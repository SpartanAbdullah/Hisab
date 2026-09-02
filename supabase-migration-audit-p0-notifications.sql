-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Server-side notification fan-out (audit item C7)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
-- Apply AFTER:
--   supabase-schema.sql
--   supabase-migration-fix-rls-recursion.sql
--   supabase-migration-notifications-rls.sql
--   supabase-migration-linked-notifications-realtime.sql
--   supabase-migration-connections-push-discovery.sql
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-safe-leave-group.sql
--   supabase-migration-audit-p0-group-ledger-integrity.sql   (policies on
--     group_expenses / group_settlements live there — this file adds only
--     AFTER triggers to those two tables and never touches their policies)
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- Audit 2026-09-02:
--   • 05-security.md H5 (SEC-06) — CONFIRMED, HIGH.
--     supabase-migration-notifications-rls.sql:35-44 lets ANY co-member insert
--     a notifications row for any other member with completely unconstrained
--     `type` / `title` / `body` (no CHECK, no length cap, no rate limit), and
--     supabase-migration-connections-push-discovery.sql:450-488 forwards
--     new.title / new.body / new.type verbatim to the push edge function,
--     which renders them as an app-branded Android HIGH-priority notification
--     (supabase/functions/push-notify/index.ts:167-195). That is phishing and
--     harassment through the product's own trust chrome, plus an unbounded
--     FCM quota burn. Group co-membership is cheap to obtain (join codes,
--     and H6 owner-adds), so the precondition is attacker-manufacturable.
--   • 08-notifications.md N-2 — CONFIRMED, HIGH.
--     Group notifications AND the group_events activity rows are fanned out
--     CLIENT-side, after the money write commits, from the actor's device
--     (src/stores/splitStore.ts:253-284, call sites 471, 522, 604, 708, 896,
--     970, 1021, 1093). Every failure is swallowed with console.error. An
--     actor who goes offline / gets killed / closes the tab between the write
--     and the fan-out means the other members are NEVER notified and no
--     activity row is ever written. There is no retry (the outbox scaffold is
--     inert, src/App.tsx:253-264).
--   • 08-notifications.md N-3 — the same root cause as H5.
--
-- ────────────────────────────────────────────────────────────────────────────
-- HOW IT IS FIXED
-- ────────────────────────────────────────────────────────────────────────────
-- 1. notifications INSERT for client roles is narrowed to SELF ONLY
--    (auth.uid() = user_id). Nobody can write a row that lands in someone
--    else's Inbox or on someone else's phone.
-- 2. Group fan-out moves into SECURITY DEFINER AFTER triggers on
--    group_expenses / group_settlements / group_members. They compose text
--    from a fixed server-side template catalog — the same pattern the linked
--    request/settlement triggers already use
--    (supabase-migration-linked-notifications-realtime.sql:34-117) — and also
--    write the group_events activity row, so the shared activity feed becomes
--    durable instead of best-effort.
-- 3. Rows carry `template` + `params` (jsonb) alongside the server-composed
--    `title`/`body`. The client renders template+params through i18n
--    (src/lib/notificationContent.ts) so group notifications finally appear in
--    Roman Urdu; `title`/`body` stay populated as the fallback for legacy rows
--    and for the push pipeline, which reads new.title/new.body verbatim and
--    needs no change.
-- 4. `actor_id` records who caused a notification, which gives a cheap
--    per-sender rate limit (MAX_PER_ACTOR_PER_MINUTE) enforced inside the
--    trigger path. Over the limit, the notifications are skipped SILENTLY —
--    the money write and the group_events row always still commit.
--
-- ────────────────────────────────────────────────────────────────────────────
-- TEMPLATE CATALOG (client must match src/lib/notificationContent.ts)
-- ────────────────────────────────────────────────────────────────────────────
--   template            params (beyond groupId/groupName/currency/actorName)
--   ------------------  -------------------------------------------------------
--   group_added         —
--   member_joined       memberId
--   expense_added       expenseId, description, amount
--   expense_updated     expenseId, description
--   expense_deleted     expenseId, description
--   settlement_added    settlementId, fromName, toName, amount
--   settlement_deleted  settlementId, fromName, toName
--
-- Trigger inventory (event → who is notified):
--   group_members  AFTER INSERT/UPDATE  → group_added   (the added member)
--                                       → member_joined (every other member)
--   group_expenses AFTER INSERT         → expense_added
--                  AFTER UPDATE         → expense_updated (core fields moved)
--                                       → expense_deleted (deleted_at set)
--   group_settlements AFTER INSERT      → settlement_added
--                     AFTER UPDATE      → settlement_deleted (deleted_at set)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Schema — template / params / actor_id
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.notifications.template IS
  'Server-side template key (see the catalog in supabase-migration-audit-p0-notifications.sql). NULL = legacy row: render the stored title/body.';
COMMENT ON COLUMN public.notifications.params IS
  'Structured render parameters for `template`. Client renders these through i18n; title/body hold the server-composed English fallback (also what the push pipeline sends).';
COMMENT ON COLUMN public.notifications.actor_id IS
  'Who caused this notification. Drives the per-sender fan-out rate limit and lets the client attribute the row.';

-- Rate-limit lookup: "how many notifications has this actor caused in the
-- last minute". Partial index — the vast majority of legacy rows are NULL.
CREATE INDEX IF NOT EXISTS idx_notifications_actor_created
  ON public.notifications (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- Defence in depth against the flood/oversize half of H5 for the one insert
-- path clients keep (self-notifications). NOT VALID so the migration never
-- fails on pre-existing rows; the constraint still applies to every new row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND conname = 'notifications_text_length_check'
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_text_length_check
      CHECK (length(title) <= 200 AND length(body) <= 1000) NOT VALID;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. RLS — clients may only ever insert notifications for THEMSELVES
--
-- This is the H5 fix. Every legitimate cross-user notification in the product
-- is already written by a SECURITY DEFINER trigger or RPC (linked requests,
-- linked settlements, contact links) or becomes one in Section 5 below, and
-- SECURITY DEFINER bypasses RLS — so nothing legitimate needs this policy.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Users can insert notifications for self or fellow members" ON public.notifications;
DROP POLICY IF EXISTS "Users can insert own notifications" ON public.notifications;
CREATE POLICY "Users can insert own notifications"
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- group_events was the second half of the same hole: its INSERT policy let any
-- connected member author an arbitrary `summary` into the shared group
-- activity feed. Section 5 writes those rows server-side now, so the client
-- policy has no remaining caller (the only one was
-- src/stores/splitStore.ts:260, removed in this change).
DROP POLICY IF EXISTS "Connected members can create group events" ON public.group_events;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Template catalog — server-composed fallback text
--
-- English at P0 (matching the existing linked-request triggers). The client
-- renders `template` + `params` through i18n for the localized copy; this text
-- is what a legacy client, and the FCM push pipeline, actually display.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.group_notification_text(
  p_template TEXT,
  p_params   JSONB
)
RETURNS TABLE (title TEXT, body TEXT)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_actor  TEXT := COALESCE(NULLIF(trim(p_params->>'actorName'), ''), 'A member');
  v_group  TEXT := COALESCE(NULLIF(trim(p_params->>'groupName'), ''), 'the group');
  v_desc   TEXT := COALESCE(NULLIF(trim(p_params->>'description'), ''), 'An expense');
  v_from   TEXT := COALESCE(NULLIF(trim(p_params->>'fromName'), ''), 'Someone');
  v_to     TEXT := COALESCE(NULLIF(trim(p_params->>'toName'), ''), 'someone');
  v_money  TEXT;
BEGIN
  IF (p_params->>'amount') IS NOT NULL THEN
    v_money := COALESCE(NULLIF(trim(p_params->>'currency'), ''), '')
      || CASE WHEN COALESCE(NULLIF(trim(p_params->>'currency'), ''), '') = '' THEN '' ELSE ' ' END
      || trim(to_char((p_params->>'amount')::NUMERIC, 'FM999999999990.00'));
  END IF;

  IF p_template = 'group_added' THEN
    title := 'Added to ' || v_group;
    body  := v_actor || ' added you to a shared group.';
  ELSIF p_template = 'member_joined' THEN
    title := v_actor || ' joined ' || v_group;
    body  := v_actor || ' is now connected to the group.';
  ELSIF p_template = 'expense_added' THEN
    title := v_actor || ' added an expense';
    body  := v_desc || COALESCE(' for ' || v_money, '') || ' was added in ' || v_group || '.';
  ELSIF p_template = 'expense_updated' THEN
    title := v_actor || ' updated an expense';
    body  := v_desc || ' was changed in ' || v_group || '.';
  ELSIF p_template = 'expense_deleted' THEN
    title := v_actor || ' deleted an expense';
    body  := v_desc || ' was removed from ' || v_group || '.';
  ELSIF p_template = 'settlement_added' THEN
    title := v_from || ' settled up';
    body  := v_from || ' settled ' || COALESCE(v_money, 'up') || ' with ' || v_to || ' in ' || v_group || '.';
  ELSIF p_template = 'settlement_deleted' THEN
    title := v_actor || ' removed a settlement';
    body  := 'The ' || v_from || ' → ' || v_to || ' settlement in ' || v_group || ' was undone.';
  ELSE
    title := 'Update in ' || v_group;
    body  := v_actor || ' made a change in ' || v_group || '.';
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.group_notification_text(TEXT, JSONB) IS
  'Fixed server-side template catalog for group notifications. The ONLY source of notification title/body for group events — clients can no longer author them (audit H5).';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Fan-out helper: group_events row + rate-limited notifications
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fan_out_group_notification(
  p_group_id    TEXT,
  p_actor       UUID,
  p_event_type  TEXT,
  p_entity_type TEXT,
  p_entity_id   TEXT,
  p_template    TEXT,
  p_params      JSONB,
  p_recipients  UUID[] DEFAULT NULL,  -- NULL = every other connected member
  -- Optional third-person text for the shared group_events feed. The
  -- notification body is written TO one reader ("… added you …"), which reads
  -- wrong in a feed everyone sees. '{actor}' is substituted.
  p_event_summary TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One actor may cause at most this many notification rows per rolling
  -- minute. A 20-member group expense costs 19, so this comfortably covers
  -- honest bursts (a trip being entered) while capping a flood attack and
  -- the FCM quota burn it would drive.
  c_max_per_minute CONSTANT INTEGER := 120;
  -- No legitimate Hisaab group is anywhere near this size; the cap stops one
  -- pathological group from becoming an amplifier.
  c_max_recipients CONSTANT INTEGER := 100;

  v_group      public.split_groups%ROWTYPE;
  v_actor_name TEXT;
  v_params     JSONB;
  v_title      TEXT;
  v_body       TEXT;
  v_event_id   TEXT := gen_random_uuid()::TEXT;
  v_recent     INTEGER := 0;
BEGIN
  SELECT * INTO v_group FROM public.split_groups WHERE id = p_group_id;
  IF v_group.id IS NULL THEN
    RETURN;  -- group already gone (cascade delete) — nothing to announce.
  END IF;

  SELECT COALESCE(NULLIF(trim(p.name), ''), 'A Hisaab user')
    INTO v_actor_name
    FROM public.profiles p
   WHERE p.id = p_actor;

  -- The actor's group display name is friendlier than their profile name and
  -- matches what the other members see in the member list.
  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), v_actor_name)
    INTO v_actor_name
    FROM public.group_members gm
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = p_actor
   ORDER BY gm.created_at
   LIMIT 1;

  v_params := COALESCE(p_params, '{}'::jsonb)
    || jsonb_build_object(
         'groupId',   p_group_id,
         'groupName', v_group.name,
         'currency',  v_group.currency,
         'actorName', COALESCE(v_actor_name, 'A member')
       );

  SELECT t.title, t.body INTO v_title, v_body
    FROM public.group_notification_text(p_template, v_params) AS t;

  -- The activity row is written unconditionally: it is the durable record of
  -- what happened and must survive both the rate limit and a zero-recipient
  -- group. Previously client-written (splitStore.ts:260) and therefore lost
  -- whenever the actor went offline mid-write (audit N-2).
  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, p_actor, p_event_type, p_entity_type, p_entity_id,
    left(
      COALESCE(
        replace(p_event_summary, '{actor}', COALESCE(v_actor_name, 'A member')),
        v_body
      ),
      500
    ),
    v_params, now()
  );

  -- Per-sender rate limit. Over the limit we skip SILENTLY — the audit's
  -- requirement — because raising here would roll back the money write that
  -- fired this trigger.
  IF p_actor IS NOT NULL THEN
    SELECT count(*) INTO v_recent
      FROM public.notifications n
     WHERE n.actor_id = p_actor
       AND n.created_at > now() - interval '1 minute';
    IF v_recent >= c_max_per_minute THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.notifications (
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, read_at, created_at
  )
  SELECT
    gen_random_uuid()::TEXT, r.profile_id, p_group_id, v_event_id,
    'group_update', left(v_title, 200), left(v_body, 1000),
    p_template, v_params, p_actor, NULL, now()
  FROM (
    SELECT DISTINCT gm.profile_id
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.status = 'connected'
       AND gm.profile_id IS NOT NULL
       AND gm.profile_id IS DISTINCT FROM p_actor
       AND (p_recipients IS NULL OR gm.profile_id = ANY (p_recipients))
     LIMIT c_max_recipients
  ) AS r;
END;
$$;

COMMENT ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) IS
  'Writes the durable group_events activity row plus template-composed notifications for the other connected members. SECURITY DEFINER so it bypasses the self-only notifications INSERT policy. Rate-limited per actor; over the limit notifications are skipped silently and the activity row still commits.';

-- Only the triggers below call this. No client should ever be able to.
REVOKE ALL ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Triggers — one per fan-out call site that splitStore had
-- ═══════════════════════════════════════════════════════════════════════════

-- ── group_members: "X added you to <group>" and "X joined <group>" ─────────
-- Replaces splitStore.ts:471 (createGroup), :522 (joinGroupByCode) and
-- :604 (acceptInvite). Fires on both the INSERT path (join_group_by_code's
-- new-member branch, createGroup's addMany) and the UPDATE path (the RPC's
-- reactivate branch, acceptInvite, and claimPaidByMemberIfMine attaching a
-- profile to a guest row).
CREATE OR REPLACE FUNCTION public.tg_group_members_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      UUID := auth.uid();
  v_became     BOOLEAN;
  v_group_owner UUID;
  v_role       TEXT;
BEGIN
  IF NEW.profile_id IS NULL OR NEW.status <> 'connected' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_became := TRUE;
  ELSE
    -- Newly connected, or a guest row that just got a profile attached.
    v_became := (OLD.status IS DISTINCT FROM NEW.status)
             OR (OLD.profile_id IS DISTINCT FROM NEW.profile_id);
  END IF;
  IF NOT v_became THEN
    RETURN NULL;
  END IF;

  v_actor := COALESCE(v_actor, NEW.invited_by);

  SELECT g.user_id INTO v_group_owner FROM public.split_groups g WHERE g.id = NEW.group_id;
  v_role := COALESCE(NEW.role, 'member');

  IF NEW.profile_id IS DISTINCT FROM v_actor THEN
    -- Someone else attached this person to the group: tell only them.
    PERFORM public.fan_out_group_notification(
      NEW.group_id, v_actor, 'group_created', 'group', NEW.group_id,
      'group_added', jsonb_build_object('memberId', NEW.id),
      ARRAY[NEW.profile_id]::UUID[],
      '{actor} added ' || COALESCE(NULLIF(trim(NEW.display_name), ''), 'a member') || ' to the group'
    );
  ELSIF v_role <> 'owner' AND NEW.profile_id IS DISTINCT FROM v_group_owner THEN
    -- The person joined under their own steam. The owner's own membership row
    -- (written in the same statement as createGroup's other members) is NOT a
    -- join and must not announce itself to the people just added.
    PERFORM public.fan_out_group_notification(
      NEW.group_id, v_actor, 'member_joined', 'member', NEW.id,
      'member_joined', jsonb_build_object('memberId', NEW.id),
      NULL::UUID[]
    );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_members_notify ON public.group_members;
CREATE TRIGGER group_members_notify
  AFTER INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_notify();

-- ── group_expenses: added / updated / deleted ──────────────────────────────
-- Replaces splitStore.ts:708 (addGroupExpense), :896 (updateGroupExpense),
-- :970 (deleteGroupExpense). Reconcile-only updates (the
-- reconcile_group_expense RPC) deliberately do NOT notify — they never did.
CREATE OR REPLACE FUNCTION public.tg_group_expenses_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := COALESCE(auth.uid(), NEW.user_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    PERFORM public.fan_out_group_notification(
      NEW.group_id, v_actor, 'expense_added', 'group_expense', NEW.id,
      'expense_added',
      jsonb_build_object(
        'expenseId', NEW.id,
        'description', NEW.description,
        'amount', NEW.amount,
        'paidBy', NEW.paid_by
      ),
      NULL::UUID[]
    );
    RETURN NULL;
  END IF;

  -- Soft delete.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM public.fan_out_group_notification(
      NEW.group_id, COALESCE(auth.uid(), NEW.deleted_by, NEW.user_id),
      'expense_deleted', 'group_expense', NEW.id,
      'expense_deleted',
      jsonb_build_object(
        'expenseId', NEW.id,
        'description', OLD.description,
        'amount', OLD.amount
      ),
      NULL::UUID[]
    );
    RETURN NULL;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;  -- already-dead row being touched; nothing to announce.
  END IF;

  -- Only the fields that change what people owe, or what the expense IS.
  IF NEW.description IS DISTINCT FROM OLD.description
     OR NEW.amount    IS DISTINCT FROM OLD.amount
     OR NEW.paid_by   IS DISTINCT FROM OLD.paid_by
     OR NEW.splits    IS DISTINCT FROM OLD.splits
     OR NEW.split_type IS DISTINCT FROM OLD.split_type
     OR NEW.category  IS DISTINCT FROM OLD.category THEN
    PERFORM public.fan_out_group_notification(
      NEW.group_id, COALESCE(auth.uid(), NEW.updated_by, NEW.user_id),
      'expense_updated', 'group_expense', NEW.id,
      'expense_updated',
      jsonb_build_object(
        'expenseId', NEW.id,
        'description', OLD.description,
        'amount', NEW.amount
      ),
      NULL::UUID[]
    );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_expenses_notify ON public.group_expenses;
CREATE TRIGGER group_expenses_notify
  AFTER INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_notify();

-- ── group_settlements: recorded / undone ───────────────────────────────────
-- Replaces splitStore.ts:1093 (addSettlement) and :1021 (deleteSettlement).
CREATE OR REPLACE FUNCTION public.tg_group_settlements_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID;
  v_from  TEXT;
  v_to    TEXT;
BEGIN
  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), 'Someone') INTO v_from
    FROM public.group_members gm WHERE gm.id = NEW.from_member;
  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), 'someone') INTO v_to
    FROM public.group_members gm WHERE gm.id = NEW.to_member;

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_actor := COALESCE(auth.uid(), NEW.created_by, NEW.user_id);
    PERFORM public.fan_out_group_notification(
      NEW.group_id, v_actor, 'settlement_added', 'group_settlement', NEW.id,
      'settlement_added',
      jsonb_build_object(
        'settlementId', NEW.id,
        'fromName', COALESCE(v_from, 'Someone'),
        'toName', COALESCE(v_to, 'someone'),
        'amount', NEW.amount
      ),
      NULL::UUID[]
    );
    RETURN NULL;
  END IF;

  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    v_actor := COALESCE(auth.uid(), NEW.deleted_by, NEW.user_id);
    PERFORM public.fan_out_group_notification(
      NEW.group_id, v_actor, 'settlement_deleted', 'group_settlement', NEW.id,
      'settlement_deleted',
      jsonb_build_object(
        'settlementId', NEW.id,
        'fromName', COALESCE(v_from, 'Someone'),
        'toName', COALESCE(v_to, 'someone'),
        'amount', OLD.amount
      ),
      NULL::UUID[]
    );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_settlements_notify ON public.group_settlements;
CREATE TRIGGER group_settlements_notify
  AFTER INSERT OR UPDATE ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_settlements_notify();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the COMMIT above.
-- Every assertion aborts with a descriptive message; a clean run prints
-- "audit-p0-notifications: OK".
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
  v_check TEXT;
  v_title TEXT;
  v_body  TEXT;
BEGIN
  -- 1. The new columns exist.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'notifications'
     AND column_name IN ('template', 'params', 'actor_id');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'notifications is missing template/params/actor_id (found %)', v_count;
  END IF;

  -- 2. THE H5 FIX: no INSERT policy on notifications permits a row for
  --    another user. The only permitted INSERT check is auth.uid() = user_id.
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notifications'
     AND permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'ALL');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'notifications should have exactly 1 permissive INSERT/ALL policy, found %', v_count;
  END IF;

  SELECT with_check INTO v_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notifications'
     AND permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'ALL');
  IF v_check IS NULL OR v_check LIKE '%is_group_member%' OR v_check LIKE '%OR%' THEN
    RAISE EXCEPTION 'notifications INSERT policy is still fan-out permissive: %', v_check;
  END IF;

  -- 3. group_events can no longer be authored by a client.
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'group_events'
     AND permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'ALL');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'group_events still has % client INSERT policy/policies', v_count;
  END IF;

  -- 4. All three fan-out triggers are installed.
  FOR v_check IN
    SELECT unnest(ARRAY['group_members_notify', 'group_expenses_notify', 'group_settlements_notify'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = v_check AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'trigger % is missing', v_check;
    END IF;
  END LOOP;

  -- 5. The template catalog composes non-empty text for every known key and
  --    for an unknown key (the fallback branch).
  FOR v_check IN
    SELECT unnest(ARRAY[
      'group_added', 'member_joined', 'expense_added', 'expense_updated',
      'expense_deleted', 'settlement_added', 'settlement_deleted', 'nonsense_key'
    ])
  LOOP
    SELECT t.title, t.body INTO v_title, v_body
      FROM public.group_notification_text(
        v_check,
        jsonb_build_object(
          'actorName', 'Ali', 'groupName', 'Flat 12', 'currency', 'AED',
          'description', 'Groceries', 'amount', 250.5,
          'fromName', 'Ali', 'toName', 'Sara'
        )
      ) AS t;
    IF COALESCE(v_title, '') = '' OR COALESCE(v_body, '') = '' THEN
      RAISE EXCEPTION 'template % composed empty text', v_check;
    END IF;
  END LOOP;

  -- 6. The fan-out helper is not client-callable.
  IF has_function_privilege(
       'authenticated',
       'public.fan_out_group_notification(text,uuid,text,text,text,text,jsonb,uuid[],text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'fan_out_group_notification is EXECUTE-able by authenticated';
  END IF;

  RAISE NOTICE 'audit-p0-notifications: OK';
END;
$$;

-- Manual spot-checks (run as a signed-in user in the SQL editor's "run as"
-- mode, or from the app):
--
--   -- Must fail with a row-level security violation (H5 regression probe):
--   INSERT INTO public.notifications (id, user_id, type, title, body)
--   VALUES (gen_random_uuid()::text, '<some other member uuid>', 'linked_settlement',
--           'Repayment confirmed', 'Verify at hisaab-verify.example');
--
--   -- Adding a group expense must now produce one templated row per other
--   -- connected member, authored by nobody's client:
--   SELECT type, template, actor_id, title, body, params
--     FROM public.notifications
--    WHERE group_id = '<group id>'
--    ORDER BY created_at DESC LIMIT 10;
--
--   -- The activity row is durable now, even if the actor's app dies:
--   SELECT event_type, summary, actor_profile_id FROM public.group_events
--    WHERE group_id = '<group id>' ORDER BY created_at DESC LIMIT 10;
