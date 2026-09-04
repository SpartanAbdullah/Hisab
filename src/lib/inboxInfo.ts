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
import { buildPayeeProfiles, matchPayee } from './payeeMemory';
import { localIso } from './thisWeek';
import { formatMoney } from './constants';
import { isRequestMirrorNotification } from './notificationCounts';
import { tStatic } from './i18n';

// Persisted notifications that belong in the Inbox "Info" tab + bell badge:
// every unread row EXCEPT the linked request/settlement pings, which are
// actioned on the Incoming tab and counted from the request rows themselves
// (see isRequestMirrorNotification).
//
// This was an allow-list of four types — `contact_linked | system | invite |
// kameti` — until 2026-09-03. Two of those four are written by nothing in the
// product (audit 08-notifications.md §1.1), so in practice the tab and the
// bell badge showed contact pings only, and `group_update` — the highest
// volume notification in the app — was invisible on both: the founder's bell
// went dark with hundreds of unread rows in the table. Group rows have a real
// home here now; `notificationHref` already deep-links each one to its group,
// and tapping marks it read, so the count clears.
export function isInboxInfoNotification(n: AppNotification): boolean {
  return !n.readAt && !isRequestMirrorNotification(n);
}

export type InfoTone = 'pay' | 'warn' | 'info' | 'accent' | 'receive';
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

// Backward sibling of daysUntilDayOfMonth: the most recent occurrence of
// `dayOfMonth` on-or-before `today` (local calendar, clamped to month
// length). This is the statement-cycle start for a card that only has a
// due day configured. null for an invalid day.
export function lastDayOfMonthOccurrence(dayOfMonth: number, today: Date): Date | null {
  if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const y = today.getFullYear();
  const m = today.getMonth();
  const todayMid = new Date(y, m, today.getDate()).getTime();
  let target = new Date(y, m, Math.min(dayOfMonth, daysInMonth(y, m)));
  if (target.getTime() > todayMid) {
    target = new Date(y, m - 1, Math.min(dayOfMonth, daysInMonth(y, m - 1)));
  }
  return target;
}

/** Real money that LANDED on this card in the run-up to its UPCOMING due
 *  day (last 14 days before it): bill-payment transfers and cash-advance
 *  repayment credits. Window is anchored to the NEXT due day, not the last
 *  one, so (a) a payment made 3 days late for LAST cycle never earns
 *  "cleared early" praise weeks later, and (b) on the due day itself an
 *  early payment still counts (a last-occurrence anchor collapses to
 *  today-midnight on d=0 and drops it). Balance ADJUSTMENTS deliberately
 *  don't count — "Correct balance" is bookkeeping repair, not a payment,
 *  and praising it would congratulate drift-fixing as bill-paying.
 *  Ledger-only settlement rows carry no account legs → naturally excluded. */
export function cardPaymentThisCycle(
  card: Account,
  transactions: Transaction[],
  today: Date,
): number {
  const dueDay = parseInt(card.metadata?.dueDay ?? '', 10);
  const d = daysUntilDayOfMonth(dueDay, today);
  if (d === null) return 0;
  // When a distinct statement-close day is known, the honest window is
  // "since the statement closed" (payments toward THIS bill). Otherwise a
  // single-date card uses the tested 14-days-before-the-upcoming-due window
  // (which also dodges the due-day collapse).
  const rawStmt = parseInt(card.metadata?.statementDay ?? '', 10);
  const hasDistinctStatement =
    Number.isFinite(rawStmt) && rawStmt >= 1 && rawStmt <= 31 && rawStmt !== dueDay;
  const fourteenBeforeDue = new Date(
    today.getFullYear(), today.getMonth(), today.getDate() + d - 14,
  ).getTime();
  const closeDate = hasDistinctStatement ? lastDayOfMonthOccurrence(rawStmt, today) : null;
  const startMs = closeDate ? closeDate.getTime() : fourteenBeforeDue;
  let paid = 0;
  for (const t of transactions) {
    if (t.deletedAt) continue;
    if (t.destinationAccountId !== card.id) continue;
    if (t.type !== 'transfer' && t.type !== 'repayment') continue;
    const at = new Date(t.createdAt).getTime();
    if (!Number.isFinite(at) || at < startMs) continue;
    paid = Math.round((paid + t.amount) * 100) / 100;
  }
  return paid;
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

  // 3. Credit-card payment date coming up — STATE-AWARE. A reminder that
  // keeps firing after the bill is paid is noise that teaches users to
  // ignore the inbox; a cleared bill flips to quiet praise instead.
  for (const a of inp.accounts) {
    if (a.type !== 'credit_card') continue;
    const dueDay = parseInt(a.metadata?.dueDay ?? '', 10);
    const d = daysUntilDayOfMonth(dueDay, inp.today);
    if (d === null || d > CC_DUE_WINDOW_DAYS) continue;
    const limit = parseFloat(a.metadata.creditLimit || '0');
    const owed = limit > 0 ? Math.round((limit - a.balance) * 100) / 100 : null;
    if (owed !== null && owed <= 0.005) {
      // Nothing owed. Praise only when a payment actually landed this
      // cycle — a card that was never used stays silent.
      if (cardPaymentThisCycle(a, inp.transactions, inp.today) > 0.005) {
        items.push({
          id: `cc-cleared-${a.id}`,
          icon: 'card',
          tone: 'receive',
          // tStatic: this is a NEW surface — bilingual like its This-week
          // sibling (tw_cleared), unlike the legacy English Info items.
          title: (d === 0
            ? tStatic('info_cc_cleared_ontime')
            : tStatic('info_cc_cleared_early').replace('{d}', String(d))
          ).replace('{name}', a.name),
          body: tStatic('info_cc_cleared_body'),
          href: `/account/${a.id}`,
        });
      }
      continue;
    }
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
  | { kind: 'uncategorized'; amount: number; currency: string; dateIso: string; note: string; suggestedCategory?: string };

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
  /** Live expense-category names (built-ins + customs). When provided, a
   *  payee-history suggestion pointing at a DELETED category is dropped —
   *  one tap must never file a new row under a name no picker offers. */
  expenseCategories?: string[];
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
  // The user's own history knows where this payee usually files — offer it
  // as a one-tap suggestion instead of making every card a full edit trip.
  const payeeProfiles = unfiled.length > 0 ? buildPayeeProfiles(inp.transactions) : null;
  const liveCategories = inp.expenseCategories
    ? new Set(inp.expenseCategories.map((c) => c.trim().toLowerCase()))
    : null;
  for (const txn of unfiled.slice(0, UNCATEGORIZED_MAX)) {
    const note = parseInternalNote(txn.notes).visibleNote.trim();
    // Match on the FULL note (the display copy below is truncated).
    let profile = payeeProfiles ? matchPayee(payeeProfiles, note) : null;
    if (profile && liveCategories && !liveCategories.has(profile.category.trim().toLowerCase())) {
      profile = null; // history points at a deleted category
    }
    items.push({
      id: `uncategorized-${txn.id}`,
      content: {
        kind: 'uncategorized',
        amount: txn.amount,
        currency: txn.currency,
        dateIso: txn.createdAt,
        note: note.slice(0, 40),
        ...(profile?.category ? { suggestedCategory: profile.category } : {}),
      },
      resolve: { kind: 'editTxn', txnId: txn.id },
    });
  }

  return items;
}
