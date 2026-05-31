-- Hisaab - secure Leave Group flow for shared splits.
-- Apply after supabase-migration-p0-launch-blockers.sql.
--
-- A connected member may leave only through public.leave_group(text).
-- Direct client DELETE and membership-control UPDATE operations are blocked so
-- callers cannot bypass balance, unresolved-record, or ownership checks.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Prevent direct membership bypasses
-- ---------------------------------------------------------------------------

-- There is intentionally no authenticated DELETE policy. Group deletion still
-- cascades server-side when an owner deletes the entire split_groups row.
DROP POLICY IF EXISTS "Owner can remove group members" ON public.group_members;
DROP POLICY IF EXISTS "Group owners can remove members" ON public.group_members;

-- Owners can still move guest placeholders through the existing invite/link
-- flow, but a connected member cannot be detached or deactivated directly.
-- Role changes are also blocked until a dedicated admin-transfer RPC exists.
CREATE OR REPLACE FUNCTION public.tg_group_members_protect_membership_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
    NEW.group_id IS DISTINCT FROM OLD.group_id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR (
      OLD.status = 'connected'
      AND (
        NEW.profile_id IS DISTINCT FROM OLD.profile_id
        OR NEW.status IS DISTINCT FROM OLD.status
      )
    )
  ) THEN
    RAISE EXCEPTION 'Group membership changes must use an approved RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_protect_membership_fields ON public.group_members;
CREATE TRIGGER group_members_protect_membership_fields
  BEFORE UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_protect_membership_fields();

-- ---------------------------------------------------------------------------
-- 2. Hardened leave RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  v_member public.group_members%ROWTYPE;
  v_group public.split_groups%ROWTYPE;
  v_net NUMERIC := 0;
  v_payable NUMERIC := 0;
  v_receivable NUMERIC := 0;
  v_pending_invites INTEGER := 0;
  v_unreconciled INTEGER := 0;
BEGIN
  IF uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Lock the caller's connected membership first. The same generic response is
  -- returned for a missing group, guessed group id, or inactive membership so
  -- the RPC does not reveal whether an unrelated group exists.
  SELECT * INTO v_member
    FROM public.group_members
   WHERE group_id = p_group_id
     AND profile_id = uid
     AND status = 'connected'
   FOR UPDATE;

  IF v_member.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_ACTIVE_MEMBER',
      'user_message', 'You are not an active member of this group.'
    );
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = v_member.group_id
   FOR UPDATE;

  -- The current schema has one canonical owner on split_groups.user_id. Keep
  -- that owner attached until an explicit ownership-transfer flow exists.
  IF v_group.user_id = uid OR v_member.role = 'owner' THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'ONLY_OWNER_ADMIN',
      'user_message', 'You can''t leave because you are the only group admin. Assign another admin first.'
    );
  END IF;

  -- Net position: positive means the member is owed money, negative means the
  -- member owes money. Ignore soft-deleted rows exactly as the frontend does.
  SELECT COALESCE(SUM(delta), 0) INTO v_net
  FROM (
    SELECT e.amount AS delta
      FROM public.group_expenses e
     WHERE e.group_id = v_member.group_id
       AND e.deleted_at IS NULL
       AND e.paid_by = v_member.id
    UNION ALL
    SELECT -COALESCE((split.value->>'amount')::NUMERIC, 0) AS delta
      FROM public.group_expenses e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS split(value)
     WHERE e.group_id = v_member.group_id
       AND e.deleted_at IS NULL
       AND COALESCE(split.value->>'memberId', split.value->>'member_id') = v_member.id
    UNION ALL
    SELECT s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = v_member.group_id
       AND s.deleted_at IS NULL
       AND s.from_member = v_member.id
    UNION ALL
    SELECT -s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = v_member.group_id
       AND s.deleted_at IS NULL
       AND s.to_member = v_member.id
  ) balance_parts;

  v_net := round(COALESCE(v_net, 0), 2);
  v_payable := GREATEST(-v_net, 0);
  v_receivable := GREATEST(v_net, 0);

  IF abs(v_net) > 0.01 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', CASE WHEN v_payable > 0 THEN 'OUTSTANDING_PAYABLE' ELSE 'OUTSTANDING_RECEIVABLE' END,
      'user_message', format(
        'You owe %s %s and are owed %s %s. Please settle all balances before leaving.',
        v_group.currency, trim(to_char(v_payable, 'FM999999999990.00')),
        v_group.currency, trim(to_char(v_receivable, 'FM999999999990.00'))
      ),
      'payable_amount', v_payable,
      'receivable_amount', v_receivable,
      'currency', v_group.currency
    );
  END IF;

  -- A payer must reconcile their own live expenses before leaving, even when
  -- the aggregate position happens to net to zero.
  SELECT count(*) INTO v_unreconciled
    FROM public.group_expenses e
   WHERE e.group_id = v_member.group_id
     AND e.deleted_at IS NULL
     AND e.paid_by = v_member.id
     AND COALESCE(e.is_reconciled, false) = false;

  IF v_unreconciled > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'UNRECONCILED_PARTICIPATION',
      'user_message', 'You can''t leave yet because you still have an unreconciled group expense. Reconcile it before leaving.'
    );
  END IF;

  -- In the current schema, group_invites are the only pending group-scoped
  -- request records. Linked loan and linked settlement requests are contact-
  -- scoped and have no group_id, so they are intentionally not guessed into
  -- this rule.
  SELECT count(*) INTO v_pending_invites
    FROM public.group_invites i
   WHERE i.group_id = v_member.group_id
     AND i.revoked_at IS NULL
     AND i.accepted_at IS NULL
     AND (i.linked_member_id = v_member.id OR i.accepted_by = uid);

  IF v_pending_invites > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'PENDING_SPLIT_INVITE_REQUEST',
      'user_message', 'You can''t leave yet because a pending group invitation or request still needs to be resolved.'
    );
  END IF;

  -- Soft-deactivate to preserve member ids referenced by expense split JSON
  -- and settlement history. Rejoining through the hardened code/invite RPCs
  -- reactivates this row instead of creating a duplicate.
  UPDATE public.group_members
     SET status = 'left'
   WHERE id = v_member.id;

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'LEFT_GROUP',
    'user_message', 'You left this group.',
    'payable_amount', 0,
    'receivable_amount', 0,
    'currency', v_group.currency
  );
END;
$$;

COMMENT ON FUNCTION public.leave_group(TEXT) IS
  'RPC-only safe group leave. Requires connected membership, non-owner role, zero net balance, no unreconciled payer expenses, and no pending member-linked group invites. Soft-deactivates membership as status=left.';

REVOKE ALL ON FUNCTION public.leave_group(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_group(TEXT) TO authenticated;

COMMIT;
