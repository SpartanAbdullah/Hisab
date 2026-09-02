// Monthly Hisaab Wrap: Spotify-Wrapped for your money. Computed entirely
// on the client from existing transactions; no schema changes.
//
// The wrap focuses on the PRIOR calendar month — we want users to see
// "April was..." on May 1st, not "April so far" on April 28th. The
// trigger logic in MonthlyWrapModal handles when to display.

import type { Transaction, Currency } from '../db';
import { localIso } from './localDate';

export interface WrapStats {
  // Which month this wrap describes — "2026-04" form.
  monthKey: string;
  monthLabel: string; // "April 2026"
  primaryCurrency: Currency;
  txCount: number;
  totalSpent: number;          // sum of expenses in primary currency
  totalIncome: number;         // sum of incomes in primary currency
  net: number;                 // income - spend
  // Top categories by spend, max 3.
  topCategories: { category: string; amount: number; share: number }[];
  // Single biggest expense (in primary currency only).
  biggestExpense: Transaction | null;
  // Day with the highest spend. ISO date.
  bigSpendDay: { date: string; amount: number } | null;
  // Comparison to the month before. Negative = saved more / spent less.
  spendChangePercent: number | null;
  // Number of days with at least one expense ("active days").
  activeDays: number;
  // A one-line headline appropriate for the lead card.
  headline: string;
}

export function computeMonthlyWrap(
  transactions: readonly Transaction[],
  primaryCurrency: Currency,
  // Defaults to "last month" — pass a Date to override for testing.
  asOf: Date = new Date(),
): WrapStats | null {
  const target = new Date(asOf.getFullYear(), asOf.getMonth() - 1, 1);
  const targetStart = target.getTime();
  const targetEnd = new Date(target.getFullYear(), target.getMonth() + 1, 1).getTime();
  const prevStart = new Date(target.getFullYear(), target.getMonth() - 1, 1).getTime();
  const prevEnd = targetStart;
  const monthKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = target.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Filter to primary-currency transactions in the target month. Mixing
  // currencies would require live FX rates; we'd rather report honestly
  // on the dominant currency and let multi-currency users open the
  // wrap once per currency in a future iteration.
  const inMonth = transactions.filter((t) => {
    const ts = new Date(t.createdAt).getTime();
    return ts >= targetStart && ts < targetEnd && t.currency === primaryCurrency;
  });
  if (inMonth.length === 0) return null;

  const expenses = inMonth.filter((t) => t.type === 'expense');
  const incomes = inMonth.filter((t) => t.type === 'income');
  const totalSpent = sum(expenses.map((t) => t.amount));
  const totalIncome = sum(incomes.map((t) => t.amount));
  const net = totalIncome - totalSpent;

  // Top categories
  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    const k = e.category || 'Uncategorised';
    byCategory.set(k, (byCategory.get(k) ?? 0) + e.amount);
  }
  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, amount]) => ({
      category,
      amount: Math.round(amount * 100) / 100,
      share: totalSpent > 0 ? Math.round((amount / totalSpent) * 1000) / 10 : 0,
    }));

  // Biggest single expense
  const biggestExpense = expenses.length > 0
    ? expenses.reduce((max, t) => (t.amount > max.amount ? t : max), expenses[0])
    : null;

  // Day with the highest spend
  const byDay = new Map<string, number>();
  for (const e of expenses) {
    // Local calendar day, not toISOString() (UTC) — an expense logged late
    // at night in this app's UTC+4/+5 markets must bucket into the day the
    // user actually experienced it, not UTC's earlier day.
    const d = localIso(new Date(e.createdAt));
    byDay.set(d, (byDay.get(d) ?? 0) + e.amount);
  }
  const bigSpendDay = byDay.size > 0
    ? [...byDay.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([date, amount]) => ({
          date,
          amount: Math.round(amount * 100) / 100,
        }))[0]
    : null;

  // Comparison to prior month
  const prevExpenses = transactions.filter((t) => {
    const ts = new Date(t.createdAt).getTime();
    return ts >= prevStart && ts < prevEnd && t.currency === primaryCurrency && t.type === 'expense';
  });
  const prevTotal = sum(prevExpenses.map((t) => t.amount));
  const spendChangePercent = prevTotal > 0
    ? Math.round(((totalSpent - prevTotal) / prevTotal) * 1000) / 10
    : null;

  // Headline
  const headline = buildHeadline({
    monthLabel,
    totalSpent,
    primaryCurrency,
    spendChangePercent,
    net,
  });

  return {
    monthKey,
    monthLabel,
    primaryCurrency,
    txCount: inMonth.length,
    totalSpent: Math.round(totalSpent * 100) / 100,
    totalIncome: Math.round(totalIncome * 100) / 100,
    net: Math.round(net * 100) / 100,
    topCategories,
    biggestExpense,
    bigSpendDay,
    spendChangePercent,
    activeDays: byDay.size,
    headline,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function buildHeadline(args: {
  monthLabel: string;
  totalSpent: number;
  primaryCurrency: Currency;
  spendChangePercent: number | null;
  net: number;
}): string {
  if (args.spendChangePercent == null) {
    return `Your ${args.monthLabel}, summarised`;
  }
  if (args.spendChangePercent <= -10) {
    return `You spent ${Math.abs(args.spendChangePercent).toFixed(0)}% less than last month — bachat ka mausam`;
  }
  if (args.spendChangePercent >= 20) {
    return `Spending up ${args.spendChangePercent.toFixed(0)}% — let's see where it went`;
  }
  return `${args.monthLabel} ka hisaab — steady mahina`;
}

// Trigger guard: should we show the wrap this session?
// Returns the month key if yes, null if no. Records the key so we don't
// show again until next month rolls in.

const WRAP_SHOWN_KEY = 'hisaab_wrap_last_shown_v1';

export function shouldShowMonthlyWrap(stats: WrapStats | null): boolean {
  if (!stats) return false;
  if (stats.txCount < 3) return false; // Not enough data to be interesting.
  try {
    const last = localStorage.getItem(WRAP_SHOWN_KEY);
    if (last === stats.monthKey) return false;
  } catch {
    // localStorage unavailable — show anyway, no harm.
  }
  return true;
}

export function markWrapShown(monthKey: string): void {
  try {
    localStorage.setItem(WRAP_SHOWN_KEY, monthKey);
  } catch {
    // localStorage unavailable — wrap will show again. Annoying but harmless.
  }
}
