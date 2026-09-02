// The pure half of the server-side repayment engine (L4 step 2).
//
// `record_loan_repayment` (supabase-migration-p3-atomic-repayment.sql) commits
// the account leg, the loan leg, the EMI status marks and the transactions row
// in ONE Postgres transaction. To do that it needs the client to tell it WHICH
// instalments the repayment covers — the coverage rule is real business logic
// with a tested engine (src/lib/emiCoverage.ts) and porting it to plpgsql would
// fork the source of truth. So: the client PLANS, the server APPLIES (and
// re-validates ownership + loan membership before it marks anything).
//
// Everything here is a pure function of values the store already holds, so the
// whole plan — including the conflict-retry decision, which is the part that
// can silently corrupt a loan when it is wrong — is unit-testable without
// Supabase. Same philosophy as src/lib/loanRemainingDelta.ts.

import { uncoveredToPaidIds, type CoverableInstallment } from './emiCoverage';

// Matches src/lib/loanRemainingDelta.ts: amounts are compared at half a paisa
// so float noise never decides a branch.
const EPSILON = 0.005;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What `record_loan_repayment` will leave in loans.remaining_amount.
 *
 * Byte-for-byte the server expression
 *   round(GREATEST(0, remaining_amount - round(p_amount, 2)), 2)
 * which is itself byte-for-byte apply_loan_remaining_delta's clamp — which is
 * itself the store's historical `Math.max(0, remaining - amount)`. Three
 * copies of one rule, deliberately identical; this is the client's.
 */
export function predictedRemainingAfter(remainingBefore: number, amount: number): number {
  return round2(Math.max(0, round2(remainingBefore) - round2(amount)));
}

export interface RepaymentEmiPlanInput {
  /** Every instalment of THIS loan, exactly as the emi store holds them. */
  schedules: CoverableInstallment[];
  loanTotalAmount: number;
  /** The loan's remaining amount BEFORE this repayment (the CAS expectation). */
  remainingBefore: number;
  /** The repayment amount, in loan currency. */
  amount: number;
  /** An explicitly targeted instalment (RepaymentInput.emiId), if any. */
  targetedEmiId?: string;
}

export interface RepaymentEmiPlan {
  /**
   * The targeted instalment, when it exists, belongs to this loan and is not
   * already paid — i.e. exactly when `trackedMarkEmiPaid` would flip it.
   */
  targetedId: string | null;
  /**
   * Instalments the paid-down total now fully covers, oldest-first — exactly
   * what `trackedMarkCoveredEmisPaid` computes, and computed AFTER the
   * targeted one is treated as paid, which is what makes the two lists
   * disjoint (the legacy path flips the targeted one first, so the coverage
   * walk skips it).
   */
  coveredIds: string[];
  /** What goes to the RPC as p_emi_schedule_ids: targeted first, then covered. */
  allIds: string[];
}

/**
 * Reproduce the legacy pair
 *   trackedMarkEmiPaid(input.emiId)  →  trackedMarkCoveredEmisPaid(loanId)
 * as one list, ahead of the write instead of after it.
 *
 * The targeted instalment is marked whether or not the money covers it (paying
 * instalment #3 while #1 and #2 are still open is legitimate — the loan-detail
 * screen offers it), which is why it is NOT derived from the coverage walk.
 *
 * A targeted id that does not belong to this loan is DROPPED rather than sent:
 * the RPC refuses foreign ids outright (EMI_SCHEDULE_INVALID), and turning an
 * unreachable UI state into a failed repayment would be a regression. The
 * legacy path would have marked it; nothing in the app can produce one.
 */
export function planRepaymentEmiMarks(input: RepaymentEmiPlanInput): RepaymentEmiPlan {
  const targeted = input.targetedEmiId
    ? input.schedules.find((e) => e.id === input.targetedEmiId) ?? null
    : null;
  const targetedId = targeted && targeted.status !== 'paid' ? targeted.id : null;

  // The coverage walk sees the targeted instalment as already paid, exactly as
  // it does today (the store was mutated one line earlier).
  const afterTargeted: CoverableInstallment[] = targetedId
    ? input.schedules.map((e) => (e.id === targetedId ? { ...e, status: 'paid' as const } : e))
    : input.schedules;

  const paid = round2(
    input.loanTotalAmount - predictedRemainingAfter(input.remainingBefore, input.amount),
  );
  const coveredIds = uncoveredToPaidIds(afterTargeted, paid);

  return {
    targetedId,
    coveredIds,
    allIds: targetedId ? [targetedId, ...coveredIds] : coveredIds,
  };
}

/**
 * The retry guard, lifted verbatim from `trackedApplyRepayment`'s
 * `requireRemainingAtLeast: Math.min(requested, round2(before.remainingAmount))`.
 *
 * Why a floor at all (src/lib/loanRemainingDelta.ts:13-19): blindly replaying a
 * conflicted repayment against a server clamp would let a 500 payment reduce a
 * now-200 loan by 200 while the transaction row still says 500 — "records
 * exceed the reduction", the exact F-2 corruption the lock exists to prevent.
 */
export function repaymentRetryFloor(amount: number, remainingBefore: number): number {
  return Math.min(round2(amount), round2(remainingBefore));
}

/** May a conflicted repayment be replayed against this refetched remaining? */
export function canRetryRepayment(freshRemaining: number, floor: number): boolean {
  return round2(freshRemaining) + EPSILON >= round2(floor);
}
