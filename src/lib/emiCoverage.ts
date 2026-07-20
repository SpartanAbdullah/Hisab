// Reconcile a loan's binary EMI schedule against how much of the loan has
// actually been paid down.
//
// EmiSchedule.status is binary (upcoming | paid | late) with no per-instalment
// "partial" amount, so an instalment can only be marked covered when the
// cumulative amount of it AND every earlier instalment fits inside the
// paid-down total. Walking oldest-first (by installmentNumber) mirrors how the
// loan-detail screen picks the "next" instalment, and stopping at the first
// instalment the paid amount can't fully cover keeps the schedule honest: a
// partial payment never marks an instalment it didn't fully cover.

export interface CoverableInstallment {
  id: string;
  installmentNumber: number;
  amount: number;
  status: 'upcoming' | 'paid' | 'late';
}

// Matches the epsilon used for the loan settlement check in transactionStore.
const COVERAGE_EPSILON = 0.00001;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Ids of instalments fully covered by `paidAmount` (in loan currency) that are
// NOT yet marked paid — oldest-first, stopping at the first instalment the
// paid amount can't fully cover. Already-paid instalments still count toward
// the running total (so a gap doesn't block later ones) but are never
// returned. A full payoff covers every instalment, so this subsumes the old
// "mark all on full settlement" behaviour.
export function uncoveredToPaidIds(
  installments: CoverableInstallment[],
  paidAmount: number,
): string[] {
  const covered = round2(paidAmount);
  if (covered <= 0) return [];
  const sorted = installments.slice().sort((a, b) => a.installmentNumber - b.installmentNumber);
  let cumulative = 0;
  const ids: string[] = [];
  for (const instalment of sorted) {
    cumulative = round2(cumulative + instalment.amount);
    if (cumulative <= covered + COVERAGE_EPSILON) {
      if (instalment.status !== 'paid') ids.push(instalment.id);
    } else {
      break;
    }
  }
  return ids;
}

export interface EmiStatusSync {
  /** Unpaid instalments now fully covered by the paid-down amount. */
  toPaid: string[];
  /** Paid instalments NO LONGER covered (a repayment was deleted) — revert to upcoming. */
  toUpcoming: string[];
}

// Full two-way reconcile of a binary schedule against the loan's paid-down
// amount. uncoveredToPaidIds only ever marks forward; deleting a repayment
// shrinks the paid-down amount, and instalments past the new coverage must
// un-mark or the schedule lies ("paid" rows the money no longer backs). Same
// oldest-first cumulative walk: an instalment is covered iff its full
// cumulative prefix fits inside paidAmount.
export function statusSyncToPaid(
  installments: CoverableInstallment[],
  paidAmount: number,
): EmiStatusSync {
  const covered = round2(Math.max(0, paidAmount));
  const sorted = installments.slice().sort((a, b) => a.installmentNumber - b.installmentNumber);
  let cumulative = 0;
  const toPaid: string[] = [];
  const toUpcoming: string[] = [];
  for (const instalment of sorted) {
    cumulative = round2(cumulative + instalment.amount);
    const isCovered = cumulative <= covered + COVERAGE_EPSILON;
    if (isCovered && instalment.status !== 'paid') toPaid.push(instalment.id);
    if (!isCovered && instalment.status === 'paid') toUpcoming.push(instalment.id);
  }
  return { toPaid, toUpcoming };
}
