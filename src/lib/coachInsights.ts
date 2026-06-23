// Proactive "coach" cards — deterministic, rules-based insights surfaced on the
// home screen (no LLM). The benchmark found Cleo's stickiness comes almost
// entirely from a proactive, characterful voice; this brings that to Hisaab
// with on-device templates over data the app already has.
//
// The engine is PURE: it takes pre-computed simple inputs and returns a
// prioritised, capped list of cards as STRUCTURED data (kind + params). The
// rendering layer maps each kind to localized, formatted copy — so this file
// stays free of i18n and money formatting and is trivially testable.

export type CoachKind =
  | 'budget_over'
  | 'overdue_receivable'
  | 'budget_pace'
  | 'renewals_soon'
  | 'goal_behind'
  | 'top_category'
  | 'log_nudge';

export type CoachTone = 'pay' | 'warn' | 'receive' | 'accent' | 'info';

export interface CoachCard {
  id: string;
  kind: CoachKind;
  tone: CoachTone;
  params: Record<string, string | number>;
  href: string;
  priority: number;
}

export interface CoachInputs {
  // Budgets that have blown past their cap, and ones pacing ahead of an even
  // monthly burn (pct used vs days left).
  budgetOver: { category: string; amount: number; currency: string }[];
  budgetPace: { category: string; pct: number; daysLeft: number }[];
  // Subscriptions/recurring renewing within the next few days.
  renewalsSoon: { count: number; amount: number; currency: string } | null;
  // The biggest spending category this month (by total).
  topCategory: { category: string; count: number; amount: number; currency: string } | null;
  // Distinct people who owe the user money on overdue loans.
  overdueReceivableCount: number;
  // Goals tracking behind their target date.
  goalsBehind: { title: string; amount: number; currency: string }[];
  // Days since the last logged transaction (null if none ever).
  daysSinceLastEntry: number | null;
}

// Build the prioritised card list. Higher priority surfaces first; we cap so
// the home screen stays calm (the "Sukoon" bar).
export function buildCoachCards(inputs: CoachInputs, limit = 3): CoachCard[] {
  const cards: CoachCard[] = [];

  for (const b of inputs.budgetOver) {
    cards.push({
      id: `budget_over:${b.category}`, kind: 'budget_over', tone: 'pay',
      params: { category: b.category, amount: b.amount, currency: b.currency }, href: '/budgets', priority: 95,
    });
  }

  if (inputs.overdueReceivableCount > 0) {
    cards.push({
      id: 'overdue_receivable', kind: 'overdue_receivable', tone: 'warn',
      params: { count: inputs.overdueReceivableCount }, href: '/loans?tab=receivables', priority: 85,
    });
  }

  for (const b of inputs.budgetPace) {
    cards.push({
      id: `budget_pace:${b.category}`, kind: 'budget_pace', tone: 'warn',
      params: { category: b.category, pct: b.pct, daysLeft: b.daysLeft }, href: '/budgets', priority: 70,
    });
  }

  for (const g of inputs.goalsBehind) {
    cards.push({
      id: `goal_behind:${g.title}`, kind: 'goal_behind', tone: 'accent',
      params: { title: g.title, amount: g.amount, currency: g.currency }, href: '/goals', priority: 60,
    });
  }

  if (inputs.renewalsSoon && inputs.renewalsSoon.count > 0) {
    cards.push({
      id: 'renewals_soon', kind: 'renewals_soon', tone: 'info',
      params: { count: inputs.renewalsSoon.count, amount: inputs.renewalsSoon.amount, currency: inputs.renewalsSoon.currency },
      href: '/subscriptions', priority: 50,
    });
  }

  if (inputs.topCategory && inputs.topCategory.count >= 3) {
    cards.push({
      id: 'top_category', kind: 'top_category', tone: 'accent',
      params: { category: inputs.topCategory.category, count: inputs.topCategory.count, amount: inputs.topCategory.amount, currency: inputs.topCategory.currency },
      href: '/analytics', priority: 40,
    });
  }

  // Gentle re-engagement only after a real gap, and only as a low-priority
  // filler (never crowds out a money signal).
  if (inputs.daysSinceLastEntry != null && inputs.daysSinceLastEntry >= 4) {
    cards.push({
      id: 'log_nudge', kind: 'log_nudge', tone: 'accent',
      params: { days: inputs.daysSinceLastEntry }, href: '/transactions', priority: 20,
    });
  }

  return cards.sort((a, b) => b.priority - a.priority).slice(0, limit);
}
