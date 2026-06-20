import { describe, expect, it } from 'vitest';
import { coreExpenseFieldsChanged } from './groupExpenseDiff';

const base = {
  paidBy: 'A',
  amount: 100,
  splits: [
    { memberId: 'A', amount: 50 },
    { memberId: 'B', amount: 50 },
  ],
};

describe('coreExpenseFieldsChanged', () => {
  it('is false when nothing money-bearing changed (order-independent)', () => {
    const after = { ...base, splits: [{ memberId: 'B', amount: 50 }, { memberId: 'A', amount: 50 }] };
    expect(coreExpenseFieldsChanged(base, after)).toBe(false);
  });
  it('is true when the payer changes', () => {
    expect(coreExpenseFieldsChanged(base, { ...base, paidBy: 'B' })).toBe(true);
  });
  it('is true when the total amount changes', () => {
    expect(coreExpenseFieldsChanged(base, { ...base, amount: 120 })).toBe(true);
  });
  it('is true when a split share changes', () => {
    expect(
      coreExpenseFieldsChanged(base, { ...base, splits: [{ memberId: 'A', amount: 40 }, { memberId: 'B', amount: 60 }] }),
    ).toBe(true);
  });
  it('is true when the participant set changes', () => {
    expect(
      coreExpenseFieldsChanged(base, { ...base, splits: [{ memberId: 'A', amount: 50 }, { memberId: 'C', amount: 50 }] }),
    ).toBe(true);
  });
});
