-- ════════════════════════════════════════════════════════════════════════════
-- 7y · Atomic goal contributions and the whole credit-card story —
--      `contribute_to_goal` and `pay_card_bill`
--      (supabase-migration-p3-atomic-goal-and-card.sql, audit L4 step 4)
--
-- Evidence:
--   07-mobile-first.md MF-01 — money left half-moved server-side on a flaky
--     network; the compensation and the refetch die in the same outage.
--   12-qa-review.md F-2, O-1 / F-4 — "permanent half-applied money … with no
--     repair queue and no persisted marker."
--   00-executive-summary.md M1 / L4 — branches #3 and #5 of the server-side
--     money engine (docs/server-side-money-engine.md §6, §18-22).
--
-- What the legacy client does, and what this file proves is now one commit:
--   goal_contribution  → balance CAS → goals.saved_amount (an ABSOLUTE write,
--                        no lock at all) → stored-in balance CAS →
--                        transactions INSERT
--   card bill payment  → 2 balance CAS → transactions INSERT, then PER advance
--                        a loan CAS + M instalment writes + a ledger row
--   cash-advance repayment → balance CAS → CARD balance CAS → loan CAS →
--                        instalments → row   (the case step 2 deferred)
--
-- Its own user I (99999999-…) so nothing here can disturb the fixtures above,
-- so the account-deletion suite in 50- cannot have removed what it needs, and
-- so 8y-guest-members' `delete_current_user()` (which owns 88888888-…) cannot
-- cascade this suite's accounts, goals and loans away underneath it.
-- Every object id is prefixed `H-`, which no other suite uses.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('7y-atomic-goal-and-card');

-- ── The functions' own shape. Catalog reads, so RESET ROLE deliberately. ────
RESET ROLE;

SELECT test.assert(
  (SELECT bool_and(p.prosecdef)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('contribute_to_goal', 'pay_card_bill')),
  'both functions are SECURITY DEFINER (RLS is not consulted; the user_id predicates are the access control)');

SELECT test.assert(
  (SELECT bool_and('search_path=public' = ANY(p.proconfig))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('contribute_to_goal', 'pay_card_bill')),
  'both functions pin search_path=public');

SELECT test.assert(
  has_function_privilege('authenticated',
    'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)',
    'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)',
    'EXECUTE')
  AND has_function_privilege('authenticated',
    'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)',
    'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)',
    'EXECUTE'),
  'authenticated may execute both; anon may NOT');

-- GoTrue's job in production.
INSERT INTO auth.users (id, email)
VALUES ('99999999-9999-9999-9999-999999999999', 'i@hisaab.test')
ON CONFLICT (id) DO NOTHING;

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

INSERT INTO accounts (id, user_id, name, type, currency, balance, metadata) VALUES
  ('H-bank',  auth.uid(), 'Bank',   'bank',        'AED', 20000,   '{}'),
  ('H-vault', auth.uid(), 'Vault',  'savings',     'AED',     0,   '{}'),
  ('H-cash',  auth.uid(), 'Cash',   'cash',        'AED',   250,   '{}'),
  ('H-pkr',   auth.uid(), 'Meezan', 'bank',        'PKR', 50000,   '{}'),
  ('H-gone',  auth.uid(), 'Closed', 'cash',        'AED',   900,   '{}'),
  ('H-card',  auth.uid(), 'ENBD',   'credit_card', 'AED', 6521.96,
     '{"creditLimit":"16500","dueDay":"15","statementDay":"1"}'),
  ('H-card2', auth.uid(), 'RAK',    'credit_card', 'AED', 3000,
     '{"creditLimit":"5000","dueDay":"20"}');
UPDATE accounts SET deleted_at = now() WHERE id = 'H-gone';

INSERT INTO goals (id, user_id, title, target_amount, saved_amount, currency, stored_in_account_id) VALUES
  ('H-g1', auth.uid(), 'Umrah',   10000, 0, 'AED', ''),
  ('H-g2', auth.uid(), 'Laptop',   5000, 0, 'AED', 'H-vault'),
  ('H-g3', auth.uid(), 'Emergency',9000, 0, 'AED', 'H-bank'),
  ('H-g4', auth.uid(), 'Ghost',    3000, 0, 'AED', 'H-ghost'),
  ('H-g5', auth.uid(), 'Hajj',    50000, 0, 'AED', '');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. GOAL — happy path, tracked internally. One call: debit, goal, row.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h1 AS
  SELECT contribute_to_goal(
    'H-tx1', 'H-g1', 'H-bank', 200, 200, NULL,
    'eid money', 'Savings', '2026-09-02T10:00:00Z'::timestamptz, NULL,
    20000, NULL, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'source_balance')::numeric FROM _h1) = 19800.00
  AND (SELECT (r ->> 'goal_saved_amount')::numeric FROM _h1) = 200.00
  AND (SELECT (r ->> 'goal_applied')::numeric FROM _h1) = 200.00
  AND (SELECT (r ->> 'source_delta')::numeric FROM _h1) = -200.00
  AND NOT (SELECT (r ->> 'self_stored')::boolean FROM _h1),
  'goal contribution: the wallet is debited and the goal grows in ONE call',
  (SELECT r::text FROM _h1));

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 19800.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g1') = 200.00
  AND (SELECT count(*) FROM transactions WHERE id = 'H-tx1') = 1,
  'all three artifacts landed: balance 19800, goal 200, one transactions row');

-- The row, field by field, against transactionsDb.add's payload.
SELECT test.assert(
  (SELECT type = 'goal_contribution' AND amount = 200 AND currency = 'AED'
          AND source_account_id = 'H-bank' AND destination_account_id IS NULL
          AND related_person IS NULL AND person_id IS NULL
          AND related_loan_id IS NULL AND related_goal_id = 'H-g1'
          AND conversion_rate IS NULL
          AND category = 'Savings' AND notes = 'eid money'
          AND created_at = '2026-09-02T10:00:00Z'::timestamptz
          AND is_reconciled = false AND reconciled_at IS NULL
          AND reconciled_by IS NULL AND receipt_path IS NULL
          AND deleted_at IS NULL
     FROM transactions WHERE id = 'H-tx1'),
  'the goal row matches transactionsDb.add: source set, destination NULL, the goal linked, created_at passed through',
  (SELECT row_to_json(t)::text FROM transactions t WHERE id = 'H-tx1'));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. GOAL — stored in ANOTHER account: the credit leg lands, and it is the
--    row's destination. Derived from the GOAL, never from the caller.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h2 AS
  SELECT contribute_to_goal(
    'H-tx2', 'H-g2', 'H-bank', 300, 300, NULL, '', '', now(), 'H-vault',
    19800, 0, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'source_balance')::numeric FROM _h2) = 19500.00
  AND (SELECT (r ->> 'linked_balance')::numeric FROM _h2) = 300.00
  AND (SELECT (r ->> 'linked_account_id') FROM _h2) = 'H-vault'
  AND (SELECT destination_account_id FROM transactions WHERE id = 'H-tx2') = 'H-vault',
  'a goal stored in another account moves BOTH balances in one transaction, and the row carries the destination',
  (SELECT r::text FROM _h2));

-- A caller lying about the linked account cannot redirect the credit: the
-- server derives it from goals.stored_in_account_id and returns what it used.
CREATE TEMP TABLE _h2b AS
  SELECT contribute_to_goal(
    'H-tx2b', 'H-g2', 'H-bank', 100, 100, NULL, '', '', now(), 'H-cash',
    19500, 300, 300, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'linked_account_id') FROM _h2b) = 'H-vault'
  AND (SELECT balance FROM accounts WHERE id = 'H-vault') = 400.00
  AND (SELECT balance FROM accounts WHERE id = 'H-cash') = 250.00,
  'a lying p_linked_account_id is IGNORED — the credit follows the goal, and the named account is untouched');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. GOAL — SELF-STORED: no balance legs at all, and currency-blind.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h3 AS
  SELECT contribute_to_goal(
    'H-tx3', 'H-g3', 'H-bank', 500, 0, NULL,
    '[[HISAAB_META:%7B%22goalSelfStored%22%3A%221%22%7D]]', '', now(), NULL,
    19400, NULL, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'self_stored')::boolean FROM _h3)
  AND (SELECT (r ->> 'source_delta')::numeric FROM _h3) = 0
  AND (SELECT balance FROM accounts WHERE id = 'H-bank') = 19400.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g3') = 500.00
  AND (SELECT destination_account_id FROM transactions WHERE id = 'H-tx3') IS NULL,
  'SELF-STORED: the money physically stays put — saved_amount moves, NO balance leg, destination NULL',
  (SELECT r::text FROM _h3));

SELECT test.assert(
  (SELECT notes LIKE '%goalSelfStored%' FROM transactions WHERE id = 'H-tx3'),
  'the goalSelfStored internal note is stored VERBATIM — the server never synthesises one, so the delete path can skip the refund');

-- Currency-blind: the branch breaks before the cross-currency check, so a rate
-- on this payload means the two halves disagree about which branch this is.
SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad1', 'H-g3', 'H-bank', 100, 100, 3.67,
    '', '', now(), NULL, 19400, NULL, 500, false)
$$, 'CONVERSION_RATE_NOT_APPLICABLE',
  'a conversion rate on a self-stored contribution is refused (it converts nothing)');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. GOAL — the stored-in account that no longer exists. A LABEL, not an FK,
--    so this must contribute WITHOUT a credit leg rather than fail.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h4 AS
  SELECT contribute_to_goal(
    'H-tx4', 'H-g4', 'H-bank', 100, 100, NULL, '', '', now(), NULL,
    19400, NULL, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'linked_account_id') FROM _h4) IS NULL
  AND (SELECT (r ->> 'source_balance')::numeric FROM _h4) = 19300.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g4') = 100.00
  AND (SELECT destination_account_id FROM transactions WHERE id = 'H-tx4') IS NULL,
  'a goal naming an account that no longer exists still contributes — with no credit leg, not an error');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. GOAL — cross-currency DIVIDES (the opposite of the transfer branch).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h5 AS
  SELECT contribute_to_goal(
    'H-tx5', 'H-g5', 'H-pkr', 1000, 13.07, 76.5, '', '', now(), NULL,
    50000, NULL, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'source_balance')::numeric FROM _h5) = 49986.93
  AND (SELECT (r ->> 'goal_saved_amount')::numeric FROM _h5) = 1000.00
  AND (SELECT currency FROM transactions WHERE id = 'H-tx5') = 'AED'
  AND (SELECT conversion_rate FROM transactions WHERE id = 'H-tx5') = 76.5
  AND (SELECT amount FROM transactions WHERE id = 'H-tx5') = 1000,
  'cross-currency: round(1000 / 76.5, 2) = 13.07 leaves the PKR wallet and the AED goal grows by 1000 — a MULTIPLY would have taken 76 500',
  (SELECT r::text FROM _h5));

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad2', 'H-g5', 'H-pkr', 1000, 999, 76.5,
    '', '', now(), NULL, 49986.93, NULL, 1000, false)
$$, 'SOURCE_AMOUNT_MISMATCH',
  'a lying source amount is refused — the server derives its own and will not move money on the caller''s word');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad3', 'H-g5', 'H-pkr', 1000, 13.07, NULL,
    '', '', now(), NULL, 49986.93, NULL, 1000, false)
$$, 'CONVERSION_RATE_REQUIRED',
  'a missing rate on a cross-currency contribution is refused');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad4', 'H-g5', 'H-pkr', 1000, 13.07, 999999,
    '', '', now(), NULL, 49986.93, NULL, 1000, false)
$$, 'INVALID_CONVERSION_RATE',
  'a rate outside conversionMath''s 0.0001..100000 window is refused');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-pkr') = 49986.93
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-bad%') = 0,
  'the four cross-currency refusals wrote NOTHING');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. GOAL — the compare-and-swap goals.saved_amount has never had.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad5', 'H-g1', 'H-bank', 50, 50, NULL,
    '', '', now(), NULL, 19300, NULL, 0, false)
$$, 'BALANCE_CONFLICT',
  'a stale goal expectation raises BALANCE_CONFLICT — the token the client ladder already parses');

SELECT test.assert(
  (SELECT saved_amount FROM goals WHERE id = 'H-g1') = 200.00
  AND (SELECT balance FROM accounts WHERE id = 'H-bank') = 19300.00
  AND (SELECT count(*) FROM transactions WHERE id = 'H-bad5') = 0,
  'the goal conflict moved NOTHING — not the goal, not the account, no row (this is the lost-update bug, closed)');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad6', 'H-g1', 'H-bank', 50, 50, NULL,
    '', '', now(), NULL, 99999, NULL, 200, false)
$$, 'BALANCE_CONFLICT',
  'a stale ACCOUNT expectation raises the same token');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad7', 'H-g1', 'H-bank', 50, 50, NULL,
    '', '', now(), NULL, 19300, NULL, NULL, false)
$$, 'EXPECTED_SAVED_REQUIRED',
  'refusing to guess: no expectation means no compare-and-swap, which would make this a blind write');

-- The client-shaped retry with a fresh expectation then succeeds.
SELECT test.assert_ok($$
  SELECT contribute_to_goal('H-tx6', 'H-g1', 'H-bank', 50, 50, NULL,
    '', '', now(), NULL, 19300, NULL, 200, false)
$$, 'the retry carrying fresh expectations succeeds');

SELECT test.assert(
  (SELECT saved_amount FROM goals WHERE id = 'H-g1') = 250.00
  AND (SELECT balance FROM accounts WHERE id = 'H-bank') = 19250.00,
  'and it moved each side exactly once');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. GOAL — the balance guard, and its escape.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-bad8', 'H-g1', 'H-cash', 10000, 10000, NULL,
    '', '', now(), NULL, 250, NULL, 250, false)
$$, 'INSUFFICIENT_BALANCE',
  'contributing more than the wallet holds is refused — the server half of checkBalance');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-cash') = 250.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g1') = 250.00,
  'the insufficient refusal moved nothing');

SELECT test.assert_ok($$
  SELECT contribute_to_goal('H-tx7', 'H-g1', 'H-cash', 400, 400, NULL,
    '', '', now(), NULL, 250, NULL, 250, true)
$$, 'p_allow_negative is the repair-queue escape (the shipped client always sends false)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-cash') = -150.00,
  'and with it the account goes negative, as the escape intends');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. GOAL — idempotent replay, and the poisoned payloads.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h8 AS
  SELECT contribute_to_goal(
    'H-tx1', 'H-g1', 'H-bank', 200, 200, NULL, '', '', now(), NULL,
    -- deliberately the ORIGINAL, now-stale, expectations
    20000, NULL, 0, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'replay')::boolean FROM _h8)
  AND (SELECT (r ->> 'goal_applied')::numeric FROM _h8) = 0
  AND (SELECT balance FROM accounts WHERE id = 'H-bank') = 19250.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g1') = 650.00
  AND (SELECT count(*) FROM transactions WHERE id = 'H-tx1') = 1,
  'a replay short-circuits BEFORE the compare-and-swaps and moves nothing — even carrying the original stale expectation',
  (SELECT r::text FROM _h8));

SELECT test.assert_ok($$
  SELECT contribute_to_goal('H-tx1', 'H-g1', 'H-bank', 200, 200, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'a replay is a SUCCESS, not an error — the caller retried a call that had already landed');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('', 'H-g1', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'INVALID_TRANSACTION_ID', 'an empty transaction id is refused');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p1', '', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'INVALID_GOAL_ID', 'an empty goal id is refused');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p2', 'H-g1', NULL, 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'ACCOUNT_NOT_FOUND',
  'a NULL account is refused — splits_only has no goals at all, so no ledger row can be written here');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p3', 'H-g1', '   ', 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'ACCOUNT_NOT_FOUND', 'an all-whitespace account id is refused too');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p4', 'H-g1', 'H-gone', 100, 100, NULL,
    '', '', now(), NULL, 900, NULL, 650, false)
$$, 'ACCOUNT_NOT_FOUND', 'a SOFT-DELETED account is refused (the MF-01 mid-flight scenario)');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p5', 'H-nope', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 0, false)
$$, 'GOAL_NOT_FOUND', 'an unknown goal is refused with the goal twin of LOAN_NOT_FOUND');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p6', 'H-g1', 'H-bank', 0, 0, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'INVALID_AMOUNT', 'a zero amount is refused');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p7', 'H-g1', 'H-bank', 'NaN'::numeric, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'INVALID_AMOUNT', 'NaN is a real NUMERIC value in Postgres — and it is refused');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p8', 'H-g1', 'H-bank', 1e13, 1e13, NULL,
    '', '', now(), NULL, 19250, NULL, 650, false)
$$, 'INVALID_AMOUNT', 'an amount past the shared 1e12 ceiling is refused');

-- Another user's goal. Under SECURITY DEFINER, RLS is off — the
-- `user_id = v_uid` predicate IS the access control.
RESET ROLE;
INSERT INTO goals (id, user_id, title, target_amount, saved_amount, currency, stored_in_account_id)
VALUES ('A-goal', '11111111-1111-1111-1111-111111111111', 'Ayesha goal', 1000, 400, 'AED', '')
ON CONFLICT (id) DO NOTHING;
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-p9', 'A-goal', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 19250, NULL, 400, false)
$$, 'GOAL_NOT_FOUND',
  'another user''s goal is refused — the definer predicate is the boundary');

RESET ROLE;
SELECT test.assert(
  (SELECT saved_amount FROM goals WHERE id = 'A-goal') = 400,
  'no saved amount leaked from the other user''s goal');
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 19250.00
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-p%') = 0
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-bad%') = 0,
  'twelve refusals in this section wrote nothing at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. GOAL — MID-TRANSACTION FAILURE. A trigger that raises on the transactions
--    INSERT, i.e. AFTER the goal UPDATE and the balance UPDATE.
--    Under the legacy path both had already committed independently.
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
CREATE OR REPLACE FUNCTION public._h_boom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IN ('H-gboom', 'H-cboom') THEN
    RAISE EXCEPTION 'SIMULATED_WRITE_FAILURE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER _h_boom_trg BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public._h_boom();
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-gboom', 'H-g2', 'H-bank', 250, 250, NULL,
    '', '', now(), 'H-vault', 19250, 400, 400, false)
$$, 'SIMULATED_WRITE_FAILURE',
  'the transactions INSERT fails AFTER the goal, the wallet AND the stored-in account were written');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 19250.00
  AND (SELECT balance FROM accounts WHERE id = 'H-vault') = 400.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g2') = 400.00
  AND (SELECT count(*) FROM transactions WHERE id = 'H-gboom') = 0,
  'ALL FOUR legs rolled back together — no half-applied money. THIS is what the migration exists for');

-- ════════════════════════════════════════════════════════════════════════════
-- 10. CARD — the bill payment. One call: both balances, the advance, its
--     instalment, the transfer row AND the ledger row.
-- ════════════════════════════════════════════════════════════════════════════
-- The RAK/ENBD shape from src/lib/cardStatement.test.ts: limit 16 500,
-- balance 6 521.96 (used 9 978.04), a 13 000 advance with 8 666.68 left over
-- 12 instalments (four already paid), 1 311.36 of revolving purchases behind it.
INSERT INTO loans (id, user_id, person_name, person_id, type, total_amount,
                   remaining_amount, currency, status, notes, created_at) VALUES
  ('H-adv',  auth.uid(), 'ENBD Credit Card', NULL, 'taken', 13000, 8666.68,
   'AED', 'active', '', '2026-05-21T00:00:00Z'),
  ('H-adv2', auth.uid(), 'RAK Credit Card',  NULL, 'taken',  2000, 2000,
   'AED', 'active', '', '2026-06-01T00:00:00Z'),
  ('H-given', auth.uid(), 'Ali', NULL, 'given', 500, 500,
   'AED', 'active', '', '2026-06-02T00:00:00Z');

-- The origin rows: a loan_taken carrying the CARD as its source is what makes
-- a loan a cash advance (findCashAdvanceCardForLoan / the V7 drift watch).
INSERT INTO transactions (id, user_id, type, amount, currency,
                          source_account_id, destination_account_id,
                          related_person, related_loan_id, created_at) VALUES
  ('H-origin1', auth.uid(), 'loan_taken', 13000, 'AED', 'H-card',  'H-bank',
   'ENBD Credit Card', 'H-adv',  '2026-05-21T00:00:00Z'),
  ('H-origin2', auth.uid(), 'loan_taken',  2000, 'AED', 'H-card2', 'H-bank',
   'RAK Credit Card',  'H-adv2', '2026-06-01T00:00:00Z');

INSERT INTO emi_schedules (id, user_id, loan_id, installment_number, due_date, amount, status)
SELECT 'H-e' || n, auth.uid(), 'H-adv', n,
       CASE WHEN n <= 5 THEN '2026-0' || n || '-15' ELSE '2027-0' || (n - 5) || '-15' END,
       CASE WHEN n = 12 THEN 1083.37 ELSE 1083.33 END,
       CASE WHEN n <= 4 THEN 'paid' ELSE 'upcoming' END
  FROM generate_series(1, 12) AS n;

CREATE TEMP TABLE _h10 AS
  SELECT pay_card_bill(
    'H-bill1', 'transfer', 'H-bank', 'H-card',
    2394.69, 2394.69, 2394.69, 'AED', NULL,
    'monthly bill', 'Bills', '2026-09-02T11:00:00Z'::timestamptz,
    '[{"loan_id":"H-adv","applied":1083.33,"expected_remaining":8666.68,
       "emi_ids":["H-e5"],"row_id":"H-ledger1",
       "row_note":"Covered by card bill payment"}]'::jsonb,
    19250, 6521.96, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'source_balance')::numeric FROM _h10) = 16855.31
  AND (SELECT (r ->> 'card_balance')::numeric FROM _h10) = 8916.65
  AND (SELECT (r ->> 'settled')::integer FROM _h10) = 1
  AND (SELECT (r -> 'lines' -> 0 ->> 'remaining')::numeric FROM _h10) = 7583.35
  AND (SELECT (r -> 'lines' -> 0 ->> 'applied')::numeric FROM _h10) = 1083.33,
  'card bill: BOTH balances, the advance and its instalment move in ONE transaction — the flow that used to need up to eight round-trips',
  (SELECT r::text FROM _h10));

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 16855.31
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 8916.65
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv') = 7583.35
  AND (SELECT status FROM emi_schedules WHERE id = 'H-e5') = 'paid'
  AND (SELECT status FROM emi_schedules WHERE id = 'H-e6') = 'upcoming'
  AND (SELECT count(*) FROM transactions WHERE id IN ('H-bill1', 'H-ledger1')) = 2,
  'the statement-native allocation stepped the plan by exactly ONE instalment, and both rows landed');

-- The ledger row, field by field, against the legacy tail's payload.
SELECT test.assert(
  (SELECT type = 'repayment' AND amount = 1083.33 AND currency = 'AED'
          AND source_account_id IS NULL AND destination_account_id IS NULL
          AND related_person = 'ENBD Credit Card' AND person_id IS NULL
          AND related_loan_id = 'H-adv' AND related_goal_id IS NULL
          AND conversion_rate IS NULL AND category = ''
          AND notes = 'Covered by card bill payment'
          AND created_at = '2026-09-02T11:00:00Z'::timestamptz
          AND is_reconciled = false
     FROM transactions WHERE id = 'H-ledger1'),
  'the ledger row carries BOTH account ids NULL and the loan''s own person — exactly what the legacy tail writes, and what a ledger row must look like (tasks/lessons.md:26-27)',
  (SELECT row_to_json(t)::text FROM transactions t WHERE id = 'H-ledger1'));

SELECT test.assert(
  (SELECT type = 'transfer' AND source_account_id = 'H-bank'
          AND destination_account_id = 'H-card'
          AND related_loan_id IS NULL AND related_person IS NULL
          AND notes = 'monthly bill'
     FROM transactions WHERE id = 'H-bill1'),
  'the main row is still an ordinary transfer — the settlement rides beside it, not inside it');

-- ════════════════════════════════════════════════════════════════════════════
-- 11. CARD — the lockstep invariant. Settling more principal than the payment
--     credited would MINT MONEY: `used` drops by X, the loans drop by Y > X.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad1', 'transfer', 'H-bank', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":5000,"expected_remaining":7583.35,
       "emi_ids":[],"row_id":"H-cbadrow1","row_note":""}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'PLAN_OVER_PAYMENT',
  'a plan that settles 5 000 of principal on a 100 payment is refused — this is the money-minting shape');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad2', 'transfer', 'H-bank', 'H-card',
    500, 500, 500, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-given","applied":100,"expected_remaining":500,
       "emi_ids":[],"row_id":"H-cbadrow2","row_note":""}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'PLAN_INVALID',
  'a loan you GAVE cannot be settled by a card bill — a card funds cash advances, and settling a receivable against it is free money');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad3', 'transfer', 'H-bank', 'H-card',
    500, 500, 500, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":100,"expected_remaining":7583.35,
       "emi_ids":["H-e5","H-nope"],"row_id":"H-cbadrow3","row_note":""}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'EMI_SCHEDULE_INVALID',
  'an instalment id that does not belong to this loan is refused BEFORE any write');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad4', 'transfer', 'H-bank', 'H-card',
    500, 500, 500, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":100,"expected_remaining":9999,
       "emi_ids":[],"row_id":"H-cbadrow4","row_note":""}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'LOAN_REMAINING_CONFLICT',
  'a stale loan expectation raises the token apply_loan_remaining_delta already raises');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad5', 'transfer', 'H-bank', 'H-card',
    500, 500, 500, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":100,"expected_remaining":7583.35,
       "emi_ids":[],"row_id":"H-ledger1","row_note":""}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'TRANSACTION_ID_COLLISION',
  'a ledger row id that already exists is refused rather than upserted over (transactionsDb.add would have overwritten it)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 16855.31
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 8916.65
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv') = 7583.35
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-given') = 500
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-cbad%') = 0
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-cbadrow%') = 0,
  'the five plan refusals wrote NOTHING — no balance, no loan, no instalment, no row');

-- ════════════════════════════════════════════════════════════════════════════
-- 12. CARD — MID-TRANSACTION FAILURE, the largest flow in the switch.
--     The trigger raises on the transactions INSERT, i.e. AFTER the loan
--     UPDATE, the instalment UPDATE, the LEDGER row, and both balance UPDATEs.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cboom', 'transfer', 'H-bank', 'H-card',
    1083.33, 1083.33, 1083.33, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":1083.33,"expected_remaining":7583.35,
       "emi_ids":["H-e6"],"row_id":"H-ledgerboom","row_note":"boom"}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'SIMULATED_WRITE_FAILURE',
  'the main INSERT fails after the loan, the instalment, the ledger row and BOTH balances were written');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 16855.31
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 8916.65
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv') = 7583.35
  AND (SELECT status FROM emi_schedules WHERE id = 'H-e6') = 'upcoming'
  AND (SELECT count(*) FROM transactions WHERE id IN ('H-cboom', 'H-ledgerboom')) = 0,
  'ALL SIX legs rolled back together — under the legacy path the bill was paid and the loan had already moved independently');

RESET ROLE;
DROP TRIGGER _h_boom_trg ON public.transactions;
DROP FUNCTION public._h_boom();
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert_ok($$
  SELECT pay_card_bill('H-cboom', 'transfer', 'H-bank', 'H-card',
    1083.33, 1083.33, 1083.33, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":1083.33,"expected_remaining":7583.35,
       "emi_ids":["H-e6"],"row_id":"H-ledgerboom","row_note":"boom"}]'::jsonb,
    16855.31, 8916.65, false)
$$, 'with the trigger removed the identical call commits all six legs');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 15771.98
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 9999.98
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv') = 6500.02
  AND (SELECT status FROM emi_schedules WHERE id = 'H-e6') = 'paid'
  AND (SELECT count(*) FROM transactions WHERE id IN ('H-cboom', 'H-ledgerboom')) = 2,
  'bank 15771.98 / card 9999.98 / loan 6500.02 / instalment paid / two rows — all six, together');

-- ════════════════════════════════════════════════════════════════════════════
-- 13. CARD — the CASH-ADVANCE REPAYMENT that credits the card back. This is
--     the case supabase-migration-p3-atomic-repayment.sql §8.1 deferred,
--     because record_loan_repayment takes exactly ONE account id.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h13 AS
  SELECT pay_card_bill(
    'H-rep1', 'repayment', 'H-bank', 'H-card2',
    400, 400, 400, 'AED', NULL,
    'paying down the advance', '', '2026-09-02T12:00:00Z'::timestamptz,
    '[{"loan_id":"H-adv2","applied":400,"expected_remaining":2000,
       "emi_ids":[],"row_id":null,"row_note":""}]'::jsonb,
    15771.98, 3000, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'source_balance')::numeric FROM _h13) = 15371.98
  AND (SELECT (r ->> 'card_balance')::numeric FROM _h13) = 3400.00
  AND (SELECT (r -> 'lines' -> 0 ->> 'remaining')::numeric FROM _h13) = 1600.00,
  'cash-advance repayment: the wallet is debited, the CARD is credited and the loan reduced in ONE transaction',
  (SELECT r::text FROM _h13));

SELECT test.assert(
  (SELECT type = 'repayment' AND amount = 400 AND currency = 'AED'
          AND source_account_id = 'H-bank' AND destination_account_id = 'H-card2'
          AND related_person = 'RAK Credit Card'
          AND related_loan_id = 'H-adv2' AND related_goal_id IS NULL
          AND conversion_rate IS NULL AND notes = 'paying down the advance'
     FROM transactions WHERE id = 'H-rep1')
  AND (SELECT count(*) FROM transactions
        WHERE related_loan_id = 'H-adv2' AND type = 'repayment') = 1,
  'the MAIN row IS the repayment record — one row, carrying wallet → card and the loan; a second ledger row would double-count the payment');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad6', 'repayment', 'H-bank', 'H-card2',
    400, 400, 400, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv2","applied":400,"expected_remaining":1600,
       "emi_ids":[],"row_id":"H-extra","row_note":""}]'::jsonb,
    15371.98, 3400, false)
$$, 'PLAN_INVALID',
  'a repayment line asking for its OWN ledger row is refused — the main row is already the record');

-- THE CLAMP (src/lib/cardCredit.ts). Headroom is 5000 − 3400 = 1600, so a
-- 2 000 credit is 400 over the limit. (The line's `applied` must equal the row
-- amount — a repayment settles its OWN loan — which is asserted separately
-- above; here it is 2 000 on both sides so the clamp is what fires.)
SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad7', 'repayment', 'H-bank', 'H-card2',
    2000, 2000, 2000, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv2","applied":2000,"expected_remaining":1600,
       "emi_ids":[],"row_id":null,"row_note":""}]'::jsonb,
    15371.98, 3400, false)
$$, 'CARD_CREDIT_OVER_LIMIT',
  'crediting the card past its limit is refused — the Available-27650-over-Limit-16500 bug, closed server-side');

-- The clamped version of the same payment is accepted, and the loan legitimately
-- drops by MORE than the card is credited: the rest of the bill was already
-- paid by a transfer that had already credited the card.
SELECT test.assert_ok($$
  SELECT pay_card_bill('H-rep2', 'repayment', 'H-bank', 'H-card2',
    1600, 1600, 1600, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv2","applied":1600,"expected_remaining":1600,
       "emi_ids":[],"row_id":null,"row_note":""}]'::jsonb,
    15371.98, 3400, false)
$$, 'a credit within the headroom is accepted');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-card2') = 5000.00
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv2') = 0.00
  AND (SELECT status FROM loans WHERE id = 'H-adv2') = 'settled',
  'the loan clamps at 0 and derives status=settled in the SAME statement — byte-for-byte apply_loan_remaining_delta');

-- ════════════════════════════════════════════════════════════════════════════
-- 14. CARD — replay, the ledger guard and the ownership boundary.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _h14 AS
  SELECT pay_card_bill(
    'H-bill1', 'transfer', 'H-bank', 'H-card',
    2394.69, 2394.69, 2394.69, 'AED', NULL, '', '', now(),
    '[{"loan_id":"H-adv","applied":1083.33,"expected_remaining":8666.68,
       "emi_ids":["H-e5"],"row_id":"H-ledgerX","row_note":""}]'::jsonb,
    19250, 6521.96, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'replay')::boolean FROM _h14)
  AND (SELECT (r ->> 'settled')::integer FROM _h14) = 0
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 9999.98
  AND (SELECT remaining_amount FROM loans WHERE id = 'H-adv') = 6500.02
  AND (SELECT count(*) FROM transactions WHERE id = 'H-ledgerX') = 0,
  'a replay short-circuits BEFORE every compare-and-swap: no money moved, no second ledger row, even carrying the original stale plan',
  (SELECT r::text FROM _h14));

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad8', 'transfer', NULL, 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 0, 9999.98, false)
$$, 'ACCOUNT_NOT_FOUND',
  'a NULL source is refused — a ledger repayment (both ids null) can never be routed through this RPC');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad9', 'transfer', 'H-bank', NULL,
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 0, false)
$$, 'ACCOUNT_NOT_FOUND', 'a NULL card is refused too');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad10', 'transfer', 'H-card', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 9999.98, 9999.98, false)
$$, 'SAME_ACCOUNT', 'a card cannot pay its own bill');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad11', 'transfer', 'H-bank', 'H-vault',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 400, false)
$$, 'NOT_A_CREDIT_CARD', 'the destination of a card bill payment must be a credit card');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad12', 'settlement', 'H-bank', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 9999.98, false)
$$, 'INVALID_ROW_TYPE', 'a row type other than transfer/repayment is refused');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad13', 'transfer', 'H-gone', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 900, 9999.98, false)
$$, 'ACCOUNT_NOT_FOUND', 'a SOFT-DELETED source account is refused');

RESET ROLE;
INSERT INTO accounts (id, user_id, name, type, currency, balance)
VALUES ('A-card', '11111111-1111-1111-1111-111111111111', 'Ayesha card',
        'credit_card', 'AED', 5000)
ON CONFLICT (id) DO NOTHING;
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-cbad14', 'transfer', 'H-bank', 'A-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 5000, false)
$$, 'ACCOUNT_NOT_FOUND',
  'another user''s card is refused — the definer predicate is the boundary');

RESET ROLE;
SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'A-card') = 5000,
  'no balance leaked into the other user''s card');
SET ROLE authenticated;
SELECT test.as_user('99999999-9999-9999-9999-999999999999');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank') = 13771.98
  AND (SELECT balance FROM accounts WHERE id = 'H-card') = 9999.98
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'H-cbad%') = 0,
  'the seven guard refusals wrote nothing at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 15. THE DRIFT WATCHES the migration ships (V5/V6/V7/V8) must be clean over
--     everything this suite just wrote.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM transactions t
    WHERE t.type = 'goal_contribution'
      AND t.deleted_at IS NULL
      AND (t.source_account_id IS NULL
           OR t.related_goal_id IS NULL
           OR t.destination_account_id = t.source_account_id)) = 0,
  'V5 goal-leg drift: zero rows — no contribution with a null source, a null goal, or crediting the account it debited');

SELECT test.assert(
  (SELECT count(*) FROM (
     SELECT g.id
       FROM goals g
       LEFT JOIN transactions t ON t.related_goal_id = g.id
                               AND t.type = 'goal_contribution'
                               AND t.deleted_at IS NULL
      WHERE g.user_id = '99999999-9999-9999-9999-999999999999'
      GROUP BY g.id, g.saved_amount
     HAVING abs(g.saved_amount - COALESCE(sum(t.amount), 0)) > 0.01) s) = 0,
  'V6 goal-accounting drift: every goal''s saved_amount equals the contributions recorded against it, to the cent');

SELECT test.assert(
  (SELECT count(*) FROM (
     SELECT a.id
       FROM accounts a
       JOIN transactions t ON t.source_account_id = a.id
                          AND t.type = 'loan_taken' AND t.deleted_at IS NULL
       JOIN loans l ON l.id = t.related_loan_id
                   AND l.deleted_at IS NULL AND l.status = 'active'
      WHERE a.type = 'credit_card' AND a.deleted_at IS NULL
        AND (a.metadata ->> 'creditLimit') ~ '^[0-9]+(\.[0-9]+)?$'
        AND (a.metadata ->> 'creditLimit')::numeric > 0
      GROUP BY a.id, a.metadata, a.balance
     HAVING sum(l.remaining_amount)
            > ((a.metadata ->> 'creditLimit')::numeric - a.balance) + 0.01) s) = 0,
  'V7 the CARD LOCKSTEP INVARIANT: Σ(cash-advance remaining) never exceeds the card''s `used` — the same debt is never counted twice');

SELECT test.assert(
  (SELECT count(*) FROM (
     SELECT t.id
       FROM transactions t
       JOIN transactions r ON r.type = 'repayment' AND r.deleted_at IS NULL
                          AND r.source_account_id IS NULL
                          AND r.destination_account_id IS NULL
                          AND r.notes LIKE '%' || t.id || '%'
      WHERE t.type = 'transfer' AND t.deleted_at IS NULL
      GROUP BY t.id, t.amount, t.conversion_rate
     HAVING round(sum(r.amount), 2)
            > round(t.amount * COALESCE(t.conversion_rate, 1), 2) + 0.01) s) = 0,
  'V8 bill-payment reconcile: no bill payment settles more principal than it paid');

-- Finally: the whole suite as one balance-sheet check.
SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'H-bank')  = 13771.98
  AND (SELECT balance FROM accounts WHERE id = 'H-vault') = 400.00
  AND (SELECT balance FROM accounts WHERE id = 'H-cash')  = -150.00
  AND (SELECT balance FROM accounts WHERE id = 'H-card')  = 9999.98
  AND (SELECT balance FROM accounts WHERE id = 'H-card2') = 5000.00
  AND (SELECT balance FROM accounts WHERE id = 'H-pkr')   = 49986.93
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g1')  = 650.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g2')  = 400.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g3')  = 500.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g4')  = 100.00
  AND (SELECT saved_amount FROM goals WHERE id = 'H-g5')  = 1000.00,
  'closing balances and goal totals match the entries written, to the cent',
  (SELECT string_agg(id || '=' || balance::text, ' ' ORDER BY id)
     FROM accounts WHERE user_id = '99999999-9999-9999-9999-999999999999'));

-- ── anon may not call either at all. ───────────────────────────────────────
RESET ROLE;
SET ROLE anon;
SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-anon', 'H-g1', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 15371.98, NULL, 650, false)
$$, 'permission denied', 'anon cannot execute contribute_to_goal');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-anon2', 'transfer', 'H-bank', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 9999.98, false)
$$, 'permission denied', 'anon cannot execute pay_card_bill');

RESET ROLE;
SET ROLE authenticated;
SELECT test.as_user(NULL::uuid);
SELECT test.assert_raises($$
  SELECT contribute_to_goal('H-nojwt', 'H-g1', 'H-bank', 100, 100, NULL,
    '', '', now(), NULL, 15371.98, NULL, 650, false)
$$, 'NOT_AUTHENTICATED',
  'authenticated with no JWT subject raises NOT_AUTHENTICATED (contribute_to_goal)');

SELECT test.assert_raises($$
  SELECT pay_card_bill('H-nojwt2', 'transfer', 'H-bank', 'H-card',
    100, 100, 100, 'AED', NULL, '', '', now(), '[]'::jsonb, 15371.98, 9999.98, false)
$$, 'NOT_AUTHENTICATED',
  'authenticated with no JWT subject raises NOT_AUTHENTICATED (pay_card_bill)');

RESET ROLE;
