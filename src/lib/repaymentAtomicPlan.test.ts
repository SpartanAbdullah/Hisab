import { describe, expect, it } from 'vitest';
import {
  canRetryRepayment,
  planRepaymentEmiMarks,
  predictedRemainingAfter,
  repaymentRetryFloor,
} from './repaymentAtomicPlan';
import type { CoverableInstallment } from './emiCoverage';

const schedule = (n: number, amount: number, status: CoverableInstallment['status'] = 'upcoming'): CoverableInstallment =>
  ({ id: `e${n}`, installmentNumber: n, amount, status });

// A 1200 loan as 4 × 300.
const four = [schedule(1, 300), schedule(2, 300), schedule(3, 300), schedule(4, 300)];

describe('predictedRemainingAfter — the client copy of the server clamp', () => {
  it('subtracts and rounds to 2dp', () => {
    expect(predictedRemainingAfter(1000, 250)).toBe(750);
    expect(predictedRemainingAfter(1000.005, 0.01)).toBe(1000);
  });

  it('clamps at zero, never negative (an overpayment settles the loan)', () => {
    expect(predictedRemainingAfter(250, 400)).toBe(0);
    expect(predictedRemainingAfter(0, 5)).toBe(0);
  });

  it('kills the float tail that used to strand a loan active forever (F-19)', () => {
    // 0.1 + 0.2 arithmetic left 0.0000001 remaining and status never flipped.
    expect(predictedRemainingAfter(0.3, 0.1 + 0.2)).toBe(0);
  });
});

describe('planRepaymentEmiMarks — the ids sent to record_loan_repayment', () => {
  it('marks the instalments the paid-down total fully covers, oldest-first', () => {
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 600,
    });
    expect(plan.targetedId).toBeNull();
    expect(plan.coveredIds).toEqual(['e1', 'e2']);
    expect(plan.allIds).toEqual(['e1', 'e2']);
  });

  it('never marks an instalment a partial payment did not fully cover', () => {
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 500,
    });
    expect(plan.allIds).toEqual(['e1']); // 500 covers #1 (300), not #1+#2 (600)
  });

  it('a full payoff covers every instalment', () => {
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 1200,
    });
    expect(plan.allIds).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('an OVERPAYMENT still only covers what the clamped loan can absorb', () => {
    // The loan clamps at 0, so paid = total: everything is covered — and the
    // plan must be computed from the CLAMPED remaining, not `before - amount`.
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 9999,
    });
    expect(plan.allIds).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('counts instalments already paid toward coverage but never re-sends them', () => {
    const partly = [schedule(1, 300, 'paid'), schedule(2, 300), schedule(3, 300), schedule(4, 300)];
    const plan = planRepaymentEmiMarks({
      schedules: partly, loanTotalAmount: 1200, remainingBefore: 900, amount: 300,
    });
    // paid-down = 1200 - 600 = 600 → #1 and #2 covered; #1 is already paid.
    expect(plan.allIds).toEqual(['e2']);
  });

  it('a targeted instalment is marked even when the money does not reach it', () => {
    // Paying instalment #3 while #1 and #2 are open — the loan-detail screen
    // offers exactly this, and trackedMarkEmiPaid honours it unconditionally.
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 300,
      targetedEmiId: 'e3',
    });
    expect(plan.targetedId).toBe('e3');
    expect(plan.coveredIds).toEqual(['e1']); // coverage still walks oldest-first
    expect(plan.allIds).toEqual(['e3', 'e1']);
  });

  it('the targeted instalment is excluded from the covered list (they never double up)', () => {
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 600,
      targetedEmiId: 'e1',
    });
    expect(plan.targetedId).toBe('e1');
    expect(plan.coveredIds).toEqual(['e2']);
    expect(plan.allIds).toEqual(['e1', 'e2']);
    expect(new Set(plan.allIds).size).toBe(plan.allIds.length);
  });

  it('an already-paid target is dropped, exactly as trackedMarkEmiPaid returns early', () => {
    const partly = [schedule(1, 300, 'paid'), schedule(2, 300), schedule(3, 300), schedule(4, 300)];
    const plan = planRepaymentEmiMarks({
      schedules: partly, loanTotalAmount: 1200, remainingBefore: 900, amount: 300,
      targetedEmiId: 'e1',
    });
    expect(plan.targetedId).toBeNull();
    expect(plan.allIds).toEqual(['e2']);
  });

  it('a target from another loan is dropped rather than sent (the RPC would refuse it)', () => {
    const plan = planRepaymentEmiMarks({
      schedules: four, loanTotalAmount: 1200, remainingBefore: 1200, amount: 300,
      targetedEmiId: 'someone-elses-instalment',
    });
    expect(plan.targetedId).toBeNull();
    expect(plan.allIds).toEqual(['e1']);
  });

  it('a loan with no schedule plans nothing', () => {
    const plan = planRepaymentEmiMarks({
      schedules: [], loanTotalAmount: 1000, remainingBefore: 1000, amount: 500,
    });
    expect(plan.allIds).toEqual([]);
  });
});

describe('the conflict-retry floor (the F-2 guard)', () => {
  it('is the smaller of the amount and what the loan held', () => {
    expect(repaymentRetryFloor(500, 1000)).toBe(500);
    // Overpayment: the loan only ever had 300, so that is all the retry needs.
    expect(repaymentRetryFloor(500, 300)).toBe(300);
  });

  it('retries when the refetched loan can still absorb the payment', () => {
    expect(canRetryRepayment(600, repaymentRetryFloor(500, 1000))).toBe(true);
    expect(canRetryRepayment(500, repaymentRetryFloor(500, 1000))).toBe(true);
  });

  it('REFUSES to retry when the fresh loan can no longer take it', () => {
    // Someone else paid the loan down to 200 while we held a 500 payment. A
    // blind replay would move the loan 200 and still record 500 — the exact
    // "records exceed the reduction" corruption.
    expect(canRetryRepayment(200, repaymentRetryFloor(500, 1000))).toBe(false);
    expect(canRetryRepayment(0, repaymentRetryFloor(500, 1000))).toBe(false);
  });

  it('tolerates half-a-paisa of float noise at the boundary', () => {
    expect(canRetryRepayment(499.999, repaymentRetryFloor(500, 1000))).toBe(true);
    expect(canRetryRepayment(499.98, repaymentRetryFloor(500, 1000))).toBe(false);
  });
});
