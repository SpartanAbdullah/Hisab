import { describe, expect, it, beforeEach } from 'vitest';
import { computeMonthlyWrap, shouldShowMonthlyWrap, markWrapShown } from './monthlyWrap';
import type { Transaction } from '../db';

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
    createdAt: '2026-04-15T10:00:00Z',
    ...overrides,
  };
}

describe('computeMonthlyWrap', () => {
  // asOf = May 5th 2026 → target month is April 2026.
  const asOf = new Date(2026, 4, 5);

  it('returns null when no transactions exist in target month', () => {
    const stats = computeMonthlyWrap([], 'AED', asOf);
    expect(stats).toBe(null);
  });

  it('ignores transactions outside the target month', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-03-30T00:00:00Z', amount: 999 }), // prior month
        tx({ createdAt: '2026-05-01T00:00:00Z', amount: 999 }), // next month
        tx({ createdAt: '2026-04-15T00:00:00Z', amount: 50 }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.totalSpent).toBe(50);
    expect(stats?.txCount).toBe(1);
  });

  it('ignores transactions in a different currency', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-15T00:00:00Z', amount: 100, currency: 'PKR' }),
        tx({ createdAt: '2026-04-15T00:00:00Z', amount: 50, currency: 'AED' }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.totalSpent).toBe(50);
  });

  it('computes top categories ranked by spend with shares', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-01T00:00:00Z', amount: 300, category: 'Rent' }),
        tx({ createdAt: '2026-04-05T00:00:00Z', amount: 100, category: 'Food & Dining' }),
        tx({ createdAt: '2026-04-10T00:00:00Z', amount: 100, category: 'Food & Dining' }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.topCategories[0]).toMatchObject({ category: 'Rent', amount: 300, share: 60 });
    expect(stats?.topCategories[1]).toMatchObject({ category: 'Food & Dining', amount: 200, share: 40 });
  });

  it('identifies the biggest single expense', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-01T00:00:00Z', amount: 100 }),
        tx({ createdAt: '2026-04-10T00:00:00Z', amount: 750 }),
        tx({ createdAt: '2026-04-20T00:00:00Z', amount: 200 }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.biggestExpense?.amount).toBe(750);
  });

  it('computes net = income − expense', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-01T00:00:00Z', type: 'income', amount: 5000 }),
        tx({ createdAt: '2026-04-05T00:00:00Z', amount: 300 }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.totalIncome).toBe(5000);
    expect(stats?.totalSpent).toBe(300);
    expect(stats?.net).toBe(4700);
  });

  it('computes spendChangePercent vs prior month', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-03-15T00:00:00Z', amount: 1000 }), // prior month
        tx({ createdAt: '2026-04-15T00:00:00Z', amount: 1500 }), // target month
      ],
      'AED',
      asOf,
    );
    // (1500 − 1000) / 1000 = +50%
    expect(stats?.spendChangePercent).toBe(50);
  });

  it('returns null spendChangePercent when prior month is empty', () => {
    const stats = computeMonthlyWrap(
      [tx({ createdAt: '2026-04-15T00:00:00Z', amount: 100 })],
      'AED',
      asOf,
    );
    expect(stats?.spendChangePercent).toBe(null);
  });

  it('handles year boundary (January → previous December)', () => {
    const janAsOf = new Date(2026, 0, 5); // Jan 5th 2026 → target is Dec 2025
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2025-12-15T00:00:00Z', amount: 100 }),
        tx({ createdAt: '2026-01-02T00:00:00Z', amount: 999 }), // should be ignored
      ],
      'AED',
      janAsOf,
    );
    expect(stats?.totalSpent).toBe(100);
    expect(stats?.monthKey).toBe('2025-12');
  });

  it('counts active days correctly (one day with two txns counts once)', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-15T08:00:00Z', amount: 30 }),
        tx({ createdAt: '2026-04-15T18:00:00Z', amount: 20 }),
        tx({ createdAt: '2026-04-20T12:00:00Z', amount: 50 }),
      ],
      'AED',
      asOf,
    );
    expect(stats?.activeDays).toBe(2);
  });
});

describe('shouldShowMonthlyWrap', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false for null stats', () => {
    expect(shouldShowMonthlyWrap(null)).toBe(false);
  });

  it('returns false when txCount < 3', () => {
    const stats = computeMonthlyWrap(
      [
        tx({ createdAt: '2026-04-15T00:00:00Z' }),
        tx({ createdAt: '2026-04-16T00:00:00Z' }),
      ],
      'AED',
      new Date(2026, 4, 5),
    );
    expect(shouldShowMonthlyWrap(stats)).toBe(false);
  });

  it('returns true on first show for the month', () => {
    const stats = computeMonthlyWrap(
      Array.from({ length: 5 }, (_, i) =>
        tx({ createdAt: `2026-04-${10 + i}T00:00:00Z` }),
      ),
      'AED',
      new Date(2026, 4, 5),
    );
    expect(shouldShowMonthlyWrap(stats)).toBe(true);
  });

  it('returns false after markWrapShown for the same month', () => {
    const stats = computeMonthlyWrap(
      Array.from({ length: 5 }, (_, i) =>
        tx({ createdAt: `2026-04-${10 + i}T00:00:00Z` }),
      ),
      'AED',
      new Date(2026, 4, 5),
    );
    markWrapShown(stats!.monthKey);
    expect(shouldShowMonthlyWrap(stats)).toBe(false);
  });
});
