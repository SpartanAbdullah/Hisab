-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Group Ledger Integrity (audit item C4)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
-- Apply AFTER:
--   supabase-schema.sql
--   supabase-migration-fix-rls-recursion.sql
--   supabase-migration-prelaunch-hardening.sql
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-safe-leave-group.sql
--   supabase-migration-enforce-active-group-transaction-members.sql
--   supabase-migration-reconciliation.sql
--   supabase-migration-fix-group-expense-reconciliation-rpc.sql
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- Audit 2026-09-02, docs/audit-2026-09/05-security.md H4 (SEC-08) and
-- docs/audit-2026-09/04-supabase.md F-RLS1 — both CONFIRMED, HIGH.
--
-- An ex-member (status='left') keeps their JWT, the group id, and the member
-- ids (all client-side uuidv4, src/stores/splitStore.ts:2). Today they can,
-- straight through PostgREST:
--   (a) INSERT/UPDATE/DELETE group_settlements rows, because the leftover
--       authorship-only FOR ALL policy ORs past every membership-checked
--       per-command policy (permissive policies OR together);
--   (b) UPDATE or hard-DELETE their historical group_expenses rows, because
--       those policies check authorship (auth.uid() = user_id) and never
--       CURRENT membership;
--   (c) change an amount without touching participants, because the
--       validation triggers only re-validate when group_id / paid_by / splits
--       (expenses) or group_id / from_member / to_member (settlements) change,
--       and never check that the ACTING user is an active member.
-- Balances are computed purely from paid_by / splits / from_member / to_member
-- / amount, ignoring the author (src/lib/groupDebts.ts, src/lib/supabaseDb.ts
-- :973-999, :1088-1099), so every remaining member's numbers silently move.
-- In splits_only (ledger-only) mode these two tables ARE the entire money
-- record.
--
-- ────────────────────────────────────────────────────────────────────────────
-- COMPLETE POLICY INVENTORY — BEFORE (every policy that exists on the two
-- tables anywhere in the repo, with source file:line)
-- ────────────────────────────────────────────────────────────────────────────
-- group_expenses
--   ALL        "Users can manage own group expenses"
--                USING (auth.uid() = user_id)
--                supabase-schema.sql:230
--                DROPPED (correctly, no replacement FOR ALL) at
--                supabase-migration-prelaunch-hardening.sql:63-64
--   SELECT     "Members can view shared group expenses"
--                USING (auth.uid() = user_id
--                       OR is_group_member(group_id, auth.uid()))
--                supabase-schema.sql:502-507
--                supabase-migration-fix-rls-recursion.sql:69-75
--                guarded re-create: prelaunch-hardening.sql:432-441
--   INSERT     "Connected members can create shared group expenses"
--                WITH CHECK (auth.uid() = user_id
--                            AND is_group_member(group_id, auth.uid()))
--                supabase-schema.sql:509-514
--                supabase-migration-fix-rls-recursion.sql:77-83
--   UPDATE     "Expense creators can update their shared group expenses"
--                USING (auth.uid() = user_id)
--                supabase-schema.sql:516-518
--                + WITH CHECK (auth.uid() = user_id)
--                supabase-migration-prelaunch-hardening.sql:67-71
--                ^^ ROOT CAUSE (b): authorship only, no membership check.
--   DELETE     "Expense creators can delete their shared group expenses"
--                USING (auth.uid() = user_id)
--                supabase-schema.sql:520-522
--                ^^ ROOT CAUSE (b): hard DELETE on a shared ledger, authorship
--                   only. The client soft-deletes (supabaseDb.ts:1047-1057),
--                   so this grant is only reachable by a raw REST call and by
--                   deleteByGroup (supabaseDb.ts:1058-1061).
--   RESTRICTIVE "Active profiles only"  FOR ALL TO authenticated
--                USING/WITH CHECK (is_current_profile_active())
--                supabase-migration-p0-launch-blockers.sql:74-96
--                (dynamic loop; group_expenses listed at :80)
--                ^^ KEPT — restrictive policies AND, they cannot widen access.
--
-- group_settlements
--   ALL        "Users can manage own settlements"
--                USING (auth.uid() = user_id)
--                supabase-schema.sql:249
--                RE-CREATED with WITH CHECK (auth.uid() = user_id) at
--                supabase-migration-prelaunch-hardening.sql:59-61
--                ^^ ROOT CAUSE (a): the leftover. The parallel policy on
--                   group_expenses was dropped 4 lines later (:63); this one
--                   was not. No later migration drops it (verified against all
--                   46 root-level *.sql files). It is ALSO the only policy in
--                   the repo granting UPDATE on group_settlements — which is
--                   why this migration must add an explicit UPDATE policy or
--                   the settlement soft-delete path breaks.
--   SELECT     "Members can view shared group settlements"
--                USING (auth.uid() = user_id
--                       OR is_group_member(group_id, auth.uid()))
--                supabase-schema.sql:524-529
--                supabase-migration-fix-rls-recursion.sql:86-92
--   INSERT     "Connected members can create shared group settlements"
--                WITH CHECK (auth.uid() = user_id
--                            AND is_group_member(group_id, auth.uid()))
--                supabase-schema.sql:531-536
--                supabase-migration-fix-rls-recursion.sql:94-100
--   DELETE     "Connected members can delete shared group settlements"
--                USING (auth.uid() = user_id)
--                supabase-migration-prelaunch-hardening.sql:307-310
--                ^^ name says "connected members", predicate checks neither
--                   connectedness nor membership.
--   RESTRICTIVE "Active profiles only" — p0-launch-blockers.sql:74-96 (:81).
--                KEPT.
--
-- Other group children audited for the same leftover-FOR ALL pattern — none
-- found, all already per-command:
--   group_members   SELECT schema:352-362 / fix-rls-recursion.sql:32-43;
--                   INSERT schema:364-373 -> p0-launch-blockers.sql:150-161;
--                   UPDATE schema:375-384 -> p0-launch-blockers.sql:163-178;
--                   DELETE prelaunch-hardening.sql:285-295, deliberately
--                   removed again by safe-leave-group.sql:14-17.
--   group_invites   SELECT schema:403-413 / fix-rls-recursion.sql:103-114;
--                   INSERT schema:415-423;
--                   UPDATE schema:425-427 -> p0-launch-blockers.sql:180-190;
--                   DELETE prelaunch-hardening.sql:297-300.
--   group_events    SELECT schema:444-446 / fix-rls-recursion.sql:55-58;
--                   INSERT schema:448-453 / fix-rls-recursion.sql:60-66;
--                   DELETE prelaunch-hardening.sql:302-305.
--   split_groups    "Users can manage own groups" FOR ALL
--                   schema:205; prelaunch-hardening.sql:55-57.
--                   Authorship-only FOR ALL, but split_groups.user_id IS the
--                   single canonical group owner (safe-leave-group.sql:98-106)
--                   and every owner path — rename, settle, join-code refresh,
--                   delete — runs through it. Narrowing it is a separate,
--                   larger change (see F-RLS11 / L13); OUT OF SCOPE here and
--                   deliberately left alone.
--
-- ────────────────────────────────────────────────────────────────────────────
-- POLICY INVENTORY — AFTER
-- ────────────────────────────────────────────────────────────────────────────
-- group_expenses / group_settlements (identical shape on both):
--   SELECT   "Members can view shared group <x>"
--              USING (auth.uid() = user_id
--                     OR is_group_member(group_id, auth.uid()))
--              unchanged — membership-based, ex-members keep read access to
--              rows they authored and lose the rest of the ledger.
--   INSERT   "Active members can create their group <x>"
--              WITH CHECK (auth.uid() = user_id
--                          AND is_group_member(group_id, auth.uid()))
--   UPDATE   "Active members can update their own group <x>"
--              USING      (auth.uid() = user_id
--                          AND is_group_member(group_id, auth.uid()))
--              WITH CHECK (auth.uid() = user_id
--                          AND is_group_member(group_id, auth.uid()))
--              USING pins the OLD row, WITH CHECK the NEW one, so neither
--              user_id reassignment nor group donation is possible.
--   DELETE   (none — hard delete is blocked outright)
--   RESTRICTIVE "Active profiles only" (untouched)
--
-- Section 4 sweeps any PERMISSIVE policy on either table that is not in that
-- expected set — including ones hand-created in Studio that this repo cannot
-- see. That is what makes the drop list provably complete rather than
-- merely complete-against-the-repo.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY HARD DELETE GOES AWAY ENTIRELY (soft-delete is already the client model)
-- ────────────────────────────────────────────────────────────────────────────
-- Both tables carry deleted_at / deleted_by (supabase-schema.sql:303-314) and
-- every client read filters `deleted_at IS NULL`:
--   src/lib/supabaseDb.ts:939-947, :948-956, :961-968, :973-986, :1031-1039
--   src/lib/supabaseDb.ts:1068-1076, :1078-1085, :1088-1100
-- Deletes are already UPDATEs:
--   groupExpensesDb.delete       supabaseDb.ts:1047-1057  (sets deleted_at)
--   groupSettlementsDb.deleteOne supabaseDb.ts:1116-1127  (sets deleted_at)
-- The leave gate and the reconcile RPC both read `deleted_at IS NULL` too
-- (safe-leave-group.sql:110-164; fix-group-expense-reconciliation-rpc.sql:32),
-- so a tombstone is a first-class state server-side as well.
--
-- The ONE remaining hard-DELETE caller is groupExpensesDb.deleteByGroup /
-- groupSettlementsDb.deleteByGroup (supabaseDb.ts:1058-1061, :1128-1131),
-- reached only from splitStore.deleteGroup (src/stores/splitStore.ts:539-540).
-- With no DELETE policy, PostgREST deletes 0 rows and returns success (RLS
-- filters rather than errors), so `deleteByGroup` becomes a silent no-op and
-- the very next line — splitGroupsDb.delete (supabaseDb.ts:911-915) — removes
-- the split_groups row, whose ON DELETE CASCADE (schema:213, :238) reaps every
-- expense and settlement at table-owner level, bypassing RLS. The flow is
-- preserved without a client change. Account deletion is likewise unaffected:
-- delete_current_user (p0-launch-blockers.sql:102-138) cascades from
-- auth.users via group_expenses.user_id / group_settlements.user_id
-- (schema:212, :237).
--
-- A raising BEFORE DELETE trigger was deliberately NOT added: it would turn
-- deleteByGroup's no-op into a thrown error and break group deletion.
--
-- ────────────────────────────────────────────────────────────────────────────
-- CLIENT WRITE PATHS VERIFIED AGAINST THE NEW POLICIES
-- ────────────────────────────────────────────────────────────────────────────
--  1. addGroupExpense        splitStore.ts:626-723 -> supabaseDb.ts:987-1001
--     INSERT, user_id = self, caller is a connected member. PASSES.
--  2. updateGroupExpense     splitStore.ts:724-910 -> supabaseDb.ts:1002-1026
--     UPDATE of own row; the store already refuses non-creators at :733-737.
--     PASSES for a current member; now correctly REFUSED after leaving.
--  3. deleteGroupExpense     splitStore.ts:933-985 -> supabaseDb.ts:1047-1057
--     soft-delete UPDATE of own row. PASSES (was already an UPDATE).
--  4. addSettlement          splitStore.ts:1076   -> supabaseDb.ts:1101-1111
--     INSERT, user_id = self. PASSES.
--  5. deleteSettlement       splitStore.ts:991-1003 -> supabaseDb.ts:1116-1127
--     soft-delete UPDATE of own row. Previously ONLY the leftover FOR ALL
--     policy permitted this UPDATE; the new named UPDATE policy is what keeps
--     it working. PASSES.
--  6. setGroupExpenseReconciled splitStore.ts:912-931 -> supabaseDb.ts:1040-1046
--     Goes through the SECURITY DEFINER RPC reconcile_group_expense
--     (fix-group-expense-reconciliation-rpc.sql:10-62), which runs as the
--     function owner and is not subject to RLS. This is the one legitimate
--     path where a NON-author (the paid_by member) mutates someone else's
--     row; it is preserved untouched, and Section 3's trigger check
--     deliberately exempts definer roles so it keeps working even when the
--     row's author has since left the group.
--  7. deleteGroup            splitStore.ts:533-543 -> supabaseDb.ts:1058-1061,
--     :1128-1131, :911-915. See the hard-delete note above — preserved via
--     FK cascade. (Client follow-up: the two deleteByGroup calls are now dead
--     code and should be removed; leaving them is harmless.)
--  8. Read paths (getByGroup / getAllVisible / getAllVisibleForBalances /
--     probeExists, supabaseDb.ts:939-1039, :1068-1100; dataExport.ts:41-42;
--     GlobalSearch.tsx:57) are SELECT-only and unchanged.
--  9. Ad-hoc splits (the 2026-09 "split without a group" feature) write
--     transactions and loans, never these two tables — grep-verified. Not
--     affected.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Drop the leftover authorship-only FOR ALL policies
-- Permissive policies OR together, so ONE of these re-opens everything the
-- per-command policies below close. Both legacy names are dropped on both
-- tables regardless of which migrations this database has actually seen.
-- ═══════════════════════════════════════════════════════════════════════════

-- supabase-schema.sql:249 + supabase-migration-prelaunch-hardening.sql:59-61
DROP POLICY IF EXISTS "Users can manage own settlements" ON public.group_settlements;

-- supabase-schema.sql:230 (already dropped by prelaunch-hardening.sql:63 —
-- repeated here so a database that never ran that migration is still fixed)
DROP POLICY IF EXISTS "Users can manage own group expenses" ON public.group_expenses;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. Per-command policies: authorship AND current membership
-- SELECT stays membership-based. INSERT/UPDATE require BOTH
-- `auth.uid() = user_id` AND `is_group_member(group_id, auth.uid())`, which
-- is TRUE only for a group_members row with status = 'connected'
-- (supabase-schema.sql:335-348). Leaving flips that row to 'left'
-- (safe-leave-group.sql:196-198), so departure revokes write access the
-- instant it happens. DELETE gets no policy at all.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── group_expenses ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Members can view shared group expenses" ON public.group_expenses;
CREATE POLICY "Members can view shared group expenses"
  ON public.group_expenses FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_expenses.group_id, auth.uid())
  );

DROP POLICY IF EXISTS "Connected members can create shared group expenses" ON public.group_expenses;
DROP POLICY IF EXISTS "Active members can create their group expenses" ON public.group_expenses;
CREATE POLICY "Active members can create their group expenses"
  ON public.group_expenses FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_expenses.group_id, auth.uid())
  );

-- USING pins the OLD row, WITH CHECK the NEW one: an ex-member fails USING,
-- and a current member cannot re-assign user_id or move the row into another
-- group (both halves must hold).
DROP POLICY IF EXISTS "Expense creators can update their shared group expenses" ON public.group_expenses;
DROP POLICY IF EXISTS "Active members can update their own group expenses" ON public.group_expenses;
CREATE POLICY "Active members can update their own group expenses"
  ON public.group_expenses FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    AND public.is_group_member(group_expenses.group_id, auth.uid())
  )
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_expenses.group_id, auth.uid())
  );

-- No DELETE policy: hard delete is routed to UPDATE deleted_at (the client
-- already does exactly this — supabaseDb.ts:1047-1057).
DROP POLICY IF EXISTS "Expense creators can delete their shared group expenses" ON public.group_expenses;

-- ── group_settlements ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Members can view shared group settlements" ON public.group_settlements;
CREATE POLICY "Members can view shared group settlements"
  ON public.group_settlements FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_settlements.group_id, auth.uid())
  );

DROP POLICY IF EXISTS "Connected members can create shared group settlements" ON public.group_settlements;
DROP POLICY IF EXISTS "Active members can create their group settlements" ON public.group_settlements;
CREATE POLICY "Active members can create their group settlements"
  ON public.group_settlements FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_settlements.group_id, auth.uid())
  );

-- NEW. group_settlements had no named UPDATE policy anywhere in the repo —
-- the dropped FOR ALL was the only thing permitting the settlement
-- soft-delete at supabaseDb.ts:1116-1127. Without this policy that flow
-- would start failing with the "only the recorder can remove this
-- settlement" 0-row error for everyone.
DROP POLICY IF EXISTS "Active members can update their own group settlements" ON public.group_settlements;
CREATE POLICY "Active members can update their own group settlements"
  ON public.group_settlements FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    AND public.is_group_member(group_settlements.group_id, auth.uid())
  )
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_settlements.group_id, auth.uid())
  );

-- No DELETE policy — see the header note; soft-delete is the model.
DROP POLICY IF EXISTS "Connected members can delete shared group settlements" ON public.group_settlements;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Validation triggers: acting user must be an active member, and
--            amount-only edits are validated too
--
-- Replaces the two functions from
-- supabase-migration-enforce-active-group-transaction-members.sql:10-72 and
-- :74-112 (same function and trigger names, so this is a drop-in upgrade).
--
-- Added:
--   (1) The ACTING user (auth.uid()) must be a connected member of both the
--       OLD and the NEW group_id — defence in depth behind Section 2, and the
--       part RLS cannot express for a future non-PostgREST caller.
--   (2) user_id is immutable, and on INSERT must be the acting user.
--   (3) `amount` joins the list of fields that re-triggers participant
--       validation, closing the amount-only-update hole. (The client always
--       ships splits alongside an amount change — splitStore.ts:853-867 — so
--       this only bites raw REST writes.)
--
-- Deliberately scoped to client roles (`current_user IN ('authenticated',
-- 'anon')`), the same pattern as
-- supabase-migration-safe-leave-group.sql:28. SECURITY DEFINER RPCs run as
-- the function owner and do their own authorisation; exempting them is what
-- keeps reconcile_group_expense working when the row's AUTHOR has left the
-- group but the paid_by member (the caller) has not. Checking the author's
-- membership instead of the actor's would break that legitimate flow.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_group_expenses_require_connected_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_client BOOLEAN := current_user IN ('authenticated', 'anon');
BEGIN
  -- (1)+(2) Author/actor integrity for every client-issued write.
  IF v_client THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.user_id IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: group expenses must be authored by the signed-in user'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: group expense authorship cannot be reassigned'
          USING ERRCODE = '42501';
      END IF;
      IF NOT public.is_group_member(OLD.group_id, v_uid) THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: only active connected members can change group expenses'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NOT public.is_group_member(NEW.group_id, v_uid) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: only active connected members can write group expenses'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- (3) Participant-shape validation, now including amount changes.
  IF TG_OP = 'INSERT'
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.paid_by IS DISTINCT FROM OLD.paid_by
     OR NEW.splits IS DISTINCT FROM OLD.splits
     OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    IF (
      SELECT count(*)
        FROM public.group_members AS gm
       WHERE gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) < 2 THEN
      RAISE EXCEPTION 'NOT_ENOUGH_ACTIVE_GROUP_MEMBERS: at least two connected members are required'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.paid_by
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: paid_by must be an active connected member of this group'
        USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(COALESCE(NEW.splits, '[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_GROUP_SPLITS: splits must be a JSON array'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(NEW.splits, '[]'::jsonb)) AS split(value)
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.group_members AS gm
          WHERE gm.id = COALESCE(split.value->>'memberId', split.value->>'member_id')
            AND gm.group_id = NEW.group_id
            AND gm.status = 'connected'
       )
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: every split participant must be an active connected member of this group'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_expenses_require_connected_members ON public.group_expenses;
CREATE TRIGGER group_expenses_require_connected_members
  BEFORE INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_require_connected_members();

COMMENT ON FUNCTION public.tg_group_expenses_require_connected_members() IS
  'Preserves historical expenses while requiring that the acting client user is an active connected member for every write, that authorship is never reassigned, and that paid_by plus every split participant are connected members whenever participants OR the amount change.';

CREATE OR REPLACE FUNCTION public.tg_group_settlements_require_connected_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_client BOOLEAN := current_user IN ('authenticated', 'anon');
BEGIN
  IF v_client THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.user_id IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: group settlements must be authored by the signed-in user'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: group settlement authorship cannot be reassigned'
          USING ERRCODE = '42501';
      END IF;
      IF NOT public.is_group_member(OLD.group_id, v_uid) THEN
        RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: only active connected members can change group settlements'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NOT public.is_group_member(NEW.group_id, v_uid) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_AUTHOR: only active connected members can write group settlements'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.from_member IS DISTINCT FROM OLD.from_member
     OR NEW.to_member IS DISTINCT FROM OLD.to_member
     OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.from_member
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) OR NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.to_member
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: settlements require active connected group members'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_settlements_require_connected_members ON public.group_settlements;
CREATE TRIGGER group_settlements_require_connected_members
  BEFORE INSERT OR UPDATE ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_settlements_require_connected_members();

COMMENT ON FUNCTION public.tg_group_settlements_require_connected_members() IS
  'Preserves settlement history while requiring that the acting client user is an active connected member for every write, that authorship is never reassigned, and that both members are connected whenever participants OR the amount change.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Sweep: drop ANY remaining permissive policy on the two tables
-- that is not in the expected set.
--
-- This is what makes the drop list provably complete rather than complete
-- only against the 46 root-level SQL files. Production has 40+ hand-applied
-- migrations with no ledger (audit F-MIG1) and Studio-authored policies would
-- be invisible to this repo — and a single stray permissive policy ORs the
-- whole fix away. RESTRICTIVE policies are skipped: they AND, so they can
-- only narrow access ("Active profiles only" is preserved).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  r RECORD;
  v_expected TEXT[];
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['group_expenses', 'group_settlements'] LOOP
    IF v_table = 'group_expenses' THEN
      v_expected := ARRAY[
        'Members can view shared group expenses',
        'Active members can create their group expenses',
        'Active members can update their own group expenses'
      ];
    ELSE
      v_expected := ARRAY[
        'Members can view shared group settlements',
        'Active members can create their group settlements',
        'Active members can update their own group settlements'
      ];
    END IF;

    FOR r IN
      SELECT policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = v_table
         AND permissive = 'PERMISSIVE'
         AND NOT (policyname = ANY (v_expected))
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, v_table);
      RAISE NOTICE 'Dropped unexpected permissive policy "%" on public.%', r.policyname, v_table;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. VERIFICATION — read-only. Run after the COMMIT above.
-- Nothing here writes; every assertion aborts with a descriptive message.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_table TEXT;
  v_count INTEGER;
  v_def TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['group_expenses', 'group_settlements'] LOOP

    -- 5a. The leftover FOR ALL is gone, and no permissive FOR ALL replaced it.
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE' AND cmd = 'ALL';
    IF v_count > 0 THEN
      RAISE EXCEPTION '% still has % permissive FOR ALL policy/policies', v_table, v_count;
    END IF;

    -- 5b. Hard DELETE is impossible: no permissive DELETE policy at all.
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE' AND cmd = 'DELETE';
    IF v_count > 0 THEN
      RAISE EXCEPTION '% still grants hard DELETE (% permissive policy/policies)', v_table, v_count;
    END IF;

    -- 5c. Exactly three permissive policies: SELECT, INSERT, UPDATE.
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE';
    IF v_count <> 3 THEN
      RAISE EXCEPTION '% has % permissive policies, expected exactly 3', v_table, v_count;
    END IF;

    -- 5d. INSERT checks authorship AND current membership.
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE' AND cmd = 'INSERT'
       AND with_check LIKE '%is_group_member%'
       AND with_check LIKE '%user_id%';
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% INSERT policy does not check both authorship and membership', v_table;
    END IF;

    -- 5e. UPDATE checks authorship AND current membership on BOTH sides.
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE' AND cmd = 'UPDATE'
       AND qual LIKE '%is_group_member%'
       AND qual LIKE '%user_id%'
       AND with_check LIKE '%is_group_member%'
       AND with_check LIKE '%user_id%';
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% UPDATE policy does not check authorship AND membership in both USING and WITH CHECK', v_table;
    END IF;

    -- 5f. SELECT is still membership-based (shared reads must keep working).
    SELECT count(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_table
       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
       AND qual LIKE '%is_group_member%';
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% SELECT policy is missing or no longer membership-based', v_table;
    END IF;

    -- 5g. The soft-delete escape hatch actually exists: deleted_at column.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table
         AND column_name = 'deleted_at'
    ) THEN
      RAISE EXCEPTION '% has no deleted_at column — soft delete cannot replace hard delete', v_table;
    END IF;

    -- 5h. The restrictive soft-deleted-account gate survived the sweep.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = v_table
         AND permissive = 'RESTRICTIVE' AND policyname = 'Active profiles only'
    ) THEN
      RAISE WARNING '% is missing the "Active profiles only" restrictive policy — run supabase-migration-p0-launch-blockers.sql', v_table;
    END IF;
  END LOOP;

  -- 5i. Triggers are installed and carry the new author/amount checks.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'group_expenses_require_connected_members'
       AND tgrelid = 'public.group_expenses'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'group expense active-member trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'group_settlements_require_connected_members'
       AND tgrelid = 'public.group_settlements'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'group settlement active-member trigger is missing';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_expenses_require_connected_members()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%INACTIVE_GROUP_AUTHOR%' THEN
    RAISE EXCEPTION 'expense trigger does not enforce acting-member authorship';
  END IF;
  IF v_def NOT LIKE '%NEW.amount IS DISTINCT FROM OLD.amount%' THEN
    RAISE EXCEPTION 'expense trigger does not re-validate on amount changes';
  END IF;
  IF v_def NOT LIKE '%jsonb_array_elements%' THEN
    RAISE EXCEPTION 'expense trigger lost its split-participant validation';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_settlements_require_connected_members()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%INACTIVE_GROUP_AUTHOR%' THEN
    RAISE EXCEPTION 'settlement trigger does not enforce acting-member authorship';
  END IF;
  IF v_def NOT LIKE '%NEW.amount IS DISTINCT FROM OLD.amount%' THEN
    RAISE EXCEPTION 'settlement trigger does not re-validate on amount changes';
  END IF;
  IF v_def NOT LIKE '%gm.status = ''connected''%' THEN
    RAISE EXCEPTION 'settlement trigger lost its connected-membership validation';
  END IF;

  -- 5j. The one legitimate non-author write path must still exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reconcile_group_expense'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'reconcile_group_expense is missing or is no longer SECURITY DEFINER — the payer reconcile flow would break';
  END IF;

  RAISE NOTICE 'Group ledger integrity verification passed';
  RAISE NOTICE 'Ex-members can no longer insert, rewrite or hard-delete group ledger rows';
  RAISE NOTICE 'Historical expense and settlement rows remain untouched and readable';
END;
$$;

-- Final policy inventory — eyeball this against the AFTER table in the header.
SELECT
  tablename,
  policyname,
  permissive,
  cmd,
  qual        AS using_expression,
  with_check  AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('group_expenses', 'group_settlements')
ORDER BY tablename, permissive DESC, cmd, policyname;

-- Trigger inventory on the two tables.
SELECT
  c.relname   AS table_name,
  t.tgname    AS trigger_name,
  p.proname   AS function_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc  p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND c.relname IN ('group_expenses', 'group_settlements')
ORDER BY c.relname, t.tgname;

-- Blast radius of the hard-delete removal: how many live rows are authored by
-- users who are no longer connected members of the group. These rows are now
-- frozen (readable, not editable, not deletable) — which is the intent.
SELECT
  'group_expenses' AS table_name,
  count(*)         AS rows_authored_by_non_members
FROM public.group_expenses e
WHERE e.deleted_at IS NULL
  AND NOT public.is_group_member(e.group_id, e.user_id)
UNION ALL
SELECT
  'group_settlements',
  count(*)
FROM public.group_settlements s
WHERE s.deleted_at IS NULL
  AND NOT public.is_group_member(s.group_id, s.user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Manual staging verification (two accounts, one shared group):
--  1. As member B (connected): add an expense and a settlement — both succeed.
--  2. As member B: soft-delete the settlement (PATCH deleted_at) — succeeds.
--  3. Settle all balances, reconcile B's expenses, then call leave_group as B.
--  4. As the now-left B, straight through PostgREST with B's JWT:
--       PATCH /rest/v1/group_expenses?id=eq.<own row>   {"amount": 1}
--         -> 0 rows affected (RLS), and a raw SQL attempt raises
--            INACTIVE_GROUP_AUTHOR.
--       DELETE /rest/v1/group_settlements?id=eq.<own row>
--         -> 0 rows affected; the row is still there on re-read.
--       POST /rest/v1/group_settlements  {fabricated A-paid-B row}
--         -> 42501 / 0 rows.
--  5. As member A (still connected): open the group — B's historical rows are
--     all still visible and balances are unchanged.
--  6. As member A: edit and soft-delete A's OWN expense — both still succeed.
--  7. As the payer of an expense authored by the departed B: toggle
--     reconciliation from the UI — still succeeds (definer RPC path).
--  8. As the group owner: delete the whole group — succeeds, and every
--     expense/settlement is gone via FK cascade.
-- ────────────────────────────────────────────────────────────────────────────
