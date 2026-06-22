// Inbox "Info" tab — derives non-actionable informational signals from the
// existing stores (no schema, no new tables): over-budget warnings,
// subscription renewals due soon, credit-card payment dates coming up, and
// upcoming bills inside their reminder window. Pure so it can be unit-tested
// with fixtures and reused (e.g. for a bell badge) without a store.

import type { Account, AppNotification, Budget, RecurringTransaction, Transaction, UpcomingExpense } from '../db';
import { computeBudgetUsages } from '../stores/budgetStore';
import { upcomingRenewals } from './subscriptionMetrics';
import { formatMoney } from './constants';

// Persisted notifications that belong in the Inbox "Info" tab + bell badge:
// unread, non-group, non-request informational pings (e.g. "someone added you
// via your code"). Group fan-out notifications have their own home on the
// Activity page; linked request/settlement pings are actioned on Incoming.
export function isInboxInfoNotification(n: AppNotification): boolean {
  return !n.readAt && (n.type === 'contact_linked' || n.type === 'system' || n.type === 'invite');
}

export type InfoTone = 'pay' | 'warn' | 'info' | 'accent';
export type InfoIcon = 'budget' | 'renewal' | 'card' | 'bill';

export interface InfoItem {
  id: string;
  icon: InfoIcon;
  tone: InfoTone;
  title: string;
  body: string;
  href?: string; // route to open on tap
}

export interface InfoInputs {
  budgets: Budget[];
  transactions: Transaction[];
  templates: RecurringTransaction[];
  accounts: Account[];
  upcoming: UpcomingExpense[];
  today: Date;
}

// Windows (days) before a date that we surface it as "coming up".
const CC_DUE_WINDOW_DAYS = 7;
const RENEWAL_WINDOW_DAYS = 7;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Whole days from `today` until the next occurrence of `dayOfMonth` (1..31).
// Returns 0 when it's today, rolls into next month once the day has passed,
// and clamps the target to the month's length (e.g. a 31st due-day in a
// 30-day month lands on the 30th). null for an invalid day.
export function daysUntilDayOfMonth(dayOfMonth: number, today: Date): number | null {
  if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const y = today.getFullYear();
  const m = today.getMonth();
  const todayMid = new Date(y, m, today.getDate()).getTime();
  let target = new Date(y, m, Math.min(dayOfMonth, daysInMonth(y, m))).getTime();
  if (target < todayMid) {
    target = new Date(y, m + 1, Math.min(dayOfMonth, daysInMonth(y, m + 1))).getTime();
  }
  return Math.round((target - todayMid) / 86_400_000);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}

export function buildInboxInfoItems(inp: InfoInputs): InfoItem[] {
  const items: InfoItem[] = [];
  const todayIso = inp.today.toISOString().slice(0, 10);

  // 1. Over-budget / near-limit.
  for (const u of computeBudgetUsages(inp.budgets, inp.transactions, inp.today)) {
    if (!u.overWarn) continue;
    items.push({
      id: `budget-${u.budget.id}`,
      icon: 'budget',
      tone: u.overLimit ? 'pay' : 'warn',
      title: u.overLimit ? `Over budget · ${u.budget.category}` : `Nearing budget · ${u.budget.category}`,
      body: u.overLimit
        ? `${formatMoney(u.spent, u.budget.currency)} of ${formatMoney(u.budget.monthlyAmount, u.budget.currency)} spent (${Math.round(u.percent)}%).`
        : `${Math.round(u.percent)}% of ${formatMoney(u.budget.monthlyAmount, u.budget.currency)} used this month.`,
      href: '/budgets',
    });
  }

  // 2. Subscriptions renewing soon.
  for (const r of upcomingRenewals(inp.templates, todayIso, RENEWAL_WINDOW_DAYS)) {
    items.push({
      id: `renewal-${r.template.id}`,
      icon: 'renewal',
      tone: 'info',
      title: `${r.template.label || r.template.category} renews ${r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`}`,
      body: `${formatMoney(r.template.amount, r.template.currency)} · ${r.template.category}`,
      href: '/subscriptions',
    });
  }

  // 3. Credit-card payment date coming up.
  for (const a of inp.accounts) {
    if (a.type !== 'credit_card') continue;
    const dueDay = parseInt(a.metadata?.dueDay ?? '', 10);
    const d = daysUntilDayOfMonth(dueDay, inp.today);
    if (d === null || d > CC_DUE_WINDOW_DAYS) continue;
    items.push({
      id: `cc-${a.id}`,
      icon: 'card',
      tone: d <= 2 ? 'pay' : 'warn',
      title: `${a.name} payment due ${d === 0 ? 'today' : `in ${d}d`}`,
      body: `Payment date is the ${dueDay}${ordinal(dueDay)} of the month.`,
      href: `/account/${a.id}`,
    });
  }

  // 4. Upcoming bills inside their reminder window.
  for (const e of inp.upcoming) {
    if (e.status !== 'upcoming') continue;
    const due = Math.ceil((new Date(e.dueDate).getTime() - inp.today.getTime()) / 86_400_000);
    if (due > (e.reminderDaysBefore ?? 3)) continue;
    items.push({
      id: `upcoming-${e.id}`,
      icon: 'bill',
      tone: due <= 0 ? 'pay' : 'warn',
      title: `${e.title} ${due <= 0 ? 'is due' : `due in ${due}d`}`,
      body: `${formatMoney(e.amount, e.currency)}${e.category ? ` · ${e.category}` : ''}`,
    });
  }

  return items;
}
