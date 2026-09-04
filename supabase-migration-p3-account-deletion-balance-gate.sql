-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Account deletion refuses while a shared-group balance is unsettled
-- (founder decision D1, 2026-09-04; audit 2026-09 item C2 / R1)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor AFTER:
--   supabase-migration-p2-trust-safety.sql          (the delete_current_user
--                                                    body this file extends)
--   supabase-migration-audit-p0-group-concurrency.sql (group_member_net_balance)
--   supabase-migration-audit-p0-account-deletion.sql  (group_has_other_connected_members)
-- and BEFORE supabase-migration-p3-rpc-execute-grants.sql (which must stay the
-- last file: it sweeps every function for EXECUTE grants and the search_path
-- pin). Idempotent: CREATE OR REPLACE only, no data is touched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DECISION
-- ─────────────────────────────────────────────────────────────────────────────
-- audit-p0-account-deletion.sql deliberately left one question open (its
-- header, "what this does NOT do", and P0-REMEDIATION.md §6.1 D1): a member can
-- delete their account while carrying a NON-ZERO balance in a shared group.
-- The rows survive (SET NULL), so nobody's ledger is rewritten — but the debt
-- becomes UNSETTLEABLE: the departed member is `'left'` with no profile, a
-- settlement needs both parties connected, and the counterparty is then also
-- refused by leave_group (OUTSTANDING_PAYABLE / OUTSTANDING_RECEIVABLE) and by
-- the split_groups delete guard (GROUP_HAS_OUTSTANDING_BALANCES). The debt
-- outlives everyone who could clear it.
--
-- Two options were on the table:
--   (a) refuse deletion until settled — mirroring leave_group's gate;
--   (b) allow deletion plus a write-off RPC that redistributes the residue.
-- The founder chose (a) on 2026-09-04: "refuse deletion until settled,
-- mirroring how leaving a group already works". Rationale: leaving a group
-- and deleting an account are the same exit from the counterparty's point of
-- view, and the app already promises (play-store-listing.md) "hand over any
-- group you run first" — "and settle what you owe" is the same shape of
-- qualification, not a new one. A write-off would silently move money between
-- the people who stayed, which is exactly the class of surprise the C-series
-- fixes exist to prevent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-creates public.delete_current_user() — the p2-trust-safety §8.3 body,
-- verbatim — with ONE new guard (4a-bis) between the owner guard and the
-- departure loop:
--
--   for every group where the caller is a CONNECTED member AND at least one
--   other profile-linked member is still connected, compute the caller's net
--   position with public.group_member_net_balance(group_id, member_id) — the
--   same arithmetic, sign convention, rounding and deleted_at filter as
--   leave_group and the two group guards — and refuse with the stable marker
--
--     UNSETTLED_GROUP_BALANCES
--       DETAIL = 'Flatmates: owes AED 20.00; Trip: is owed PKR 1,500.00'
--       HINT   = how to resolve
--
--   when any |net| > 0.01 (leave_group's tolerance).
--
-- Why "other connected members" is part of the predicate: if everyone else has
-- already left, there is nobody left to settle with, and a refusal would trap
-- the caller forever. Such a group is either solo-owned (deleted by 4c) or a
-- dead ledger nobody can act on; the balance-gate is only meaningful while a
-- counterparty exists. That is also why the guard sits AFTER the owner guard —
-- an owner is told about the groups they run first, because transferring
-- ownership is the bigger step and may itself change who they owe.
--
-- Why unreconciled expenses (leave_group's UNRECONCILED_PARTICIPATION) are NOT
-- gated here: is_reconciled records whether the PAYER mirrored the expense into
-- their own tracker — private bookkeeping that ceases to exist with the
-- account. It does not affect any other member's balance, so it is not a
-- reason to keep an identity alive.
--
-- Error contract (client: src/pages/SettingsPage.tsx readDeletionBlocker):
--   message = 'UNSETTLED_GROUP_BALANCES'  (stable marker, never localized)
--   details = server-composed English list, shown as supporting detail under
--             localized copy — same convention as GROUP_HAS_OUTSTANDING_BALANCES
--   hint    = resolution text
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_current_user()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_blocking      TEXT;
  v_unsettled     TEXT;
  v_still_owned   INTEGER;
  v_member        RECORD;
  v_expenses      INTEGER;
  v_settlements   INTEGER;
  v_display       TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- ── 4a. Owner guard ──────────────────────────────────────────────────────
  -- split_groups.user_id is still ON DELETE CASCADE, and that cascade would
  -- take the group, its members, invites, events, and EVERY member's expenses
  -- with it. Refuse instead, naming the groups so the client can tell the user
  -- exactly what to transfer or wind down first.
  SELECT string_agg(g.name, ', ' ORDER BY g.name)
    INTO v_blocking
    FROM public.split_groups g
   WHERE g.user_id = v_uid
     AND public.group_has_other_connected_members(g.id, v_uid);

  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION 'OWNED_GROUPS_WITH_MEMBERS'
      USING ERRCODE = 'P0001',
            DETAIL  = v_blocking,
            HINT    = 'Transfer ownership of these groups (public.transfer_group_ownership) or settle and remove the other members before deleting your account.';
  END IF;

  -- ── 4a-bis. Balance guard (founder decision D1, 2026-09-04) ─────────────
  -- Mirrors leave_group: a member may not exit a shared group while their net
  -- position is non-zero, because after the exit nobody can settle it. Same
  -- arithmetic as leave_group (group_member_net_balance, audit-p0-group-
  -- concurrency.sql), same 0.01 tolerance. Only groups with another connected,
  -- profile-linked member count — with nobody left to settle with, a refusal
  -- would be a permanent trap, not a protection.
  SELECT string_agg(
           format('%s: %s %s %s',
                  g.name,
                  CASE WHEN b.net < 0 THEN 'owes' ELSE 'is owed' END,
                  g.currency,
                  trim(to_char(abs(b.net), 'FM999999999990.00'))),
           '; ' ORDER BY g.name)
    INTO v_unsettled
    FROM public.group_members gm
    JOIN public.split_groups g ON g.id = gm.group_id
    CROSS JOIN LATERAL (
      SELECT public.group_member_net_balance(gm.group_id, gm.id) AS net
    ) b
   WHERE gm.profile_id = v_uid
     AND gm.status = 'connected'
     AND abs(b.net) > 0.01
     AND public.group_has_other_connected_members(gm.group_id, v_uid);

  IF v_unsettled IS NOT NULL THEN
    RAISE EXCEPTION 'UNSETTLED_GROUP_BALANCES'
      USING ERRCODE = 'P0001',
            DETAIL  = v_unsettled,
            HINT    = 'Settle these balances first — record a settlement (or ask the other member to), then delete your account. Leaving a group has the same rule.';
  END IF;

  -- ── 4b. Announce the departure in every shared group the user participates
  -- in, and soft-deactivate their membership. Runs BEFORE the auth.users delete
  -- so the group_members row is still resolvable. actor_profile_id is written
  -- as NULL on purpose: the actor is about to cease to exist, and the FK would
  -- null it moments later anyway.
  FOR v_member IN
    SELECT gm.id AS member_id, gm.group_id, gm.display_name
      FROM public.group_members gm
     WHERE gm.profile_id = v_uid
       AND public.group_has_other_connected_members(gm.group_id, v_uid)
  LOOP
    SELECT count(*) INTO v_expenses
      FROM public.group_expenses e
     WHERE e.group_id = v_member.group_id
       AND e.user_id = v_uid
       AND e.deleted_at IS NULL;

    SELECT count(*) INTO v_settlements
      FROM public.group_settlements s
     WHERE s.group_id = v_member.group_id
       AND s.user_id = v_uid
       AND s.deleted_at IS NULL;

    v_display := COALESCE(NULLIF(trim(v_member.display_name), ''), 'A member');

    INSERT INTO public.group_events (
      id, group_id, actor_profile_id, event_type, entity_type, entity_id,
      summary, payload
    ) VALUES (
      gen_random_uuid()::text,
      v_member.group_id,
      NULL,
      'member_account_deleted',
      'member',
      v_member.member_id,
      v_display || ' deleted their Hisaab account. Their past expenses and settlements stay in this group, without a linked account.',
      jsonb_build_object(
        'memberId',            v_member.member_id,
        'displayName',         v_display,
        'expensesRetained',    v_expenses,
        'settlementsRetained', v_settlements,
        'deletedAt',           now()
      )
    );

    -- Soft-deactivate: 'left' is the same terminal state leave_group uses.
    -- Nulling profile_id here (rather than leaving it to the FK) keeps the two
    -- writes in one statement and, critically, prevents a `connected` row with
    -- a NULL profile from being claimed by another user with the same display
    -- name (claimPaidByMemberIfMine, src/stores/splitStore.ts:160-177).
    -- Runs as the function owner, so group_members_protect_membership_fields
    -- (safe-leave-group.sql:46) does not fire its authenticated-only guard.
    UPDATE public.group_members
       SET status     = 'left',
           profile_id = NULL
     WHERE id = v_member.member_id;
  END LOOP;

  -- ── 4c. Solo groups: delete explicitly, so the only thing left for the
  -- auth.users cascade to reach is nothing. Re-verified below.
  DELETE FROM public.split_groups g
   WHERE g.user_id = v_uid
     AND NOT public.group_has_other_connected_members(g.id, v_uid);

  SELECT count(*) INTO v_still_owned
    FROM public.split_groups g
   WHERE g.user_id = v_uid;

  IF v_still_owned > 0 THEN
    -- Only reachable if someone joined one of these groups between 4a and now.
    RAISE EXCEPTION 'OWNED_GROUPS_WITH_MEMBERS'
      USING ERRCODE = 'P0001',
            DETAIL  = 'A member joined one of your groups while the deletion was running.',
            HINT    = 'Please try again.';
  END IF;

  -- ── 4d. Mark the profile first so concurrent policy checks stop admitting
  -- new work. The profile row itself is then removed by the auth.users cascade.
  UPDATE public.profiles
     SET is_deleted = true,
         deleted_at = now(),
         name = '',
         public_code = NULL,
         public_code_normalized = NULL
   WHERE id = v_uid;

  -- ── [E1] 4d-bis. Purge the user's receipt objects (audit F-ST1 / M13).
  -- Dynamic SQL so a database without the storage schema (scaffolds, self-host
  -- variants) plans this lazily instead of failing to create the function;
  -- WARNING rather than EXCEPTION so Storage can never block a right-to-delete.
  BEGIN
    EXECUTE 'DELETE FROM storage.objects '
            'WHERE bucket_id = ''receipts'' AND split_part(name, ''/'', 1) = $1'
      USING v_uid::text;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'delete_current_user: receipt purge for % skipped (%) — purge the receipts/%/ folder with the storage API.', v_uid, SQLERRM, v_uid;
  END;

  -- ── 4e. Permanently remove the auth identity.
  -- Cascades now reach only rows that are private to this user. The two shared
  -- ledgers (group_expenses, group_settlements) are SET NULL by §1, so their
  -- rows survive anonymized for the members who still depend on them.
  DELETE FROM auth.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.delete_current_user() IS
  'Permanent account deletion. Refuses with OWNED_GROUPS_WITH_MEMBERS (DETAIL = comma-separated group names) when the caller owns a group that still has other participants, and with UNSETTLED_GROUP_BALANCES (DETAIL = "group: owes/is owed CUR amount; ...") when the caller has a non-zero net position in any shared group that still has another connected member (founder decision D1, 2026-09-04 — same rule as leave_group). Otherwise: emits a member_account_deleted group_event and marks the membership left in every shared group, hard-deletes solo groups, purges the caller''s receipts/<uid>/ storage rows (audit F-ST1 — see the storage-API caveat in supabase-migration-p2-trust-safety.sql §8.3), then deletes the auth identity. Shared group_expenses / group_settlements survive with user_id SET NULL.';

REVOKE ALL ON FUNCTION public.delete_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_current_user() TO authenticated;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION — run after the COMMIT above. Nothing below writes.
-- ════════════════════════════════════════════════════════════════════════════

-- V1 The function carries the new guard and still carries the old one.
SELECT (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%UNSETTLED_GROUP_BALANCES%') AS has_balance_gate,
       (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%OWNED_GROUPS_WITH_MEMBERS%') AS has_owner_gate,
       (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%storage.objects%')          AS has_receipt_purge;
-- Expect: t, t, t

-- V2 Grants unchanged: authenticated only.
SELECT has_function_privilege('authenticated', 'public.delete_current_user()', 'EXECUTE') AS auth_ok,
       has_function_privilege('anon',          'public.delete_current_user()', 'EXECUTE') AS anon_ok;
-- Expect: t, f

-- V3 Census (informational, not an assertion): how many live members would be
--    refused by the new gate today. Each row is a real person who currently
--    owes or is owed inside a group that still has a counterparty — these are
--    exactly the situations the gate exists for.
SELECT count(*)                       AS members_currently_gated,
       count(DISTINCT gm.profile_id)  AS profiles_currently_gated,
       count(DISTINCT gm.group_id)    AS groups_involved
  FROM public.group_members gm
  CROSS JOIN LATERAL (SELECT public.group_member_net_balance(gm.group_id, gm.id) AS net) b
 WHERE gm.profile_id IS NOT NULL
   AND gm.status = 'connected'
   AND abs(b.net) > 0.01
   AND public.group_has_other_connected_members(gm.group_id, gm.profile_id);
