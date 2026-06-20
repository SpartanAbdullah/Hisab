// Subscriptions Tracker — Phase 1 pure helpers.
//
// A "subscription" is just a recurring EXPENSE template tagged with the
// SUBSCRIPTION_CATEGORY (see constants.ts). This module derives all the
// view data — burn totals, upcoming renewals, and "ghost"/forgotten flags —
// from the existing recurringStore templates with NO schema change. Every
// function here is pure so it can be unit-tested without a store or DB.

import type { RecurringCadence, RecurringTransaction } from '../db';
import { SUBSCRIPTION_CATEGORY } from './constants';

const MS_PER_DAY = 86_400_000;

// Average cycle length used for cadence normalisation and overdue maths.
const CYCLE_DAYS: Record<RecurringCadence, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

export function isSubscription(t: RecurringTransaction): boolean {
  return t.type === 'expense' && t.category === SUBSCRIPTION_CATEGORY;
}

// Normalise a charge to its average MONTHLY cost. Yearly cost is always
// monthly × 12, so callers derive yearly from this.
export function monthlyAmount(amount: number, cadence: RecurringCadence): number {
  switch (cadence) {
    case 'daily':
      return (amount * 365) / 12;
    case 'weekly':
      return (amount * 52) / 12;
    case 'monthly':
      return amount;
    case 'yearly':
      return amount / 12;
  }
}

function toUTC(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

// Whole days from `todayIso` to `dateIso`. Negative when dateIso is in the past.
export function daysUntil(todayIso: string, dateIso: string): number {
  return Math.round((toUTC(dateIso) - toUTC(todayIso)) / MS_PER_DAY);
}

export interface CurrencyBurn {
  currency: string;
  monthly: number;
  yearly: number;
  count: number; // active subscriptions in this currency
}

export interface SubscriptionTotals {
  byCurrency: CurrencyBurn[]; // sorted by monthly burn, largest first
  currencies: string[];
  mixed: boolean; // active subscriptions span more than one currency
  activeCount: number;
}

// Burn totals grouped by currency. We deliberately do NOT sum across
// currencies (no FX in Phase 1) — mixing AED and PKR into one number would
// be silently wrong, exactly the bug class flagged elsewhere in the audit.
// Paused subscriptions are excluded from burn (they are not charging).
export function subscriptionTotals(templates: RecurringTransaction[]): SubscriptionTotals {
  const active = templates.filter((t) => isSubscription(t) && t.active);
  const map = new Map<string, CurrencyBurn>();
  for (const t of active) {
    const monthly = monthlyAmount(t.amount, t.cadence);
    const cur = map.get(t.currency) ?? { currency: t.currency, monthly: 0, yearly: 0, count: 0 };
    cur.monthly += monthly;
    cur.yearly += monthly * 12;
    cur.count += 1;
    map.set(t.currency, cur);
  }
  const byCurrency = [...map.values()].sort((a, b) => b.monthly - a.monthly);
  const currencies = byCurrency.map((c) => c.currency);
  return {
    byCurrency,
    currencies,
    mixed: currencies.length > 1,
    activeCount: active.length,
  };
}

export interface Renewal {
  template: RecurringTransaction;
  daysUntil: number;
}

// Active subscriptions renewing within the next `withinDays` (inclusive of
// today). Overdue ones are excluded here — they surface as "skipped" ghosts.
export function upcomingRenewals(
  templates: RecurringTransaction[],
  todayIso: string,
  withinDays = 14,
): Renewal[] {
  return templates
    .filter((t) => isSubscription(t) && t.active)
    .map((t) => ({ template: t, daysUntil: daysUntil(todayIso, t.nextDueDate) }))
    .filter((r) => r.daysUntil >= 0 && r.daysUntil <= withinDays)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

export type GhostReason = 'skipped' | 'duplicate';

export interface GhostFlag {
  template: RecurringTransaction;
  reasons: GhostReason[];
}

function normalizeLabel(t: RecurringTransaction): string {
  return (t.label || t.category).trim().toLowerCase();
}

// Phase-1 ghost detection is inference-only (no engagement signal yet —
// that needs the Phase-2 `lastUsedAt` field). Two reasons:
//  - skipped:   active but overdue by more than ~1.5 cycles → the user keeps
//               dismissing the recurring-due prompt, i.e. quietly not paying
//               attention to a sub that's still "on".
//  - duplicate: two active subs share a label/merchant.
export function detectGhosts(templates: RecurringTransaction[], todayIso: string): GhostFlag[] {
  const active = templates.filter((t) => isSubscription(t) && t.active);
  const labelCounts = new Map<string, number>();
  for (const t of active) {
    const key = normalizeLabel(t);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const flags: GhostFlag[] = [];
  for (const t of active) {
    const reasons: GhostReason[] = [];
    const overdue = daysUntil(todayIso, t.nextDueDate); // negative if past due
    if (overdue < 0 && Math.abs(overdue) > CYCLE_DAYS[t.cadence] * 1.5) {
      reasons.push('skipped');
    }
    if ((labelCounts.get(normalizeLabel(t)) ?? 0) > 1) {
      reasons.push('duplicate');
    }
    if (reasons.length > 0) flags.push({ template: t, reasons });
  }
  return flags;
}

// Human-readable one-liner for a ghost flag (used by the page).
export function describeGhost(flag: GhostFlag, todayIso: string): string {
  if (flag.reasons.includes('skipped')) {
    const overdueDays = Math.abs(daysUntil(todayIso, flag.template.nextDueDate));
    const cycles = Math.floor(overdueDays / CYCLE_DAYS[flag.template.cadence]);
    if (cycles >= 1) {
      return `Overdue ${cycles} ${cycles === 1 ? 'cycle' : 'cycles'} — still using it?`;
    }
    return 'Overdue a while — still using it?';
  }
  if (flag.reasons.includes('duplicate')) return 'Looks like a duplicate';
  return 'Worth a review';
}
