-- ════════════════════════════════════════════════════════════════════════════
-- 90 · Performance hardening — supabase-migration-p3-rls-initplan-and-indexes
--
-- Covers the whole PERFORMANCE half of the 2026-09-03 Supabase advisor run:
--   §1  split_groups permissive-policy consolidation  (multiple_permissive_policies)
--   §2  the generic (select auth.uid()) rewrite       (auth_rls_initplan)
--   §3  the duplicate group_events index              (duplicate_index)
--   §4  FK covering indexes                           (unindexed_foreign_keys)
--   §5  attempt-ledger primary keys                   (no_primary_key)
--
-- Two kinds of assertion live here and they are deliberately different:
--
--   * CATALOG shape (pg_policies, pg_index, pg_constraint) — asserted with
--     RESET ROLE. These are reads of the system catalogs, not of user data;
--     RLS has nothing to do with them, and `authenticated` cannot see the
--     policy expressions it needs to grep anyway.
--
--   * BEHAVIOUR — asserted with SET ROLE authenticated, because §1 physically
--     replaced a FOR ALL policy on split_groups with three per-command ones
--     and "identical semantics" is a claim that has to be walked, not
--     asserted from a comment. Owner / connected member / ex-member / stranger
--     are each pushed through SELECT, INSERT, UPDATE and DELETE.
--
-- Runs after 8z-edit-history.sql and before 99-summary.sql.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('90-performance-hardening');

RESET ROLE;
SELECT test.as_user(NULL::uuid);

-- A stranger to G1. Every other fixture user is, or becomes, a member of it
-- (D joins in 60-notification-maturity.sql:146), so the "outsider cannot see
-- the group" assertion needs a user of its own.
INSERT INTO auth.users (id, email)
VALUES ('90909090-9090-9090-9090-909090909090', 'perf-outsider@hisaab.test')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET name = 'Outsider'
 WHERE id = '90909090-9090-9090-9090-909090909090';


-- ═══════════════════════════════════════════════════════════════════════════
-- §2 · auth_rls_initplan — not one bare auth.*() call left in schema public
-- ═══════════════════════════════════════════════════════════════════════════
-- The negative lookbehind is the same one the migration uses: a call site that
-- is immediately preceded by `SELECT ` is already hoisted into an InitPlan.

SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
          ~ '(?<!SELECT )(auth\.(uid|jwt|role)\(\)|current_setting\()') = 0,
  'no policy in schema public calls auth.*() or current_setting() per row',
  'still bare: ' || (SELECT coalesce(string_agg(tablename || '.' || policyname, ', '), '-')
                       FROM pg_policies
                      WHERE schemaname = 'public'
                        AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                            ~ '(?<!SELECT )(auth\.(uid|jwt|role)\(\)|current_setting\()'));

-- The mirror image: the rewrite must have actually happened, not merely have
-- found nothing. If a future refactor deletes every auth.uid() from every
-- policy this fails loudly rather than passing vacuously.
SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) LIKE '%SELECT auth.uid()%') >= 90,
  'at least 90 policies use the hoisted ( SELECT auth.uid() ) form',
  'hoisted: ' || (SELECT count(*) FROM pg_policies
                   WHERE schemaname = 'public'
                     AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                         LIKE '%SELECT auth.uid()%')::text);

-- Rewriting must not have changed WHO a policy applies to or whether it is
-- permissive. ALTER POLICY cannot touch either, but assert it anyway — this is
-- the assertion that would catch someone "improving" §2 into a drop/recreate.
SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
      AND policyname = 'Active profiles only') = 20,
  'the 20 RESTRICTIVE "Active profiles only" policies survived the rewrite',
  'restrictive: ' || (SELECT count(*) FROM pg_policies
                       WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
                         AND policyname = 'Active profiles only')::text);


-- ═══════════════════════════════════════════════════════════════════════════
-- §1 · multiple_permissive_policies — no table overlaps on any command
-- ═══════════════════════════════════════════════════════════════════════════
-- FOR ALL is expanded into its four commands, which is what the advisor does
-- and what made split_groups (ALL + SELECT) a finding in the first place.

SELECT test.assert(
  (WITH x AS (
     SELECT tablename, policyname,
            CASE WHEN cmd = 'ALL' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
                 ELSE ARRAY[cmd] END AS cmds
       FROM pg_policies
      WHERE schemaname = 'public' AND permissive = 'PERMISSIVE'),
   y AS (
     SELECT tablename, unnest(cmds) AS command, count(*) AS n
       FROM x GROUP BY 1, 2)
   SELECT count(*) FROM y WHERE n > 1) = 0,
  'no table in schema public has two permissive policies for one command',
  (WITH x AS (
     SELECT tablename, policyname,
            CASE WHEN cmd = 'ALL' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
                 ELSE ARRAY[cmd] END AS cmds
       FROM pg_policies
      WHERE schemaname = 'public' AND permissive = 'PERMISSIVE'),
   y AS (
     SELECT tablename, unnest(cmds) AS command, count(*) AS n
       FROM x GROUP BY 1, 2)
   SELECT coalesce(string_agg(tablename || ' ' || command, ', '), '-')
     FROM y WHERE n > 1));

SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'split_groups'
      AND policyname = 'Users can manage own groups') = 0,
  'split_groups: the FOR ALL "Users can manage own groups" policy is gone');

SELECT test.assert(
  (SELECT array_agg(policyname || ':' || cmd ORDER BY policyname)
     FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'split_groups'
      AND permissive = 'PERMISSIVE')
  = ARRAY['Members can view shared groups:SELECT',
          'Owners can create own groups:INSERT',
          'Owners can delete own groups:DELETE',
          'Owners can update own groups:UPDATE'],
  'split_groups: exactly one permissive policy per command',
  (SELECT coalesce(string_agg(policyname || ':' || cmd, ', ' ORDER BY policyname), '-')
     FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'split_groups'
      AND permissive = 'PERMISSIVE'));

-- The C4 fix from audit-p0-group-ledger-integrity, re-checked here because the
-- advisor blamed 15 of its 20 findings on it and the migration's header claims
-- it is already handled.
SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_settlements'
      AND policyname = 'Users can manage own settlements') = 0,
  'group_settlements: "Users can manage own settlements" FOR ALL is gone (C4)');


-- ═══════════════════════════════════════════════════════════════════════════
-- §1 · BEHAVIOUR — the consolidation changed nothing a client can observe
-- ═══════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;

-- ── Owner (A) — all four commands, exactly as under FOR ALL.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

SELECT test.assert(
  (SELECT count(*) FROM split_groups WHERE id = 'G1') = 1,
  'split_groups SELECT: the owner still sees their own group');

SELECT test.assert_ok(
  $$ INSERT INTO split_groups (id, user_id, name, emoji, currency, created_by)
     VALUES ('G-PERF', auth.uid(), 'Perf Probe', '⚡', 'PKR', auth.uid()) $$,
  'split_groups INSERT: the owner can still create a group');

SELECT test.assert_ok(
  $$ UPDATE split_groups SET name = 'Perf Probe 2' WHERE id = 'G-PERF' $$,
  'split_groups UPDATE: the owner can still rename their own group');

SELECT test.assert(
  (SELECT name FROM split_groups WHERE id = 'G-PERF') = 'Perf Probe 2',
  'split_groups UPDATE: the rename actually landed');

-- ── Connected member (B) — SELECT yes, write no. This is the pair that proves
--    `A OR (A OR B)` collapsed to `A OR B` and not to `A`.
SELECT test.as_user('22222222-2222-2222-2222-222222222222');

SELECT test.assert(
  (SELECT count(*) FROM split_groups WHERE id = 'G1') = 1,
  'split_groups SELECT: a connected non-owner member still sees the shared group');

SELECT test.assert_zero_rows(
  $$ UPDATE split_groups SET name = 'hijacked' WHERE id = 'G1' $$,
  'split_groups UPDATE: a non-owner member cannot rename the group');

SELECT test.assert_zero_rows(
  $$ DELETE FROM split_groups WHERE id = 'G1' $$,
  'split_groups DELETE: a non-owner member cannot delete the group');

SELECT test.assert_zero_rows(
  $$ UPDATE split_groups SET name = 'hijacked' WHERE id = 'G-PERF' $$,
  'split_groups UPDATE: a non-member cannot touch a group they cannot see');

-- ── Ex-member (C, left G1 in 00-fixtures) — no longer sees it.
SELECT test.as_user('33333333-3333-3333-3333-333333333333');

SELECT test.assert(
  (SELECT count(*) FROM split_groups WHERE id = 'G1') = 0,
  'split_groups SELECT: an ex-member no longer sees the group');

-- ── Stranger — sees nothing, and cannot forge a row owned by someone else.
SELECT test.as_user('90909090-9090-9090-9090-909090909090');

SELECT test.assert(
  (SELECT count(*) FROM split_groups) = 0,
  'split_groups SELECT: an outsider sees no groups at all',
  'visible: ' || (SELECT count(*) FROM split_groups)::text);

SELECT test.assert_raises(
  $$ INSERT INTO split_groups (id, user_id, name, currency, created_by)
     VALUES ('G-FORGE', '11111111-1111-1111-1111-111111111111', 'Forged', 'PKR',
             '11111111-1111-1111-1111-111111111111') $$,
  'row-level security',
  'split_groups INSERT: an outsider cannot create a group owned by someone else');

SELECT test.assert_zero_rows(
  $$ DELETE FROM split_groups WHERE id = 'G-PERF' $$,
  'split_groups DELETE: an outsider cannot delete another user''s group');

-- ── Owner deletes their own solo group. Closes the loop and cleans up.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

SELECT test.assert_ok(
  $$ DELETE FROM split_groups WHERE id = 'G-PERF' $$,
  'split_groups DELETE: the owner can still delete their own group');

SELECT test.assert(
  (SELECT count(*) FROM split_groups WHERE id = 'G-PERF') = 0,
  'split_groups DELETE: the probe group is gone');


-- ═══════════════════════════════════════════════════════════════════════════
-- §3/§4/§5 · Catalog shape. Back to superuser — these are catalog reads.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.as_user(NULL::uuid);
RESET ROLE;

-- ── §3 duplicate_index on group_events ─────────────────────────────────────
SELECT test.assert(
  to_regclass('public.idx_group_events_group_created') IS NULL,
  'group_events: the duplicate index (supabase-schema.sql:441) is dropped');

SELECT test.assert(
  to_regclass('public.idx_gevents_group_created') IS NOT NULL,
  'group_events: the survivor (performance-indexes.sql:328) is still there');

SELECT test.assert(
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'group_events'
      AND indexdef LIKE '%group_id, created_at%') = 1,
  'group_events: exactly one (group_id, created_at DESC) index remains',
  (SELECT coalesce(string_agg(indexname, ', '), '-') FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'group_events'
      AND indexdef LIKE '%group_id, created_at%'));

-- ── §4 FK covering indexes ─────────────────────────────────────────────────
SELECT test.assert(
  (SELECT count(*) FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname IN (
      'idx_committees_user_created','idx_committee_members_user_created',
      'idx_committee_payments_user_member_round','idx_group_expenses_user',
      'idx_group_settlements_user','idx_investment_prices_market',
      'idx_lsr_requester_loan','idx_lsr_responder_loan',
      'idx_notifications_group','idx_notifications_event','idx_ltr_person',
      'idx_persons_linked_profile','idx_recurring_source_account',
      'idx_group_invites_linked_member')
      AND i.indisvalid) = 14,
  'all 14 FK covering indexes exist and are valid',
  'found: ' || (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '-')
                  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                 WHERE c.relname LIKE 'idx_%' AND i.indisvalid
                   AND c.relname IN (
                     'idx_committees_user_created','idx_committee_members_user_created',
                     'idx_committee_payments_user_member_round','idx_group_expenses_user',
                     'idx_group_settlements_user','idx_investment_prices_market',
                     'idx_lsr_requester_loan','idx_lsr_responder_loan',
                     'idx_notifications_group','idx_notifications_event','idx_ltr_person',
                     'idx_persons_linked_profile','idx_recurring_source_account',
                     'idx_group_invites_linked_member')));

-- Every FK the migration set out to cover is genuinely covered now: an index
-- whose LEADING columns are exactly the constraint's columns. This is the same
-- test the advisor runs, restricted to the 14 named FKs.
SELECT test.assert(
  (WITH fk AS (
     SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND c.conname IN (
          'committees_user_id_fkey','committee_members_user_id_fkey',
          'committee_payments_user_id_fkey','group_expenses_user_id_fkey',
          'group_settlements_user_id_fkey','investment_prices_market_id_fkey',
          'linked_settlement_requests_requester_loan_id_fkey',
          'linked_settlement_requests_responder_loan_id_fkey',
          'notifications_group_id_fkey','notifications_event_id_fkey',
          'linked_transaction_requests_person_id_fkey',
          'persons_linked_profile_id_fkey','fk_recurring_source_account',
          'group_invites_linked_member_id_fkey'))
   SELECT count(*) FROM fk
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = fk.tbl::regclass
         AND (i.indkey::smallint[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)) = 0,
  'none of the 14 targeted foreign keys is uncovered any more');

-- The deferral is a decision, not an oversight: the *_by audit columns and the
-- branch-new tables are still uncovered on purpose (§4's comment says so).
-- If this number moves, someone changed the schema and should re-read that
-- comment rather than edit this number.
--
-- The 16 `*_fk_currency` foreign keys added by
-- `supabase-migration-p3-currencies-iso4217.sql` are excluded from this census
-- rather than counted, because they are uncovered BY DESIGN and would
-- otherwise drown the audit-column signal this assertion exists to protect.
-- The reason an FK wants an index on the referencing column is the parent-side
-- check: every DELETE or key-UPDATE on the parent must scan each child. On
-- `public.currencies` neither happens — currencies are retired with
-- `is_active = false`, never deleted (the FKs are ON DELETE RESTRICT precisely
-- to enforce that), and the seed's `ON CONFLICT DO UPDATE` touches only
-- `name_en` / `minor_units` / `sort_order`, never `code`, so no FK check
-- fires. A btree on a column holding ~8 distinct values would also be near
-- useless to the planner. Their presence is asserted separately, and in full,
-- in `93-currencies-iso4217.sql`.
SELECT test.assert(
  (WITH fk AS (
     SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND c.confrelid <> COALESCE(to_regclass('public.currencies'), 0::oid))
   SELECT count(*) FROM fk
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = fk.tbl::regclass
         AND (i.indkey::smallint[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)) = 22,
  'exactly 22 foreign keys remain uncovered — the documented audit-column deferral (currency FKs excluded, see comment)',
  'uncovered: ' || (WITH fk AS (
     SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND c.confrelid <> COALESCE(to_regclass('public.currencies'), 0::oid))
   SELECT coalesce(string_agg(conname, ', ' ORDER BY conname), '-') FROM fk
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = fk.tbl::regclass
         AND (i.indkey::smallint[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)));

-- ── §5 attempt-ledger primary keys ─────────────────────────────────────────
SELECT test.assert(
  (SELECT count(*) FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
    WHERE con.contype = 'p'
      AND c.relname IN ('join_code_attempts', 'phone_lookup_attempts',
                        'code_lookup_attempts')) = 3,
  'all three rate-limit attempt ledgers have a primary key',
  'with pk: ' || (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '-')
                    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
                   WHERE con.contype = 'p'
                     AND c.relname IN ('join_code_attempts', 'phone_lookup_attempts',
                                       'code_lookup_attempts')));

SELECT test.assert(
  (SELECT count(*) FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('join_code_attempts', 'phone_lookup_attempts',
                        'code_lookup_attempts')
      AND a.attname = 'id'
      AND a.atttypid = 'bigint'::regtype
      AND a.attidentity = 'a') = 3,
  'each ledger key is a BIGINT GENERATED ALWAYS AS IDENTITY column');

-- The rewrite must not have broken the writers. Every RPC inserts with an
-- explicit column list; prove that shape still works and that the identity
-- column fills itself in. Superuser on purpose: these tables deny ALL client
-- access ("no client access to …", USING (false)), so `authenticated` cannot
-- reach them and an RLS-gated version of this test would prove nothing.
SELECT test.assert_ok(
  $$ INSERT INTO public.join_code_attempts (user_id, succeeded)
     VALUES ('90909090-9090-9090-9090-909090909090', false) $$,
  'join_code_attempts still accepts the RPC insert shape after the PK rewrite');

SELECT test.assert_ok(
  $$ INSERT INTO public.phone_lookup_attempts (user_id)
     VALUES ('90909090-9090-9090-9090-909090909090') $$,
  'phone_lookup_attempts still accepts the RPC insert shape after the PK rewrite');

SELECT test.assert(
  (SELECT count(*) FROM public.join_code_attempts
    WHERE user_id = '90909090-9090-9090-9090-909090909090' AND id IS NOT NULL) = 1,
  'join_code_attempts.id was generated for the new row');

-- Clean up the probe rows so a later advisor/reconciliation read is not
-- confused by a user that only exists inside this suite.
DELETE FROM public.join_code_attempts
 WHERE user_id = '90909090-9090-9090-9090-909090909090';
DELETE FROM public.phone_lookup_attempts
 WHERE user_id = '90909090-9090-9090-9090-909090909090';
