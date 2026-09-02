-- ════════════════════════════════════════════════════════════════════════════
-- 7x · Atomic loan creation — `create_loan_with_leg`
--      (supabase-migration-p3-atomic-loan-create.sql, audit L4 step 3)
--
-- Evidence:
--   07-mobile-first.md MF-01 — money left half-moved server-side on a flaky
--     network; the compensation and the refetch die in the same outage.
--   12-qa-review.md O-1 / F-4 — "permanent half-applied money … with no repair
--     queue and no persisted marker."
--   00-executive-summary.md M1 / L4 — branch #4 of the server-side money
--     engine (docs/server-side-money-engine.md §6, §13).
--
-- What the legacy client does, and what this file proves is now one commit:
--   loan_given  → balance CAS → loans INSERT → transactions INSERT
--   loan_taken  → [card CAS] → balance CAS → loans INSERT → transactions INSERT
-- A drop after leg 1 leaves a lighter wallet with NO loan saying who owes the
-- money and NO row saying it happened; the cash-advance case additionally
-- consumes card credit for cash that arrived nowhere.
--
-- Its own user G (77777777-…) so nothing here can disturb the fixtures above,
-- and so the account-deletion suite in 50- cannot have removed the accounts
-- this file needs.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('7x-atomic-loan-create');

-- ── The function's own shape. Catalog reads, so RESET ROLE deliberately. ────
RESET ROLE;

SELECT test.assert(
  (SELECT p.prosecdef
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_loan_with_leg'),
  'create_loan_with_leg is SECURITY DEFINER (RLS is not consulted; the user_id predicates are the access control)');

SELECT test.assert(
  (SELECT 'search_path=public' = ANY(p.proconfig)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_loan_with_leg'),
  'create_loan_with_leg pins search_path=public');

SELECT test.assert(
  has_function_privilege('authenticated',
    'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)',
    'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)',
    'EXECUTE'),
  'authenticated may execute it; anon may NOT');

-- GoTrue's job in production.
INSERT INTO auth.users (id, email)
VALUES ('77777777-7777-7777-7777-777777777777', 'g@hisaab.test')
ON CONFLICT (id) DO NOTHING;

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('77777777-7777-7777-7777-777777777777');

INSERT INTO accounts (id, user_id, name, type, currency, balance) VALUES
  ('G-bank', auth.uid(), 'Bank',  'bank',        'AED', 1000),
  ('G-cash', auth.uid(), 'Cash',  'cash',        'AED',  250),
  ('G-card', auth.uid(), 'ENBD',  'credit_card', 'AED', 16500),
  ('G-pkr',  auth.uid(), 'Meezan','bank',        'PKR', 50000),
  ('G-gone', auth.uid(), 'Closed','cash',        'AED', 900);
UPDATE accounts SET deleted_at = now() WHERE id = 'G-gone';

-- ════════════════════════════════════════════════════════════════════════════
-- 1. HAPPY PATH — loan GIVEN. One call: debit, loan, row.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _g1 AS
  SELECT create_loan_with_leg(
    'G-tx1', 'G-loan1', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 250, 'AED', NULL,
    'for the deposit', 'Loans', '2026-09-02T10:00:00Z'::timestamptz,
    'for the deposit', '2026-09-02T10:00:00Z'::timestamptz, NULL,
    1000, NULL, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'account_balance')::numeric FROM _g1) = 750.00
  AND (SELECT (r ->> 'loan_created')::boolean FROM _g1)
  AND (SELECT (r ->> 'account_delta')::numeric FROM _g1) = -250.00,
  'loan GIVEN: the funding account is debited and the loan is created in one call',
  (SELECT r::text FROM _g1));

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 750.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan1') = 1
  AND (SELECT count(*) FROM transactions WHERE id = 'G-tx1') = 1,
  'all three artifacts landed: balance 750, one loans row, one transactions row');

-- The loans row, field by field, against loansDb.add's payload.
SELECT test.assert(
  (SELECT person_name = 'Ali' AND person_id IS NULL AND type = 'given'
          AND total_amount = 250 AND remaining_amount = 250
          AND currency = 'AED' AND status = 'active'
          AND notes = 'for the deposit' AND deleted_at IS NULL
     FROM loans WHERE id = 'G-loan1'),
  'the loans row matches loansDb.add byte for byte (remaining = total, status active, visible note only)',
  (SELECT row_to_json(l)::text FROM loans l WHERE id = 'G-loan1'));

-- The transactions row, field by field, against transactionsDb.add's payload.
SELECT test.assert(
  (SELECT type = 'loan_given' AND amount = 250 AND currency = 'AED'
          AND source_account_id = 'G-bank' AND destination_account_id IS NULL
          AND related_person = 'Ali' AND person_id IS NULL
          AND related_loan_id = 'G-loan1' AND related_goal_id IS NULL
          AND conversion_rate IS NULL
          AND category = 'Loans' AND notes = 'for the deposit'
          AND created_at = '2026-09-02T10:00:00Z'::timestamptz
          AND is_reconciled = false AND reconciled_at IS NULL
          AND reconciled_by IS NULL AND receipt_path IS NULL
          AND deleted_at IS NULL
     FROM transactions WHERE id = 'G-tx1'),
  'the transactions row matches transactionsDb.add: source set, destination NULL, no rate, created_at passed through',
  (SELECT row_to_json(t)::text FROM transactions t WHERE id = 'G-tx1'));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. HAPPY PATH — loan TAKEN. The direction inverts; so does the row.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _g2 AS
  SELECT create_loan_with_leg(
    'G-tx2', 'G-loan2', true, 'taken', 'Sara', NULL,
    'G-bank', NULL, 500, NULL, NULL,
    '', '', now(), '', now(), NULL,
    750, NULL, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'account_balance')::numeric FROM _g2) = 1250.00
  AND (SELECT (r ->> 'account_delta')::numeric FROM _g2) = 500.00,
  'loan TAKEN: the receiving account is CREDITED — direction is derived from p_type, never a caller flag',
  (SELECT r::text FROM _g2));

SELECT test.assert(
  (SELECT source_account_id IS NULL AND destination_account_id = 'G-bank'
          AND type = 'loan_taken'
     FROM transactions WHERE id = 'G-tx2'),
  'a loan you TOOK carries destination_account_id and a NULL source');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. CASH ADVANCE — the four-leg case, in one commit.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _g3 AS
  SELECT create_loan_with_leg(
    'G-tx3', 'G-loan3', true, 'taken', 'ENBD Credit Card', NULL,
    'G-bank', 'G-card', 1500, 'AED', NULL,
    '', '', now(), '', now(), NULL,
    1250, 16500, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'account_balance')::numeric FROM _g3) = 2750.00
  AND (SELECT (r ->> 'card_balance')::numeric FROM _g3) = 15000.00
  AND (SELECT (r ->> 'card_delta')::numeric FROM _g3) = -1500.00,
  'cash advance: the card is charged AND the receiver credited in ONE transaction (the worst MF-01 shape)',
  (SELECT r::text FROM _g3));

SELECT test.assert(
  (SELECT source_account_id = 'G-card' AND destination_account_id = 'G-bank'
     FROM transactions WHERE id = 'G-tx3'),
  'the cash-advance row reads card → receiver, which is what findCashAdvanceCardForLoan looks for');

-- The card guards. Both refuse BEFORE any write.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-bad1', 'G-badloan1', true, 'taken', 'X', NULL,
    'G-bank', 'G-cash', 100, NULL, NULL, '', '', now(), '', now(), NULL,
    2750, 250, false)
$$, 'INVALID_CASH_ADVANCE',
  'a non-card cash-advance source is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-bad2', 'G-badloan2', true, 'taken', 'X', NULL,
    'G-pkr', 'G-card', 100, NULL, NULL, '', '', now(), '', now(), NULL,
    50000, 16500, false)
$$, 'INVALID_CASH_ADVANCE',
  'a cash-advance card in another currency than the receiver is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-bad3', 'G-badloan3', true, 'given', 'X', NULL,
    'G-bank', 'G-card', 100, NULL, NULL, '', '', now(), '', now(), NULL,
    2750, 16500, false)
$$, 'INVALID_CASH_ADVANCE',
  'a cash-advance card on a loan you GIVE is refused (the branch has no such path)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 2750.00
  AND (SELECT balance FROM accounts WHERE id = 'G-card') = 15000.00
  AND (SELECT balance FROM accounts WHERE id = 'G-pkr') = 50000.00
  AND (SELECT count(*) FROM loans WHERE id LIKE 'G-badloan%') = 0
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'G-bad%') = 0,
  'the three cash-advance refusals wrote NOTHING — no balance, no loan, no row');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. THE CROSS-CURRENCY QUESTION — structurally absent, and refused.
--    Unlike a repayment, a CREATED loan takes its currency FROM the account
--    (transactionStore.ts:1540, :1571), so there is no second currency.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-bad4', 'G-badloan4', true, 'given', 'X', NULL,
    'G-pkr', NULL, 100, NULL, 76.5, '', '', now(), '', now(), NULL,
    50000, NULL, false)
$$, 'CONVERSION_RATE_NOT_APPLICABLE',
  'a conversion rate on a loan CREATION is refused — there is nothing to convert');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-bad5', 'G-badloan5', true, 'given', 'X', NULL,
    'G-pkr', NULL, 100, 'AED', NULL, '', '', now(), '', now(), NULL,
    50000, NULL, false)
$$, 'CURRENCY_MISMATCH',
  'a currency that disagrees with the funding account is refused (the server takes it from the account)');

-- A PKR loan from a PKR account is fine, and the loan is PKR — proof the
-- currency really is derived, not defaulted.
SELECT test.assert_ok($$
  SELECT create_loan_with_leg('G-tx4', 'G-loan4', true, 'given', 'Nadia', NULL,
    'G-pkr', NULL, 5000, 'PKR', NULL, '', '', now(), '', now(), NULL,
    50000, NULL, false)
$$, 'a PKR account funds a PKR loan');

SELECT test.assert(
  (SELECT currency FROM loans WHERE id = 'G-loan4') = 'PKR'
  AND (SELECT currency FROM transactions WHERE id = 'G-tx4') = 'PKR'
  AND (SELECT balance FROM accounts WHERE id = 'G-pkr') = 45000.00,
  'the loan and the row both take the ACCOUNT''s currency');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. COMPARE-AND-SWAP — a stale expectation writes nothing at all.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx5', 'G-loan5', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    999, NULL, false)
$$, 'BALANCE_CONFLICT',
  'a stale expected balance raises BALANCE_CONFLICT (the same token the client ladder already parses)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 2750.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan5') = 0
  AND (SELECT count(*) FROM transactions WHERE id = 'G-tx5') = 0,
  'the conflict left NO orphan loan — which is what makes the client''s retry safe');

-- The card side has its own CAS, and it fires before anything moves.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx6', 'G-loan6', true, 'taken', 'ENBD', NULL,
    'G-bank', 'G-card', 100, NULL, NULL, '', '', now(), '', now(), NULL,
    2750, 99999, false)
$$, 'BALANCE_CONFLICT',
  'a stale CARD expectation raises BALANCE_CONFLICT too');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 2750.00
  AND (SELECT balance FROM accounts WHERE id = 'G-card') = 15000.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan6') = 0,
  'neither account moved and no loan exists — the two legs cannot half-apply');

-- Missing expectation: refuse rather than write blind.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx7', 'G-loan7', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    NULL, NULL, false)
$$, 'EXPECTED_BALANCE_REQUIRED',
  'no expected balance = no compare-and-swap = refused, never a blind write');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. INSUFFICIENT BALANCE — the first server-side creation guard, and its
--    splits_only escape.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx8', 'G-loan8', true, 'given', 'Ali', NULL,
    'G-cash', NULL, 10000, NULL, NULL, '', '', now(), '', now(), NULL,
    250, NULL, false)
$$, 'INSUFFICIENT_BALANCE',
  'lending 10 000 from a 250 account is refused server-side (CLAUDE.md: the UI guard used to be the ONLY protection)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-cash') = 250.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan8') = 0,
  'the refused loan moved nothing and created nothing');

-- p_allow_negative is the splits_only bypass (isSimpleModeBalanceBypassAllowed
-- lists loan_given and loan_taken), and only that.
SELECT test.assert_ok($$
  SELECT create_loan_with_leg('G-tx9', 'G-loan9', true, 'given', 'Ali', NULL,
    'G-cash', NULL, 400, NULL, NULL, '', '', now(), '', now(), NULL,
    250, NULL, true)
$$, 'p_allow_negative lets a splits_only user push the account negative');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-cash') = -150.00,
  'the account went to −150.00, exactly as ledger mode allows today');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. THE EMI PLAN — inserted when sound, and refused with ZERO writes when not.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _g10 AS
  SELECT create_loan_with_leg(
    'G-tx10', 'G-loan10', true, 'taken', 'Bilal', NULL,
    'G-bank', NULL, 1200, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-e1","installment_number":1,"due_date":"2026-10-01","amount":300},
      {"id":"G-e2","installment_number":2,"due_date":"2026-11-01","amount":300},
      {"id":"G-e3","installment_number":3,"due_date":"2026-12-01","amount":300},
      {"id":"G-e4","installment_number":4,"due_date":"2027-01-01","amount":300}]'::jsonb,
    2750, NULL, false) AS r;

SELECT test.assert(
  (SELECT count(*) FROM emi_schedules WHERE loan_id = 'G-loan10') = 4
  AND (SELECT count(*) FROM emi_schedules WHERE loan_id = 'G-loan10' AND status <> 'upcoming') = 0
  AND (SELECT sum(amount) FROM emi_schedules WHERE loan_id = 'G-loan10') = 1200,
  'a sound schedule is inserted in the SAME transaction: 4 upcoming instalments summing to the loan',
  (SELECT r::text FROM _g10));

SELECT test.assert(
  (SELECT jsonb_array_length(r -> 'emi_inserted') FROM _g10) = 4,
  'the reply lists the instalments it inserted');

-- The sum rule — the EMI twin of M12's "0.01 charged, 50 000 attributed".
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx11', 'G-loan11', true, 'taken', 'Bilal', NULL,
    'G-bank', NULL, 1200, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-x1","installment_number":1,"due_date":"2026-10-01","amount":300},
      {"id":"G-x2","installment_number":2,"due_date":"2026-11-01","amount":300}]'::jsonb,
    3950, NULL, false)
$$, 'EMI_PLAN_MISMATCH',
  'a schedule that does not add up to its loan is REFUSED');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 3950.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan11') = 0
  AND (SELECT count(*) FROM transactions WHERE id = 'G-tx11') = 0
  AND (SELECT count(*) FROM emi_schedules WHERE id IN ('G-x1','G-x2')) = 0,
  'the EMI refusal wrote ZERO of the four artifacts — no balance, no loan, no row, no instalments');

-- A one-cent remainder is inside the documented tolerance and must be accepted:
-- emiStore.generateSchedule's last instalment absorbs the rounding tail.
SELECT test.assert_ok($$
  SELECT create_loan_with_leg('G-tx12', 'G-loan12', true, 'taken', 'Bilal', NULL,
    'G-bank', NULL, 1000, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-y1","installment_number":1,"due_date":"2026-10-01","amount":333.33},
      {"id":"G-y2","installment_number":2,"due_date":"2026-11-01","amount":333.33},
      {"id":"G-y3","installment_number":3,"due_date":"2026-12-01","amount":333.34}]'::jsonb,
    3950, NULL, false)
$$, 'the 2dp rounding tail of an unevenly divisible loan is accepted');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx13', 'G-loan13', true, 'taken', 'Bilal', NULL,
    'G-bank', NULL, 600, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-z1","installment_number":1,"due_date":"2026-10-01","amount":300},
      {"id":"G-z2","installment_number":7,"due_date":"2026-11-01","amount":300}]'::jsonb,
    4950, NULL, false)
$$, 'EMI_PLAN_INVALID',
  'instalments numbered other than 1..N are refused (the oldest-first coverage walk assumes it)');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx14', 'G-loan14', true, 'taken', 'Bilal', NULL,
    'G-bank', NULL, 600, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-e1","installment_number":1,"due_date":"2026-10-01","amount":300},
      {"id":"G-w2","installment_number":2,"due_date":"2026-11-01","amount":300}]'::jsonb,
    4950, NULL, false)
$$, 'EMI_ID_COLLISION',
  'an instalment id that already exists is refused (G-e1 belongs to G-loan10)');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. IDEMPOTENT REPLAY — "the call committed but the reply never arrived".
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _replay AS
  SELECT create_loan_with_leg(
    'G-tx1', 'G-loan1', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 250, 'AED', NULL,
    'for the deposit', 'Loans', '2026-09-02T10:00:00Z'::timestamptz,
    'for the deposit', '2026-09-02T10:00:00Z'::timestamptz, NULL,
    1000, NULL, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'replay')::boolean FROM _replay)
  AND (SELECT (r ->> 'loan_created')::boolean FROM _replay) = false
  AND (SELECT r ->> 'loan_id' FROM _replay) = 'G-loan1',
  'replaying the same p_transaction_id short-circuits — even carrying the ORIGINAL stale expectation',
  (SELECT r::text FROM _replay));

SELECT test.assert(
  (SELECT count(*) FROM transactions WHERE id = 'G-tx1') = 1
  AND (SELECT count(*) FROM loans WHERE id = 'G-loan1') = 1
  AND (SELECT total_amount FROM loans WHERE id = 'G-loan1') = 250,
  'the money moved once: one row, one loan, unchanged');

-- The loan id is a SECOND idempotency guard: loansDb.add is an UPSERT, so the
-- legacy path would silently overwrite a live loan on a uuid repeat.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx15', 'G-loan1', true, 'given', 'Someone Else', NULL,
    'G-bank', NULL, 99, NULL, NULL, '', '', now(), '', now(), NULL,
    4950, NULL, false)
$$, 'LOAN_ID_COLLISION',
  'creating a loan over an id that already exists is REFUSED, not upserted');

SELECT test.assert(
  (SELECT person_name = 'Ali' AND total_amount = 250 FROM loans WHERE id = 'G-loan1'),
  'the live loan was not overwritten');

-- Attaching to an existing loan writes the row without creating a second loan.
SELECT test.assert_ok($$
  SELECT create_loan_with_leg('G-tx16', 'G-loan1', false, 'given', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    4950, NULL, false)
$$, 'a second entry can ATTACH to an existing loan (the ad-hoc-split shape)');

SELECT test.assert(
  (SELECT count(*) FROM loans WHERE id = 'G-loan1') = 1
  AND (SELECT related_loan_id FROM transactions WHERE id = 'G-tx16') = 'G-loan1'
  AND (SELECT balance FROM accounts WHERE id = 'G-bank') = 4850.00,
  'attaching created no second loan and still moved the money');

-- Direction/currency of an attached loan is cross-checked, so a curl cannot
-- turn a debit into a credit by lying about p_type.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx17', 'G-loan1', false, 'taken', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    4850, NULL, false)
$$, 'LOAN_MISMATCH',
  'attaching a TAKEN entry to a GIVEN loan is refused (a flipped direction is a free credit)');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. MID-TRANSACTION FAILURE — the proof. A trigger that raises on the
--    transactions INSERT, i.e. AFTER the loan INSERT and BOTH balance UPDATEs.
--    Under the legacy path the card charge and the wallet credit had already
--    committed independently by this point.
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
CREATE OR REPLACE FUNCTION public._g_boom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = 'G-boom' THEN
    RAISE EXCEPTION 'SIMULATED_WRITE_FAILURE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER _g_boom_trg BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public._g_boom();
SET ROLE authenticated;
SELECT test.as_user('77777777-7777-7777-7777-777777777777');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-boom', 'G-loanboom', true, 'taken', 'ENBD', NULL,
    'G-bank', 'G-card', 500, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-b1","installment_number":1,"due_date":"2026-10-01","amount":500}]'::jsonb,
    4850, 15000, false)
$$, 'SIMULATED_WRITE_FAILURE',
  'the transactions INSERT fails AFTER the loan, both balances and the instalment were written');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 4850.00
  AND (SELECT balance FROM accounts WHERE id = 'G-card') = 15000.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loanboom') = 0
  AND (SELECT count(*) FROM emi_schedules WHERE id = 'G-b1') = 0
  AND (SELECT count(*) FROM transactions WHERE id = 'G-boom') = 0,
  'ALL FIVE legs rolled back together — no half-applied money. THIS is what the migration exists for');

RESET ROLE;
DROP TRIGGER _g_boom_trg ON public.transactions;
DROP FUNCTION public._g_boom();
SET ROLE authenticated;
SELECT test.as_user('77777777-7777-7777-7777-777777777777');

-- The same call, trigger gone, lands everything.
SELECT test.assert_ok($$
  SELECT create_loan_with_leg('G-boom', 'G-loanboom', true, 'taken', 'ENBD', NULL,
    'G-bank', 'G-card', 500, NULL, NULL, '', '', now(), '', now(),
    '[{"id":"G-b1","installment_number":1,"due_date":"2026-10-01","amount":500}]'::jsonb,
    4850, 15000, false)
$$, 'with the trigger removed the identical call commits all five legs');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 5350.00
  AND (SELECT balance FROM accounts WHERE id = 'G-card') = 14500.00
  AND (SELECT count(*) FROM loans WHERE id = 'G-loanboom') = 1
  AND (SELECT count(*) FROM emi_schedules WHERE id = 'G-b1') = 1
  AND (SELECT count(*) FROM transactions WHERE id = 'G-boom') = 1,
  'balance 5350 / card 14500 / loan / instalment / row — all five, together');

-- ════════════════════════════════════════════════════════════════════════════
-- 10. THE LEDGER GUARD (tasks/lessons.md:26-27) and the ownership boundary.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx18', 'G-loan18', true, 'given', 'Ali', NULL,
    NULL, NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    0, NULL, false)
$$, 'ACCOUNT_NOT_FOUND',
  'a NULL account is refused — a splits_only loan can never be written here (it uses loanStore.createLoan)');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx19', 'G-loan19', true, 'given', 'Ali', NULL,
    '   ', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    0, NULL, false)
$$, 'ACCOUNT_NOT_FOUND',
  'an all-whitespace account id is refused too');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx20', 'G-loan20', true, 'given', 'Ali', NULL,
    'G-gone', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    900, NULL, false)
$$, 'ACCOUNT_NOT_FOUND',
  'a SOFT-DELETED account is refused (the MF-01 mid-flight scenario)');

-- Another user's account. Under SECURITY DEFINER, RLS is off — the
-- `user_id = v_uid` predicate IS the access control.
RESET ROLE;
INSERT INTO accounts (id, user_id, name, type, currency, balance)
VALUES ('A-wallet', '11111111-1111-1111-1111-111111111111', 'Ayesha wallet',
        'cash', 'AED', 9999)
ON CONFLICT (id) DO NOTHING;
SET ROLE authenticated;
SELECT test.as_user('77777777-7777-7777-7777-777777777777');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-tx21', 'G-loan21', true, 'given', 'Ali', NULL,
    'A-wallet', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    9999, NULL, false)
$$, 'ACCOUNT_NOT_FOUND',
  'another user''s account id is refused — the definer predicate is the boundary');

RESET ROLE;
SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'A-wallet') = 9999,
  'no balance leaked from the other user''s account');
SET ROLE authenticated;
SELECT test.as_user('77777777-7777-7777-7777-777777777777');

-- Poisoned payloads: seven named refusals, zero writes.
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('', 'G-p1', true, 'given', 'Ali', NULL, 'G-bank',
    NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_TRANSACTION_ID', 'an empty transaction id is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p2', '', true, 'given', 'Ali', NULL, 'G-bank',
    NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_LOAN_ID', 'an empty loan id is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p3', 'G-p3l', true, 'lent', 'Ali', NULL, 'G-bank',
    NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_LOAN_TYPE', 'a direction other than given/taken is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p4', 'G-p4l', true, 'given', '  ', NULL, 'G-bank',
    NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_PERSON', 'a nameless counterparty is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p5', 'G-p5l', true, 'given', 'Ali', NULL, 'G-bank',
    NULL, 0, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_AMOUNT', 'a zero amount is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p6', 'G-p6l', true, 'given', 'Ali', NULL, 'G-bank',
    NULL, 'NaN'::numeric, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_AMOUNT', 'NaN is a real NUMERIC value in Postgres — and it is refused');

SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-p7', 'G-p7l', true, 'given', 'Ali', NULL, 'G-bank',
    NULL, 1e13, NULL, NULL, '', '', now(), '', now(), NULL, 5350, NULL, false)
$$, 'INVALID_AMOUNT', 'an amount past the shared 1e12 ceiling is refused');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank') = 5350.00
  AND (SELECT count(*) FROM loans WHERE id LIKE 'G-p%') = 0
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'G-p%') = 0
  AND (SELECT count(*) FROM loans WHERE id IN ('G-loan18','G-loan19','G-loan20','G-loan21')) = 0,
  'eleven refusals in this section wrote nothing at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 11. THE DRIFT WATCHES the migration ships (V5/V6/V7) must be clean over
--     everything this suite just wrote.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM transactions t
     LEFT JOIN accounts sa ON sa.id = t.source_account_id
    WHERE t.type IN ('loan_given','loan_taken')
      AND t.deleted_at IS NULL
      AND (
        (t.type = 'loan_given' AND (t.source_account_id IS NULL
                                    OR t.destination_account_id IS NOT NULL))
        OR (t.type = 'loan_taken' AND (t.destination_account_id IS NULL
                                       OR (t.source_account_id IS NOT NULL
                                           AND COALESCE(sa.type,'') <> 'credit_card')))
      )) = 0,
  'V5 direction drift: zero rows');

SELECT test.assert(
  (SELECT count(*) FROM transactions t
     LEFT JOIN accounts sa ON sa.id = t.source_account_id
     LEFT JOIN accounts da ON da.id = t.destination_account_id
    WHERE t.type IN ('loan_given','loan_taken')
      AND t.deleted_at IS NULL
      AND (t.conversion_rate IS NOT NULL
           OR (sa.id IS NOT NULL AND sa.currency <> t.currency)
           OR (da.id IS NOT NULL AND da.currency <> t.currency))) = 0,
  'V6 currency drift: zero rows — no loan-creation row carries a rate or a foreign-currency leg');

SELECT test.assert(
  (SELECT count(*) FROM (
     SELECT l.id
       FROM loans l JOIN emi_schedules e ON e.loan_id = l.id
      WHERE l.deleted_at IS NULL
      GROUP BY l.id, l.total_amount
     HAVING abs(COALESCE(sum(e.amount),0) - l.total_amount) > 0.01) s) = 0,
  'V7 schedule drift: zero loans whose instalments do not add up to them');

-- Finally: the whole suite as one balance-sheet check. Every AED account this
-- file touched, against the entries it wrote.
SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'G-bank')  = 5350.00
  AND (SELECT balance FROM accounts WHERE id = 'G-card') = 14500.00
  AND (SELECT balance FROM accounts WHERE id = 'G-cash') = -150.00
  AND (SELECT balance FROM accounts WHERE id = 'G-pkr')  = 45000.00,
  'closing balances match the entries written, to the cent',
  (SELECT string_agg(id || '=' || balance::text, ' ' ORDER BY id)
     FROM accounts WHERE user_id = '77777777-7777-7777-7777-777777777777'));

-- ── anon may not call it at all. ───────────────────────────────────────────
RESET ROLE;
SET ROLE anon;
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-anon', 'G-anonl', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    5350, NULL, false)
$$, 'permission denied',
  'anon cannot execute create_loan_with_leg');

RESET ROLE;
SET ROLE authenticated;
SELECT test.as_user(NULL::uuid);
SELECT test.assert_raises($$
  SELECT create_loan_with_leg('G-nojwt', 'G-nojwtl', true, 'given', 'Ali', NULL,
    'G-bank', NULL, 100, NULL, NULL, '', '', now(), '', now(), NULL,
    5350, NULL, false)
$$, 'NOT_AUTHENTICATED',
  'authenticated with no JWT subject raises NOT_AUTHENTICATED');

RESET ROLE;
