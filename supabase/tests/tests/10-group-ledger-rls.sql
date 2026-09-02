-- ════════════════════════════════════════════════════════════════════════════
-- 10 · The group ledger trust boundary
--
-- Evidence: docs/audit-2026-09/05-security.md + APPLY-ORDER.md §2 step 5
--   (supabase-migration-audit-p0-group-ledger-integrity.sql, "the keystone").
--
-- The three claims the audit cares about:
--   (a) nobody can insert themselves into a group they were not admitted to;
--   (b) an EX-member cannot mutate the ledger of a group they have left;
--   (c) there is no blanket FOR ALL policy on the ledger tables, and no DELETE
--       policy at all — hard-deleting a shared money row is not a client verb.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('10-group-ledger-rls');

SET ROLE authenticated;

-- ── (a) SELF-INSERT INTO group_members ─────────────────────────────────────
-- D is a stranger to G1. The only INSERT policy on group_members is
-- "Group owners can add members" (WITH CHECK: the group's user_id = auth.uid()),
-- so a self-insert has no policy to satisfy — even though the consent trigger
-- waves a self-row through as self-consent.
SELECT test.as_user('44444444-4444-4444-4444-444444444444');
SELECT test.assert_raises($$
  INSERT INTO group_members (id, group_id, profile_id, display_name, role, status)
  VALUES ('M-D-hack', 'G1', auth.uid(), 'Danish', 'member', 'connected')
$$, 'row-level security',
  'a stranger cannot self-insert a group_members row (H6)');

-- Nor can a stranger conscript themselves as owner.
SELECT test.assert_raises($$
  INSERT INTO group_members (id, group_id, profile_id, display_name, role, status)
  VALUES ('M-D-hack2', 'G1', auth.uid(), 'Danish', 'owner', 'connected')
$$, 'row-level security',
  'a stranger cannot self-insert as role=owner');

-- A stranger cannot see the group's members either.
SELECT test.assert((SELECT count(*) FROM group_members WHERE group_id = 'G1') = 0,
  'a stranger reads zero group_members rows for G1');

-- ── (b) THE EX-MEMBER ──────────────────────────────────────────────────────
SELECT test.as_user('33333333-3333-3333-3333-333333333333');

-- is_group_member() is status='connected'-scoped, so C fails every ledger
-- policy. UPDATE and DELETE have no error to raise: RLS simply matches no row.
SELECT test.assert(NOT is_group_member('G1', auth.uid()),
  'is_group_member() is false for an ex-member');

SELECT test.assert((SELECT count(*) FROM group_expenses WHERE id = 'E1') = 0,
  'an ex-member cannot SELECT the group ledger they left');

SELECT test.assert_zero_rows(
  $$ UPDATE group_expenses SET amount = 1, version = version + 1 WHERE id = 'E1' $$,
  'an ex-member cannot UPDATE a group expense');

SELECT test.assert_zero_rows(
  $$ DELETE FROM group_expenses WHERE id = 'E1' $$,
  'an ex-member cannot DELETE a group expense');

SELECT test.assert_zero_rows(
  $$ UPDATE group_settlements SET amount = 1 WHERE group_id = 'G1' $$,
  'an ex-member cannot UPDATE a group settlement');

SELECT test.assert_zero_rows(
  $$ DELETE FROM group_settlements WHERE group_id = 'G1' $$,
  'an ex-member cannot DELETE a group settlement');

SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-ghost', auth.uid(), 'G1', 'ghost', 10,
          'M-A', '[{"memberId":"M-A","amount":10}]'::jsonb)
$$, 'INACTIVE_GROUP_AUTHOR',
  'an ex-member cannot INSERT a new group expense');

-- The expense survived all of the above, unchanged.
RESET ROLE;
SELECT test.assert((SELECT amount FROM group_expenses WHERE id = 'E1') = 60.00,
  'E1 is byte-for-byte intact after the ex-member probes',
  'amount = ' || COALESCE((SELECT amount FROM group_expenses WHERE id='E1')::text, 'GONE'));
SET ROLE authenticated;

-- ── An ACTIVE member is still not a co-owner of someone else's row ─────────
SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert((SELECT count(*) FROM group_expenses WHERE id = 'E1') = 1,
  'an active member CAN read a fellow member''s expense');
SELECT test.assert_zero_rows(
  $$ UPDATE group_expenses SET description = 'edited' WHERE id = 'E1' $$,
  'an active member cannot UPDATE a fellow member''s expense (auth.uid() = user_id)');
SELECT test.assert_zero_rows(
  $$ DELETE FROM group_expenses WHERE id = 'E1' $$,
  'an active member cannot hard-DELETE a fellow member''s expense');

-- ── The author cannot hard-DELETE their own row either: the hardened policy
--    set has no DELETE policy at all. Soft-delete via deleted_at is the verb.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_zero_rows(
  $$ DELETE FROM group_expenses WHERE id = 'E1' $$,
  'even the author cannot hard-DELETE their own group expense');

-- ── The version guard (F-6): a core edit must carry version + 1 ───────────
-- `description` rather than `amount`: the split-sum trigger
-- (group_expenses_validate_split_amounts) sorts BEFORE
-- group_expenses_version_guard by name and would reject an amount change first,
-- masking the version guard. Both guards are exercised — the sum one in
-- 40-money-integrity.sql.
SELECT test.assert_raises(
  $$ UPDATE group_expenses SET description = 'edited' WHERE id = 'E1' $$,
  'GROUP_EXPENSE_VERSION_CONFLICT',
  'a core edit without a version bump is refused');

SELECT test.assert_raises(
  $$ UPDATE group_expenses SET description = 'edited', version = version - 1
      WHERE id = 'E1' $$,
  'version cannot move backwards',
  'version may never move backwards');

SELECT test.assert_ok(
  $$ UPDATE group_expenses SET description = 'Hotel (edited)',
                               version = version + 1 WHERE id = 'E1' $$,
  'a core edit carrying version + 1 is accepted');

-- ── (c) CATALOG SHAPE ──────────────────────────────────────────────────────
RESET ROLE;

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'group_settlements'
                 AND cmd = 'ALL' AND permissive = 'PERMISSIVE'),
  'group_settlements has NO permissive FOR ALL policy',
  COALESCE((SELECT string_agg(policyname, ', ') FROM pg_policies
             WHERE schemaname='public' AND tablename='group_settlements'
               AND cmd='ALL' AND permissive='PERMISSIVE'), '(none)'));

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'group_expenses'
                 AND cmd = 'ALL' AND permissive = 'PERMISSIVE'),
  'group_expenses has NO permissive FOR ALL policy');

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public'
                 AND tablename IN ('group_expenses', 'group_settlements')
                 AND cmd = 'DELETE'),
  'neither ledger table has a DELETE policy (hard-delete is not a client verb)');

-- Every ledger policy is membership-scoped, not merely authorship-scoped:
-- a bare `auth.uid() = user_id` would let an ex-member keep editing their own
-- rows in a group they left, which is exactly the finding.
SELECT test.assert(
  (SELECT bool_and(COALESCE(qual, with_check) ILIKE '%is_group_member%')
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('group_expenses', 'group_settlements')
      AND cmd IN ('INSERT', 'UPDATE')),
  'every ledger INSERT/UPDATE policy calls is_group_member()');

-- ── RLS ENABLED ON EVERY PUBLIC TABLE ─────────────────────────────────────
-- The audit's systemic worry: 40 hand-applied files, one forgotten
-- ENABLE ROW LEVEL SECURITY and a whole table is world-readable.
SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity),
  'RLS is ENABLED on every table in schema public',
  COALESCE((SELECT string_agg(c.relname, ', ') FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity),
           '(none missing)'));

-- A table with RLS on and zero policies is a deliberate service-role lockbox
-- (app_push_config; khata_link_lookups from p3-khata-link; reconciliation_runs
-- and reconciliation_findings from p3-invariant-monitoring). Assert the set is
-- exactly the known one, so a NEW silent lockbox fails the build.
SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
       AND NOT EXISTS (SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'public' AND p.tablename = c.relname)
       AND c.relname NOT IN ('app_push_config', 'khata_link_lookups', 'reconciliation_runs', 'reconciliation_findings')),
  'the only policy-less RLS table is the documented app_push_config lockbox',
  COALESCE((SELECT string_agg(c.relname, ', ') FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
               AND NOT EXISTS (SELECT 1 FROM pg_policies p
                                WHERE p.schemaname='public' AND p.tablename=c.relname)
               AND c.relname NOT IN ('app_push_config', 'khata_link_lookups', 'reconciliation_runs', 'reconciliation_findings')), '(none)'));
