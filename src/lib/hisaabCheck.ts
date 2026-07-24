// "Hisaab check" — the weekly 5-minute review ritual's math. Monarch's
// stickiest pattern is a bounded review ceremony with a visible
// days-since-last counter; Hisaab's version walks money-in/out, people
// deltas, the upcoming week, and ends with ONE suggested action that
// exercises the WhatsApp-reminder differentiator. Pure + tested; the
// swipe UI stays in the component.
import type { Loan, Transaction } from '../db';

export const CHECK_STAMP_KEY = 'hisaab_check_last';

export interface CheckStamp {
  dateIso: string; // YYYY-MM-DD
  receivable: number;
  payable: number;
  currency: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Real money in/out over the last 7 days, one currency. Internal moves
 *  (transfers, adjustments, goal contributions) are excluded — the ritual
 *  reads FLOW, not shuffling. Loans count by their CASH leg: lending money
 *  out is real out, borrowed cash landing in a wallet is real in — the same
 *  lifecycle whose repayments are already counted below. Ledger-only rows
 *  (no account leg — money moved outside the app, or a write-off) carry no
 *  flow. */
export function weekFlow(
  transactions: Transaction[],
  currency: string,
  today: Date,
): { moneyIn: number; moneyOut: number } {
  const cutoff = today.getTime() - 7 * DAY_MS;
  let moneyIn = 0;
  let moneyOut = 0;
  for (const txn of transactions) {
    if (txn.currency !== currency) continue;
    const at = new Date(txn.createdAt).getTime();
    if (!Number.isFinite(at) || at < cutoff || at > today.getTime() + DAY_MS) continue;
    if (txn.type === 'income') moneyIn = round2(moneyIn + txn.amount);
    else if (txn.type === 'expense') moneyOut = round2(moneyOut + txn.amount);
    else if (txn.type === 'repayment') {
      // Direction by which leg carries the user's money: destination-only =
      // received back; source set = paid out.
      if (txn.sourceAccountId) moneyOut = round2(moneyOut + txn.amount);
      else if (txn.destinationAccountId) moneyIn = round2(moneyIn + txn.amount);
    } else if (txn.type === 'loan_given') {
      if (txn.sourceAccountId) moneyOut = round2(moneyOut + txn.amount);
    } else if (txn.type === 'loan_taken') {
      if (txn.destinationAccountId) moneyIn = round2(moneyIn + txn.amount);
    }
  }
  return { moneyIn, moneyOut };
}

export function daysSince(dateIso: string | null, today: Date): number | null {
  if (!dateIso) return null;
  const then = new Date(`${dateIso}T00:00:00`).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((today.getTime() - then) / DAY_MS));
}

/** Receivable/payable deltas since the last check (null with no history). */
export function peopleDelta(
  current: { receivable: number; payable: number },
  stamp: CheckStamp | null,
  currency: string,
): { receivable: number; payable: number } | null {
  if (!stamp || stamp.currency !== currency) return null;
  return {
    receivable: round2(current.receivable - stamp.receivable),
    payable: round2(current.payable - stamp.payable),
  };
}

export interface SuggestedAction {
  loanId: string;
  personName: string;
  remaining: number;
  currency: string;
  sinceIso: string;
  daysOpen: number;
}

/** The ONE action: the person who has owed you longest (linked reminders and
 *  statements already exist one tap away on that loan's page). */
export function suggestAction(loans: Loan[], today: Date): SuggestedAction | null {
  const candidates = loans
    .filter((l) => l.status === 'active' && l.type === 'given' && l.remainingAmount > 0.005)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const oldest = candidates[0];
  if (!oldest) return null;
  const daysOpen = Math.max(
    0,
    Math.floor((today.getTime() - new Date(oldest.createdAt).getTime()) / DAY_MS),
  );
  // Only nag-worthy after a couple of weeks — a fresh loan isn't an "action".
  if (daysOpen < 14) return null;
  return {
    loanId: oldest.id,
    personName: oldest.personName,
    remaining: oldest.remainingAmount,
    currency: oldest.currency,
    sinceIso: oldest.createdAt.slice(0, 10),
    daysOpen,
  };
}
