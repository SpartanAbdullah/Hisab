-- ════════════════════════════════════════════════════════════════════════════
-- L4 STEP 5 — THE LAST TWO SHAPES: the investment trade, and the single leg
--             (+ the goal compensation's own compare-and-swap)
--
-- Audit refs: docs/audit-2026-09/07-mobile-first.md MF-01 · 12-qa-review.md
--             O-1 / F-4 · 00-executive-summary.md M1 / L4.
-- Narrative:  docs/server-side-money-engine.md §23 (this file closes items 6
--             and the two "—" rows of the §22 branch table).
--
-- APPLY ORDER: after supabase-migration-p3-atomic-goal-and-card.sql (step 4).
-- Hard requirements, checked by name in SECTION 0:
--   supabase-schema.sql, supabase-migration-prelaunch-hardening.sql,
--   supabase-migration-investments.sql  (investment_markets / investment_trades
--                                        and transactions.related_investment_id),
--   supabase-migration-p1-money-bounds.sql (the CHECKs these INSERTs satisfy),
--   supabase-migration-incremental-sync-tombstones.sql (deleted_at columns).
--
-- SAFE AHEAD OF THE CLIENT. It adds three functions and changes nothing else.
-- Nothing calls them until VITE_ATOMIC_SINGLE_LEG / VITE_ATOMIC_INVEST are set
-- (and the goal delta is only reached from the already-flagged VITE_ATOMIC_GOAL
-- path's compensation), so applying it is inert. Re-running it is clean.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ────────────────────────────────────────────────────────────────────────────
-- Steps 1-4 moved every MULTI-LEG money branch of `processTransaction` behind a
-- Postgres transaction. Two shapes were left, and §22 of the doc named both:
--
--   investment_buy / investment_sell / investment_dividend   (TWO artifacts)
--     1. apply_account_balance_delta(account, ±cash, expected)  — commits
--     2. investment_trades INSERT                               — TIMES OUT
--     3. transactions INSERT                                    — never runs
--
--     Server truth: the wallet moved and NO TRADE EXISTS. Positions in this
--     product are DERIVED by replaying the trade ledger (src/lib/
--     investmentMath.ts — "there is no holdings table to drift"), so a missing
--     trade row is not a cosmetic gap: the shares the user just paid for are
--     not held by anybody, the cost basis never learns about the money, and
--     the only surviving evidence is a balance that is quietly smaller. The
--     reverse case is worse: a SELL whose balance leg commits and whose trade
--     row does not leaves the position still showing the shares, so the user
--     can sell them a second time.
--
--   income / expense / opening_balance / adjustment          (ONE artifact + 1)
--     1. apply_account_balance_delta(account, ±amount, expected) — commits
--     2. transactions INSERT                                     — TIMES OUT
--
--     A narrow window — this cannot leave money half-moved BETWEEN two places,
--     which was MF-01's finding — but it is the single most common write in the
--     app, and what it leaves behind is the shape the product has no answer
--     for: a balance that changed with no row saying why. The user's own repair
--     for it is `adjustment`, which is itself one of the four branches with the
--     same window.
--
-- And one leftover from step 4 (doc §23 item 6): the goal contribution's
-- COMPENSATION still writes goals.saved_amount through goalsDb.update — an
-- unlocked read-modify-write. Step 4 made the FORWARD write a compare-and-swap;
-- `apply_goal_saved_delta` gives the inverse the same protection.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ARTIFACT CONTRACT #1 — record_single_leg_entry
-- ────────────────────────────────────────────────────────────────────────────
-- Traced from src/stores/transactionStore.ts:
--   case 'income'          :2452-2464
--   case 'expense'         :2466-2475
--   case 'opening_balance' :3255-3272
--   case 'adjustment'      :3274-3288
-- and the shared tail at :3439-3480.
--
--  # | Artifact                                   | Owner after step 5
-- ---+--------------------------------------------+-----------------------------
--  1 | accounts.balance (exactly ONE row)         | SERVER, in the transaction
--  2 | transactions row (20 columns)              | SERVER, same transaction
--  3 | Dexie mirrors (accounts, transactions)     | client, post-commit,
--    | + Zustand state in two stores              | adopting the server's balance
--  4 | activity_log 'transaction_created', or     | client, post-commit,
--    | 'opening_balance' for that one type        | best-effort — UNCHANGED
--  5 | reminder reschedule (nudgeReminderSchedule)| client, post-commit — UNCHANGED
--
-- PER-TYPE, and this is the whole specification:
--
--   type             | leg        | row.source | row.destination | balance guard
--   -----------------+------------+------------+-----------------+---------------
--   income           | +amount    | NULL       | the account     | none, ever
--   opening_balance  | +amount    | NULL       | the account     | none, ever
--   expense          | -amount    | the account| NULL            | checkBalanceFor-
--                    |            |            |                 | Transaction
--   adjustment       | ±delta     | acct if    | acct if delta>0 | none, ever
--                    |            | delta<0    |                 |
--
--   · `amount` on the row is ALWAYS the unsigned magnitude — direction is
--     carried by which leg the account sits on. That is the repo-wide sign
--     convention (supabase-migration-p1-money-bounds.sql §"SIGN CONVENTION").
--   · adjustment's `amount` is abs(target − balance), which the branch derives;
--     the server derives it too, from the LOCKED row, and refuses a client
--     figure that disagrees by more than 0.01 (AMOUNT_MISMATCH).
--   · adjustment SETS the balance to the target rather than adding a delta
--     computed from a stale snapshot. That is the correction this RPC makes:
--     "set it to X" is what the user asked for, and doing it inside the lock is
--     the only way the answer is X.
--   · NONE of the four is cross-currency. All four take the row's currency FROM
--     the account and write conversion_rate NULL; a non-null rate is REFUSED
--     (CONVERSION_RATE_NOT_APPLICABLE) rather than silently stored.
--
-- BOTH APP MODES — traced, not assumed:
--   full_tracker  — the only mode that reaches this RPC.
--   splits_only (ledger-only) — every one of the four branches' FIRST line is a
--     `accountStore.getAccount(...)` lookup followed by `throw new Error('…
--     account not found')`. `getAccount('')` returns undefined, so an entry with
--     no account cannot be created in either mode: **there is no ledger-only
--     income / expense / opening_balance / adjustment row today.** Rows with
--     BOTH account ids null exist in this product (tasks/lessons.md:26-27) but
--     they are `repayment` rows written by loanStore.applyRepayment and by the
--     card-bill tail — never one of these four types. This RPC therefore
--     REFUSES a null/blank account id (ACCOUNT_NOT_FOUND) in every case: making
--     it acceptable "for ledger mode" would create a second, silent way to write
--     a money row, which is exactly the failure class the lessons file records.
--     Verification query V5 watches production for one appearing anyway.
--   One subtlety reproduced faithfully: 'expense' IS in
--     isSimpleModeBalanceBypassAllowed (transactionStore.ts:341-349), so a user
--     who switched full_tracker → splits_only and still has accounts may
--     legitimately push one negative. The client passes p_allow_negative = true
--     in exactly that case and only for 'expense'; full tracker always false.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ARTIFACT CONTRACT #2 — record_investment_trade
-- ────────────────────────────────────────────────────────────────────────────
-- Traced from src/stores/transactionStore.ts:
--   case 'investment_buy' / 'investment_sell' :3290-3383
--   case 'investment_dividend'                :3385-3436
--
--  # | Artifact                                   | Owner after step 5
-- ---+--------------------------------------------+-----------------------------
--  1 | accounts.balance (exactly ONE row)         | SERVER, in the transaction
--  2 | investment_trades row (16 columns)         | SERVER, same transaction
--  3 | transactions row, related_investment_id set| SERVER, same transaction
--  4 | Zustand state in three stores + the Dexie  | client, post-commit,
--    | transactions/accounts mirrors              | adopting the server's figures
--  5 | activity_log 'transaction_created'         | client, post-commit — UNCHANGED
--  6 | reminder reschedule                        | client, post-commit — UNCHANGED
--  — | DERIVED positions (qty / avg cost / P&L)   | NOBODY. They are replayed
--    |                                            | from artifact 2 on every
--    |                                            | render (investmentMath.ts).
--    |                                            | There is no holdings table,
--    |                                            | so there is nothing to sync
--    |                                            | and nothing to drift — which
--    |                                            | is precisely why losing the
--    |                                            | trade row loses the position.
--  — | investment_prices                          | untouched. A trade never
--    |                                            | writes a price; updatePrice
--    |                                            | is a separate user action.
--
-- THE CASH AMOUNT, per kind (the row's `amount`, in MARKET currency):
--   buy      round(round(qty × price, 2) + fees, 2)   fees CAPITALIZED
--   sell     round(round(qty × price, 2) − fees, 2)   fees reduce proceeds
--   dividend round(gross − fees, 2)                   fees reduce income
-- The server re-derives all three and refuses a client figure disagreeing by
-- more than 0.01 (TRADE_AMOUNT_MISMATCH). It does NOT re-derive the position —
-- that stays in TypeScript, the same *plan on the client, apply on the server*
-- rule steps 3 and 4 settled.
--
-- THE ACCOUNT LEG, and the third asymmetric currency convention in this engine:
--   buy      DIVIDE   round(amount / rate, 2) leaves the wallet   (goal shape)
--   sell     MULTIPLY round(amount × rate, 2) arrives             (transfer shape)
--   dividend MULTIPLY round(amount × rate, 2) arrives
-- A single "convert" implementation would mis-convert the buy by a factor of
-- rate². The server derives which applies FROM THE KIND and cross-checks the
-- client's own figure within 0.01 (ACCOUNT_AMOUNT_MISMATCH).
-- Note the exact trigger, copied line for line: buy and sell convert only when
-- `account.currency <> market.currency AND amount > 0` — a zero-cash entry
-- (bonus shares at price 0) needs no rate and moves nothing — while DIVIDEND
-- converts on the currency test alone (its amount is > 0 by construction).
--
-- THE OVERSELL GUARD. `simulateTimeline` (investmentMath.ts:165-188) is the
-- product's own guard and it runs BEFORE any money moves. It is re-run here,
-- byte-for-byte, because it is the one investment rule whose violation MINTS
-- SHARES: a curl can post a sell of 500 against a holding of 5. Reproduced
-- exactly, including the two subtleties that make it correct:
--   · replay order is (traded_at, buys-before-dividends-before-sells,
--     created_at, id) — so a BACKDATED sell is caught;
--   · sells that are ALREADY invalid in the stored data are SKIPPED, not
--     counted, so historical bad-sync residue cannot lock a user out of an
--     otherwise-valid new entry.
--
-- BOTH APP MODES:
--   full_tracker — the only mode that reaches this RPC.
--   splits_only  — the Investments tab is full-tracker only, and the
--     ledger-shaped trade ("held outside Hisaab", account_id NULL) does not go
--     through processTransaction at all: investmentStore.recordOutsideTrade
--     writes ONE investment_trades row and no transactions row and no balance
--     (investmentStore.ts:144-180). Not one line of that changes, and this RPC
--     REFUSES a null account (ACCOUNT_NOT_FOUND) so an outside trade can never
--     be routed through it. 'investment_*' is absent from
--     isSimpleModeBalanceBypassAllowed, so the buy guard is the STRICT
--     checkBalance and p_allow_negative is always false from the client.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ARTIFACT CONTRACT #3 — apply_goal_saved_delta
-- ────────────────────────────────────────────────────────────────────────────
-- One column, one compare-and-swap, no row writes. It is the goal twin of
-- `apply_loan_remaining_delta` (supabase-migration-audit-p0-loan-concurrency.sql)
-- and exists for doc §23 item 6: after step 4 the FORWARD goal write is a CAS
-- inside contribute_to_goal, but the INVERSE the scope registers still goes
-- through goalStore.addContribution → goalsDb.update, an unlocked
-- read-modify-write that can clobber a contribution made on another device
-- while the rollback is in flight.
--
-- IMPORTANT — a CAS on a compensation is a knife with two edges, and the client
-- side is written accordingly (src/stores/transactionStore.ts,
-- `atomicGoalSavedDelta`): on BALANCE_CONFLICT it refetches the goals and
-- retries ONCE (a pure delta is always safe to replay against a fresh
-- expectation), and if that still conflicts it FALLS BACK to the legacy
-- unlocked write. A rollback that refuses to run is strictly worse than a
-- rollback that races, so the ladder can only make the inverse better, never
-- more fragile.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ERROR CONTRACT — only tokens the client already speaks, plus ONE
-- ────────────────────────────────────────────────────────────────────────────
--   BALANCE_CONFLICT        a stale compare-and-swap — on an ACCOUNT, or (in
--                           apply_goal_saved_delta) on the GOAL. Byte-identical
--                           to apply_account_balance_delta's token, so the
--                           existing refetch-and-retry-once ladders work
--                           unchanged. DETAIL carries the truth as JSON.
--   INSUFFICIENT_BALANCE    the server half of checkBalance / checkBalanceFor-
--                           Transaction. DETAIL rebuilds the identical
--                           bilingual err_insufficient string.
--   ACCOUNT_NOT_FOUND       unknown, blank, soft-deleted, or not yours.
--   GOAL_NOT_FOUND          the goal twin of LOAN_NOT_FOUND (step 4's one new
--                           token; reused here, not reinvented).
--   INSUFFICIENT_HOLDINGS   ** THE ONE NEW TOKEN. ** The server half of
--                           simulateTimeline. There was no server-side
--                           equivalent because nothing server-side had ever
--                           refused a trade. DETAIL carries
--                           {symbol, held, attempted}; the client maps it to one
--                           new bilingual string (err_trade_rejected) and NEVER
--                           retries it — the trade is wrong, not stale.
--
-- Everything else is a poisoned payload or a programming error, unreachable
-- from the shipped client but reachable with one curl against PostgREST:
--   NOT_AUTHENTICATED, INVALID_TRANSACTION_ID, INVALID_TYPE, INVALID_AMOUNT,
--   INVALID_KIND, EXPECTED_BALANCE_REQUIRED, TARGET_BALANCE_REQUIRED,
--   NOTHING_TO_CORRECT, AMOUNT_MISMATCH, CONVERSION_RATE_NOT_APPLICABLE,
--   CONVERSION_RATE_REQUIRED, INVALID_CONVERSION_RATE, MARKET_NOT_FOUND,
--   INVALID_SYMBOL, INVALID_TRADE, TRADE_AMOUNT_MISMATCH,
--   ACCOUNT_AMOUNT_MISMATCH, TRADE_ID_COLLISION, TRANSACTION_ID_COLLISION,
--   INVALID_ARGUMENT.
--
-- Two of those are TIGHTENINGS rather than ports, and are worth naming:
--   · TRADE_ID_COLLISION.  investmentTradesDb.add is an UPSERT, so on the legacy
--     path a repeated trade id silently OVERWRITES a live trade — and with it
--     the position that trade produced. The RPC refuses instead.
--   · NOTHING_TO_CORRECT.  The adjustment branch's own `Math.abs(delta) < 0.005`
--     guard, moved inside the lock. On the legacy path it is evaluated against a
--     local snapshot, so a correction to a balance that has since become correct
--     still writes a row for a movement of zero.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LOCKING
-- ────────────────────────────────────────────────────────────────────────────
-- The repo rule (supabase-migration-audit-p0-settlement-row-locks.sql:73-100)
-- is loans → accounts → emi_schedules, extended by step 4 to
-- loans → accounts → emi_schedules → goals, ascending id within a table.
--
--   record_single_leg_entry   : accounts only. ONE row, taken FOR UPDATE
--                               (through an ORDER BY id ANY(...) statement, so
--                               the shape stays identical to its siblings and
--                               the V3 roll-call has something to assert)
--                               before any write.
--   record_investment_trade   : accounts only. Same shape. investment_markets
--                               and investment_trades are read/insert-only and
--                               are NOT locked — a market is immutable to this
--                               function, and the trade id is its own
--                               serialisation point via the primary key.
--   apply_goal_saved_delta    : goals only, the LEAF of the chain.
--
-- None of the three can invert order against accept_linked_request /
-- accept_settlement_request, apply_loan_remaining_delta,
-- apply_account_balance_delta, transfer_between_accounts,
-- record_loan_repayment, create_loan_with_leg, contribute_to_goal or
-- pay_card_bill: every one of those takes accounts in ascending id order too,
-- and none of them holds an accounts lock while waiting for a goals lock.
--
-- ════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY
-- ────────────────────────────────────────────────────────────────────────────
-- p_transaction_id is generated client-side (uuid() at transactionStore.ts:2433)
-- and is the primary key of `transactions`, so it is the natural key for the
-- exact failure this programme exists to kill: "the call committed but the
-- reply never arrived". The replay check is taken AFTER the row locks, so two
-- copies of the same retry serialise rather than race. A replay returns
-- {status:'ok', replay:true} with the CURRENT figures and moves nothing — even
-- when it carries the original, now stale, expectations.
--
-- record_investment_trade has a second key: the trade id. A replay returns the
-- trade id already stored on the row (transactions.related_investment_id), so a
-- retry can never mint a second trade for one payment.
--
-- apply_goal_saved_delta is deliberately NOT idempotent — it is a delta, and it
-- has no id to key on. Its caller is a compensation that runs at most once per
-- scope.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 0. Preconditions — fail with a name, never with a runtime surprise
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_pairs   TEXT[][] := ARRAY[
    ARRAY['accounts','id'], ARRAY['accounts','user_id'], ARRAY['accounts','name'],
    ARRAY['accounts','type'], ARRAY['accounts','currency'], ARRAY['accounts','balance'],
    ARRAY['accounts','deleted_at'],
    ARRAY['goals','id'], ARRAY['goals','user_id'], ARRAY['goals','saved_amount'],
    ARRAY['investment_markets','id'], ARRAY['investment_markets','user_id'],
    ARRAY['investment_markets','name'], ARRAY['investment_markets','currency'],
    ARRAY['investment_markets','deleted_at'],
    ARRAY['investment_trades','id'], ARRAY['investment_trades','user_id'],
    ARRAY['investment_trades','market_id'], ARRAY['investment_trades','symbol'],
    ARRAY['investment_trades','name'], ARRAY['investment_trades','kind'],
    ARRAY['investment_trades','quantity'], ARRAY['investment_trades','price_per_unit'],
    ARRAY['investment_trades','amount'], ARRAY['investment_trades','fees'],
    ARRAY['investment_trades','account_id'], ARRAY['investment_trades','transaction_id'],
    ARRAY['investment_trades','traded_at'], ARRAY['investment_trades','notes'],
    ARRAY['investment_trades','created_at'], ARRAY['investment_trades','deleted_at'],
    ARRAY['transactions','id'], ARRAY['transactions','user_id'], ARRAY['transactions','type'],
    ARRAY['transactions','amount'], ARRAY['transactions','currency'],
    ARRAY['transactions','source_account_id'], ARRAY['transactions','destination_account_id'],
    ARRAY['transactions','related_person'], ARRAY['transactions','person_id'],
    ARRAY['transactions','related_loan_id'], ARRAY['transactions','related_goal_id'],
    ARRAY['transactions','related_investment_id'],
    ARRAY['transactions','conversion_rate'], ARRAY['transactions','category'],
    ARRAY['transactions','notes'], ARRAY['transactions','created_at'],
    ARRAY['transactions','is_reconciled'], ARRAY['transactions','reconciled_at'],
    ARRAY['transactions','reconciled_by'], ARRAY['transactions','receipt_path'],
    ARRAY['transactions','deleted_at']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = v_pairs[i][1]
         AND column_name = v_pairs[i][2]
    ) THEN
      v_missing := v_missing || (v_pairs[i][1] || '.' || v_pairs[i][2]);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: p3-atomic-investments-and-single-leg needs column(s) % — apply the migrations listed in this file''s APPLY ORDER header first (supabase-migration-investments.sql is the usual missing one), then re-run.',
      array_to_string(v_missing, ', ');
  END IF;

  -- Step 4's CORRECTION 2, restated: goals has no deleted_at, so
  -- apply_goal_saved_delta does not filter on one. If a future migration adds
  -- the column, this file must gain the predicate — fail loudly, not silently.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'goals' AND column_name = 'deleted_at'
  ) THEN
    RAISE WARNING 'p3-atomic-investments-and-single-leg: goals.deleted_at now EXISTS. apply_goal_saved_delta does not filter on it (it did not exist when this file was written) — a soft-deleted goal can still be written. Add the predicate.';
  END IF;

  IF to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-investments-and-single-leg: apply_account_balance_delta is ABSENT — supabase-migration-prelaunch-hardening.sql has not been applied. These functions still install (they reimplement the same compare-and-swap inline), but the legacy client paths they replace are still running unlocked balance writes.';
  END IF;

  IF to_regprocedure('public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)') IS NULL THEN
    RAISE WARNING 'p3-atomic-investments-and-single-leg: contribute_to_goal is ABSENT — supabase-migration-p3-atomic-goal-and-card.sql (L4 step 4) has not been applied. apply_goal_saved_delta still installs and is still correct on its own, but the forward goal write it protects the inverse of is not atomic yet.';
  END IF;
END;
$$;

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. record_single_leg_entry — one balance + one row, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_single_leg_entry(
  p_transaction_id   TEXT,
  p_type             TEXT,      -- income | expense | opening_balance | adjustment
  p_account_id       TEXT,
  p_amount           NUMERIC,   -- the ROW's amount; for adjustment, abs(delta)
  p_target_balance   NUMERIC,   -- adjustment ONLY; NULL for the other three
  p_note             TEXT,
  p_category         TEXT,
  p_date             TIMESTAMPTZ,
  p_expected_balance NUMERIC,
  p_allow_negative   BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER   -- RLS is not consulted; the user_id = v_uid predicates below
                   -- ARE the access control (apply_loan_remaining_delta precedent).
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_acct       public.accounts%ROWTYPE;
  v_existing   public.transactions%ROWTYPE;
  v_delta      NUMERIC;
  v_amount     NUMERIC;
  v_new_bal    NUMERIC;
  v_src        TEXT := NULL;
  v_dest       TEXT := NULL;
  v_created_at TIMESTAMPTZ;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation (mirrors assertInputAmountsInBounds + each branch's own
  --    first guards, so a curl cannot post what the UI cannot) ──────────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_type IS NULL
     OR p_type NOT IN ('income', 'expense', 'opening_balance', 'adjustment') THEN
    RAISE EXCEPTION 'INVALID_TYPE' USING ERRCODE = 'P0001',
      DETAIL = 'record_single_leg_entry covers income, expense, opening_balance and adjustment only';
  END IF;

  -- THE LEDGER GUARD. None of the four branches can produce a row with no
  -- account in EITHER app mode (see BOTH APP MODES in the header), so accepting
  -- one here would create a second, silent way to write a money row.
  IF p_account_id IS NULL OR length(trim(p_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'income / expense / opening_balance / adjustment all require an account in both app modes';
  END IF;

  -- NOTE ON THE ABSENT p_conversion_rate: none of the four branches is ever
  -- cross-currency — each takes the row's currency FROM its one account and
  -- writes conversion_rate NULL. Rather than accept a rate and refuse it (the
  -- shape create_loan_with_leg had to use, because its caller already bound the
  -- argument), this signature simply has no such parameter: a rate is not
  -- expressible here at all, which is the stronger refusal. V6 watches
  -- production for a single-leg row that carries one anyway.

  IF p_expected_balance IS NULL THEN
    -- Refusing to guess is the point: without an expectation there is no
    -- compare-and-swap, and this RPC would be the blind write it replaces.
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
      DETAIL = 'the account has no expected balance';
  END IF;

  IF p_type = 'adjustment' THEN
    -- `amount` is ignored by the branch (the engine derives |delta|), so what
    -- is bounded here is the TARGET, which may legitimately be negative for a
    -- credit card carrying debt. Magnitude and finiteness only — exactly
    -- assertInputAmountsInBounds' adjustment case.
    IF p_target_balance IS NULL THEN
      RAISE EXCEPTION 'TARGET_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = 'an adjustment is a target the balance is set TO';
    END IF;
    IF p_target_balance = 'NaN'::NUMERIC OR abs(p_target_balance) >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
        DETAIL = 'target balance must be finite and below 1e12 in magnitude';
    END IF;
  ELSE
    IF p_target_balance IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_ARGUMENT' USING ERRCODE = 'P0001',
        DETAIL = 'only an adjustment carries a target balance';
    END IF;
    -- Strictly positive, finite, below the shared 1e12 ceiling — the same rule
    -- as src/lib/currencyValidation.ts checkMoneyAmount and p1-money-bounds.
    -- NUMERIC 'NaN' is a real value in Postgres, so it is rejected explicitly.
    IF p_amount IS NULL OR p_amount = 'NaN'::NUMERIC OR p_amount <= 0 OR p_amount >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
        DETAIL = 'amount must be greater than 0 and less than 1e12';
    END IF;
  END IF;

  -- ══ LOCK: the one account row, before any write. The ANY(...)/ORDER BY id
  --    shape is deliberately identical to its sibling functions so the
  --    ascending-id convention is visible in the body roll-call (V3) and cannot
  --    be quietly dropped by a later edit that adds a second account.
  PERFORM 1 FROM public.accounts
   WHERE id = ANY(ARRAY[p_account_id])
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  -- Taken AFTER the lock so two copies of the same retry serialise: the second
  -- sees the first's committed row instead of racing it.
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> p_type THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_bal FROM public.accounts
     WHERE id = p_account_id AND user_id = v_uid;

    RETURN jsonb_build_object(
      'status',          'ok',
      'replay',          true,
      'transaction_id',  v_existing.id,
      'type',            v_existing.type,
      'account_id',      COALESCE(v_existing.source_account_id, v_existing.destination_account_id),
      'account_balance', v_new_bal,
      'account_delta',   0,
      'amount',          v_existing.amount,
      'currency',        v_existing.currency,
      'created_at',      v_existing.created_at,
      'row_deleted',     (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load the account (lock already held) ────────────────────────────────
  SELECT * INTO v_acct FROM public.accounts
   WHERE id = p_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'account is unknown, deleted, or not yours';
  END IF;

  -- ── Optimistic lock ─────────────────────────────────────────────────────
  -- Byte-identical to apply_account_balance_delta's predicate, so the token and
  -- the retry ladder the client already runs are unchanged.
  IF round(v_acct.balance, 2) <> round(p_expected_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_acct.id,
        'account_balance',          v_acct.balance,
        'expected_account_balance', p_expected_balance
      )::TEXT;
  END IF;

  -- ── The direction table, from the header ────────────────────────────────
  IF p_type = 'adjustment' THEN
    -- Derived from the LOCKED row, not from a client snapshot — that is the
    -- whole point of doing this here. `Math.round((target - balance) * 100)/100`
    -- is transactionStore.ts:3277 verbatim.
    v_delta := round(p_target_balance - v_acct.balance, 2);
    IF abs(v_delta) < 0.005 THEN
      RAISE EXCEPTION 'NOTHING_TO_CORRECT' USING ERRCODE = 'P0001',
        DETAIL = 'the balance is already exactly that';
    END IF;
    v_amount := abs(v_delta);
    -- The client derived the same magnitude from its own snapshot; the CAS
    -- above pins them together, so a disagreement means the two halves have
    -- forked and no row should be written on either's word.
    IF p_amount IS NOT NULL
       AND p_amount <> 'NaN'::NUMERIC
       AND abs(round(p_amount, 2) - v_amount) > 0.01 THEN
      RAISE EXCEPTION 'AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'client said ' || p_amount::TEXT || ', the server derives ' || v_amount::TEXT;
    END IF;
    -- Direction is carried by which leg the account sits on (:3283-3284).
    IF v_delta > 0 THEN v_dest := v_acct.id; ELSE v_src := v_acct.id; END IF;

  ELSIF p_type = 'expense' THEN
    v_amount := p_amount;
    v_delta  := -round(p_amount, 2);
    v_src    := v_acct.id;

  ELSE  -- income, opening_balance
    v_amount := p_amount;
    v_delta  := round(p_amount, 2);
    v_dest   := v_acct.id;
  END IF;

  -- ── Insufficient-balance guard ──────────────────────────────────────────
  -- ONLY for 'expense' — the single one of the four that calls
  -- checkBalanceForTransaction. income and opening_balance are credits;
  -- adjustment deliberately has no guard at all (setting a credit card to a
  -- negative balance is the correct use of it). p_allow_negative is TRUE only
  -- where the client's own checkBalanceForTransaction is a no-op, i.e.
  -- splits_only mode (isSimpleModeBalanceBypassAllowed); full tracker: false.
  IF p_type = 'expense'
     AND NOT COALESCE(p_allow_negative, false)
     AND v_acct.balance < round(p_amount, 2) THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_acct.id,
        'account_name', v_acct.name,
        'account_type', v_acct.type,
        'currency',     v_acct.currency,
        'available',    v_acct.balance,
        'requested',    round(p_amount, 2)
      )::TEXT;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════

  -- 1. The balance. An adjustment SETS the target (that is what the user asked
  --    for, and inside the lock it is achievable exactly); the other three add
  --    a delta, matching apply_account_balance_delta's `balance = balance +
  --    p_delta` — the balance itself is never re-rounded, only the delta is.
  IF p_type = 'adjustment' THEN
    UPDATE public.accounts
       SET balance = p_target_balance
     WHERE id = v_acct.id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_bal;
  ELSE
    UPDATE public.accounts
       SET balance = balance + v_delta
     WHERE id = v_acct.id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_bal;
  END IF;

  IF v_new_bal IS NULL THEN
    -- Unreachable: the row was selected under FOR UPDATE above.
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the account disappeared mid-entry';
  END IF;

  -- 2. The row. EXACTLY the columns and values transactionsDb.add writes, read
  --    back the same way by mapTransaction:
  --      amount                 the unsigned magnitude
  --      currency               the ACCOUNT's currency, always
  --      source/destination     per the direction table
  --      related_*              all NULL (related_investment_id omitted
  --                             entirely, exactly as the client omits it when
  --                             it is null, so a database without
  --                             supabase-migration-investments.sql still works)
  --      conversion_rate        NULL — none of the four is cross-currency
  --      is_reconciled          false; reconciled_at/by, receipt_path NULL
  --      updated_at             left to the column default, because the
  --                             client's insert payload omits it too
  v_created_at := COALESCE(p_date, now());

  INSERT INTO public.transactions (
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at,
    is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
  ) VALUES (
    p_transaction_id, v_uid, p_type,
    v_amount, v_acct.currency,
    v_src, v_dest,
    NULL, NULL, NULL, NULL,
    NULL, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',          'ok',
    'replay',          false,
    'transaction_id',  p_transaction_id,
    'type',            p_type,
    'account_id',      v_acct.id,
    'account_balance', v_new_bal,
    -- Signed, already 2dp — the client registers its inverse against THIS,
    -- never against a locally recomputed figure. For an adjustment it is the
    -- movement the SERVER made, which is the only figure a rollback can undo.
    'account_delta',   round(v_new_bal - v_acct.balance, 2),
    'amount',          v_amount,
    'currency',        v_acct.currency,
    'created_at',      v_created_at,
    'row_deleted',     false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_single_leg_entry(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_single_leg_entry(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.record_single_leg_entry(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) IS
  'Audit L4 step 5 (MF-01 / O-1 / F-4): the four single-leg money entries — income, expense, opening_balance and adjustment — as ONE Postgres transaction (the balance compare-and-swap AND the transactions row). Closes the narrow window where the row INSERT fails after the balance has already moved, leaving a changed balance with nothing saying why. Direction and guards are per type: income/opening_balance credit and are never guarded; expense debits behind checkBalanceForTransaction (p_allow_negative reproduces the splits_only bypass); adjustment SETS the target balance inside the lock, derives its own |delta| from the locked row, refuses a no-op (NOTHING_TO_CORRECT) and has no balance guard by design. None of the four is cross-currency. A null/blank account is REFUSED (ACCOUNT_NOT_FOUND): no ledger-only row of these four types exists in either app mode. Idempotent on p_transaction_id. Gated client-side by VITE_ATOMIC_SINGLE_LEG.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. record_investment_trade — the account leg AND the trade row
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_investment_trade(
  p_transaction_id   TEXT,
  p_trade_id         TEXT,
  p_kind             TEXT,        -- buy | sell | dividend
  p_market_id        TEXT,
  p_symbol           TEXT,
  p_company_name     TEXT,
  p_quantity         NUMERIC,     -- 0 for dividend
  p_price_per_unit   NUMERIC,     -- 0 for dividend
  p_gross_amount     NUMERIC,     -- dividend gross; 0 for buy/sell
  p_fees             NUMERIC,
  p_account_id       TEXT,        -- source for a buy, destination otherwise
  p_amount           NUMERIC,     -- the ROW's amount, MARKET currency
  p_account_amount   NUMERIC,     -- what the ACCOUNT moves, account currency
  p_conversion_rate  NUMERIC,
  p_note             TEXT,
  p_category         TEXT,
  p_date             TIMESTAMPTZ,
  p_traded_at        TIMESTAMPTZ,
  p_trade_notes      TEXT,
  p_trade_created_at TIMESTAMPTZ,
  p_expected_balance NUMERIC,
  p_allow_negative   BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_acct         public.accounts%ROWTYPE;
  v_market       public.investment_markets%ROWTYPE;
  v_existing     public.transactions%ROWTYPE;
  v_symbol       TEXT;
  v_name         TEXT;
  v_qty          NUMERIC;
  v_price        NUMERIC;
  v_gross        NUMERIC;
  v_fees         NUMERIC;
  v_amount       NUMERIC;
  v_acct_amount  NUMERIC;
  v_delta        NUMERIC;
  v_new_bal      NUMERIC;
  v_src          TEXT := NULL;
  v_dest         TEXT := NULL;
  v_cross        BOOLEAN;
  v_created_at   TIMESTAMPTZ;
  v_traded_at    TIMESTAMPTZ;
  v_trade_made   TIMESTAMPTZ;
  -- The oversell replay
  v_pre_invalid  TEXT[] := ARRAY[]::TEXT[];
  v_held         NUMERIC;
  r              RECORD;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation ────────────────────────────────────────────────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;
  IF p_trade_id IS NULL OR length(trim(p_trade_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT' USING ERRCODE = 'P0001',
      DETAIL = 'every account-linked trade carries its own id';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('buy', 'sell', 'dividend') THEN
    RAISE EXCEPTION 'INVALID_KIND' USING ERRCODE = 'P0001',
      DETAIL = 'kind must be buy, sell or dividend';
  END IF;

  -- THE LEDGER GUARD. A trade "held outside Hisaab" (account_id NULL) is
  -- recorded by investmentStore.recordOutsideTrade — one trade row, no money
  -- row, no balance — and never reaches processTransaction. Accepting a null
  -- account here would create a second way to write one.
  IF p_account_id IS NULL OR length(trim(p_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'an account-linked trade requires an account; outside trades belong to investmentStore.recordOutsideTrade';
  END IF;

  IF p_expected_balance IS NULL THEN
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
      DETAIL = 'the account has no expected balance';
  END IF;

  v_symbol := upper(trim(COALESCE(p_symbol, '')));
  IF length(v_symbol) = 0 THEN
    RAISE EXCEPTION 'INVALID_SYMBOL' USING ERRCODE = 'P0001',
      DETAIL = 'symbol is required (investmentStore normalises it to upper case)';
  END IF;

  -- ── validateTradeInput (src/lib/investmentMath.ts:191-210), re-run ───────
  -- Same order, same messages' meaning, same rules. The magnitude ceiling is
  -- assertInputAmountsInBounds' half of the pair.
  v_fees  := COALESCE(p_fees, 0);
  v_qty   := COALESCE(p_quantity, 0);
  v_price := COALESCE(p_price_per_unit, 0);
  v_gross := COALESCE(p_gross_amount, 0);

  IF v_fees = 'NaN'::NUMERIC OR v_fees < 0 OR v_fees >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
      DETAIL = 'fees cannot be negative';
  END IF;

  IF p_kind = 'dividend' THEN
    IF v_gross = 'NaN'::NUMERIC OR v_gross <= 0 OR v_gross >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'dividend amount must be more than zero';
    END IF;
    IF v_gross - v_fees <= 0 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'fees cannot exceed the dividend amount';
    END IF;
    -- The investment_trades CHECK demands exactly this shape for a dividend.
    IF v_qty <> 0 OR v_price <> 0 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'a dividend carries no quantity and no price';
    END IF;
  ELSE
    IF v_qty = 'NaN'::NUMERIC OR v_qty <= 0 OR v_qty >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'quantity must be more than zero';
    END IF;
    IF v_price = 'NaN'::NUMERIC OR v_price < 0 OR v_price >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'price cannot be negative';
    END IF;
    IF v_gross <> 0 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'a buy or sell carries no gross amount (its total derives from qty x price)';
    END IF;
    IF p_kind = 'sell' AND v_qty * v_price - v_fees < 0 THEN
      RAISE EXCEPTION 'INVALID_TRADE' USING ERRCODE = 'P0001',
        DETAIL = 'fees cannot exceed the sale proceeds';
    END IF;
  END IF;

  -- ── The market. Immutable to this function, so it is read, never locked. ─
  SELECT * INTO v_market FROM public.investment_markets
   WHERE id = p_market_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKET_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'market is unknown, deleted, or not yours';
  END IF;

  -- ── The cash amount, per kind (transactionStore.ts:3305-3308, :3396) ─────
  IF p_kind = 'buy' THEN
    v_amount := round(round(v_qty * v_price, 2) + v_fees, 2);
  ELSIF p_kind = 'sell' THEN
    v_amount := round(round(v_qty * v_price, 2) - v_fees, 2);
  ELSE
    v_amount := round(v_gross - v_fees, 2);
  END IF;

  IF v_amount < 0 OR v_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'the derived cash amount is out of bounds';
  END IF;

  IF p_amount IS NULL
     OR p_amount = 'NaN'::NUMERIC
     OR abs(round(p_amount, 2) - v_amount) > 0.01 THEN
    RAISE EXCEPTION 'TRADE_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = 'client said ' || COALESCE(p_amount::TEXT, '<null>')
               || ', the server derives ' || v_amount::TEXT;
  END IF;

  -- ══ LOCK: the one account row, before any write. ════════════════════════
  PERFORM 1 FROM public.accounts
   WHERE id = ANY(ARRAY[p_account_id])
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> ('investment_' || p_kind) THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_bal FROM public.accounts
     WHERE id = p_account_id AND user_id = v_uid;

    RETURN jsonb_build_object(
      'status',          'ok',
      'replay',          true,
      'transaction_id',  v_existing.id,
      -- The trade the FIRST call minted, not the id this retry generated. A
      -- retry can never produce a second trade for one payment.
      'trade_id',        v_existing.related_investment_id,
      'kind',            p_kind,
      'symbol',          v_symbol,
      'account_id',      COALESCE(v_existing.source_account_id, v_existing.destination_account_id),
      'account_balance', v_new_bal,
      'account_delta',   0,
      'amount',          v_existing.amount,
      'currency',        v_existing.currency,
      'conversion_rate', v_existing.conversion_rate,
      'created_at',      v_existing.created_at,
      'row_deleted',     (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- investmentTradesDb.add is an UPSERT, so on the legacy path a repeated trade
  -- id silently overwrites a live trade — and with it the position that trade
  -- produced. Refuse instead. (Soft-deleted rows count: the id is the primary
  -- key either way, and a resurrected trade is not what this call means.)
  IF EXISTS (SELECT 1 FROM public.investment_trades WHERE id = p_trade_id) THEN
    RAISE EXCEPTION 'TRADE_ID_COLLISION' USING ERRCODE = 'P0001',
      DETAIL = 'that trade id already exists';
  END IF;

  -- ── Load the account (lock already held) ────────────────────────────────
  SELECT * INTO v_acct FROM public.accounts
   WHERE id = p_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'account is unknown, deleted, or not yours';
  END IF;

  -- ── THE OVERSELL GUARD — the server half of simulateTimeline. ───────────
  -- It runs BEFORE the compare-and-swap and before every write, exactly as the
  -- branch runs it before any money moves.
  IF p_kind = 'sell' THEN
    -- Pass 1: which stored sells are ALREADY invalid. computePosition skips
    -- them, so simulateTimeline must not count them as new violations —
    -- historical bad-sync residue cannot lock the user out of a valid entry.
    v_held := 0;
    FOR r IN
      SELECT id, kind, quantity
        FROM public.investment_trades
       WHERE user_id = v_uid AND market_id = v_market.id
         AND symbol = v_symbol AND deleted_at IS NULL
       ORDER BY traded_at,
                CASE kind WHEN 'buy' THEN 0 WHEN 'dividend' THEN 1 ELSE 2 END,
                created_at, id
    LOOP
      IF r.kind = 'buy' THEN
        v_held := v_held + r.quantity;
      ELSIF r.kind = 'sell' THEN
        IF r.quantity > v_held + 1e-9 THEN
          v_pre_invalid := v_pre_invalid || r.id;
          CONTINUE;
        END IF;
        v_held := v_held - r.quantity;
      END IF;
      -- dividends never touch quantity
    END LOOP;

    -- Pass 2: the same timeline with the candidate inserted at its own place.
    v_traded_at := COALESCE(p_traded_at, now());
    v_held := 0;
    FOR r IN
      SELECT id, kind, quantity FROM (
        SELECT id, kind, quantity, traded_at,
               CASE kind WHEN 'buy' THEN 0 WHEN 'dividend' THEN 1 ELSE 2 END AS ord,
               created_at
          FROM public.investment_trades
         WHERE user_id = v_uid AND market_id = v_market.id
           AND symbol = v_symbol AND deleted_at IS NULL
        UNION ALL
        SELECT p_trade_id, 'sell', v_qty, v_traded_at, 2,
               COALESCE(p_trade_created_at, now())
      ) t
      ORDER BY traded_at, ord, created_at, id
    LOOP
      IF r.kind = 'buy' THEN
        v_held := v_held + r.quantity;
      ELSIF r.kind = 'sell' THEN
        IF r.quantity > v_held + 1e-9 THEN
          IF r.id = ANY(v_pre_invalid) THEN CONTINUE; END IF;
          RAISE EXCEPTION 'INSUFFICIENT_HOLDINGS' USING
            ERRCODE = 'P0001',
            DETAIL  = jsonb_build_object(
              'symbol',    v_symbol,
              'trade_id',  r.id,
              'held',      v_held,
              'attempted', r.quantity
            )::TEXT;
        END IF;
        v_held := v_held - r.quantity;
      END IF;
    END LOOP;
  END IF;

  -- ── The account leg, and the third currency convention ──────────────────
  -- buy: the branch converts only when the currencies differ AND the cash is
  -- non-zero (a bonus-share entry at price 0 needs no rate). sell: identical.
  -- dividend: the currency test alone (:3420).
  IF p_kind = 'dividend' THEN
    v_cross := (v_acct.currency <> v_market.currency);
  ELSE
    v_cross := (v_acct.currency <> v_market.currency AND v_amount > 0);
  END IF;

  IF v_cross THEN
    IF p_conversion_rate IS NULL THEN
      RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = 'the account and the market are in different currencies';
    END IF;
    -- Mirrors src/lib/conversionMath.ts RATE_MIN/RATE_MAX (rateIsSane) and the
    -- transactions_conversion_rate_bounded CHECK, so a rate the client would
    -- reject cannot be posted around it.
    IF p_conversion_rate = 'NaN'::NUMERIC
       OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
      RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
        DETAIL = 'rate must be between 0.0001 and 100000';
    END IF;
    IF p_kind = 'buy' THEN
      -- DIVIDE — rate is market-per-account (:3352). The goal_contribution
      -- shape, and the OPPOSITE of the sell/dividend one three lines below.
      v_acct_amount := round(v_amount / p_conversion_rate, 2);
    ELSE
      -- MULTIPLY — rate is account-per-market (:3371, :3425).
      v_acct_amount := round(v_amount * p_conversion_rate, 2);
    END IF;
  ELSE
    IF p_conversion_rate IS NOT NULL THEN
      RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
        DETAIL = 'the account and the market share a currency (or the entry moves no cash)';
    END IF;
    v_acct_amount := v_amount;
  END IF;

  IF p_account_amount IS NULL
     OR p_account_amount = 'NaN'::NUMERIC
     OR abs(round(p_account_amount, 2) - v_acct_amount) > 0.01 THEN
    RAISE EXCEPTION 'ACCOUNT_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = 'client said ' || COALESCE(p_account_amount::TEXT, '<null>')
               || ', the server derives ' || v_acct_amount::TEXT;
  END IF;

  IF p_kind = 'buy' THEN
    v_delta := -v_acct_amount;
    v_src   := v_acct.id;
  ELSE
    v_delta := v_acct_amount;
    v_dest  := v_acct.id;
  END IF;

  -- ── Optimistic lock ─────────────────────────────────────────────────────
  IF round(v_acct.balance, 2) <> round(p_expected_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_acct.id,
        'account_balance',          v_acct.balance,
        'expected_account_balance', p_expected_balance
      )::TEXT;
  END IF;

  -- ── Insufficient-balance guard — BUYS ONLY, and STRICT. ─────────────────
  -- 'investment_*' is absent from isSimpleModeBalanceBypassAllowed, so the
  -- branch uses `checkBalance`, not checkBalanceForTransaction: there is no
  -- ledger bypass to reproduce. p_allow_negative exists for the future repair
  -- queue and the client always sends false. A SELL or a DIVIDEND is a credit
  -- and is never guarded.
  IF p_kind = 'buy'
     AND NOT COALESCE(p_allow_negative, false)
     AND v_acct.balance < v_acct_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_acct.id,
        'account_name', v_acct.name,
        'account_type', v_acct.type,
        'currency',     v_acct.currency,
        'available',    v_acct.balance,
        'requested',    v_acct_amount
      )::TEXT;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════
  v_created_at := COALESCE(p_date, now());
  v_traded_at  := COALESCE(p_traded_at, now());
  v_trade_made := COALESCE(p_trade_created_at, now());
  -- A dividend carries no company name (transactionStore.ts:3407 writes '').
  v_name := CASE WHEN p_kind = 'dividend' THEN ''
                 ELSE trim(COALESCE(p_company_name, '')) END;

  -- 1. The balance.
  UPDATE public.accounts
     SET balance = balance + v_delta
   WHERE id = v_acct.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_bal;

  IF v_new_bal IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the account disappeared mid-trade';
  END IF;

  -- 2. The trade. EXACTLY investmentTradesDb.add's payload, read back the same
  --    way by mapInvestmentTrade. quantity/price are 0 for a dividend and
  --    `amount` is 0 for a buy/sell — the table's own CHECK enforces the pair,
  --    and getting it wrong here would fail the INSERT rather than corrupt a
  --    position, which is the right failure.
  INSERT INTO public.investment_trades (
    id, user_id, market_id, symbol, name, kind,
    quantity, price_per_unit, amount, fees,
    account_id, transaction_id, traded_at, notes, created_at, deleted_at
  ) VALUES (
    p_trade_id, v_uid, v_market.id, v_symbol, v_name, p_kind,
    CASE WHEN p_kind = 'dividend' THEN 0 ELSE v_qty END,
    CASE WHEN p_kind = 'dividend' THEN 0 ELSE v_price END,
    CASE WHEN p_kind = 'dividend' THEN v_gross ELSE 0 END,
    v_fees,
    v_acct.id, p_transaction_id, v_traded_at, COALESCE(p_trade_notes, ''),
    v_trade_made, NULL
  );

  -- 3. The row. `related_investment_id` is the O(1) link back to the trade
  --    (supabase-migration-investments.sql:78-85) and is what
  --    investmentStore.deleteTrade walks to reverse the money.
  INSERT INTO public.transactions (
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    related_investment_id,
    conversion_rate, category, notes, created_at,
    is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
  ) VALUES (
    p_transaction_id, v_uid, 'investment_' || p_kind,
    v_amount, v_market.currency,
    v_src, v_dest,
    NULL, NULL, NULL, NULL,
    p_trade_id,
    p_conversion_rate, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',          'ok',
    'replay',          false,
    'transaction_id',  p_transaction_id,
    'trade_id',        p_trade_id,
    'kind',            p_kind,
    'symbol',          v_symbol,
    'account_id',      v_acct.id,
    'account_balance', v_new_bal,
    'account_delta',   v_delta,
    'amount',          v_amount,
    'currency',        v_market.currency,
    'conversion_rate', p_conversion_rate,
    'traded_at',       v_traded_at,
    'trade_created_at',v_trade_made,
    'created_at',      v_created_at,
    'row_deleted',     false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_investment_trade(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_investment_trade(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.record_investment_trade(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT, TIMESTAMPTZ, NUMERIC, BOOLEAN
) IS
  'Audit L4 step 5 (MF-01 / O-1 / F-4): an account-linked investment trade — the account balance leg, the investment_trades row AND the transactions row — as ONE Postgres transaction. Positions in this product are DERIVED by replaying the trade ledger (there is no holdings table), so a drop between the balance and the trade row loses the position outright: shares paid for that nobody holds, or sold shares that can be sold again. Re-derives the cash amount per kind (buy capitalises fees, sell and dividend net them) and the account movement per the THIRD asymmetric currency convention in this engine (buy DIVIDES, sell and dividend MULTIPLY), refusing a client figure that disagrees by more than 0.01. Re-runs validateTradeInput and the full simulateTimeline oversell replay server-side, including backdated sells and the skip-already-invalid rule (INSUFFICIENT_HOLDINGS). A null account is REFUSED — trades held outside Hisaab belong to investmentStore.recordOutsideTrade. Idempotent on p_transaction_id, and a repeated trade id is refused (TRADE_ID_COLLISION) rather than upserted over a live trade. Gated client-side by VITE_ATOMIC_INVEST.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. apply_goal_saved_delta — the goal twin of
--            apply_loan_remaining_delta (doc §23 item 6)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_goal_saved_delta(
  p_goal_id        TEXT,
  p_delta          NUMERIC,
  p_expected_saved NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_found     BOOLEAN;
  v_before    NUMERIC;
  v_new_saved NUMERIC;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF p_goal_id IS NULL OR length(trim(p_goal_id)) = 0
     OR p_delta IS NULL OR p_delta = 'NaN'::NUMERIC
     OR abs(p_delta) >= 1e12
     OR p_expected_saved IS NULL OR p_expected_saved = 'NaN'::NUMERIC THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT' USING ERRCODE = 'P0001',
      DETAIL = 'goal id, a finite delta and an expected saved amount are all required';
  END IF;

  -- Existence probe first, so "gone / not yours" is reported as its own error
  -- instead of masquerading as a lost-update conflict the client would retry.
  -- CORRECTION (step 4's #2, still true): `goals` has no deleted_at, so there
  -- is no soft-delete predicate to add. SECTION 0 warns if that ever changes.
  SELECT true, saved_amount INTO v_found, v_before
    FROM public.goals
   WHERE id = p_goal_id AND user_id = v_uid
     FOR UPDATE;

  IF v_found IS NULL THEN
    RAISE EXCEPTION 'GOAL_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'goal is unknown or not yours';
  END IF;

  -- Compare-and-swap. Byte-for-byte goalStore.addContribution's expression
  --   Math.max(0, Math.round((savedAmount + amount) * 100) / 100)
  -- (the SUM is rounded, not the addend) and the same clamp at zero that makes
  -- a negative delta safe. The conflict token is BALANCE_CONFLICT, matching
  -- contribute_to_goal — the client already has a ladder for it, and step 4
  -- decided deliberately not to mint a GOAL_SAVED_CONFLICT.
  UPDATE public.goals
     SET saved_amount = GREATEST(0, round(saved_amount + p_delta, 2))
   WHERE id = p_goal_id
     AND user_id = v_uid
     AND round(saved_amount, 2) = round(p_expected_saved, 2)
  RETURNING saved_amount INTO v_new_saved;

  IF v_new_saved IS NULL THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'goal_id',               p_goal_id,
        'goal_saved_amount',     v_before,
        'expected_saved_amount', p_expected_saved
      )::TEXT;
  END IF;

  RETURN jsonb_build_object(
    'status',            'ok',
    'goal_id',           p_goal_id,
    'goal_saved_amount', v_new_saved,
    -- What the GOAL actually moved. Differs from p_delta when the clamp bit —
    -- which is reachable on the compensation path, where the delta is negative.
    'goal_applied',      round(v_new_saved - v_before, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_goal_saved_delta(TEXT, NUMERIC, NUMERIC)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_goal_saved_delta(TEXT, NUMERIC, NUMERIC)
  TO authenticated;

COMMENT ON FUNCTION public.apply_goal_saved_delta(TEXT, NUMERIC, NUMERIC) IS
  'Audit L4 step 5 (doc section 23 item 6): the goal twin of apply_loan_remaining_delta — a compare-and-swap on goals.saved_amount. Step 4 gave the FORWARD goal write a CAS inside contribute_to_goal; the compensation that reverses it still went through goalsDb.update, an unlocked read-modify-write that can clobber a contribution made on another device while the rollback is in flight. Clamp and 2dp are byte-for-byte goalStore.addContribution. The conflict token is BALANCE_CONFLICT, matching contribute_to_goal. The client (transactionStore.atomicGoalSavedDelta) retries once against a fresh expectation and then FALLS BACK to the legacy unlocked write: a rollback that refuses to run would be strictly worse than one that races.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. VERIFICATION — read-only, safe to re-run at any time
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. The three functions exist with the expected signatures, are SECURITY
--     DEFINER, and pin their search_path.
--     EXPECT: three rows; security_definer = t; config contains search_path=public.
SELECT p.proname,
       p.prosecdef                               AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.proconfig                               AS config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('record_single_leg_entry', 'record_investment_trade',
                     'apply_goal_saved_delta')
 ORDER BY p.proname;

-- V2. Privileges: authenticated may execute all three; anon and PUBLIC may not.
--     EXPECT: t / f, t / f, t / f.
SELECT has_function_privilege('authenticated',
         'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)',
         'EXECUTE') AS leg_auth_can,
       has_function_privilege('anon',
         'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)',
         'EXECUTE') AS leg_anon_can,
       has_function_privilege('authenticated',
         'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)',
         'EXECUTE') AS inv_auth_can,
       has_function_privilege('anon',
         'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)',
         'EXECUTE') AS inv_anon_can,
       has_function_privilege('authenticated',
         'public.apply_goal_saved_delta(text,numeric,numeric)', 'EXECUTE') AS goal_auth_can,
       has_function_privilege('anon',
         'public.apply_goal_saved_delta(text,numeric,numeric)', 'EXECUTE') AS goal_anon_can;

-- V3. Body roll-call — the invariants this file exists to install.
--     EXPECT: every column t.
SELECT (l LIKE '%FOR UPDATE%')                          AS leg_takes_row_lock,
       (l LIKE '%ORDER BY id%')                         AS leg_locks_in_id_order,
       (l LIKE '%BALANCE_CONFLICT%')                    AS leg_has_cas,
       (l LIKE '%NOTHING_TO_CORRECT%')                  AS leg_refuses_noop_adjustment,
       (l LIKE '%INSUFFICIENT_BALANCE%')                AS leg_guards_expense,
       (l LIKE '%ACCOUNT_NOT_FOUND%')                   AS leg_refuses_null_account,
       (l LIKE '%user_id = v_uid%')                     AS leg_owner_scoped,
       (i LIKE '%FOR UPDATE%')                          AS inv_takes_row_lock,
       (i LIKE '%ORDER BY id%')                         AS inv_locks_in_id_order,
       (i LIKE '%BALANCE_CONFLICT%')                    AS inv_has_cas,
       (i LIKE '%INSUFFICIENT_HOLDINGS%')               AS inv_guards_oversell,
       (i LIKE '%v_pre_invalid%')                       AS inv_skips_already_invalid_sells,
       (i LIKE '%TRADE_ID_COLLISION%')                  AS inv_refuses_trade_id_reuse,
       (i LIKE '%INSERT INTO public.investment_trades%')AS inv_writes_the_trade,
       (i LIKE '%INSERT INTO public.transactions%')     AS inv_writes_the_row,
       (i LIKE '%user_id = v_uid%')                     AS inv_owner_scoped,
       (g LIKE '%FOR UPDATE%')                          AS goal_takes_row_lock,
       (g LIKE '%BALANCE_CONFLICT%')                    AS goal_has_cas,
       (g LIKE '%GREATEST(0, round(saved_amount + p_delta, 2))%') AS goal_clamp_matches_client
  FROM (SELECT pg_get_functiondef(
          'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)'::regprocedure) AS l,
               pg_get_functiondef(
          'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)'::regprocedure) AS i,
               pg_get_functiondef(
          'public.apply_goal_saved_delta(text,numeric,numeric)'::regprocedure) AS g
       ) s;

-- V4. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_l  TEXT;
  v_i  TEXT;
  v_g  TEXT;
  v_ls CONSTANT TEXT :=
    'public.record_single_leg_entry(text,text,text,numeric,numeric,text,text,timestamptz,numeric,boolean)';
  v_is CONSTANT TEXT :=
    'public.record_investment_trade(text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,text,timestamptz,timestamptz,text,timestamptz,numeric,boolean)';
  v_gs CONSTANT TEXT := 'public.apply_goal_saved_delta(text,numeric,numeric)';
BEGIN
  IF to_regprocedure(v_ls) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: record_single_leg_entry is missing';
  END IF;
  IF to_regprocedure(v_is) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: record_investment_trade is missing';
  END IF;
  IF to_regprocedure(v_gs) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: apply_goal_saved_delta is missing';
  END IF;

  v_l := pg_get_functiondef(v_ls::regprocedure);
  v_i := pg_get_functiondef(v_is::regprocedure);
  v_g := pg_get_functiondef(v_gs::regprocedure);

  IF v_l NOT LIKE '%FOR UPDATE%' OR v_i NOT LIKE '%FOR UPDATE%'
     OR v_g NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: the row locks are gone — concurrent writes can now interleave';
  END IF;
  IF v_l NOT LIKE '%ORDER BY id%' OR v_i NOT LIKE '%ORDER BY id%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: the ascending-id lock order is gone — these can now deadlock against transfer_between_accounts';
  END IF;
  IF v_l NOT LIKE '%BALANCE_CONFLICT%' OR v_i NOT LIKE '%BALANCE_CONFLICT%'
     OR v_g NOT LIKE '%BALANCE_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: a compare-and-swap is gone — a lost update is reachable again';
  END IF;
  IF v_l NOT LIKE '%NOTHING_TO_CORRECT%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: the adjustment no-op guard is gone — a correction to an already-correct balance would write a row for a movement of zero';
  END IF;
  IF v_i NOT LIKE '%INSUFFICIENT_HOLDINGS%' OR v_i NOT LIKE '%v_pre_invalid%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: the oversell replay is gone — a sell can now exceed the shares held (shares minted)';
  END IF;
  IF v_i NOT LIKE '%TRADE_ID_COLLISION%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: the trade-id guard is gone — a repeated id would overwrite a live trade and the position it produced';
  END IF;
  IF v_i NOT LIKE '%INSERT INTO public.investment_trades%'
     OR v_i NOT LIKE '%INSERT INTO public.transactions%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: record_investment_trade no longer writes BOTH artifacts — the whole point of the function';
  END IF;
  IF v_g NOT LIKE '%GREATEST(0, round(saved_amount + p_delta, 2))%' THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: apply_goal_saved_delta no longer matches goalStore.addContribution''s clamp';
  END IF;

  IF NOT has_function_privilege('authenticated', v_ls, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_is, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_gs, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: authenticated cannot execute all three functions';
  END IF;
  IF has_function_privilege('anon', v_ls, 'EXECUTE')
     OR has_function_privilege('anon', v_is, 'EXECUTE')
     OR has_function_privilege('anon', v_gs, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-investments-and-single-leg: anon can execute one of the functions';
  END IF;

  RAISE NOTICE 'p3-atomic-investments-and-single-leg: verification passed';
END;
$$;

-- V5. DRIFT WATCH #1 — a single-leg row with NO account.
--     There is no ledger-only income / expense / opening_balance / adjustment
--     in this product (see BOTH APP MODES in the header). A row here means
--     either a writer nobody has traced or a restored backup that lost its
--     account ids — and it is unreadable money either way.
--     EXPECT: zero rows, before and after.
SELECT t.id, t.created_at, t.type, t.amount, t.currency
  FROM public.transactions t
 WHERE t.type IN ('income', 'expense', 'opening_balance', 'adjustment')
   AND t.deleted_at IS NULL
   AND t.source_account_id IS NULL
   AND t.destination_account_id IS NULL
 ORDER BY t.created_at DESC;

-- V6. DRIFT WATCH #2 — a single-leg row with BOTH accounts, or a cross-currency
--     one. Neither is expressible by any of the four branches: they set exactly
--     one leg and take the currency from that account, never converting.
--     EXPECT: zero rows, before and after.
SELECT t.id, t.created_at, t.type,
       t.source_account_id, t.destination_account_id, t.conversion_rate,
       CASE
         WHEN t.source_account_id IS NOT NULL AND t.destination_account_id IS NOT NULL
           THEN 'a single-leg entry touching two accounts'
         ELSE 'a single-leg entry carrying a conversion rate'
       END AS problem
  FROM public.transactions t
 WHERE t.type IN ('income', 'expense', 'opening_balance', 'adjustment')
   AND t.deleted_at IS NULL
   AND ((t.source_account_id IS NOT NULL AND t.destination_account_id IS NOT NULL)
        OR t.conversion_rate IS NOT NULL)
 ORDER BY t.created_at DESC;

-- V7. DRIFT WATCH #3 — THE LOST-TRADE SIGNATURE. An account-linked investment
--     row whose trade is missing, or a trade whose money row is missing. This
--     is EXACTLY the failure the RPC exists to make impossible: under the
--     legacy path the balance leg commits first, so a drop leaves the money row
--     without its trade (or, on the delete path, the reverse).
--     Rows here are HISTORY. Know the number BEFORE the flag goes on so any
--     post-rollout row is unambiguous.
--     EXPECT: a stable number; zero NEW rows after the flag.
SELECT t.id            AS transaction_id,
       t.type, t.created_at, t.amount, t.currency,
       t.related_investment_id,
       'a money row whose trade does not exist' AS problem
  FROM public.transactions t
 WHERE t.type IN ('investment_buy', 'investment_sell', 'investment_dividend')
   AND t.deleted_at IS NULL
   AND (t.related_investment_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.investment_trades tr
                        WHERE tr.id = t.related_investment_id
                          AND tr.deleted_at IS NULL))
UNION ALL
SELECT tr.transaction_id, tr.kind, tr.created_at, tr.amount, '', tr.id,
       'an account-linked trade whose money row does not exist'
  FROM public.investment_trades tr
 WHERE tr.deleted_at IS NULL
   AND tr.account_id IS NOT NULL
   AND (tr.transaction_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.transactions t2
                        WHERE t2.id = tr.transaction_id
                          AND t2.deleted_at IS NULL))
 ORDER BY created_at DESC;

-- V8. DRIFT WATCH #4 — THE OVERSOLD POSITION. Replays every (market, symbol)
--     timeline the way investmentMath.computePosition does and reports the ones
--     that end BELOW zero. A negative holding is unreachable through the UI
--     (simulateTimeline refuses it) and now unreachable through the RPC too, so
--     a row here is bad-sync residue or a hand-written INSERT.
--     EXPECT: zero rows, before and after.
WITH ordered AS (
  SELECT tr.user_id, tr.market_id, tr.symbol, tr.kind, tr.quantity,
         row_number() OVER (
           PARTITION BY tr.user_id, tr.market_id, tr.symbol
           ORDER BY tr.traded_at,
                    CASE tr.kind WHEN 'buy' THEN 0 WHEN 'dividend' THEN 1 ELSE 2 END,
                    tr.created_at, tr.id) AS seq
    FROM public.investment_trades tr
   WHERE tr.deleted_at IS NULL
)
SELECT user_id, market_id, symbol,
       round(sum(CASE kind WHEN 'buy' THEN quantity
                           WHEN 'sell' THEN -quantity
                           ELSE 0 END), 8) AS net_quantity
  FROM ordered
 GROUP BY user_id, market_id, symbol
HAVING sum(CASE kind WHEN 'buy' THEN quantity
                     WHEN 'sell' THEN -quantity
                     ELSE 0 END) < -1e-9
 ORDER BY net_quantity;

-- V9. DRIFT WATCH #5 — the goal-accounting signature, restated for step 5.
--     Step 4's V6 covers the forward write; this is the same query, and the
--     reason it is repeated here is that the COMPENSATION was the remaining
--     unlocked writer of this column. Zero NEW rows after the flag.
SELECT g.id, g.title, g.currency,
       g.saved_amount,
       round(COALESCE(sum(t.amount), 0), 2)                  AS contributions_recorded,
       round(g.saved_amount - COALESCE(sum(t.amount), 0), 2) AS gap
  FROM public.goals g
  LEFT JOIN public.transactions t
         ON t.related_goal_id = g.id
        AND t.type = 'goal_contribution'
        AND t.deleted_at IS NULL
 GROUP BY g.id, g.title, g.currency, g.saved_amount
HAVING abs(g.saved_amount - COALESCE(sum(t.amount), 0)) > 0.01
 ORDER BY abs(g.saved_amount - COALESCE(sum(t.amount), 0)) DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Manual authenticated QA (run as a normal signed-in account).
--            The automated equivalent is supabase/tests/tests/
--            7z-atomic-investments-single-leg.sql — run `bash
--            supabase/tests/run.sh` instead of doing this by hand unless you
--            are smoking a real PostgREST session, which the harness cannot.
-- ═══════════════════════════════════════════════════════════════════════════
--
--   1. A plain expense:
--        select record_single_leg_entry('t1','expense','<acct>',100,null,
--          'chai','Food',now(),<balance>,false);
--      → balance − 100, one row, source set and destination NULL.
--
--   2. The same call again → {"replay": true}, and the balance does NOT move
--      a second time.
--
--   3. An adjustment to the balance it already has → NOTHING_TO_CORRECT.
--
--   4. A buy: record_investment_trade(...) with kind 'buy' → the wallet drops
--      by qty × price + fees, one investment_trades row, one transactions row
--      carrying related_investment_id.
--
--   5. A sell of more shares than the symbol holds → INSUFFICIENT_HOLDINGS,
--      and NOTHING is written (check the balance and both tables).
--
--   6. apply_goal_saved_delta('<goal>', -50, <current saved>) → the goal drops
--      by 50; call it again with the SAME expectation → BALANCE_CONFLICT.
--
--   7. As `anon`, every one of the three → permission denied.
--
-- ═══════════════════════════════════════════════════════════════════════════
