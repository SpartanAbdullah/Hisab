import { describe, expect, it } from 'vitest';
import { groupByCategory, monthlyTrend, dailySpending, topExpenses } from './analytics';
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
    createdAt: '2026-04-15T00:00:00Z',
    ...overrides,
  };
}

describe('groupByCategory', () => {
  it('ranks categories by total spend with shares summing to 100', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-30T23:59:59Z');
    const result = groupByCategory(
      [
        tx({ amount: 300, category: 'Rent' }),
        tx({ amount: 100, category: 'Food & Dining' }),
        tx({ amount: 100, category: 'Food & Dining' }),
      ],
      start,
      end,
    );
    expect(result[0]).toMatchObject({ category: 'Rent', amount: 300, percentage: 60 });
    expect(result[1]).toMatchObject({ category: 'Food & Dining', amount: 200, percentage: 40 });
    expect(result.reduce((s, r) => s + r.percentage, 0)).toBe(100);
  });

  it('defaults missing category to "Other"', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-30T23:59:59Z');
    const result = groupByCategory([tx({ amount: 50, category: '' })], start, end);
    expect(result[0]?.category).toBe('Other');
  });

  it('returns empty when no expenses fall in range', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-31T23:59:59Z');
    const result = groupByCategory(
      [tx({ amount: 100, createdAt: '2026-04-15T00:00:00Z' })],
      start,
      end,
    );
    expect(result).toEqual([]);
  });
});

describe('monthlyTrend', () => {
  it('produces N buckets, oldest first', () => {
    const result = monthlyTrend([], 3);
    expect(result).toHaveLength(3);
    // Result is most-distant first → label sequence reflects that.
    expect(result.map((r) => r.income)).toEqual([0, 0, 0]);
  });

  it('bucketizes income and expense per month independently', () => {
    // Pick recent months relative to today so the bucket aligns deterministically.
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
    const result = monthlyTrend(
      [
        tx({ type: 'income', amount: 5000, createdAt: thisMonth }),
        tx({ type: 'expense', amount: 1200, createdAt: thisMonth }),
        tx({ type: 'expense', amount: 800, createdAt: lastMonth }),
      ],
      2,
    );
    // Last entry is the current month (oldest-first ordering).
    expect(result[1]?.income).toBe(5000);
    expect(result[1]?.expense).toBe(1200);
    expect(result[0]?.expense).toBe(800);
    expect(result[0]?.income).toBe(0);
  });
});

describe('dailySpending', () => {
  it('produces one entry per day in the range, capped at 31', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-07T00:00:00Z');
    const result = dailySpending([], start, end);
    expect(result).toHaveLength(7);
    expect(result.every((d) => d.amount === 0)).toBe(true);
  });

  it('sums same-day expenses into one bucket', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-03T00:00:00Z');
    const result = dailySpending(
      [
        tx({ amount: 30, createdAt: '2026-04-02T08:00:00Z' }),
        tx({ amount: 20, createdAt: '2026-04-02T18:00:00Z' }),
      ],
      start,
      end,
    );
    const day2 = result.find((d) => d.day === '2');
    expect(day2?.amount).toBe(50);
  });
});

describe('topExpenses', () => {
  it('returns top N expenses by amount desc', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-30T23:59:59Z');
    const result = topExpenses(
      [
        tx({ amount: 50 }),
        tx({ amount: 500 }),
        tx({ amount: 150 }),
        tx({ amount: 1000 }),
        tx({ amount: 75 }),
      ],
      start,
      end,
      3,
    );
    expect(result.map((t) => t.amount)).toEqual([1000, 500, 150]);
  });
});
