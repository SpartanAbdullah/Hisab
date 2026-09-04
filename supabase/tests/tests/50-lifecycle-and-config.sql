-- ════════════════════════════════════════════════════════════════════════════
-- 50 · Destructive lifecycle + remote config
--
-- Runs LAST because it deletes accounts and groups. It uses the throwaway
-- users E and F so nothing above can be disturbed.
--
-- Evidence:
--   05-security.md C10 / M10 — the kameti draw was a client-side ballot: the
--     organiser device generated the seed and wrote the slots, so it could
--     re-roll until it liked the order.
--   05-security.md L13 — splitStore.deleteGroup hard-deleted a shared group,
--     taking every other member's expenses with it.
--   05-security.md C2  — account deletion cascaded through shared ledgers.
--   07-mobile-first.md MF-12 — no minimum-version kill switch; the config row
--     has to be readable BEFORE login, i.e. by anon.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('50-lifecycle-and-config');

-- ── app_config: readable by anon, writable by nobody (MF-12) ───────────────
SET ROLE anon;
SELECT test.as_user(NULL::uuid);
SELECT test.assert((SELECT count(*) FROM app_config WHERE id = 'default') = 1,
  'anon can SELECT the app_config kill-switch row BEFORE login (MF-12)');

SELECT test.assert_zero_rows(
  $$ UPDATE app_config SET min_supported_version = '99.0.0' WHERE id = 'default' $$,
  'anon cannot UPDATE app_config');
-- Refused at the GRANT layer, before RLS is even consulted: p1-app-config
-- grants anon SELECT only.
SELECT test.assert_raises(
  $$ INSERT INTO app_config (id) VALUES ('rogue') $$,
  'permission denied',
  'anon cannot INSERT into app_config');

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert((SELECT count(*) FROM app_config) = 1,
  'an authenticated client can read app_config too');
SELECT test.assert_zero_rows(
  $$ UPDATE app_config SET min_supported_version_code = 9999 $$,
  'an authenticated client cannot UPDATE app_config (service-role only)');

RESET ROLE;
SELECT test.assert(
  (SELECT min_supported_version FROM app_config WHERE id = 'default') <> '99.0.0',
  'app_config is unchanged after both write attempts');
SET ROLE authenticated;

-- ── KAMETI: the draw is server-only and once-only (C10 / M10) ─────────────
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method)
VALUES ('K-1', auth.uid(), 'Office Kameti', 'PKR', 5000, 3, 'monthly', 3,
        CURRENT_DATE, 'ballot');
INSERT INTO committee_members (id, committee_id, user_id, name, is_organizer)
VALUES ('KM-1', 'K-1', auth.uid(), 'Erum', true),
       ('KM-2', 'K-1', auth.uid(), 'Faisal', false),
       ('KM-3', 'K-1', auth.uid(), 'Ghazala', false);

-- The organiser's device may never supply the seed: a client that could choose
-- it would brute-force one matching a hand-picked order (~N! hashes) and every
-- verification would still pass.
SELECT test.assert_raises(
  $$ UPDATE committees SET draw_seed = 'deadbeef' WHERE id = 'K-1' $$,
  'DRAW_FIELDS_ARE_SERVER_ONLY',
  'hand-writing committees.draw_seed is refused (M10)');
SELECT test.assert_raises(
  $$ UPDATE committees SET draw_commitment = 'cafe' WHERE id = 'K-1' $$,
  'DRAW_FIELDS_ARE_SERVER_ONLY',
  'hand-writing committees.draw_commitment is refused');
SELECT test.assert_raises($$
  INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                          member_count, cadence, total_rounds, start_date,
                          draw_seed)
  VALUES ('K-seeded', auth.uid(), 'Pre-seeded', 'PKR', 1, 2, 'monthly', 2,
          CURRENT_DATE, 'deadbeef')
$$, 'DRAW_FIELDS_ARE_SERVER_ONLY',
  'INSERTing a committee that already carries a seed is refused');

CREATE TEMP TABLE _draw AS SELECT perform_committee_draw('K-1') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _draw) = 'ok',
  'perform_committee_draw() succeeds for the organiser',
  (SELECT r::text FROM _draw));
SELECT test.assert((SELECT r ->> 'drawScheme' FROM _draw) = 'sha256-rank-v1',
  'the draw records its scheme (sha256-rank-v1)');

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM committee_members
    WHERE committee_id = 'K-1' AND slot IS NOT NULL) = 3
  AND (SELECT count(DISTINCT slot) FROM committee_members
        WHERE committee_id = 'K-1') = 3,
  'all three members got a distinct server-assigned slot');
SELECT test.assert(
  (SELECT draw_seed IS NOT NULL AND draw_commitment IS NOT NULL
     FROM committees WHERE id = 'K-1'),
  'the draw stored a server seed and its commitment');
SET ROLE authenticated;

-- THE finding: no re-rolling.
SELECT test.assert_raises(
  $$ SELECT perform_committee_draw('K-1') $$,
  'ALREADY_DRAWN',
  'a second perform_committee_draw() raises ALREADY_DRAWN (M10)');

-- Post-draw the whole outcome is frozen.
-- `slot + 10` rather than a literal: the draw assigns slots at random, so a
-- literal could coincide with the slot the member already holds, and the guard
-- (correctly) only fires on an actual change.
SELECT test.assert_raises(
  $$ UPDATE committee_members SET slot = slot + 10 WHERE id = 'KM-3' $$,
  'DRAW_LOCKED',
  'a slot cannot be rewritten after the draw');
SELECT test.assert_raises(
  $$ UPDATE committees SET drawn_at = now() WHERE id = 'K-1' $$,
  'DRAW_LOCKED',
  'drawn_at cannot be re-dated after the draw');
SELECT test.assert_raises(
  $$ UPDATE committees SET payout_method = 'fixed' WHERE id = 'K-1' $$,
  'DRAW_LOCKED',
  'payout_method cannot be flipped to escape the slot lock');
SELECT test.assert_raises($$
  INSERT INTO committee_members (id, committee_id, user_id, name)
  VALUES ('KM-4', 'K-1', auth.uid(), 'Latecomer')
$$, 'DRAW_LOCKED',
  'a member cannot be added after the draw');

-- A non-organiser cannot draw someone else's kameti.
SELECT test.as_user('66666666-6666-6666-6666-666666666666');
SELECT test.assert_raises(
  $$ SELECT perform_committee_draw('K-1') $$,
  'NOT_ORGANISER',
  'a non-organiser cannot call perform_committee_draw()');

-- ── THE NEVER-DRAW PATH (was GAP(kameti-draw), closed) ────────────────────
-- Every guard above keys off `committees.draw_seed IS NOT NULL`. That left
-- BEFORE the draw completely unlocked, so an organiser could hand-write the
-- slots of a payout_method='ballot' kameti and simply never call
-- perform_committee_draw() — which then refused FOREVER (its guard tripped on
-- `v_slotted > 0`), leaving a "ballot" with a hand-picked order, no seed and no
-- commitment. M10's abuse via the "never draw" path rather than the "re-roll"
-- path. Hand-stamping drawn_at did the same.
--
-- kameti-draw.sql now gates those pre-draw writes on payout_method, as a state
-- invariant: on a ballot kameti, drawn_at and every slot are NULL unless
-- draw_seed is non-null, and draw_seed is server-only. These assertions used to
-- be the two named GAP(kameti-draw); they now pin the refusals.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                        member_count, cadence, total_rounds, start_date,
                        payout_method)
VALUES ('K-2', auth.uid(), 'Undrawn Ballot', 'PKR', 100, 2, 'monthly', 2,
        CURRENT_DATE, 'ballot');
INSERT INTO committee_members (id, committee_id, user_id, name, is_organizer)
VALUES ('KN-1', 'K-2', auth.uid(), 'One', true),
       ('KN-2', 'K-2', auth.uid(), 'Two', false);

SELECT test.assert_raises(
  $$ UPDATE committee_members SET slot = 1 WHERE id = 'KN-1' $$,
  'BALLOT_SLOTS_SERVER_ONLY',
  'a PRE-draw slot write on a BALLOT kameti is refused (never-draw path)');
SELECT test.assert_raises($$
  INSERT INTO committee_members (id, committee_id, user_id, name, slot)
  VALUES ('KN-3', 'K-2', auth.uid(), 'Three', 1)
$$, 'BALLOT_SLOTS_SERVER_ONLY',
  'INSERTing a ballot member that already carries a slot is refused');
SELECT test.assert_raises(
  $$ UPDATE committees SET drawn_at = now() WHERE id = 'K-2' $$,
  'BALLOT_DRAW_SERVER_ONLY',
  'hand-stamping drawn_at on an UNDRAWN ballot kameti is refused');
SELECT test.assert_raises($$
  INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                          member_count, cadence, total_rounds, start_date,
                          payout_method, drawn_at)
  VALUES ('K-born-drawn', auth.uid(), 'Born drawn', 'PKR', 1, 2, 'monthly', 2,
          CURRENT_DATE, 'ballot', now())
$$, 'BALLOT_DRAW_SERVER_ONLY',
  'INSERTing a ballot kameti that is already "drawn" is refused');

RESET ROLE;  -- read past RLS to prove nothing landed
SELECT test.assert(
  (SELECT count(*) FROM committee_members
    WHERE committee_id = 'K-2' AND slot IS NOT NULL) = 0
  AND (SELECT drawn_at IS NULL FROM committees WHERE id = 'K-2'),
  'the refused rig left K-2 with no slots and no drawn_at');
SET ROLE authenticated;

-- The point of the fix: a refused rig must not brick the real draw. Before, the
-- hand-written slot made this call fail with ALREADY_DRAWN forever.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
CREATE TEMP TABLE _draw2 AS SELECT perform_committee_draw('K-2') AS r;
SELECT test.assert((SELECT r ->> 'status' FROM _draw2) = 'ok',
  'the real draw still succeeds after the rig was refused',
  (SELECT r::text FROM _draw2));

RESET ROLE;
SELECT test.assert(
  (SELECT count(DISTINCT slot) FROM committee_members
    WHERE committee_id = 'K-2' AND slot IS NOT NULL) = 2,
  'the server assigned both K-2 slots itself');
SET ROLE authenticated;

-- ── payout_method='fixed' is the column default and MUST stay writable ────
-- Manual slots are that mode's entire feature; the fix gates on payout_method
-- precisely so this path is untouched.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
SELECT test.assert_ok($$
  INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                          member_count, cadence, total_rounds, start_date,
                          payout_method, drawn_at)
  VALUES ('K-3', auth.uid(), 'Fixed Order', 'PKR', 100, 2, 'monthly', 2,
          CURRENT_DATE, 'fixed', now())
$$, 'a FIXED kameti may be created already carrying drawn_at');
SELECT test.assert_ok($$
  INSERT INTO committee_members (id, committee_id, user_id, name, slot)
  VALUES ('KF-1', 'K-3', auth.uid(), 'First', 1),
         ('KF-2', 'K-3', auth.uid(), 'Second', 2)
$$, 'a FIXED kameti may be created with hand-picked slots');
SELECT test.assert_ok(
  $$ UPDATE committee_members SET slot = 2 WHERE id = 'KF-1' $$,
  'slots on a FIXED kameti stay editable (the organiser chooses the order)');
-- The seal columns are still server-only in fixed mode.
SELECT test.assert_raises(
  $$ UPDATE committees SET draw_seed = 'deadbeef' WHERE id = 'K-3' $$,
  'DRAW_FIELDS_ARE_SERVER_ONLY',
  'the seed is server-only in FIXED mode too');
-- …and a hand-picked order cannot be relabelled as a ballot.
SELECT test.assert_raises(
  $$ UPDATE committees SET payout_method = 'ballot' WHERE id = 'K-3' $$,
  'BALLOT_SWITCH_NEEDS_CLEAR_SLOTS',
  'flipping a slotted FIXED kameti to ballot is refused (laundering route)');
-- The documented remedy: clear the slots, then switch with drawn_at cleared.
UPDATE committee_members SET slot = NULL WHERE committee_id = 'K-3';
SELECT test.assert_raises(
  $$ UPDATE committees SET payout_method = 'ballot' WHERE id = 'K-3' $$,
  'BALLOT_DRAW_SERVER_ONLY',
  'the switch still needs drawn_at cleared — a ballot is drawn only by the server');
SELECT test.assert_ok(
  $$ UPDATE committees SET payout_method = 'ballot', drawn_at = NULL WHERE id = 'K-3' $$,
  'clearing the slots AND drawn_at is the sanctioned fixed -> ballot switch');
SELECT test.assert((SELECT (perform_committee_draw('K-3') ->> 'status')) = 'ok',
  'the switched kameti can then be drawn for real');

-- The RPC's v_slotted guard is now unreachable for ballot, but survives as
-- defence-in-depth for a slotted FIXED kameti, with its own code.
SELECT test.assert_ok($$
  INSERT INTO committees (id, user_id, name, currency, contribution_amount,
                          member_count, cadence, total_rounds, start_date,
                          payout_method)
  VALUES ('K-4', auth.uid(), 'Slotted Fixed', 'PKR', 100, 2, 'monthly', 2,
          CURRENT_DATE, 'fixed')
$$, 'a second FIXED kameti for the defence-in-depth check');
INSERT INTO committee_members (id, committee_id, user_id, name, slot)
VALUES ('KG-1', 'K-4', auth.uid(), 'First', 1),
       ('KG-2', 'K-4', auth.uid(), 'Second', 2);
SELECT test.assert_raises(
  $$ SELECT perform_committee_draw('K-4') $$,
  'SLOTS_ALREADY_SET',
  'drawing a slotted FIXED kameti is refused with SLOTS_ALREADY_SET, not ALREADY_DRAWN');

-- ── GROUP DELETE GUARD (L13) ─────────────────────────────────────────────
-- A owns G1, which still has connected members.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_raises(
  $$ DELETE FROM split_groups WHERE id = 'G1' $$,
  'GROUP_HAS_OTHER_MEMBERS',
  'hard-deleting a SHARED group is refused (L13)');

RESET ROLE;
SELECT test.assert((SELECT count(*) FROM group_expenses WHERE id = 'E1') = 1,
  'the other members'' expenses survived the delete attempt');
SET ROLE authenticated;

-- Archive is the supported verb, and it freezes writes.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
CREATE TEMP TABLE _arch AS SELECT archive_group('G1') AS r;
SELECT test.assert((SELECT r ->> 'success' FROM _arch)::boolean,
  'archive_group() is the supported alternative',
  (SELECT r::text FROM _arch));
SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-archived', auth.uid(), 'G1', 'after archive', 10, 'M-A',
          '[{"memberId":"M-A","amount":10}]'::jsonb)
$$, 'GROUP_ARCHIVED',
  'writes into an archived group are refused');
SELECT test.assert((unarchive_group('G1') ->> 'success')::boolean,
  'unarchive_group() restores it');

-- archived_at is RPC-only, not a client column.
SELECT test.assert_raises(
  $$ UPDATE split_groups SET archived_at = now() WHERE id = 'G1' $$,
  'GROUP_ARCHIVE_RPC_ONLY',
  'setting split_groups.archived_at directly is refused');

-- A solo group is still deletable — the guard is about other people's money.
SELECT test.assert_ok($$
  INSERT INTO split_groups (id, user_id, name, currency)
  VALUES ('G-solo', auth.uid(), 'Just me', 'AED')
$$, 'a solo group can be created');
SELECT test.assert_ok($$ DELETE FROM split_groups WHERE id = 'G-solo' $$,
  'a SOLO group can still be hard-deleted');

-- ── ACCOUNT DELETION (C2) ────────────────────────────────────────────────
-- Build G2: E owns it, F joins by code, E posts an expense, F settles.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
INSERT INTO split_groups (id, user_id, name, currency, join_code,
                          join_code_normalized, created_by)
VALUES ('G2', auth.uid(), 'Flatmates', 'AED', 'GRP-XYZ789', 'XYZ789', auth.uid());
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, joined_at)
VALUES ('M-E', 'G2', auth.uid(), 'Erum', 'owner', 'connected', auth.uid(), now());

SELECT test.as_user('66666666-6666-6666-6666-666666666666');
SELECT test.assert((join_group_by_code('XYZ789', 'Faisal') ->> 'status') = 'ok',
  'F joins G2');

RESET ROLE;
INSERT INTO test.fixture (k, v)
SELECT 'M-F', id FROM group_members
 WHERE group_id = 'G2' AND profile_id = '66666666-6666-6666-6666-666666666666'
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
SET ROLE authenticated;

SELECT test.as_user('55555555-5555-5555-5555-555555555555');
INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, splits, created_by)
SELECT 'E2', auth.uid(), 'G2', 'Rent', 40.00, 'M-E',
       jsonb_build_array(
         jsonb_build_object('memberId', 'M-E', 'amount', 20.00),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k='M-F'),
                            'amount', 20.00)),
       auth.uid();

-- F owes E 20.00 and E is still connected → deletion is refused, and the
-- DETAIL names the group and the amount (founder decision D1, 2026-09-04;
-- supabase-migration-p3-account-deletion-balance-gate.sql). Same rule as
-- leave_group's OUTSTANDING_PAYABLE.
SELECT test.as_user('66666666-6666-6666-6666-666666666666');
SELECT test.assert_raises($$ SELECT delete_current_user() $$,
  'UNSETTLED_GROUP_BALANCES',
  'a member who still OWES in a shared group cannot delete their account (D1)');
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM auth.users
    WHERE id = '66666666-6666-6666-6666-666666666666') = 1
  AND (SELECT status FROM group_members
        WHERE id = (SELECT v FROM test.fixture WHERE k = 'M-F')) = 'connected',
  'the balance-gated refusal left the account and the membership intact');
SET ROLE authenticated;
SELECT test.as_user('66666666-6666-6666-6666-666666666666');
DO $$
DECLARE v_detail TEXT;
BEGIN
  PERFORM delete_current_user();
  PERFORM test.assert(false, 'D1 refusal carries a DETAIL naming group and amount');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  PERFORM test.assert(v_detail = 'Flatmates: owes AED 20.00',
    'D1 refusal carries a DETAIL naming group and amount', 'detail: ' || COALESCE(v_detail, '<null>'));
END $$;

-- E is OWED 20.00 — the creditor side is gated too, and the owner guard wins
-- the ordering (E also owns G2), so E sees OWNED_GROUPS_WITH_MEMBERS, not the
-- balance marker. Asserted explicitly so the guard order is pinned.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
SELECT test.assert_raises($$ SELECT delete_current_user() $$,
  'OWNED_GROUPS_WITH_MEMBERS',
  'owner guard is evaluated before the balance guard (D1 ordering)');

SELECT test.as_user('66666666-6666-6666-6666-666666666666');
SELECT test.assert(
  (record_group_settlement('S2', 'G2',
     (SELECT v FROM test.fixture WHERE k = 'M-F'), 'M-E', 20.00)
   ->> 'success')::boolean,
  'F settles their 20.00 share in G2');
-- group_member_net_balance is a definer helper, not a client RPC: the grants
-- sweep (92-function-grants) revokes it from authenticated, so read it as owner.
RESET ROLE;
SELECT test.assert(
  abs(group_member_net_balance('G2', (SELECT v FROM test.fixture WHERE k = 'M-F'))) <= 0.01,
  'after settling, F is square in G2 — the gate must now let F go');
SET ROLE authenticated;

-- E owns a group that still has another connected member → refused.
SELECT test.as_user('55555555-5555-5555-5555-555555555555');
SELECT test.assert_raises($$ SELECT delete_current_user() $$,
  'OWNED_GROUPS_WITH_MEMBERS',
  'an owner of a shared group cannot delete their account (C2)');

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM auth.users
    WHERE id = '55555555-5555-5555-5555-555555555555') = 1,
  'the refused deletion left the account intact');
SET ROLE authenticated;

-- F is only a member, so F can go.
SELECT test.as_user('66666666-6666-6666-6666-666666666666');
SELECT test.assert_ok($$ SELECT delete_current_user() $$,
  'a plain member CAN delete their account');

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM auth.users
    WHERE id = '66666666-6666-6666-6666-666666666666') = 0,
  'the auth identity is gone');
SELECT test.assert(
  (SELECT count(*) FROM group_settlements WHERE id = 'S2' AND deleted_at IS NULL) = 1,
  'the deleted user''s settlement row SURVIVES for the remaining member (C2)');
SELECT test.assert(
  (SELECT user_id IS NULL FROM group_settlements WHERE id = 'S2'),
  'the surviving settlement is anonymized (user_id SET NULL, not cascaded)');
SELECT test.assert(
  (SELECT count(*) FROM group_expenses WHERE id = 'E2') = 1
  AND (SELECT user_id FROM group_expenses WHERE id = 'E2')
      = '55555555-5555-5555-5555-555555555555',
  'the other member''s expense is untouched');
SELECT test.assert(
  (SELECT count(*) FROM group_events
    WHERE group_id = 'G2' AND event_type = 'member_account_deleted') = 1,
  'a member_account_deleted group_event was emitted');
SELECT test.assert(
  (SELECT status = 'left' AND profile_id IS NULL FROM group_members
    WHERE id = (SELECT v FROM test.fixture WHERE k = 'M-F')),
  'the departed membership row is soft-deactivated and unclaimable');
