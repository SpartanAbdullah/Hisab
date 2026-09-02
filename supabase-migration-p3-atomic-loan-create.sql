-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 / L4 STEP 3: creating a loan (`loan_given` / `loan_taken`)
-- becomes ONE Postgres transaction (`create_loan_with_leg`).
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER
--   AFTER  supabase-migration-prelaunch-hardening.sql        (#18 in docs/audit-2026-09/APPLY-ORDER.md)
--            ^ apply_account_balance_delta (the account CAS contract mirrored
--              here) and the accounts/transactions FKs.
--   AFTER  supabase-migration-audit-p0-loan-concurrency.sql
--            ^ not called, but its LOAN_* token vocabulary is reused so the
--              client's existing ladders keep working.
--   AFTER  supabase-migration-p1-money-bounds.sql
--            ^ the CHECK constraints this RPC's own validation mirrors
--              (amount >= 0 AND < 1e12; loans_remaining_not_over_total;
--               emi_schedules_amount_bounded; installment_number 1..1200;
--               the eight-currency whitelist).
--   AFTER  supabase-migration-p3-atomic-transfer.sql   (step 1)
--   AFTER  supabase-migration-p3-atomic-repayment.sql  (step 2)
--            ^ neither is a hard dependency, but the three are one rollout and
--              this file copies their error contract verbatim.
--   Also requires (all in the historical set, long applied):
--     supabase-schema.sql                      accounts, transactions, loans,
--                                              emi_schedules
--     supabase-migration-phase1-persons.sql    transactions.person_id,
--                                              loans.person_id
--     supabase-migration-reconciliation.sql    is_reconciled/reconciled_at/by
--     supabase-migration-receipts.sql          transactions.receipt_path
--     supabase-migration-incremental-sync-core.sql        updated_at (+trigger)
--     supabase-migration-incremental-sync-tombstones.sql  deleted_at
--   Section 0 hard-checks every one of those columns and ABORTS with a named
--   message rather than creating a function that would fail at runtime.
--
--   SAFE AHEAD OF THE CLIENT. This file only ADDS one function. Nothing calls
--   it until a build ships with VITE_ATOMIC_LOAN_CREATE=true
--   (src/stores/transactionStore.ts, `ATOMIC_LOAN_CREATE_ENABLED`), which is
--   FALSE by default.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES — the evidence
-- ────────────────────────────────────────────────────────────────────────────
-- docs/audit-2026-09/07-mobile-first.md  MF-01 (high, borderline critical):
--   money left half-moved server-side on a flaky network; the compensation and
--   the refetch die in the same outage; the outbox that would repair it is
--   inert.  Fix (L): "move multi-leg money moves into single SECURITY DEFINER
--   RPCs so atomicity lives in Postgres."
-- docs/audit-2026-09/12-qa-review.md  O-1 / F-4 (high):
--   "permanent half-applied money … with no repair queue and no persisted
--    marker."
-- docs/audit-2026-09/02-repository-architecture.md  H-3 / H-4,
-- docs/audit-2026-09/00-executive-summary.md  M1 / L4 — this is branch #4 in
--   the order table of docs/server-side-money-engine.md §6.
--
-- Loan CREATION is the first branch whose legs span two tables in the
-- *creation* direction — it does not just move money, it brings a new
-- obligation into existence:
--
--   loan_given (2 legs)
--     1. apply_account_balance_delta(source, −amount, expected)  — commits
--     2. loans INSERT                                            — TIMES OUT
--     3. transactions INSERT                                     — never runs
--   Server truth: the money left the wallet, there is no loan saying who owes
--   it, and no row saying it ever happened. The user's cash is simply gone.
--
--   loan_taken as a CREDIT-CARD CASH ADVANCE (4 legs)
--     1. apply_account_balance_delta(card, −amount, expected)     — commits
--     2. apply_account_balance_delta(destination, +amount, exp.)  — TIMES OUT
--     3. loans INSERT                                             — never runs
--     4. transactions INSERT                                      — never runs
--   Server truth: the card's available credit dropped and the cash arrived
--   nowhere — the MF-01 shape exactly, with a phantom card charge on top.
--
-- The inverse of leg 1 has to travel the same dead connection that killed leg
-- 2 (src/lib/mutationSafety.ts:10-13 says so in its own header), so no client
-- pattern closes this. A transaction boundary does.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ARTIFACT CONTRACT — what the CLIENT leaves behind today, and what this
-- RPC must reproduce EXACTLY.
-- Traced from src/stores/transactionStore.ts `case 'loan_given'` (:1536-1566)
-- and `case 'loan_taken'` (:1568-1607), trackedCreateLoan (:455-490),
-- trackedBalanceDelta (:321-325), the shared tail (:2032-2073), and every
-- helper they call.
-- ════════════════════════════════════════════════════════════════════════════
--
--  # | Artifact                      | Today (client, 2-4 remote round-trips)                                 | This RPC (1 transaction)
-- ---+-------------------------------+------------------------------------------------------------------------+------------------------------------------------
--  1 | accounts.balance (PRIMARY)    | loan_given  → trackedBalanceDelta(sourceAccountId, −amount)             | UPDATE accounts SET balance = balance + delta
--    |                               | loan_taken  → trackedBalanceDelta(destinationAccountId, +amount)       | after FOR UPDATE + expected-balance compare.
--    |                               | Both via apply_account_balance_delta (CAS, its own round-trip).        | Direction derived from p_type, never a flag.
--  2 | accounts.balance (CARD)       | loan_taken ONLY, and only when input.sourceAccountId is set:           | Second UPDATE, SAME transaction. Both account
--    |                               | trackedBalanceDelta(sourceAccountId, −amount) against a credit card.   | rows locked in ONE ascending-id statement.
--    |                               | Guarded client-side: type must be credit_card, currency must match the |
--    |                               | receiving account. SECOND round-trip, SECOND failure window.           |
--  3 | loans row                     | trackedCreateLoan → loansDb.add (UPSERT). Only when input.loanId is    | INSERT … the same 12 columns loansDb.add
--    |                               | ABSENT; when present the caller is attaching to an existing loan       | writes (:377-385), same values, same tx.
--    |                               | (ad-hoc splits, cash-advance re-entry) and nothing is created.         | p_create_loan says which.
--    |                               | THIRD round-trip.                                                      |
--  4 | emi_schedules rows            | NOT written here. AddLoanModal.tsx:173-174/195-196 and                 | Supported (p_emi) and re-validated, but the
--    |                               | QuickEntry.tsx:1205 call emiStore.generateSchedule AFTER               | SHIPPED CLIENT SENDS NULL — see the note
--    |                               | processTransaction resolves — a separate, unprotected write.           | below. Byte-for-byte parity today.
--  5 | transactions row              | trackedAddTransaction → transactionsDb.add (UPSERT), AFTER the switch  | INSERT … same 20 columns, same values, same tx
--  6 | Dexie mirror (transactions)   | mirrorPut(db.transactions, tx) + markMirrorStale('transactions')       | client-side, post-commit (unchanged)
--  7 | Dexie mirror (accounts)       | mirrorPut(db.accounts, updated) + markMirrorStale('accounts')          | client-side, post-commit (unchanged)
--  8 | Dexie mirror (loans)          | mirrorPut(db.loans, loan) + markMirrorStale('loans')                   | client-side, post-commit (unchanged)
--  9 | Zustand accounts/loans/       | set() inside the three stores                                          | client-side, post-commit (unchanged)
--    | transactions                  |                                                                        |
-- 10 | activity 'loan_created'       | inside trackedCreateLoan, try/catch → reportError. Best-effort.        | client-side, post-commit, best-effort
--    |                               | "Loan given to X: AED 500" / "Loan taken from X: AED 500"              | (unchanged — deliberately NOT in the RPC)
-- 11 | activity 'transaction_created'| logActivitySafe(description) AFTER runSafeMutation commits             | client-side, post-commit (unchanged)
-- 12 | reminder reschedule           | nudgeReminderSchedule() — fire-and-forget, native only                  | client-side, post-commit (unchanged)
--
-- Artifacts 6-12 stay client-side by design: local caches and a best-effort
-- audit trail. The repo's rule is that an activity-log failure must NEVER roll
-- back money that has moved (transactionStore.ts:2062-2069, logActivitySafe).
--
-- ── ARTIFACT 4: why the EMI schedule is server-CAPABLE but client-UNUSED ─────
-- The brief for this step assumed the loan_given/loan_taken branches write the
-- EMI schedule. THEY DO NOT. `emiStore.generateSchedule` is called by the PAGE
-- (src/pages/AddLoanModal.tsx:173-174 and :195-196, src/pages/QuickEntry.tsx
-- :1205) AFTER `processTransaction` has already resolved — outside the
-- MutationScope entirely. A failure there today leaves a funded loan with no
-- instalments and NOTHING is rolled back.
--
-- This function therefore accepts and fully validates a schedule (p_emi) and
-- inserts it in the same transaction, but the shipped client passes NULL, so
-- behaviour is byte-for-byte identical today. Moving the page's call into the
-- branch is a one-line client change once the page files are free; the server
-- half is already here and already tested. Recorded so nobody assumes the gap
-- is closed — it is closable, not closed.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BOTH APP MODES TRACED (tasks/lessons.md:6-13, :26-27)
-- ════════════════════════════════════════════════════════════════════════════
-- full_tracker  — the only mode that reaches this RPC. Exactly one or two
--                 account ids are non-null on the row:
--                   loan_given                → source_account_id set,
--                                               destination NULL
--                   loan_taken                → destination_account_id set,
--                                               source NULL
--                   loan_taken (cash advance) → BOTH set: source = the card,
--                                               destination = the receiver
--
-- splits_only   — LEDGER LOAN CREATION DOES NOT COME HERE AND IS UNTOUCHED.
--                 CONFIRMED, NOT ASSUMED: in ledger mode both entry points
--                 bypass processTransaction entirely and call
--                 src/stores/loanStore.ts `createLoan` directly —
--                   src/pages/AddLoanModal.tsx:164-165  `if (isLedgerOnlyMode)`
--                   src/pages/QuickEntry.tsx:750, :850  `if (isLedgerOnlyPersonFlow)`
--                 That path writes ONLY a loans row: no account leg (ledger
--                 mode has no accounts) and NO transactions row at all. Not one
--                 line of it changes, and it never calls this function.
--
--                 Consequently this RPC REFUSES a NULL/empty/unknown/foreign/
--                 soft-deleted account with ACCOUNT_NOT_FOUND. It does NOT
--                 accept a null account "for ledger mode", because no ledger
--                 path uses it — accepting one would create a second, silent
--                 way to write a loan, which is exactly the class of failure
--                 tasks/lessons.md records.
--
--                 One subtlety reproduced faithfully: 'loan_given' and
--                 'loan_taken' ARE both listed in
--                 isSimpleModeBalanceBypassAllowed (transactionStore.ts
--                 :249-257). A user who switched full_tracker → splits_only
--                 still HAS accounts, and for them checkBalanceForTransaction
--                 is a no-op, so an account may legitimately go negative. The
--                 client passes p_allow_negative = true in exactly that case,
--                 and only that case. Full tracker always passes false —
--                 byte-for-byte today's behaviour.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ERROR CONTRACT — only tokens the client ALREADY parses
-- ════════════════════════════════════════════════════════════════════════════
--   BALANCE_CONFLICT      bare token, byte-identical to
--                         apply_account_balance_delta
--                         (prelaunch-hardening.sql:270) and to
--                         transfer_between_accounts. DETAIL carries
--                         {account_id, account_balance, expected_account_balance}
--                         so the refetch-and-retry-once ladder needs no extra
--                         round-trip. Raised for EITHER account; the client's
--                         ladder refetches all of them anyway.
--   INSUFFICIENT_BALANCE  the server half of the client's
--                         checkBalanceForTransaction (transactionStore.ts
--                         :259-268). DETAIL carries {account_id, account_name,
--                         account_type, currency, available, requested} so the
--                         wrapper rebuilds the identical bilingual
--                         tStatic('err_insufficient') string.
--                         Escape: p_allow_negative = true (the splits_only
--                         bypass above, and the future repair queue).
--   LOAN_NOT_FOUND        same token and meaning as apply_loan_remaining_delta:
--                         the loan being ATTACHED to is unknown, soft-deleted,
--                         or not yours. The client turns it into
--                         tStatic('err_loan_gone') and never retries it.
--
-- Everything else is a poisoned payload or a programming error, unreachable
-- from the shipped client, and exists because ONE curl against PostgREST
-- bypasses every client guard: NOT_AUTHENTICATED, INVALID_TRANSACTION_ID,
-- INVALID_LOAN_ID, INVALID_LOAN_TYPE, INVALID_AMOUNT, INVALID_PERSON,
-- ACCOUNT_NOT_FOUND, SAME_ACCOUNT, EXPECTED_BALANCE_REQUIRED,
-- CURRENCY_MISMATCH, CONVERSION_RATE_NOT_APPLICABLE, INVALID_CASH_ADVANCE,
-- LOAN_ID_COLLISION, LOAN_MISMATCH, EMI_PLAN_INVALID, EMI_PLAN_MISMATCH,
-- EMI_ID_COLLISION, TRANSACTION_ID_COLLISION.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LOCKING
-- ════════════════════════════════════════════════════════════════════════════
-- Repo-wide rule (supabase-migration-audit-p0-settlement-row-locks.sql:73-100):
--   loans → accounts → emi_schedules, and WITHIN a table rows in ascending
--   `id` order.
--   1. SELECT … FROM loans    WHERE id = p_loan_id … FOR UPDATE   (only when
--      ATTACHING to an existing loan; a loan being created has no row to lock,
--      and its INSERT is itself the serialisation point via the primary key.)
--   2. SELECT … FROM accounts WHERE id = ANY(both ids) ORDER BY id FOR UPDATE
--      — ONE statement, so two concurrent cash advances over the same
--      card/account pair cannot invert their lock order, and a cash advance
--      racing a transfer over the same two accounts cannot deadlock with
--      transfer_between_accounts (which takes the same ascending-id order).
--   3. emi_schedules — INSERT only, and last. Nothing to lock.
-- It therefore cannot invert order against accept_linked_request /
-- accept_settlement_request (loans → accounts), apply_loan_remaining_delta
-- (loans only), apply_account_balance_delta / transfer_between_accounts
-- (accounts only), or record_loan_repayment (loans → accounts → emis).
--
-- ════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY
-- ════════════════════════════════════════════════════════════════════════════
-- The failure this file kills is "the call committed but the reply never
-- arrived". The transaction id is generated client-side (uuid v4,
-- transactionStore.ts:1321) and is the primary key of `transactions`, so it is
-- the natural idempotency key. After taking the row locks — so two in-flight
-- copies of the same retry serialise rather than race — a pre-existing row with
-- that id short-circuits to {status:'ok', replay:true} carrying the CURRENT
-- balances and the loan id, and moves nothing. The loan id is a SECOND
-- idempotency guard: p_create_loan against an id that already exists raises
-- LOAN_ID_COLLISION rather than silently upserting over a live loan (which is
-- what loansDb.add's UPSERT would do).
--
-- ════════════════════════════════════════════════════════════════════════════
-- THREE CORRECTIONS WORTH RECORDING (things the brief assumed that are untrue)
-- ════════════════════════════════════════════════════════════════════════════
-- 1. THERE IS NO `due_date` ON `loans`. The brief asked for a p_due_date
--    parameter. `loans` is (id, user_id, person_name, type, total_amount,
--    remaining_amount, currency, status, notes, created_at) plus person_id
--    (phase1-persons), loan_pair_id (fix-bidirectional-linked-settlements),
--    updated_at (incremental-sync-core) and deleted_at (tombstones) — and
--    nothing else. Due dates live ONLY on emi_schedules.due_date, which is a
--    TEXT column holding 'yyyy-MM-dd' (supabase-schema.sql:116). A p_due_date
--    here would have written a column mapLoan (supabaseDb.ts:2177-2189) cannot
--    read back. It is carried instead inside p_emi, per instalment, which is
--    where the product actually keeps it.
--
-- 2. LOAN CREATION HAS NO CROSS-CURRENCY CASE. The brief asked for a
--    p_conversion_rate. Unlike `repayment` — where the loan's currency and the
--    account's may differ and the convention is asymmetric — a loan being
--    CREATED takes its currency FROM the funding account
--    (transactionStore.ts:1540 `currency = src.currency`, :1571
--    `currency = dest.currency`), and a cash-advance card is required to match
--    that same currency (:1580). There is no second currency to convert
--    between, and the client sets conversionRate to null on every one of these
--    rows. The parameter is kept for signature symmetry with steps 1 and 2 and
--    a non-NULL value is REFUSED (CONVERSION_RATE_NOT_APPLICABLE) rather than
--    silently written — a rate on a loan-creation row would be drift, and V6
--    below watches for exactly that.
--
-- 3. `p_emi` IS `JSONB` (a JSON array), NOT `jsonb[]`. A Postgres array of
--    jsonb has no natural JS representation through PostgREST's named-argument
--    binding, whereas a JSON array is what `supabase.rpc()` sends for a JS
--    array of objects with no ceremony. The pilot's own §4 already flags
--    "text[] binding through PostgREST is unverified" as its top staging risk;
--    choosing jsonb[] here would have doubled that risk for no gain.
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
    ARRAY['loans','id'], ARRAY['loans','user_id'], ARRAY['loans','person_name'],
    ARRAY['loans','person_id'], ARRAY['loans','type'], ARRAY['loans','total_amount'],
    ARRAY['loans','remaining_amount'], ARRAY['loans','currency'], ARRAY['loans','status'],
    ARRAY['loans','notes'], ARRAY['loans','created_at'], ARRAY['loans','deleted_at'],
    ARRAY['emi_schedules','id'], ARRAY['emi_schedules','user_id'],
    ARRAY['emi_schedules','loan_id'], ARRAY['emi_schedules','installment_number'],
    ARRAY['emi_schedules','due_date'], ARRAY['emi_schedules','amount'],
    ARRAY['emi_schedules','status'],
    ARRAY['transactions','id'], ARRAY['transactions','user_id'], ARRAY['transactions','type'],
    ARRAY['transactions','amount'], ARRAY['transactions','currency'],
    ARRAY['transactions','source_account_id'], ARRAY['transactions','destination_account_id'],
    ARRAY['transactions','related_person'], ARRAY['transactions','person_id'],
    ARRAY['transactions','related_loan_id'], ARRAY['transactions','related_goal_id'],
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
    RAISE EXCEPTION 'PRECONDITION FAILED: p3-atomic-loan-create needs column(s) % — apply the migrations listed in this file''s APPLY ORDER header first, then re-run.',
      array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-loan-create: apply_account_balance_delta is ABSENT — supabase-migration-prelaunch-hardening.sql has not been applied. This file still installs (it reimplements the same compare-and-swap inline), but the legacy client path it replaces is still running unlocked balance writes.';
  END IF;
END;
$$;

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. create_loan_with_leg — the whole creation, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_loan_with_leg(
  p_transaction_id           TEXT,
  p_loan_id                  TEXT,
  p_create_loan              BOOLEAN,
  p_type                     TEXT,        -- 'given' | 'taken' (loans.type)
  p_person_name              TEXT,
  p_person_id                TEXT,
  p_account_id               TEXT,        -- source for 'given', destination for 'taken'
  p_card_account_id          TEXT,        -- cash-advance CARD; 'taken' only, else NULL
  p_amount                   NUMERIC,
  p_currency                 TEXT,        -- cross-check only; NULL = "you decide"
  p_conversion_rate          NUMERIC,     -- must be NULL — see CORRECTION 2
  p_note                     TEXT,
  p_category                 TEXT,
  p_date                     TIMESTAMPTZ,
  p_loan_notes               TEXT,        -- parseInternalNote(...).visibleNote
  p_loan_created_at          TIMESTAMPTZ,
  p_emi                      JSONB,       -- [{id, installment_number, due_date, amount}] | NULL
  p_expected_account_balance NUMERIC,
  p_expected_card_balance    NUMERIC,
  p_allow_negative           BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER   -- RLS is not consulted; the user_id = v_uid predicates below
                   -- ARE the access control (apply_loan_remaining_delta precedent).
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_acct         public.accounts%ROWTYPE;
  v_card         public.accounts%ROWTYPE;
  v_loan         public.loans%ROWTYPE;
  v_existing     public.transactions%ROWTYPE;
  v_currency     TEXT;
  v_amount       NUMERIC;   -- the 2dp figure the balances move by
  v_acct_delta   NUMERIC;   -- signed: − for a loan given, + for one taken
  v_card_delta   NUMERIC;   -- signed: always − (a cash advance charges the card)
  v_new_balance  NUMERIC;
  v_new_card_bal NUMERIC;
  v_src_id       TEXT;
  v_dst_id       TEXT;
  v_created_at   TIMESTAMPTZ;
  v_loan_created BOOLEAN := false;
  v_emi_count    INTEGER := 0;
  v_emi_sum      NUMERIC;
  v_bad          INTEGER;
  v_emi_ids      TEXT[] := ARRAY[]::TEXT[];
  v_dup_id       TEXT;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation (mirrors assertInputAmountsInBounds + the branches'
  --    own first guards, so a curl cannot post what the UI cannot) ─────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_loan_id IS NULL OR length(trim(p_loan_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_LOAN_ID' USING ERRCODE = 'P0001',
      DETAIL = 'every loan_given/loan_taken row points at a loan';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('given', 'taken') THEN
    RAISE EXCEPTION 'INVALID_LOAN_TYPE' USING ERRCODE = 'P0001',
      DETAIL = 'direction must be given or taken, got ' || COALESCE(p_type, '<null>');
  END IF;

  IF p_person_name IS NULL OR length(trim(p_person_name)) = 0 THEN
    -- QuickEntry/AddLoanModal both require a name before the button enables
    -- (QuickEntry.tsx:643, AddLoanModal.tsx:97). A nameless loan is unreadable
    -- on LoansPage and ungroupable by the person key.
    RAISE EXCEPTION 'INVALID_PERSON' USING ERRCODE = 'P0001',
      DETAIL = 'a loan needs a counterparty name';
  END IF;

  -- A ledger-only (splits_only) loan has NO account and must never reach this
  -- function — it belongs to loanStore.createLoan, which writes a loans row
  -- and NOTHING else. Refusing loudly here is what keeps the two paths from
  -- ever crossing (tasks/lessons.md:26-27).
  IF p_account_id IS NULL OR length(trim(p_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'a tracker loan requires an account; ledger-mode loan creation uses loanStore.createLoan, not this RPC';
  END IF;

  -- Strictly positive, finite, below the shared 1e12 ceiling — the same rule as
  -- src/lib/currencyValidation.ts checkMoneyAmount and p1-money-bounds.
  -- NUMERIC 'NaN' is a real value in Postgres, so it is rejected explicitly.
  IF p_amount IS NULL OR p_amount = 'NaN'::NUMERIC OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'amount must be greater than 0 and less than 1e12';
  END IF;

  IF p_expected_account_balance IS NULL THEN
    -- Refusing to guess is the point: without an expectation there is no
    -- compare-and-swap, and this RPC would become a blind write.
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
      DETAIL = 'the funding/receiving account has no expected balance';
  END IF;

  -- See CORRECTION 2: there is no second currency in a loan creation.
  IF p_conversion_rate IS NOT NULL THEN
    RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
      DETAIL = 'a created loan takes the funding account''s currency; there is nothing to convert';
  END IF;

  -- The cash-advance card is a loan_taken-only concept (transactionStore.ts
  -- :1576-1585). A card on a loan_given payload is a poisoned payload.
  IF p_card_account_id IS NOT NULL AND length(trim(p_card_account_id)) > 0 THEN
    IF p_type <> 'taken' THEN
      RAISE EXCEPTION 'INVALID_CASH_ADVANCE' USING ERRCODE = 'P0001',
        DETAIL = 'only a loan you TAKE can be funded by a credit-card cash advance';
    END IF;
    IF p_card_account_id = p_account_id THEN
      RAISE EXCEPTION 'SAME_ACCOUNT' USING ERRCODE = 'P0001',
        DETAIL = 'a cash advance cannot fund the card it is drawn on';
    END IF;
    IF p_expected_card_balance IS NULL THEN
      RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = 'the cash-advance card has no expected balance';
    END IF;
  END IF;

  -- ══ LOCK ORDER: loans → accounts → emi_schedules ═══════════════════════
  -- (1) the loan row, but ONLY when attaching to one that already exists. A
  --     loan being created has no row to lock; its INSERT is the serialisation
  --     point (primary key).
  IF NOT COALESCE(p_create_loan, false) THEN
    PERFORM 1 FROM public.loans
     WHERE id = p_loan_id AND user_id = v_uid
       FOR UPDATE;
  END IF;

  -- (2) BOTH account rows, in ONE statement, ascending id.
  PERFORM 1 FROM public.accounts
   WHERE id = ANY(
           ARRAY[p_account_id]
           || CASE WHEN p_card_account_id IS NOT NULL
                        AND length(trim(p_card_account_id)) > 0
                   THEN ARRAY[p_card_account_id] ELSE ARRAY[]::TEXT[] END)
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  -- Taken AFTER the locks so two copies of the same retry serialise: the
  -- second one sees the first one's committed row instead of racing it.
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type NOT IN ('loan_given', 'loan_taken') THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_balance FROM public.accounts
     WHERE id = p_account_id AND user_id = v_uid;
    IF p_card_account_id IS NOT NULL AND length(trim(p_card_account_id)) > 0 THEN
      SELECT balance INTO v_new_card_bal FROM public.accounts
       WHERE id = p_card_account_id AND user_id = v_uid;
    END IF;

    RETURN jsonb_build_object(
      'status',          'ok',
      'replay',          true,
      'transaction_id',  v_existing.id,
      'loan_id',         v_existing.related_loan_id,
      'loan_created',    false,
      'account_balance', v_new_balance,
      'account_delta',   0,
      'card_balance',    v_new_card_bal,
      'card_delta',      0,
      'currency',        v_existing.currency,
      'created_at',      v_existing.created_at,
      'emi_inserted',    to_jsonb(ARRAY[]::TEXT[]),
      -- true only in the (practically unreachable) case where the user deleted
      -- the entry between the original call and its retry. Reported, not
      -- resurrected: the figures above are still the truth.
      'row_deleted',     (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load the primary account (lock already held) ────────────────────────
  SELECT * INTO v_acct FROM public.accounts
   WHERE id = p_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'account is unknown, deleted, or not yours';
  END IF;

  -- The loan's currency is the ACCOUNT's currency — never a caller-supplied
  -- one (transactionStore.ts:1540, :1571). p_currency is a cross-check only.
  v_currency := v_acct.currency;
  IF p_currency IS NOT NULL AND p_currency <> v_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = 'client said ' || p_currency || ', the account is ' || v_currency;
  END IF;

  -- ── Load the cash-advance card (lock already held) ──────────────────────
  IF p_card_account_id IS NOT NULL AND length(trim(p_card_account_id)) > 0 THEN
    SELECT * INTO v_card FROM public.accounts
     WHERE id = p_card_account_id AND user_id = v_uid AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'cash-advance card is unknown, deleted, or not yours';
    END IF;
    -- Both guards are the client's, verbatim (transactionStore.ts:1579-1580).
    IF v_card.type <> 'credit_card' THEN
      RAISE EXCEPTION 'INVALID_CASH_ADVANCE' USING ERRCODE = 'P0001',
        DETAIL = 'cash advance source must be a credit card account';
    END IF;
    IF v_card.currency <> v_currency THEN
      RAISE EXCEPTION 'INVALID_CASH_ADVANCE' USING ERRCODE = 'P0001',
        DETAIL = 'cash advance source card must match the receiving account currency';
    END IF;
  END IF;

  -- ── The loan: create it, or attach to an existing one ───────────────────
  IF COALESCE(p_create_loan, false) THEN
    -- loansDb.add is an UPSERT, so the legacy path would silently overwrite a
    -- live loan if a uuid ever repeated. Refuse instead — a collision here is
    -- either a bug or a replay whose transaction row was deleted.
    IF EXISTS (SELECT 1 FROM public.loans WHERE id = p_loan_id) THEN
      RAISE EXCEPTION 'LOAN_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'a loan with that id already exists';
    END IF;
  ELSE
    SELECT * INTO v_loan FROM public.loans
     WHERE id = p_loan_id AND user_id = v_uid AND deleted_at IS NULL;
    IF NOT FOUND THEN
      -- Same token apply_loan_remaining_delta raises, so the client's existing
      -- "the loan is gone" branch fires instead of a retry loop.
      RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'loan is unknown, deleted, or not yours';
    END IF;
    IF v_loan.type <> p_type OR v_loan.currency <> v_currency THEN
      RAISE EXCEPTION 'LOAN_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'the existing loan is a ' || v_loan.type || ' ' || v_loan.currency
                 || ' loan; this entry is a ' || p_type || ' ' || v_currency || ' one';
    END IF;
  END IF;

  -- ── Direction. Derived from p_type exactly as the client does — and cross-
  --    checked against the loan when attaching, so a curl cannot flip a debit
  --    into a credit by lying about the direction.
  v_amount := round(p_amount, 2);
  IF p_type = 'given' THEN
    v_acct_delta := -v_amount;          -- I lent it out → my account shrinks
    v_src_id     := v_acct.id;
    v_dst_id     := NULL;
  ELSE
    v_acct_delta := v_amount;           -- I borrowed it → my account grows
    v_src_id     := NULL;               -- (overwritten below for a cash advance)
    v_dst_id     := v_acct.id;
  END IF;

  IF v_card.id IS NOT NULL THEN
    v_card_delta := -v_amount;          -- the card is charged
    v_src_id     := v_card.id;          -- the row carries card → receiver
  ELSE
    v_card_delta := NULL;
  END IF;

  -- ── Optimistic lock: the primary account. Same token as
  --    apply_account_balance_delta, compared at 2dp because the client sends
  --    IEEE-754 doubles (apply_loan_remaining_delta:132 precedent).
  IF round(v_acct.balance, 2) <> round(p_expected_account_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_acct.id,
        'account_balance',          v_acct.balance,
        'expected_account_balance', p_expected_account_balance
      )::TEXT;
  END IF;

  -- ── Optimistic lock: the cash-advance card.
  IF v_card.id IS NOT NULL
     AND round(v_card.balance, 2) <> round(p_expected_card_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_card.id,
        'account_balance',          v_card.balance,
        'expected_account_balance', p_expected_card_balance
      )::TEXT;
  END IF;

  -- ── Insufficient-balance guard (debit legs only) ────────────────────────
  -- The server half of checkBalanceForTransaction (transactionStore.ts
  -- :259-268). NOT inherited from apply_account_balance_delta, which has no
  -- balance guard at all — the client has always been the only gate ("the UI
  -- guard is the real protection", CLAUDE.md). p_allow_negative is the escape
  -- the splits_only bypass and the future repair queue use.
  --
  -- NOTE: it is applied to a CREDIT CARD source too, exactly as checkBalance
  -- is today — a card's `balance` IS its available credit, so "insufficient"
  -- means "over the limit", which is the correct refusal.
  IF v_acct_delta < 0
     AND NOT COALESCE(p_allow_negative, false)
     AND v_acct.balance < v_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_acct.id,
        'account_name', v_acct.name,
        'account_type', v_acct.type,
        'currency',     v_acct.currency,
        'available',    v_acct.balance,
        'requested',    v_amount
      )::TEXT;
  END IF;

  IF v_card.id IS NOT NULL
     AND NOT COALESCE(p_allow_negative, false)
     AND v_card.balance < v_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_card.id,
        'account_name', v_card.name,
        'account_type', v_card.type,
        'currency',     v_card.currency,
        'available',    v_card.balance,
        'requested',    v_amount
      )::TEXT;
  END IF;

  -- ── The EMI plan: validated in full BEFORE any write, so a bad schedule
  --    refuses the whole loan instead of funding one with a broken plan.
  --    The COVERAGE rule (which instalments a payment covers) stays in
  --    src/lib/emiCoverage.ts — this validates the SHAPE the client's
  --    emiStore.generateSchedule produces: N instalments numbered 1..N whose
  --    amounts sum to the loan total (the last one absorbs the rounding tail,
  --    emiStore.ts:79-81), within the 0.01 tolerance p1-money-bounds uses for
  --    all split arithmetic.
  IF p_emi IS NOT NULL THEN
    IF jsonb_typeof(p_emi) <> 'array' THEN
      RAISE EXCEPTION 'EMI_PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'p_emi must be a JSON array of instalments';
    END IF;
    v_emi_count := jsonb_array_length(p_emi);
  END IF;

  IF v_emi_count > 0 THEN
    -- emi_schedules_installment_number_sane (p1-money-bounds) caps at 1200.
    IF v_emi_count > 1200 THEN
      RAISE EXCEPTION 'EMI_PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'at most 1200 instalments';
    END IF;

    -- Pass 1: TYPES only. A value cast on a wrongly-typed member would raise
    -- an unnamed error, and AND does not short-circuit reliably in a WHERE.
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(p_emi) AS e
     WHERE jsonb_typeof(e -> 'id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(e -> 'installment_number') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e -> 'due_date') IS DISTINCT FROM 'string'
        OR jsonb_typeof(e -> 'amount') IS DISTINCT FROM 'number';
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'EMI_PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'every instalment needs id (string), installment_number (number), due_date (string), amount (number)';
    END IF;

    -- Pass 2: VALUES. Mirrors emi_schedules_amount_bounded and
    -- emi_schedules_installment_number_sane so the CHECK can never be the
    -- thing that fails mid-write.
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(p_emi) AS e
     WHERE length(trim(e ->> 'id')) = 0
        OR length(trim(e ->> 'due_date')) = 0
        OR (e ->> 'amount')::NUMERIC = 'NaN'::NUMERIC
        OR (e ->> 'amount')::NUMERIC < 0
        OR (e ->> 'amount')::NUMERIC >= 1e12
        OR (e ->> 'installment_number')::NUMERIC <> trunc((e ->> 'installment_number')::NUMERIC)
        OR (e ->> 'installment_number')::INTEGER < 1
        OR (e ->> 'installment_number')::INTEGER > 1200;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'EMI_PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'an instalment has an empty id/due_date, a negative or absurd amount, or an out-of-range installment_number';
    END IF;

    -- The numbering must be exactly 1..N, each once — what generateSchedule
    -- emits, and what uncoveredToPaidIds' oldest-first walk assumes.
    SELECT count(*) INTO v_bad
      FROM (
        SELECT DISTINCT (e ->> 'installment_number')::INTEGER AS n
          FROM jsonb_array_elements(p_emi) AS e
      ) s
     WHERE s.n BETWEEN 1 AND v_emi_count;
    IF v_bad <> v_emi_count THEN
      RAISE EXCEPTION 'EMI_PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'instalments must be numbered 1..' || v_emi_count || ', each exactly once';
    END IF;

    -- Ids: unique within the payload, and free in the table.
    SELECT array_agg(e ->> 'id') INTO v_emi_ids
      FROM jsonb_array_elements(p_emi) AS e;
    IF (SELECT count(DISTINCT x) FROM unnest(v_emi_ids) AS x) <> v_emi_count THEN
      RAISE EXCEPTION 'EMI_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'duplicate instalment ids in the payload';
    END IF;
    SELECT id INTO v_dup_id FROM public.emi_schedules
     WHERE id = ANY(v_emi_ids) LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
      RAISE EXCEPTION 'EMI_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'instalment ' || v_dup_id || ' already exists';
    END IF;

    -- THE SUM RULE. round(Σ amount, 2) must equal round(p_amount, 2) within
    -- 0.01 — a schedule that does not add up to the loan is the EMI twin of
    -- audit M12's "0.01 charged, 50,000 attributed".
    SELECT round(sum((e ->> 'amount')::NUMERIC), 2) INTO v_emi_sum
      FROM jsonb_array_elements(p_emi) AS e;
    IF abs(COALESCE(v_emi_sum, 0) - v_amount) > 0.01 THEN
      RAISE EXCEPTION 'EMI_PLAN_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'instalments sum to ' || COALESCE(v_emi_sum, 0)::TEXT
                 || ' but the loan is ' || v_amount::TEXT;
    END IF;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════
  -- Arithmetic is done IN the UPDATE (never from a plpgsql snapshot) — the
  -- L-4 lesson from supabase-migration-audit-p0-settlement-row-locks.sql.

  -- 1. The loan. EXACTLY the columns and values loansDb.add writes
  --    (src/lib/supabaseDb.ts:377-385) — no more:
  --      remaining_amount   = total_amount (a fresh loan owes all of it)
  --      status             'active'
  --      notes              the caller's VISIBLE note only; the client strips
  --                         [[HISAAB_META:…]] with parseInternalNote before
  --                         sending, because Loan.notes is rendered raw on
  --                         LoansPage / LoanDetailPage / statements
  --      created_at         the client's own stamp (trackedCreateLoan uses a
  --                         DIFFERENT clock read from the transaction's)
  --      updated_at         left to the column default + touch trigger, because
  --                         loansDb.add's payload omits it too
  --      loan_pair_id       untouched (NULL) — it belongs to the cross-user
  --                         linked-settlement flow, not to local creation
  IF COALESCE(p_create_loan, false) THEN
    INSERT INTO public.loans (
      id, user_id, person_name, person_id, type,
      total_amount, remaining_amount, currency, status, notes,
      created_at, deleted_at
    ) VALUES (
      p_loan_id, v_uid, p_person_name, NULLIF(trim(COALESCE(p_person_id, '')), ''), p_type,
      p_amount, p_amount, v_currency, 'active', COALESCE(p_loan_notes, ''),
      COALESCE(p_loan_created_at, now()), NULL
    );
    v_loan_created := true;
  END IF;

  -- 2. The primary account. The balance itself is not re-rounded, matching
  --    apply_account_balance_delta (`balance = balance + p_delta`); only the
  --    DELTA is 2dp, matching accountStore.updateBalance's
  --    Math.round(delta * 100) / 100.
  UPDATE public.accounts
     SET balance = balance + v_acct_delta
   WHERE id = v_acct.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- Unreachable: the row was selected under FOR UPDATE above. Kept so a
    -- future edit that loosens the locks fails loudly instead of committing
    -- the loan alone.
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the account disappeared mid-creation';
  END IF;

  -- 3. The cash-advance card.
  IF v_card.id IS NOT NULL THEN
    UPDATE public.accounts
       SET balance = balance + v_card_delta
     WHERE id = v_card.id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_card_bal;

    IF v_new_card_bal IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'the cash-advance card disappeared mid-creation';
    END IF;
  END IF;

  -- 4. The EMI rows. Status-only shape, exactly what emiSchedulesDb.bulkAdd
  --    writes (src/lib/supabaseDb.ts:1049-1056): no paid_at, no updated_at, no
  --    deleted_at — those columns do not exist on this table.
  IF v_emi_count > 0 THEN
    INSERT INTO public.emi_schedules (
      id, user_id, loan_id, installment_number, due_date, amount, status
    )
    SELECT e ->> 'id', v_uid, p_loan_id,
           (e ->> 'installment_number')::INTEGER,
           e ->> 'due_date',
           (e ->> 'amount')::NUMERIC,
           'upcoming'
      FROM jsonb_array_elements(p_emi) AS e;
  END IF;

  -- 5. The row. EXACTLY the columns and values transactionsDb.add writes
  --    (src/lib/supabaseDb.ts:256-274) for a loan entry, read back the same way
  --    by mapTransaction:
  --      type                   'loan_given' | 'loan_taken'
  --      amount                 the caller's amount, VERBATIM (the client
  --                             stores `input.amount` unrounded on the row and
  --                             rounds only the deltas)
  --      currency               the ACCOUNT's currency (= the loan's)
  --      source/destination     given → source only; taken → destination only;
  --                             taken via cash advance → BOTH (card → receiver)
  --      related_person         input.personName
  --      person_id              input.personId (may be NULL)
  --      related_loan_id        the loan, new or attached
  --      related_goal_id        NULL
  --      related_investment_id  omitted entirely — the client only sends it
  --                             when non-null, so a database without
  --                             supabase-migration-investments.sql still works
  --      conversion_rate        always NULL here (CORRECTION 2)
  --      notes                  the caller's notes, INCLUDING any internal
  --                             [[HISAAB_META:…]] the ad-hoc-split flow stamps;
  --                             the server never synthesises one
  --      is_reconciled          false; reconciled_at/by, receipt_path NULL
  --      updated_at             left to the column default (now()), because
  --                             the client's insert payload omits it too
  --      deleted_at             NULL
  v_created_at := COALESCE(p_date, now());

  INSERT INTO public.transactions (
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at,
    is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
  ) VALUES (
    p_transaction_id, v_uid,
    CASE WHEN p_type = 'given' THEN 'loan_given' ELSE 'loan_taken' END,
    p_amount, v_currency,
    v_src_id, v_dst_id,
    p_person_name, NULLIF(trim(COALESCE(p_person_id, '')), ''), p_loan_id, NULL,
    NULL, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',          'ok',
    'replay',          false,
    'transaction_id',  p_transaction_id,
    'loan_id',         p_loan_id,
    'loan_created',    v_loan_created,
    'account_balance', v_new_balance,
    -- Signed, already 2dp — the client registers its inverse against THIS,
    -- never against a locally recomputed figure.
    'account_delta',   v_acct_delta,
    'card_balance',    v_new_card_bal,
    'card_delta',      v_card_delta,
    'currency',        v_currency,
    'created_at',      v_created_at,
    'emi_inserted',    to_jsonb(COALESCE(v_emi_ids, ARRAY[]::TEXT[])),
    'row_deleted',     false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_loan_with_leg(
  TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_loan_with_leg(
  TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.create_loan_with_leg(
  TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) IS
  'Audit L4 step 3 (MF-01 / O-1 / F-4): the whole full-tracker loan creation — the funding/receiving account leg, the optional credit-card cash-advance leg, the loans row, an optional EMI schedule and the transactions row — in ONE Postgres transaction, so a flaky network can no longer take money out of a wallet without recording who owes it. Locks loans (only when attaching) -> accounts (both, one statement, ascending id) -> emi_schedules (insert only), per the repo rule. Compare-and-swap on every account balance touched (BALANCE_CONFLICT, the same token the existing client ladder parses). Direction is derived from p_type and cross-checked against the loan; the loan currency is taken from the account, never from the caller. Idempotent on p_transaction_id, and p_create_loan against an existing id raises LOAN_ID_COLLISION rather than upserting over a live loan. The EMI schedule is re-validated server-side (1..N numbering, ids free, amounts summing to the loan within 0.01) — the shipped client sends NULL because the pages still call emiStore.generateSchedule after the fact. Ledger-mode (splits_only) loan creation never comes here: it uses loanStore.createLoan and a null account raises ACCOUNT_NOT_FOUND. Gated client-side by VITE_ATOMIC_LOAN_CREATE.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. VERIFICATION — read-only, safe to re-run at any time
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. The function exists with the expected signature, is SECURITY DEFINER,
--     and pins its search_path.
--     EXPECT: one row; security_definer = t; config contains search_path=public.
SELECT p.proname,
       p.prosecdef                               AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.proconfig                               AS config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'create_loan_with_leg';

-- V2. Privileges: authenticated may execute; anon and PUBLIC may not.
--     EXPECT: auth_can = t, anon_can = f, public_can = f.
SELECT has_function_privilege('authenticated',
         'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)',
         'EXECUTE') AS auth_can,
       has_function_privilege('anon',
         'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)',
         'EXECUTE') AS anon_can,
       has_function_privilege('public',
         'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)',
         'EXECUTE') AS public_can;

-- V3. Body roll-call — the invariants this file exists to install.
--     EXPECT: every column t.
SELECT (d LIKE '%FOR UPDATE%')                        AS takes_row_locks,
       (d LIKE '%ORDER BY id%')                       AS locks_accounts_in_id_order,
       (d LIKE '%BALANCE_CONFLICT%')                  AS raises_balance_conflict,
       (d LIKE '%INSUFFICIENT_BALANCE%')              AS guards_balance,
       (d LIKE '%p_allow_negative%')                  AS has_negative_escape,
       (d LIKE '%user_id = v_uid%')                   AS owner_scoped,
       (d LIKE '%deleted_at IS NULL%')                AS skips_deleted,
       (d LIKE '%balance = balance + v_acct_delta%')  AS delta_in_statement,
       (d LIKE '%balance = balance + v_card_delta%')  AS card_delta_in_statement,
       (d LIKE '%p_type = ''given''%')                AS direction_from_type,
       (d LIKE '%v_currency := v_acct.currency%')     AS currency_from_account,
       (d LIKE '%EMI_PLAN_MISMATCH%')                 AS revalidates_emi_sum,
       (d LIKE '%LOAN_ID_COLLISION%')                 AS refuses_loan_id_reuse,
       (d LIKE '%INSERT INTO public.loans%')          AS writes_the_loan,
       (d LIKE '%INSERT INTO public.transactions%')   AS writes_the_row
  FROM (SELECT pg_get_functiondef(
          'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)'::regprocedure
        ) AS d) s;

-- V4. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_def TEXT;
  v_sig CONSTANT TEXT :=
    'public.create_loan_with_leg(text,text,boolean,text,text,text,text,text,numeric,text,numeric,text,text,timestamptz,text,timestamptz,jsonb,numeric,numeric,boolean)';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the function is missing';
  END IF;

  v_def := pg_get_functiondef(v_sig::regprocedure);

  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the row locks are gone — two concurrent cash advances can now interleave';
  END IF;
  IF v_def NOT LIKE '%ORDER BY id%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the ascending-id account lock order is gone — a cash advance can now deadlock against transfer_between_accounts';
  END IF;
  IF v_def NOT LIKE '%BALANCE_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the account compare-and-swap is gone — the client retry ladder is dead code';
  END IF;
  IF v_def NOT LIKE '%INSUFFICIENT_BALANCE%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the balance guard is gone — a loan can now be funded from an empty account';
  END IF;
  IF v_def NOT LIKE '%EMI_PLAN_MISMATCH%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the EMI sum check is gone — a schedule that does not add up to its loan is now insertable';
  END IF;
  IF v_def NOT LIKE '%LOAN_ID_COLLISION%' THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: the loan-id collision guard is gone — a live loan can now be silently overwritten';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: authenticated cannot execute the function';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-loan-create: anon can execute the function';
  END IF;

  RAISE NOTICE 'p3-atomic-loan-create: verification passed';
END;
$$;

-- V5. DRIFT WATCH #1 (the reconciliation surface L7 will grow) — loan-creation
--     rows whose account legs contradict their own direction. Reads history
--     written by the legacy client as well as rows this RPC writes.
--     EXPECT: zero rows, before and after.
--
--     Legitimate shapes:
--       loan_given → source_account_id set, destination NULL
--       loan_taken → destination_account_id set, source NULL
--                    …or source = a CREDIT CARD (the cash-advance leg)
--       ledger mode writes NO loan_given/loan_taken row at all, so BOTH NULL
--                    is NOT expected here — unlike the repayment table.
SELECT t.id,
       t.created_at,
       t.type,
       t.source_account_id,
       t.destination_account_id,
       CASE
         WHEN t.type = 'loan_given' AND t.source_account_id IS NULL
           THEN 'a loan you GAVE was funded by no account'
         WHEN t.type = 'loan_given' AND t.destination_account_id IS NOT NULL
           THEN 'a loan you GAVE is crediting an account'
         WHEN t.type = 'loan_taken' AND t.destination_account_id IS NULL
           THEN 'a loan you TOOK landed in no account'
         WHEN t.type = 'loan_taken' AND t.source_account_id IS NOT NULL
              AND COALESCE(sa.type, '') <> 'credit_card'
           THEN 'a loan you TOOK is debiting a non-card account'
         ELSE 'unclassified direction drift'
       END AS problem
  FROM public.transactions t
  LEFT JOIN public.accounts sa ON sa.id = t.source_account_id
 WHERE t.type IN ('loan_given', 'loan_taken')
   AND t.deleted_at IS NULL
   AND (
     (t.type = 'loan_given' AND (t.source_account_id IS NULL
                                 OR t.destination_account_id IS NOT NULL))
     OR (t.type = 'loan_taken' AND (t.destination_account_id IS NULL
                                    OR (t.source_account_id IS NOT NULL
                                        AND COALESCE(sa.type, '') <> 'credit_card')))
   )
 ORDER BY t.created_at DESC;

-- V6. DRIFT WATCH #2 — a loan-creation row must carry NO conversion rate, and
--     its currency must equal every account it touches (CORRECTION 2).
--     EXPECT: zero rows.
SELECT t.id, t.created_at, t.type, t.currency, t.conversion_rate,
       sa.currency AS source_currency, da.currency AS destination_currency
  FROM public.transactions t
  LEFT JOIN public.accounts sa ON sa.id = t.source_account_id
  LEFT JOIN public.accounts da ON da.id = t.destination_account_id
 WHERE t.type IN ('loan_given', 'loan_taken')
   AND t.deleted_at IS NULL
   AND (
     t.conversion_rate IS NOT NULL
     OR (sa.id IS NOT NULL AND sa.currency <> t.currency)
     OR (da.id IS NOT NULL AND da.currency <> t.currency)
   )
 ORDER BY t.created_at DESC;

-- V7. DRIFT WATCH #3 — the orphan the CLIENT still produces: a loan whose EMI
--     schedule does not add up to it. Today the schedule is written by the page
--     AFTER processTransaction resolves (artifact 4 above), so a drop between
--     the two leaves exactly this. It is the number to know before enabling the
--     flag, and the number that should stop growing once the page's call moves
--     into p_emi.
--     EXPECT: zero rows. (Historical rows are the finding, not a false
--     positive — a partially-written schedule is unrecoverable by hand.)
SELECT l.id,
       l.person_name,
       l.currency,
       l.total_amount,
       count(e.id)                                   AS instalments,
       round(COALESCE(sum(e.amount), 0), 2)          AS instalments_sum,
       round(COALESCE(sum(e.amount), 0) - l.total_amount, 2) AS gap
  FROM public.loans l
  JOIN public.emi_schedules e ON e.loan_id = l.id
 WHERE l.deleted_at IS NULL
 GROUP BY l.id, l.person_name, l.currency, l.total_amount
HAVING abs(COALESCE(sum(e.amount), 0) - l.total_amount) > 0.01
 ORDER BY abs(COALESCE(sum(e.amount), 0) - l.total_amount) DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Manual authenticated QA (run as a normal signed-in account).
-- Every one of these also runs in Docker — see
-- supabase/tests/tests/7x-atomic-loan-create.sql and
-- docs/server-side-money-engine.md §13.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  1. Happy path, loan GIVEN (Bank has 1000 AED, lend 250 to Ali):
--       select public.create_loan_with_leg(
--         gen_random_uuid()::text, gen_random_uuid()::text, true,
--         'given', 'Ali', null, '<bank>', null, 250, 'AED', null,
--         '', '', now(), '', now(), null, 1000, null, false);
--     → {"account_balance":750.00,"loan_created":true}
--       one loans row (total 250, remaining 250, status 'active') and one
--       transactions row: type 'loan_given', source_account_id = <bank>,
--       destination_account_id NULL.
--
--  2. Happy path, loan TAKEN (Bank has 1000, borrow 500 from Sara):
--     → account_balance 1500.00, and the row carries
--       destination_account_id = <bank>, source_account_id NULL.
--
--  3. Cash advance (card <cc> limit 16500 available 16500, into <bank> 1000):
--       … p_type 'taken', p_account_id '<bank>', p_card_account_id '<cc>',
--         p_amount 1500, p_expected_account_balance 1000,
--         p_expected_card_balance 16500 …
--     → account_balance 2500.00, card_balance 15000.00, ONE loans row, ONE
--       transactions row carrying BOTH ids (source = card, destination = bank).
--
--  4. Stale expectation: repeat #1 with p_expected_account_balance = 999.
--     → BALANCE_CONFLICT, DETAIL carries the true balance. NOTHING moved —
--       not the account, not the loan, no row.
--
--  5. Insufficient (lend 10 000 from a 250 account).
--     → INSUFFICIENT_BALANCE, DETAIL {available:250, requested:10000}.
--       With p_allow_negative = true it succeeds and the account goes negative
--       — that is the splits_only bypass.
--
--  6. EMI plan: pass p_emi with three instalments summing to the loan.
--     → three emi_schedules rows, status 'upcoming', numbered 1..3.
--       A plan that sums to anything else → EMI_PLAN_MISMATCH and NOTHING is
--       written: no loan, no row, no instalments, the balance unmoved.
--
--  7. Replay: call #1 again with the SAME p_transaction_id.
--     → {"replay":true, …} with the CURRENT figures; the money moves once and
--       there is one loan and one row, not two.
--
--  8. Ledger guard: p_account_id = NULL.
--     → ACCOUNT_NOT_FOUND. A splits_only loan can never be written here.
--
--  9. Someone else's account id, or a soft-deleted one.
--     → ACCOUNT_NOT_FOUND, never a partial write.
--
-- 10. A conversion rate on a loan creation.
--     → CONVERSION_RATE_NOT_APPLICABLE (there is no second currency).
--
-- 11. A non-card cash-advance source, or one in another currency.
--     → INVALID_CASH_ADVANCE, nothing moved.
--
-- 12. anon: call it with the anon key.
--     → permission denied for function create_loan_with_leg.
-- ═══════════════════════════════════════════════════════════════════════════
