-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Shared-group deletion guard + owner-facing archive
-- (audit 2026-09: 04-supabase.md F-RLS11, 05-security.md L13, and the R2
--  residual risk filed by supabase-migration-audit-p0-account-deletion.sql:334)
-- ----------------------------------------------------------------------------
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run (every ALTER is
-- IF NOT EXISTS, every function is CREATE OR REPLACE, every trigger is
-- DROP IF EXISTS + CREATE).
--
-- APPLY ORDER — READ THIS FIRST, IT IS NOT OPTIONAL
--   Apply AFTER (in this order):
--     supabase-schema.sql
--     supabase-migration-fix-rls-recursion.sql
--     supabase-migration-prelaunch-hardening.sql
--     supabase-migration-p0-launch-blockers.sql
--     supabase-migration-safe-leave-group.sql
--     supabase-migration-enforce-active-group-transaction-members.sql
--     supabase-migration-audit-p0-notifications.sql            (optional, see §6)
--   >>> supabase-migration-audit-p0-group-ledger-integrity.sql  (MANDATORY,
--       and it MUST come BEFORE this file — Section 0 refuses to install
--       otherwise, and explains exactly why below.)
--   Order relative to supabase-migration-audit-p0-account-deletion.sql does not
--   matter (disjoint objects; interaction analysis in Section 0.2).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS BROKEN
-- ─────────────────────────────────────────────────────────────────────────────
-- `split_groups` carries one authorship-only FOR ALL policy —
--   CREATE POLICY "Users can manage own groups" ON split_groups
--     FOR ALL USING (auth.uid() = user_id)
--   (supabase-schema.sql:205, re-created with a WITH CHECK at
--    supabase-migration-prelaunch-hardening.sql:55-57)
-- — so the group OWNER may issue a raw hard DELETE of a *shared* group row
-- straight from the client:
--   splitGroupsDb.delete       src/lib/supabaseDb.ts:958-961
--   splitStore.deleteGroup     src/stores/splitStore.ts:545-556
--   GroupDetailPage.handleDelete  src/pages/GroupDetailPage.tsx:381-395
-- (the confirm dialog is the ONLY gate, and it does not even try/catch).
--
-- The FK cascades then reap every other member's money records at table-owner
-- level, bypassing RLS entirely:
--   group_expenses.group_id    REFERENCES split_groups(id) ON DELETE CASCADE
--                              supabase-schema.sql:213
--   group_settlements.group_id REFERENCES split_groups(id) ON DELETE CASCADE
--                              supabase-schema.sql:238
--   group_members.group_id     schema:317   group_invites.group_id  schema:389
--   group_events.group_id      schema:431   notifications.group_id  schema:458
--
-- Net effect: one tap by one member erases every other member's expense and
-- settlement history — no balance gate, no tombstone (`deleted_at` is bypassed
-- entirely), no group_event, no notification, no undo. In splits_only
-- (ledger-only) mode those two tables ARE the entire money record.
--
-- The asymmetry is the point: `leave_group` (supabase-migration-safe-leave-
-- group.sql:55-209) refuses a member's *exit* on a non-zero net balance
-- (:142-155), an unreconciled payer expense (:159-172), or a pending invite
-- (:178-191) — while the owner's *demolition* of the same ledger is
-- unconditional. audit 05-security.md L13 states it plainly: "asymmetric with
-- the strict leave gate members face."
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE RULE CHOSEN (and every case it was checked against)
-- ─────────────────────────────────────────────────────────────────────────────
-- A client-issued DELETE on split_groups is refused when EITHER holds:
--
--   TIER A — GROUP_HAS_OTHER_MEMBERS
--     Any other CONNECTED, profile-linked member exists
--     (group_members.status = 'connected' AND profile_id IS NOT NULL
--      AND profile_id <> split_groups.user_id).
--     This is byte-for-byte the predicate
--     `group_has_other_connected_members(id, user_id)` uses
--     (audit-p0-account-deletion.sql:513-537) — deliberately the same notion of
--     "somebody else is really in this group", so the two guards can never
--     disagree about whether a group is solo. It is queried inline here rather
--     than by calling that function, so this migration has no ordering
--     dependency on the account-deletion migration and neither file can drift
--     the other's definition.
--
--   TIER B — GROUP_HAS_OUTSTANDING_BALANCES
--     No other connected member remains, but some member that still maps to a
--     LIVE Hisaab account other than the owner (profile_id IS NOT NULL AND
--     profile_id <> owner — in practice a status='left' ex-member) has a net
--     balance ≠ 0 (tolerance 0.01, exactly leave_group's).
--     Why an ex-member still has standing: after leaving, the split_groups
--     SELECT policy (schema:495) and the ledger SELECT policies both fail for
--     them EXCEPT the `auth.uid() = user_id` half — an ex-member can still read
--     the expense and settlement rows they authored. Those rows are their
--     personal record of money they paid. Deleting the group destroys them.
--
-- ALLOWED (unchanged behaviour) when neither tier fires. That covers, checked
-- one by one:
--   * A true solo group (owner only). The legitimate path. UNCHANGED.
--   * A LEGACY group with GUEST placeholders carrying unsettled balances
--     ("Dubai Trip" with Ali/Sara typed in by hand, nobody joined). Such rows
--     can no longer be CREATED — enforce-active-group-transaction-members.sql:
--     20-27 requires ≥2 connected members and connected split participants, and
--     splitStore.createGroup only mints profile-linked members
--     (src/stores/splitStore.ts:388-414) — but that migration "intentionally
--     preserved" existing rows (:4-6), so production still holds them. Guests
--     can never settle (a settlement needs both members connected,
--     enforce-active-group-transaction-members.sql:96-107), so gating on their
--     balances would strand every legacy group forever with archive as the only
--     exit. The same reasoning covers the owner's own residue. The balance test
--     is therefore scoped to profile-linked non-owner members: the one
--     deliberate narrowing of the audit's "every member's net balance is zero"
--     suggestion, and what keeps requirement 3 (solo deletion unchanged) true.
--     VERIFIED on the live throwaway database, not reasoned about — see the
--     VALIDATION section: a legacy owner+guest group with a 100.00 guest
--     imbalance still deletes cleanly.
--   * A group whose other real members ALL left through leave_group — that RPC
--     already forced their net to zero, so Tier B passes by construction.
--   * A group whose other real members deleted their Hisaab accounts. Their
--     group_members.profile_id is NULL by then (FK ON DELETE SET NULL,
--     schema:319, plus the explicit NULL write at account-deletion.sql:640-643),
--     so no live account is harmed and Tier B correctly does not fire. Their
--     retained, anonymized rows die with the group — which is acceptable
--     precisely because no surviving account can read them.
--
-- REFUSED-AND-STUCK, on purpose (the case that makes archive_group necessary):
--   A member deletes their Hisaab account owing money. audit-p0-account-
--   deletion.sql:319-333 (residual risk R1) documents that the debt is retained
--   but becomes unsettleable, because a new settlement needs BOTH parties
--   connected (enforce-active-group-transaction-members.sql:84-99). If that
--   departed member still had a live account they would trip Tier B forever —
--   they do not (profile_id is NULL), so deletion IS allowed in the R1 case.
--   But the SURVIVING member's own net is also ≠ 0 and leave_group will refuse
--   their exit forever. Archive is that group's only honest end state.
--
-- WHY A REFUSAL AND NOT A SOFT DELETE OF THE GROUP:
--   A tombstoned split_groups row would need every read path, RLS policy and FK
--   in the group subtree to learn about it; `archived_at` (§3) gives the same
--   "this group is over" affordance with one new column, no policy rewrites and
--   full readability preserved. Hard deletion stays possible exactly where it
--   harms nobody.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 0.1 — WHY supabase-migration-audit-p0-group-ledger-integrity.sql IS A
-- HARD PREREQUISITE (this is a data-loss interlock, not a style preference)
-- ─────────────────────────────────────────────────────────────────────────────
-- splitStore.deleteGroup (src/stores/splitStore.ts:545-556) runs THREE writes,
-- in this order:
--     await groupExpensesDb.deleteByGroup(id);      // supabaseDb.ts:1058-1061
--     await groupSettlementsDb.deleteByGroup(id);   // supabaseDb.ts:1128-1131
--     await splitGroupsDb.delete(id);               // supabaseDb.ts:958-961
-- On a database that has NOT had group-ledger-integrity applied, the first two
-- are REAL hard deletes (granted by "Expense creators can delete their shared
-- group expenses", schema:520, and "Users can manage own settlements" FOR ALL,
-- schema:249 / prelaunch:59-61). Installing this migration's BEFORE DELETE
-- trigger on such a database creates a strictly WORSE failure than the bug it
-- fixes: the two ledgers are wiped by steps 1-2, then step 3 raises — leaving a
-- surviving group whose entire money history is gone, with no cascade to blame
-- and no tombstone.
-- With group-ledger-integrity applied there is no permissive DELETE (or FOR
-- ALL) policy on either table, so steps 1-2 are silent 0-row no-ops (RLS
-- filters, it does not error) and step 3 is the only statement that does
-- anything — which is exactly what this guard is built to arbitrate.
-- Section 0 below therefore ABORTS the migration if any permissive
-- ALL/DELETE policy still exists on either ledger table.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 0.2 — INTERACTION WITH supabase-migration-audit-p0-account-deletion.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Read in full before writing this file; the two are complementary halves of
-- the same hole and neither is sufficient alone.
--   * That migration closes the AUTH-CASCADE door (an owner deleting their
--     ACCOUNT). It refuses with OWNED_GROUPS_WITH_MEMBERS when the caller owns
--     a group with other participants (account-deletion.sql:570-586) and ships
--     transfer_group_ownership (:704-804) as the escape hatch. It explicitly
--     files the CLIENT door — this file — as residual risk R2 (:334-341).
--   * This migration closes the CLIENT door and never touches the FK, the
--     policies, delete_current_user, or transfer_group_ownership. Disjoint
--     objects → either apply order is safe.
--   * REQUIREMENT 3 VERIFIED BY READING, NOT ASSUMED. delete_current_user's own
--     solo-group delete —
--         DELETE FROM public.split_groups g
--          WHERE g.user_id = v_uid
--            AND NOT public.group_has_other_connected_members(g.id, v_uid);
--       (account-deletion.sql:646-650)
--     — is exempt from this trigger twice over: (a) it is SECURITY DEFINER
--     (:551-556), so `current_user` inside it is the function OWNER, never
--     'authenticated'/'anon', and (b) the predicate it deletes under is Tier
--     A's own predicate negated, so even a client-role caller would pass Tier A.
--     Tier B could in principle differ (an ex-member with a live account and a
--     non-zero balance), which is precisely why the role gate — not the
--     predicate — is what guarantees account deletion never regresses. This is
--     the same exemption mechanism the account-deletion migration relies on for
--     group_members_protect_membership_fields (analysis at :265-270) and that
--     group-ledger-integrity relies on for reconcile_group_expense (:349-355).
--   * The auth.users → split_groups ON DELETE CASCADE (schema:194, deliberately
--     LEFT as CASCADE by that migration, rationale at :76-95) is likewise
--     exempt: a referential action executes as the owner of the referencing
--     table, not as the session role. In practice it can no longer reach a
--     shared group at all, because delete_current_user refuses first and clears
--     solo groups itself.
--   * transfer_group_ownership (:704-804) is untouched and remains the
--     resolution path for Tier A: hand the group over, or ask the members to
--     leave, or archive it (§3).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 0.3 — INTERACTION WITH group-ledger-integrity's stated design
-- ─────────────────────────────────────────────────────────────────────────────
-- That file's header (§"WHY HARD DELETE GOES AWAY ENTIRELY") deliberately did
-- NOT add a raising BEFORE DELETE trigger on the two LEDGER tables, because it
-- would have turned deleteByGroup's harmless no-op into a thrown error and
-- broken group deletion. That reasoning is unaffected here: this migration adds
-- no trigger to group_expenses/group_settlements DELETE. It puts the single
-- raising guard on the PARENT (split_groups), which is the one statement in the
-- flow that is supposed to decide whether the teardown may happen at all.
-- Its manual staging step 8 ("as the group owner: delete the whole group —
-- succeeds, and every expense/settlement is gone via FK cascade") remains true
-- for a solo group, and is now correctly REFUSED for a shared one. Update that
-- checklist when re-running it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT ARCHIVE MEANS (§3-§6)
-- ─────────────────────────────────────────────────────────────────────────────
-- Checked first for an existing archive concept: the only one in the repo is
-- persons.archived_at (supabase-migration-safe-contact-archive.sql:11), a
-- different table with a different lifecycle. split_groups has `settled`
-- (schema:199) — a per-currency "all square" badge the client toggles and
-- untoggles (SplitsPage.tsx:324, GroupDetailPage.tsx:670), NOT a lifecycle
-- state, and reusing it would make an archived group indistinguishable from a
-- settled-but-active one. So a new nullable `archived_at` (+ `archived_by`,
-- mirroring the deleted_at/deleted_by pair at schema:303-314) is introduced.
--   * Archived groups stay fully READABLE by every member — no policy changes.
--   * No new expenses or settlements: two dedicated triggers (§5), NOT an edit
--     of tg_group_expenses_require_connected_members /
--     tg_group_settlements_require_connected_members. Those two belong to
--     group-ledger-integrity and are CREATE OR REPLACEd by it wholesale; adding
--     the archive rule inside them would be silently reverted the next time
--     that file is re-applied. Separate trigger names = no clobber in either
--     direction.
--   * Nobody new can JOIN an archived group (§5c), including through the
--     SECURITY DEFINER join/invite RPCs — that guard is deliberately NOT
--     role-gated, since join_group_by_code (p0-launch-blockers.sql:223) and
--     accept_group_invite (:298) run as definer and would otherwise walk past
--     it. It blocks only transitions INTO 'connected', so
--     delete_current_user's status='left' write (account-deletion.sql:640-643)
--     and leave_group's (safe-leave-group.sql:196-198) still work on an
--     archived group.
--   * archived_at may not be written directly by a client (§4), same shape as
--     tg_persons_protect_archive (safe-contact-archive.sql:108-127), so the
--     group_event and the notification fan-out can never be skipped.
--   * Reconciliation through reconcile_group_expense stays possible on an
--     archived group (definer → exempt). It moves no money, only a flag, and
--     leaving it open means an owner can still tidy the record before winding
--     down.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- KNOWN RESIDUAL RISKS — deliberately not closed here
-- ─────────────────────────────────────────────────────────────────────────────
--   G1. NO CLIENT UI EXISTS YET for archive/unarchive, and the delete path does
--       not map the two new error codes. Until src/ ships that (handover list
--       in the accompanying notes), an owner tapping Delete on a shared group
--       gets a raw PostgREST error string through
--       GroupDetailPage.handleDelete (src/pages/GroupDetailPage.tsx:381-395,
--       which has no try/catch at all). The DATA is safe either way — that is
--       the point of the guard — but the UX is a dead end until then. Ship the
--       client change in the same release as this migration.
--   G2. §5c raises inside join_group_by_code / accept_group_invite when someone
--       tries to join an ARCHIVED group. Those RPCs commit a
--       join_code_attempts row for the brute-force limiter, and a raise rolls
--       that evidence back — the exact failure mode audit C5 fixed for the
--       code-not-found path (supabase-migration-audit-p0-join-abuse-limits.sql
--       SECTION 3). The window is narrow (archived groups only, and the code
--       must still be valid and unexpired), but the clean fix is for
--       join_group_by_code to check archived_at itself and RETURN a status
--       instead. Do that when that RPC is next edited; do not fold it into
--       this file, which must not own that function.
--   G3. Tier B lets a group be hard-deleted once every other real participant
--       has DELETED THEIR ACCOUNT, even with balances outstanding — the
--       anonymized rows audit-p0-account-deletion.sql fought to retain then die
--       with the group. This is deliberate (no surviving account can read them,
--       see the rule section) but it is the one case where retained history is
--       still destroyable. If the privacy/records policy ever says otherwise,
--       widen Tier B to `member_status = 'left'` regardless of profile_id.
--   G4. Archive is a group-level freeze with no per-currency nuance, unlike the
--       `settled` badge. A group that is done in AED but live in PKR must not
--       be archived; nothing stops an owner doing it anyway (they can
--       unarchive).
--   G5. The guard cannot fire for a service_role / Studio DELETE. That is
--       intentional (support must retain a way out) but it means the ONLY
--       remaining path to destroying a shared ledger is an operator action.
--       Treat a manual split_groups DELETE as a privileged, logged operation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDATION — this migration was EXECUTED, not just written.
-- ─────────────────────────────────────────────────────────────────────────────
-- A throwaway PostgreSQL 15.19 was loaded with an auth shim (auth.users,
-- auth.uid(), real anon/authenticated/service_role roles) plus, in order:
--   supabase-schema.sql, fix-rls-recursion, prelaunch-hardening,
--   p0-launch-blockers, reconciliation, safe-leave-group,
--   enforce-active-group-transaction-members,
--   fix-group-expense-reconciliation-rpc, audit-p0-group-ledger-integrity,
--   THIS FILE, then audit-p0-account-deletion and audit-p0-notifications.
-- All applied clean. Every DELETE/write below was issued from a genuine
-- `SET ROLE authenticated` session with request.jwt.claim.sub set.
--
--   PRECONDITION: applying this file BEFORE group-ledger-integrity aborted with
--     the Section 0 message, naming all three offending policies
--     ("Expense creators can delete…", "Connected members can delete…",
--      "Users can manage own settlements" FOR ALL). Nothing was left behind
--     (no archived_at column). The interlock works.
--   TIER A: owner deletes a group with a connected member Bilal ->
--     GROUP_HAS_OTHER_MEMBERS, DETAIL '1 other member(s) still in "Dubai Trip":
--     Bilal'. Group row and expense row both still present afterwards.
--   TIER B: same group after Bilal goes status='left' owing 150 ->
--     GROUP_HAS_OUTSTANDING_BALANCES, DETAIL 'Bilal owes AED 150.00'.
--     Attempting to settle that debt first FAILED with
--     INACTIVE_GROUP_MEMBER (enforce-active-group-transaction-members) — i.e.
--     the R1 dead-end from audit-p0-account-deletion.sql:319-333 reproduced
--     live. That group has no exit except archive_group. This is the single
--     strongest argument for §3-§6 existing at all.
--   ALLOWED: the legacy owner+guest group with a 100.00 guest imbalance
--     deleted cleanly; the pure solo group deleted cleanly. Requirement 3 holds.
--   ARCHIVE: archive_group returned
--     {"success":true,"reason_code":"GROUP_ARCHIVED","archived_at":…}; a second
--     call returned ALREADY_ARCHIVED with success:true; a non-owner got
--     NOT_GROUP_OWNER while still being able to SELECT the group and its
--     expenses. group_archived event written, notification fanned out to the
--     other connected member — verified on BOTH notification schemas (base
--     columns, and the template/params/actor_id columns after
--     audit-p0-notifications was applied: template='group_archived',
--     params.groupName='Dubai Trip').
--   FROZEN: in the archived group a new expense, a soft-delete UPDATE, and a
--     new connected membership were all refused (GROUP_ARCHIVED); a direct
--     PATCH of archived_at was refused (GROUP_ARCHIVE_RPC_ONLY); RENAMING the
--     group still worked; a member could still go status='left'. Deleting an
--     archived shared group is still refused by the delete guard.
--   UNARCHIVE: reason_code GROUP_UNARCHIVED, group_unarchived event written,
--     and a new expense + settlement then inserted successfully.
--   ACCOUNT DELETION (requirement 3, proven not assumed): with this guard
--     installed, delete_current_user() called from a real `authenticated`
--     session (a) still raised OWNED_GROUPS_WITH_MEMBERS for an owner of a
--     shared group, (b) succeeded for a member, leaving the group and ledger
--     intact and the membership 'left'/profile_id NULL, and (c) succeeded for a
--     user owning three SOLO groups — all three were deleted by §4c's sweep and
--     the auth row removed. The definer exemption holds.
--   IDEMPOTENCY: applied three times in a row on the fully-loaded stack, no
--     errors; every verification query below runs and returns the expected
--     shape.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 0. PRECONDITION INTERLOCK — see Section 0.1 of the header.
-- Refuse to install the guard while a client can still hard-delete the two
-- ledger tables directly, because splitStore.deleteGroup would then destroy
-- the ledger BEFORE hitting this guard.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(format('%s.%s (%s)', tablename, policyname, cmd), '; ' ORDER BY tablename, policyname)
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('group_expenses', 'group_settlements')
     AND permissive = 'PERMISSIVE'
     AND cmd IN ('ALL', 'DELETE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: a client can still hard-DELETE group ledger rows (%). Apply supabase-migration-audit-p0-group-ledger-integrity.sql FIRST, then re-run this file. Installing the split_groups delete guard now would let splitStore.deleteGroup wipe every expense and settlement before the guard refuses, leaving a surviving group with an empty ledger.',
      v_bad
      USING ERRCODE = 'P0001';
  END IF;

  IF to_regclass('public.split_groups') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.split_groups does not exist — apply supabase-schema.sql first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Server-side net balance per member.
--
-- Lifted verbatim (shape, sign convention, rounding and the deleted_at filter)
-- from leave_group's balance CTE, supabase-migration-safe-leave-group.sql:
-- 110-136, generalised from "the caller" to "every member of the group":
--   + amount        for every live expense the member PAID   (paid_by)
--   - split amount  for every live split assigned to them    (splits[].memberId)
--   + amount        for every live settlement they SENT      (from_member)
--   - amount        for every live settlement they RECEIVED  (to_member)
-- Positive net = the member is owed money. Negative = the member owes.
--
-- Kept as its own function (rather than inlined in the trigger) so the guard,
-- the archive RPC's diagnostics and the verification queries at the bottom all
-- read balances through ONE definition — the drift between a guard's arithmetic
-- and a report's arithmetic is exactly how a money app ships a lie.
-- ═══════════════════════════════════════════════════════════════════════════

-- Output columns are prefixed `member_*` on purpose: a SQL-language function's
-- RETURNS TABLE names are in scope inside its own body, and `display_name`,
-- `profile_id` and `status` are all real group_members columns — the prefix
-- removes any chance of an ambiguous-reference failure.
CREATE OR REPLACE FUNCTION public.group_member_net_balances(p_group_id TEXT)
RETURNS TABLE (
  member_id         TEXT,
  member_name       TEXT,
  member_profile_id UUID,
  member_status     TEXT,
  net               NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    gm.id,
    gm.display_name,
    gm.profile_id,
    gm.status,
    round(COALESCE((
      SELECT SUM(delta) FROM (
        SELECT e.amount AS delta
          FROM public.group_expenses e
         WHERE e.group_id = p_group_id
           AND e.deleted_at IS NULL
           AND e.paid_by = gm.id
        UNION ALL
        SELECT -COALESCE((split.value->>'amount')::NUMERIC, 0)
          FROM public.group_expenses e
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS split(value)
         WHERE e.group_id = p_group_id
           AND e.deleted_at IS NULL
           AND COALESCE(split.value->>'memberId', split.value->>'member_id') = gm.id
        UNION ALL
        SELECT s.amount
          FROM public.group_settlements s
         WHERE s.group_id = p_group_id
           AND s.deleted_at IS NULL
           AND s.from_member = gm.id
        UNION ALL
        SELECT -s.amount
          FROM public.group_settlements s
         WHERE s.group_id = p_group_id
           AND s.deleted_at IS NULL
           AND s.to_member = gm.id
      ) parts
    ), 0), 2)
  FROM public.group_members gm
 WHERE gm.group_id = p_group_id;
$$;

COMMENT ON FUNCTION public.group_member_net_balances(TEXT) IS
  'Net position of every member of a group, using the same arithmetic, sign convention, rounding and deleted_at filter as leave_group (supabase-migration-safe-leave-group.sql:110-136). Positive = owed money, negative = owes money. Read by the split_groups delete guard and by support/verification queries.';

REVOKE ALL ON FUNCTION public.group_member_net_balances(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.group_member_net_balances(TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. THE GUARD — BEFORE DELETE on split_groups.
--
-- Role-gated to client sessions (`current_user IN ('authenticated','anon')`),
-- the established repo pattern:
--   safe-leave-group.sql:28              (membership field protection)
--   group-ledger-integrity.sql:365, 462  (ledger write validation)
--   safe-contact-archive.sql:114         (contact archive protection)
-- SECURITY DEFINER RPCs (delete_current_user), referential actions, migrations,
-- the service_role key and Studio are all intentionally exempt — support must
-- retain a way to remove a group, and delete_current_user's solo-group sweep
-- must keep working untouched (header Section 0.2).
--
-- Errors are raised, not returned: a BEFORE DELETE trigger has no other channel.
-- ERRCODE P0001 with a STABLE message code as the whole message (never a
-- sentence — the client matches on it), counts/names in DETAIL, and the
-- resolution in HINT. Same contract style as delete_current_user's
-- OWNED_GROUPS_WITH_MEMBERS (account-deletion.sql:581-586).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_split_groups_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_other_count   INTEGER := 0;
  v_other_names   TEXT;
  v_unsettled     TEXT;
  v_currency      TEXT := COALESCE(NULLIF(trim(OLD.currency), ''), '');
BEGIN
  -- Server-side and definer callers keep the old, unconditional behaviour.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;

  -- ── TIER A. Another real, currently-connected participant. ───────────────
  -- Identical predicate to group_has_other_connected_members(OLD.id,
  -- OLD.user_id) (account-deletion.sql:513-537); inlined so the two migrations
  -- have no ordering dependency on each other.
  SELECT count(*),
         string_agg(COALESCE(NULLIF(trim(gm.display_name), ''), 'A member'), ', '
                    ORDER BY gm.display_name)
    INTO v_other_count, v_other_names
    FROM public.group_members gm
   WHERE gm.group_id = OLD.id
     AND gm.status = 'connected'
     AND gm.profile_id IS NOT NULL
     AND gm.profile_id IS DISTINCT FROM OLD.user_id;

  IF v_other_count > 0 THEN
    RAISE EXCEPTION 'GROUP_HAS_OTHER_MEMBERS'
      USING ERRCODE = 'P0001',
            DETAIL  = format('%s other member(s) still in "%s": %s',
                             v_other_count, OLD.name, v_other_names),
            HINT    = 'Archive this group instead (public.archive_group), hand it over with public.transfer_group_ownership, or ask the other members to leave first. Deleting it would erase their expenses and settlements too.';
  END IF;

  -- ── TIER B. No connected member left, but an ex-member with a LIVE Hisaab
  -- account still has a non-zero position in this ledger. 0.01 tolerance is
  -- leave_group's (safe-leave-group.sql:142). Guests (profile_id IS NULL) and
  -- the owner's own residue are deliberately out of scope — header rationale.
  SELECT string_agg(
           format('%s %s %s %s',
                  COALESCE(NULLIF(trim(b.member_name), ''), 'A member'),
                  CASE WHEN b.net < 0 THEN 'owes' ELSE 'is owed' END,
                  v_currency,
                  trim(to_char(abs(b.net), 'FM999999999990.00'))),
           '; ' ORDER BY abs(b.net) DESC)
    INTO v_unsettled
    FROM public.group_member_net_balances(OLD.id) b
   WHERE b.member_profile_id IS NOT NULL
     AND b.member_profile_id IS DISTINCT FROM OLD.user_id
     AND abs(b.net) > 0.01;

  IF v_unsettled IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_HAS_OUTSTANDING_BALANCES'
      USING ERRCODE = 'P0001',
            DETAIL  = format('Unsettled in "%s": %s', OLD.name, v_unsettled),
            HINT    = 'Settle these balances first, or archive the group (public.archive_group) to keep the record without deleting anyone''s history.';
  END IF;

  -- Solo group, or every remaining stakeholder is square / has no account.
  RETURN OLD;
END;
$fn$;

COMMENT ON FUNCTION public.tg_split_groups_guard_delete() IS
  'Refuses a client-issued hard DELETE of a shared split_groups row: GROUP_HAS_OTHER_MEMBERS when another connected profile-linked member exists, GROUP_HAS_OUTSTANDING_BALANCES when an ex-member with a live account still has a non-zero net. Solo-group deletion and every SECURITY DEFINER / referential-action caller (delete_current_user, support, service_role) are unaffected.';

DROP TRIGGER IF EXISTS split_groups_guard_delete ON public.split_groups;
CREATE TRIGGER split_groups_guard_delete
  BEFORE DELETE ON public.split_groups
  FOR EACH ROW EXECUTE FUNCTION public.tg_split_groups_guard_delete();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. archived_at / archived_by — the non-destructive alternative.
-- No group archive concept existed (checked: persons.archived_at is a
-- different table; split_groups.settled is a badge, not a lifecycle state).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.split_groups
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.split_groups
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.split_groups.archived_at IS
  'When set, the group is wound down: fully readable by every member, but no new expenses, settlements or joins. Written ONLY by public.archive_group / public.unarchive_group (a client UPDATE is blocked by split_groups_protect_archive). Distinct from `settled`, which is a reversible all-square badge.';

COMMENT ON COLUMN public.split_groups.archived_by IS
  'Owner who archived the group. NULLed if that account is later deleted.';

CREATE INDEX IF NOT EXISTS idx_split_groups_archived
  ON public.split_groups (archived_at)
  WHERE archived_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. archived_at is RPC-only for clients.
-- Same shape as tg_persons_protect_archive (safe-contact-archive.sql:108-127).
-- Without this, the "Users can manage own groups" FOR ALL policy (schema:205 /
-- prelaunch:55-57) would let the owner PATCH archived_at straight through
-- PostgREST, skipping the group_event and the member notification.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_split_groups_protect_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.archived_at IS DISTINCT FROM OLD.archived_at
          OR NEW.archived_by IS DISTINCT FROM OLD.archived_by) THEN
    RAISE EXCEPTION 'GROUP_ARCHIVE_RPC_ONLY: use archive_group / unarchive_group'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS split_groups_protect_archive ON public.split_groups;
CREATE TRIGGER split_groups_protect_archive
  BEFORE UPDATE ON public.split_groups
  FOR EACH ROW EXECUTE FUNCTION public.tg_split_groups_protect_archive();

COMMENT ON FUNCTION public.tg_split_groups_protect_archive() IS
  'Archive state on split_groups may only change through archive_group / unarchive_group, so the group_event and member notifications can never be skipped. Client roles only; definer RPCs and support are exempt.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. An archived group is frozen.
--
-- 5a/5b: no client INSERT or UPDATE on the two ledger tables while archived.
-- Separate trigger names from group-ledger-integrity's
-- {group_expenses,group_settlements}_require_connected_members on purpose —
-- that migration CREATE OR REPLACEs those functions wholesale, so folding the
-- archive rule into them would be silently reverted on any re-apply.
--
-- All client writes are blocked, including the soft-delete UPDATE
-- (supabaseDb.ts:1047-1057, :1116-1127): removing an expense in an archived
-- group would move everyone's balances after the group was declared finished.
-- Archive is "frozen and readable"; unarchive to edit again.
-- Definer callers stay exempt, so reconcile_group_expense still works.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_block_writes_in_archived_group()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_archived TIMESTAMPTZ;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  SELECT g.archived_at INTO v_archived
    FROM public.split_groups g
   WHERE g.id = NEW.group_id;

  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_ARCHIVED: this group is archived and cannot be changed'
      USING ERRCODE = '42501',
            HINT = 'Unarchive the group (public.unarchive_group) to record anything new in it.';
  END IF;

  -- An UPDATE that moves a row OUT of an archived group is equally forbidden.
  IF TG_OP = 'UPDATE' AND OLD.group_id IS DISTINCT FROM NEW.group_id THEN
    SELECT g.archived_at INTO v_archived
      FROM public.split_groups g
     WHERE g.id = OLD.group_id;

    IF v_archived IS NOT NULL THEN
      RAISE EXCEPTION 'GROUP_ARCHIVED: this group is archived and cannot be changed'
        USING ERRCODE = '42501',
              HINT = 'Unarchive the group (public.unarchive_group) to record anything new in it.';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_block_writes_in_archived_group() IS
  'Blocks client INSERT/UPDATE on group ledger rows belonging to an archived group. Definer RPCs (reconcile_group_expense) and support are exempt.';

DROP TRIGGER IF EXISTS group_expenses_block_when_archived ON public.group_expenses;
CREATE TRIGGER group_expenses_block_when_archived
  BEFORE INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_block_writes_in_archived_group();

DROP TRIGGER IF EXISTS group_settlements_block_when_archived ON public.group_settlements;
CREATE TRIGGER group_settlements_block_when_archived
  BEFORE INSERT OR UPDATE ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_block_writes_in_archived_group();

-- 5c. Nobody new joins an archived group.
-- NOT role-gated: join_group_by_code (p0-launch-blockers.sql:223) and
-- accept_group_invite (:298) are SECURITY DEFINER and would otherwise walk
-- straight past it. Only transitions INTO 'connected' are blocked, so
-- leave_group's status='left' (safe-leave-group.sql:196-198) and
-- delete_current_user's (account-deletion.sql:640-643) still work on an
-- archived group — a member must always be able to get out.
CREATE OR REPLACE FUNCTION public.tg_block_join_archived_group()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_archived TIMESTAMPTZ;
BEGIN
  IF NEW.status IS DISTINCT FROM 'connected' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'connected' THEN
    RETURN NEW;   -- already connected; not a new join.
  END IF;

  SELECT g.archived_at INTO v_archived
    FROM public.split_groups g
   WHERE g.id = NEW.group_id;

  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_ARCHIVED: this group is archived and is not accepting new members'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_block_join_archived_group() IS
  'Blocks new connected memberships in an archived group, including through the SECURITY DEFINER join/invite RPCs. Leaving an archived group is always allowed.';

DROP TRIGGER IF EXISTS group_members_block_join_archived ON public.group_members;
CREATE TRIGGER group_members_block_join_archived
  BEFORE INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_block_join_archived_group();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. archive_group / unarchive_group — owner-facing RPCs.
--
-- Contract: the SAME jsonb shape leave_group returns
-- (safe-leave-group.sql:86-90, :200-207):
--     { "success": bool, "reason_code": text, "user_message": text }
-- plus an "archived_at" convenience field on success, so the client can update
-- its mirror without a re-fetch.
--
-- A group_event ('group_archived' / 'group_unarchived') is ALWAYS written —
-- durable, member-visible history, matching how member_account_deleted and
-- group_ownership_transferred are recorded (account-deletion.sql:613-631,
-- :773-789). Notifications are best-effort on top (see §6a).
-- ═══════════════════════════════════════════════════════════════════════════

-- 6a. Best-effort member notification. Written with base-schema columns only,
-- and with the template/params/actor_id columns when
-- supabase-migration-audit-p0-notifications.sql (which ADDs them, :96-101, all
-- nullable/defaulted) has been applied. Clients render the stored title/body
-- for templates they do not know (src/lib/notificationContent.ts:10-15), so a
-- new template key degrades gracefully instead of showing an empty row.
-- Failures here NEVER abort the archive: the archive is the money-relevant
-- act, a missed inbox row is not.
CREATE OR REPLACE FUNCTION public.notify_group_archive_state(
  p_group_id TEXT,
  p_event_id TEXT,
  p_actor    UUID,
  p_template TEXT,
  p_title    TEXT,
  p_body     TEXT,
  p_params   JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_has_template BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notifications'
       AND column_name = 'template'
  ) INTO v_has_template;

  IF v_has_template THEN
    EXECUTE $q$
      INSERT INTO public.notifications
        (id, user_id, group_id, event_id, type, title, body, template, params, actor_id, read_at, created_at)
      SELECT gen_random_uuid()::text, gm.profile_id, $1, $2, 'group_update',
             left($4, 200), left($5, 1000), $3, $6, $7, NULL, now()
        FROM public.group_members gm
       WHERE gm.group_id = $1
         AND gm.status = 'connected'
         AND gm.profile_id IS NOT NULL
         AND gm.profile_id IS DISTINCT FROM $7
    $q$ USING p_group_id, p_event_id, p_template, p_title, p_body, p_params, p_actor;
  ELSE
    INSERT INTO public.notifications
      (id, user_id, group_id, event_id, type, title, body, read_at, created_at)
    SELECT gen_random_uuid()::text, gm.profile_id, p_group_id, p_event_id, 'group_update',
           left(p_title, 200), left(p_body, 1000), NULL, now()
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.status = 'connected'
       AND gm.profile_id IS NOT NULL
       AND gm.profile_id IS DISTINCT FROM p_actor;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_group_archive_state: notification fan-out skipped (%)', SQLERRM;
END;
$fn$;

COMMENT ON FUNCTION public.notify_group_archive_state(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) IS
  'Best-effort inbox fan-out for archive_group / unarchive_group. Never raises: the archive itself must not fail because a notification could not be written.';

REVOKE ALL ON FUNCTION public.notify_group_archive_state(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- 6b. archive_group
CREATE OR REPLACE FUNCTION public.archive_group(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      UUID := auth.uid();
  v_group    public.split_groups%ROWTYPE;
  v_now      TIMESTAMPTZ := now();
  v_event_id TEXT := gen_random_uuid()::text;
  v_actor    TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  -- One generic answer for "missing group", "guessed id" and "not the owner",
  -- so the RPC never confirms that an unrelated group exists — leave_group's
  -- rule (safe-leave-group.sql:75-91).
  IF v_group.id IS NULL OR v_group.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_OWNER',
      'user_message', 'Only the group owner can archive this group.'
    );
  END IF;

  IF v_group.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'reason_code', 'ALREADY_ARCHIVED',
      'user_message', 'This group is already archived.',
      'archived_at', v_group.archived_at
    );
  END IF;

  UPDATE public.split_groups
     SET archived_at = v_now,
         archived_by = v_uid
   WHERE id = p_group_id;

  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), NULLIF(trim(p.name), ''), 'The group owner')
    INTO v_actor
    FROM public.profiles p
    LEFT JOIN public.group_members gm
      ON gm.group_id = p_group_id AND gm.profile_id = v_uid
   WHERE p.id = v_uid
   LIMIT 1;

  v_actor := COALESCE(v_actor, 'The group owner');

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, v_uid, 'group_archived', 'group', p_group_id,
    v_actor || ' archived this group. It stays readable, but nothing new can be added.',
    jsonb_build_object(
      'groupId',    p_group_id,
      'groupName',  v_group.name,
      'currency',   v_group.currency,
      'actorName',  v_actor,
      'archivedAt', v_now
    ),
    v_now
  );

  PERFORM public.notify_group_archive_state(
    p_group_id, v_event_id, v_uid, 'group_archived',
    'Group archived',
    v_actor || ' archived ' || v_group.name || '. It is now read-only.',
    jsonb_build_object('groupId', p_group_id, 'groupName', v_group.name,
                       'currency', v_group.currency, 'actorName', v_actor)
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'GROUP_ARCHIVED',
    'user_message', 'Group archived. Everyone can still see it, but nothing new can be added.',
    'archived_at', v_now
  );
END;
$fn$;

COMMENT ON FUNCTION public.archive_group(TEXT) IS
  'Owner-only, non-destructive alternative to deleting a shared group. Sets split_groups.archived_at (readable by all members, closed to new expenses, settlements and joins) and emits a group_archived event. Returns leave_group''s { success, reason_code, user_message } shape; reason_code is NOT_GROUP_OWNER, ALREADY_ARCHIVED or GROUP_ARCHIVED.';

REVOKE ALL ON FUNCTION public.archive_group(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_group(TEXT) TO authenticated;

-- 6c. unarchive_group — an archive with no exit is a trap. Mirrors the contact
-- unarchive precedent (supabase-migration-contacts-merge-unarchive.sql:183-205).
CREATE OR REPLACE FUNCTION public.unarchive_group(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      UUID := auth.uid();
  v_group    public.split_groups%ROWTYPE;
  v_now      TIMESTAMPTZ := now();
  v_event_id TEXT := gen_random_uuid()::text;
  v_actor    TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF v_group.id IS NULL OR v_group.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_OWNER',
      'user_message', 'Only the group owner can reopen this group.'
    );
  END IF;

  IF v_group.archived_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'reason_code', 'NOT_ARCHIVED',
      'user_message', 'This group is already active.'
    );
  END IF;

  UPDATE public.split_groups
     SET archived_at = NULL,
         archived_by = NULL
   WHERE id = p_group_id;

  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), NULLIF(trim(p.name), ''), 'The group owner')
    INTO v_actor
    FROM public.profiles p
    LEFT JOIN public.group_members gm
      ON gm.group_id = p_group_id AND gm.profile_id = v_uid
   WHERE p.id = v_uid
   LIMIT 1;

  v_actor := COALESCE(v_actor, 'The group owner');

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, v_uid, 'group_unarchived', 'group', p_group_id,
    v_actor || ' reopened this group.',
    jsonb_build_object(
      'groupId',      p_group_id,
      'groupName',    v_group.name,
      'currency',     v_group.currency,
      'actorName',    v_actor,
      'unarchivedAt', v_now
    ),
    v_now
  );

  PERFORM public.notify_group_archive_state(
    p_group_id, v_event_id, v_uid, 'group_unarchived',
    'Group reopened',
    v_actor || ' reopened ' || v_group.name || '.',
    jsonb_build_object('groupId', p_group_id, 'groupName', v_group.name,
                       'currency', v_group.currency, 'actorName', v_actor)
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'GROUP_UNARCHIVED',
    'user_message', 'Group reopened. You can add expenses again.',
    'archived_at', NULL
  );
END;
$fn$;

COMMENT ON FUNCTION public.unarchive_group(TEXT) IS
  'Owner-only reopen of an archived group. Same { success, reason_code, user_message } shape as archive_group; reason_code is NOT_GROUP_OWNER, NOT_ARCHIVED or GROUP_UNARCHIVED.';

REVOKE ALL ON FUNCTION public.unarchive_group(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unarchive_group(TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the COMMIT. Nothing below writes.
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Objects installed. EXPECT 6 functions and 5 triggers.
SELECT p.proname AS function_name, p.prosecdef AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('tg_split_groups_guard_delete',
                     'tg_split_groups_protect_archive',
                     'tg_block_writes_in_archived_group',
                     'tg_block_join_archived_group',
                     'group_member_net_balances',
                     'notify_group_archive_state',
                     'archive_group',
                     'unarchive_group')
 ORDER BY 1;

SELECT t.tgname AS trigger_name, c.relname AS on_table
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal
   AND t.tgname IN ('split_groups_guard_delete',
                    'split_groups_protect_archive',
                    'group_expenses_block_when_archived',
                    'group_settlements_block_when_archived',
                    'group_members_block_join_archived')
 ORDER BY 2, 1;

-- V2. The archive columns exist and are nullable. EXPECT 2 rows, both YES.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'split_groups'
   AND column_name IN ('archived_at', 'archived_by')
 ORDER BY 1;

-- V3. The interlock still holds: NO permissive ALL/DELETE policy on either
--     ledger table. EXPECT 0 rows. A row here means a client can hard-delete
--     the ledger before this guard ever runs — re-apply
--     supabase-migration-audit-p0-group-ledger-integrity.sql immediately.
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('group_expenses', 'group_settlements')
   AND permissive = 'PERMISSIVE'
   AND cmd IN ('ALL', 'DELETE')
 ORDER BY 1, 2;

-- V4. Which groups a client may still hard-delete, and which are now refused
--     and why. Run BEFORE announcing the change so support knows the blast
--     radius. `verdict` mirrors the trigger's own two tiers exactly.
SELECT
  g.id,
  g.name,
  g.user_id AS owner_user_id,
  g.archived_at,
  (SELECT count(*) FROM public.group_members gm
    WHERE gm.group_id = g.id AND gm.status = 'connected'
      AND gm.profile_id IS NOT NULL
      AND gm.profile_id IS DISTINCT FROM g.user_id) AS other_connected_members,
  (SELECT count(*) FROM public.group_member_net_balances(g.id) b
    WHERE b.member_profile_id IS NOT NULL
      AND b.member_profile_id IS DISTINCT FROM g.user_id
      AND abs(b.net) > 0.01) AS unsettled_live_accounts,
  CASE
    WHEN EXISTS (SELECT 1 FROM public.group_members gm
                  WHERE gm.group_id = g.id AND gm.status = 'connected'
                    AND gm.profile_id IS NOT NULL
                    AND gm.profile_id IS DISTINCT FROM g.user_id)
      THEN 'REFUSED: GROUP_HAS_OTHER_MEMBERS'
    WHEN EXISTS (SELECT 1 FROM public.group_member_net_balances(g.id) b
                  WHERE b.member_profile_id IS NOT NULL
                    AND b.member_profile_id IS DISTINCT FROM g.user_id
                    AND abs(b.net) > 0.01)
      THEN 'REFUSED: GROUP_HAS_OUTSTANDING_BALANCES'
    ELSE 'ALLOWED (solo / everyone square)'
  END AS verdict
  FROM public.split_groups g
 ORDER BY 7, g.name;

-- V5. Per-member net positions for one group — the exact numbers the guard
--     reads. Paste a group id to debug a refusal.
--   SELECT * FROM public.group_member_net_balances('<group id>') ORDER BY net;

-- V6. Archived groups today.
SELECT g.id, g.name, g.currency, g.archived_at, g.archived_by
  FROM public.split_groups g
 WHERE g.archived_at IS NOT NULL
 ORDER BY g.archived_at DESC;

-- V7. Archive/unarchive history. EXPECT 0 rows before first use.
SELECT e.group_id, e.event_type, e.summary, e.actor_profile_id, e.created_at
  FROM public.group_events e
 WHERE e.event_type IN ('group_archived', 'group_unarchived')
 ORDER BY e.created_at DESC
 LIMIT 50;

-- V8. Grants: the two owner RPCs are executable by authenticated and by nobody
--     else; the notification helper is definer-internal (no client grant).
SELECT p.proname,
       pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text              AS acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('archive_group', 'unarchive_group',
                     'group_member_net_balances', 'notify_group_archive_state')
 ORDER BY 1;

-- ────────────────────────────────────────────────────────────────────────────
-- MANUAL STAGING SCRIPT (two accounts, A = owner, B = joined member)
--  1. As A, with B connected: DELETE /rest/v1/split_groups?id=eq.<g>
--       -> 400, message 'GROUP_HAS_OTHER_MEMBERS', detail names B.
--       Re-read the group: it and every expense/settlement are still there.
--  2. B settles up, reconciles, and calls leave_group -> success.
--     As A: DELETE the group -> SUCCEEDS (B left square; Tier B does not fire).
--  3. Rebuild the group. B leaves owing 300 (force it by settling A's side
--     only). As A: DELETE -> 400 'GROUP_HAS_OUTSTANDING_BALANCES', detail
--     'B owes AED 300.00'.
--  4. As A: rpc archive_group -> { success: true, reason_code: 'GROUP_ARCHIVED' }.
--     A group_archived event exists; still-connected members got a notification.
--     As any member: the group, its expenses and its balances all still READ.
--     As A or B: POST a new group_expense -> 42501 'GROUP_ARCHIVED'.
--     PATCH an existing expense (incl. deleted_at) -> 42501 'GROUP_ARCHIVED'.
--     Join by code / accept an invite -> 42501 'GROUP_ARCHIVED'.
--     PATCH /split_groups {archived_at: null} -> 42501 'GROUP_ARCHIVE_RPC_ONLY'.
--  5. As A: rpc unarchive_group -> success; writes work again.
--  6. Solo regression: a pure solo group, and a LEGACY group with only guest
--     placeholders and unsettled guest balances -> DELETE still succeeds
--     (unchanged behaviour).
--  7. Account-deletion regression: as a user owning ONLY solo groups, call
--     delete_current_user() from a real `authenticated` session -> succeeds,
--     the solo groups are gone (definer exemption holds).
-- ────────────────────────────────────────────────────────────────────────────
