-- ════════════════════════════════════════════════════════════════════════════
-- 00 · Fixtures — three users, one shared group, one expense.
--
-- Everything below runs through the SAME doors a PostgREST client uses:
-- role `authenticated` with request.jwt.claim.sub set. The only superuser work
-- is creating auth.users rows (GoTrue's job in production).
--
-- Users:
--   A  11111111-…  owner of group G1
--   B  22222222-…  joins G1 by code, stays
--   C  33333333-…  joins G1 by code, then LEAVES with a zero balance → the
--                  "ex-member" of the group-ledger-integrity finding
--   D  44444444-…  solo user, used by the account-deletion tests
--
-- The one expense E1 (60.00) is split A/B only, so C's balance is zero and
-- leave_group takes the clean LEFT_GROUP path.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('00-fixtures');

RESET ROLE;

-- ── GoTrue's job: create the auth users. `on_auth_user_created` (schema.sql)
--    bootstraps a public.profiles row for each.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a@hisaab.test'),
  ('22222222-2222-2222-2222-222222222222', 'b@hisaab.test'),
  ('33333333-3333-3333-3333-333333333333', 'c@hisaab.test'),
  ('44444444-4444-4444-4444-444444444444', 'd@hisaab.test'),
  -- E and F exist only for 50-lifecycle.sql, which deletes accounts. Keeping
  -- them out of A–D means the deletion tests cannot disturb anything above.
  ('55555555-5555-5555-5555-555555555555', 'e@hisaab.test'),
  ('66666666-6666-6666-6666-666666666666', 'f@hisaab.test');

UPDATE profiles SET name = 'Ayesha', public_code = 'HSB-AAA111',
                    public_code_normalized = 'AAA111'
 WHERE id = '11111111-1111-1111-1111-111111111111';
UPDATE profiles SET name = 'Bilal',  public_code = 'HSB-BBB222',
                    public_code_normalized = 'BBB222'
 WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET name = 'Chand',  public_code = 'HSB-CCC333',
                    public_code_normalized = 'CCC333'
 WHERE id = '33333333-3333-3333-3333-333333333333';
UPDATE profiles SET name = 'Danish', public_code = 'HSB-DDD444',
                    public_code_normalized = 'DDD444'
 WHERE id = '44444444-4444-4444-4444-444444444444';
UPDATE profiles SET name = 'Erum',   public_code = 'HSB-EEE555',
                    public_code_normalized = 'EEE555'
 WHERE id = '55555555-5555-5555-5555-555555555555';
UPDATE profiles SET name = 'Faisal', public_code = 'HSB-FFF666',
                    public_code_normalized = 'FFF666'
 WHERE id = '66666666-6666-6666-6666-666666666666';

SELECT test.assert((SELECT count(*) FROM profiles) = 6,
  'schema.sql on_auth_user_created bootstraps one profile per auth user',
  'profiles: ' || (SELECT count(*) FROM profiles)::text);

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- A creates the group with a join code. The expiry is stamped server-side by
-- tg_split_groups_join_code_expiry — the client never sets it.
INSERT INTO split_groups (id, user_id, name, emoji, currency,
                          join_code, join_code_normalized, created_by)
VALUES ('G1', auth.uid(), 'Dubai Trip', '🏝', 'AED',
        'GRP-ABC123', 'ABC123', auth.uid());

SELECT test.assert(
  (SELECT join_code_expires_at IS NOT NULL FROM split_groups WHERE id = 'G1'),
  'join_code_expires_at is stamped server-side on group creation');

-- A's own membership row: self-consent, so the consent trigger lets
-- role=owner / status=connected through untouched.
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, joined_at)
VALUES ('M-A', 'G1', auth.uid(), 'Ayesha', 'owner', 'connected', auth.uid(), now());

SELECT test.assert(
  (SELECT role = 'owner' AND status = 'connected'
     FROM group_members WHERE id = 'M-A'),
  'owner self-member insert keeps role=owner status=connected');

-- ── B joins by code. join_group_by_code is the definer path, so B lands
--    `connected` without an owner ever writing B's row.
SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert(
  (join_group_by_code('ABC123', 'Bilal') ->> 'status') = 'ok',
  'B joins G1 with a valid join code');

-- ── C joins by code too.
SELECT test.as_user('33333333-3333-3333-3333-333333333333');
SELECT test.assert(
  (join_group_by_code('ABC123', 'Chand') ->> 'status') = 'ok',
  'C joins G1 with a valid join code');

-- Park the member ids so later files can name them without re-querying.
RESET ROLE;
CREATE TABLE IF NOT EXISTS test.fixture (k TEXT PRIMARY KEY, v TEXT);
GRANT SELECT ON test.fixture TO authenticated, anon;
INSERT INTO test.fixture (k, v)
SELECT 'M-B', id FROM group_members
 WHERE group_id = 'G1' AND profile_id = '22222222-2222-2222-2222-222222222222'
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
INSERT INTO test.fixture (k, v)
SELECT 'M-C', id FROM group_members
 WHERE group_id = 'G1' AND profile_id = '33333333-3333-3333-3333-333333333333'
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
SET ROLE authenticated;

-- ── A records a 60.00 expense split A/B. C is deliberately NOT in the splits
--    so C can leave with a zero balance.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, split_type, splits, created_by)
SELECT 'E1', auth.uid(), 'G1', 'Hotel', 60.00, 'M-A', 'equal',
       jsonb_build_array(
         jsonb_build_object('memberId', 'M-A', 'amount', 30.00),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                            'amount', 30.00)),
       auth.uid();

SELECT test.assert((SELECT count(*) FROM group_expenses WHERE id = 'E1') = 1,
  'an active connected member can write a group expense');

-- ── C leaves the group through the supported RPC (zero balance → LEFT_GROUP).
SELECT test.as_user('33333333-3333-3333-3333-333333333333');
CREATE TEMP TABLE _leave AS SELECT leave_group('G1') AS r;
SELECT test.assert((SELECT (r ->> 'success')::boolean FROM _leave),
  'C leaves G1 cleanly (zero balance)',
  (SELECT r::text FROM _leave));

SELECT test.as_user(NULL::uuid);
RESET ROLE;
SELECT test.assert(
  (SELECT status FROM group_members
    WHERE group_id = 'G1'
      AND profile_id = '33333333-3333-3333-3333-333333333333') <> 'connected',
  'C is no longer a connected member of G1 (the ex-member fixture)',
  'status = ' || (SELECT status FROM group_members
                   WHERE group_id = 'G1'
                     AND profile_id = '33333333-3333-3333-3333-333333333333'));
