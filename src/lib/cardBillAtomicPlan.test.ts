import { describe, expect, it } from 'vitest';
import {
  cardBillPlanExceedsPayment,
  planCardBillPrincipal,
  toCardBillPayload,
  type CardBillAdvance,
  type CardBillPlanLine,
} from './cardBillAtomicPlan';

// The RAK card from src/lib/cardStatement.test.ts, so the two suites pin the
// same numbers: limit 16 500, balance 6 521.96 → used 9 978.04, one advance of
// 8 666.68 with a 1 083.33 instalment due, revolving purchases 1 311.36.
const rak = (over: Partial<CardBillAdvance> = {}): CardBillAdvance => ({
  loanId: 'rak-ca',
  remaining: 8666.68,
  dueThisCycle: 1083.33,
  createdAt: '2026-05-21',
  ...over,
});

describe('planCardBillPrincipal — statement-native', () => {
  it('paying THIS cycle\'s statement steps the plan by ONE instalment', () => {
    expect(planCardBillPrincipal({
      pool: 2394.69, statementNative: true, revolvingPurchases: 1311.36, advances: [rak()],
    })).toEqual([{ loanId: 'rak-ca', applied: 1083.33 }]);
  });

  it('paying the FULL balance still clears the whole advance', () => {
    expect(planCardBillPrincipal({
      pool: 9978.04, statementNative: true, revolvingPurchases: 1311.36, advances: [rak()],
    })).toEqual([{ loanId: 'rak-ca', applied: 8666.68 }]);
  });

  it('a partial payment below the instalment settles only what it reaches', () => {
    expect(planCardBillPrincipal({
      pool: 500, statementNative: true, revolvingPurchases: 420, advances: [rak()],
    })).toEqual([{ loanId: 'rak-ca', applied: 500 }]);
  });

  it('overpayment never settles more principal than the advance holds', () => {
    const plan = planCardBillPrincipal({
      pool: 12000, statementNative: true, revolvingPurchases: 1311.36, advances: [rak()],
    });
    expect(plan).toEqual([{ loanId: 'rak-ca', applied: 8666.68 }]);
  });

  it('two advances: this cycle\'s instalments first, oldest first', () => {
    const plan = planCardBillPrincipal({
      pool: 1500,
      statementNative: true,
      revolvingPurchases: 0,
      advances: [
        rak({ loanId: 'old', remaining: 5000, dueThisCycle: 1000, createdAt: '2026-01-01' }),
        rak({ loanId: 'new', remaining: 3000, dueThisCycle: 800, createdAt: '2026-06-01' }),
      ],
    });
    expect(plan).toEqual([
      { loanId: 'old', applied: 1000 },
      { loanId: 'new', applied: 500 },
    ]);
  });

  it('with no advances at all the plan is empty and no loan is touched', () => {
    expect(planCardBillPrincipal({
      pool: 3000, statementNative: true, revolvingPurchases: 1000, advances: [],
    })).toEqual([]);
  });
});

describe('planCardBillPrincipal — the legacy greedy fallback', () => {
  // A card saved before the two-date model (no limit or no due day) must behave
  // EXACTLY as it does today: wipe the oldest advance whole, then the next.
  it('wipes the oldest advance first, whole remaining at a time', () => {
    expect(planCardBillPrincipal({
      pool: 6000,
      statementNative: false,
      revolvingPurchases: 0,
      advances: [
        rak({ loanId: 'old', remaining: 5000, createdAt: '2026-01-01' }),
        rak({ loanId: 'new', remaining: 3000, createdAt: '2026-06-01' }),
      ],
    })).toEqual([
      { loanId: 'old', applied: 5000 },
      { loanId: 'new', applied: 1000 },
    ]);
  });

  it('ignores instalments entirely — that is what makes it the FALLBACK', () => {
    expect(planCardBillPrincipal({
      pool: 2394.69, statementNative: false, revolvingPurchases: 1311.36, advances: [rak()],
    })).toEqual([{ loanId: 'rak-ca', applied: 2394.69 }]);
  });

  it('skips sub-half-paisa remainders instead of writing 0.00 rows', () => {
    expect(planCardBillPrincipal({
      pool: 5000.004,
      statementNative: false,
      revolvingPurchases: 0,
      advances: [
        rak({ loanId: 'old', remaining: 5000 }),
        rak({ loanId: 'new', remaining: 3000 }),
      ],
    })).toEqual([{ loanId: 'old', applied: 5000 }]);
  });

  it('an empty advance list is an empty plan, statement-native or not', () => {
    expect(planCardBillPrincipal({
      pool: 900, statementNative: false, revolvingPurchases: 0, advances: [],
    })).toEqual([]);
  });

  it('statementNative with advances present still routes to allocateBillPayment', () => {
    // The shipped guard is `statementNative && fundedLoans.length > 0`, so a
    // statement-native card with NO advances falls into the greedy branch — and
    // the greedy branch over an empty list is an empty plan either way. Pinned
    // because the two branches must not disagree on the empty case.
    expect(planCardBillPrincipal({
      pool: 100, statementNative: true, revolvingPurchases: 0, advances: [],
    })).toEqual(planCardBillPrincipal({
      pool: 100, statementNative: false, revolvingPurchases: 0, advances: [],
    }));
  });
});

describe('toCardBillPayload', () => {
  const lines: CardBillPlanLine[] = [{
    loanId: 'rak-ca',
    applied: 1083.33,
    expectedRemaining: 8666.68,
    emiIds: ['emi-1'],
    rowId: 'row-1',
    rowNote: 'Covered by card bill payment',
  }];

  it('emits exactly the snake_case keys the plpgsql body reads', () => {
    expect(toCardBillPayload(lines)).toEqual([{
      loan_id: 'rak-ca',
      applied: 1083.33,
      expected_remaining: 8666.68,
      emi_ids: ['emi-1'],
      row_id: 'row-1',
      row_note: 'Covered by card bill payment',
    }]);
  });

  it('carries a null row_id through — that is how a repayment line says "I am the row"', () => {
    expect(toCardBillPayload([{ ...lines[0], rowId: null }])[0].row_id).toBeNull();
  });
});

describe('cardBillPlanExceedsPayment — the lockstep invariant', () => {
  const line = (applied: number): CardBillPlanLine => ({
    loanId: 'l', applied, expectedRemaining: 10000, emiIds: [], rowId: 'r', rowNote: '',
  });

  it('accepts a plan that settles exactly what the payment credited', () => {
    expect(cardBillPlanExceedsPayment([line(1083.33)], 1083.33)).toBe(false);
  });

  it('accepts a plan that settles LESS (the payment also covered purchases)', () => {
    expect(cardBillPlanExceedsPayment([line(1083.33)], 2394.69)).toBe(false);
  });

  it('REFUSES a plan that settles more principal than the card was credited', () => {
    // This is the money-minting shape: `used` drops by 1 000 while the loans
    // drop by 5 000, so 4 000 of debt vanishes from both records at once.
    expect(cardBillPlanExceedsPayment([line(5000)], 1000)).toBe(true);
  });

  it('sums across lines before comparing', () => {
    expect(cardBillPlanExceedsPayment([line(600), line(600)], 1000)).toBe(true);
    expect(cardBillPlanExceedsPayment([line(600), line(400)], 1000)).toBe(false);
  });

  it('tolerates a cent of rounding, matching the server\'s 0.01 slack', () => {
    expect(cardBillPlanExceedsPayment([line(1000.01)], 1000)).toBe(false);
    expect(cardBillPlanExceedsPayment([line(1000.02)], 1000)).toBe(true);
  });
});
