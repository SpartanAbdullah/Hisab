-- ════════════════════════════════════════════════════════════════════════════
-- 8y · Guest members in groups  (G6 / O4, July blocker B6)
--
-- Evidence: supabase-migration-p2-guest-members.sql
--           docs/audit-2026-09/11-competitive-analysis.md:88 (G6) and :121 (O4)
--
-- The claims under test — every one of them a thing the audit or the migration
-- header ASSERTS, proven here against a live database instead:
--   (a) a connected member (owner OR not) can add a named seat with no Hisaab
--       account; a stranger cannot, and the name must be unique in the group;
--   (b) the hashed phone behind a guest is invisible to every client role;
--   (c) a guest is a first-class ledger participant — split share AND payer —
--       because the connected-member triggers gate on status, not profile_id;
--   (d) a settlement to a guest is recorded BY a connected member, still capped,
--       and a stranger cannot record one;
--   (e) join-by-code claims a matching guest seat through the EXISTING rebind
--       door instead of minting a second row;
--   (f) the group deletion guard still ignores guests, and another member's
--       account deletion leaves guest rows intact;
--   (g) a guest RENAME (owner UPDATE of display_name) is validated
--       SERVER-SIDE now too — group_members_guest_rename_rules, the residual
--       close in p2-guest-members.sql §3b — not just by the client.
--
-- Fresh group GG1 and fresh users, so nothing above (G1, users A–F) shifts.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8y-guest-members');

RESET ROLE;

-- Two new accounts: K is the real person behind the guest seat (claim test),
-- L is a bystander member whose account deletion must not disturb guests.
INSERT INTO auth.users (id, email) VALUES
  ('77777777-7777-7777-7777-777777777777', 'k@hisaab.test'),
  ('88888888-8888-8888-8888-888888888888', 'l@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Kamran', public_code = 'HSB-KKK777',
                    public_code_normalized = 'KKK777',
                    -- The number the owner will type on the guest seat. Nothing
                    -- verifies it (migration §0c) — that is the documented risk.
                    phone_e164 = '+923001234567'
 WHERE id = '77777777-7777-7777-7777-777777777777';
UPDATE profiles SET name = 'Laiba', public_code = 'HSB-LLL888',
                    public_code_normalized = 'LLL888'
 WHERE id = '88888888-8888-8888-8888-888888888888';

SET ROLE authenticated;

-- ── Fixture: A owns GG1, B joins by code. ───────────────────────────────────
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

INSERT INTO split_groups (id, user_id, name, emoji, currency,
                          join_code, join_code_normalized, created_by)
VALUES ('GG1', auth.uid(), 'Flat 12', '🏠', 'AED',
        'GRP-GST123', 'GST123', auth.uid());

INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, joined_at)
VALUES ('MGG-A', 'GG1', auth.uid(), 'Ayesha', 'owner', 'connected', auth.uid(), now());

SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert((join_group_by_code('GST123', 'Bilal') ->> 'status') = 'ok',
  'fixture: B joins GG1 by code');

-- ════════════════════════════════════════════════════════════════════════════
-- (a) ADDING A GUEST
-- ════════════════════════════════════════════════════════════════════════════

-- 1. The OWNER adds a guest carrying a phone number.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
CREATE TEMP TABLE _g1 AS
  SELECT add_group_guest('GG1', '  Kamran  ', '0300 1234567', 'MG-1') AS r;
SELECT test.assert(
  (SELECT r ->> 'status' FROM _g1) = 'ok'
  AND (SELECT (r ->> 'has_phone')::boolean FROM _g1),
  'owner adds a guest with a phone; the number normalises to an E.164 hash',
  (SELECT r::text FROM _g1));

-- The row is a LIVE participant with no account, and is_guest says so.
SELECT test.assert(
  (SELECT profile_id IS NULL AND status = 'connected' AND role = 'member'
          AND is_guest AND display_name = 'Kamran'
     FROM group_members WHERE id = 'MG-1'),
  'the guest seat is profile_id NULL, status connected, is_guest true, name trimmed');

-- 2. A STRANGER cannot add a guest to someone else''s group, and gets the same
--    answer a guessed group id would produce (no existence oracle).
SELECT test.as_user('44444444-4444-4444-4444-444444444444');
SELECT test.assert(
  (add_group_guest('GG1', 'Intruder', NULL, 'MG-HACK') ->> 'status') = 'NOT_ACTIVE_MEMBER'
  AND (add_group_guest('G-NOPE', 'Intruder', NULL, 'MG-HACK2') ->> 'status') = 'NOT_ACTIVE_MEMBER'
  AND (SELECT count(*) FROM group_members WHERE id IN ('MG-HACK', 'MG-HACK2')) = 0,
  'a stranger cannot add a guest, and a real group is indistinguishable from a fake one');

-- 3. A CONNECTED NON-OWNER can (the Splitwise model, migration §0b).
SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert(
  (add_group_guest('GG1', 'Sana', NULL, 'MG-2') ->> 'status') = 'ok',
  'any connected member — not just the owner — can add a guest');

-- 4. Duplicate live names are refused: the app keys people by NAME wherever a
--    profile is absent (docs/who-owes-me.md §3 rule 3), so two "Sana"s would
--    silently merge into one person''s money.
SELECT test.assert(
  (add_group_guest('GG1', ' sana ', NULL, 'MG-3') ->> 'status') = 'DUPLICATE_NAME'
  AND (add_group_guest('GG1', 'Bilal', NULL, 'MG-4') ->> 'status') = 'DUPLICATE_NAME',
  'a guest cannot reuse the name of another guest or of a real member');

-- 5. Idempotent replay — a double tap must not mint a twin.
SELECT test.assert(
  (add_group_guest('GG1', 'Sana', NULL, 'MG-2') ->> 'status') = 'ALREADY_ADDED'
  AND (SELECT count(*) FROM group_members WHERE group_id = 'GG1' AND profile_id IS NULL) = 2,
  'replaying add_group_guest on the same member id returns ALREADY_ADDED, not a second seat');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) THE PHONE HASH IS NOT CLIENT-READABLE
-- ════════════════════════════════════════════════════════════════════════════
-- 6. Not the owner, not the adder, not anyone. RLS denies every row and the
--    table grant was revoked as well.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_zero_rows(
  $$ UPDATE group_guest_identities SET phone_hashes = ARRAY['x'] WHERE member_id = 'MG-1' $$,
  'no client role can write group_guest_identities');
-- Not "returns zero rows" but "cannot ask the question at all": the table grant
-- itself was revoked, so RLS never even gets consulted.
SELECT test.assert_raises(
  $$ SELECT count(*) FROM group_guest_identities $$,
  'permission denied',
  'the guest phone hashes are invisible to a client, even the one who typed the number');
SELECT test.assert(
  NOT has_table_privilege('authenticated', 'public.group_guest_identities', 'SELECT')
  AND NOT has_function_privilege('authenticated', 'public.hash_phone_e164(text)', 'EXECUTE'),
  'neither the hash table nor the hashing function is reachable from a client role');

-- But the row really is there, under the definer''s eyes.
RESET ROLE;
SELECT test.assert(
  (SELECT array_length(phone_hashes, 1) >= 1 FROM group_guest_identities WHERE member_id = 'MG-1'),
  'the hash was stored — the invisibility above is RLS, not a silent no-op');
SELECT test.assert(
  (SELECT NOT (phone_hashes::text LIKE '%1234567%') FROM group_guest_identities WHERE member_id = 'MG-1'),
  'the RAW number is never stored — only its digest');
SET ROLE authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- (c) A GUEST IS A FIRST-CLASS LEDGER PARTICIPANT
-- ════════════════════════════════════════════════════════════════════════════
-- 7. Split participant. tg_group_expenses_require_connected_members demands a
--    CONNECTED member for every split id and never looks at profile_id, so this
--    lands with no change to that trigger (migration §0.1).
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_ok($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, split_type, splits, created_by)
  VALUES ('E-GG1A', auth.uid(), 'GG1', 'Cleaner', 90.00, 'MGG-A', 'equal',
          jsonb_build_array(
            jsonb_build_object('memberId', 'MGG-A',  'amount', 30.00),
            jsonb_build_object('memberId', 'MG-1',  'amount', 30.00),
            jsonb_build_object('memberId', 'MG-2',  'amount', 30.00)),
          auth.uid())
$$, 'a guest can be a split participant in a group expense');

-- 8. And the PAYER. Recorded by a connected member on the guest''s behalf —
--    a guest has no account and can never author anything itself.
SELECT test.assert_ok($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, split_type, splits, created_by)
  VALUES ('E-GG1B', auth.uid(), 'GG1', 'Gas cylinder', 20.00, 'MG-1', 'equal',
          jsonb_build_array(
            jsonb_build_object('memberId', 'MGG-A', 'amount', 10.00),
            jsonb_build_object('memberId', 'MG-1', 'amount', 10.00)),
          auth.uid())
$$, 'a guest can be paid_by — the payer of a group expense');

-- A guest still is not a MEMBER in the access sense: nothing can act as one.
SELECT test.assert(NOT is_group_member('GG1', NULL::uuid),
  'is_group_member() can never be true for a guest — there is no account to act as');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) SETTLING WITH A GUEST
-- ════════════════════════════════════════════════════════════════════════════
-- Position after E-G2A + E-G2B: Kamran owes A 30 (share) − 20 (he paid) + 10
-- (his share of what he paid) = 20; Sana owes A 30.

-- 9. A STRANGER cannot record a settlement involving the guest.
SELECT test.as_user('44444444-4444-4444-4444-444444444444');
SELECT test.assert(
  (record_group_settlement('S-HACK', 'GG1', 'MG-1', 'MGG-A', 5.00, '', now())
     ->> 'reason_code') = 'NOT_ACTIVE_MEMBER'
  AND (SELECT count(*) FROM group_settlements WHERE id = 'S-HACK') = 0,
  'a stranger cannot settle on a guest''s behalf');

-- 10. The cap still applies to a guest edge — group_settlement_cap is pure
--     arithmetic over the ledger and never reads profile_id.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert(
  (record_group_settlement('S-OVER', 'GG1', 'MG-1', 'MGG-A', 500.00, '', now())
     ->> 'reason_code') = 'EXCEEDS_OUTSTANDING',
  'a settlement bigger than what the guest owes is refused by the cap');

-- 11. A connected member records it on the guest''s behalf, and it lands.
CREATE TEMP TABLE _s1 AS
  SELECT record_group_settlement('S-GG1', 'GG1', 'MG-1', 'MGG-A', 20.00, 'cash', now()) AS r;
SELECT test.assert(
  (SELECT (r ->> 'success')::boolean AND (r ->> 'reason_code') = 'SETTLEMENT_RECORDED' FROM _s1)
  AND (SELECT user_id FROM group_settlements WHERE id = 'S-GG1')
      = '11111111-1111-1111-1111-111111111111',
  'a connected member records a guest settlement on their behalf; authorship stays with the recorder',
  (SELECT r::text FROM _s1));

-- Which squares that edge: the cap is now nothing.
SELECT test.assert(
  (record_group_settlement('S-GG1b', 'GG1', 'MG-1', 'MGG-A', 1.00, '', now())
     ->> 'reason_code') = 'ALREADY_SETTLED',
  'the guest edge reads as settled once the full outstanding amount is recorded');

-- ════════════════════════════════════════════════════════════════════════════
-- (e) THE CLAIM — one mechanism, not a second one
-- ════════════════════════════════════════════════════════════════════════════
-- 12. K joins G2 by code. Their profile number matches MG-1''s stored hash, so
--     the EXISTING rebind door binds the seat instead of minting a new row —
--     and the whole ledger history above comes with it.
SELECT test.as_user('77777777-7777-7777-7777-777777777777');
CREATE TEMP TABLE _join AS SELECT join_group_by_code('GST123', 'Kamran K') AS r;
SELECT test.assert(
  (SELECT r ->> 'status' FROM _join) = 'ok'
  AND (SELECT (r ->> 'claimed_guest_seat')::boolean FROM _join)
  AND (SELECT r ->> 'member_id' FROM _join) = 'MG-1'
  AND NOT (SELECT (r ->> 'was_already_connected')::boolean FROM _join),
  'join-by-code claims the matching guest seat rather than creating a second one',
  (SELECT r::text FROM _join));

RESET ROLE;
SELECT test.assert(
  (SELECT profile_id = '77777777-7777-7777-7777-777777777777'
          AND status = 'connected' AND NOT is_guest AND joined_at IS NOT NULL
     FROM group_members WHERE id = 'MG-1')
  AND (SELECT count(*) FROM group_members WHERE group_id = 'GG1') = 4
  -- the seat''s money history followed it, unchanged
  AND (SELECT paid_by FROM group_expenses WHERE id = 'E-GG1B') = 'MG-1'
  AND (SELECT from_member FROM group_settlements WHERE id = 'S-GG1') = 'MG-1',
  'the claimed seat keeps its member id, its expenses and its settlements');

-- The claim consumes the phone identity, so no one else can match it later.
SELECT test.assert(
  (SELECT count(*) FROM group_guest_identities WHERE member_id = 'MG-1') = 0,
  'the claimed seat''s phone hash is deleted — it can never be matched twice');
SET ROLE authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- (f) LIFECYCLE — guests block nothing, and survive other people''s exits
-- ════════════════════════════════════════════════════════════════════════════
-- 13. remove_group_guest: the typo escape hatch, closed the moment money
--     references the seat.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert(
  (remove_group_guest('GG1', 'MG-2') ->> 'status') = 'GUEST_HAS_LEDGER'
  AND (remove_group_guest('GG1', 'MG-1') ->> 'status') = 'NOT_A_GUEST'
  AND (SELECT count(*) FROM group_members WHERE id IN ('MG-1', 'MG-2')) = 2,
  'a guest with ledger rows cannot be removed, and a claimed seat is no longer a guest');

SELECT test.assert(
  (add_group_guest('GG1', 'Typo', NULL, 'MG-TYPO') ->> 'status') = 'ok'
  AND (remove_group_guest('GG1', 'MG-TYPO') ->> 'status') = 'ok'
  AND (SELECT count(*) FROM group_members WHERE id = 'MG-TYPO') = 0,
  'an unused guest seat can be removed by the owner');

-- 14. The deletion guard ignores guests entirely (Tier A and Tier B both scope
--     to profile-linked members), so a guest-only group with an OUTSTANDING
--     guest balance still deletes cleanly — the legacy case
--     group-deletion-guard.sql:93-110 argued for, now the everyday one.
INSERT INTO split_groups (id, user_id, name, emoji, currency, created_by)
VALUES ('GG2', auth.uid(), 'Solo + guest', '🧾', 'AED', auth.uid());
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, joined_at)
VALUES ('MGG2-A', 'GG2', auth.uid(), 'Ayesha', 'owner', 'connected', auth.uid(), now());
SELECT test.assert((add_group_guest('GG2', 'Rehan', NULL, 'MG3-1') ->> 'status') = 'ok',
  'fixture: a guest-only group needs no second real member to be usable');
INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, split_type, splits, created_by)
VALUES ('E-GG2', auth.uid(), 'GG2', 'Paint', 100.00, 'MGG2-A', 'equal',
        jsonb_build_array(
          jsonb_build_object('memberId', 'MGG2-A',  'amount', 50.00),
          jsonb_build_object('memberId', 'MG3-1', 'amount', 50.00)),
        auth.uid());
SELECT test.assert_ok($$ DELETE FROM split_groups WHERE id = 'GG2' $$,
  'the deletion guard ignores guests: a group whose only other member is an unsettled guest still deletes');
SELECT test.assert((SELECT count(*) FROM group_members WHERE group_id = 'GG2') = 0,
  'deleting the group takes its guest seats with it (FK cascade)');

-- 15. Another member''s ACCOUNT DELETION leaves guest rows untouched.
SELECT test.as_user('88888888-8888-8888-8888-888888888888');
SELECT test.assert((join_group_by_code('GST123', 'Laiba') ->> 'status') = 'ok',
  'fixture: L joins GG1');
SELECT test.assert_ok($$ SELECT delete_current_user() $$,
  'fixture: L deletes their Hisaab account');

RESET ROLE;
SELECT test.assert(
  (SELECT is_guest AND status = 'connected' AND profile_id IS NULL
     FROM group_members WHERE id = 'MG-2')
  AND (SELECT count(*) FROM group_expenses WHERE group_id = 'GG1' AND deleted_at IS NULL) = 2,
  'a departing account leaves the group''s guest seats and ledger intact');

-- And the departed account''s OWN seat is left, not guest — the distinction
-- is_guest exists to keep (migration §0.6).
SELECT test.assert(
  (SELECT status = 'left' AND profile_id IS NULL AND NOT is_guest
     FROM group_members
    WHERE group_id = 'GG1' AND display_name = 'Laiba'),
  'a deleted account''s anonymized seat reads as left, never as a claimable guest');

-- ════════════════════════════════════════════════════════════════════════════
-- (g) RENAME — the BEFORE UPDATE OF display_name backstop (§3b)
-- ════════════════════════════════════════════════════════════════════════════
-- The owner-only UPDATE policy (p0-launch-blockers.sql:163-178) is the only
-- door a rename walks through; group_members_guest_rename_rules is now the
-- floor underneath it. Before this, splitStore.ts renameGroupGuest's
-- 1-40-char + live-duplicate checks were the ONLY enforcement (:148-151) —
-- purely client-side, so two owner devices could race two guests onto one
-- name. GG1 at this point: MGG-A = Ayesha (owner, real), MG-1 = Kamran
-- (claimed at test 12, real), MG-2 = Sana (still an unclaimed guest).
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- 16. A clean rename of a live guest seat succeeds.
SELECT test.assert_ok(
  $$ UPDATE group_members SET display_name = 'Sana K' WHERE id = 'MG-2' $$,
  'the owner renames a guest seat; the trigger accepts a clean, unique name');
SELECT test.assert(
  (SELECT display_name = 'Sana K' AND is_guest FROM group_members WHERE id = 'MG-2'),
  'the rename landed and the seat is still a guest');

-- 17. Renaming onto a live member's existing name is refused with the same
--     stable code §3's INSERT trigger raises for add_group_guest.
SELECT test.assert_raises(
  $$ UPDATE group_members SET display_name = 'Ayesha' WHERE id = 'MG-2' $$,
  'DUPLICATE_GROUP_MEMBER_NAME',
  'renaming a guest onto a live member''s existing name is refused server-side');
SELECT test.assert(
  (SELECT display_name = 'Sana K' FROM group_members WHERE id = 'MG-2'),
  'the refused rename changed nothing');

-- 18. A name past rename's 1-40 bound is refused server-side — previously
--     only the client checked this.
SELECT test.assert_raises(
  $$ UPDATE group_members SET display_name = repeat('x', 41) WHERE id = 'MG-2' $$,
  'INVALID_GUEST_NAME',
  'a 41-character guest name is refused by the server, not just the client');

-- 19. A profile-linked member's rename is completely unaffected — the trigger
--     scopes to OLD.profile_id IS NULL AND OLD.status <> 'left' only.
SELECT test.assert_ok(
  $$ UPDATE group_members SET display_name = 'Kamran Khan' WHERE id = 'MG-1' $$,
  'a profile-linked member''s rename is untouched by the guest-only trigger');
SELECT test.assert(
  (SELECT display_name = 'Kamran Khan' AND NOT is_guest AND profile_id IS NOT NULL
     FROM group_members WHERE id = 'MG-1'),
  'the linked member''s rename landed with no guest-rule interference');
