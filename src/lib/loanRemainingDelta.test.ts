import { describe, expect, it, vi } from 'vitest';
import {
  LOAN_NOT_FOUND,
  LOAN_REMAINING_CONFLICT,
  applyLoanRemainingDelta,
  clampRepaymentAmount,
  isLoanRemainingConflict,
  type LoanRemainingDeltaDeps,
} from './loanRemainingDelta';

function coded(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

// A stand-in for the server RPC: holds one authoritative remaining amount,
// applies `remaining = max(0, remaining + delta)` only when the caller's
// expected value matches, and raises the conflict code otherwise — exactly
// what apply_loan_remaining_delta does.
function fakeServer(initial: number) {
  const state = { remaining: initial, calls: [] as { expected: number; delta: number }[] };
  return {
    state,
    applyDelta: async (expected: number, delta: number) => {
      state.calls.push({ expected, delta });
      if (Math.round(state.remaining * 100) !== Math.round(expected * 100)) {
        throw coded(LOAN_REMAINING_CONFLICT);
      }
      state.remaining = Math.round(Math.max(0, state.remaining + delta) * 100) / 100;
      return state.remaining;
    },
    refetchRemaining: async () => state.remaining,
  };
}

function deps(over: Partial<LoanRemainingDeltaDeps> = {}): LoanRemainingDeltaDeps {
  return {
    applyDelta: vi.fn(),
    refetchRemaining: vi.fn().mockResolvedValue(null),
    conflictMessage: 'CONFLICT_COPY',
    missingMessage: 'MISSING_COPY',
    ...over,
  };
}

describe('applyLoanRemainingDelta', () => {
  it('applies a repayment on the happy path and reports what actually moved', async () => {
    const server = fakeServer(2000);
    const result = await applyLoanRemainingDelta(
      { expectedRemaining: 2000, delta: -500, requireRemainingAtLeast: 500 },
      deps(server),
    );
    expect(result).toEqual({ expectedUsed: 2000, newRemaining: 1500, applied: 500, retried: false });
    expect(server.state.calls).toHaveLength(1);
  });

  it('reverses a repayment (positive delta) — applied comes back negative', async () => {
    const server = fakeServer(1500);
    const result = await applyLoanRemainingDelta({ expectedRemaining: 1500, delta: 500 }, deps(server));
    expect(result.newRemaining).toBe(2000);
    expect(result.applied).toBe(-500);
    expect(server.state.remaining).toBe(2000);
  });

  it('refetches and retries ONCE when another device moved the loan and the fresh balance still covers it', async () => {
    // Device B already paid 200 (2000 -> 1800); our local snapshot still says 2000.
    const server = fakeServer(1800);
    const result = await applyLoanRemainingDelta(
      { expectedRemaining: 2000, delta: -500, requireRemainingAtLeast: 500 },
      deps(server),
    );
    expect(result).toEqual({ expectedUsed: 1800, newRemaining: 1300, applied: 500, retried: true });
    // Exactly two RPC calls: the stale one and the retry. Never a third.
    expect(server.state.calls).toEqual([
      { expected: 2000, delta: -500 },
      { expected: 1800, delta: -500 },
    ]);
  });

  it('refuses to retry when the refetched loan can no longer absorb the amount', async () => {
    // The whole point of F-2: the server would clamp 500 down to 200 and the
    // 500-rupee record would then overstate the loan reduction.
    const server = fakeServer(200);
    await expect(
      applyLoanRemainingDelta(
        { expectedRemaining: 2000, delta: -500, requireRemainingAtLeast: 500 },
        deps(server),
      ),
    ).rejects.toMatchObject({ message: 'CONFLICT_COPY', code: LOAN_REMAINING_CONFLICT });
    expect(server.state.remaining).toBe(200);
    expect(server.state.calls).toHaveLength(1);
  });

  it('does not treat sub-paisa float noise in the local snapshot as a conflict', async () => {
    const server = fakeServer(500);
    const result = await applyLoanRemainingDelta(
      { expectedRemaining: 499.99999999, delta: -500, requireRemainingAtLeast: 500 },
      deps(server),
    );
    expect(result).toEqual({ expectedUsed: 500, newRemaining: 0, applied: 500, retried: false });
  });

  it('retries a full payoff when the refetched remaining exactly equals the amount', async () => {
    const server = fakeServer(500);
    const result = await applyLoanRemainingDelta(
      { expectedRemaining: 800, delta: -500, requireRemainingAtLeast: 500 },
      deps(server),
    );
    expect(result).toEqual({ expectedUsed: 500, newRemaining: 0, applied: 500, retried: true });
  });

  it('retries reversals unconditionally — giving money back is always safe', async () => {
    const server = fakeServer(300); // another device paid it down further
    const result = await applyLoanRemainingDelta({ expectedRemaining: 1500, delta: 500 }, deps(server));
    expect(result.newRemaining).toBe(800);
    expect(result.retried).toBe(true);
  });

  it('surfaces the "loan is gone" copy instead of retrying when the refetch finds nothing', async () => {
    const d = deps({
      applyDelta: vi.fn().mockRejectedValue(coded(LOAN_REMAINING_CONFLICT)),
      refetchRemaining: vi.fn().mockResolvedValue(null),
    });
    await expect(
      applyLoanRemainingDelta({ expectedRemaining: 100, delta: -100 }, d),
    ).rejects.toMatchObject({ message: 'MISSING_COPY', code: LOAN_REMAINING_CONFLICT });
    expect(d.applyDelta).toHaveBeenCalledTimes(1);
  });

  it('maps a server LOAN_NOT_FOUND straight to the missing copy', async () => {
    const d = deps({ applyDelta: vi.fn().mockRejectedValue(coded(LOAN_NOT_FOUND)) });
    await expect(
      applyLoanRemainingDelta({ expectedRemaining: 100, delta: -100 }, d),
    ).rejects.toMatchObject({ message: 'MISSING_COPY' });
    expect(d.refetchRemaining).not.toHaveBeenCalled();
  });

  it('gives up with the conflict copy when the retry conflicts too', async () => {
    const d = deps({
      applyDelta: vi.fn().mockRejectedValue(coded(LOAN_REMAINING_CONFLICT)),
      refetchRemaining: vi.fn().mockResolvedValue(2000),
    });
    await expect(
      applyLoanRemainingDelta({ expectedRemaining: 2000, delta: -500, requireRemainingAtLeast: 500 }, d),
    ).rejects.toMatchObject({ message: 'CONFLICT_COPY', code: LOAN_REMAINING_CONFLICT });
    expect(d.applyDelta).toHaveBeenCalledTimes(2);
  });

  it('never swallows a non-conflict failure (offline, RLS, 500)', async () => {
    const d = deps({ applyDelta: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(
      applyLoanRemainingDelta({ expectedRemaining: 100, delta: -50 }, d),
    ).rejects.toThrow('offline');
    expect(d.refetchRemaining).not.toHaveBeenCalled();
  });

  it('rejects nonsense deltas before touching the network', async () => {
    const d = deps();
    await expect(applyLoanRemainingDelta({ expectedRemaining: 100, delta: 0 }, d)).rejects.toThrow(/non-zero/);
    await expect(applyLoanRemainingDelta({ expectedRemaining: 100, delta: NaN }, d)).rejects.toThrow(/non-zero/);
    await expect(applyLoanRemainingDelta({ expectedRemaining: NaN, delta: -5 }, d)).rejects.toThrow(/finite/);
    expect(d.applyDelta).not.toHaveBeenCalled();
  });

  it('rounds the delta to 2dp so a float chain cannot strand a loan at 0.004', async () => {
    const server = fakeServer(100);
    const result = await applyLoanRemainingDelta(
      { expectedRemaining: 100, delta: -99.99600000001 },
      deps(server),
    );
    expect(result.newRemaining).toBe(0);
  });
});

describe('isLoanRemainingConflict', () => {
  it('only matches the coded conflict', () => {
    expect(isLoanRemainingConflict(coded(LOAN_REMAINING_CONFLICT))).toBe(true);
    expect(isLoanRemainingConflict(new Error(LOAN_REMAINING_CONFLICT))).toBe(false);
    expect(isLoanRemainingConflict(null)).toBe(false);
  });
});

describe('clampRepaymentAmount', () => {
  it('caps at the remaining balance and rounds to paisa', () => {
    expect(clampRepaymentAmount(500, 2000)).toBe(500);
    expect(clampRepaymentAmount(2500, 2000)).toBe(2000);
    expect(clampRepaymentAmount(10.005, 2000)).toBe(10.01);
    expect(clampRepaymentAmount(100, 99.994)).toBe(99.99);
  });

  it('returns 0 for anything unpayable so the caller can refuse early', () => {
    expect(clampRepaymentAmount(0, 100)).toBe(0);
    expect(clampRepaymentAmount(-5, 100)).toBe(0);
    expect(clampRepaymentAmount(NaN, 100)).toBe(0);
    expect(clampRepaymentAmount(50, 0)).toBe(0);
  });
});
