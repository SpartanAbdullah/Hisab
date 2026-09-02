-- Hisaab — Audit 2026-09 item C10 (loan part): optimistic lock on
-- loans.remaining_amount.
--
-- Apply in Supabase Studio AFTER supabase-migration-prelaunch-hardening.sql
-- (source of the pattern reused below), supabase-migration-incremental-sync-core.sql
-- (loans.updated_at + trg_loans_touch) and
-- supabase-migration-incremental-sync-tombstones.sql (loans.deleted_at).
-- Idempotent: safe to re-run.
--
-- ── Evidence (docs/audit-2026-09/12-qa-review.md) ───────────────────────────
--
-- F-2 / C-1 (high) — "Concurrent loan repayment across devices = lost update;
--   records (rows + debits) exceed actual loan reduction."
--   Every write to remaining_amount is an absolute read-then-write:
--       src/stores/loanStore.ts:90,98
--         const newRemaining = Math.max(0, loan.remainingAmount - amount);
--         await loansDb.update(loanId, { remainingAmount: newRemaining, ... });
--       src/stores/transactionStore.ts:356-359 (trackedApplyRepayment) does the
--         same shape, and src/lib/supabaseDb.ts:262-273 (loansDb.update) filters
--         by id + user_id only — no version, no expected value.
--   Two devices repaying 500 against a 2000 loan both read 2000, both write
--   1500. Both repayment transaction rows persist and (in full_tracker) both
--   account debits persist, so the user's records say 1000 was paid while the
--   loan only dropped by 500. §8.1 of the QA review ranks this the #1
--   money-integrity scenario.
--   Contrast the account-balance path, which has had a compare-and-swap RPC
--   since 2026-05-26: supabase-migration-prelaunch-hardening.sql:245-277
--   (apply_account_balance_delta) + the one refetch-and-retry wrapper at
--   src/stores/accountStore.ts:120-155. This migration gives loans the same
--   contract.
--
-- F-19 / R-1 (low, closed here as a side-effect) — "Ledger applyRepayment
--   doesn't round remaining → possible never-settled 0.00x loans."
--   src/stores/loanStore.ts:90-91 computes newRemaining WITHOUT rounding, and
--   status flips to 'settled' only on `newRemaining === 0` exactly, so a float
--   chain leaving 0.0000001 strands a loan 'active' forever while every display
--   rounds it to 0.00. The RPC below rounds the stored remainder to 2dp and
--   derives status from that rounded value inside the same UPDATE, so the two
--   columns can never disagree and a paid-off loan always settles.
--
-- ── apply_loan_remaining_delta contract ────────────────────────────────────
--   apply_loan_remaining_delta(p_loan_id TEXT, p_delta NUMERIC,
--                              p_expected_remaining NUMERIC) RETURNS NUMERIC
--
--   Success  → the NEW remaining_amount (rounded to 2dp). status is re-derived
--              in the same statement: 0 → 'settled', otherwise 'active'.
--              remaining_amount is clamped at 0 (never negative) so an
--              overpaying delta cannot invert the loan.
--   Conflict → RAISE EXCEPTION 'LOAN_REMAINING_CONFLICT' (ERRCODE P0001) when
--              the row's current remaining_amount does not equal
--              p_expected_remaining (compared at 2dp, because the client sends
--              IEEE-754 doubles). The caller refetches the row and retries once
--              — src/lib/loanRemainingDelta.ts.
--   Missing  → RAISE EXCEPTION 'LOAN_NOT_FOUND' (ERRCODE P0001) when the id is
--              unknown, soft-deleted, or owned by someone else. Distinguished
--              from a conflict so the client can tell "someone else changed it"
--              from "it is gone" instead of retrying forever.
--   Auth     → RAISE EXCEPTION 'NOT_AUTHENTICATED' when auth.uid() is null.
--
--   SECURITY DEFINER with an explicit `user_id = auth.uid()` predicate on BOTH
--   the existence probe and the UPDATE (the RLS policy
--   "Users can manage own loans", supabase-schema.sql:105, is not consulted
--   under DEFINER — the predicate is the whole access control here).
--
--   Deliberately NOT locked down further: loansDb.update still writes
--   remaining_amount on other paths (loan edit / repayment delete, via
--   src/stores/transactionStore.ts:1596,1689,1881,1976). Those now route
--   through this RPC client-side (loanStore.updateLoan translates an absolute
--   remainingAmount into expected+delta), but no table-level trigger blocks the
--   old shape — a trigger would break any client build older than this commit.
--
--   Pre-launch, breaking-change note: the client in this same commit calls the
--   RPC unconditionally for every remaining_amount change. Until this migration
--   is applied, ledger-mode repayments will fail with "function ... does not
--   exist". That is intentional (fail loud, not silently unlocked) and matches
--   the pre-launch posture — there is no dual-path fallback.

BEGIN;

-- ═══════════════════════════════════════════════════════════
-- SECTION 1. Optimistic-locked remaining_amount mutation
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_loan_remaining_delta(
  p_loan_id TEXT,
  p_delta NUMERIC,
  p_expected_remaining NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_found BOOLEAN;
  v_new_remaining NUMERIC;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF p_delta IS NULL OR p_expected_remaining IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT' USING ERRCODE = 'P0001';
  END IF;

  -- Existence probe first, so "gone / not yours" is reported as its own error
  -- instead of masquerading as a lost-update conflict the client would retry.
  SELECT true INTO v_found
    FROM public.loans
   WHERE id = p_loan_id
     AND user_id = v_uid
     AND deleted_at IS NULL;

  IF v_found IS NULL THEN
    RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Compare-and-swap. The row is locked by this UPDATE for the rest of the
  -- statement, so two concurrent callers serialize: the loser re-reads a
  -- changed remaining_amount, fails the predicate and gets LOAN_REMAINING_CONFLICT.
  UPDATE public.loans
     SET remaining_amount = round(GREATEST(0, remaining_amount + p_delta), 2),
         status = CASE
                    WHEN round(GREATEST(0, remaining_amount + p_delta), 2) = 0
                      THEN 'settled'
                    ELSE 'active'
                  END
   WHERE id = p_loan_id
     AND user_id = v_uid
     AND deleted_at IS NULL
     AND round(remaining_amount, 2) = round(p_expected_remaining, 2)
  RETURNING remaining_amount INTO v_new_remaining;

  IF v_new_remaining IS NULL THEN
    RAISE EXCEPTION 'LOAN_REMAINING_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_new_remaining;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_loan_remaining_delta(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_loan_remaining_delta(TEXT, NUMERIC, NUMERIC) TO authenticated;

COMMIT;

-- ═══════════════════════════════════════════════════════════
-- SECTION 2. Verification — run these after applying
-- ═══════════════════════════════════════════════════════════

-- 2.1 The function exists with the expected signature, is SECURITY DEFINER and
--     pins its search_path.
SELECT p.proname,
       p.prosecdef                                   AS security_definer,
       pg_get_function_identity_arguments(p.oid)     AS args,
       p.proconfig                                   AS settings
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'apply_loan_remaining_delta';
-- Expect: one row, security_definer = t, args = 'p_loan_id text, p_delta numeric,
--         p_expected_remaining numeric', settings = {search_path=public}

-- 2.2 Only authenticated users can execute it.
SELECT has_function_privilege('authenticated', 'public.apply_loan_remaining_delta(text,numeric,numeric)', 'EXECUTE') AS auth_can,
       has_function_privilege('anon',          'public.apply_loan_remaining_delta(text,numeric,numeric)', 'EXECUTE') AS anon_can;
-- Expect: t, f

-- 2.3 The body carries every guard this fix depends on.
SELECT (pg_get_functiondef('public.apply_loan_remaining_delta(text,numeric,numeric)'::regprocedure)
          LIKE '%user_id = v_uid%')                            AS owner_scoped,
       (pg_get_functiondef('public.apply_loan_remaining_delta(text,numeric,numeric)'::regprocedure)
          LIKE '%deleted_at IS NULL%')                         AS skips_deleted,
       (pg_get_functiondef('public.apply_loan_remaining_delta(text,numeric,numeric)'::regprocedure)
          LIKE '%LOAN_REMAINING_CONFLICT%')                    AS raises_conflict,
       (pg_get_functiondef('public.apply_loan_remaining_delta(text,numeric,numeric)'::regprocedure)
          LIKE '%GREATEST(0, remaining_amount + p_delta)%')    AS clamps_at_zero;
-- Expect: t, t, t, t

-- 2.4 Manual authenticated QA (run as a normal signed-in account that owns
--     loan <ID> with remaining_amount 1000):
--   a. SELECT public.apply_loan_remaining_delta('<ID>', -250, 1000);
--      -> 750.00, and `SELECT status FROM loans WHERE id='<ID>'` is 'active'.
--   b. SELECT public.apply_loan_remaining_delta('<ID>', -250, 1000);
--      -> ERROR: LOAN_REMAINING_CONFLICT   (this IS the fix — the stale
--         expected value is refused instead of clobbering the first payment).
--   c. SELECT public.apply_loan_remaining_delta('<ID>', -750, 750);
--      -> 0.00, status flips to 'settled' in the same statement.
--   d. SELECT public.apply_loan_remaining_delta('<ID>', 750, 0);
--      -> 750.00, status back to 'active' (this is the rollback compensation
--         path — reversal must restore both columns).
--   e. SELECT public.apply_loan_remaining_delta('<ID>', -99999, 750);
--      -> 0.00, never negative.
--   f. SELECT public.apply_loan_remaining_delta('<someone-elses-loan>', -1, 1);
--      -> ERROR: LOAN_NOT_FOUND  (ownership is enforced inside the DEFINER
--         function, not by RLS).

-- 2.5 No loan can be left in the "settled amount but active status" state that
--     F-19 describes. Run before and after a repayment smoke test.
SELECT count(*) AS inconsistent_rows
  FROM public.loans
 WHERE deleted_at IS NULL
   AND ((round(remaining_amount, 2) = 0 AND status <> 'settled')
     OR (round(remaining_amount, 2) > 0 AND status = 'settled'));
-- Expect: 0 for every row touched since this migration (pre-existing rows written
--         by older clients may still be inconsistent — this query finds them).
