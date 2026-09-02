-- ════════════════════════════════════════════════════════════════════════════
-- 7z · The last two shapes — `record_single_leg_entry`,
--      `record_investment_trade` and `apply_goal_saved_delta`
--      (supabase-migration-p3-atomic-investments-and-single-leg.sql, L4 step 5)
--
-- Evidence:
--   07-mobile-first.md MF-01 — money left half-moved server-side on a flaky
--     network; the compensation and the refetch die in the same outage.
--   12-qa-review.md O-1 / F-4 — "permanent half-applied money … with no repair
--     queue and no persisted marker."
--   00-executive-summary.md M1 / L4 — the two rows §22 of
--     docs/server-side-money-engine.md left uncovered, plus §23 item 6.
--
-- What the legacy client does, and what this file proves is now one commit:
--   income/expense/          → balance CAS → transactions INSERT
--   opening_balance/adjustment  (a changed balance with NO row saying why)
--   investment_buy/sell/     → balance CAS → investment_trades INSERT →
--   dividend                    transactions INSERT
--                               (a wallet that moved and NO TRADE — and since
--                                positions are REPLAYED from the trade ledger,
--                                a lost trade is a lost position)
--   goal compensation        → goalsDb.update, an unlocked read-modify-write
--
-- Its own user J (aaaaaaaa-…) and its own `J-` object-id prefix, which no other
-- suite uses — so nothing here can disturb the fixtures above, 50-'s account
-- deletion cannot remove what it needs, and 8y-guest-members'
-- delete_current_user() (which owns 88888888-…) cannot cascade this suite's
-- rows away underneath it. User K (bbbbbbbb-…) exists only to be the OTHER
-- user whose rows must stay invisible.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('7z-atomic-investments-single-leg');

-- ── The functions' own shape. Catalog reads, so RESET ROLE deliberately. ────
RESET ROLE;

SELECT test.assert(
  (SELECT bool_and(p.prosecdef)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('record_single_leg_entry', 'record_investment_trade',
                        'apply_goal_saved_delta')),
  'all three functions are SECURITY DEFINER (RLS is not consulted; the user_id predicates are the access control)');

SELECT test.assert(
  (SELECT count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('record_single_leg_entry', 'record_investment_trade',
                        'apply_goal_saved_delta')
      AND 'search_path=public' = ANY(p.proconfig)),
  'all three functions pin search_path=public');

SELECT test.assert(
  has_function_privilege('authenticated',
    'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)', 'EXECUTE')
  AND has_function_privilege('authenticated',
    'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)', 'EXECUTE')
  AND has_function_privilege('authenticated',
    'public.apply_goal_saved_delta(text,numeric,numeric)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.apply_goal_saved_delta(text,numeric,numeric)', 'EXECUTE'),
  'authenticated may execute all three; anon may NOT');

-- GoTrue's job in production.
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'j@hisaab.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'k@hisaab.test')
ON CONFLICT (id) DO NOTHING;

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

INSERT INTO accounts (id, user_id, name, type, currency, balance, metadata) VALUES
  ('J-bank',  auth.uid(), 'Bank',   'bank',        'AED',  5000, '{}'),
  ('J-cash',  auth.uid(), 'Cash',   'cash',        'AED',   250, '{}'),
  ('J-empty', auth.uid(), 'Jar',    'cash',        'AED',     0, '{}'),
  ('J-pkr',   auth.uid(), 'Meezan', 'bank',        'PKR', 50000, '{}'),
  ('J-gone',  auth.uid(), 'Closed', 'cash',        'AED',   900, '{}'),
  ('J-card',  auth.uid(), 'ENBD',   'credit_card', 'AED',  6000,
     '{"creditLimit":"16500","dueDay":"15","statementDay":"1"}');
UPDATE accounts SET deleted_at = now() WHERE id = 'J-gone';

INSERT INTO investment_markets (id, user_id, name, currency) VALUES
  ('J-m1', auth.uid(), 'DFM (7z)', 'AED'),
  ('J-m2', auth.uid(), 'PSX (7z)', 'PKR');

INSERT INTO goals (id, user_id, title, target_amount, saved_amount, currency, stored_in_account_id)
VALUES ('J-g1', auth.uid(), 'Umrah (7z)', 10000, 500, 'AED', '');

-- The other user, whose rows must never be reachable.
SELECT test.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
INSERT INTO accounts (id, user_id, name, type, currency, balance, metadata)
VALUES ('K-bank', auth.uid(), 'Their Bank', 'bank', 'AED', 99999, '{}');
INSERT INTO investment_markets (id, user_id, name, currency)
VALUES ('K-m1', auth.uid(), 'Their Market (7z)', 'AED');
INSERT INTO goals (id, user_id, title, target_amount, saved_amount, currency, stored_in_account_id)
VALUES ('K-g1', auth.uid(), 'Their Goal (7z)', 1000, 100, 'AED', '');
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. SINGLE LEG — an expense. One call: the debit AND the row.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _j1 AS
  SELECT record_single_leg_entry(
    'J-tx1', 'expense', 'J-bank', 100, NULL,
    'chai', 'Food', '2026-09-02T10:00:00Z'::timestamptz, 5000, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'account_balance')::numeric FROM _j1) = 4900.00
  AND (SELECT (r ->> 'account_delta')::numeric FROM _j1) = -100.00
  AND (SELECT (r ->> 'amount')::numeric FROM _j1) = 100.00
  AND (SELECT (r ->> 'currency') FROM _j1) = 'AED'
  AND NOT (SELECT (r ->> 'replay')::boolean FROM _j1)
  AND (SELECT balance FROM accounts WHERE id = 'J-bank') = 4900.00,
  'expense: the balance moves and the row lands in ONE call',
  (SELECT r::text FROM _j1));

-- The row, field by field, against transactionsDb.add's payload.
SELECT test.assert(
  (SELECT type = 'expense' AND amount = 100 AND currency = 'AED'
          AND source_account_id = 'J-bank' AND destination_account_id IS NULL
          AND related_person IS NULL AND person_id IS NULL
          AND related_loan_id IS NULL AND related_goal_id IS NULL
          AND related_investment_id IS NULL
          AND conversion_rate IS NULL
          AND category = 'Food' AND notes = 'chai'
          AND created_at = '2026-09-02T10:00:00Z'::timestamptz
          AND is_reconciled = false AND reconciled_at IS NULL
          AND reconciled_by IS NULL AND receipt_path IS NULL
          AND deleted_at IS NULL
     FROM transactions WHERE id = 'J-tx1'),
  'the expense row matches transactionsDb.add: source set, destination NULL, no rate, created_at passed through',
  (SELECT row_to_json(t)::text FROM transactions t WHERE id = 'J-tx1'));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. SINGLE LEG — income and opening_balance CREDIT, and are never guarded.
-- ════════════════════════════════════════════════════════════════════════════
SELECT record_single_leg_entry('J-tx2', 'income', 'J-empty', 750, NULL,
  'salary', 'Income', now(), 0, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-empty') = 750.00
  AND (SELECT source_account_id IS NULL AND destination_account_id = 'J-empty'
         FROM transactions WHERE id = 'J-tx2'),
  'income credits an EMPTY account with no balance guard at all, and the row carries the destination');

SELECT record_single_leg_entry('J-tx3', 'opening_balance', 'J-cash', 50, NULL,
  '', '', now(), 250, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-cash') = 300.00
  AND (SELECT type = 'opening_balance' AND destination_account_id = 'J-cash'
         FROM transactions WHERE id = 'J-tx3'),
  'opening_balance credits and writes its own type (the activity entry is client-side and unchanged)');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. SINGLE LEG — the ADJUSTMENT. The balance is SET to the target inside the
--    lock, the |delta| is derived there, and direction rides on the leg.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _j4 AS
  SELECT record_single_leg_entry(
    'J-tx4', 'adjustment', 'J-bank', 100.00, 5000.00,
    'bank says 5000', '', now(), 4900, false) AS r;

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 5000.00
  AND (SELECT (r ->> 'account_delta')::numeric FROM _j4) = 100.00
  AND (SELECT (r ->> 'amount')::numeric FROM _j4) = 100.00
  AND (SELECT amount = 100 AND destination_account_id = 'J-bank'
              AND source_account_id IS NULL
         FROM transactions WHERE id = 'J-tx4'),
  'adjustment UP: the balance is SET to the target exactly, and the row puts the account on the DESTINATION leg',
  (SELECT r::text FROM _j4));

SELECT record_single_leg_entry('J-tx5', 'adjustment', 'J-bank', 250.00, 4750.00,
  '', '', now(), 5000, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4750.00
  AND (SELECT amount = 250 AND source_account_id = 'J-bank'
              AND destination_account_id IS NULL
         FROM transactions WHERE id = 'J-tx5'),
  'adjustment DOWN: the row puts the account on the SOURCE leg and the amount stays an unsigned magnitude');

-- A credit card carrying debt is the reason adjustment has NO balance guard.
SELECT record_single_leg_entry('J-tx6', 'adjustment', 'J-card', 6400.00, -400.00,
  '', '', now(), 6000, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-card') = -400.00,
  'adjustment to a NEGATIVE target is allowed — it is the correct use of it for a credit card, and it has no balance guard by design');

-- The no-op guard, evaluated INSIDE the lock (the legacy path evaluates it
-- against a local snapshot and can still write a row for a movement of zero).
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad1', 'adjustment', 'J-bank', 0, 4750.00,
    '', '', now(), 4750, false)
$$, 'NOTHING_TO_CORRECT',
  'an adjustment to the balance the account already has is refused inside the lock');

-- The client's own |delta| must agree with the server's.
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad2', 'adjustment', 'J-bank', 999, 4800.00,
    '', '', now(), 4750, false)
$$, 'AMOUNT_MISMATCH',
  'a client |delta| that disagrees with the one the locked row implies is refused');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4750.00
  AND (SELECT count(*) FROM transactions WHERE id IN ('J-bad1', 'J-bad2')) = 0,
  'both adjustment refusals wrote nothing');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. SINGLE LEG — the compare-and-swap, and the client-shaped retry.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-tx7', 'expense', 'J-bank', 50, NULL,
    '', '', now(), 9999, false)
$$, 'BALANCE_CONFLICT',
  'a stale expectation raises BALANCE_CONFLICT — byte-identical to apply_account_balance_delta''s token');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4750.00
  AND (SELECT count(*) FROM transactions WHERE id = 'J-tx7') = 0,
  'the conflict moved NOTHING and wrote no row — so the client''s retry has nothing to compensate');

SELECT record_single_leg_entry('J-tx7', 'expense', 'J-bank', 50, NULL,
  '', '', now(), 4750, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4700.00
  AND (SELECT count(*) FROM transactions WHERE id = 'J-tx7') = 1,
  'the refetch-and-retry-once ladder then succeeds, moving the money exactly once');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad3', 'expense', 'J-bank', 50, NULL,
    '', '', now(), NULL, false)
$$, 'EXPECTED_BALANCE_REQUIRED',
  'no expectation, no compare-and-swap — the RPC refuses to become the blind write it replaces');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. SINGLE LEG — the insufficient-balance guard is EXPENSE-only, and the
--    splits_only bypass is reproduced by p_allow_negative.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad4', 'expense', 'J-cash', 10000, NULL,
    '', '', now(), 300, false)
$$, 'INSUFFICIENT_BALANCE',
  'spending more than the account holds is refused — the server half of checkBalanceForTransaction');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-cash') = 300.00
  AND (SELECT count(*) FROM transactions WHERE id = 'J-bad4') = 0,
  'the insufficient refusal wrote nothing');

SELECT record_single_leg_entry('J-tx8', 'expense', 'J-cash', 450, NULL,
  '', '', now(), 300, true);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-cash') = -150.00,
  'p_allow_negative reproduces the splits_only bypass exactly: a full_tracker→splits_only switcher may push one negative');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. SINGLE LEG — idempotent replay, and the id-collision guard.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _j9 AS
  SELECT record_single_leg_entry(
    'J-tx1', 'expense', 'J-bank', 100, NULL,
    'chai', 'Food', now(), 999999, false) AS r;   -- stale expectation on purpose

SELECT test.assert(
  (SELECT (r ->> 'replay')::boolean FROM _j9)
  AND (SELECT (r ->> 'account_delta')::numeric FROM _j9) = 0
  AND (SELECT (r ->> 'account_balance')::numeric FROM _j9) = 4700.00
  AND (SELECT balance FROM accounts WHERE id = 'J-bank') = 4700.00
  AND (SELECT count(*) FROM transactions WHERE id = 'J-tx1') = 1,
  'a replay short-circuits BEFORE the compare-and-swap (even carrying the original stale expectation) and moves nothing',
  (SELECT r::text FROM _j9));

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-tx1', 'income', 'J-bank', 100, NULL,
    '', '', now(), 4700, false)
$$, 'TRANSACTION_ID_COLLISION',
  'an id already owned by another entry type is refused, not replayed');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. SINGLE LEG — THE LEDGER GUARD and the poisoned payloads.
--    There is no ledger-only income/expense/opening_balance/adjustment in this
--    product (both branches throw on a missing account in BOTH app modes), so
--    a null account must be refused rather than written as a both-ids-null row
--    — the failure class tasks/lessons.md records.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad5', 'expense', NULL, 10, NULL, '', '', now(), 0, false)
$$, 'ACCOUNT_NOT_FOUND', 'a NULL account id is refused — no both-ids-null single-leg row can be written here');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad6', 'expense', '   ', 10, NULL, '', '', now(), 0, false)
$$, 'ACCOUNT_NOT_FOUND', 'a whitespace account id is refused too');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad7', 'expense', 'J-gone', 10, NULL, '', '', now(), 900, false)
$$, 'ACCOUNT_NOT_FOUND', 'a soft-deleted account is refused');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad8', 'expense', 'K-bank', 10, NULL, '', '', now(), 99999, false)
$$, 'ACCOUNT_NOT_FOUND', 'ANOTHER USER''S account is refused — the user_id predicate IS the access control under SECURITY DEFINER');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('', 'expense', 'J-bank', 10, NULL, '', '', now(), 4700, false)
$$, 'INVALID_TRANSACTION_ID', 'an empty transaction id is refused');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad9', 'transfer', 'J-bank', 10, NULL, '', '', now(), 4700, false)
$$, 'INVALID_TYPE', 'a type this function does not cover is refused (a transfer belongs to transfer_between_accounts)');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad10', 'expense', 'J-bank', 0, NULL, '', '', now(), 4700, false)
$$, 'INVALID_AMOUNT', 'a zero amount is refused (it is not a record, it is a no-op that still writes a row)');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad11', 'expense', 'J-bank', 'NaN'::numeric, NULL, '', '', now(), 4700, false)
$$, 'INVALID_AMOUNT', 'NaN is a real NUMERIC value in Postgres and is rejected explicitly');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad12', 'expense', 'J-bank', 1e13, NULL, '', '', now(), 4700, false)
$$, 'INVALID_AMOUNT', 'the shared 1e12 ceiling (p1-money-bounds / checkMoneyAmount) is enforced server-side');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad13', 'expense', 'J-bank', 10, 4000, '', '', now(), 4700, false)
$$, 'INVALID_ARGUMENT', 'only an adjustment may carry a target balance');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-bad14', 'adjustment', 'J-bank', 10, NULL, '', '', now(), 4700, false)
$$, 'TARGET_BALANCE_REQUIRED', 'an adjustment without a target is refused');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4700.00
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = 'K-bank')
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'J-bad%') = 0,
  'ELEVEN refusals in this section wrote nothing at all — and the other user''s account is not even READABLE from here (RLS on the table, the user_id predicate inside the DEFINER function)');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. SINGLE LEG — MID-TRANSACTION FAILURE. A trigger that raises on the
--    transactions INSERT, i.e. AFTER the balance UPDATE. Under the legacy path
--    the debit had already committed independently by this point.
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
CREATE OR REPLACE FUNCTION public._j_boom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IN ('J-legboom', 'J-invboom') THEN
    RAISE EXCEPTION 'SIMULATED_WRITE_FAILURE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER _j_boom_trg BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public._j_boom();
SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-legboom', 'expense', 'J-bank', 200, NULL,
    '', '', now(), 4700, false)
$$, 'SIMULATED_WRITE_FAILURE',
  'the transactions INSERT fails AFTER the balance was written');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4700.00
  AND (SELECT count(*) FROM transactions WHERE id = 'J-legboom') = 0,
  'BOTH legs rolled back together — a changed balance with no row saying why is exactly what this RPC exists to prevent');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. INVESTMENT — a BUY. One call: the debit, the trade row AND the money row.
-- ════════════════════════════════════════════════════════════════════════════
-- The trigger is still installed; only the two boom ids raise, so the rest of
-- the suite composes with it and section 15 uses it for the investment case.
CREATE TEMP TABLE _j10 AS
  SELECT record_investment_trade(
    'J-itx1', 'J-tr1', 'buy', 'J-m1', ' emaar ', 'Emaar Properties',
    100, 10, 0, 5,
    'J-bank', 1005, 1005, NULL,
    'first buy', 'Investments', '2026-09-02T11:00:00Z'::timestamptz,
    '2026-09-01T00:00:00Z'::timestamptz, 'via broker',
    '2026-09-02T11:00:00Z'::timestamptz, 4700, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'account_balance')::numeric FROM _j10) = 3695.00
  AND (SELECT (r ->> 'account_delta')::numeric FROM _j10) = -1005.00
  AND (SELECT (r ->> 'amount')::numeric FROM _j10) = 1005.00
  AND (SELECT (r ->> 'symbol') FROM _j10) = 'EMAAR'
  AND (SELECT balance FROM accounts WHERE id = 'J-bank') = 3695.00,
  'buy: qty x price PLUS fees leaves the wallet (fees are CAPITALIZED), and the symbol is normalised to upper case',
  (SELECT r::text FROM _j10));

-- The trade row, field by field, against investmentTradesDb.add's payload.
SELECT test.assert(
  (SELECT market_id = 'J-m1' AND symbol = 'EMAAR' AND name = 'Emaar Properties'
          AND kind = 'buy' AND quantity = 100 AND price_per_unit = 10
          AND amount = 0 AND fees = 5
          AND account_id = 'J-bank' AND transaction_id = 'J-itx1'
          AND traded_at = '2026-09-01T00:00:00Z'::timestamptz
          AND notes = 'via broker'
          AND created_at = '2026-09-02T11:00:00Z'::timestamptz
          AND deleted_at IS NULL
     FROM investment_trades WHERE id = 'J-tr1'),
  'the trade row matches investmentTradesDb.add: amount 0 for a buy, the traded_at kept separate from created_at, the money row linked',
  (SELECT row_to_json(t)::text FROM investment_trades t WHERE id = 'J-tr1'));

SELECT test.assert(
  (SELECT type = 'investment_buy' AND amount = 1005 AND currency = 'AED'
          AND source_account_id = 'J-bank' AND destination_account_id IS NULL
          AND related_investment_id = 'J-tr1'
          AND related_person IS NULL AND related_loan_id IS NULL
          AND related_goal_id IS NULL AND conversion_rate IS NULL
          AND category = 'Investments' AND notes = 'first buy'
          AND created_at = '2026-09-02T11:00:00Z'::timestamptz
          AND deleted_at IS NULL
     FROM transactions WHERE id = 'J-itx1'),
  'the money row carries related_investment_id — the O(1) link deleteTrade walks back to reverse the balance',
  (SELECT row_to_json(t)::text FROM transactions t WHERE id = 'J-itx1'));

-- ════════════════════════════════════════════════════════════════════════════
-- 10. INVESTMENT — a SELL and a DIVIDEND credit; fees NET rather than capitalise.
-- ════════════════════════════════════════════════════════════════════════════
SELECT record_investment_trade(
  'J-itx2', 'J-tr2', 'sell', 'J-m1', 'EMAAR', '',
  40, 12, 0, 3,
  'J-bank', 477, 477, NULL,
  '', 'Investments', now(), '2026-09-03T00:00:00Z'::timestamptz, '',
  now(), 3695, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4172.00
  AND (SELECT quantity = 40 AND amount = 0 AND kind = 'sell'
         FROM investment_trades WHERE id = 'J-tr2')
  AND (SELECT destination_account_id = 'J-bank' AND source_account_id IS NULL
              AND amount = 477
         FROM transactions WHERE id = 'J-itx2'),
  'sell: 40 x 12 MINUS 3 fees arrives, and the row puts the account on the DESTINATION leg');

SELECT record_investment_trade(
  'J-itx3', 'J-tr3', 'dividend', 'J-m1', 'EMAAR', 'ignored on a dividend',
  0, 0, 200, 20,
  'J-bank', 180, 180, NULL,
  '', 'Investments', now(), now(), '',
  now(), 4172, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4352.00
  AND (SELECT quantity = 0 AND price_per_unit = 0 AND amount = 200 AND name = ''
         FROM investment_trades WHERE id = 'J-tr3')
  AND (SELECT amount = 180 FROM transactions WHERE id = 'J-itx3'),
  'dividend: the GROSS is stored on the trade, the NET reaches the wallet and the row, and the company name is forced empty (transactionStore.ts:3407)');

-- ════════════════════════════════════════════════════════════════════════════
-- 11. INVESTMENT — THE OVERSELL GUARD, the one rule whose violation mints
--     shares. 100 bought, 40 sold ⇒ 60 held.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_investment_trade(
    'J-bad20', 'J-trbad1', 'sell', 'J-m1', 'EMAAR', '',
    500, 12, 0, 0, 'J-bank', 6000, 6000, NULL,
    '', '', now(), now(), '', now(), 4352, false)
$$, 'INSUFFICIENT_HOLDINGS',
  'selling 500 of a 60-share position is refused server-side — simulateTimeline, re-run where a curl cannot skip it');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4352.00
  AND (SELECT count(*) FROM investment_trades WHERE id = 'J-trbad1') = 0
  AND (SELECT count(*) FROM transactions WHERE id = 'J-bad20') = 0,
  'the oversell refusal wrote NONE of the three artifacts');

-- A BACKDATED sell: 61 shares dated before the 40-share sell. Valid at that
-- instant against the 100 bought, but it breaks the LATER sell — which is
-- exactly why the guard replays the whole timeline instead of checking a total.
SELECT test.assert_raises($$
  SELECT record_investment_trade(
    'J-bad21', 'J-trbad2', 'sell', 'J-m1', 'EMAAR', '',
    61, 12, 0, 0, 'J-bank', 732, 732, NULL,
    '', '', now(), '2026-09-02T00:00:00Z'::timestamptz, '', now(), 4352, false)
$$, 'INSUFFICIENT_HOLDINGS',
  'a BACKDATED sell that breaks a LATER one is caught — the guard replays the timeline, it does not check a running total');

-- Already-invalid stored data must be SKIPPED, not counted: historical
-- bad-sync residue cannot lock the user out of an otherwise-valid entry.
INSERT INTO investment_trades (id, user_id, market_id, symbol, name, kind,
  quantity, price_per_unit, amount, fees, account_id, transaction_id,
  traded_at, notes, created_at)
VALUES ('J-trbad3', auth.uid(), 'J-m1', 'ROTTEN', '', 'sell',
  999, 1, 0, 0, NULL, NULL, '2026-01-01T00:00:00Z', '', '2026-01-01T00:00:00Z');
INSERT INTO investment_trades (id, user_id, market_id, symbol, name, kind,
  quantity, price_per_unit, amount, fees, account_id, transaction_id,
  traded_at, notes, created_at)
VALUES ('J-trok', auth.uid(), 'J-m1', 'ROTTEN', '', 'buy',
  10, 1, 0, 0, NULL, NULL, '2026-02-01T00:00:00Z', '', '2026-02-01T00:00:00Z');

SELECT test.assert_ok($$
  SELECT record_investment_trade(
    'J-itx4', 'J-tr4', 'sell', 'J-m1', 'ROTTEN', '',
    10, 2, 0, 0, 'J-bank', 20, 20, NULL,
    '', '', now(), '2026-03-01T00:00:00Z'::timestamptz, '', now(), 4352, false)
$$, 'a sell that is valid AGAINST THE REAL BUYS succeeds even though the symbol carries an already-invalid historical sell (computePosition skips it, so simulateTimeline must too)');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4372.00,
  'and that sell really did credit the wallet');

-- ════════════════════════════════════════════════════════════════════════════
-- 12. INVESTMENT — the THIRD asymmetric currency convention: buy DIVIDES,
--     sell and dividend MULTIPLY. Getting one wrong is a factor of rate².
-- ════════════════════════════════════════════════════════════════════════════
-- A PKR market funded from an AED wallet at 76.5 PKR per AED.
SELECT record_investment_trade(
  'J-itx5', 'J-tr5', 'buy', 'J-m2', 'OGDC', '',
  100, 76.5, 0, 0,
  'J-bank', 7650, 100, 76.5,
  '', '', now(), now(), '', now(), 4372, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND (SELECT amount = 7650 AND currency = 'PKR' AND conversion_rate = 76.5
         FROM transactions WHERE id = 'J-itx5'),
  'cross-currency BUY DIVIDES: round(7650 / 76.5, 2) = 100.00 leaves an AED wallet while the row stays in PKR');

SELECT record_investment_trade(
  'J-itx6', 'J-tr6', 'sell', 'J-m2', 'OGDC', '',
  50, 76.5, 0, 0,
  'J-pkr', 3825, 3825, NULL,
  '', '', now(), now(), '', now(), 50000, false);

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-pkr') = 53825.00,
  'a same-currency sell needs no rate at all (and refuses one — see below)');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad22', 'J-trbad4', 'buy', 'J-m2', 'OGDC', '',
    10, 76.5, 0, 0, 'J-bank', 765, 10, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'CONVERSION_RATE_REQUIRED',
  'a cross-currency trade with no rate is refused BEFORE any money moves');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad23', 'J-trbad5', 'buy', 'J-m2', 'OGDC', '',
    10, 76.5, 0, 0, 'J-bank', 765, 10, 999999, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_CONVERSION_RATE',
  'a rate outside RATE_MIN/RATE_MAX is refused (mirrors conversionMath.ts and the transactions CHECK)');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad24', 'J-trbad6', 'sell', 'J-m1', 'EMAAR', '',
    1, 10, 0, 0, 'J-bank', 10, 10, 3.67, '', '', now(), now(), '', now(), 4272, false)
$$, 'CONVERSION_RATE_NOT_APPLICABLE',
  'a rate on a SAME-currency trade is refused rather than silently written');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad25', 'J-trbad7', 'buy', 'J-m2', 'OGDC', '',
    10, 76.5, 0, 0, 'J-bank', 765, 999, 76.5, '', '', now(), now(), '', now(), 4272, false)
$$, 'ACCOUNT_AMOUNT_MISMATCH',
  'a LYING account amount is refused — the server derives its own and will not move money on the caller''s word');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad26', 'J-trbad8', 'buy', 'J-m1', 'EMAAR', '',
    10, 10, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'TRADE_AMOUNT_MISMATCH',
  'a LYING cash amount is refused — qty x price +/- fees is re-derived per kind');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND (SELECT count(*) FROM investment_trades WHERE id LIKE 'J-trbad%'
         AND id <> 'J-trbad3') = 0,
  'FIVE currency/amount refusals moved nothing and left no trade behind');

-- ════════════════════════════════════════════════════════════════════════════
-- 13. INVESTMENT — validateTradeInput, re-run server-side.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad30', 'J-trbadA', 'buy', 'J-m1', 'EMAAR', '',
    10, 10, 0, -1, 'J-bank', 99, 99, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_TRADE', 'negative fees are refused');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad31', 'J-trbadB', 'dividend', 'J-m1', 'EMAAR', '',
    0, 0, 100, 100, 'J-bank', 0, 0, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_TRADE', 'fees that swallow the whole dividend are refused');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad32', 'J-trbadC', 'buy', 'J-m1', 'EMAAR', '',
    0, 10, 0, 0, 'J-bank', 0, 0, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_TRADE', 'a zero quantity is refused for a buy');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad33', 'J-trbadD', 'sell', 'J-m1', 'EMAAR', '',
    1, 1, 0, 50, 'J-bank', -49, -49, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_TRADE', 'fees that exceed the sale proceeds are refused');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad34', 'J-trbadE', 'gift', 'J-m1', 'EMAAR', '',
    1, 1, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_KIND', 'a kind outside buy/sell/dividend is refused');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad35', 'J-trbadF', 'buy', 'J-m1', '  ', '',
    1, 1, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'INVALID_SYMBOL', 'a blank symbol is refused');

-- ════════════════════════════════════════════════════════════════════════════
-- 14. INVESTMENT — ownership, the ledger guard, the balance guard, replay and
--     the trade-id collision.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad40', 'J-trbadG', 'buy', 'K-m1', 'EMAAR', '',
    1, 1, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'MARKET_NOT_FOUND', 'ANOTHER USER''S market is refused');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad41', 'J-trbadH', 'buy', 'J-m1', 'EMAAR', '',
    1, 1, 0, 0, NULL, 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'ACCOUNT_NOT_FOUND',
  'a NULL account is refused — a trade held OUTSIDE Hisaab belongs to investmentStore.recordOutsideTrade, which writes no money row at all');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-bad42', 'J-trbadI', 'buy', 'J-m1', 'EMAAR', '',
    1000, 100, 0, 0, 'J-cash', 100000, 100000, NULL, '', '', now(), now(), '', now(), -150, false)
$$, 'INSUFFICIENT_BALANCE',
  'a buy you cannot afford is refused — the STRICT checkBalance (investment_* is absent from isSimpleModeBalanceBypassAllowed)');

-- Replay: the same transaction id returns the FIRST call's trade id.
CREATE TEMP TABLE _j11 AS
  SELECT record_investment_trade(
    'J-itx1', 'J-tr-other', 'buy', 'J-m1', 'EMAAR', 'Emaar Properties',
    100, 10, 0, 5, 'J-bank', 1005, 1005, NULL,
    'first buy', 'Investments', now(), now(), '', now(), 999999, false) AS r;

SELECT test.assert(
  (SELECT (r ->> 'replay')::boolean FROM _j11)
  AND (SELECT (r ->> 'trade_id') FROM _j11) = 'J-tr1'
  AND (SELECT (r ->> 'account_delta')::numeric FROM _j11) = 0
  AND (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND (SELECT count(*) FROM investment_trades WHERE id = 'J-tr-other') = 0,
  'a replay returns the trade the FIRST call minted and creates NO second trade — even carrying a stale expectation',
  (SELECT r::text FROM _j11));

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-itx9', 'J-tr1', 'buy', 'J-m1', 'EMAAR', '',
    1, 1, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'TRADE_ID_COLLISION',
  'a reused TRADE id is refused — investmentTradesDb.add is an upsert, so the legacy path would silently overwrite a live trade and the position it produced');

SELECT test.assert(
  (SELECT quantity = 100 AND price_per_unit = 10 FROM investment_trades WHERE id = 'J-tr1'),
  'and the live trade was NOT overwritten');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = 'K-bank')
  AND NOT EXISTS (SELECT 1 FROM investment_markets WHERE id = 'K-m1')
  AND (SELECT count(*) FROM transactions WHERE id LIKE 'J-bad%') = 0,
  'every refusal in sections 12-14 wrote nothing, and neither the other user''s account nor their market is readable from here');

-- ════════════════════════════════════════════════════════════════════════════
-- 15. INVESTMENT — MID-TRANSACTION FAILURE, the proof this file exists for.
--     The trigger raises on the transactions INSERT, i.e. AFTER the balance
--     UPDATE **and** the investment_trades INSERT.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$
  SELECT record_investment_trade(
    'J-invboom', 'J-trboom', 'buy', 'J-m1', 'EMAAR', '',
    10, 10, 0, 0, 'J-bank', 100, 100, NULL,
    '', '', now(), now(), '', now(), 4272, false)
$$, 'SIMULATED_WRITE_FAILURE',
  'the money row fails AFTER the balance and the TRADE were both written');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND (SELECT count(*) FROM investment_trades WHERE id = 'J-trboom') = 0
  AND (SELECT count(*) FROM transactions WHERE id = 'J-invboom') = 0,
  'ALL THREE legs rolled back together — under the legacy path the wallet had already paid for shares nobody holds. THIS is what the migration exists for');

RESET ROLE;
DROP TRIGGER _j_boom_trg ON public.transactions;
DROP FUNCTION public._j_boom();
SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ════════════════════════════════════════════════════════════════════════════
-- 16. apply_goal_saved_delta — the compensation's own compare-and-swap.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _j12 AS
  SELECT apply_goal_saved_delta('J-g1', -200, 500) AS r;

SELECT test.assert(
  (SELECT (r ->> 'goal_saved_amount')::numeric FROM _j12) = 300.00
  AND (SELECT (r ->> 'goal_applied')::numeric FROM _j12) = -200.00
  AND (SELECT saved_amount FROM goals WHERE id = 'J-g1') = 300.00,
  'the goal inverse applies as a DELTA behind a compare-and-swap — the last unlocked writer of goals.saved_amount, closed',
  (SELECT r::text FROM _j12));

SELECT test.assert_raises($$
  SELECT apply_goal_saved_delta('J-g1', -200, 500)
$$, 'BALANCE_CONFLICT',
  'replaying it with the ORIGINAL expectation is refused — this is the lost update the CAS exists to stop');

SELECT test.assert(
  (SELECT saved_amount FROM goals WHERE id = 'J-g1') = 300.00,
  'and the refused replay did not move the goal a second time');

-- The clamp: a compensation larger than what is left cannot drive it negative.
CREATE TEMP TABLE _j13 AS
  SELECT apply_goal_saved_delta('J-g1', -1000, 300) AS r;

SELECT test.assert(
  (SELECT (r ->> 'goal_saved_amount')::numeric FROM _j13) = 0.00
  AND (SELECT (r ->> 'goal_applied')::numeric FROM _j13) = -300.00
  AND (SELECT saved_amount FROM goals WHERE id = 'J-g1') = 0.00,
  'the clamp at zero is byte-for-byte goalStore.addContribution, and goal_applied reports what ACTUALLY moved (-300), not what was asked (-1000)',
  (SELECT r::text FROM _j13));

SELECT test.assert_raises($$
  SELECT apply_goal_saved_delta('K-g1', -10, 100)
$$, 'GOAL_NOT_FOUND', 'ANOTHER USER''S goal is refused, and no saved amount leaks from it');

SELECT test.assert_raises($$
  SELECT apply_goal_saved_delta('J-g1', 'NaN'::numeric, 0)
$$, 'INVALID_ARGUMENT', 'a NaN delta is refused');

SELECT test.assert_raises($$
  SELECT apply_goal_saved_delta('J-g1', -10, NULL)
$$, 'INVALID_ARGUMENT', 'no expectation, no compare-and-swap');

-- Read it back as the OWNER of the table, not through RLS: the point is that
-- the refusals above changed nothing, and user J cannot even see the row.
RESET ROLE;
SELECT test.assert(
  (SELECT saved_amount FROM public.goals WHERE id = 'K-g1') = 100.00,
  'the other user''s goal is untouched by every one of those calls (read back with RLS bypassed, because J cannot see it at all)');
SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ════════════════════════════════════════════════════════════════════════════
-- 17. TWO SESSIONS racing the same ACCOUNT row.
--     The harness runs one psql session per file, so the second one is opened
--     through dblink. If the image has no dblink the section degrades to a
--     recorded SKIP rather than failing the suite — the lock order is
--     additionally verified statically by the migration's V3/V4.
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
DO $race$
DECLARE
  v_start   NUMERIC;
  v_blocked BOOLEAN := false;
  v_conflict BOOLEAN := false;
  v_ok      BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS dblink';
    PERFORM dblink_connect('j_racer', 'dbname=' || current_database() || ' user=postgres');
  EXCEPTION WHEN OTHERS THEN
    PERFORM test.assert(true,
      'two-session race SKIPPED — dblink is unavailable in this image (' || SQLERRM || '); the ascending-id lock order is still asserted statically by the migration''s V3/V4');
    RETURN;
  END;

  -- Session A opens a transaction, moves J-cash, and HOLDS the row lock.
  PERFORM dblink_exec('j_racer', 'BEGIN');
  PERFORM dblink_exec('j_racer',
    'SET request.jwt.claim.sub = ''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa''');
  PERFORM 1 FROM dblink('j_racer', $q$
    SELECT record_single_leg_entry('J-raceA', 'income', 'J-cash', 100, NULL,
      '', '', now(), -150, false)::text
  $q$) AS t(r TEXT);

  -- Session B (this one) asks for the same row. It must WAIT, not interleave.
  PERFORM set_config('lock_timeout', '1500ms', true);
  BEGIN
    PERFORM record_single_leg_entry('J-raceB', 'income', 'J-cash', 50, NULL,
      '', '', now(), -150, false);
  EXCEPTION WHEN OTHERS THEN
    -- 55P03 = lock_not_available, i.e. "canceling statement due to lock timeout"
    v_blocked := (SQLSTATE = '55P03');
  END;
  PERFORM set_config('lock_timeout', '0', true);

  PERFORM test.assert(v_blocked,
    'session B BLOCKED on the account row lock while A held it open — the two calls serialise, they do not interleave (no deadlock)');

  -- A commits. B's original expectation is now stale.
  PERFORM dblink_exec('j_racer', 'COMMIT');
  PERFORM dblink_disconnect('j_racer');

  BEGIN
    PERFORM record_single_leg_entry('J-raceB', 'income', 'J-cash', 50, NULL,
      '', '', now(), -150, false);
  EXCEPTION WHEN OTHERS THEN
    v_conflict := (SQLERRM ILIKE '%BALANCE_CONFLICT%');
  END;

  PERFORM test.assert(v_conflict,
    'once A committed, B''s pre-A expectation is refused with BALANCE_CONFLICT carrying the post-A truth — the lost update is impossible');

  -- The client-shaped retry against the fresh figure.
  BEGIN
    PERFORM record_single_leg_entry('J-raceB', 'income', 'J-cash', 50, NULL,
      '', '', now(), -50, false);
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
    RAISE NOTICE 'retry failed: %', SQLERRM;
  END;

  PERFORM test.assert(
    v_ok
    AND (SELECT balance FROM public.accounts WHERE id = 'J-cash') = 0.00
    AND (SELECT count(*) FROM public.transactions
          WHERE id IN ('J-raceA', 'J-raceB')) = 2,
    'money moved EXACTLY ONCE per call: -150 + 100 + 50 = 0, and both rows exist');

EXCEPTION WHEN OTHERS THEN
  BEGIN PERFORM dblink_disconnect('j_racer'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM test.assert(false, 'two-session race harness failed', SQLERRM);
END;
$race$;
SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ════════════════════════════════════════════════════════════════════════════
-- 18. THE SHIPPED DRIFT WATCHES, run over everything this suite wrote.
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM transactions t
    WHERE t.type IN ('income', 'expense', 'opening_balance', 'adjustment')
      AND t.deleted_at IS NULL
      AND t.source_account_id IS NULL AND t.destination_account_id IS NULL) = 0,
  'V5 (single-leg row with NO account) returns zero rows — the ledger guard held');

SELECT test.assert(
  (SELECT count(*) FROM transactions t
    WHERE t.type IN ('income', 'expense', 'opening_balance', 'adjustment')
      AND t.deleted_at IS NULL
      AND ((t.source_account_id IS NOT NULL AND t.destination_account_id IS NOT NULL)
           OR t.conversion_rate IS NOT NULL)) = 0,
  'V6 (a single-leg row touching two accounts, or carrying a rate) returns zero rows');

SELECT test.assert(
  (SELECT count(*) FROM transactions t
    WHERE t.type IN ('investment_buy', 'investment_sell', 'investment_dividend')
      AND t.deleted_at IS NULL
      AND (t.related_investment_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM investment_trades tr
                           WHERE tr.id = t.related_investment_id
                             AND tr.deleted_at IS NULL))) = 0
  AND (SELECT count(*) FROM investment_trades tr
        WHERE tr.deleted_at IS NULL AND tr.account_id IS NOT NULL
          AND (tr.transaction_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM transactions t2
                               WHERE t2.id = tr.transaction_id
                                 AND t2.deleted_at IS NULL))) = 0,
  'V7 (THE LOST-TRADE SIGNATURE: a money row with no trade, or an account-linked trade with no money row) returns zero rows in both directions');

SELECT test.assert(
  (SELECT count(*) FROM (
     SELECT tr.user_id, tr.market_id, tr.symbol
       FROM investment_trades tr
      WHERE tr.deleted_at IS NULL
        AND tr.user_id = auth.uid()
        AND tr.symbol <> 'ROTTEN'
      GROUP BY tr.user_id, tr.market_id, tr.symbol
     HAVING sum(CASE tr.kind WHEN 'buy' THEN tr.quantity
                             WHEN 'sell' THEN -tr.quantity ELSE 0 END) < -1e-9
   ) s) = 0,
  'V8 (an OVERSOLD position) returns zero rows for every symbol this suite traded — ROTTEN is excluded because the suite planted its bad row on purpose');

SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'J-bank') = 4272.00
  AND (SELECT balance FROM accounts WHERE id = 'J-cash') = 0.00
  AND (SELECT balance FROM accounts WHERE id = 'J-empty') = 750.00
  AND (SELECT balance FROM accounts WHERE id = 'J-pkr') = 53825.00
  AND (SELECT balance FROM accounts WHERE id = 'J-card') = -400.00
  AND (SELECT saved_amount FROM goals WHERE id = 'J-g1') = 0.00,
  'every closing balance reconciles to the cent across the whole suite');

-- ════════════════════════════════════════════════════════════════════════════
-- P. Roles. Under SECURITY DEFINER, the GRANT is the outer gate and the
--    user_id = auth.uid() predicate is the inner one.
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
SET ROLE anon;
SELECT test.assert_raises($$
  SELECT record_single_leg_entry('J-anon1', 'expense', 'J-bank', 1, NULL, '', '', now(), 4272, false)
$$, 'permission denied', 'as anon, record_single_leg_entry is permission denied');

SELECT test.assert_raises($$
  SELECT record_investment_trade('J-anon2', 'J-tranon', 'buy', 'J-m1', 'EMAAR', '',
    1, 1, 0, 0, 'J-bank', 1, 1, NULL, '', '', now(), now(), '', now(), 4272, false)
$$, 'permission denied', 'as anon, record_investment_trade is permission denied');

SELECT test.assert_raises($$
  SELECT apply_goal_saved_delta('J-g1', -1, 0)
$$, 'permission denied', 'as anon, apply_goal_saved_delta is permission denied');

RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', false);

SELECT test.assert_raises($$
  SELECT record_single_leg_