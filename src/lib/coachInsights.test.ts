import { describe, it, expect } from 'vitest';
import { buildCoachCards, type CoachInputs } from './coachInsights';

const empty: CoachInputs = {
  budgetOver: [], budgetPace: [], renewalsSoon: null, topCategory: null,
  overdueReceivableCount: 0, goalsBehind: [], daysSinceLastEntry: null,
};

describe('buildCoachCards', () => {
  it('returns nothing when there is nothing to say', () => {
    expect(buildCoachCards(empty)).toEqual([]);
  });

  it('prioritises an over-budget card above a renewal reminder', () => {
    const cards = buildCoachCards({
      ...empty,
      budgetOver: [{ category: 'Food', amount: 200, currency: 'AED' }],
      renewalsSoon: { count: 2, amount: 90, currency: 'AED' },
    });
    expect(cards[0].kind).toBe('budget_over');
    expect(cards[1].kind).toBe('renewals_soon');
  });

  it('caps the number of cards', () => {
    const cards = buildCoachCards({
      ...empty,
      budgetOver: [{ category: 'A', amount: 1, currency: 'AED' }, { category: 'B', amount: 1, currency: 'AED' }],
      overdueReceivableCount: 3,
      budgetPace: [{ category: 'C', pct: 90, daysLeft: 8 }],
      renewalsSoon: { count: 1, amount: 10, currency: 'AED' },
    }, 3);
    expect(cards).toHaveLength(3);
    // Highest-priority first: the two over-budget, then overdue.
    expect(cards.map((c) => c.kind)).toEqual(['budget_over', 'budget_over', 'overdue_receivable']);
  });

  it('only surfaces a top-category card when it recurs (>=3)', () => {
    const twice = buildCoachCards({ ...empty, topCategory: { category: 'Food', count: 2, amount: 50, currency: 'AED' } });
    expect(twice.some((c) => c.kind === 'top_category')).toBe(false);
    const thrice = buildCoachCards({ ...empty, topCategory: { category: 'Food', count: 3, amount: 80, currency: 'AED' } });
    expect(thrice.some((c) => c.kind === 'top_category')).toBe(true);
  });

  it('treats the log nudge as a low-priority filler behind money signals', () => {
    const cards = buildCoachCards({
      ...empty,
      daysSinceLastEntry: 9,
      overdueReceivableCount: 1,
    });
    expect(cards[0].kind).toBe('overdue_receivable');
    expect(cards[cards.length - 1].kind).toBe('log_nudge');
  });

  it('does not nudge before a real gap (<4 days)', () => {
    expect(buildCoachCards({ ...empty, daysSinceLastEntry: 2 })).toEqual([]);
  });
});
