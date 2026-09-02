-- ════════════════════════════════════════════════════════════════════════════
-- 30 · The join / lookup / invite RPC contracts
--
-- Evidence:
--   05-security.md H1  — join_group_by_code RAISED on a bad code, which rolled
--                        back the very attempt row the rate limiter counts. The
--                        limiter could therefore never fire. The fix returns a
--                        jsonb status object so the INSERT commits.
--   05-security.md H9  — lookup_profile_by_code was an unthrottled oracle over
--                        the whole 6-character code keyspace.
--   05-security.md C6  — accept_group_invite now takes the RAW token and hashes
--                        it server-side; passing the hash must NOT work, or the
--                        hash is still a bearer credential.
--   06-user-experience.md UX-18 — preview_group_by_code, with a projection
--                        fixed in SQL.
--
-- Rate-limit budgets are per-caller, so each windowed test uses its own user.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('30-join-lookup-invite-rpcs');

SET ROLE authenticated;

-- ── join_group_by_code returns DATA, never an exception (H1) ───────────────
SELECT test.as_user('44444444-4444-4444-4444-444444444444');

CREATE TEMP TABLE _j1 AS SELECT join_group_by_code('ZZZZZZ', 'Danish') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _j1) = 'INVALID_OR_EXPIRED_CODE',
  'a bad join code returns {"status":"INVALID_OR_EXPIRED_CODE"} instead of raising',
  (SELECT r::text FROM _j1));

SELECT test.assert(jsonb_typeof((SELECT r FROM _j1)) = 'object',
  'join_group_by_code returns a jsonb object (the new client contract)');

-- THE load-bearing assertion: the failed attempt SURVIVED. Under the old
-- raising version this row was rolled back with the exception and the limiter
-- counted zero forever.
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM join_code_attempts
    WHERE user_id = '44444444-4444-4444-4444-444444444444'
      AND succeeded = false) = 1,
  'the failed-attempt row COMMITS (the H1 root cause)',
  'attempts: ' || (SELECT count(*) FROM join_code_attempts
                    WHERE user_id = '44444444-4444-4444-4444-444444444444')::text);
SET ROLE authenticated;

-- Shape rejects are free — they look nothing up, so they are not charged.
SELECT test.assert(
  (join_group_by_code('SHORT', 'Danish') ->> 'status') = 'INVALID_CODE',
  'a wrong-length code is rejected on shape alone');

-- ── The 5-per-5-minutes window actually trips ─────────────────────────────
-- One miss is already on the ledger; four more reach the limit.
SELECT join_group_by_code('ZZZZZ1', 'Danish');
SELECT join_group_by_code('ZZZZZ2', 'Danish');
SELECT join_group_by_code('ZZZZZ3', 'Danish');
CREATE TEMP TABLE _j5 AS SELECT join_group_by_code('ZZZZZ4', 'Danish') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _j5) = 'INVALID_OR_EXPIRED_CODE',
  'misses 2–5 still answer INVALID_OR_EXPIRED_CODE',
  (SELECT r::text FROM _j5));

CREATE TEMP TABLE _j6 AS SELECT join_group_by_code('ZZZZZ5', 'Danish') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _j6) = 'RATE_LIMITED',
  'the 6th miss in the window returns RATE_LIMITED (C5)',
  (SELECT r::text FROM _j6));
SELECT test.assert(((SELECT r FROM _j6) ->> 'retry_after_seconds')::int = 300,
  'RATE_LIMITED carries retry_after_seconds = 300');

-- A blocked call must not extend its own block, or an honest user never drains
-- the window: the ledger is still at 5.
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM join_code_attempts
    WHERE user_id = '44444444-4444-4444-4444-444444444444'
      AND succeeded = false) = 5,
  'a rate-limited call is NOT charged to its own window',
  'attempts: ' || (SELECT count(*) FROM join_code_attempts
                    WHERE user_id='44444444-4444-4444-4444-444444444444'
                      AND succeeded = false)::text);
SET ROLE authenticated;

-- The owner's own code is a valid code, so it is not a guess and not charged.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert(
  (join_group_by_code('ABC123', 'Ayesha') ->> 'status') = 'CANNOT_JOIN_OWN_GROUP',
  'the owner joining their own group is refused as data, not an exception');

-- anon must not be able to call the join RPC at all.
RESET ROLE;
SELECT test.assert(
  NOT has_function_privilege('anon', 'public.join_group_by_code(text,text)', 'EXECUTE'),
  'anon cannot EXECUTE join_group_by_code');
SET ROLE authenticated;

-- ── preview_group_by_code (UX-18) ─────────────────────────────────────────
-- E has a clean rate-limit budget.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
CREATE TEMP TABLE _p AS SELECT preview_group_by_code('ABC123') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _p) = 'ok',
  'preview_group_by_code resolves a valid code',
  (SELECT r::text FROM _p));
SELECT test.assert(
  (SELECT r ->> 'name' FROM _p) = 'Dubai Trip'
  AND (SELECT r ->> 'owner_display_name' FROM _p) = 'Ayesha'
  AND (SELECT (r ->> 'member_count')::int FROM _p) = 2,
  'the preview shows name / owner / connected member count',
  (SELECT r::text FROM _p));
SELECT test.assert(
  NOT ((SELECT r FROM _p) ? 'id')
  AND NOT ((SELECT r FROM _p) ? 'members')
  AND NOT ((SELECT r FROM _p) ? 'join_code')
  AND (SELECT r::text FROM _p) NOT LIKE '%G1%',
  'the preview leaks no group id, no member list, no code, no money',
  (SELECT r::text FROM _p));

-- A miss on the preview is charged to the SAME window as the join RPC, or the
-- preview becomes a free oracle that makes the join limiter irrelevant.
SELECT preview_group_by_code('YYYYYY');
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM join_code_attempts
    WHERE user_id = '55555555-5555-5555-5555-555555555555'
      AND succeeded = false) = 1,
  'a preview miss is charged to the shared join-code window');
SET ROLE authenticated;

-- ── lookup_profile_by_code throttle (H9) ──────────────────────────────────
-- C's budget is untouched. 20 lookups per rolling hour; the 21st must be
-- indistinguishable from "no such code" — zero rows, never an error.
SELECT test.as_user('33333333-3333-3333-3333-333333333333');

SELECT test.assert((SELECT count(*) FROM lookup_profile_by_code('AAA111')) = 1,
  'lookup_profile_by_code resolves a real code');

DO $$
BEGIN
  FOR i IN 1..19 LOOP PERFORM public.lookup_profile_by_code('AAA111'); END LOOP;
END;
$$;

SELECT test.assert((SELECT count(*) FROM lookup_profile_by_code('AAA111')) = 0,
  'the 21st lookup in the hour returns ZERO ROWS (H9 throttle)');

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM code_lookup_attempts
    WHERE user_id = '33333333-3333-3333-3333-333333333333') = 20,
  'exactly 20 lookups were charged; the throttled call was not',
  'charged: ' || (SELECT count(*) FROM code_lookup_attempts
                   WHERE user_id='33333333-3333-3333-3333-333333333333')::text);
SET ROLE authenticated;

-- ── accept_group_invite takes the RAW token, not the hash (C6) ────────────
-- hash_invite_token() is a server-side helper and is deliberately NOT
-- executable by a client; the owner's client computes the same SHA-256 itself
-- (src/stores/splitStore.ts) because it holds the raw token at that moment.
RESET ROLE;
SELECT test.assert(
  NOT has_function_privilege('authenticated', 'public.hash_invite_token(text)',
                             'EXECUTE'),
  'hash_invite_token() is not callable by authenticated');
SET ROLE authenticated;

SELECT test.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO group_invites (id, group_id, token_hash, created_by)
VALUES ('I-1', 'G1',
        encode(extensions.digest('raw-secret-token', 'sha256'), 'hex'),
        auth.uid());

SELECT test.assert(
  (SELECT expires_at IS NOT NULL FROM group_invites WHERE id = 'I-1'),
  'group_invites.expires_at is stamped server-side');

-- F presents the STORED HASH. If this worked, the hash would still be a bearer
-- credential and C6 would only be half closed.
SELECT test.as_user('66666666-6666-6666-6666-666666666666');
CREATE TEMP TABLE _iv1 AS
  SELECT accept_group_invite(
    encode(extensions.digest('raw-secret-token','sha256'),'hex'), 'Faisal') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _iv1) = 'INVITE_NOT_FOUND_OR_EXPIRED',
  'presenting the stored token_hash does NOT accept the invite (C6)',
  (SELECT r::text FROM _iv1));

CREATE TEMP TABLE _iv2 AS
  SELECT accept_group_invite('raw-secret-token', 'Faisal') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _iv2) = 'ok',
  'presenting the RAW token accepts the invite',
  (SELECT r::text FROM _iv2));

RESET ROLE;
SELECT test.assert(
  (SELECT status FROM group_members
    WHERE group_id = 'G1'
      AND profile_id = '66666666-6666-6666-6666-666666666666') = 'connected',
  'the invite acceptance produced a CONNECTED member row via the definer RPC');
