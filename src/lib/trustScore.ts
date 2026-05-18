// Private-to-you "trust history" with a contact. Computes a quick read of
// how the person has handled prior money interactions so the user can decide
// at-a-glance whether to lend again, lend more, or let it be. Not a credit
// score — never shared with anyone, not even the linked counterparty.
//
// Pure function over existing data (loans + transactions). No schema change.

import type { Loan, Transaction } from '../db';

export type TrustLevel = 'new' | 'building' | 'reliable' | 'rock_solid';

export interface TrustScore {
  // Counts of every prior loan with this person, both directions.
  totalLoans: number;
  settledLoans: number;
  activeLoans: number;
  // Sum of every "loan_given" repayment received in full. We don't track
  // currency-normalised totals because that would require a fresh FX rate
  // for retroactive scoring; instead, this is an "interactions" count.
  // Per-currency aggregates live on the consumer side if needed.
  settlementRatio: number; // settledLoans / totalLoans, in [0, 1]. NaN-safe → 0.
  // Average days from loan creation to its final repayment, computed only
  // over settled loans where we can find the latest related repayment txn.
  // Null when no settled loans exist.
  avgDaysToSettle: number | null;
  // Whether the contact currently owes the user or vice versa. Useful for
  // highlighting "currently 0 open" as a good sign in the badge tooltip.
  hasOpenBalance: boolean;
  level: TrustLevel;
  // One-line summary appropriate for the card subtitle. Roman-Urdu-friendly
  // English; localisation can replace at call site if needed.
  summary: string;
}

const EMPTY_SCORE: Omit<TrustScore, 'summary'> = {
  totalLoans: 0,
  settledLoans: 0,
  activeLoans: 0,
  settlementRatio: 0,
  avgDaysToSettle: null,
  hasOpenBalance: false,
  level: 'new',
};

export function computeTrustScore(
  personId: string | null | undefined,
  personName: string,
  loans: readonly Loan[],
  transactions: readonly Transaction[],
): TrustScore {
  // Personless contacts (legacy free-text loans) can't be scored — the
  // person_id wasn't backfilled, so we'd be matching against names which
  // collide. Return empty.
  if (!personId) return { ...EMPTY_SCORE, summary: `${personName} ki trust history abhi shuru hogi.` };

  const personLoans = loans.filter((l) => l.personId === personId);
  if (personLoans.length === 0) {
    return { ...EMPTY_SCORE, summary: 'No prior loans on record yet.' };
  }

  const settled = personLoans.filter((l) => l.status === 'settled');
  const active = personLoans.filter((l) => l.status === 'active');

  // Days-to-settle = latest repayment's createdAt minus loan.createdAt.
  // We deliberately ignore overpayments / corrections: the LAST repayment
  // is the moment the ledger closed, by definition.
  const daysSamples: number[] = [];
  for (const loan of settled) {
    const repayments = transactions
      .filter((t) => t.relatedLoanId === loan.id && t.type === 'repayment')
      .map((t) => new Date(t.createdAt).getTime())
      .sort((a, b) => b - a);
    if (repayments.length === 0) continue;
    const opened = new Date(loan.createdAt).getTime();
    const closed = repayments[0];
    const days = Math.max(0, Math.round((closed - opened) / (1000 * 60 * 60 * 24)));
    daysSamples.push(days);
  }
  const avgDaysToSettle =
    daysSamples.length > 0
      ? Math.round(daysSamples.reduce((a, b) => a + b, 0) / daysSamples.length)
      : null;

  const settlementRatio = personLoans.length > 0 ? settled.length / personLoans.length : 0;
  const hasOpenBalance = active.length > 0;

  // Level thresholds intentionally err on the side of giving people credit
  // quickly — building trust early is the point. Rock-solid requires
  // multiple settled loans, not just one perfect transaction.
  let level: TrustLevel;
  if (settled.length === 0) level = 'new';
  else if (settled.length < 3) level = 'building';
  else if (settlementRatio >= 0.9 && (avgDaysToSettle ?? 0) <= 30) level = 'rock_solid';
  else level = 'reliable';

  // Summary is the single line the contact card shows. Keep it warm — this
  // person might still be a close friend or family member.
  const summary = buildSummary(level, settled.length, avgDaysToSettle, active.length, personName);

  return {
    totalLoans: personLoans.length,
    settledLoans: settled.length,
    activeLoans: active.length,
    settlementRatio,
    avgDaysToSettle,
    hasOpenBalance,
    level,
    summary,
  };
}

function buildSummary(
  level: TrustLevel,
  settledCount: number,
  avgDays: number | null,
  activeCount: number,
  name: string,
): string {
  const settledPhrase =
    settledCount === 0
      ? 'no settled loans yet'
      : settledCount === 1
        ? '1 settled loan'
        : `${settledCount} settled loans`;
  const speedPhrase = avgDays != null ? ` · avg ${avgDays}d to settle` : '';
  const openPhrase = activeCount > 0 ? ` · ${activeCount} open` : '';
  switch (level) {
    case 'new':
      return `First time tracking ${name}.`;
    case 'building':
      return `${settledPhrase}${speedPhrase}${openPhrase}.`;
    case 'reliable':
      return `Reliable — ${settledPhrase}${speedPhrase}${openPhrase}.`;
    case 'rock_solid':
      return `Rock-solid — ${settledPhrase}${speedPhrase}${openPhrase}.`;
  }
}

// Tailwind classnames per level for the badge. Kept here so the UI can stay
// dumb. Pairs with the existing Sukoon tone palette.
export function trustLevelStyle(level: TrustLevel): {
  label: string;
  badgeClass: string;
  dot: string;
} {
  switch (level) {
    case 'new':
      return {
        label: 'New',
        badgeClass: 'bg-cream-soft text-ink-600 border-cream-border',
        dot: 'bg-ink-400',
      };
    case 'building':
      return {
        label: 'Building',
        badgeClass: 'bg-info-50 text-info-600 border-info-50',
        dot: 'bg-info-600',
      };
    case 'reliable':
      return {
        label: 'Reliable',
        badgeClass: 'bg-accent-50 text-accent-600 border-accent-100',
        dot: 'bg-accent-500',
      };
    case 'rock_solid':
      return {
        label: 'Rock-solid',
        badgeClass: 'bg-receive-50 text-receive-text border-receive-100',
        dot: 'bg-receive-600',
      };
  }
}
