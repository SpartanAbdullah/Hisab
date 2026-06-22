import { describe, expect, it } from 'vitest';
import { allocateRepayment, totalRemaining, type AllocatableLoan } from './repaymentAllocation';

// The scenario from the report: 29, 50, 1000, 6000 owed; pays back 2000.
const loans: AllocatableLoan[] = [
  { id: 'a', remainingAmount: 29, createdAt: '2026-01-01' },
  { id: 'b', remainingAmount: 50, createdAt: '2026-02-01' },
  { id: 'c', remainingAmount: 1000, createdAt: '2026-03-01' },
  { id: 'd', remainingAmount: 6000, createdAt: '2026-04-01' },
];

describe('allocateRepayment — smallest-first', () => {
  it('clears the small loans first, spilling the rest into the next', () => {
    const out = allocateRepayment(loans, 2000, 'smallest');
    // 29 + 50 + 1000 = 1079 cleared, remaining 921 onto the 6000 loan.
    expect(out).toEqual([
      { loanId: 'a', amount: 29 },
      { loanId: 'b', amount: 50 },
      { loanId: 'c', amount: 1000 },
      { loanId: 'd', amount: 921 },
    ]);
  });

  it('sum never exceeds the lump', () => {
    const out = allocateRepayment(loans, 2000, 'smallest');
    const sum = out.reduce((a, x) => a + x.amount, 0);
    expect(sum).toBeCloseTo(2000, 2);
  });
});

describe('allocateRepayment — largest-first', () => {
  it('pours the lump into the biggest loan first', () => {
    const out = allocateRepayment(loans, 2000, 'largest');
    expect(out).toEqual([{ loanId: 'd', amount: 2000 }]);
  });
});

describe('allocateRepayment — oldest-first (FIFO)', () => {
  it('fills by creation order', () => {
    const out = allocateRepayment(loans, 80, 'oldest');
    expect(out).toEqual([
      { loanId: 'a', amount: 29 },
      { loanId: 'b', amount: 50 },
      { loanId: 'c', amount: 1 },
    ]);
  });
});

describe('allocateRepayment — edges', () => {
  it('caps at total remaining when lump exceeds everything', () => {
    const out = allocateRepayment(loans, 999999, 'smallest');
    const sum = out.reduce((a, x) => a + x.amount, 0);
    expect(sum).toBeCloseTo(totalRemaining(loans), 2);
    expect(out).toHaveLength(4);
  });
  it('skips already-cleared loans', () => {
    const out = allocateRepayment(
      [{ id: 'x', remainingAmount: 0, createdAt: '2026-01-01' }, { id: 'y', remainingAmount: 100, createdAt: '2026-01-02' }],
      50,
      'smallest',
    );
    expect(out).toEqual([{ loanId: 'y', amount: 50 }]);
  });
  it('handles decimals without drift', () => {
    const out = allocateRepayment(
      [{ id: 'a', remainingAmount: 33.33, createdAt: '1' }, { id: 'b', remainingAmount: 66.67, createdAt: '2' }],
      50,
      'smallest',
    );
    expect(out).toEqual([
      { loanId: 'a', amount: 33.33 },
      { loanId: 'b', amount: 16.67 },
    ]);
  });
});
