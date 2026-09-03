-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3: RLS init-plan hoisting, FK covering indexes, ledger PKs
--   the whole PERFORMANCE half of the Supabase advisor, in one pass
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
-- The Supabase PERFORMANCE advisor was run against production on 2026-09-03
-- (raw output archived in docs/audit-2026-09/prod-verification-2026-09-03.md).
-- It returned 173 findings in schema `public`:
--
--   87 WARN  auth_rls_initplan            ← §2 fixes ALL of them, generically
--   20 WARN  multiple_permissive_policies ← 15 already fixed; 5 fixed in §1
--    1 WARN  duplicate_index              ← §3
--   27 INFO  unindexed_foreign_keys       ← §4 covers the 14 that are queried
--   36 INFO  unused_index                 ← deliberately NOT touched, see below
--    2 INFO  no_primary_key               ← §5
--
-- Production is schema + the 40 historical migrations only, so its numbers are
-- a floor. Measured in the test harness (supabase/tests/run.sh) against the
-- FULL corpus — schema + all 71 migration files in apply-order.txt — the real
-- surface is bigger:
--
--   121 policies in schema public
--    95 of them contain at least one bare `auth.uid()`   (production: 87)
--   140 bare `auth.uid()` call sites in total
--     0 bare `auth.jwt()` / `auth.role()` / `current_setting()` call sites
--
-- §1 removes one of those 95 policies (2 of the 140 call sites) and writes its
-- three replacements pre-hoisted, so §2 then rewrites the remaining 94 policies
-- / 138 call sites and the file leaves ZERO behind. On a re-run §2 rewrites 0.
--
-- §2 is written generically (a DO block over pg_policy,
-- not a hand-listed 121-policy script) for three reasons: the count differs
-- between production and the repo corpus, a hand list silently rots the moment
-- anyone adds a policy, and re-running it after a future migration re-fixes
-- whatever that migration reintroduced. It is a no-op on a database that is
-- already clean.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────
-- Canonical order: `supabase/tests/apply-order.txt`.
-- Apply AFTER every other `supabase-migration-*.sql` in the repo — every
-- audit-p0 file, every p1/p2/p3 file — and specifically AFTER
-- `supabase-migration-p2-edit-history.sql`. It sits immediately BEFORE
-- `supabase-migration-p3-invariant-monitoring.sql` (which creates no policy,
-- so nothing this file rewrote can be undone by it) and before
-- `supabase-migration-p3-rpc-execute-grants.sql` (functions and grants only).
--
-- §2 MUST run late: it can only wrap the policies that exist when it runs. If
-- you later apply a migration that creates or replaces a policy, re-run THIS
-- FILE afterwards. That is safe and cheap — §2 skips policies already wrapped.
--
-- Hard prerequisites (objects this file READS or ALTERs; it creates almost
-- nothing new):
--   public.split_groups + "Users can manage own groups"    prelaunch-hardening:55
--                       + "Members can view shared groups" fix-rls-recursion:46
--   public.group_events + idx_group_events_group_created   supabase-schema.sql:441
--                       + idx_gevents_group_created        performance-indexes.sql:328
--   public.join_code_attempts                              p0-launch-blockers.sql:200
--   public.phone_lookup_attempts                           connections-push-discovery.sql:314
--   public.code_lookup_attempts                            audit-p0-join-abuse-limits.sql:94
--   the 14 tables named in §4                              various
-- Every one of those is guarded: a missing object is skipped with a NOTICE,
-- never an error, so this file also applies cleanly to a partially-migrated
-- database.
--
-- ── ⚠ NO `CONCURRENTLY`, AND WHY ────────────────────────────────────────────
-- Supabase Studio runs a pasted file as ONE transaction, and
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
-- (25001 "CREATE INDEX CONCURRENTLY cannot run inside a transaction block").
-- So §4 uses plain `CREATE INDEX IF NOT EXISTS`, which takes a SHARE lock and
-- blocks writes to that table for the duration of the build.
--
-- At today's data volume (the app is weeks old; every table in §4 is small)
-- that is milliseconds and this file can be pasted whole. If any §4 table has
-- grown large by the time you apply this, do NOT paste the whole file:
--   1. run §1, §2, §3 and §5 as one paste (they are all instantaneous),
--   2. then run each §4 statement SEPARATELY, one per Studio execution, as
--      `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` with the `CONCURRENTLY`
--      keyword added by hand. Check afterwards that none is `indisvalid = false`
--      (V-4 at the bottom finds a failed concurrent build).
--
-- ── unused_index: DELIBERATELY LEFT ALONE ───────────────────────────────────
-- 36 indexes have never been scanned. Every one of them is young: the advisor's
-- counters come from `pg_stat_user_indexes`, which was last reset when the
-- database was created, and most of these indexes were added by
-- `supabase-migration-performance-indexes.sql` and the investments/committees
-- migrations for features that have barely any production traffic yet. Dropping
-- an index because a pre-launch app has not used it is how you find out at
-- launch that it was load-bearing. FOLLOW-UP, not now: re-run the advisor 30
-- days after real traffic starts, and only then consider dropping any of these
-- that are still at zero scans:
--
--   activities        idx_activities_user_entity_ts
--   budgets           idx_budgets_user_updated, idx_budgets_user_deleted
--   contact_link_requests   contact_link_requests_to_pending_idx
--   device_push_tokens      device_push_tokens_user_idx
--   emi_schedules     idx_emi_user_installment
--   goals             idx_goals_user_created
--   group_expenses    idx_gexp_live_created
--   group_invites     idx_ginvites_token_active, idx_ginvites_group_active
--   group_settlements idx_gsett_group_live, idx_gsett_live_created
--   investment_markets      idx_investment_markets_user_deleted,
--                           idx_investment_markets_user_created
--   investment_prices       idx_investment_prices_user_deleted
--   investment_trades       idx_investment_trades_user_created,
--                           idx_investment_trades_user_deleted,
--                           idx_investment_trades_market,
--                           idx_investment_trades_user_symbol
--   linked_settlement_requests  idx_lsr_from_created, idx_lsr_to_created,
--                           idx_lsr_from_pending, idx_lsr_to_pending, idx_lsr_pair
--   linked_transaction_requests idx_ltr_to_pending, idx_ltr_from_pending
--   persons           persons_active_user_name_idx, persons_user_id_idx
--   profiles          idx_profiles_is_deleted, profiles_phone_discovery_idx
--   recurring_transactions  idx_recurring_user_due, recurring_due_date_idx
--   remittances       remittances_user_id_idx
--   transactions      idx_transactions_related_investment,
--                     idx_transactions_reconciled
--   upcoming_expenses idx_upcoming_user_due
--
-- (`persons_user_id_idx` and `recurring_user_id_idx` are genuine redundancy —
-- both are strict prefixes of a wider index on the same table — but they are
-- also the FK-covering index for their table, so they stay.)
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
-- None. No RPC signature, no return shape, no error code and no row-level
-- permission changes. §1 and §2 preserve policy semantics exactly (proof in
-- each section's comment); §3–§5 are pure storage. `src/lib/supabaseDb.ts`
-- needs no edit and the app can ship before or after this file.
--
-- ════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. split_groups — collapse the two permissive SELECT policies
-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor: multiple_permissive_policies ×5 (one per role) on split_groups
-- SELECT, `{"Members can view shared groups","Users can manage own groups"}`.
-- Permissive policies OR together and Postgres evaluates EVERY one of them on
-- every row, so a redundant policy is pure per-row cost.
--
-- The other 15 warnings (group_settlements × {SELECT,INSERT,DELETE} × 5 roles,
-- `"Users can manage own settlements"`) are ALREADY fixed on this branch:
-- supabase-migration-audit-p0-group-ledger-integrity.sql:237 drops that FOR ALL
-- policy and replaces it with one policy per command. Verified in the harness —
-- after the full corpus, group_settlements has exactly four policies:
-- three permissive, one per command, plus the RESTRICTIVE "Active profiles
-- only". Nothing to do here; V-2 re-checks it on production after apply.
--
-- WHY THIS ONE IS A **PURE** CONSOLIDATION — the two policies today are
--
--   "Users can manage own groups"     ALL    USING      (auth.uid() = user_id)
--                                            WITH CHECK (auth.uid() = user_id)
--   "Members can view shared groups"  SELECT USING      (auth.uid() = user_id
--                                            OR is_group_member(id, auth.uid()))
--
-- and the FOR ALL policy's USING clause is a strict SUBSET of the SELECT
-- policy's USING clause (`A` vs `A OR B`). So for SELECT, `A OR (A OR B)`
-- ≡ `A OR B`: dropping the FOR ALL policy from the SELECT path removes a
-- redundant disjunct and changes the visible row set by exactly nothing.
--
-- For the other three commands we restate the SAME expression verbatim, one
-- policy per command, which is what FOR ALL already meant:
--   INSERT → WITH CHECK          UPDATE → USING + WITH CHECK   DELETE → USING
-- (FOR ALL applies USING to SELECT/UPDATE/DELETE and WITH CHECK to
-- INSERT/UPDATE; splitting it this way reproduces that table exactly.)
--
-- The RESTRICTIVE "Active profiles only" FOR ALL policy on split_groups is
-- untouched and still ANDs into all four commands.
--
-- NOT done for group_expenses / group_settlements / anything else: their FOR
-- ALL policies were already split by the audit-p0 batch, and no other table in
-- the advisor output has a permissive overlap.

DO $sg$
BEGIN
  IF to_regclass('public.split_groups') IS NULL THEN
    RAISE NOTICE '[p3-rls-initplan] split_groups absent — section 1 skipped';
    RETURN;
  END IF;

  -- Guard: only collapse if the SELECT superset policy is actually there.
  -- Without it, dropping the FOR ALL policy would make every group invisible.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'split_groups'
       AND policyname = 'Members can view shared groups' AND cmd = 'SELECT'
  ) THEN
    RAISE NOTICE '[p3-rls-initplan] "Members can view shared groups" missing — '
                 'section 1 SKIPPED so SELECT access is not lost. Apply '
                 'supabase-migration-fix-rls-recursion.sql first, then re-run.';
    RETURN;
  END IF;

  -- Already consolidated by an earlier run of this file: nothing to do. Doing
  -- this check (rather than an unconditional drop/recreate) is what keeps a
  -- re-run of this file a true no-op instead of pointless policy churn.
  IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'split_groups'
           AND policyname = 'Users can manage own groups')
     AND (SELECT count(*) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'split_groups'
             AND policyname IN ('Owners can create own groups',
                                'Owners can update own groups',
                                'Owners can delete own groups')) = 3
  THEN
    RAISE NOTICE '[p3-rls-initplan] split_groups already consolidated — section 1 is a no-op';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "Users can manage own groups"  ON public.split_groups;
  DROP POLICY IF EXISTS "Owners can create own groups" ON public.split_groups;
  DROP POLICY IF EXISTS "Owners can update own groups" ON public.split_groups;
  DROP POLICY IF EXISTS "Owners can delete own groups" ON public.split_groups;

  -- Written pre-hoisted, so §2 has nothing to do to them either.
  CREATE POLICY "Owners can create own groups"
    ON public.split_groups FOR INSERT
    WITH CHECK ((SELECT auth.uid()) = user_id);

  CREATE POLICY "Owners can update own groups"
    ON public.split_groups FOR UPDATE
    USING      ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

  CREATE POLICY "Owners can delete own groups"
    ON public.split_groups FOR DELETE
    USING ((SELECT auth.uid()) = user_id);

  RAISE NOTICE '[p3-rls-initplan] split_groups: FOR ALL policy split into '
               'INSERT/UPDATE/DELETE; SELECT now has one permissive policy';
END
$sg$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. Hoist every bare auth.*() / current_setting() out of the row loop
-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor: auth_rls_initplan × 87 (production) / × 95 (full repo corpus).
--
-- `auth.uid()` is STABLE, not IMMUTABLE, so a policy expression that calls it
-- directly is re-evaluated ONCE PER CANDIDATE ROW. Wrapping it in a scalar
-- subquery — `(select auth.uid())` — turns it into an InitPlan the planner
-- evaluates once per statement and then treats as a constant, which also lets
-- it be pushed into an index qualifier. Same value, same semantics, one call
-- instead of N. This is Supabase's own documented fix:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- ── HOW THE REWRITE WORKS ───────────────────────────────────────────────────
-- For every policy in schema `public` we take the DEPARSED expression
-- (`pg_get_expr`), run four regexp_replace passes over it, and, if anything
-- changed, apply it back with ALTER POLICY. The four patterns:
--
--   (?<!SELECT )auth\.uid\(\)              → ( SELECT auth.uid() )
--   (?<!SELECT )auth\.jwt\(\)              → ( SELECT auth.jwt() )
--   (?<!SELECT )auth\.role\(\)             → ( SELECT auth.role() )
--   (?<!SELECT )current_setting\(([^()]*)\) → ( SELECT current_setting(\1) )
--
-- The negative lookbehind `(?<!SELECT )` is what makes this SAFE TO RE-RUN.
-- Postgres deparses an already-wrapped call as `( SELECT auth.uid() AS uid)`,
-- so on a second pass every wrapped call site is immediately preceded by
-- `SELECT ` and is skipped. A call inside a larger subquery — e.g.
-- `EXISTS ( SELECT 1 FROM t WHERE t.u = auth.uid())` — is NOT preceded by
-- `SELECT `, so it still gets wrapped, which is correct: it was being
-- re-evaluated per row too. Verified idempotent in the harness against the full
-- corpus: 94 policies rewritten on the first pass, 0 on the second and third,
-- with the md5 of the whole `pg_policies` snapshot identical across all three.
--
-- `[^()]*` for current_setting's argument list is deliberate: the argument is
-- always a string literal (optionally plus the `missing_ok` boolean), never a
-- nested call, so a paren-free match is exact and cannot swallow the closing
-- paren of an enclosing expression. There are ZERO current_setting call sites
-- in policies today — the pattern is there so this file keeps working if one
-- appears later.
--
-- ── HOW IT APPLIES THE RESULT ───────────────────────────────────────────────
-- `ALTER POLICY … USING (…) WITH CHECK (…)` changes ONLY the expressions. It
-- cannot and does not change the command (FOR ALL / SELECT / …), the role
-- list, or PERMISSIVE vs RESTRICTIVE — those are preserved by construction,
-- which is why this is a rewrite and not a drop-and-recreate.
--
-- The three clause shapes are handled separately, because emitting a clause a
-- policy did not have would CHANGE ITS MEANING:
--   * qual only     (SELECT, DELETE, and FOR ALL/UPDATE policies that never
--                    declared WITH CHECK) → emit USING only. For FOR ALL and
--                    UPDATE a NULL with_check means "reuse USING", and leaving
--                    it NULL preserves that; writing it out explicitly would
--                    freeze today's expression into a second place.
--   * with_check only (INSERT)            → emit WITH CHECK only.
--   * both                                → emit both.
--
-- RESTRICTIVE policies go through the same path unchanged (the 20 "Active
-- profiles only" policies from p2-trust-safety already call
-- `( SELECT is_current_profile_active())`, which is not an auth.* call and is
-- already hoisted, so they are no-ops here).

DO $initplan$
DECLARE
  r           RECORD;
  v_qual      TEXT;
  v_check     TEXT;
  v_sql       TEXT;
  v_rewritten INT := 0;
  v_scanned   INT := 0;
BEGIN
  FOR r IN
    SELECT n.nspname                                AS sch,
           c.relname                                AS tbl,
           p.polname                                AS pol,
           pg_get_expr(p.polqual,      p.polrelid)  AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid)  AS wcheck
      FROM pg_policy    p
      JOIN pg_class     c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY c.relname, p.polname
  LOOP
    v_scanned := v_scanned + 1;

    v_qual := regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(r.qual,
                      '(?<!SELECT )auth\.uid\(\)',  '( SELECT auth.uid() )',  'g'),
                      '(?<!SELECT )auth\.jwt\(\)',  '( SELECT auth.jwt() )',  'g'),
                      '(?<!SELECT )auth\.role\(\)', '( SELECT auth.role() )', 'g'),
                      '(?<!SELECT )current_setting\(([^()]*)\)',
                      '( SELECT current_setting(\1) )', 'g');

    v_check := regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(r.wcheck,
                      '(?<!SELECT )auth\.uid\(\)',  '( SELECT auth.uid() )',  'g'),
                      '(?<!SELECT )auth\.jwt\(\)',  '( SELECT auth.jwt() )',  'g'),
                      '(?<!SELECT )auth\.role\(\)', '( SELECT auth.role() )', 'g'),
                      '(?<!SELECT )current_setting\(([^()]*)\)',
                      '( SELECT current_setting(\1) )', 'g');

    -- Nothing to do for this policy.
    IF v_qual IS NOT DISTINCT FROM r.qual
       AND v_check IS NOT DISTINCT FROM r.wcheck THEN
      CONTINUE;
    END IF;

    v_sql := format('ALTER POLICY %I ON %I.%I', r.pol, r.sch, r.tbl);
    IF r.qual   IS NOT NULL THEN v_sql := v_sql || ' USING ('      || v_qual  || ')'; END IF;
    IF r.wcheck IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK (' || v_check || ')'; END IF;

    EXECUTE v_sql;
    v_rewritten := v_rewritten + 1;
  END LOOP;

  RAISE NOTICE '[p3-rls-initplan] scanned % policies in schema public, rewrote %',
               v_scanned, v_rewritten;
END
$initplan$;

-- Fail loudly rather than silently leaving the advisor warning in place.
-- If this raises, the regexes above did not match something they should have —
-- read the offending policy out of pg_policies before touching anything else.
DO $verify$
DECLARE v_left INT;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
         ~ '(?<!SELECT )(auth\.(uid|jwt|role)\(\)|current_setting\()';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'INITPLAN_REWRITE_INCOMPLETE: % policies still call auth.*() '
                    'or current_setting() per row', v_left;
  END IF;
  RAISE NOTICE '[p3-rls-initplan] verified: 0 bare auth.*/current_setting() calls remain';
END
$verify$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Drop the duplicate group_events index
-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor: duplicate_index on public.group_events,
-- {idx_gevents_group_created, idx_group_events_group_created}.
--
-- The two are byte-identical — both `btree (group_id, created_at DESC)`:
--   supabase-schema.sql:441                      idx_group_events_group_created
--   supabase-migration-performance-indexes.sql:328-329  idx_gevents_group_created
--
-- KEEP `idx_gevents_group_created` (the migration file's), DROP the schema
-- file's. Rationale: `supabase-migration-performance-indexes.sql` names it in
-- its own POST-FLIGHT verification block at line 378, so dropping that one
-- would make an existing migration's self-check report a missing index
-- forever; and `docs/testing-the-trust-boundary.md` already documents
-- `supabase-schema.sql` as the artifact that has drifted, so the migration
-- corpus is the side to trust. The `idx_gevents_*` prefix also matches its
-- eight siblings from the same file (idx_gexp_*, idx_gsett_*, idx_ginvites_*).

DROP INDEX IF EXISTS public.idx_group_events_group_created;

DO $dupidx$
BEGIN
  IF to_regclass('public.idx_gevents_group_created') IS NULL
     AND to_regclass('public.group_events') IS NOT NULL THEN
    -- Neither index exists (e.g. performance-indexes was never applied).
    -- Put the survivor back rather than leaving the table unindexed.
    CREATE INDEX idx_gevents_group_created
      ON public.group_events (group_id, created_at DESC);
    RAISE NOTICE '[p3-rls-initplan] idx_gevents_group_created was missing — recreated';
  END IF;
END
$dupidx$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Covering indexes for the foreign keys that are actually used
-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor: unindexed_foreign_keys × 27 (production) / × 36 (full corpus, which
-- adds the branch's new tables). An uncovered FK costs twice:
--   (a) every DELETE or key-UPDATE of a row in the REFERENCED table triggers a
--       full sequential scan of the referencing table to enforce the action;
--   (b) any client query filtering on that column has no index either.
--
-- Of the 36, these 14 are indexed here. Each is justified by a real call site —
-- a query in `src/lib/supabaseDb.ts`, an RPC body, or a deletion path that
-- production actually runs. `CREATE INDEX IF NOT EXISTS` throughout; see the
-- CONCURRENTLY note in the header before pasting this into a large database.
--
-- ── NOT indexed, deliberately: the `*_by` audit columns ─────────────────────
-- group_expenses.{created_by,updated_by,deleted_by,reconciled_by},
-- group_settlements.{created_by,updated_by,deleted_by},
-- group_invites.{created_by,accepted_by}, group_members.invited_by,
-- split_groups.{created_by,archived_by}, transactions.reconciled_by,
-- group_events.actor_profile_id, record_edits.actor_id, reports.reporter_id,
-- group_guest_identities.created_by.
-- Nothing filters or joins on any of them — they are display-only provenance
-- read back with the row they live on. Their only scan is the ON DELETE SET
-- NULL sweep during account deletion, which is a rare, already-slow,
-- already-asynchronous admin path; 15 extra indexes maintained on every write
-- to buy speed there is a bad trade. Revisit only if account deletion starts
-- timing out (`supabase-migration-audit-p0-account-deletion.sql` §12 lists the
-- same columns).
--
-- Also skipped: khata_links.person_id, notification_prefs.group_id,
-- reconciliation_findings.{run_id,resolved_run_id},
-- reconciliation_runs.scope_user_id — all on tables this branch introduces
-- that hold no production rows yet. Re-run the advisor after they do.

DO $fkidx$
DECLARE
  v_made INT := 0;
  v_skip INT := 0;

  -- (table, index name, index definition tail)
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- ── committees: committeesDb.getAll filters user_id and orders by
      --    created_at DESC (src/lib/supabaseDb.ts:2810-2812); the FK is to
      --    auth.users ON DELETE CASCADE, so account deletion scans it too.
      ('committees',                  'idx_committees_user_created',
       '(user_id, created_at DESC)'),

      -- ── committee_members: committeeMembersDb.getAll filters user_id,
      --    orders created_at ASC (supabaseDb.ts:3046-3050). FK → auth.users
      --    CASCADE.
      ('committee_members',           'idx_committee_members_user_created',
       '(user_id, created_at)'),

      -- ── committee_payments: getAll filters user_id (supabaseDb.ts:3083-3086)
      --    and remove() deletes on (user_id, member_id, round)
      --    (supabaseDb.ts:3096-3099). One composite serves both plus the FK.
      ('committee_payments',          'idx_committee_payments_user_member_round',
       '(user_id, member_id, round)'),

      -- ── group_expenses.user_id: authorship is half of every write policy
      --    (audit-p0-group-ledger-integrity §2) and the FK is ON DELETE SET
      --    NULL, so account deletion sweeps the whole table without this.
      ('group_expenses',              'idx_group_expenses_user',
       '(user_id)'),

      -- ── group_settlements.user_id: same story, same migration, same sweep.
      ('group_settlements',           'idx_group_settlements_user',
       '(user_id)'),

      -- ── investment_prices.market_id → investment_markets ON DELETE CASCADE.
      --    Deleting a market scans every price row. The existing unique index
      --    is (user_id, market_id, symbol) — wrong leading column, no help.
      ('investment_prices',           'idx_investment_prices_market',
       '(market_id)'),

      -- ── linked_settlement_requests.{requester,responder}_loan_id → loans
      --    ON DELETE CASCADE, and both are read by the settlement accept /
      --    cancel / reject RPCs (audit-p0-settlement-row-locks.sql). Deleting
      --    a loan scans the request table twice, once per FK.
      ('linked_settlement_requests',  'idx_lsr_requester_loan',
       '(requester_loan_id)'),
      ('linked_settlement_requests',  'idx_lsr_responder_loan',
       '(responder_loan_id)'),

      -- ── notifications.group_id → split_groups ON DELETE CASCADE. Group
      --    deletion (delete_group, audit-p0-group-deletion-guard) cascades
      --    here; the existing (user_id, group_id) partial index cannot serve
      --    the FK check because group_id is not its leading column.
      ('notifications',               'idx_notifications_group',
       '(group_id)'),

      -- ── notifications.event_id → group_events ON DELETE CASCADE. Same
      --    group-deletion path, one level down (the events go with the group).
      ('notifications',               'idx_notifications_event',
       '(event_id)'),

      -- ── linked_transaction_requests.person_id → persons ON DELETE SET NULL.
      --    Deleting a contact scans every request row.
      ('linked_transaction_requests', 'idx_ltr_person',
       '(person_id)'),

      -- ── persons.linked_profile_id → profiles ON DELETE SET NULL, and it is
      --    read directly by the consent/settlement RPCs (consent-guards:428,
      --    settlement-row-locks:399/660, connections-push-discovery:100). The
      --    existing (user_id, linked_profile_id) partial unique index has the
      --    wrong leading column for both.
      ('persons',                     'idx_persons_linked_profile',
       '(linked_profile_id)'),

      -- ── recurring_transactions.source_account_id → accounts ON DELETE SET
      --    NULL. Deleting an account scans every recurring rule.
      ('recurring_transactions',      'idx_recurring_source_account',
       '(source_account_id)'),

      -- ── group_invites.linked_member_id → group_members ON DELETE SET NULL.
      --    Leaving or removing a member deletes group_members rows
      --    (safe-leave-group.sql), which scans group_invites each time.
      ('group_invites',               'idx_group_invites_linked_member',
       '(linked_member_id)')
    ) AS t(tbl, idx, cols)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE '[p3-rls-initplan] table public.% absent — % skipped', r.tbl, r.idx;
      v_skip := v_skip + 1;
      CONTINUE;
    END IF;

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I %s',
                   r.idx, r.tbl, r.cols);
    v_made := v_made + 1;
  END LOOP;

  RAISE NOTICE '[p3-rls-initplan] FK covering indexes: % ensured, % skipped (table absent)',
               v_made, v_skip;
END
$fkidx$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Primary keys on the rate-limit attempt ledgers
-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor: no_primary_key on public.phone_lookup_attempts and
-- public.join_code_attempts.
--
-- Both are PURE APPEND-ONLY LOGS with NO natural key. Their shape is
-- (user_id, attempted_at[, succeeded]) and `attempted_at` defaults to `now()`,
-- which in Postgres is transaction start time — two inserts in one transaction
-- get the SAME timestamp, so (user_id, attempted_at) is provably not unique.
-- There is nothing else to key on. So both get a surrogate:
--
--     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
--
-- BIGINT, not UUID: these tables are written on every join-code miss and every
-- phone-discovery lookup, and a monotonic identity keeps inserts appending to
-- the same btree page instead of scattering. GENERATED ALWAYS so no client can
-- supply one (nothing can anyway — both tables deny all client access).
--
-- `code_lookup_attempts` (audit-p0-join-abuse-limits.sql:94) is the same shape
-- and gets the same treatment. The advisor never saw it because it does not
-- exist in production yet; adding it here means the next advisor run is clean
-- instead of reporting a third finding.
--
-- SAFETY: every INSERT into all three tables in the whole corpus names its
-- columns explicitly (`INSERT INTO … (user_id[, succeeded]) VALUES …`), so a
-- new leading column breaks nothing. Adding an identity column REWRITES the
-- table under an ACCESS EXCLUSIVE lock — fine here because all three are
-- pruned on every call (`DELETE … WHERE attempted_at < now() - INTERVAL '1
-- hour'`, consent-guards:776) and never hold more than an hour of rows.

DO $pk$
DECLARE
  t     TEXT;
  v_new INT := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'join_code_attempts',
    'phone_lookup_attempts',
    'code_lookup_attempts'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '[p3-rls-initplan] table public.% absent — no PK added', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = ('public.' || t)::regclass AND contype = 'p'
    ) THEN
      CONTINUE;                                    -- already has a primary key
    END IF;

    -- ADD COLUMN IF NOT EXISTS so a half-applied earlier run still converges.
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS id BIGINT GENERATED ALWAYS AS IDENTITY', t);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (id)', t, t || '_pkey');

    EXECUTE format('COMMENT ON COLUMN public.%I.id IS %L', t,
      'Surrogate key. This is an append-only rate-limit log with no natural '
      'key — (user_id, attempted_at) collides for two inserts in one '
      'transaction. Added by supabase-migration-p3-rls-initplan-and-indexes.sql.');

    v_new := v_new + 1;
  END LOOP;

  RAISE NOTICE '[p3-rls-initplan] attempt-ledger primary keys: % added', v_new;
END
$pk$;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — run these AFTER applying, against the same database.
-- Every one of them is read-only.
-- ════════════════════════════════════════════════════════════════════════════
--
-- V-1. THE headline check. Must return 0. Any row here is a policy the advisor
--      will still flag as auth_rls_initplan.
--
--   SELECT count(*) AS policies_still_bare
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (coalesce(qual,'') || ' ' || coalesce(with_check,''))
--          ~ '(?<!SELECT )(auth\.(uid|jwt|role)\(\)|current_setting\()';
--
--   ...and the same thing listed, if it is not 0:
--
--   SELECT tablename, policyname, cmd, qual, with_check
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (coalesce(qual,'') || ' ' || coalesce(with_check,''))
--          ~ '(?<!SELECT )(auth\.(uid|jwt|role)\(\)|current_setting\()'
--    ORDER BY tablename, policyname;
--
-- V-2. No table has two permissive policies for the same command any more.
--      Expect ZERO rows. (RESTRICTIVE policies are excluded — they AND, they
--      do not overlap.) `unnest` on cmd expands FOR ALL into its four commands
--      so an ALL + SELECT overlap is caught, which is exactly the shape §1
--      just removed from split_groups.
--
--   WITH x AS (
--     SELECT tablename, policyname,
--            CASE WHEN cmd = 'ALL'
--                 THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
--                 ELSE ARRAY[cmd] END AS cmds
--       FROM pg_policies
--      WHERE schemaname = 'public' AND permissive = 'PERMISSIVE'
--   )
--   SELECT tablename, unnest(cmds) AS command,
--          count(*), array_agg(policyname ORDER BY policyname)
--     FROM x GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2;
--
-- V-3. split_groups reads identically for a member who does not own the group.
--      Run as that member (Studio: impersonate, or from the app). Expect the
--      group to be visible — the same row set as before §1.
--
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<member-uuid>', true);
--   SELECT id, name, user_id FROM public.split_groups ORDER BY created_at DESC;
--   RESET ROLE;
--
-- V-4. Every index this file added exists and is VALID. Expect 14 rows, all
--      `t`. An `f` in indisvalid means a CONCURRENTLY build failed and left a
--      dead index behind — drop it and rebuild.
--
--   SELECT c.relname AS index_name, i.indisvalid, i.indisready
--     FROM pg_class c
--     JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE c.relname IN (
--      'idx_committees_user_created','idx_committee_members_user_created',
--      'idx_committee_payments_user_member_round','idx_group_expenses_user',
--      'idx_group_settlements_user','idx_investment_prices_market',
--      'idx_lsr_requester_loan','idx_lsr_responder_loan',
--      'idx_notifications_group','idx_notifications_event','idx_ltr_person',
--      'idx_persons_linked_profile','idx_recurring_source_account',
--      'idx_group_invites_linked_member')
--    ORDER BY 1;
--
-- V-5. The duplicate is gone and the survivor is there. Expect exactly one row,
--      `idx_gevents_group_created`.
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'group_events'
--      AND indexdef LIKE '%group_id, created_at%';
--
-- V-6. All three attempt ledgers have a primary key. Expect 3 rows.
--
--   SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con
--     JOIN pg_class c ON c.oid = con.conrelid
--    WHERE con.contype = 'p'
--      AND c.relname IN ('join_code_attempts','phone_lookup_attempts',
--                        'code_lookup_attempts')
--    ORDER BY 1;
--
-- V-7. The rate limiters still work after the table rewrite. Both should insert
--      one row and return a monotonically increasing id.
--
--   INSERT INTO public.join_code_attempts(user_id, succeeded)
--        VALUES ('00000000-0000-0000-0000-000000000000', false) RETURNING id;
--   DELETE FROM public.join_code_attempts
--    WHERE user_id = '00000000-0000-0000-0000-000000000000';
--
-- V-8. Remaining unindexed FKs, so the deferral in §4 stays a decision and not
--      an oversight. Expect the `*_by` audit columns plus the branch-new
--      tables, and nothing else.
--
--   WITH fk AS (
--     SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey
--       FROM pg_constraint c
--       JOIN pg_class t ON t.oid = c.conrelid
--       JOIN pg_namespace n ON n.oid = t.relnamespace
--      WHERE c.contype = 'f' AND n.nspname = 'public'
--   )
--   SELECT tbl, conname FROM fk
--    WHERE NOT EXISTS (
--      SELECT 1 FROM pg_index i
--       WHERE i.indrelid = fk.tbl::regclass
--         AND (i.indkey::smallint[])[0:array_length(fk.conkey,1)-1] = fk.conkey)
--    ORDER BY 1, 2;
--
-- V-9. After a week of traffic: did the new indexes get used?
--
--   SELECT relname, indexrelname, idx_scan
--     FROM pg_stat_user_indexes
--    WHERE schemaname = 'public' AND indexrelname LIKE 'idx_%'
--    ORDER BY idx_scan, indexrelname;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- §2 is not worth rolling back — it is semantically a no-op and reverting it
-- only makes the database slower. If you must, re-apply the migration that
-- created the policy in question; every one of them writes bare `auth.uid()`.
--
--   -- §1
--   DROP POLICY IF EXISTS "Owners can create own groups" ON public.split_groups;
--   DROP POLICY IF EXISTS "Owners can update own groups" ON public.split_groups;
--   DROP POLICY IF EXISTS "Owners can delete own groups" ON public.split_groups;
--   CREATE POLICY "Users can manage own groups" ON public.split_groups
--     FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
--
--   -- §3
--   CREATE INDEX IF NOT EXISTS idx_group_events_group_created
--     ON public.group_events (group_id, created_at DESC);
--
--   -- §4
--   DROP INDEX IF EXISTS public.idx_committees_user_created;
--   DROP INDEX IF EXISTS public.idx_committee_members_user_created;
--   DROP INDEX IF EXISTS public.idx_committee_payments_user_member_round;
--   DROP INDEX IF EXISTS public.idx_group_expenses_user;
--   DROP INDEX IF EXISTS public.idx_group_settlements_user;
--   DROP INDEX IF EXISTS public.idx_investment_prices_market;
--   DROP INDEX IF EXISTS public.idx_lsr_requester_loan;
--   DROP INDEX IF EXISTS public.idx_lsr_responder_loan;
--   DROP INDEX IF EXISTS public.idx_notifications_group;
--   DROP INDEX IF EXISTS public.idx_notifications_event;
--   DROP INDEX IF EXISTS public.idx_ltr_person;
--   DROP INDEX IF EXISTS public.idx_persons_linked_profile;
--   DROP INDEX IF EXISTS public.idx_recurring_source_account;
--   DROP INDEX IF EXISTS public.idx_group_invites_linked_member;
--
--   -- §5 (drops the column too; the tables hold at most an hour of rows)
--   ALTER TABLE public.join_code_attempts    DROP COLUMN IF EXISTS id;
--   ALTER TABLE public.phone_lookup_attempts DROP COLUMN IF EXISTS id;
--   ALTER TABLE public.code_lookup_attempts  DROP COLUMN IF EXISTS id;
-- ════════════════════════════════════════════════════════════════════════════
