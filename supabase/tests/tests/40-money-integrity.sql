-- ════════════════════════════════════════════════════════════════════════════
-- 40 · Money integrity — the server of last resort
--
-- Evidence:
--   05-security.md M12 / 12-qa-review.md V-1 — no server-side bounds on money.
--     {amount: 0.01, splits:[{memberId: victim, amount: 50000}]} was insertable
--     into a shared group ledger, and in splits_only (ledger-only) mode that
--     row IS the entire money record.
--   05-security.md C9 — the currency CHECK listed AED/PKR only; 6 of the 8
--     shipped currencies errored out.
--   12-qa-review.md F-2 — loan repayment had no compare-and-set, so two devices
--     could both write the same remaining amount.
--   12-qa-review.md F-7 — record_group_settlement had no server cap, so a
--     member could "settle" more than they owed and invert the balance.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('40-money-integrity');

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- ── SPLIT-SUM TRIGGER (M12) ───────────────────────────────────────────────
-- The exact poisoned row from the finding: a trivial amount, a huge share.
SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  SELECT 'E-poison', auth.uid(), 'G1', 'poison', 0.01, 'M-A',
         jsonb_build_array(jsonb_build_object(
           'memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
           'amount', 50000))
$$, 'GROUP_SPLITS_DO_NOT_SUM',
  'splits that do not sum to the amount are refused (M12)');

SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-neg', auth.uid(), 'G1', 'negative share', 10, 'M-A',
          '[{"memberId":"M-A","amount":-5},{"memberId":"M-A","amount":15}]'::jsonb)
$$, 'INVALID_GROUP_SPLIT_AMOUNT',
  'a negative split share is refused');

SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-str', auth.uid(), 'G1', 'stringly typed', 10, 'M-A',
          '[{"memberId":"M-A","amount":"10"}]'::jsonb)
$$, 'INVALID_GROUP_SPLIT_AMOUNT',
  'a split share sent as a JSON string is refused');

SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-empty', auth.uid(), 'G1', 'no splits', 10, 'M-A', '[]'::jsonb)
$$, 'INVALID_GROUP_SPLITS',
  'an expense with zero splits is refused');

SELECT test.assert_raises($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  VALUES ('E-foreign', auth.uid(), 'G1', 'cross-group id', 10, 'M-A',
          '[{"memberId":"M-NOT-IN-THIS-GROUP","amount":10}]'::jsonb)
$$, 'INACTIVE_GROUP_MEMBER',
  'a split naming a member of another group is refused');

-- A one-cent rounding remainder is inside the documented tolerance — the server
-- must never reject a row the client's allocator considered valid.
SELECT test.assert_ok($$
  INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                              paid_by, splits)
  SELECT 'E-round', auth.uid(), 'G1', 'rounded', 10.00, 'M-A',
         jsonb_build_array(
           jsonb_build_object('memberId', 'M-A', 'amount', 5.00),
           jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k='M-B'),
                              'amount', 4.99))
$$, 'a 0.01 rounding remainder is accepted (client allocator tolerance)');

SELECT test.assert_raises($$
  UPDATE group_expenses SET amount = 999, version = version + 1
   WHERE id = 'E-round'
$$, 'GROUP_SPLITS_DO_NOT_SUM',
  'changing only the amount desyncs the splits and is refused');

-- ── CURRENCY WHITELIST (C9) ───────────────────────────────────────────────
-- src/db/types.ts SUPPORTED_CURRENCIES = AED PKR PHP SAR QAR OMR KWD BHD.
-- BHD is the sentinel: it is one of the eight and was NOT in the pre-fix list.
SELECT test.assert_ok($$
  INSERT INTO split_groups (id, user_id, name, currency)
  VALUES ('G-bhd', auth.uid(), 'Bahrain', 'BHD')
$$, 'BHD is accepted — the constraint was widened past AED/PKR (C9)');

SELECT test.assert_raises($$
  INSERT INTO split_groups (id, user_id, name, currency)
  VALUES ('G-xxx', auth.uid(), 'Nowhere', 'XXX')
$$, 'currency',
  'an unlisted currency (XXX) is still refused');

SELECT test.assert_raises($$
  INSERT INTO loans (id, user_id, person_name, type, total_amount,
                     remaining_amount, currency)
  VALUES ('L-xxx', auth.uid(), 'Nobody', 'lent', 10, 10, 'USD')
$$, 'currency',
  'USD is refused — it is not one of the eight shipped currencies');

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM pg_constraint
    WHERE contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%''AED''%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%''BHD''%') = 0,
  'no currency CHECK anywhere still lists AED without BHD (C9 closed)',
  COALESCE((SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
              FROM pg_constraint
             WHERE contype='c' AND pg_get_constraintdef(oid) ILIKE '%''AED''%'
               AND pg_get_constraintdef(oid) NOT ILIKE '%''BHD''%'), '(none)'));
SET ROLE authenticated;

-- ── LOAN COMPARE-AND-SET (F-2) ────────────────────────────────────────────
INSERT INTO loans (id, user_id, person_name, type, total_amount,
                   remaining_amount, currency)
VALUES ('L-1', auth.uid(), 'Bilal', 'lent', 2000, 2000, 'AED');

SELECT test.assert(
  apply_loan_remaining_delta('L-1', -500, 2000) = 1500.00,
  'apply_loan_remaining_delta(-500, expected 2000) → 1500.00');

-- The second device replays the stale expected value. Under the pre-fix
-- read-modify-write both repayments would have landed on the same base.
SELECT test.assert_raises(
  $$ SELECT apply_loan_remaining_delta('L-1', -500, 2000) $$,
  'LOAN_REMAINING_CONFLICT',
  'replaying a stale expected_remaining raises LOAN_REMAINING_CONFLICT (F-2)');

SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = 'L-1') = 1500.00,
  'the loan is still 1500.00 — the conflicting write changed nothing');

SELECT test.assert_raises(
  $$ SELECT apply_loan_remaining_delta('L-nope', -1, 0) $$,
  'LOAN_NOT_FOUND',
  'apply_loan_remaining_delta on an unknown loan raises LOAN_NOT_FOUND');

-- ── SETTLEMENT CAP (F-7) ──────────────────────────────────────────────────
-- After E1 (60.00 paid by A, split A/B 30/30) plus E-round (10.00 paid by A,
-- split 5.00 / 4.99), B owes A 34.99. The cap is derived server-side.
SELECT test.as_user('22222222-2222-2222-2222-222222222222');

CREATE TEMP TABLE _cap AS
  SELECT group_settlement_cap('G1', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                              'M-A') AS c;
SELECT test.assert((SELECT c FROM _cap) > 0,
  'group_settlement_cap derives a positive outstanding balance for B → A',
  'cap = ' || (SELECT c::text FROM _cap));

-- Over the cap through the RPC: refused AS DATA, so the client can show a
-- reason instead of a 500.
CREATE TEMP TABLE _over AS
  SELECT record_group_settlement('S-over', 'G1',
           (SELECT v FROM test.fixture WHERE k = 'M-B'), 'M-A', 5000) AS r;
SELECT test.assert((SELECT (r ->> 'success')::boolean FROM _over) = false,
  'an over-cap record_group_settlement is refused as data, not an exception',
  (SELECT r::text FROM _over));
SELECT test.assert((SELECT r ->> 'reason_code' FROM _over) = 'EXCEEDS_OUTSTANDING',
  'the refusal carries reason_code = EXCEEDS_OUTSTANDING (F-7)',
  (SELECT r::text FROM _over));
SELECT test.assert((SELECT count(*) FROM group_settlements WHERE id = 'S-over') = 0,
  'the refused settlement inserted nothing');

-- The raw PostgREST-shaped INSERT that bypasses the RPC hits the trigger.
SELECT test.assert_raises($$
  INSERT INTO group_settlements (id, user_id, group_id, from_member, to_member,
                                 amount, created_by)
  SELECT 'S-raw', auth.uid(), 'G1',
         (SELECT v FROM test.fixture WHERE k = 'M-B'), 'M-A', 5000, auth.uid()
$$, 'SETTLEMENT_EXCEEDS_OUTSTANDING',
  'a raw over-cap settlement INSERT is blocked by the cap trigger');

SELECT test.assert_raises($$
  INSERT INTO group_settlements (id, user_id, group_id, from_member, to_member,
                                 amount, created_by)
  SELECT 'S-zero', auth.uid(), 'G1',
         (SELECT v FROM test.fixture WHERE k = 'M-B'), 'M-A', 0, auth.uid()
$$, 'INVALID_SETTLEMENT_AMOUNT',
  'a zero-amount settlement is refused');

-- The honest settlement, exactly at the cap, goes through.
CREATE TEMP TABLE _ok AS
  SELECT record_group_settlement('S-ok', 'G1',
           (SELECT v FROM test.fixture WHERE k = 'M-B'), 'M-A',
           (SELECT c FROM _cap)) AS r;
SELECT test.assert((SELECT (r ->> 'success')::boolean FROM _ok),
  'a settlement exactly at the cap is recorded',
  (SELECT r::text FROM _ok));

SELECT test.assert(
  group_settlement_cap('G1', (SELECT v FROM test.fixture WHERE k = 'M-B'), 'M-A') = 0,
  'the cap drops to zero once the balance is settled');
