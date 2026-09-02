-- ════════════════════════════════════════════════════════════════════════════
-- 8w · Safe post-creation editing of a kameti
--      (supabase-migration-p2-kameti-editing.sql, audit 06-user-experience
--       UX-25 "no dropout/removal or order-fixing path")
--
-- What this pins, in the two directions that matter:
--   1. The RPC honours the matrix — organiser-only, each field frozen at
--      exactly the lifecycle state the migration header's table says.
--   2. RAW PostgREST cannot walk around the RPC. Every lock is asserted twice:
--      once through update_committee(), once as the plain `UPDATE committees
--      SET …` a client with an anon key can send against its own row (the
--      owner UPDATE policy in committees.sql:69 allows the row; only the
--      trigger stops the write).
--
-- STYLE NOTE: a call that mutates and a read of the result NEVER share one
-- boolean expression — Postgres may evaluate the operands of AND in any order,
-- so `fn(...) = 'ok' AND (SELECT … FROM committees)` could read the table
-- before the function ran. Mutate in its own statement, assert in the next.
--
-- Its own user H (88888888-…) so nothing here can disturb the fixtures, and so
-- 50-lifecycle's account-deletion suite (which deletes F) cannot have removed
-- the rows this file needs.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8w-kameti-editing');

-- ── Shape of the three RPCs. Catalog reads, so RESET ROLE deliberately. ─────
RESET ROLE;

SELECT test.assert(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('update_committee', 'add_committee_member', 'remove_committee_member')
      AND p.prosecdef) = 3,
  'update_committee / add_committee_member / remove_committee_member are all SECURITY DEFINER');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.update_committee(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_committee(text,jsonb)', 'EXECUTE'),
  'authenticated may execute update_committee; anon may NOT');

SELECT test.assert(
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'committees' AND NOT t.tgisinternal
      AND t.tgname IN ('trg_committees_draw_immutable',
                       'trg_committees_edit_guard',
                       'trg_committees_witness_token_guard')
      AND t.tgenabled = 'O') = 3,
  'the edit guard is armed ALONGSIDE the draw and witness-token guards (three coexisting BEFORE triggers)');

-- GoTrue's job in production.
INSERT INTO auth.users (id, email)
VALUES ('88888888-8888-8888-8888-888888888888', 'h@hisaab.test')
ON CONFLICT (id) DO NOTHING;

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('88888888-8888-8888-8888-888888888888');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. STATE `open` — no payment, no draw. Everything is editable.
-- ════════════════════════════════════════════════════════════════════════════
-- FIXED payout with hand-picked slots 1..4 and drawn_at stamped at creation,
-- exactly as committeeStore.createCommittee writes it — the case that must NOT
-- read as "drawn" (drawn_at is not the draw marker; draw_seed is).
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method, drawn_at)
VALUES ('KE-1', auth.uid(), 'Mohalla Kameti', 'PKR', 5000, 4, 'monthly', 4,
        CURRENT_DATE, 'fixed', now());
INSERT INTO committee_members (id, committee_id, user_id, name, slot, is_organizer)
VALUES ('KEM-1', 'KE-1', auth.uid(), 'Hina',   1, true),
       ('KEM-2', 'KE-1', auth.uid(), 'Imran',  2, false),
       ('KEM-3', 'KE-1', auth.uid(), 'Junaid', 3, false),
       ('KEM-4', 'KE-1', auth.uid(), 'Kiran',  4, false);

SELECT update_committee('KE-1', '{"contributionAmount": 7500}'::jsonb);
SELECT test.assert(
  (SELECT contribution_amount FROM committees WHERE id = 'KE-1') = 7500,
  'the organiser may change the contribution amount BEFORE any payment (a fixed kameti''s creation-time drawn_at does not lock it)');

SELECT update_committee('KE-1', '{"name":"Mohalla BC","emoji":"🏘"}'::jsonb);
SELECT test.assert(
  (SELECT name = 'Mohalla BC' AND emoji = '🏘' FROM committees WHERE id = 'KE-1'),
  'name and emoji are editable (and the emoji column exists)');

-- A key that is not on the whitelist never reaches a write, even alongside a
-- legal one — the whole patch is validated before anything is touched.
SELECT test.assert_raises(
  $$ SELECT update_committee('KE-1', '{"name":"Rigged","drawSeed":"deadbeef"}'::jsonb) $$,
  'KAMETI_INVALID_PATCH',
  'a patch naming a draw column is refused outright (draw fields stay untouchable)');
SELECT test.assert(
  (SELECT name = 'Mohalla BC' AND draw_seed IS NULL FROM committees WHERE id = 'KE-1'),
  'the refused patch changed NOTHING — not even its one legal key');

SELECT test.assert_raises(
  $$ SELECT update_committee('KE-1', '{"memberCount": 99}'::jsonb) $$,
  'KAMETI_INVALID_PATCH',
  'memberCount is derived — the RPC refuses it (add/remove own it)');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Not the organiser
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_raises(
  $$ SELECT update_committee('KE-1', '{"name":"Mine now"}'::jsonb) $$,
  'NOT_ORGANISER',
  'a non-organiser cannot edit someone else''s kameti');
SELECT test.assert_raises(
  $$ SELECT remove_committee_member('KE-1', 'KEM-2') $$,
  'NOT_ORGANISER',
  'a non-organiser cannot remove a member from someone else''s kameti');
SELECT test.as_user('88888888-8888-8888-8888-888888888888');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Members: add appends a member AND a round; remove compacts the slots
-- ════════════════════════════════════════════════════════════════════════════
SELECT add_committee_member('KE-1', 'Laiba', '+923001234567');
SELECT test.assert(
  (SELECT member_count = 5 AND total_rounds = 5 FROM committees WHERE id = 'KE-1')
  AND (SELECT count(*) FROM committee_members WHERE committee_id = 'KE-1') = 5
  AND (SELECT slot FROM committee_members WHERE committee_id = 'KE-1' AND name = 'Laiba') = 5,
  'add_committee_member appends a member AND a round, keeps member_count in step with the roster, and gives the newcomer the new last slot');

-- Remove the slot-2 member: slots 3,4,5 must become 2,3,4 or the schedule
-- grows a "—" round nobody can be paid in.
SELECT remove_committee_member('KE-1', 'KEM-2');
SELECT test.assert(
  (SELECT member_count = 4 AND total_rounds = 4 FROM committees WHERE id = 'KE-1')
  AND (SELECT slot FROM committee_members WHERE id = 'KEM-3') = 2
  AND (SELECT slot FROM committee_members WHERE id = 'KEM-4') = 3
  AND (SELECT count(DISTINCT slot) = 4 AND max(slot) = 4
         FROM committee_members WHERE committee_id = 'KE-1'),
  'remove_committee_member deletes the member, compacts the slots above it, drops a round, and leaves 1..total_rounds with no gap');

SELECT test.assert_raises(
  $$ SELECT remove_committee_member('KE-1', 'KEM-1') $$,
  'KAMETI_INVALID_PATCH',
  'the organiser cannot be removed from their own kameti');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. STATE `collecting` — contributions recorded for rounds 1 and 2
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO committee_payments (id, committee_id, user_id, member_id, round)
VALUES ('KEP-1', 'KE-1', auth.uid(), 'KEM-1', 1),
       ('KEP-2', 'KE-1', auth.uid(), 'KEM-1', 2);

SELECT test.assert_raises(
  $$ SELECT update_committee('KE-1', '{"contributionAmount": 100}'::jsonb) $$,
  'KAMETI_LOCKED_PAYMENTS',
  'the contribution amount is FROZEN once a contribution is recorded');
SELECT test.assert_raises(
  $$ SELECT update_committee('KE-1', '{"startDate":"2027-01-01"}'::jsonb) $$,
  'KAMETI_LOCKED_PAYMENTS',
  'the start date is frozen once a contribution is recorded');

SELECT update_committee('KE-1', '{"name":"Mohalla BC 2026","notes":"ok"}'::jsonb);
SELECT test.assert(
  (SELECT name = 'Mohalla BC 2026' FROM committees WHERE id = 'KE-1'),
  'the name is editable in EVERY state, payments or not');

-- THE BYPASS. This is the shape PostgREST sends for `committeesDb.update`, and
-- the owner UPDATE policy allows the row — only the trigger refuses the write.
SELECT test.assert_raises(
  $$ UPDATE committees SET contribution_amount = 1 WHERE id = 'KE-1' $$,
  'KAMETI_LOCKED_PAYMENTS',
  'a RAW PostgREST write of contribution_amount is refused post-payment (the RPC cannot be walked around)');
SELECT test.assert_raises(
  $$ UPDATE committees SET member_count = 99, total_rounds = 99 WHERE id = 'KE-1' $$,
  'KAMETI_INVALID_PATCH',
  'a raw write of the derived counters is refused in every state');
SELECT test.assert_ok(
  $$ UPDATE committees SET name = 'Direct rename', notes = 'still fine' WHERE id = 'KE-1' $$,
  'a raw rename is still allowed — the guard locks money shape, not labels');

SELECT test.assert_raises(
  $$ SELECT remove_committee_member('KE-1', 'KEM-3') $$,
  'KAMETI_LOCKED_PAYMENTS',
  'a member holding slot 2 cannot be removed while round 2 has a contribution — the compaction would re-number a round that already happened');

-- The untouched TAIL of the cycle may still be re-shaped: Kiran holds the last
-- slot, has no payments, and no round at or after it has been collected.
SELECT remove_committee_member('KE-1', 'KEM-4');
SELECT test.assert(
  (SELECT member_count = 3 AND total_rounds = 3 FROM committees WHERE id = 'KE-1')
  AND (SELECT count(DISTINCT slot) = 3 AND max(slot) = 3
         FROM committee_members WHERE committee_id = 'KE-1'),
  'a clean member on the untouched tail is still removable mid-collection');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. STATE `drawn` — a real server ballot draw
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method)
VALUES ('KE-2', auth.uid(), 'Ballot Kameti', 'PKR', 2000, 3, 'monthly', 3,
        CURRENT_DATE, 'ballot');
INSERT INTO committee_members (id, committee_id, user_id, name, is_organizer)
VALUES ('KEB-1', 'KE-2', auth.uid(), 'Hina', true),
       ('KEB-2', 'KE-2', auth.uid(), 'Imran', false),
       ('KEB-3', 'KE-2', auth.uid(), 'Junaid', false);

SELECT update_committee('KE-2', '{"cadence":"weekly"}'::jsonb);
SELECT test.assert(
  (SELECT cadence = 'weekly' FROM committees WHERE id = 'KE-2'),
  'an undrawn ballot kameti is fully editable');

SELECT test.assert((perform_committee_draw('KE-2') ->> 'status') = 'ok',
  'the ballot draws — the edit guard honours the draw RPC''s transaction flag and does not block it');

SELECT test.assert_raises(
  $$ SELECT update_committee('KE-2', '{"contributionAmount": 3000}'::jsonb) $$,
  'KAMETI_LOCKED_DRAW',
  'after the draw the amount is locked — with the DRAW code, not the payments one');
SELECT test.assert_raises(
  $$ SELECT add_committee_member('KE-2', 'Late Joiner') $$,
  'KAMETI_LOCKED_DRAW',
  'no member may be added after the ballot draw');
SELECT test.assert_raises(
  $$ SELECT remove_committee_member('KE-2', 'KEB-2') $$,
  'KAMETI_LOCKED_DRAW',
  'no member may be removed after the ballot draw');
SELECT test.assert_raises(
  $$ UPDATE committees SET cadence = 'daily' WHERE id = 'KE-2' $$,
  'KAMETI_LOCKED_DRAW',
  'a raw PostgREST write of a locked column is refused after the draw too');

SELECT update_committee('KE-2', '{"name":"Ballot Kameti 2026","emoji":"🎲"}'::jsonb);
SELECT test.assert(
  (SELECT name = 'Ballot Kameti 2026' AND emoji = '🎲' FROM committees WHERE id = 'KE-2'),
  'name and emoji stay editable after the draw');
SELECT test.assert(
  (SELECT draw_seed IS NOT NULL AND draw_scheme = 'sha256-rank-v1'
     FROM committees WHERE id = 'KE-2')
  AND (SELECT count(DISTINCT slot) FROM committee_members WHERE committee_id = 'KE-2') = 3,
  'the draw record and every slot survived those edits untouched');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. The fixed -> ballot switch, in ONE call (a dead end before this file)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method, drawn_at)
VALUES ('KE-3', auth.uid(), 'Switcher', 'PKR', 1000, 3, 'monthly', 3,
        CURRENT_DATE, 'fixed', now());
INSERT INTO committee_members (id, committee_id, user_id, name, slot, is_organizer)
VALUES ('KES-1', 'KE-3', auth.uid(), 'Hina', 1, true),
       ('KES-2', 'KE-3', auth.uid(), 'Imran', 2, false),
       ('KES-3', 'KE-3', auth.uid(), 'Junaid', 3, false);

-- The raw one-shot switch is exactly what audit-p0-kameti-draw refuses, and
-- there was no in-app way to perform the documented remedy.
SELECT test.assert_raises(
  $$ UPDATE committees SET payout_method = 'ballot' WHERE id = 'KE-3' $$,
  'BALLOT_SWITCH_NEEDS_CLEAR_SLOTS',
  'the raw fixed -> ballot switch is still refused by the draw trigger');

SELECT update_committee('KE-3', '{"payoutMethod":"ballot"}'::jsonb);
SELECT test.assert(
  (SELECT payout_method = 'ballot' AND drawn_at IS NULL AND draw_seed IS NULL
     FROM committees WHERE id = 'KE-3')
  AND (SELECT count(*) FROM committee_members
        WHERE committee_id = 'KE-3' AND slot IS NOT NULL) = 0,
  'update_committee performs the documented two-step atomically — slots and drawn_at cleared, still composing with the draw trigger');

SELECT test.assert((perform_committee_draw('KE-3') ->> 'status') = 'ok',
  'the switched kameti can then be drawn for real (the earlier refusal did not brick it)');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Adding is gated on the POOL rule, not on payments existing
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method, drawn_at)
VALUES ('KE-4', auth.uid(), 'Payout Rule', 'PKR', 1000, 3, 'monthly', 3,
        CURRENT_DATE, 'fixed', now());
INSERT INTO committee_members (id, committee_id, user_id, name, slot, is_organizer)
VALUES ('KEP4-1', 'KE-4', auth.uid(), 'Hina', 1, true),
       ('KEP4-2', 'KE-4', auth.uid(), 'Imran', 2, false),
       ('KEP4-3', 'KE-4', auth.uid(), 'Junaid', 3, false);
INSERT INTO committee_payments (id, committee_id, user_id, member_id, round)
VALUES ('KEP4-P1', 'KE-4', auth.uid(), 'KEP4-2', 1);

SELECT add_committee_member('KE-4', 'Naila');
SELECT test.assert(
  (SELECT member_count = 4 AND total_rounds = 4 FROM committees WHERE id = 'KE-4'),
  'a member may still be added mid-collection while nobody has taken their pool (the newcomer simply starts in arrears)');

UPDATE committee_members SET payout_received_at = now() WHERE id = 'KEP4-1';
SELECT test.assert_raises(
  $$ SELECT add_committee_member('KE-4', 'Omar') $$,
  'KAMETI_LOCKED_PAYMENTS',
  'once a payout is confirmed, adding a member is refused — it would raise the pool only for the members not yet paid');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. A cycle that has already run out has no round left to append
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method, drawn_at)
VALUES ('KE-5', auth.uid(), 'Old Kameti', 'PKR', 1000, 2, 'monthly', 2,
        CURRENT_DATE - INTERVAL '3 years', 'fixed', now());
INSERT INTO committee_members (id, committee_id, user_id, name, slot, is_organizer)
VALUES ('KEO-1', 'KE-5', auth.uid(), 'Hina', 1, true),
       ('KEO-2', 'KE-5', auth.uid(), 'Imran', 2, false);

SELECT test.assert_raises(
  $$ SELECT add_committee_member('KE-5', 'Too Late') $$,
  'KAMETI_INVALID_PATCH',
  'a member cannot be appended to a cycle whose next round is already in the past');

-- ── Housekeeping: leave nothing behind for later suites. ───────────────────
DELETE FROM committees WHERE id IN ('KE-1', 'KE-2', 'KE-3', 'KE-4', 'KE-5');
SELECT test.assert(
  (SELECT count(*) FROM committee_members
    WHERE committee_id IN ('KE-1', 'KE-2', 'KE-3', 'KE-4', 'KE-5')) = 0,
  'deleting a kameti still cascades its members — the edit guard never blocks DELETE');
