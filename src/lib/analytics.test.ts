import { describe, expect, it } from 'vitest';
import {
  groupByCategory,
  groupByCategoryFromSummary,
  monthlyTrend,
  monthlyTrendFromSummary,
  dailySpending,
  dailySeriesFromTransactions,
  dailySpendingFromSeries,
  endOfMonthExact,
  monthlySummaryFromTransactions,
  sumByCurrency,
  sumByCurrencyFromSummary,
  summaryCurrencies,
  topExpenses,
  topExpensesFromRows,
  topExpensesFromTransactions,
  toTopExpenseRow,
  totalFromSummary,
} from './analytics';
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

  it('assigns colour by FIRST APPEARANCE, not by rank', () => {
    // Regression pin for the rule groupByCategoryFromSummary has to reproduce
    // without row-level data: the colour index comes from the insertion order
    // of the Map, and only THEN is the list sorted by amount.
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-30T23:59:59Z');
    const result = groupByCategory(
      [tx({ amount: 10, category: 'Small' }), tx({ amount: 900, category: 'Big' })],
      start,
      end,
    );
    expect(result[0]?.category).toBe('Big');
    expect(result[0]?.color).toBe('#10b981'); // second colour: 'Big' was seen second
    expect(result[1]?.color).toBe('#6366f1'); // first colour: 'Small' was seen first
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

  // ── Regression: the 999 ms hole (audit P2 M2d) ───────────────────────────
  // The bucket end used to be `new Date(y, m + 1, 0, 23, 59, 59)` — 23:59:59.000
  // — and every comparison against it is `<=`. A transaction stamped in the
  // final 999 ms of a month therefore belonged to NO bucket: not to its own
  // month (past the end) and not to the next one (before its start). Money in
  // the ledger, money in no chart.
  it('counts a transaction in the LAST 999 ms of a month (bucket end is exact)', () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const result = monthlyTrend(
      [tx({ amount: 42, createdAt: '2026-04-30T23:59:59.500Z' })],
      2,
      now,
    );
    expect(result.map((r) => r.month)).toEqual(['Apr', 'May']);
    expect(result[0]?.expense).toBe(42); // was 0 before the fix
    expect(result[1]?.expense).toBe(0);
  });

  it('endOfMonthExact is the last millisecond of the month, not 23:59:59.000', () => {
    expect(endOfMonthExact(2026, 3).toISOString()).toBe('2026-04-30T23:59:59.999Z');
    // Leap-year February, and a December that must not roll the year wrong.
    expect(endOfMonthExact(2024, 1).toISOString()).toBe('2024-02-29T23:59:59.999Z');
    expect(endOfMonthExact(2026, 11).toISOString()).toBe('2026-12-31T23:59:59.999Z');
  });

  it('buckets are contiguous — no instant falls between two months', () => {
    const buckets = monthlyTrend([], 3, new Date('2026-05-15T00:00:00.000Z'));
    expect(buckets).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const start = new Date(2026, 2 + i, 1);
      const end = endOfMonthExact(2026, 2 + i);
      expect(end.getTime() + 1).toBe(new Date(2026, 3 + i, 1).getTime());
      expect(start.getTime()).toBeLessThan(end.getTime());
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// SQL-side analytics aggregates (audit 03-performance M2 / H3)
// ═══════════════════════════════════════════════════════════════════════════
//
// `supabase-migration-p2-analytics-aggregates.sql` moves the summary-card and
// category aggregation into Postgres. These tests are the contract:
//
//   * every rule the SQL had to re-implement is pinned here against the shipped
//     client behaviour, and
//   * ANALYTICS_FIXTURE is the exact fixture the migration's Docker equality
//     run seeds into PostgreSQL 15 — the RPC's output is compared row for row
//     against `monthlySummaryFromTransactions(ANALYTICS_FIXTURE, …)`.
//
// vitest.setup.ts pins TZ=UTC, so "local month" here is the UTC month, which is
// exactly what the Docker run passes to the RPC as `p_tz`.

/**
 * Deliberately exercises every rule the port had to carry:
 *  - two currencies inside one window (must never be summed together)
 *  - a `conversionRate`-bearing row (must be ignored — analytics has no FX)
 *  - a LEDGER-ONLY row: BOTH account ids null (the splits_only repayment shape)
 *  - an empty category (folds to 'Other')
 *  - non-income/expense types: transfer, adjustment, investment_buy, repayment
 *  - two calendar months, plus rows sitting exactly on each window edge
 *  - a row just outside the window on each side
 */
export const ANALYTICS_FIXTURE: Transaction[] = [
  // ── outside the window (before) ──
  tx({ id: 'f00', amount: 999, createdAt: '2026-03-31T23:59:59.999Z', category: 'Rent' }),
  // ── exactly the `from` edge, inclusive ──
  tx({ id: 'f01', amount: 100, createdAt: '2026-04-01T00:00:00.000Z', category: 'Food & Dining' }),
  tx({ id: 'f02', amount: 250.55, createdAt: '2026-04-03T10:00:00.000Z', category: 'Rent' }),
  tx({ id: 'f03', amount: 40.45, createdAt: '2026-04-03T18:30:00.000Z', category: '' }),
  tx({ id: 'f04', type: 'income', amount: 5000, createdAt: '2026-04-05T08:00:00.000Z', category: 'Salary' }),
  // Second currency in the same month — must stay a separate bucket.
  tx({ id: 'f05', amount: 3000, currency: 'PKR', createdAt: '2026-04-06T09:00:00.000Z', category: 'Food & Dining' }),
  tx({ id: 'f06', type: 'income', amount: 12000, currency: 'PKR', createdAt: '2026-04-07T09:00:00.000Z', category: 'Freelance' }),
  // conversionRate is set: analytics must ignore it entirely.
  tx({ id: 'f07', amount: 82.5, currency: 'PKR', conversionRate: 0.013, createdAt: '2026-04-08T09:00:00.000Z', category: 'Travel' }),
  // LEDGER-ONLY row (splits_only): both account ids null. Must count normally.
  tx({ id: 'f08', amount: 60, sourceAccountId: null, destinationAccountId: null, createdAt: '2026-04-09T12:00:00.000Z', category: 'Food & Dining' }),
  // Types that are neither income nor expense — returned by the RPC, filtered
  // out by every consumer, never part of a spend/income figure.
  tx({ id: 'f09', type: 'transfer', amount: 700, createdAt: '2026-04-10T12:00:00.000Z', category: 'Transfer' }),
  tx({ id: 'f10', type: 'adjustment', amount: 15, createdAt: '2026-04-11T12:00:00.000Z', category: 'Adjustment' }),
  tx({ id: 'f11', type: 'investment_buy', amount: 2000, createdAt: '2026-04-12T12:00:00.000Z', category: 'Investment' }),
  tx({ id: 'f12', type: 'repayment', amount: 300, sourceAccountId: null, destinationAccountId: null, createdAt: '2026-04-13T12:00:00.000Z', category: 'Loan' }),
  // ── May: a second calendar month inside the same window ──
  tx({ id: 'f13', amount: 90, createdAt: '2026-05-02T07:00:00.000Z', category: 'Food & Dining' }),
  tx({ id: 'f14', amount: 400, createdAt: '2026-05-04T07:00:00.000Z', category: 'Rent' }),
  tx({ id: 'f15', type: 'income', amount: 5200, createdAt: '2026-05-05T07:00:00.000Z', category: 'Salary' }),
  // Exactly the `to` edge, inclusive.
  tx({ id: 'f16', amount: 25, createdAt: '2026-05-31T23:59:59.000Z', category: 'Groceries' }),
  // ── outside the window (after) ──
  tx({ id: 'f17', amount: 777, createdAt: '2026-06-01T00:00:00.000Z', category: 'Rent' }),
];

export const FIXTURE_FROM = new Date('2026-04-01T00:00:00.000Z');
export const FIXTURE_TO = new Date('2026-05-31T23:59:59.000Z');

describe('monthlySummaryFromTransactions (the SQL contract)', () => {
  const rows = monthlySummaryFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO);
  const find = (monthStart: string, currency: string, type: string, category: string) =>
    rows.find(
      (r) =>
        r.monthStart === monthStart &&
        r.currency === currency &&
        r.type === type &&
        r.category === category,
    );

  it('R3: the window is inclusive at BOTH ends and excludes everything else', () => {
    // f00 (999) and f17 (777) sit just outside; f01 and f16 sit exactly on it.
    expect(rows.some((r) => r.total === 999 || r.total === 777)).toBe(false);
    expect(find('2026-05-01', 'AED', 'expense', 'Groceries')?.total).toBe(25);
    expect(find('2026-04-01', 'AED', 'expense', 'Food & Dining')?.txCount).toBe(2);
  });

  it('R_month: buckets by LOCAL calendar month', () => {
    expect(new Set(rows.map((r) => r.monthStart))).toEqual(
      new Set(['2026-04-01', '2026-05-01']),
    );
  });

  it('R4: an empty category folds into "Other", not a category named ""', () => {
    expect(rows.some((r) => r.category === '')).toBe(false);
    expect(find('2026-04-01', 'AED', 'expense', 'Other')?.total).toBeCloseTo(40.45, 10);
  });

  it('R5: currencies are never merged and conversionRate is ignored', () => {
    expect(find('2026-04-01', 'PKR', 'expense', 'Travel')?.total).toBe(82.5); // not × 0.013
    expect(find('2026-04-01', 'AED', 'expense', 'Food & Dining')?.total).toBe(160);
    expect(find('2026-04-01', 'PKR', 'expense', 'Food & Dining')?.total).toBe(3000);
  });

  it('R6: every transaction type survives as its own bucket', () => {
    expect(find('2026-04-01', 'AED', 'transfer', 'Transfer')?.total).toBe(700);
    expect(find('2026-04-01', 'AED', 'adjustment', 'Adjustment')?.total).toBe(15);
    expect(find('2026-04-01', 'AED', 'investment_buy', 'Investment')?.total).toBe(2000);
    expect(find('2026-04-01', 'AED', 'repayment', 'Loan')?.total).toBe(300);
  });

  it('R7: ledger-only rows (both account ids null) aggregate like any other', () => {
    // f08 is the ledger-only AED 60 folded into April Food & Dining (100 + 60).
    const bucket = find('2026-04-01', 'AED', 'expense', 'Food & Dining');
    expect(bucket?.total).toBe(160);
    expect(bucket?.txCount).toBe(2);
  });

  it('is ordered (monthStart, currency, type, category) so SQL rows compare 1:1', () => {
    const keys = rows.map((r) => [r.monthStart, r.currency, r.type, r.category].join('|'));
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('summary derivations equal the client aggregation', () => {
  const rows = monthlySummaryFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO);

  it('sumByCurrencyFromSummary === sumByCurrency, for both types', () => {
    for (const type of ['expense', 'income'] as const) {
      expect(sumByCurrencyFromSummary(rows, type)).toEqual(
        sumByCurrency(ANALYTICS_FIXTURE, type, FIXTURE_FROM, FIXTURE_TO),
      );
    }
  });

  it('groupByCategoryFromSummary === groupByCategory, per currency', () => {
    for (const currency of ['AED', 'PKR'] as const) {
      // The client path filters to one currency BEFORE aggregating — exactly
      // what AnalyticsPage does with `chartTransactions`. The store holds
      // transactions createdAt DESC, which is what makes the colour order
      // reproducible from max(created_at); mirror that ordering here.
      const clientRows = ANALYTICS_FIXTURE
        .filter((t) => t.currency === currency)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      expect(groupByCategoryFromSummary(rows, currency)).toEqual(
        groupByCategory(clientRows, FIXTURE_FROM, FIXTURE_TO),
      );
    }
  });

  it('summaryCurrencies matches the page currency chips', () => {
    const clientCurrencies = Array.from(
      new Set(
        ANALYTICS_FIXTURE.filter(
          (t) =>
            (t.type === 'expense' || t.type === 'income') &&
            new Date(t.createdAt) >= FIXTURE_FROM &&
            new Date(t.createdAt) <= FIXTURE_TO,
        ).map((t) => t.currency),
      ),
    ).sort();
    expect(summaryCurrencies(rows)).toEqual(clientCurrencies);
  });

  it('net per currency matches income minus spend computed from raw rows', () => {
    const net = (
      plus: { currency: string; amount: number }[],
      minus: { currency: string; amount: number }[],
    ) => {
      const m = new Map<string, number>();
      for (const { currency, amount } of plus) m.set(currency, (m.get(currency) ?? 0) + amount);
      for (const { currency, amount } of minus) m.set(currency, (m.get(currency) ?? 0) - amount);
      return [...m.entries()].sort();
    };
    expect(
      net(sumByCurrencyFromSummary(rows, 'income'), sumByCurrencyFromSummary(rows, 'expense')),
    ).toEqual(
      net(
        sumByCurrency(ANALYTICS_FIXTURE, 'income', FIXTURE_FROM, FIXTURE_TO),
        sumByCurrency(ANALYTICS_FIXTURE, 'expense', FIXTURE_FROM, FIXTURE_TO),
      ),
    );
  });

  it('totalFromSummary equals the client per-currency expense sum', () => {
    for (const currency of ['AED', 'PKR'] as const) {
      const client = sumByCurrency(ANALYTICS_FIXTURE, 'expense', FIXTURE_FROM, FIXTURE_TO)
        .find((r) => r.currency === currency)?.amount ?? 0;
      expect(totalFromSummary(rows, 'expense', currency)).toBeCloseTo(client, 10);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M2(d): the two remaining RPCs — analytics_daily_series, analytics_top_expenses
// ═══════════════════════════════════════════════════════════════════════════
//
// Same contract discipline as the monthly summary above: `*FromTransactions` is
// the TypeScript twin the SQL is proven equal to in Docker (see the header of
// supabase-migration-p2-analytics-aggregates-2.sql), and `*From{Series,Rows}`
// rebuilds the SHIPPED client output from what the RPC returns.
//
// The same ANALYTICS_FIXTURE feeds both, so a rule that drifts in either
// direction fails here before it can reach a chart.

/** The store's ordering — created_at DESC, id DESC — which the ranking rule depends on. */
function asStoreOrder(rows: typeof ANALYTICS_FIXTURE) {
  return [...rows].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

describe('dailySeriesFromTransactions (the SQL contract)', () => {
  const rows = dailySeriesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO);
  const find = (day: string, currency: string, type: string) =>
    rows.find((r) => r.day === day && r.currency === currency && r.type === type);

  it('D1: the window is inclusive at BOTH ends', () => {
    expect(rows.some((r) => r.day === '2026-03-31' || r.day === '2026-06-01')).toBe(false);
    expect(find('2026-04-01', 'AED', 'expense')?.total).toBe(100);
    expect(find('2026-05-31', 'AED', 'expense')?.total).toBe(25);
  });

  it('D2: same-day rows of one currency+type fold into ONE bucket', () => {
    // f02 (250.55, Rent) and f03 (40.45, '') are both AED expenses on Apr 3.
    const bucket = find('2026-04-03', 'AED', 'expense');
    expect(bucket?.total).toBeCloseTo(291, 10);
    expect(bucket?.txCount).toBe(2);
  });

  it('D3: currencies are never merged and conversionRate is ignored', () => {
    expect(find('2026-04-08', 'PKR', 'expense')?.total).toBe(82.5); // not × 0.013
    expect(find('2026-04-06', 'PKR', 'expense')?.total).toBe(3000);
    expect(find('2026-04-06', 'AED', 'expense')).toBeUndefined();
  });

  it('D4: every transaction type survives as its own bucket', () => {
    expect(find('2026-04-10', 'AED', 'transfer')?.total).toBe(700);
    expect(find('2026-04-11', 'AED', 'adjustment')?.total).toBe(15);
    expect(find('2026-04-12', 'AED', 'investment_buy')?.total).toBe(2000);
    expect(find('2026-04-13', 'AED', 'repayment')?.total).toBe(300);
    expect(find('2026-04-05', 'AED', 'income')?.total).toBe(5000);
  });

  it('D5: ledger-only rows (both account ids null) aggregate like any other', () => {
    // f08 — AED 60 on Apr 9, both account ids null.
    expect(find('2026-04-09', 'AED', 'expense')?.total).toBe(60);
    // f12 — a splits_only repayment record, also both ids null.
    expect(find('2026-04-13', 'AED', 'repayment')?.txCount).toBe(1);
  });

  it('is ordered (day, currency, type) so SQL rows compare 1:1', () => {
    const keys = rows.map((r) => [r.day, r.currency, r.type].join('|'));
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('dailySpendingFromSeries === dailySpending', () => {
  const series = dailySeriesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO);

  it('reproduces the shipped chart, per currency, quirks included', () => {
    for (const currency of ['AED', 'PKR'] as const) {
      const clientRows = ANALYTICS_FIXTURE.filter((t) => t.currency === currency);
      expect(dailySpendingFromSeries(series, currency, FIXTURE_FROM, FIXTURE_TO)).toEqual(
        dailySpending(clientRows, FIXTURE_FROM, FIXTURE_TO),
      );
    }
  });

  it('keeps the 31-bar cap and the day-of-month collision across months', () => {
    // The fixture window is 61 days, so the chart is capped at 31 bars keyed by
    // day-of-month — May 2 lands on the same bar as April 2 by design.
    const bars = dailySpendingFromSeries(series, 'AED', FIXTURE_FROM, FIXTURE_TO);
    expect(bars).toHaveLength(31);
    // 31 bars walked from Apr 1 = Apr 1-30 then May 1, so the LAST bar re-uses
    // key '1' — the collision, visible.
    expect(bars.at(-1)?.day).toBe('1');
    expect(bars.find((b) => b.day === '2')?.amount).toBe(90);   // May 2 only
    expect(bars.find((b) => b.day === '3')?.amount).toBeCloseTo(291, 10);
    // Every May day-of-month is folded in, including the inclusive `to` edge —
    // day '31' is not a bar here (April has 30 days) but its 25 is still summed
    // into the series, which is what the RPC returns.
    expect(series.find((r) => r.day === '2026-05-31')?.total).toBe(25);
    expect(bars.find((b) => b.day === '4')?.amount).toBe(400);  // May 4
  });
});

describe('topExpensesFromTransactions (the SQL contract)', () => {
  const rows = topExpensesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO, 5);

  it('T1: expenses only, window inclusive, both edges present', () => {
    expect(rows.every((r) => r.amount !== 5000 && r.amount !== 700)).toBe(true); // income/transfer
    expect(rows.some((r) => r.amount === 999 || r.amount === 777)).toBe(false);  // outside
    expect(rows.some((r) => r.id === 'f01')).toBe(true);                          // from edge
  });

  it('T2: ranked amount DESC within each currency, partitioned by currency', () => {
    const aed = rows.filter((r) => r.currency === 'AED').map((r) => r.amount);
    const pkr = rows.filter((r) => r.currency === 'PKR').map((r) => r.amount);
    expect(aed).toEqual([...aed].sort((a, b) => b - a));
    expect(pkr).toEqual([3000, 82.5]);
    expect(aed.length).toBe(5); // limit applies PER currency
  });

  it('T3: an amount tie breaks by createdAt DESC then id DESC (stable-sort port)', () => {
    const tie = [
      tx({ id: 'a1', amount: 100, createdAt: '2026-04-02T00:00:00.000Z' }),
      tx({ id: 'a2', amount: 100, createdAt: '2026-04-04T00:00:00.000Z' }),
      tx({ id: 'a3', amount: 100, createdAt: '2026-04-04T00:00:00.000Z' }),
    ];
    expect(
      topExpensesFromTransactions(tie, FIXTURE_FROM, FIXTURE_TO, 3).map((r) => r.id),
    ).toEqual(['a3', 'a2', 'a1']);
  });

  it('T4: a ledger-only row (both account ids null) can rank', () => {
    expect(rows.some((r) => r.id === 'f08')).toBe(true);
  });

  it('carries exactly the columns the page renders', () => {
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['amount', 'category', 'createdAt', 'currency', 'id', 'notes'].sort(),
    );
  });
});

describe('topExpensesFromRows === topExpenses', () => {
  const rows = topExpensesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO, 5);

  it('reproduces the shipped list, per currency', () => {
    for (const currency of ['AED', 'PKR'] as const) {
      // AnalyticsPage feeds `chartTransactions` — the store array (created_at
      // DESC, id DESC) filtered to one currency — into `topExpenses`.
      const clientRows = asStoreOrder(ANALYTICS_FIXTURE).filter((t) => t.currency === currency);
      expect(topExpensesFromRows(rows, currency, 5)).toEqual(
        topExpenses(clientRows, FIXTURE_FROM, FIXTURE_TO, 5).map(toTopExpenseRow),
      );
    }
  });
});

describe('monthlyTrendFromSummary === monthlyTrend', () => {
  // Two buckets — April and May 2026 — which is what the fixture spans.
  const now = new Date('2026-05-15T12:00:00.000Z');
  const trendFrom = new Date(2026, 3, 1);
  const trendTo = endOfMonthExact(2026, 4);
  const rows = monthlySummaryFromTransactions(ANALYTICS_FIXTURE, trendFrom, trendTo);

  it('rebuilds the trend from monthly summary rows, per currency', () => {
    for (const currency of ['AED', 'PKR'] as const) {
      expect(monthlyTrendFromSummary(rows, currency, 2, now)).toEqual(
        monthlyTrend(ANALYTICS_FIXTURE.filter((t) => t.currency === currency), 2, now),
      );
    }
  });

  it('the trend needs no RPC of its own — the monthly summary IS the trend', () => {
    // Pinning the reason: after the endOfMonthExact fix, the trend window is
    // exactly [month start, month end] for every bucket, which is precisely what
    // date_trunc('month') produces. A bucket the summary cannot express would
    // break this equality.
    const aed = monthlyTrendFromSummary(rows, 'AED', 2, now);
    expect(aed.map((r) => r.month)).toEqual(['Apr', 'May']);
    expect(aed[0]?.income).toBe(5000);
    expect(aed[1]?.income).toBe(5200);
    expect(aed[1]?.expense).toBe(515); // 90 + 400 + 25
  });
});
