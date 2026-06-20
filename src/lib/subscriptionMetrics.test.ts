import { describe, expect, it } from 'vitest';
import type { RecurringTransaction } from '../db';
import {
  isSubscription,
  monthlyAmount,
  daysUntil,
  subscriptionTotals,
  upcomingRenewals,
  detectGhosts,
  describeGhost,
} from './subscriptionMetrics';

let idCounter = 0;
function sub(over: Partial<RecurringTransaction> = {}): RecurringTransaction {
  idCounter += 1;
  return {
    id: `t${idCounter}`,
    type: 'expense',
    amount: 50,
    currency: 'AED',
    sourceAccountId: 'acc1',
    destinationAccountId: null,
    category: 'Subscriptions',
    notes: '',
    cadence: 'monthly',
    nextDueDate: '2026-07-01',
    active: true,
    label: 'Netflix',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('isSubscription', () => {
  it('matches expense templates in the Subscriptions category', () => {
    expect(isSubscription(sub())).toBe(true);
  });
  it('rejects non-subscription categories', () => {
    expect(isSubscription(sub({ category: 'Rent' }))).toBe(false);
  });
  it('rejects income even if tagged Subscriptions', () => {
    expect(isSubscription(sub({ type: 'income' }))).toBe(false);
  });
});

describe('monthlyAmount', () => {
  it('passes monthly through unchanged', () => {
    expect(monthlyAmount(56, 'monthly')).toBe(56);
  });
  it('spreads yearly across 12 months', () => {
    expect(monthlyAmount(120, 'yearly')).toBeCloseTo(10, 5);
  });
  it('normalises weekly to ~52/12 per month', () => {
    expect(monthlyAmount(12, 'weekly')).toBeCloseTo((12 * 52) / 12, 5);
  });
  it('normalises daily to ~365/12 per month', () => {
    expect(monthlyAmount(1, 'daily')).toBeCloseTo(365 / 12, 5);
  });
});

describe('daysUntil', () => {
  it('counts whole days forward', () => {
    expect(daysUntil('2026-06-19', '2026-06-22')).toBe(3);
  });
  it('is negative for past dates', () => {
    expect(daysUntil('2026-06-19', '2026-06-10')).toBe(-9);
  });
  it('is timezone-independent across a month boundary', () => {
    expect(daysUntil('2026-01-31', '2026-02-01')).toBe(1);
  });
});

describe('subscriptionTotals', () => {
  it('sums active subscriptions in a single currency', () => {
    const t = subscriptionTotals([
      sub({ amount: 56, cadence: 'monthly' }),
      sub({ amount: 120, cadence: 'yearly' }), // → 10/mo
    ]);
    expect(t.mixed).toBe(false);
    expect(t.activeCount).toBe(2);
    expect(t.byCurrency).toHaveLength(1);
    expect(t.byCurrency[0].monthly).toBeCloseTo(66, 5);
    expect(t.byCurrency[0].yearly).toBeCloseTo(792, 5);
  });

  it('excludes paused subscriptions from burn', () => {
    const t = subscriptionTotals([
      sub({ amount: 56 }),
      sub({ amount: 999, active: false }),
    ]);
    expect(t.activeCount).toBe(1);
    expect(t.byCurrency[0].monthly).toBeCloseTo(56, 5);
  });

  it('excludes non-subscription recurring templates', () => {
    const t = subscriptionTotals([
      sub({ amount: 56 }),
      sub({ amount: 5000, category: 'Rent' }),
      sub({ amount: 9000, type: 'income', category: 'Subscriptions' }),
    ]);
    expect(t.activeCount).toBe(1);
    expect(t.byCurrency[0].monthly).toBeCloseTo(56, 5);
  });

  it('groups by currency without summing across them, largest first', () => {
    const t = subscriptionTotals([
      sub({ amount: 10, currency: 'AED' }),
      sub({ amount: 3000, currency: 'PKR' }),
    ]);
    expect(t.mixed).toBe(true);
    expect(t.currencies).toEqual(['PKR', 'AED']);
    expect(t.byCurrency[0].currency).toBe('PKR');
    expect(t.byCurrency[0].monthly).toBeCloseTo(3000, 5);
    expect(t.byCurrency[1].monthly).toBeCloseTo(10, 5);
  });

  it('returns empty totals when there are no subscriptions', () => {
    const t = subscriptionTotals([sub({ category: 'Groceries' })]);
    expect(t.activeCount).toBe(0);
    expect(t.byCurrency).toHaveLength(0);
    expect(t.mixed).toBe(false);
  });
});

describe('upcomingRenewals', () => {
  const today = '2026-06-19';
  it('includes active subs due within the window, soonest first', () => {
    const r = upcomingRenewals(
      [
        sub({ label: 'B', nextDueDate: '2026-06-25' }),
        sub({ label: 'A', nextDueDate: '2026-06-20' }),
      ],
      today,
    );
    expect(r.map((x) => x.template.label)).toEqual(['A', 'B']);
    expect(r[0].daysUntil).toBe(1);
  });

  it('excludes subs renewing beyond the window', () => {
    const r = upcomingRenewals([sub({ nextDueDate: '2026-07-30' })], today, 14);
    expect(r).toHaveLength(0);
  });

  it('excludes overdue and paused subs', () => {
    const r = upcomingRenewals(
      [
        sub({ label: 'overdue', nextDueDate: '2026-06-01' }),
        sub({ label: 'paused', nextDueDate: '2026-06-20', active: false }),
      ],
      today,
    );
    expect(r).toHaveLength(0);
  });
});

describe('detectGhosts', () => {
  const today = '2026-06-19';

  it('flags an active sub overdue by more than ~1.5 cycles as skipped', () => {
    // monthly cycle = 30d; 1.5 cycles = 45d. Due 2026-04-01 is ~79 days overdue.
    const t = sub({ label: 'Gym', nextDueDate: '2026-04-01' });
    const ghosts = detectGhosts([t], today);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].reasons).toContain('skipped');
    expect(describeGhost(ghosts[0], today)).toMatch(/cycles/);
  });

  it('does not flag a sub that is only slightly overdue', () => {
    // ~19 days overdue < 45d threshold for monthly.
    const t = sub({ nextDueDate: '2026-05-31' });
    expect(detectGhosts([t], today)).toHaveLength(0);
  });

  it('does not flag an upcoming sub', () => {
    expect(detectGhosts([sub({ nextDueDate: '2026-06-25' })], today)).toHaveLength(0);
  });

  it('flags duplicate active subs sharing a label', () => {
    const ghosts = detectGhosts(
      [
        sub({ label: 'Spotify', nextDueDate: '2026-06-25' }),
        sub({ label: 'spotify ', nextDueDate: '2026-06-26' }),
      ],
      today,
    );
    expect(ghosts).toHaveLength(2);
    expect(ghosts[0].reasons).toContain('duplicate');
  });

  it('ignores paused subs for ghost detection', () => {
    const t = sub({ nextDueDate: '2026-01-01', active: false });
    expect(detectGhosts([t], today)).toHaveLength(0);
  });
});
