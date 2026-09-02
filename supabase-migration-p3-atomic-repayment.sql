-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 / L4 STEP 2: the full-tracker loan repayment becomes ONE
-- Postgres transaction (`record_loan_repayment`).
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER
--   AFTER  supabase-migration-prelaunch-hardening.sql        (#18 in docs/audit-2026-09/APPLY-ORDER.md)
--            ^ apply_account_balance_delta (the account CAS contract mirrored
--              here) and the accounts/transactions FKs.
--   AFTER  supabase-migration-audit-p0-loan-concurrency.sql
--            ^ apply_loan_remaining_delta — the loan CAS whose clamp, status
--              derivation, 2dp comparison and ERROR TOKENS this file copies
--              verbatim so the client's existing ladder keeps working.
--   AFTER  supabase-migration-p1-money-bounds.sql
--            ^ the CHECK constraints this RPC's own validation mirrors
--              (amount >= 0 AND < 1e12; conversion_rate in [0.0001, 100000];
--               loans_remaining_not_over_total).
--   AFTER  supabase-migration-p3-atomic-transfer.sql (step 1 of the same
--            programme — not a hard dependency, but the two are one rollout).
--   Also requires (all in the historical set, long applied):
--     supabase-schema.sql                      accounts, transactions, loans,
--                                              emi_schedules
--     supabase-migration-phase1-persons.sql    transactions.person_id
--     supabase-migration-reconciliation.sql    is_reconciled/reconciled_at/by
--     supabase-migration-receipts.sql          transactions.receipt_path
--     supabase-migration-incremental-sync-core.sql        updated_at (+trigger)
--     supabase-migration-incremental-sync-tombstones.sql  deleted_at
--   Section 0 hard-checks every one of those columns and ABORTS with a named
--   message rather than creating a function that would fail at runtime.
--
--   SAFE AHEAD OF THE CLIENT. This file only ADDS one function. Nothing calls
--   it until a build ships with VITE_ATOMIC_REPAYMENT=true
--   (src/stores/transactionStore.ts, `ATOMIC_REPAYMENT_ENABLED`), which is
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
-- docs/audit-2026-09/12-qa-review.md  F-2 / C-1 (high):
--   "Concurrent loan repayment across devices = lost update; records (rows +
--    debits) exceed actual loan reduction."  audit-p0-loan-concurrency closed
--   the *lost update*; it did NOT make the loan leg and the account leg atomic
--   with each other.
-- docs/audit-2026-09/12-qa-review.md  O-1 / F-4 (high):
--   "permanent half-applied money … with no repair queue and no persisted
--    marker."
-- docs/audit-2026-09/00-executive-summary.md  M1 / L4 — this is branch #3 in
--   the order table of docs/server-side-money-engine.md §6 (promoted to step 2
--   of the build because it is the highest-risk multi-leg flow).
--
-- The repayment branch is the WORST case in the whole switch, because it is the
-- only one whose legs span three tables and two different optimistic locks:
--
--   1. apply_account_balance_delta(account, ±amount, expected)   — commits
--   2. apply_loan_remaining_delta(loan, −amount, expected)       — TIMES OUT
--   3. emi_schedules status='paid' × N                           — never runs
--   4. transactions INSERT (the record)                          — never runs
--
-- Server truth after that: the user's account moved, the loan did not, and
-- there is NO transaction row saying why. That is precisely the 2026-07-18
-- incident recorded in tasks/lessons.md ("bulk repayment left no record"), in
-- its full-tracker form and with the balance corrupted as well.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ARTIFACT CONTRACT — what the CLIENT leaves behind today, and what this
-- RPC must reproduce EXACTLY.
-- Traced from src/stores/transactionStore.ts `case 'repayment'` (:1363-1459),
-- trackedApplyRepayment (:503-553), trackedMarkEmiPaid (:600-627),
-- trackedMarkCoveredEmisPaid (:629-675), the shared tail (:1713-1752), and
-- every helper they call.
-- ════════════════════════════════════════════════════════════════════════════
--
--  # | Artifact                     | Today (client, 3-5 remote round-trips)                                  | This RPC (1 transaction)
-- ---+------------------------------+-------------------------------------------------------------------------+------------------------------------------------
--  1 | accounts.balance             | loan.type='given'  → trackedBalanceDelta(dest, +amount)                  | UPDATE accounts SET balance = balance + v_delta
--    | (ONE account only)           |   cross-currency: +round(amount * rate, 2)                              | after FOR UPDATE + expected-balance compare.
--    |                              | loan.type='taken'  → trackedBalanceDelta(src, -amount)                   | Direction derived from loans.type, exactly as
--    |                              |   cross-currency: -round(amount / rate, 2)   ← NOTE THE INVERSE RATE     | the client does. Same 2dp rounding.
--    |                              | Both go through apply_account_balance_delta (CAS, own round-trip).      |
--  2 | loans.remaining_amount       | trackedApplyRepayment → applyLoanRemainingDelta(-round2(amount)) →      | UPDATE loans SET remaining_amount =
--    | + loans.status               | apply_loan_remaining_delta CAS: round(GREATEST(0, rem+delta),2) and     |   round(GREATEST(0, remaining_amount
--    |                              | status = 0 ? 'settled' : 'active'. SECOND round-trip.                   |   - round(p_amount,2)), 2), status likewise —
--    |                              |                                                                          | SAME transaction as #1.
--  3 | emi_schedules.status='paid'  | trackedMarkEmiPaid(input.emiId) when targeted (no-op if already paid)    | UPDATE emi_schedules SET status='paid'
--    |                              | + trackedMarkCoveredEmisPaid(loanId): uncoveredToPaidIds(schedules,      | WHERE id = ANY(p_emi_schedule_ids)
--    |                              | totalAmount - remainingAmount) — oldest-first cumulative prefix.        | AND status <> 'paid'. The client computes the
--    |                              | N MORE round-trips (Promise.all of per-row updates).                     | id list; the SERVER re-validates ownership and
--    |                              |                                                                          | loan membership before marking. Same tx.
--  4 | transactions row             | trackedAddTransaction → transactionsDb.add (UPSERT), AFTER the switch    | INSERT … same 20 columns, same values, same tx
--  5 | Dexie mirror (transactions)  | mirrorPut(db.transactions, tx) + markMirrorStale('transactions')        | client-side, post-commit (unchanged)
--  6 | Dexie mirror (accounts)      | mirrorPut(db.accounts, updated) + markMirrorStale('accounts')           | client-side, post-commit (unchanged)
--  7 | Dexie mirror (loans)         | syncLocalRemaining → mirrorPut(db.loans, next) + markMirrorStale        | client-side, post-commit (unchanged)
--  8 | Zustand accounts/loans/emis/ | set() inside the four stores                                            | client-side, post-commit (unchanged)
--    | transactions                 |                                                                          |
--  9 | activity 'loan_settled'      | inside trackedApplyRepayment, ONLY when newRemaining === 0 AND the      | client-side, post-commit, best-effort
--    |                              | loan was not already 'settled'. try/catch → reportError. Best-effort.   | (unchanged — deliberately NOT in the RPC)
-- 10 | activity 'emi_paid'          | inside trackedMarkEmiPaid ("EMI #n paid") and inside                     | client-side, post-commit, best-effort
--    |                              | trackedMarkCoveredEmisPaid ("N EMIs marked paid after repayment").      | (unchanged)
-- 11 | activity 'transaction_created'| logActivitySafe(description) AFTER runSafeMutation commits             | client-side, post-commit (unchanged)
-- 12 | reminder reschedule          | nudgeReminderSchedule() — fire-and-forget, native only                   | client-side, post-commit (unchanged)
-- 13 | cash-advance CARD CREDIT leg | when the loan originated as a credit-card cash advance:                  | ***OUT OF SCOPE — see the note below.***
--    |                              | clampCardCredit(card, amount) → a SECOND balance leg crediting the card, |
--    |                              | destinationAccountId = card.id, and a cardCreditedAmount internal note. |
--
-- Artifacts 5-12 stay client-side by design: local caches and a best-effort
-- audit trail. The repo's rule is that an activity-log failure must NEVER roll
-- back money that has moved (transactionStore.ts:654-667, logActivitySafe).
--
-- ── ARTIFACT 13: the cash-advance card leg is deliberately NOT covered ───────
-- A repayment against a loan that began life as a credit-card cash advance
-- credits the CARD as well as debiting the paying account — two account legs,
-- plus a clamp (src/lib/cardCredit.ts clampCardCredit) whose skipped remainder
-- is stamped into the row's notes. That is a second, different RPC shape and
-- the same "plan on the client, apply on the server" decision the card-bill
-- branch needs (docs/server-side-money-engine.md §6, branch 5). Until then the
-- CLIENT keeps that case on the legacy path — `record_loan_repayment` is only
-- called when there is no card-credit leg. The RPC itself cannot express it:
-- it takes exactly ONE account id. This is stated here, in the migration, so
-- nobody later assumes coverage the function does not have.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BOTH APP MODES TRACED (tasks/lessons.md:6-13, :26-27)
-- ════════════════════════════════════════════════════════════════════════════
-- full_tracker  — the only mode that reaches this RPC. Exactly one account id
--                 is non-null (destination for a 'given' loan, source for a
--                 'taken' one); the other is NULL on the row, by design.
--
-- splits_only   — LEDGER REPAYMENTS DO NOT COME HERE AND ARE UNTOUCHED.
--                 A ledger-mode repayment goes through
--                 src/stores/loanStore.ts `applyRepayment`, which writes a row
--                 with BOTH account ids NULL, applies the same
--                 apply_loan_remaining_delta CAS, logs its own activity and
--                 reconciles EMIs via emiStore.reconcileCovered. Not one line
--                 of that path changes, and it never calls this function.
--                 This RPC REFUSES a NULL/unknown/foreign/soft-deleted account
--                 with ACCOUNT_NOT_FOUND, so a ledger row can never be routed
--                 through it and can never be written here with both account
--                 ids null — the exact failure class lessons.md records.
--
--                 One subtlety, reproduced faithfully: 'repayment' IS listed in
--                 isSimpleModeBalanceBypassAllowed (transactionStore.ts:243-251).
--                 A user who switched full_tracker → splits_only still HAS
--                 accounts, and for them checkBalanceForTransaction is a no-op,
--                 so the account may legitimately go negative. The client
--                 therefore passes p_allow_negative = true in exactly that
--                 case, and only in that case. Full tracker always passes
--                 false — byte-for-byte today's behaviour.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ERROR CONTRACT — only tokens the client ALREADY parses
-- ════════════════════════════════════════════════════════════════════════════
--   BALANCE_CONFLICT          bare token, byte-identical to
--                             apply_account_balance_delta
--                             (prelaunch-hardening.sql:270). DETAIL carries
--                             {account_id, account_balance, expected_account_balance}
--                             so the refetch-and-retry-once ladder needs no
--                             extra round-trip.
--   LOAN_REMAINING_CONFLICT   bare token, byte-identical to
--                             apply_loan_remaining_delta
--                             (audit-p0-loan-concurrency.sql:136), which
--                             src/lib/supabaseDb.ts loansDb.applyRemainingDelta
--                             already maps to a coded Error and
--                             src/lib/loanRemainingDelta.ts already has a
--                             refetch-and-retry ladder for. DETAIL carries
--                             {loan_id, loan_remaining, expected_loan_remaining}.
--   LOAN_NOT_FOUND            same token and same meaning as the loan CAS:
--                             unknown, soft-deleted, or not yours. The client
--                             turns it into tStatic('err_loan_gone') and never
--                             retries it.
--   INSUFFICIENT_BALANCE      the server half of the client's checkBalance
--                             (transactionStore.ts:200-209). DETAIL carries
--                             {account_id, account_name, account_type,
--                              currency, available, requested} so the wrapper
--                             rebuilds the identical bilingual
--                             tStatic('err_insufficient') string.
--                             Escape: p_allow_negative = true (the ledger-mode
--                             bypass above, and the future repair queue).
--
-- Everything else is a poisoned payload or a programming error, unreachable
-- from the shipped client, and exists because ONE curl against PostgREST
-- bypasses every client guard: NOT_AUTHENTICATED, ACCOUNT_NOT_FOUND,
-- INVALID_TRANSACTION_ID, INVALID_AMOUNT, EXPECTED_BALANCE_REQUIRED,
-- EXPECTED_REMAINING_REQUIRED, CONVERSION_RATE_REQUIRED,
-- INVALID_CONVERSION_RATE, ACCOUNT_AMOUNT_MISMATCH, EMI_SCHEDULE_INVALID,
-- TRANSACTION_ID_COLLISION.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LOCKING
-- ════════════════════════════════════════════════════════════════════════════
-- Repo-wide rule (supabase-migration-audit-p0-settlement-row-locks.sql:73-100):
--   loans → accounts → emi_schedules, and WITHIN a table rows in ascending
--   `id` order.
-- This function is the FIRST to touch all three tables, so it is the reference
-- implementation of that rule:
--   1. SELECT … FROM loans          WHERE id = p_loan_id    … FOR UPDATE
--   2. SELECT … FROM accounts       WHERE id = p_account_id … FOR UPDATE
--   3. SELECT … FROM emi_schedules  WHERE id = ANY(...) ORDER BY id FOR UPDATE
-- One row each for (1) and (2); (3) takes the whole set in one statement in
-- ascending id order. It therefore cannot invert order against
-- accept_linked_request / accept_settlement_request (which lock loans then
-- accounts), against apply_loan_remaining_delta (loans only), against
-- apply_account_balance_delta (accounts only), or against
-- transfer_between_accounts (accounts only).
--
-- ════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY
-- ════════════════════════════════════════════════════════════════════════════
-- The failure this file kills is "the call committed but the reply never
-- arrived". The transaction id is generated client-side (uuid v4,
-- transactionStore.ts:1075) and is the primary key of `transactions`, so it is
-- the natural idempotency key. After taking the loan and account locks — so
-- two in-flight copies of the same retry serialise rather than race — a
-- pre-existing row with that id short-circuits to {status:'ok', replay:true}
-- carrying the CURRENT balance, remaining and status, and moves nothing.
--
-- ════════════════════════════════════════════════════════════════════════════
-- TWO CORRECTIONS WORTH RECORDING (things the brief assumed that are not true)
-- ════════════════════════════════════════════════════════════════════════════
-- 1. "the paid_at / paid amount semantics emiStore uses" — THERE ARE NONE.
--    `emi_schedules` is (id, user_id, loan_id, installment_number, due_date,
--    amount, status, created_at) and nothing else (supabase-schema.sql:111-120;
--    the incremental-sync migrations add updated_at/deleted_at to loans, NOT to
--    emi_schedules). `emiSchedulesDb.update` is deliberately STATUS-ONLY
--    (src/lib/supabaseDb.ts:1042-1047 — "update() … is deliberately
--    status-only"). So marking an instalment paid is exactly one column write,
--    and this RPC writes exactly that. Adding a paid_at here would invent a
--    column the client cannot read back (mapEmi, :2091-2097).
-- 2. The cross-currency rate convention is NOT symmetric between directions.
--    given: destAmt   = round(amount * rate, 2)      (account-per-loan-unit)
--    taken: srcDeduct = round(amount / rate, 2)      (loan-per-account-unit)
--    (transactionStore.ts:1380 vs :1410). A single "multiply" implementation
--    would silently mis-convert every repayment of a foreign-currency loan you
--    TOOK. The server derives which convention applies from loans.type, and
--    cross-checks the client's own figure within 0.01.
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
    ARRAY['loans','deleted_at'],
    ARRAY['emi_schedules','id'], ARRAY['emi_schedules','user_id'],
    ARRAY['emi_schedules','loan_id'], ARRAY['emi_schedules','status'],
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
    RAISE EXCEPTION 'PRECONDITION FAILED: p3-atomic-repayment needs column(s) % — apply the migrations listed in this file''s APPLY ORDER header first, then re-run.',
      array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('public.apply_loan_remaining_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-repayment: apply_loan_remaining_delta is ABSENT — supabase-migration-audit-p0-loan-concurrency.sql has not been applied. This file still installs (it reimplements the same clamp inline), but the legacy client path it replaces is still running the lost-update bug F-2 describes.';
  END IF;
  IF to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-repayment: apply_account_balance_delta is ABSENT — supabase-migration-prelaunch-hardening.sql has not been applied.';
  END IF;
END;
$$;

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. record_loan_repayment — the whole repayment, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_loan_repayment(
  p_transaction_id          TEXT,
  p_loan_id                 TEXT,
  p_account_id              TEXT,
  p_amount                  NUMERIC,
  p_account_amount          NUMERIC,
  p_conversion_rate         NUMERIC,
  p_note                    TEXT,
  p_category                TEXT,
  p_date                    TIMESTAMPTZ,
  p_expected_account_balance NUMERIC,
  p_expected_loan_remaining NUMERIC,
  p_emi_schedule_ids        TEXT[],
  p_allow_negative          BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER   -- RLS is not consulted; the user_id = v_uid predicates below
                   -- ARE the access control (apply_loan_remaining_delta precedent).
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_loan           public.loans%ROWTYPE;
  v_acct           public.accounts%ROWTYPE;
  v_existing       public.transactions%ROWTYPE;
  v_ids            TEXT[] := COALESCE(p_emi_schedule_ids, ARRAY[]::TEXT[]);
  v_bad_id         TEXT;
  v_emi_marked     TEXT[] := ARRAY[]::TEXT[];
  v_rate           NUMERIC;   -- NULL for same-currency, exactly like the client
  v_pay            NUMERIC;   -- the loan-currency amount at 2dp
  v_acct_amount    NUMERIC;   -- the ACCOUNT-currency amount at 2dp (server-computed)
  v_acct_delta     NUMERIC;   -- signed: + for a 'given' loan, − for a 'taken' one
  v_new_balance    NUMERIC;
  v_prev_remaining NUMERIC;
  v_new_remaining  NUMERIC;
  v_loan_status    TEXT;
  v_src_id         TEXT;
  v_dst_id         TEXT;
  v_created_at     TIMESTAMPTZ;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation (mirrors assertInputAmountsInBounds + the branch's own
  --    first guards, so a curl cannot post what the UI cannot) ─────────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_loan_id IS NULL OR length(trim(p_loan_id)) = 0 THEN
    RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'no loan id supplied';
  END IF;

  -- A ledger-only (splits_only) repayment has NO account and must never reach
  -- this function — it belongs to loanStore.applyRepayment, which writes a row
  -- with both account ids null. Refusing loudly here is what keeps the two
  -- paths from ever crossing (tasks/lessons.md:26-27).
  IF p_account_id IS NULL OR length(trim(p_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'a tracker repayment requires an account; ledger-mode repayments use loanStore.applyRepayment, not this RPC';
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
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_loan_remaining IS NULL THEN
    RAISE EXCEPTION 'EXPECTED_REMAINING_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- ══ LOCK ORDER: loans → accounts → emi_schedules ═══════════════════════
  -- (1) the loan row, before anything else and before any write.
  PERFORM 1 FROM public.loans
   WHERE id = p_loan_id AND user_id = v_uid
     FOR UPDATE;

  -- (2) the account row.
  PERFORM 1 FROM public.accounts
   WHERE id = p_account_id AND user_id = v_uid
     FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  -- Taken AFTER the locks so two copies of the same retry serialise: the
  -- second one sees the first one's committed row instead of racing it.
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> 'repayment' THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_balance FROM public.accounts
     WHERE id = p_account_id AND user_id = v_uid;
    SELECT remaining_amount, status INTO v_new_remaining, v_loan_status
      FROM public.loans
     WHERE id = p_loan_id AND user_id = v_uid;

    RETURN jsonb_build_object(
      'status',          'ok',
      'replay',          true,
      'transaction_id',  v_existing.id,
      'account_balance', v_new_balance,
      'account_amount',  NULL,
      'loan_remaining',  v_new_remaining,
      'loan_applied',    0,
      'loan_status',     v_loan_status,
      'emi_marked',      to_jsonb(ARRAY[]::TEXT[]),
      'conversion_rate', v_existing.conversion_rate,
      -- true only in the (practically unreachable) case where the user deleted
      -- the repayment between the original call and its retry. Reported, not
      -- resurrected: the figures above are still the truth.
      'row_deleted',     (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load the loan (lock already held) ───────────────────────────────────
  SELECT * INTO v_loan FROM public.loans
   WHERE id = p_loan_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    -- Same token apply_loan_remaining_delta raises, so the client's existing
    -- "the loan is gone" branch fires instead of a retry loop.
    RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'loan is unknown, deleted, or not yours';
  END IF;

  IF v_loan.type NOT IN ('given', 'taken') THEN
    RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'unsupported loan direction: ' || COALESCE(v_loan.type, '<null>');
  END IF;

  -- ── Load the account (lock already held) ────────────────────────────────
  SELECT * INTO v_acct FROM public.accounts
   WHERE id = p_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'account is unknown, deleted, or not yours';
  END IF;

  -- ── Currency handling — identical to the client branch, INCLUDING the
  --    asymmetry between the two directions (see CORRECTION 2 in the header):
  --      given (money comes IN)  destAmt   = round(amount * rate, 2)
  --      taken (money goes OUT)  srcDeduct = round(amount / rate, 2)
  v_pay := round(p_amount, 2);

  IF v_acct.currency = v_loan.currency THEN
    v_rate        := NULL;   -- the client leaves conversionRate null here
    v_acct_amount := v_pay;
  ELSE
    IF p_conversion_rate IS NULL THEN
      -- The client throws 'Conversion rate required — different currencies'
      -- BEFORE moving anything (transactionStore.ts:1378, :1408).
      RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = v_loan.currency || ' loan vs ' || v_acct.currency || ' account';
    END IF;
    -- RATE_MIN / RATE_MAX from src/lib/conversionMath.ts:9-10, the same window
    -- p1-money-bounds pins on transactions.conversion_rate.
    IF p_conversion_rate = 'NaN'::NUMERIC
       OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
      RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
        DETAIL = 'rate must be between 0.0001 and 100000';
    END IF;
    v_rate := p_conversion_rate;
    IF v_loan.type = 'given' THEN
      v_acct_amount := round(p_amount * v_rate, 2);
    ELSE
      v_acct_amount := round(p_amount / v_rate, 2);
    END IF;
  END IF;

  -- The caller states the account-side figure it computed. Cross-checked,
  -- never trusted: the server recomputes and refuses a payload that disagrees
  -- by more than a cent (the 0.01 tolerance p1-money-bounds uses for split
  -- arithmetic). NULL = "you decide".
  IF p_account_amount IS NOT NULL
     AND abs(p_account_amount - v_acct_amount) > 0.01 THEN
    RAISE EXCEPTION 'ACCOUNT_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = 'client said ' || p_account_amount::TEXT || ', server computes ' || v_acct_amount::TEXT;
  END IF;

  -- Direction. Derived from loans.type exactly as the client does — never from
  -- a caller-supplied flag, which a curl could invert to turn a repayment into
  -- a free credit.
  IF v_loan.type = 'given' THEN
    v_acct_delta := v_acct_amount;      -- they paid ME back → account grows
    v_src_id     := NULL;
    v_dst_id     := v_acct.id;
  ELSE
    v_acct_delta := -v_acct_amount;     -- I paid THEM back → account shrinks
    v_src_id     := v_acct.id;
    v_dst_id     := NULL;
  END IF;

  -- ── Optimistic lock #1: the loan. Same token, same 2dp comparison and same
  --    semantics as apply_loan_remaining_delta (audit-p0-loan-concurrency.sql
  --    :132-137), so src/lib/loanRemainingDelta.ts's ladder is unchanged.
  v_prev_remaining := round(v_loan.remaining_amount, 2);
  IF v_prev_remaining <> round(p_expected_loan_remaining, 2) THEN
    RAISE EXCEPTION 'LOAN_REMAINING_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'loan_id',                  v_loan.id,
        'loan_remaining',           v_loan.remaining_amount,
        'expected_loan_remaining',  p_expected_loan_remaining,
        'loan_status',              v_loan.status
      )::TEXT;
  END IF;

  -- ── Optimistic lock #2: the account. Same token as
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

  -- ── Insufficient-balance guard (debit direction only) ───────────────────
  -- The server half of checkBalanceForTransaction (transactionStore.ts:253-262).
  -- NOT inherited from apply_account_balance_delta, which has no balance guard
  -- at all — the client has always been the only gate ("the UI guard is the
  -- real protection", CLAUDE.md). p_allow_negative is the escape the ledger
  -- bypass and the reversal path use.
  IF v_acct_delta < 0
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

  -- ── (3) Lock the EMI rows, ascending id, in ONE statement — and validate
  --    them BEFORE any write, so a poisoned id refuses a repayment instead of
  --    half-applying one. The client only ever sends ids it computed from
  --    uncoveredToPaidIds (src/lib/emiCoverage.ts) plus an explicitly targeted
  --    input.emiId; the server re-derives nothing but re-checks EVERYTHING.
  IF array_length(v_ids, 1) > 0 THEN
    PERFORM 1 FROM public.emi_schedules
     WHERE id = ANY(v_ids) AND user_id = v_uid
     ORDER BY id
       FOR UPDATE;

    -- Every id must exist, be mine, and belong to THIS loan. (The client's
    -- trackedMarkEmiPaid looks an emiId up by id alone and never checks the
    -- loan — this is a deliberate tightening, not a behaviour change: the ids
    -- it sends are always filtered by loanId one line earlier.)
    SELECT x.id INTO v_bad_id
      FROM unnest(v_ids) AS x(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.emi_schedules e
        WHERE e.id = x.id AND e.user_id = v_uid AND e.loan_id = p_loan_id
     )
     LIMIT 1;

    IF v_bad_id IS NOT NULL THEN
      RAISE EXCEPTION 'EMI_SCHEDULE_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'instalment ' || v_bad_id || ' is unknown, not yours, or belongs to another loan';
    END IF;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════
  -- Arithmetic is done IN the UPDATE (never from a plpgsql snapshot) — the
  -- L-4 lesson from supabase-migration-audit-p0-settlement-row-locks.sql.

  -- 1. The loan. Byte-for-byte the expression apply_loan_remaining_delta uses:
  --    clamp at 0 (so an overpayment settles instead of inverting the loan),
  --    round to 2dp, derive status in the SAME statement so the two columns
  --    can never disagree (audit F-19).
  UPDATE public.loans
     SET remaining_amount = round(GREATEST(0, remaining_amount - v_pay), 2),
         status = CASE
                    WHEN round(GREATEST(0, remaining_amount - v_pay), 2) = 0
                      THEN 'settled'
                    ELSE 'active'
                  END
   WHERE id = v_loan.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING remaining_amount, status INTO v_new_remaining, v_loan_status;

  IF v_new_remaining IS NULL THEN
    -- Unreachable: the row was selected under FOR UPDATE above. Kept so a
    -- future edit that loosens the locks fails loudly instead of committing
    -- the account leg alone.
    RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the loan disappeared mid-repayment';
  END IF;

  -- 2. The account. The balance itself is not re-rounded, matching
  --    apply_account_balance_delta (`balance = balance + p_delta`); only the
  --    DELTA is 2dp, matching accountStore.updateBalance's
  --    Math.round(delta * 100) / 100.
  UPDATE public.accounts
     SET balance = balance + v_acct_delta
   WHERE id = v_acct.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the account disappeared mid-repayment';
  END IF;

  -- 3. The EMI marks. Status-only (see CORRECTION 1). Already-paid rows are
  --    SKIPPED rather than refused — exactly what trackedMarkEmiPaid does
  --    (`if (prevStatus === 'paid') return;`, transactionStore.ts:606) — and
  --    are simply absent from emi_marked so the client's inverse only unwinds
  --    what actually changed.
  IF array_length(v_ids, 1) > 0 THEN
    WITH marked AS (
      UPDATE public.emi_schedules
         SET status = 'paid'
       WHERE id = ANY(v_ids)
         AND user_id = v_uid
         AND loan_id = p_loan_id
         AND status <> 'paid'
      RETURNING id
    )
    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::TEXT[])
      INTO v_emi_marked
      FROM marked;
  END IF;

  -- 4. The row. EXACTLY the columns and values transactionsDb.add writes
  --    (src/lib/supabaseDb.ts:239-258) for a repayment, read back the same way
  --    by mapTransaction:
  --      type                   'repayment'
  --      amount                 the caller's amount, VERBATIM (the client
  --                             stores `input.amount` unrounded on the row and
  --                             rounds only the deltas)
  --      currency               the LOAN's currency (not the account's)
  --      source/destination     exactly one is set, per direction; the other is
  --                             NULL, which is also what the ledger path writes
  --                             for BOTH — every reader already tolerates it
  --      related_person         loans.person_name
  --      person_id              loans.person_id (may be NULL)
  --      related_loan_id        the loan
  --      related_goal_id        NULL
  --      related_investment_id  omitted entirely — the client only sends it
  --                             when non-null, so a database without
  --                             supabase-migration-investments.sql still works
  --      conversion_rate        NULL same-currency, the rate cross-currency
  --      notes                  the caller's notes, INCLUDING the internal
  --                             note the client builds; the server never
  --                             synthesises one
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
    p_transaction_id, v_uid, 'repayment', p_amount, v_loan.currency,
    v_src_id, v_dst_id,
    v_loan.person_name, v_loan.person_id, v_loan.id, NULL,
    v_rate, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',          'ok',
    'replay',          false,
    'transaction_id',  p_transaction_id,
    'account_balance', v_new_balance,
    -- What the ACCOUNT actually moved, unsigned; the client registers its
    -- inverse against this, never against a locally recomputed figure.
    'account_amount',  v_acct_amount,
    'account_delta',   v_acct_delta,
    'loan_remaining',  v_new_remaining,
    -- What the LOAN actually moved — differs from p_amount when the clamp bit
    -- (an overpayment). The client's compensation must give back THIS.
    'loan_applied',    round(v_prev_remaining - v_new_remaining, 2),
    'loan_status',     v_loan_status,
    'emi_marked',      to_jsonb(v_emi_marked),
    'conversion_rate', v_rate,
    'created_at',      v_created_at,
    'currency',        v_loan.currency,
    'row_deleted',     false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_loan_repayment(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, TEXT[], BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_loan_repayment(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, TEXT[], BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.record_loan_repayment(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, TEXT[], BOOLEAN
) IS
  'Audit L4 step 2 (MF-01 / F-2 / O-1 / F-4): the whole full-tracker loan repayment — the account leg, the loans.remaining_amount + status leg, the covered EMI status marks and the transactions row — in ONE Postgres transaction, so a flaky network can no longer move a balance without recording it. Locks loans -> accounts -> emi_schedules (repo rule), ascending id. Compare-and-swap on BOTH the expected account balance (BALANCE_CONFLICT) and the expected loan remaining (LOAN_REMAINING_CONFLICT) using the same tokens the existing client ladders already parse. Direction (credit vs debit) and the cross-currency convention (multiply for a loan given, divide for a loan taken) are derived from loans.type, never from a caller flag. Clamp at 0 + 2dp + status derivation identical to apply_loan_remaining_delta. Idempotent on p_transaction_id. Does NOT cover the credit-card cash-advance credit leg — that case stays on the legacy client path. Ledger-mode (splits_only) repayments never come here: a null account raises ACCOUNT_NOT_FOUND. Gated client-side by VITE_ATOMIC_REPAYMENT.';

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
   AND p.proname = 'record_loan_repayment';

-- V2. Privileges: authenticated may execute; anon and PUBLIC may not.
--     EXPECT: auth_can = t, anon_can = f, public_can = f.
SELECT has_function_privilege('authenticated',
         'public.record_loan_repayment(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,text[],boolean)',
         'EXECUTE') AS auth_can,
       has_function_privilege('anon',
         'public.record_loan_repayment(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,text[],boolean)',
         'EXECUTE') AS anon_can,
       has_function_privilege('public',
         'public.record_loan_repayment(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,text[],boolean)',
         'EXECUTE') AS public_can;

-- V3. Body roll-call — the invariants this file exists to install.
--     EXPECT: every column t.
SELECT (d LIKE '%FOR UPDATE%')                              AS takes_row_locks,
       (d LIKE '%ORDER BY id%')                             AS locks_emis_in_id_order,
       (d LIKE '%BALANCE_CONFLICT%')                        AS raises_balance_conflict,
       (d LIKE '%LOAN_REMAINING_CONFLICT%')                 AS raises_loan_conflict,
       (d LIKE '%INSUFFICIENT_BALANCE%')                    AS guards_balance,
       (d LIKE '%p_allow_negative%')                        AS has_negative_escape,
       (d LIKE '%user_id = v_uid%')                         AS owner_scoped,
       (d LIKE '%deleted_at IS NULL%')                      AS skips_deleted,
       (d LIKE '%GREATEST(0, remaining_amount - v_pay)%')   AS clamps_at_zero,
       (d LIKE '%balance = balance + v_acct_delta%')        AS delta_in_statement,
       (d LIKE '%v_loan.type = ''given''%')                 AS direction_from_loan,
       (d LIKE '%EMI_SCHEDULE_INVALID%')                    AS revalidates_emis,
       (d LIKE '%INSERT INTO public.transactions%')         AS writes_the_row
  FROM (SELECT pg_get_functiondef(
          'public.record_loan_repayment(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,text[],boolean)'::regprocedure
        ) AS d) s;

-- V4. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_def TEXT;
  v_sig CONSTANT TEXT :=
    'public.record_loan_repayment(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,text[],boolean)';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-repayment: the function is missing';
  END IF;

  v_def := pg_get_functiondef(v_sig::regprocedure);

  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'p3-atomic-repayment: the row locks are gone — two concurrent repayments can now interleave';
  END IF;
  IF v_def NOT LIKE '%BALANCE_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-repayment: the account compare-and-swap is gone — the client retry ladder is dead code';
  END IF;
  IF v_def NOT LIKE '%LOAN_REMAINING_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-repayment: the loan compare-and-swap is gone — audit F-2 (lost update) is back';
  END IF;
  IF v_def NOT LIKE '%GREATEST(0, remaining_amount - v_pay)%' THEN
    RAISE EXCEPTION 'p3-atomic-repayment: the overpayment clamp is gone — a loan can now go negative';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-repayment: authenticated cannot execute the function';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-repayment: anon can execute the function';
  END IF;

  RAISE NOTICE 'p3-atomic-repayment: verification passed';
END;
$$;

-- V5. DRIFT WATCH #1 (the reconciliation surface L7 will grow) — repayment
--     rows whose account leg contradicts the loan they belong to. Reads
--     history written by the legacy client as well as rows this RPC writes.
--     EXPECT: zero rows, before and after.
--
--     Legitimate shapes:
--       loan 'given'  → destination_account_id set, source NULL   (money in)
--       loan 'taken'  → source_account_id set, destination NULL   (money out)
--                       …or destination = a CREDIT CARD, which is the
--                       cash-advance credit leg the client still owns.
--       ledger mode   → BOTH NULL (loanStore.applyRepayment / write-offs /
--                       card-bill auto-settle rows) — explicitly allowed.
SELECT t.id,
       t.created_at,
       l.type   AS loan_direction,
       t.source_account_id,
       t.destination_account_id,
       CASE
         WHEN l.type = 'given' AND t.source_account_id IS NOT NULL
           THEN 'repayment of a loan you GAVE is debiting an account'
         WHEN l.type = 'taken' AND t.destination_account_id IS NOT NULL
              AND COALESCE(da.type, '') <> 'credit_card'
           THEN 'repayment of a loan you TOOK is crediting a non-card account'
         ELSE 'unclassified direction drift'
       END AS problem
  FROM public.transactions t
  JOIN public.loans l ON l.id = t.related_loan_id
  LEFT JOIN public.accounts da ON da.id = t.destination_account_id
 WHERE t.type = 'repayment'
   AND t.deleted_at IS NULL
   AND l.deleted_at IS NULL
   AND (
     (l.type = 'given' AND t.source_account_id IS NOT NULL)
     OR (l.type = 'taken' AND t.destination_account_id IS NOT NULL
         AND COALESCE(da.type, '') <> 'credit_card')
   )
 ORDER BY t.created_at DESC;

-- V6. DRIFT WATCH #2 — the F-2 corruption signature itself: a loan whose
--     recorded repayments add up to MORE than the loan ever dropped. This is
--     what a lost update leaves behind, and it is the single most valuable
--     invariant to watch during rollout.
--     EXPECT: zero rows. (Historical rows written before
--     audit-p0-loan-concurrency.sql may show up — that is the finding, not a
--     false positive.)
SELECT l.id,
       l.person_name,
       l.currency,
       l.total_amount,
       l.remaining_amount,
       round(l.total_amount - l.remaining_amount, 2) AS loan_moved,
       round(r.recorded, 2)                          AS repayments_recorded,
       round(r.recorded - (l.total_amount - l.remaining_amount), 2) AS excess
  FROM public.loans l
  JOIN LATERAL (
    SELECT COALESCE(sum(t.amount), 0) AS recorded
      FROM public.transactions t
     WHERE t.related_loan_id = l.id
       AND t.type = 'repayment'
       AND t.deleted_at IS NULL
  ) r ON true
 WHERE l.deleted_at IS NULL
   AND r.recorded > (l.total_amount - l.remaining_amount) + 0.01
 ORDER BY excess DESC;

-- V7. DRIFT WATCH #3 — cross-currency consistency on repayment rows: a row
--     whose loan currency differs from its account's currency must carry a
--     rate, and one where they match must not.
--     EXPECT: zero rows.
SELECT t.id, t.created_at, t.currency AS loan_currency,
       a.currency AS account_currency, t.conversion_rate
  FROM public.transactions t
  JOIN public.accounts a
    ON a.id = COALESCE(t.source_account_id, t.destination_account_id)
 WHERE t.type = 'repayment'
   AND t.deleted_at IS NULL
   AND (
     (a.currency <> t.currency AND t.conversion_rate IS NULL)
     OR (a.currency  = t.currency AND t.conversion_rate IS NOT NULL)
   )
 ORDER BY t.created_at DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Manual authenticated QA (run as a normal signed-in account).
-- Every one of these was also run in Docker — see
-- docs/server-side-money-engine.md §8.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  1. Happy path, loan GIVEN (they owe you 1000, you have 500 in Bank, both AED):
--       select public.record_loan_repayment(
--         gen_random_uuid()::text, '<loan>', '<bank>', 250, 250, null,
--         '', '', now(), 500, 1000, null, false);
--     → {"account_balance":750.00,"loan_remaining":750.00,"loan_status":"active"}
--       and exactly one transactions row: type 'repayment',
--       destination_account_id = <bank>, source_account_id NULL.
--
--  2. Happy path, loan TAKEN (you owe 1000, Bank has 500):
--     → account_balance 250.00, loan_remaining 750.00, and the row carries
--       source_account_id = <bank>, destination_account_id NULL.
--
--  3. Stale loan expectation: repeat #1 with p_expected_loan_remaining = 1000.
--     → LOAN_REMAINING_CONFLICT, DETAIL carries the true 750.00. NOTHING moved
--       — not the account, not the loan, no row.
--
--  4. Stale account expectation: correct remaining, wrong balance.
--     → BALANCE_CONFLICT, DETAIL carries the true balance. Nothing moved.
--
--  5. Insufficient (taken direction, pay 10 000 from a 250 account).
--     → INSUFFICIENT_BALANCE, DETAIL {available:250, requested:10000}.
--       With p_allow_negative = true it succeeds and the account goes negative
--       — that is the splits_only bypass, and the reversal hatch.
--
--  6. Overpay clamp: loan_remaining 250, pay 400 (given direction).
--     → loan_remaining 0.00, loan_status 'settled', loan_applied 250.00, and
--       account_balance grew by the FULL 400 — exactly what the client does
--       today (the row's amount is the money that moved; the loan clamps).
--
--  7. Cross-currency GIVEN: PKR loan, AED account, amount 7650, rate 0.01307.
--     → account gains round(7650 * 0.01307, 2). A lying p_account_amount →
--       ACCOUNT_AMOUNT_MISMATCH, nothing moves. Omitting the rate →
--       CONVERSION_RATE_REQUIRED.
--     Cross-currency TAKEN: AED account, PKR loan, amount 7650, rate 76.5.
--     → account loses round(7650 / 76.5, 2) = 100.00.  NOTE THE DIVISION.
--
--  8. EMI marks: pass the ids of the instalments the client computed.
--     → emi_marked lists the ones that flipped; an already-'paid' id is
--       silently skipped (not an error); an id belonging to ANOTHER loan (or
--       another user) → EMI_SCHEDULE_INVALID and NOTHING moves.
--
--  9. Replay: call #1 again with the SAME p_transaction_id.
--     → {"replay":true, …} with the CURRENT figures; the money moves once and
--       there is one row, not two.
--
-- 10. Ledger guard: p_account_id = NULL.
--     → ACCOUNT_NOT_FOUND. A splits_only repayment can never be written here.
--
-- 11. Someone else's loan or account id.
--     → LOAN_NOT_FOUND / ACCOUNT_NOT_FOUND, never a partial write.
--
-- 12. anon: call it with the anon key.
--     → permission denied for function record_loan_repayment.
-- ═══════════════════════════════════════════════════════════════════════════
