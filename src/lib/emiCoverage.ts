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
