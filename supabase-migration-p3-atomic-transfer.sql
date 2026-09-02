-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 / L4 PILOT: the account→account transfer becomes ONE Postgres
-- transaction (`transfer_between_accounts`).
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER
--   AFTER  supabase-migration-prelaunch-hardening.sql        (#18 in docs/audit-2026-09/APPLY-ORDER.md)
--            ^ defines apply_account_balance_delta, the CAS contract this file
--              mirrors, and the accounts/transactions FKs.
--   AFTER  supabase-migration-p1-money-bounds.sql
--            ^ the CHECK constraints this RPC's own validation mirrors
--              (amount >= 0 AND < 1e12; conversion_rate in [0.0001, 100000]).
--   Also requires (all in the historical set, long applied):
--     supabase-schema.sql                      accounts, transactions
--     supabase-migration-phase1-persons.sql    transactions.person_id
--     supabase-migration-reconciliation.sql    is_reconciled/reconciled_at/by
--     supabase-migration-receipts.sql          transactions.receipt_path
--     supabase-migration-incremental-sync-core.sql        updated_at (+trigger)
--     supabase-migration-incremental-sync-tombstones.sql  deleted_at
--   Section 0 hard-checks every one of those columns and ABORTS with a named
--   message rather than creating a function that would fail at runtime.
--
--   SAFE AHEAD OF THE CLIENT. This file only ADDS one function. Nothing calls
--   it until the web/Android build ships with VITE_ATOMIC_TRANSFER=true
--   (src/stores/transactionStore.ts, `ATOMIC_TRANSFER_ENABLED`), which is
--   FALSE by default. Order versus the audit-P0 batch is immaterial — no
--   object in that batch is touched here (verified by grepping every
--   CREATE FUNCTION / policy / trigger name in supabase-migration-audit-p0-*).
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES — the evidence
-- ────────────────────────────────────────────────────────────────────────────
-- docs/audit-2026-09/07-mobile-first.md  MF-01 (high, borderline critical):
--   "Money can be left half-moved server-side on a flaky network; compensation
--    and refetch fail in the same outage; the outbox that would fix it is
--    inert."  Fix (L): "…long term, move multi-leg money moves into single
--    SECURITY DEFINER RPCs so atomicity lives in Postgres."
-- docs/audit-2026-09/12-qa-review.md  O-1 / F-4 (high):
--   "permanent half-applied money (debited source, no credited destination)
--    with no repair queue and no persisted marker."
-- docs/audit-2026-09/02-repository-architecture.md  H-3 / H-4:
--   the 640-line 12-case client switch is the atomicity ceiling; the offline
--   layer that would repair it is a scaffold.
-- docs/audit-2026-09/00-executive-summary.md  M1 / L4:
--   L4 = "Progressive server-side money engine: move processTransaction
--   branches into Postgres RPCs".  THIS FILE IS THE PILOT for that programme —
--   see docs/server-side-money-engine.md for the rollout and the order the
--   remaining branches follow.
--
-- src/lib/mutationSafety.ts:10-13 states the ceiling in the repo's own words:
--   "Compensations may themselves fail (the same network outage that killed
--    the forward write usually kills the inverse)."
-- No client pattern can raise that ceiling. Postgres can: BEGIN/COMMIT.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE ARTIFACT CONTRACT — what the CLIENT leaves behind today, and what this
-- RPC must reproduce EXACTLY. Traced from src/stores/transactionStore.ts
-- `case 'transfer'` (:991-1118) and everything it calls.
-- ────────────────────────────────────────────────────────────────────────────
--
--  # | Artifact                    | Today (client, 2 remote round-trips)                                   | This RPC (1 transaction)
-- ---+-----------------------------+------------------------------------------------------------------------+--------------------------------------------
--  1 | source accounts.balance     | trackedBalanceDelta(-amount) → accountStore.updateBalance →             | UPDATE … SET balance = balance - round(p_amount,2)
--    |                             | accountsDb.applyBalanceDelta → apply_account_balance_delta CAS          | after FOR UPDATE + expected-balance compare
--  2 | destination accounts.balance| trackedBalanceDelta(+amount) same-currency, or                          | UPDATE … SET balance = balance + v_dest_delta
--    |                             | +round(amount*rate,2) cross-currency — SAME CAS RPC, SECOND round-trip | in the SAME transaction as #1
--  3 | transactions row            | trackedAddTransaction → transactionsDb.add (upsert), AFTER the switch   | INSERT … same 20 columns, same values
--  4 | Dexie mirror (transactions) | mirrorPut(db.transactions, tx) + markMirrorStale('transactions')        | client-side, post-commit (unchanged)
--  5 | Dexie mirror (accounts)     | mirrorPut(db.accounts, updated) + markMirrorStale('accounts')           | client-side, post-commit (unchanged)
--  6 | Zustand accounts/transactions| set() inside the two stores                                            | client-side, post-commit (unchanged)
--  7 | activity_log row            | logActivitySafe('transaction_created', description) — POST-commit,      | client-side, post-commit (unchanged —
--    |                             | best-effort, failure must NOT roll money back                           | deliberately NOT moved into the RPC)
--  8 | reminder reschedule         | nudgeReminderSchedule() — fire-and-forget, native only                  | client-side, post-commit (unchanged)
--  9 | cash-advance auto-settle    | when destination.type = 'credit_card': loan repayments + ledger-only    | client-side, INSIDE the same MutationScope
--    |                             | 'repayment' rows (:1033-1116). Touches loans + transactions, NOT any    | (unchanged — a later pilot moves it; see
--    |                             | account balance: "the money already moved via the transfer legs above"  | docs/server-side-money-engine.md §5)
--
-- Artifacts 4-8 are client-side by design: they are local caches and a
-- best-effort audit trail, and the repo's own rule is that an activity-log
-- failure must never roll back money that has moved
-- (transactionStore.ts:654-667, logActivitySafe).
--
-- ────────────────────────────────────────────────────────────────────────────
-- BOTH APP MODES TRACED (tasks/lessons.md:6-13)
-- ────────────────────────────────────────────────────────────────────────────
-- full_tracker  — the only mode that reaches this RPC. Both account ids are
--                 always non-null for a transfer.
-- splits_only   — UNREACHABLE, and this is confirmed rather than assumed:
--                 * a transfer REQUIRES two accounts; ledger-only mode has no
--                   accounts at all (src/stores/appModeStore.ts).
--                 * the client branch opens with
--                     const src = accountStore.getAccount(input.sourceAccountId);
--                     const dest = accountStore.getAccount(input.destinationAccountId);
--                     if (!src || !dest) throw new Error('Account not found');
--                   and, unlike expense / loan_given / loan_taken / repayment,
--                   'transfer' is NOT in isSimpleModeBalanceBypassAllowed
--                   (transactionStore.ts:238-246) — so `checkBalance` is never
--                   waived for it either.
--                 * no ledger-only surface offers a transfer: the QuickEntry
--                   type list and the account pickers are account-gated.
--                 This RPC keeps that property: `ACCOUNT_NOT_FOUND` is raised
--                 for a NULL/unknown/soft-deleted/foreign account id, so a
--                 ledger-mode caller fails loudly instead of writing a row with
--                 both account ids null (the failure class lessons.md records).
--
-- ────────────────────────────────────────────────────────────────────────────
-- ERROR CONTRACT — only what the client already understands
-- ────────────────────────────────────────────────────────────────────────────
--   BALANCE_CONFLICT      message is the bare token, byte-identical to
--                         apply_account_balance_delta
--                         (supabase-migration-prelaunch-hardening.sql:270), so
--                         src/lib/supabaseDb.ts's existing
--                         `err.message.includes('BALANCE_CONFLICT')` parser and
--                         accountStore.updateBalance's refetch-and-retry-once
--                         ladder work unchanged. The current balances travel in
--                         DETAIL (PostgREST surfaces it as `details`) so the
--                         client can retry without a second round-trip.
--   INSUFFICIENT_BALANCE  the server half of the client's `checkBalance`
--                         (transactionStore.ts:195-204). apply_account_balance_delta
--                         HAS NO SUCH GUARD — verified by reading it in full;
--                         the guard has always lived in the client, which is
--                         exactly why "the UI guard is the real protection"
--                         (CLAUDE.md). DETAIL carries {account_id, account_name,
--                         available, requested, currency} so the wrapper can
--                         rebuild the identical bilingual tStatic('err_insufficient')
--                         string the user sees today.
--                         Escape: p_allow_negative = true skips it (the
--                         REVERSAL_NEEDS_NEGATIVE hatch the delete path already
--                         offers — transactionStore.ts:211-236 — and the only
--                         way a credit-card leg may legitimately go negative).
--                         The shipped create path always passes FALSE, which is
--                         exactly today's behaviour: `checkBalance(src, amount)`
--                         is applied to a credit_card source too, because a
--                         card's `balance` IS its available credit.
--
-- Everything else is a programming error or a poisoned payload, not a business
-- outcome, and is raised with a greppable token: NOT_AUTHENTICATED,
-- ACCOUNT_NOT_FOUND, SAME_ACCOUNT, INVALID_AMOUNT, EXPECTED_BALANCE_REQUIRED,
-- CONVERSION_RATE_REQUIRED, INVALID_CONVERSION_RATE, DESTINATION_AMOUNT_MISMATCH,
-- TRANSACTION_ID_COLLISION. None of them is reachable from the shipped client,
-- which validates all of it first — they exist because one curl against
-- PostgREST bypasses every client guard.
--
-- ────────────────────────────────────────────────────────────────────────────
-- LOCKING
-- ────────────────────────────────────────────────────────────────────────────
-- Repo-wide rule (supabase-migration-audit-p0-settlement-row-locks.sql:73-100):
--   loans → accounts → emi_schedules, and WITHIN a table rows are locked in
--   ascending `id` order.
-- This function touches ONLY accounts, and takes BOTH rows in ascending id
-- order in ONE statement before any write — so two concurrent transfers over
-- the same pair (A→B and B→A) cannot invert their lock order and cannot
-- deadlock. It never touches loans, so it cannot participate in a cycle with
-- accept_linked_request / accept_settlement_request.
--
-- ────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY
-- ────────────────────────────────────────────────────────────────────────────
-- The failure this file exists to kill is "the call committed but the reply
-- never arrived". A blind retry must therefore NOT move money twice. The
-- transaction id is generated client-side (uuid v4, transactionStore.ts:947)
-- and is the primary key of `transactions`, so it is the natural idempotency
-- key: after taking both account locks, a pre-existing row with that id and
-- owner short-circuits to {status:'ok', replay:true} carrying the CURRENT
-- balances. Taking the locks first is deliberate — it serialises two in-flight
-- copies of the same retry so the second one sees the first one's committed row
-- instead of racing it.
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
    RAISE EXCEPTION 'PRECONDITION FAILED: p3-atomic-transfer needs column(s) % — apply the migrations listed in this file''s APPLY ORDER header first, then re-run.',
      array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-transfer: apply_account_balance_delta is ABSENT — supabase-migration-prelaunch-hardening.sql has not been applied. This file still installs, but the legacy two-leg client path it replaces is already broken.';
  END IF;
END;
$$;

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. transfer_between_accounts — the whole transfer, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transfer_between_accounts(
  p_transaction_id              TEXT,
  p_source_account_id           TEXT,
  p_destination_account_id      TEXT,
  p_amount                      NUMERIC,
  p_destination_amount          NUMERIC,
  p_conversion_rate             NUMERIC,
  p_note                        TEXT,
  p_category                    TEXT,
  p_date                        TIMESTAMPTZ,
  p_expected_source_balance     NUMERIC,
  p_expected_destination_balance NUMERIC,
  p_allow_negative              BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER   -- RLS is not consulted; the user_id = v_uid predicates below
                   -- ARE the access control (apply_loan_remaining_delta precedent).
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_src          public.accounts%ROWTYPE;
  v_dst          public.accounts%ROWTYPE;
  v_existing     public.transactions%ROWTYPE;
  v_src_delta    NUMERIC;   -- what the source loses (2dp, like the client)
  v_dst_delta    NUMERIC;   -- what the destination gains (2dp, like the client)
  v_rate         NUMERIC;   -- NULL for same-currency, exactly like the client
  v_new_src      NUMERIC;
  v_new_dst      NUMERIC;
  v_created_at   TIMESTAMPTZ;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation (mirrors assertInputAmountsInBounds + the branch's
  --    own first three guards, so a curl cannot post what the UI cannot) ───
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_source_account_id IS NULL OR p_destination_account_id IS NULL THEN
    -- A ledger-only (splits_only) caller would land here. Loud, not silent:
    -- a transfer with a null account id is the "row with both account ids
    -- null" failure class tasks/lessons.md records.
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'a transfer requires both a source and a destination account';
  END IF;

  IF p_source_account_id = p_destination_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'choose a different destination account';
  END IF;

  -- Strictly positive, finite, below the shared 1e12 ceiling — the same rule
  -- as src/lib/currencyValidation.ts checkMoneyAmount and
  -- supabase-migration-p1-money-bounds.sql. NUMERIC 'NaN' is a real value in
  -- Postgres, so it is rejected explicitly.
  IF p_amount IS NULL OR p_amount = 'NaN'::NUMERIC OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'amount must be greater than 0 and less than 1e12';
  END IF;

  IF p_expected_source_balance IS NULL OR p_expected_destination_balance IS NULL THEN
    -- Refusing to guess is the point: without an expectation there is no
    -- compare-and-swap, and this RPC would become a blind write.
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Lock BOTH account rows, ascending id, in one statement ──────────────
  -- Before any read-then-act and before any write. See the LOCKING note.
  PERFORM 1
     FROM public.accounts
    WHERE id IN (p_source_account_id, p_destination_account_id)
      AND user_id = v_uid
    ORDER BY id
      FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  -- Taken AFTER the locks so two copies of the same retry serialise.
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> 'transfer' THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_src FROM public.accounts
     WHERE id = p_source_account_id AND user_id = v_uid;
    SELECT balance INTO v_new_dst FROM public.accounts
     WHERE id = p_destination_account_id AND user_id = v_uid;

    RETURN jsonb_build_object(
      'status',              'ok',
      'replay',              true,
      'transaction_id',      v_existing.id,
      'source_balance',      v_new_src,
      'destination_balance', v_new_dst,
      'destination_amount',  NULL,
      'conversion_rate',     v_existing.conversion_rate,
      -- true only in the (practically unreachable) case where the user deleted
      -- the transfer between the original call and its retry. Reported, not
      -- resurrected: the balances above are still the truth.
      'row_deleted',         (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load both accounts (locks already held) ─────────────────────────────
  SELECT * INTO v_src FROM public.accounts
   WHERE id = p_source_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'source account is unknown, deleted, or not yours';
  END IF;

  SELECT * INTO v_dst FROM public.accounts
   WHERE id = p_destination_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'destination account is unknown, deleted, or not yours';
  END IF;

  -- ── Currency handling — identical to the client branch ──────────────────
  --   same currency      → destination gains exactly what the source loses,
  --                        conversion_rate stays NULL
  --   different currency → rate REQUIRED (the client throws
  --                        'Conversion rate required for cross-currency move'
  --                        BEFORE moving anything), destination gains
  --                        round(amount * rate, 2)
  v_src_delta := round(p_amount, 2);

  IF v_src.currency = v_dst.currency THEN
    v_rate      := NULL;
    v_dst_delta := v_src_delta;
  ELSE
    IF p_conversion_rate IS NULL THEN
      RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = v_src.currency || ' → ' || v_dst.currency;
    END IF;
    -- RATE_MIN / RATE_MAX from src/lib/conversionMath.ts:9-10, the same window
    -- p1-money-bounds pins on transactions.conversion_rate.
    IF p_conversion_rate = 'NaN'::NUMERIC
       OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
      RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
        DETAIL = 'rate must be between 0.0001 and 100000';
    END IF;
    v_rate      := p_conversion_rate;
    v_dst_delta := round(p_amount * v_rate, 2);
  END IF;

  -- The caller may state what it expects to land. Cross-checked, never
  -- trusted: the server recomputes and refuses a payload that disagrees by
  -- more than a cent (the same 0.01 tolerance p1-money-bounds uses for split
  -- arithmetic). NULL = "you decide", which is what the client sends for a
  -- same-currency move.
  IF p_destination_amount IS NOT NULL
     AND abs(p_destination_amount - v_dst_delta) > 0.01 THEN
    RAISE EXCEPTION 'DESTINATION_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
      DETAIL = 'client said ' || p_destination_amount::TEXT || ', server computes ' || v_dst_delta::TEXT;
  END IF;

  -- ── Optimistic lock — the same compare-and-swap as the account CAS, on
  --    BOTH rows, so a stale client cannot half-apply against fresh truth.
  --    Compared at 2dp because the client sends IEEE-754 doubles
  --    (apply_loan_remaining_delta:132 precedent).
  IF round(v_src.balance, 2) <> round(p_expected_source_balance, 2)
     OR round(v_dst.balance, 2) <> round(p_expected_destination_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'source_account_id',            v_src.id,
        'source_balance',               v_src.balance,
        'expected_source_balance',      p_expected_source_balance,
        'destination_account_id',       v_dst.id,
        'destination_balance',          v_dst.balance,
        'expected_destination_balance', p_expected_destination_balance
      )::TEXT;
  END IF;

  -- ── Insufficient-balance guard ──────────────────────────────────────────
  -- The server half of checkBalance (transactionStore.ts:195-204). Note this
  -- is NOT inherited from apply_account_balance_delta, which has no balance
  -- guard at all — the client has always been the only gate.
  -- p_allow_negative is the deliberate escape (the REVERSAL_NEEDS_NEGATIVE
  -- hatch); the shipped create path passes FALSE, including when the source is
  -- a credit card, because a card's balance IS its available credit.
  IF NOT COALESCE(p_allow_negative, false) AND v_src.balance < v_src_delta THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_src.id,
        'account_name', v_src.name,
        'account_type', v_src.type,
        'currency',     v_src.currency,
        'available',    v_src.balance,
        'requested',    v_src_delta
      )::TEXT;
  END IF;

  -- ── The money. Both legs, one statement each, one transaction. ──────────
  -- Arithmetic is done IN the UPDATE (never from a plpgsql snapshot) — the
  -- L-4 lesson from supabase-migration-audit-p0-settlement-row-locks.sql.
  -- The balance itself is not re-rounded, matching apply_account_balance_delta
  -- (`balance = balance + p_delta`); only the DELTA is 2dp, matching the
  -- client's Math.round(delta * 100) / 100 in accountStore.updateBalance.
  UPDATE public.accounts
     SET balance = balance - v_src_delta
   WHERE id = v_src.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_src;

  UPDATE public.accounts
     SET balance = balance + v_dst_delta
   WHERE id = v_dst.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_dst;

  IF v_new_src IS NULL OR v_new_dst IS NULL THEN
    -- Unreachable: both rows were selected under FOR UPDATE two statements
    -- ago. Kept so a future edit that loosens the locks fails loudly instead
    -- of committing one leg.
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'an account disappeared mid-transfer';
  END IF;

  -- ── The row. EXACTLY the columns and values transactionsDb.add writes
  --    (src/lib/supabaseDb.ts:240-259) for a transfer, read back the same way
  --    by mapTransaction (:2042-2063):
  --      type                   'transfer'
  --      amount                 the caller's amount, VERBATIM (the client
  --                             stores `input.amount` unrounded on the row and
  --                             rounds only the balance deltas)
  --      currency               the SOURCE account's currency
  --      related_person / person_id / related_loan_id / related_goal_id  NULL
  --      related_investment_id  omitted entirely — the client only sends it
  --                             when non-null, so a database without
  --                             supabase-migration-investments.sql still works
  --      conversion_rate        NULL same-currency, the rate cross-currency
  --      is_reconciled          false;  reconciled_at/by, receipt_path NULL
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
    p_transaction_id, v_uid, 'transfer', p_amount, v_src.currency,
    v_src.id, v_dst.id,
    NULL, NULL, NULL, NULL,
    v_rate, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',              'ok',
    'replay',              false,
    'transaction_id',      p_transaction_id,
    'source_balance',      v_new_src,
    'destination_balance', v_new_dst,
    'destination_amount',  v_dst_delta,
    'conversion_rate',     v_rate,
    'created_at',          v_created_at,
    'currency',            v_src.currency,
    'row_deleted',         false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_between_accounts(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.transfer_between_accounts(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.transfer_between_accounts(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, BOOLEAN
) IS
  'Audit L4 pilot (MF-01 / O-1 / F-4): the whole account-to-account transfer — both balance legs and the transactions row — in ONE Postgres transaction, so a flaky network can no longer leave money half-moved. Locks both account rows FOR UPDATE in ascending id order (repo rule: loans -> accounts -> emi_schedules). Compare-and-swap on both expected balances (BALANCE_CONFLICT, same token as apply_account_balance_delta). Insufficient-balance guard mirrors the client checkBalance, with p_allow_negative as the escape. Idempotent on p_transaction_id: a replay returns the existing row and the current balances without moving money again. Gated client-side by VITE_ATOMIC_TRANSFER.';

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
   AND p.proname = 'transfer_between_accounts';

-- V2. Privileges: authenticated may execute; anon and PUBLIC may not.
--     EXPECT: auth_can = t, anon_can = f, public_can = f.
SELECT has_function_privilege('authenticated',
         'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)',
         'EXECUTE') AS auth_can,
       has_function_privilege('anon',
         'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)',
         'EXECUTE') AS anon_can,
       has_function_privilege('public',
         'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)',
         'EXECUTE') AS public_can;

-- V3. Body roll-call — the invariants this file exists to install.
--     EXPECT: every column t.
SELECT (d LIKE '%FOR UPDATE%')                       AS takes_row_locks,
       (d LIKE '%ORDER BY id%')                      AS locks_in_id_order,
       (d LIKE '%BALANCE_CONFLICT%')                 AS raises_conflict,
       (d LIKE '%INSUFFICIENT_BALANCE%')             AS guards_balance,
       (d LIKE '%p_allow_negative%')                 AS has_negative_escape,
       (d LIKE '%user_id = v_uid%')                  AS owner_scoped,
       (d LIKE '%deleted_at IS NULL%')               AS skips_deleted,
       (d LIKE '%balance = balance - v_src_delta%')  AS delta_in_statement,
       (d LIKE '%INSERT INTO public.transactions%')  AS writes_the_row
  FROM (SELECT pg_get_functiondef(
          'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)'::regprocedure
        ) AS d) s;

-- V4. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  IF to_regprocedure('public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)') IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-transfer: the function is missing';
  END IF;

  v_def := pg_get_functiondef(
    'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)'::regprocedure);

  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'p3-atomic-transfer: the account row locks are gone — two concurrent transfers can now interleave';
  END IF;
  IF v_def NOT LIKE '%BALANCE_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-transfer: the optimistic-lock conflict is gone — the client retry ladder is dead code';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-transfer: authenticated cannot execute the function';
  END IF;
  IF has_function_privilege('anon',
       'public.transfer_between_accounts(text,text,text,numeric,numeric,numeric,text,text,timestamptz,numeric,numeric,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-transfer: anon can execute the function';
  END IF;

  RAISE NOTICE 'p3-atomic-transfer: verification passed';
END;
$$;

-- V5. Drift watch. Any transfer row whose two account legs are inconsistent
--     with its own conversion_rate — i.e. a cross-currency row with no rate,
--     or a same-currency row carrying one. EXPECT: zero rows, before and after.
--     (This is the reconciliation surface L7 will grow; it reads history the
--     client wrote as well as rows this RPC writes.)
SELECT t.id,
       t.created_at,
       sa.currency AS source_currency,
       da.currency AS destination_currency,
       t.conversion_rate,
       CASE
         WHEN sa.currency <> da.currency AND t.conversion_rate IS NULL
           THEN 'cross-currency transfer with NO rate'
         ELSE 'same-currency transfer carrying a rate'
       END AS problem
  FROM public.transactions t
  JOIN public.accounts sa ON sa.id = t.source_account_id
  JOIN public.accounts da ON da.id = t.destination_account_id
 WHERE t.type = 'transfer'
   AND t.deleted_at IS NULL
   AND (
     (sa.currency <> da.currency AND t.conversion_rate IS NULL)
     OR (sa.currency  = da.currency AND t.conversion_rate IS NOT NULL)
   )
 ORDER BY t.created_at DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Manual authenticated QA (run as a normal signed-in account that
-- owns two accounts). Every one of these was also run in Docker — see
-- docs/server-side-money-engine.md §4.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  1. Happy path, same currency: two accounts at 1000 / 0.
--       select public.transfer_between_accounts(
--         gen_random_uuid()::text, '<src>', '<dst>', 250, null, null,
--         '', '', now(), 1000, 0, false);
--     → {"status":"ok","source_balance":750.00,"destination_balance":250.00}
--       and exactly one transactions row of type 'transfer'.
--
--  2. Stale expectation: repeat with p_expected_source_balance = 1000 again.
--     → 'BALANCE_CONFLICT', details carry the true 750.00 / 250.00. Nothing
--       moved. The client refetches and retries once, exactly as
--       accountStore.updateBalance already does.
--
--  3. Insufficient: amount 10000 from the 750 account.
--     → 'INSUFFICIENT_BALANCE', details {available: 750.00, requested: 10000}.
--       Nothing moved.
--
--  4. Credit-card negative: same call with p_allow_negative = true.
--     → succeeds, source goes negative. This is the reversal/repair hatch, not
--       a creation path — the app never passes true when recording a transfer.
--
--  5. Cross-currency: AED source → PKR destination, amount 100, rate 76.5,
--     p_destination_amount 7650.
--     → source −100.00, destination +7650.00, row conversion_rate = 76.5.
--       Passing p_destination_amount = 9999 instead → DESTINATION_AMOUNT_MISMATCH
--       and nothing moves. Omitting the rate entirely → CONVERSION_RATE_REQUIRED.
--
--  6. Replay: call #1 again with the SAME p_transaction_id.
--     → {"status":"ok","replay":true, …} with the CURRENT balances, and the
--       balances do NOT move a second time. One row, not two.
--
--  7. Half-moved money is impossible: soft-delete the destination
--     (update accounts set deleted_at = now() where id = '<dst>') and repeat #1.
--     → ACCOUNT_NOT_FOUND, and the SOURCE balance is untouched. Under the old
--       two-leg client path the source debit had already committed by this
--       point and only a best-effort compensation could undo it.
--
--  8. Someone else's account: pass an account id belonging to another user.
--     → ACCOUNT_NOT_FOUND (never a partial write, never a leak of the balance).
--
--  9. anon: call it with the anon key.
--     → permission denied for function transfer_between_accounts.
-- ═══════════════════════════════════════════════════════════════════════════
