// Inbox "Info" tab — derives non-actionable informational signals from the
// existing stores (no schema, no new tables): over-budget warnings,
// subscription renewals due soon, credit-card payment dates coming up, and
// upcoming bills inside their reminder window. Pure so it can be unit-tested
// with fixtures and reused (e.g. for a bell badge) without a store.

import type { Account, AppNotification, Budget, Committee, CommitteePayment, EmiSchedule, Loan, RecurringTransaction, Transaction, UpcomingExpense } from '../db';
import { computeBudgetUsages } from '../stores/budgetStore';
import { upcomingRenewals, daysUntil } from './subscriptionMetrics';
import { currentRound, paymentsForRound, roundDate } from './committeeMath';
import { parseInternalNote } from './internalNotes';
import { localIso } from './thisWeek';
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
  // Local calendar, not toISOString (UTC): between midnight and dawn in this
  // app's UTC+4/+5 markets the UTC date is still yesterday.
  const todayIso = localIso(inp.today);

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

// ── Needs-action queue (the Inbox "To-do" tab) ─────────────────────────────
// Unlike Info items, every one of these clears itself the moment the user
// DOES the thing — mark the EMI paid, file the expense, post the recurring
// charge, tick the kameti round. That's what makes a red count legitimate
// here: it can always reach zero ("Sab clear hai ✓").

export type ActionResolve =
  | { kind: 'navigate'; href: string }
  | { kind: 'editTxn'; txnId: string }
  | { kind: 'recurringPrompt'; templateId: string };

// Structured, i18n-free content (the thisWeek.ts pattern): the page owns the
// words via t() keys, the lib owns the facts. Icon/tone derive from `kind`.
export type ActionContent =
  | { kind: 'emi'; person: string; count: number; total: number; currency: string; daysLate: number; direction: 'pay' | 'collect' }
  | { kind: 'recurring'; label: string; amount: number; currency: string; dueDate: string }
  | { kind: 'kameti'; name: string; round: number; incompleteRounds: number; paid: number; members: number; amount: number; currency: string }
  | { kind: 'uncategorized'; amount: number; currency: string; dateIso: string; note: string };

export interface ActionItem {
  id: string;
  content: ActionContent;
  resolve: ActionResolve;
}

export interface ActionInputs {
  loans: Loan[];
  schedules: EmiSchedule[];
  transactions: Transaction[];
  templates: RecurringTransaction[];
  committees: Committee[];
  committeePayments: CommitteePayment[];
  accounts: Account[];
  // Cash-advance loans keyed to their funding card (loan_taken txn origin).
  cardFundedLoanIds?: Map<string, string>;
  today: Date;
}

// Uncategorised expenses older than this are history, not a to-do.
const UNCATEGORIZED_WINDOW_DAYS = 30;
// Cap per visit so a long backlog queues instead of flooding the tab.
const UNCATEGORIZED_MAX = 5;

export function buildInboxActionItems(inp: ActionInputs): ActionItem[] {
  const items: ActionItem[] = [];
  const todayIso = localIso(inp.today);

  // 1. Overdue EMIs, aggregated PER LOAN — one action ("open that loan") no
  //    matter how many instalments slipped. Cash-advance EMIs whose funding
  //    card carries the due date are the card's debt, not a separate to-do
  //    (same-debt-never-twice, mirroring thisWeek.ts).
  const loanById = new Map(inp.loans.map((l) => [l.id, l]));
  const accountById = new Map(inp.accounts.map((a) => [a.id, a]));
  const overdueByLoan = new Map<string, { count: number; total: number; worstDays: number }>();
  for (const emi of inp.schedules) {
    if (emi.status === 'paid') continue;
    const loan = loanById.get(emi.loanId);
    if (!loan || loan.status !== 'active') continue;
    const fundingCardId = inp.cardFundedLoanIds?.get(loan.id);
    if (fundingCardId) {
      const card = accountById.get(fundingCardId);
      const cardDueDay = card ? parseInt(card.metadata?.dueDay ?? '', 10) : NaN;
      if (card && Number.isFinite(cardDueDay) && cardDueDay >= 1) continue;
    }
    const d = daysUntil(todayIso, emi.dueDate);
    if (d >= 0) continue;
    const entry = overdueByLoan.get(loan.id) ?? { count: 0, total: 0, worstDays: 0 };
    entry.count += 1;
    entry.total = Math.round((entry.total + emi.amount) * 100) / 100;
    entry.worstDays = Math.max(entry.worstDays, -d);
    overdueByLoan.set(loan.id, entry);
  }
  for (const [loanId, o] of overdueByLoan) {
    const loan = loanById.get(loanId)!;
    items.push({
      id: `emi-overdue-${loanId}`,
      content: {
        kind: 'emi',
        person: loan.personName,
        count: o.count,
        total: o.total,
        currency: loan.currency,
        daysLate: o.worstDays,
        direction: loan.type === 'taken' ? 'pay' : 'collect',
      },
      resolve: { kind: 'navigate', href: `/loan/${loanId}` },
    });
  }

  // 2. Recurring templates that missed their date (runner prompts on the day;
  //    a template strictly past-due means that prompt was skipped/unseen).
  for (const tpl of inp.templates) {
    if (!tpl.active || tpl.nextDueDate >= todayIso) continue;
    items.push({
      id: `recurring-overdue-${tpl.id}`,
      content: {
        kind: 'recurring',
        label: tpl.label || tpl.category,
        amount: tpl.amount,
        currency: tpl.currency,
        dueDate: tpl.nextDueDate,
      },
      resolve: { kind: 'recurringPrompt', templateId: tpl.id },
    });
  }

  // 3. Kameti rounds whose date has arrived but collection is incomplete —
  //    EVERY arrived round, not just the latest: a stuck older round must
  //    not vanish once the next one starts. One item per committee (the
  //    earliest incomplete round leads; the count carries the rest). No
  //    "me" member flag exists, so it's phrased as collection status.
  for (const c of inp.committees) {
    if (c.status !== 'active') continue;
    const paymentsOfC = inp.committeePayments.filter((p) => p.committeeId === c.id);
    const latest = currentRound(c.startDate, c.cadence, c.totalRounds, inp.today);
    const incomplete: Array<{ round: number; paid: number }> = [];
    for (let r = 1; r <= latest; r += 1) {
      if (roundDate(c.startDate, c.cadence, r).getTime() > inp.today.getTime()) continue;
      const paid = paymentsForRound(paymentsOfC, r).length;
      if (paid < c.memberCount) incomplete.push({ round: r, paid });
    }
    if (incomplete.length === 0) continue;
    const first = incomplete[0];
    items.push({
      id: `kameti-round-${c.id}-${first.round}`,
      content: {
        kind: 'kameti',
        name: c.name,
        round: first.round,
        incompleteRounds: incomplete.length,
        paid: first.paid,
        members: c.memberCount,
        amount: c.contributionAmount,
        currency: c.currency,
      },
      resolve: { kind: 'navigate', href: `/kameti/${c.id}` },
    });
  }

  // 4. Recent uncategorised expenses — newest first, capped; the rest surface
  //    as these get filed. '' is the empty category (cf. monthlyWrap).
  const cutoff = inp.today.getTime() - UNCATEGORIZED_WINDOW_DAYS * 86_400_000;
  const unfiled = inp.transactions
    .filter((t) => t.type === 'expense' && !t.category && !t.deletedAt)
    .filter((t) => {
      const at = new Date(t.createdAt).getTime();
      return Number.isFinite(at) && at >= cutoff;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const txn of unfiled.slice(0, UNCATEGORIZED_MAX)) {
    const note = parseInternalNote(txn.notes).visibleNote.trim();
    items.push({
      id: `uncategorized-${txn.id}`,
      content: {
        kind: 'uncategorized',
        amount: txn.amount,
        currency: txn.currency,
        dateIso: txn.createdAt,
        note: note.slice(0, 40),
      },
      resolve: { kind: 'editTxn', txnId: txn.id },
    });
  }

  return items;
}
