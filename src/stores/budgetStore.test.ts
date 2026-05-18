import { describe, expect, it } from 'vitest';
import { computeBudgetUsages } from './budgetStore';
import type { Budget, Transaction } from '../db';

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: 'b-1',
    category: 'Food & Dining',
    monthlyAmount: 1000,
    currency: 'AED',
    warnAtPercent: 80,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `tx-${Math.random()}`,
    type: 'expense',
    amount: 100,
    currency: 'AED',
    sourceAccountId: 'acc-1',
    destinationAccountId: null,
    relatedPerson: null,
    personId: null,
    relatedLoanId: null,
    relatedGoalId: null,
    conversionRate: null,
    category: 'Food & Dining',
    notes: '',
    createdAt: '2026-04-15T00:00:00Z',
    ...overrides,
  };
}

describe('computeBudgetUsages', () => {
  const asOf = new Date(2026, 3, 20); // April 20 2026

  it('reports zero spend when no matching transactions exist', () => {
    const [usage] = computeBudgetUsages([budget()], [], asOf);
    expect(usage.spent).toBe(0);
    expect(usage.remaining).toBe(1000);
    expect(usage.percent).toBe(0);
    expect(usage.overLimit).toBe(false);
    expect(usage.overWarn).toBe(false);
  });

  it('sums expenses within the current month only', () => {
    // computeBudgetUsages bounds by LOCAL calendar month (matches how the
    // user thinks about "this month" in their timezone). Use mid-day
    // timestamps so the assertion is timezone-independent.
    const transactions = [
      tx({ createdAt: '2026-03-25T12:00:00Z', amount: 999 }), // prior month
      tx({ createdAt: '2026-04-02T12:00:00Z', amount: 100 }),
      tx({ createdAt: '2026-04-15T12:00:00Z', amount: 200 }),
      tx({ createdAt: '2026-05-10T12:00:00Z', amount: 999 }), // next month
    ];
    const [usage] = computeBudgetUsages([budget()], transactions, asOf);
    expect(usage.spent).toBe(300);
  });

  it('matches category case-insensitively', () => {
    const transactions = [
      tx({ category: 'food & dining', amount: 50 }),
      tx({ category: 'FOOD & DINING', amount: 25 }),
      tx({ category: 'Food & Dining', amount: 25 }),
    ];
    const [usage] = computeBudgetUsages([budget()], transactions, asOf);
    expect(usage.spent).toBe(100);
  });

  it('does NOT mix currencies: AED budget ignores PKR transactions', () => {
    const transactions = [
      tx({ currency: 'AED', amount: 100 }),
      tx({ currency: 'PKR', amount: 500 }),
    ];
    const [usage] = computeBudgetUsages([budget({ currency: 'AED' })], transactions, asOf);
    expect(usage.spent).toBe(100);
  });

  it('flags overWarn at the configured threshold', () => {
    const transactions = [tx({ amount: 850 })];
    const [usage] = computeBudgetUsages(
      [budget({ monthlyAmount: 1000, warnAtPercent: 80 })],
      transactions,
      asOf,
    );
    expect(usage.percent).toBe(85);
    expect(usage.overWarn).toBe(true);
    expect(usage.overLimit).toBe(false);
  });

  it('flags overLimit when spent >= monthlyAmount', () => {
    const transactions = [tx({ amount: 1200 })];
    const [usage] = computeBudgetUsages([budget()], transactions, asOf);
    expect(usage.overLimit).toBe(true);
    expect(usage.remaining).toBe(-200);
  });

  it('ignores non-expense transaction types', () => {
    const transactions = [
      tx({ type: 'income', amount: 5000 }),
      tx({ type: 'transfer', amount: 500 }),
      tx({ type: 'expense', amount: 200 }),
    ];
    const [usage] = computeBudgetUsages([budget()], transactions, asOf);
    expect(usage.spent).toBe(200);
  });

  it('computes usages for multiple budgets independently', () => {
    const budgets = [
      budget({ id: 'b1', category: 'Food & Dining', monthlyAmount: 500 }),
      budget({ id: 'b2', category: 'Transport', monthlyAmount: 200 }),
    ];
    const transactions = [
      tx({ category: 'Food & Dining', amount: 300 }),
      tx({ category: 'Transport', amount: 250 }),
    ];
    const usages = computeBudgetUsages(budgets, transactions, asOf);
    expect(usages.find((u) => u.budget.id === 'b1')?.spent).toBe(300);
    expect(usages.find((u) => u.budget.id === 'b2')?.overLimit).toBe(true);
  });
});
