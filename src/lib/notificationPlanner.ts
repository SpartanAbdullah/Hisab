// The reminder BRAIN: derives every scheduled notification from live state,
// so the schedule can never disagree with reality — a paid card bill simply
// produces no plan entries the next time we reschedule. Pure and tested; the
// Capacitor bridge lives in notificationScheduler.ts.
//
// Behavior contract (the anti-anxiety ladder):
//  - Only things that are ACTUALLY outstanding get reminders. Card bills
//    check owed > 0; EMIs check unpaid + active loan (card-funded ones are
//    the card's debt — suppressed when the card carries a due day, same as
//    thisWeek/inboxInfo); bills check status === 'upcoming'.
//  - Escalation by proximity: a gentle heads-up days ahead, firmer the day
//    before, assertive on the day — never after (overdue nagging lives in
//    the in-app To-do queue, not the lock screen).
//  - A daily cap keeps Hisaab from feeling like a collections agency.
import { daysUntilDayOfMonth } from './inboxInfo';
import { daysUntil } from './subscriptionMetrics';
import { paymentsForRound, roundDate } from './committeeMath';
import { localIso } from './thisWeek';
import { formatMoney } from './constants';
import { tStatic } from './i18n';
import type {
  Account,
  Committee,
  CommitteePayment,
  EmiSchedule,
  Loan,
  RecurringTransaction,
  UpcomingExpense,
} from '../db';

export interface PlannedNotification {
  /** Stable int32 id derived from `key` — reschedules overwrite cleanly. */
  id: number;
  key: string;
  title: string;
  body: string;
  /** Epoch ms of the fire time (REMIND_HOUR local on the target day). */
  atMs: number;
  /** Route to open when the user taps the notification. */
  href: string;
  priority: number;
}

export interface PlanInputs {
  accounts: Account[];
  loans: Loan[];
  schedules: EmiSchedule[];
  templates: RecurringTransaction[];
  upcoming: UpcomingExpense[];
  committees: Committee[];
  committeePayments: CommitteePayment[];
  cardFundedLoanIds?: Map<string, string>;
  now: Date;
}

// 10:00 local — late enough to be awake, early enough to act the same day.
const REMIND_HOUR = 10;
const HORIZON_DAYS = 10;
const MAX_PER_DAY = 3;
const MAX_TOTAL = 24;

// FNV-1a 32-bit — stable across sessions so cancel/reschedule replaces
// rather than duplicates. Kept positive and below int32 max for Android.
export function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483646 + 1;
}

function fireTime(now: Date, daysFromToday: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, REMIND_HOUR, 0, 0).getTime();
}

export function planNotifications(inp: PlanInputs): PlannedNotification[] {
  const todayIso = localIso(inp.now);
  const nowMs = inp.now.getTime();
  const out: PlannedNotification[] = [];
  const push = (p: Omit<PlannedNotification, 'id'>) => {
    // Never schedule into the past — today's already-passed slots belong to
    // the in-app surfaces, not a notification that fires the moment the
    // schedule lands.
    if (p.atMs <= nowMs + 60_000) return;
    out.push({ ...p, id: notificationId(p.key) });
  };

  // 1. Card bills — ONLY while something is owed. T-3 / T-1 / T-0.
  const accountById = new Map(inp.accounts.map((a) => [a.id, a]));
  for (const a of inp.accounts) {
    if (a.type !== 'credit_card') continue;
    const dueDay = parseInt(a.metadata?.dueDay ?? '', 10);
    const d = daysUntilDayOfMonth(dueDay, inp.now);
    if (d === null || d > HORIZON_DAYS) continue;
    const limit = parseFloat(a.metadata.creditLimit || '0');
    const owed = limit > 0 ? Math.round((limit - a.balance) * 100) / 100 : null;
    if (owed !== null && owed <= 0.005) continue; // paid → silence, by construction
    const amount = owed !== null ? formatMoney(owed, a.currency) : '';
    const steps: Array<[number, string, number]> = [
      [3, tStatic('notif_bill_in').replace('{d}', '3'), 50],
      [1, tStatic('notif_bill_tomorrow'), 80],
      [0, tStatic('notif_bill_today'), 100],
    ];
    for (const [offset, template, priority] of steps) {
      if (d < offset) continue;
      push({
        // Step-based suffix: stable for the same event across replans on
        // different days (a days-from-now suffix would churn ids daily).
        key: `card:${a.id}:t${offset}`,
        title: a.name,
        // No-limit cards have no knowable amount — drop the separator too,
        // never ship "Bill due today —" with a dangling dash.
        body: amount
          ? template.replace('{amount}', amount)
          : template.replace(/\s*—\s*\{amount\}/u, '').trim(),
        atMs: fireTime(inp.now, d - offset),
        href: `/account/${a.id}`,
        priority,
      });
    }
  }

  // 2. EMI instalments on active loans — unpaid only, card-funded suppressed
  //    when the funding card has its own due day (same-debt-never-twice).
  const loanById = new Map(inp.loans.map((l) => [l.id, l]));
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
    if (d < 0 || d > HORIZON_DAYS) continue;
    const amount = formatMoney(emi.amount, loan.currency);
    const steps: Array<[number, string, number]> = [
      [1, tStatic('notif_emi_tomorrow'), 70],
      [0, tStatic('notif_emi_today'), 90],
    ];
    for (const [offset, template, priority] of steps) {
      if (d < offset) continue;
      push({
        key: `emi:${emi.id}:t${offset}`,
        title: loan.personName,
        body: template.replace('{n}', String(emi.installmentNumber)).replace('{amount}', amount),
        atMs: fireTime(inp.now, d - offset),
        href: `/loan/${emi.loanId}`,
        priority,
      });
    }
  }

  // 3. Recurring charges — day-of only (the in-app prompt does the posting;
  //    the notification just brings the user to it). Income templates are
  //    not obligations; skip them.
  for (const tpl of inp.templates) {
    if (!tpl.active || tpl.type === 'income') continue;
    const d = daysUntil(todayIso, tpl.nextDueDate);
    if (d < 0 || d > HORIZON_DAYS) continue;
    push({
      key: `recurring:${tpl.id}:${tpl.nextDueDate}`,
      title: tpl.label || tpl.category,
      body: tStatic('notif_recurring_today').replace('{amount}', formatMoney(tpl.amount, tpl.currency)),
      atMs: fireTime(inp.now, d),
      href: '/subscriptions',
      priority: 60,
    });
  }

  // 4. One-off upcoming bills — their own reminder window + day-of.
  for (const e of inp.upcoming) {
    if (e.status !== 'upcoming') continue;
    const d = daysUntil(todayIso, e.dueDate.slice(0, 10));
    if (d < 0 || d > HORIZON_DAYS) continue;
    const lead = Math.max(1, e.reminderDaysBefore ?? 3);
    const amount = formatMoney(e.amount, e.currency);
    // Distinct key suffixes: when d === lead the lead reminder and the
    // day-of reminder are different notifications on different days.
    if (d > lead) {
      push({
        key: `bill:${e.id}:lead`,
        title: e.title,
        // lead === 1 reads as "tomorrow", not "in 1 days".
        body: (lead === 1
          ? tStatic('notif_bill_tomorrow')
          : tStatic('notif_bill_in').replace('{d}', String(lead))
        ).replace('{amount}', amount),
        atMs: fireTime(inp.now, d - lead),
        href: '/',
        priority: 55,
      });
    }
    push({
      key: `bill:${e.id}:t0`,
      title: e.title,
      body: tStatic('notif_bill_today').replace('{amount}', amount),
      atMs: fireTime(inp.now, d),
      href: '/',
      priority: 75,
    });
  }

  // 5. Kameti rounds — day-of, collection framing (no "me" member flag).
  //    A round already fully collected is DONE: it must not ring (same
  //    outstanding-ness gate every other category has).
  for (const c of inp.committees) {
    if (c.status !== 'active') continue;
    const paymentsOfC = inp.committeePayments.filter((p) => p.committeeId === c.id);
    for (let r = 1; r <= c.totalRounds; r += 1) {
      const d = daysUntil(todayIso, localIso(roundDate(c.startDate, c.cadence, r)));
      if (d < 0 || d > HORIZON_DAYS) continue;
      if (paymentsForRound(paymentsOfC, r).length >= c.memberCount) continue;
      push({
        key: `kameti:${c.id}:${r}`,
        title: c.name,
        body: tStatic('notif_kameti_round')
          .replace('{r}', String(r))
          .replace('{amount}', formatMoney(c.contributionAmount, c.currency)),
        atMs: fireTime(inp.now, d),
        href: `/kameti/${c.id}`,
        priority: 45,
      });
    }
  }

  // Daily cap: the most important few win; the rest stay in-app. Then a
  // global cap to stay well inside Android's pending-alarm budget.
  const byDay = new Map<string, PlannedNotification[]>();
  for (const p of out) {
    const day = localIso(new Date(p.atMs));
    const list = byDay.get(day) ?? [];
    list.push(p);
    byDay.set(day, list);
  }
  const capped: PlannedNotification[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => b.priority - a.priority);
    capped.push(...list.slice(0, MAX_PER_DAY));
  }
  return capped
    .sort((a, b) => a.atMs - b.atMs || b.priority - a.priority)
    .slice(0, MAX_TOTAL);
}
