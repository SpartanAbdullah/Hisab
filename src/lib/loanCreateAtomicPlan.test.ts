import { describe, expect, it } from 'vitest';
import {
  EMI_SUM_TOLERANCE,
  emiPlanProblem,
  planLoanCreateLegs,
  round2,
  toEmiPayload,
  type LoanEmiPlanRow,
} from './loanCreateAtomicPlan';

// Mirrors emiStore.generateSchedule (src/stores/emiStore.ts:62-87): equal
// instalments at 2dp with the rounding tail absorbed by the LAST one.
function generateSchedule(loanId: string, total: number, installments: number): LoanEmiPlanRow[] {
  const each = Math.round((total / installments) * 100) / 100;
  return Array.from({ length: installments }, (_, i) => ({
    id: `${loanId}-e${i + 1}`,
    installmentNumber: i + 1,
    dueDate: `2026-0${i + 1}-01`,
    amount: i === installments - 1
      ? Math.round((total - each * (installments - 1)) * 100) / 100
      : each,
  }));
}

describe('planLoanCreateLegs', () => {
  it('a loan GIVEN debits its source and is the row source', () => {
    expect(planLoanCreateLegs({ direction: 'given', amount: 250, accountId: 'bank' })).toEqual({
      sourceAccountId: 'bank',
      destinationAccountId: null,
      accountDelta: -250,
      cardDelta: null,
    });
  });

  it('a loan TAKEN credits its destination and leaves the source null', () => {
    expect(planLoanCreateLegs({ direction: 'taken', amount: 500, accountId: 'bank' })).toEqual({
      sourceAccountId: null,
      destinationAccountId: 'bank',
      accountDelta: 500,
      cardDelta: null,
    });
  });

  it('a cash advance debits the card AND credits the receiver — the row carries both', () => {
    expect(planLoanCreateLegs({
      direction: 'taken', amount: 1500, accountId: 'bank', cardAccountId: 'cc',
    })).toEqual({
      sourceAccountId: 'cc',
      destinationAccountId: 'bank',
      accountDelta: 1500,
      cardDelta: -1500,
    });
  });

  it('the two legs of a cash advance are equal and opposite — no money is created', () => {
    const legs = planLoanCreateLegs({
      direction: 'taken', amount: 1500, accountId: 'bank', cardAccountId: 'cc',
    });
    expect(legs.accountDelta + (legs.cardDelta ?? 0)).toBe(0);
  });

  it('a card on a GIVEN direction is dropped, never honoured', () => {
    // Not reachable from the UI; the RPC refuses it with INVALID_CASH_ADVANCE.
    // Inventing a card leg here would be the worse of the two failures.
    const legs = planLoanCreateLegs({
      direction: 'given', amount: 100, accountId: 'bank', cardAccountId: 'cc',
    });
    expect(legs.cardDelta).toBeNull();
    expect(legs.sourceAccountId).toBe('bank');
    expect(legs.destinationAccountId).toBeNull();
  });

  it('deltas are rounded to 2dp, matching accountStore.updateBalance', () => {
    const legs = planLoanCreateLegs({ direction: 'given', amount: 10.005, accountId: 'a' });
    expect(legs.accountDelta).toBe(-10.01);
  });
});

describe('emiPlanProblem', () => {
  it('accepts a schedule generateSchedule would produce', () => {
    expect(emiPlanProblem(generateSchedule('L1', 1000, 4), 1000)).toBeNull();
  });

  it('accepts the rounding tail of an unevenly divisible loan', () => {
    // 1000/3 → 333.33, 333.33, 333.34. The naive sum is 1000.00 only because
    // the last instalment absorbs the remainder.
    const rows = generateSchedule('L2', 1000, 3);
    expect(rows.map((r) => r.amount)).toEqual([333.33, 333.33, 333.34]);
    expect(emiPlanProblem(rows, 1000)).toBeNull();
  });

  it('an empty plan is not a problem — most loans have no schedule', () => {
    expect(emiPlanProblem([], 1000)).toBeNull();
  });

  it('refuses a schedule that does not add up to the loan', () => {
    const rows = generateSchedule('L3', 1000, 4);
    rows[0].amount = 500;
    expect(emiPlanProblem(rows, 1000)).toBe('EMI_PLAN_MISMATCH');
  });

  it('a one-cent gap is inside the shared tolerance', () => {
    const rows = generateSchedule('L4', 1000, 2);
    rows[1].amount = round2(rows[1].amount - EMI_SUM_TOLERANCE);
    expect(emiPlanProblem(rows, 1000)).toBeNull();
  });

  it('…and two cents is not', () => {
    const rows = generateSchedule('L5', 1000, 2);
    rows[1].amount = round2(rows[1].amount - 0.02);
    expect(emiPlanProblem(rows, 1000)).toBe('EMI_PLAN_MISMATCH');
  });

  it('refuses duplicate instalment ids', () => {
    const rows = generateSchedule('L6', 1000, 2);
    rows[1].id = rows[0].id;
    expect(emiPlanProblem(rows, 1000)).toBe('EMI_ID_COLLISION');
  });

  it('refuses numbering that is not 1..N', () => {
    const rows = generateSchedule('L7', 1000, 3);
    rows[2].installmentNumber = 7;
    expect(emiPlanProblem(rows, 1000)).toBe('EMI_PLAN_INVALID');
  });

  it('refuses duplicate instalment numbers', () => {
    const rows = generateSchedule('L8', 1000, 3);
    rows[2].installmentNumber = 1;
    expect(emiPlanProblem(rows, 1000)).toBe('EMI_PLAN_INVALID');
  });

  it('refuses an empty id, an empty due date, a negative amount and NaN', () => {
    const base = () => generateSchedule('L9', 100, 2);
    const blankId = base(); blankId[0].id = '   ';
    const blankDue = base(); blankDue[0].dueDate = '';
    const negative = base(); negative[0].amount = -10; negative[1].amount = 110;
    const nan = base(); nan[0].amount = Number.NaN;
    expect(emiPlanProblem(blankId, 100)).toBe('EMI_PLAN_INVALID');
    expect(emiPlanProblem(blankDue, 100)).toBe('EMI_PLAN_INVALID');
    expect(emiPlanProblem(negative, 100)).toBe('EMI_PLAN_INVALID');
    expect(emiPlanProblem(nan, 100)).toBe('EMI_PLAN_INVALID');
  });

  it('a zero instalment is legal — the rounding tail of a tiny loan', () => {
    // p1-money-bounds pins emi_schedules.amount at `>= 0`, not `> 0`, for
    // exactly this reason. The client rule must not be stricter.
    const rows: LoanEmiPlanRow[] = [
      { id: 'a', installmentNumber: 1, dueDate: '2026-01-01', amount: 0 },
      { id: 'b', installmentNumber: 2, dueDate: '2026-02-01', amount: 0.01 },
    ];
    expect(emiPlanProblem(rows, 0.01)).toBeNull();
  });
});

describe('toEmiPayload', () => {
  it('renames to the snake_case keys the plpgsql body reads', () => {
    expect(toEmiPayload(generateSchedule('L1', 100, 2))).toEqual([
      { id: 'L1-e1', installment_number: 1, due_date: '2026-01-01', amount: 50 },
      { id: 'L1-e2', installment_number: 2, due_date: '2026-02-01', amount: 50 },
    ]);
  });

  it('sends NULL rather than an empty array when there is no schedule', () => {
    // `p_emi := '[]'` and `p_emi := NULL` are the same to the server, but NULL
    // is what the shipped client passes and what the tests pin.
    expect(toEmiPayload([])).toBeNull();
    expect(toEmiPayload(null)).toBeNull();
    expect(toEmiPayload(undefined)).toBeNull();
  });
});
