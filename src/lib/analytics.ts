import type { Currency, Transaction, TransactionType } from '../db';

export interface CategoryData {
  category: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface MonthlyData {
  month: string;
  income: number;
  expense: number;
}

export interface DailyData {
  day: string;
  amount: number;
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'];

/**
 * Shared tail of every category breakdown: percentage, colour, rank.
 *
 * `entries` MUST arrive in first-appearance order, because the colour index is
 * assigned BEFORE the sort — a category's colour is tied to when it was first
 * seen in the transaction list, not to its rank. That looks like an accident
 * but it is the shipped behaviour and the pie/legend both depend on it, so
 * both the client path (`groupByCategory`) and the RPC path
 * (`groupByCategoryFromSummary`) run through this one function.
 */
export function categoryDataFrom(entries: readonly (readonly [string, number])[]): CategoryData[] {
  const total = entries.reduce((s, [, amount]) => s + amount, 0);
  return entries
    .map(([category, amount], i) => ({
      category,
      amount,
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
      color: COLORS[i % COLORS.length],
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function groupByCategory(transactions: Transaction[], startDate: Date, endDate: Date): CategoryData[] {
  const expenses = transactions.filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate);
  const map = new Map<string, number>();
  expenses.forEach(t => { map.set(t.category || 'Other', (map.get(t.category || 'Other') ?? 0) + t.amount); });
  return categoryDataFrom(Array.from(map.entries()));
}

/**
 * Per-currency totals for one transaction type inside a window. Lifted out of
 * AnalyticsPage unchanged (it powers the "Total spent" / "Total income" cards)
 * so the RPC path has something to be proven equal to.
 *
 * NEVER sums across currencies — Hisaab has no FX rates and `conversion_rate`
 * on a transaction row describes the account leg, not an analytics rate.
 */
export function sumByCurrency(
  transactions: readonly Transaction[],
  type: 'expense' | 'income',
  start: Date,
  end: Date,
): { currency: Currency; amount: number }[] {
  const totals = new Map<Currency, number>();
  transactions
    .filter(tx => tx.type === type && new Date(tx.createdAt) >= start && new Date(tx.createdAt) <= end)
    .forEach(tx => totals.set(tx.currency, (totals.get(tx.currency) ?? 0) + tx.amount));

  return Array.from(totals.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

/**
 * The LAST INSTANT of the calendar month `monthIndex` of `year`.
 *
 * BUG FIX (audit P2 M2d). Every month-bucket end in this app used to be written
 * `new Date(y, m + 1, 0, 23, 59, 59)` — the last day of the month at
 * 23:59:59.**000**. Every comparison against it is `<=`, so a transaction
 * stamped in the final 999 ms of a month (`…T23:59:59.500Z`) fell out of BOTH
 * the month it belongs to and the next one: money that exists in the ledger and
 * in no chart. Rare, but it is a silent hole, not a rounding preference.
 *
 * `new Date(y, m + 1, 1).getTime() - 1` is the same boundary with no hole, and —
 * this matters for the SQL port — it makes the bucket EXACTLY one calendar
 * month, which is what `date_trunc('month', …)` produces. The old end could not
 * be reproduced by any SQL bucket, which is why `monthlyTrend` was listed as
 * "NOT PORTED" in supabase-migration-p2-analytics-aggregates.sql. Fixing it in
 * TypeScript is what makes the trend servable from `analytics_monthly_summary`
 * without a fourth RPC.
 */
export function endOfMonthExact(year: number, monthIndex: number): Date {
  return new Date(new Date(year, monthIndex + 1, 1).getTime() - 1);
}

/**
 * The N month buckets `monthlyTrend` walks, oldest first: N-1 months back from
 * `now` through `now`'s own month. Shared by the client path and the
 * summary-row path so the two can never disagree about what "May" means.
 */
export function trendMonthBuckets(months: number, now: Date = new Date()): { start: Date; end: Date; month: string }[] {
  const buckets: { start: Date; end: Date; month: string }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      start,
      end: endOfMonthExact(now.getFullYear(), now.getMonth() - i),
      month: start.toLocaleDateString('en', { month: 'short' }),
    });
  }
  return buckets;
}

export function monthlyTrend(transactions: Transaction[], months: number, now: Date = new Date()): MonthlyData[] {
  return trendMonthBuckets(months, now).map(({ start, end, month }) => {
    const filtered = transactions.filter(t => { const d = new Date(t.createdAt); return d >= start && d <= end; });
    return {
      month,
      income: filtered.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      expense: filtered.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0),
    };
  });
}

/**
 * The tail both daily-chart paths share: day-of-month totals → one bar per day
 * of the window, capped at 31.
 *
 * The cap and the DAY-OF-MONTH key (not the date) are shipped behaviour, quirks
 * included: over a window longer than a month, the 5th of April and the 5th of
 * May land in the same bar. Both the client path and the RPC path run through
 * this function, so the RPC cannot quietly "fix" it into a divergence.
 */
function dailyFromDayOfMonthTotals(totals: Map<string, number>, startDate: Date, endDate: Date): DailyData[] {
  const result: DailyData[] = [];
  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  for (let i = 0; i < Math.min(days, 31); i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = d.getDate().toString();
    result.push({ day: key, amount: totals.get(key) ?? 0 });
  }
  return result;
}

export function dailySpending(transactions: Transaction[], startDate: Date, endDate: Date): DailyData[] {
  const expenses = transactions.filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate);
  const map = new Map<string, number>();
  expenses.forEach(t => {
    const day = new Date(t.createdAt).getDate().toString();
    map.set(day, (map.get(day) ?? 0) + t.amount);
  });
  return dailyFromDayOfMonthTotals(map, startDate, endDate);
}

export function topExpenses(transactions: Transaction[], startDate: Date, endDate: Date, limit = 5): Transaction[] {
  return transactions
    .filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export function groupSpendingByGroup(expenses: { groupId: string; groupName: string; amount: number }[]): { name: string; amount: number; color: string }[] {
  const map = new Map<string, { name: string; amount: number }>();
  expenses.forEach(e => {
    const existing = map.get(e.groupId);
    if (existing) existing.amount += e.amount;
    else map.set(e.groupId, { name: e.groupName, amount: e.amount });
  });
  return Array.from(map.values())
    .sort((a, b) => b.amount - a.amount)
    .map((item, i) => ({ ...item, color: COLORS[i % COLORS.length] }));
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL-side analytics aggregates (audit 03-performance M2 / H3)
// ═══════════════════════════════════════════════════════════════════════════
//
// AnalyticsPage sums the user's ENTIRE transaction history in the browser. The
// fix is to let Postgres do the grouping — `analytics_monthly_summary` in
// supabase-migration-p2-analytics-aggregates.sql.
//
// Everything below is the TypeScript twin of that RPC. It exists for two
// reasons and only two:
//
//   1. It is the SPEC. `monthlySummaryFromTransactions` is what the SQL must
//      produce, row for row, for the same input — asserted in Docker against a
//      real PostgreSQL 15 (see the migration header, and analytics.test.ts for
//      the fixture both sides are fed).
//   2. It is the ORACLE for the derivations. The RPC only returns grouped
//      sums; `groupByCategoryFromSummary` / `sumByCurrencyFromSummary` turn
//      those back into exactly what the shipped client functions produce, and
//      the tests run one fixture through both routes.
//
// Nothing here runs in production when `VITE_ANALYTICS_RPC` is off.

/** One grouped bucket: (month, currency, type, category). */
export interface MonthlySummaryRow {
  /** First day of the bucket's LOCAL calendar month, `YYYY-MM-DD`. */
  monthStart: string;
  currency: Currency;
  type: TransactionType;
  /** Already `Other`-defaulted — an empty or missing category folds in here. */
  category: string;
  total: number;
  txCount: number;
  /** max(createdAt) in the bucket. Reproduces the colour order — see below. */
  latestAt: string;
}

function localMonthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function bucketKey(r: { monthStart: string; currency: string; type: string; category: string }): string {
  return `${r.monthStart}\u0000${r.currency}\u0000${r.type}\u0000${r.category}`;
}

/**
 * The exact aggregation `analytics_monthly_summary(p_from, p_to)` performs.
 *
 * Ported rules (each one is pinned by a test in analytics.test.ts and by the
 * Docker equality run described in the migration header):
 *
 *  - Window is INCLUSIVE at both ends, compared as instants, exactly like every
 *    other analytics filter in this file (`>= start && <= end`).
 *  - Buckets are LOCAL calendar months. The SQL takes the same zone as a
 *    parameter so a UTC+4 device's "April" is the device's April, not UTC's.
 *  - `category || 'Other'` — an empty string is a missing category, not a
 *    category named "".
 *  - NO currency conversion, ever. `conversionRate` is not read here and is not
 *    read by any other function in this file: figures stay per-currency.
 *  - ALL transaction types are returned, not just income/expense. Filtering to
 *    the two the charts use stays in the consumers below (and in the shipped
 *    client functions), so no rule is silently duplicated in SQL.
 *  - Account ids are never read, so a ledger-only (`splits_only`) row with BOTH
 *    `sourceAccountId` and `destinationAccountId` null aggregates identically
 *    to a full-tracker row. Both app modes produce the same figures.
 *  - Soft-deleted rows never appear: the client store only ever holds
 *    `deleted_at IS NULL` rows, and the RPC filters for the same thing.
 *
 * Row order is (monthStart, currency, type, category) ascending so the SQL and
 * TS outputs are comparable element by element without re-sorting either side.
 */
export function monthlySummaryFromTransactions(
  transactions: readonly Transaction[],
  from: Date,
  to: Date,
): MonthlySummaryRow[] {
  const buckets = new Map<string, MonthlySummaryRow>();
  for (const t of transactions) {
    const at = new Date(t.createdAt);
    if (!(at >= from && at <= to)) continue;
    const row = {
      monthStart: localMonthStart(at),
      currency: t.currency,
      type: t.type,
      category: t.category || 'Other',
    };
    const key = bucketKey(row);
    const existing = buckets.get(key);
    if (existing) {
      existing.total += t.amount;
      existing.txCount += 1;
      if (t.createdAt > existing.latestAt) existing.latestAt = t.createdAt;
    } else {
      buckets.set(key, { ...row, total: t.amount, txCount: 1, latestAt: t.createdAt });
    }
  }
  return Array.from(buckets.values()).sort(
    (a, b) =>
      a.monthStart.localeCompare(b.monthStart) ||
      a.currency.localeCompare(b.currency) ||
      a.type.localeCompare(b.type) ||
      a.category.localeCompare(b.category),
  );
}

/** The currencies the period's income/expense rows are denominated in, sorted. */
export function summaryCurrencies(rows: readonly MonthlySummaryRow[]): Currency[] {
  const seen = new Set<Currency>();
  for (const r of rows) {
    if (r.type === 'expense' || r.type === 'income') seen.add(r.currency);
  }
  return Array.from(seen).sort();
}

/** `sumByCurrency`, rebuilt from a summary the RPC returned for the same window. */
export function sumByCurrencyFromSummary(
  rows: readonly MonthlySummaryRow[],
  type: 'expense' | 'income',
): { currency: Currency; amount: number }[] {
  const totals = new Map<Currency, number>();
  for (const r of rows) {
    if (r.type !== type) continue;
    totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.total);
  }
  return Array.from(totals.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

/**
 * `groupByCategory`, rebuilt from a summary the RPC returned for the same
 * window and one currency.
 *
 * The subtle part is COLOUR. `groupByCategory` assigns colours by a category's
 * first appearance in the transaction array, and the store holds transactions
 * `createdAt DESC` (transactionStore's refresh sort; optimistic inserts
 * prepend). First appearance in a DESC list is therefore the category with the
 * greatest `createdAt` — which is exactly `max(created_at)` per bucket, the
 * `latestAt` the RPC returns. Ordering categories by `latestAt` DESC
 * reproduces the client's colour assignment without shipping row-level data.
 *
 * Only an exact `createdAt` tie between two different categories could swap a
 * pair of colours; amounts, percentages and ranking are unaffected either way.
 */
export function groupByCategoryFromSummary(
  rows: readonly MonthlySummaryRow[],
  currency: Currency,
): CategoryData[] {
  const totals = new Map<string, number>();
  const latest = new Map<string, string>();
  for (const r of rows) {
    if (r.type !== 'expense' || r.currency !== currency) continue;
    totals.set(r.category, (totals.get(r.category) ?? 0) + r.total);
    const seenAt = latest.get(r.category);
    if (seenAt === undefined || r.latestAt > seenAt) latest.set(r.category, r.latestAt);
  }
  const firstAppearanceOrder = Array.from(totals.entries()).sort((a, b) => {
    const la = latest.get(a[0]) ?? '';
    const lb = latest.get(b[0]) ?? '';
    return lb.localeCompare(la) || a[0].localeCompare(b[0]);
  });
  return categoryDataFrom(firstAppearanceOrder);
}

/**
 * `monthlyTrend`, rebuilt from summary rows the RPC returned for a window that
 * covers the same N month buckets, in ONE currency.
 *
 * This is only sound because `endOfMonthExact` above closed the 999 ms hole:
 * the client bucket is now exactly a calendar month, which is exactly what
 * `date_trunc('month', created_at AT TIME ZONE tz)` produces. Before that fix
 * the two could differ, which is why the M2(c) migration listed the trend as
 * NOT PORTED. No fourth RPC is needed — `analytics_monthly_summary` called over
 * the trend window IS the trend.
 */
export function monthlyTrendFromSummary(
  rows: readonly MonthlySummaryRow[],
  currency: Currency,
  months: number,
  now: Date = new Date(),
): MonthlyData[] {
  return trendMonthBuckets(months, now).map(({ start, month }) => {
    const key = localMonthStart(start);
    let income = 0;
    let expense = 0;
    for (const r of rows) {
      if (r.monthStart !== key || r.currency !== currency) continue;
      if (r.type === 'income') income += r.total;
      else if (r.type === 'expense') expense += r.total;
    }
    return { month, income, expense };
  });
}

/** One (currency, type) total for a window's summary rows. Powers the spend-trend card. */
export function totalFromSummary(
  rows: readonly MonthlySummaryRow[],
  type: 'expense' | 'income',
  currency: Currency,
): number {
  let total = 0;
  for (const r of rows) if (r.type === type && r.currency === currency) total += r.total;
  return total;
}

// ── analytics_daily_series ─────────────────────────────────────────────────

/** One grouped bucket: (local calendar day, currency, type). */
export interface DailySeriesRow {
  /** The LOCAL calendar date, `YYYY-MM-DD`. */
  day: string;
  currency: Currency;
  type: TransactionType;
  total: number;
  txCount: number;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The exact aggregation `analytics_daily_series(p_from, p_to, p_tz)` performs.
 *
 * Same rule set as `monthlySummaryFromTransactions` (R1-R8), one grain finer:
 * the bucket is a LOCAL calendar DATE rather than a month, and there is no
 * `category` dimension (the daily chart does not use one) and no `latestAt`
 * (nothing downstream needs a colour order). In particular: window inclusive at
 * both ends, no currency conversion, EVERY transaction type returned (the
 * "expense is spend" rule keeps its single definition in the consumer below),
 * and no predicate on either account id, so a splits_only ledger row with BOTH
 * account ids null aggregates identically to a full_tracker row.
 *
 * Row order is (day, currency, type) ascending, matching the SQL's ORDER BY.
 */
export function dailySeriesFromTransactions(
  transactions: readonly Transaction[],
  from: Date,
  to: Date,
): DailySeriesRow[] {
  const buckets = new Map<string, DailySeriesRow>();
  for (const t of transactions) {
    const at = new Date(t.createdAt);
    if (!(at >= from && at <= to)) continue;
    const day = localDateKey(at);
    const key = `${day} ${t.currency} ${t.type}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.total += t.amount;
      existing.txCount += 1;
    } else {
      buckets.set(key, { day, currency: t.currency, type: t.type, total: t.amount, txCount: 1 });
    }
  }
  return Array.from(buckets.values()).sort(
    (a, b) => a.day.localeCompare(b.day) || a.currency.localeCompare(b.currency) || a.type.localeCompare(b.type),
  );
}

/**
 * `dailySpending`, rebuilt from a daily series the RPC returned for the same
 * window, in one currency.
 *
 * The fold from calendar DATE back to the chart's DAY-OF-MONTH key happens
 * here, in TypeScript, deliberately: the SQL returns real dates (a fact), the
 * quirk (day-of-month keys, 31-bar cap, cross-month collisions) stays in one
 * place and is applied by the same `dailyFromDayOfMonthTotals` the client path
 * uses.
 */
export function dailySpendingFromSeries(
  rows: readonly DailySeriesRow[],
  currency: Currency,
  startDate: Date,
  endDate: Date,
): DailyData[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== 'expense' || r.currency !== currency) continue;
    // 'YYYY-MM-DD' → the day-of-month key the chart bars are keyed by, with no
    // leading zero: `new Date(...).getDate().toString()`.
    const key = String(Number(r.day.slice(8, 10)));
    totals.set(key, (totals.get(key) ?? 0) + r.total);
  }
  return dailyFromDayOfMonthTotals(totals, startDate, endDate);
}

/** The currencies a daily series carries expense rows for. */
export function dailySeriesCurrencies(rows: readonly DailySeriesRow[]): Currency[] {
  const seen = new Set<Currency>();
  for (const r of rows) if (r.type === 'expense') seen.add(r.currency);
  return Array.from(seen).sort();
}

// ── analytics_top_expenses ─────────────────────────────────────────────────

/**
 * One row of the top-expenses list — exactly the columns AnalyticsPage renders
 * (`category` for the title and the drill-in href, `notes` for the subtitle via
 * `parseInternalNote`, `amount`+`currency` for the figure, `id` for the key).
 */
export interface TopExpenseRow {
  id: string;
  createdAt: string;
  amount: number;
  currency: Currency;
  category: string;
  notes: string;
}

/** Narrow a loaded transaction to the columns the RPC returns. */
export function toTopExpenseRow(t: Transaction): TopExpenseRow {
  return {
    id: t.id,
    createdAt: t.createdAt,
    amount: t.amount,
    currency: t.currency,
    category: t.category ?? '',
    notes: t.notes ?? '',
  };
}

/**
 * The exact selection `analytics_top_expenses(p_from, p_to, p_limit)` performs.
 *
 * RANKING RULE, ported verbatim from the client. `topExpenses` does
 * `.sort((a, b) => b.amount - a.amount)` over `chartTransactions`, which is the
 * store array (`created_at DESC`, and `id DESC` within an identical timestamp —
 * the order `transactionsDb.getAllPaged` fetches in) filtered by currency.
 * `Array.prototype.sort` is stable, so two equal amounts keep that order:
 *
 *     ORDER BY amount DESC, created_at DESC, id DESC
 *
 * PARTITIONED BY CURRENCY, which is a deliberate widening of the audit's
 * suggested signature. The page always shows ONE currency's top expenses, and a
 * plain global top-N would hand a PKR-viewing user five AED rows and an empty
 * list. Top-N *per currency* answers every chip from one call and is a superset
 * of the global list — the client then filters, exactly as it does today.
 */
export function topExpensesFromTransactions(
  transactions: readonly Transaction[],
  from: Date,
  to: Date,
  limit = 5,
): TopExpenseRow[] {
  const byCurrency = new Map<Currency, TopExpenseRow[]>();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const at = new Date(t.createdAt);
    if (!(at >= from && at <= to)) continue;
    const list = byCurrency.get(t.currency);
    if (list) list.push(toTopExpenseRow(t));
    else byCurrency.set(t.currency, [toTopExpenseRow(t)]);
  }
  const out: TopExpenseRow[] = [];
  for (const currency of Array.from(byCurrency.keys()).sort()) {
    const ranked = (byCurrency.get(currency) ?? []).sort(
      (a, b) =>
        b.amount - a.amount ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
    out.push(...ranked.slice(0, limit));
  }
  return out;
}

/** The chart currency's slice of a top-expenses result, already ranked. */
export function topExpensesFromRows(
  rows: readonly TopExpenseRow[],
  currency: Currency,
  limit = 5,
): TopExpenseRow[] {
  return rows.filter((r) => r.currency === currency).slice(0, limit);
}
