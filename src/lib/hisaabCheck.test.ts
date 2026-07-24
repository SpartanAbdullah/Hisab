import { describe, expect, it } from 'vitest';
import { daysSince, peopleDelta, suggestAction, weekFlow } from './hisaabCheck';
import type { Loan, Transaction } from '../db';

const TODAY = new Date('2026-07-23T12:00:00');

const txn = (over: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2), type: 'expense', amount: 100, currency: 'AED',
  sourceAccountId: 'a', destinationAccountId: null, relatedPerson: null, personId: null,
  relatedLoanId: null, relatedGoalId: null, conversionRate: null, category: '',
  notes: '', createdAt: '2026-07-20T10:00:00', ...over,
});

const loan = (over: Partial<Loan>): Loan => ({
  id: 'l', personName: 'Ali', personId: null, type: 'given', totalAmount: 1000,
  remainingAmount: 800, currency: 'AED', status: 'active', notes: '',
  createdAt: '2026-06-01T00:00:00', ...over,
});

describe('weekFlow', () => {
  it('sums real in/out, treats repayments and loans by their money leg, ignores shuffling', () => {
    const { moneyIn, moneyOut } = weekFlow([
      txn({ type: 'income', amount: 5000, sourceAccountId: null, destinationAccountId: 'a' }),
      txn({ type: 'expense', amount: 1200 }),
      txn({ type: 'repayment', amount: 300, sourceAccountId: null, destinationAccountId: 'a' }),
      txn({ type: 'repayment', amount: 150, sourceAccountId: 'a', destinationAccountId: null }),
      // Lending cash out / borrowed cash landing in are REAL flow…
      txn({ type: 'loan_given', amount: 2000, sourceAccountId: 'a', destinationAccountId: null }),
      txn({ type: 'loan_taken', amount: 700, sourceAccountId: null, destinationAccountId: 'a' }),
      // …but ledger-only loan rows (no account leg) are not.
      txn({ type: 'loan_given', amount: 9999, sourceAccountId: null, destinationAccountId: null }),
      txn({ type: 'transfer', amount: 9999, destinationAccountId: 'b' }),
      txn({ type: 'adjustment', amount: 9999 }),
      txn({ type: 'expense', amount: 9999, createdAt: '2026-07-10T10:00:00' }), // outside window
      txn({ type: 'expense', amount: 9999, currency: 'PKR' }),
    ], 'AED', TODAY);
    expect(moneyIn).toBe(6000);
    expect(moneyOut).toBe(3350);
  });
});

describe('daysSince + peopleDelta', () => {
  it('computes elapsed days and deltas against the stamp', () => {
    expect(daysSince('2026-07-16', TODAY)).toBe(7);
    expect(daysSince(null, TODAY)).toBeNull();
    expect(
      peopleDelta({ receivable: 900, payable: 200 }, { dateIso: '2026-07-16', receivable: 1000, payable: 350, currency: 'AED' }, 'AED'),
    ).toEqual({ receivable: -100, payable: -150 });
    expect(peopleDelta({ receivable: 1, payable: 1 }, null, 'AED')).toBeNull();
  });
});

describe('suggestAction', () => {
  it('picks the longest-standing given loan, only after 14 days', () => {
    const action = suggestAction([
      loan({ id: 'new', createdAt: '2026-07-20T00:00:00' }),
      loan({ id: 'old', createdAt: '2026-05-01T00:00:00', personName: 'Maryam', remainingAmount: 450 }),
      loan({ id: 'taken', type: 'taken', createdAt: '2026-01-01T00:00:00' }),
      loan({ id: 'settled', status: 'settled', createdAt: '2026-01-01T00:00:00' }),
    ], TODAY);
    expect(action).toMatchObject({ loanId: 'old', personName: 'Maryam', remaining: 450 });
    expect(action!.daysOpen).toBeGreaterThan(14);
  });

  it('returns null when nothing is nag-worthy', () => {
    expect(suggestAction([loan({ createdAt: '2026-07-15T00:00:00' })], TODAY)).toBeNull();
    expect(suggestAction([], TODAY)).toBeNull();
  });
});
