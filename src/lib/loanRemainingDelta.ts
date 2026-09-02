// Optimistic-locked loan-balance arithmetic — the loan twin of the account
// path (accountsDb.applyBalanceDelta + the retry wrapper in
// accountStore.updateBalance:120-155).
//
// Why this exists (audit 2026-09 F-2 / C-1): loans.remainingAmount used to be
// an absolute read-then-write, so two devices repaying the same loan both read
// 2000, both wrote 1500, and one repayment silently vanished from the loan
// while BOTH repayment rows (and both account debits) survived. The server-side
// compare-and-swap is apply_loan_remaining_delta
// (supabase-migration-audit-p0-loan-concurrency.sql); this module owns the
// client half: one refetch-and-retry, then a user-facing conflict error.
//
// The retry is deliberately conservative. A stale-losing repayment is only
// retried when the FRESH remaining still covers the amount we are applying
// (`requireRemainingAtLeast`). Blindly retrying against a server clamp would
// let a 500 payment reduce a now-200 loan by 200 while the transaction row
// still says 500 — the exact "records exceed the reduction" corruption the
// lock exists to prevent. When the fresh row can't take the full amount we
// stop and tell the user, so they re-enter against the truth.
//
// Dependencies are injected so the whole conflict ladder is unit-testable
// without Supabase.

export const LOAN_REMAINING_CONFLICT = 'LOAN_REMAINING_CONFLICT';
export const LOAN_NOT_FOUND = 'LOAN_NOT_FOUND';

// Amounts are compared at half-a-paisa so float noise never decides a branch.
const EPSILON = 0.005;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isLoanRemainingConflict(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === LOAN_REMAINING_CONFLICT;
}

export function isLoanNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === LOAN_NOT_FOUND;
}

export function loanRemainingConflictError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = LOAN_REMAINING_CONFLICT;
  return err;
}

export interface LoanRemainingDeltaDeps {
  // Calls the server RPC. Resolves with the NEW remaining amount; rejects with
  // a { code: LOAN_REMAINING_CONFLICT } error when `expected` was stale.
  applyDelta: (expectedRemaining: number, delta: number) => Promise<number>;
  // Re-reads the authoritative remaining amount. `null` = the loan is gone
  // (deleted on another device) — never retried.
  refetchRemaining: () => Promise<number | null>;
  // User-facing, already localized (i18n {ur, en}).
  conflictMessage: string;
  missingMessage: string;
}

export interface LoanRemainingDeltaInput {
  // What we believe the server currently holds (local store value).
  expectedRemaining: number;
  // Negative to pay down, positive to give back (rollback compensation).
  delta: number;
  // Retry guard: after a conflict refetch, only retry when the fresh remaining
  // is at least this much. Omit for reversals, which are always safe to apply.
  requireRemainingAtLeast?: number;
}

export interface LoanRemainingDeltaResult {
  // The expected value the successful call actually used (the refetched one
  // when a retry happened). Compensations must pass `newRemaining` back as
  // their own expected value, not this.
  expectedUsed: number;
  newRemaining: number;
  // How much the loan actually moved: positive when paid down, negative when
  // restored. Callers stamp records with THIS, never with the requested delta.
  applied: number;
  retried: boolean;
}

export async function applyLoanRemainingDelta(
  input: LoanRemainingDeltaInput,
  deps: LoanRemainingDeltaDeps,
): Promise<LoanRemainingDeltaResult> {
  const delta = round2(input.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('applyLoanRemainingDelta: delta must be a non-zero finite number');
  }
  if (!Number.isFinite(input.expectedRemaining)) {
    throw new Error('applyLoanRemainingDelta: expectedRemaining must be a finite number');
  }

  const attempt = async (expected: number, retried: boolean): Promise<LoanRemainingDeltaResult> => {
    const newRemaining = round2(await deps.applyDelta(expected, delta));
    return {
      expectedUsed: expected,
      newRemaining,
      applied: round2(expected - newRemaining),
      retried,
    };
  };

  try {
    return await attempt(round2(input.expectedRemaining), false);
  } catch (err) {
    if (isLoanNotFound(err)) throw loanRemainingConflictError(deps.missingMessage);
    if (!isLoanRemainingConflict(err)) throw err;
  }

  // Someone else moved this loan. Learn the truth, then decide — don't just
  // replay the same write against a different balance.
  const fresh = await deps.refetchRemaining();
  if (fresh === null || fresh === undefined) throw loanRemainingConflictError(deps.missingMessage);
  const freshRounded = round2(fresh);

  const floor = input.requireRemainingAtLeast;
  if (floor !== undefined && freshRounded + EPSILON < round2(floor)) {
    throw loanRemainingConflictError(deps.conflictMessage);
  }

  try {
    return await attempt(freshRounded, true);
  } catch (err) {
    if (isLoanNotFound(err)) throw loanRemainingConflictError(deps.missingMessage);
    if (isLoanRemainingConflict(err)) throw loanRemainingConflictError(deps.conflictMessage);
    throw err;
  }
}

// Repayment-shaped wrapper. Clamps the requested amount to what the loan can
// absorb BEFORE the write (preserving the store's historical
// `Math.max(0, remaining - amount)` semantics) so the amount stamped on the
// repayment record always equals the amount the loan actually moved — the
// server's own clamp then never fires and can never desync the two.
export function clampRepaymentAmount(requested: number, remaining: number): number {
  const amount = round2(requested);
  const cap = round2(remaining);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(amount, cap);
}
