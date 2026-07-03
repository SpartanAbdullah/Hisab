import { describe, it, expect } from 'vitest';
import { renderWrapCardHtml } from './wrapCard';
import type { WrapStats } from './monthlyWrap';

const stats: WrapStats = {
  monthKey: '2026-06',
  monthLabel: 'June 2026',
  primaryCurrency: 'AED',
  txCount: 42,
  totalSpent: 5230.5,
  totalIncome: 9000,
  net: 3769.5,
  topCategories: [
    { category: 'Groceries', amount: 1800, share: 34.4 },
    { category: 'Transport', amount: 900, share: 17.2 },
  ],
  biggestExpense: null,
  bigSpendDay: null,
  spendChangePercent: -12,
  activeDays: 21,
  headline: 'You spent 12% less than last month — bachat ka mausam',
};

describe('renderWrapCardHtml', () => {
  it('shows proud numbers (categories, active days, change) without exact totals by default', () => {
    const html = renderWrapCardHtml(stats, { showTotals: false, connectCode: 'HSB-4F2A9' });
    expect(html).toContain('HISAAB WRAPPED');
    expect(html).toContain('June 2026');
    expect(html).toContain('Groceries');
    expect(html).toContain('34.4%');
    expect(html).toContain('21'); // active days
    expect(html).toContain('12%'); // spend change
    expect(html).toContain('HSB-4F2A9');
    // Privacy: exact spent/earned/net are hidden by default.
    expect(html).not.toContain('Spent');
    expect(html).not.toContain('5,230');
  });

  it('reveals exact Spent/Earned/Net only when opted in', () => {
    const html = renderWrapCardHtml(stats, { showTotals: true });
    expect(html).toContain('Spent');
    expect(html).toContain('5,230.50');
    expect(html).toContain('Net');
  });
});
