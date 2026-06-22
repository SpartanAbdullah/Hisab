// Distribute a single lump repayment across several individual loans with one
// person (same currency + direction). The net effect on balances is identical
// to one big repayment — this only changes WHICH loans clear, so a user can
// wipe out the small ones first instead of only chipping the largest. Pure so
// it can be unit-tested and reused; the UI loops the existing single-loan
// repayment for each returned allocation.

export type AllocationStrategy = 'smallest' | 'largest' | 'oldest';

export interface AllocatableLoan {
  id: string;
  remainingAmount: number;
  createdAt: string;
}

export interface Allocation {
  loanId: string;
  amount: number; // > 0, never exceeds the loan's remaining
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Greedily fill loans in the strategy's order until the lump runs out, never
// over-paying a loan. Returns only loans that receive a positive amount, in
// fill order. The sum equals min(lump, total remaining), to 2 dp.
export function allocateRepayment(
  loans: AllocatableLoan[],
  lump: number,
  strategy: AllocationStrategy,
): Allocation[] {
  const order = loans.filter((l) => l.remainingAmount > 0.001).slice();
  order.sort((a, b) => {
    if (strategy === 'smallest') return a.remainingAmount - b.remainingAmount || a.createdAt.localeCompare(b.createdAt);
    if (strategy === 'largest') return b.remainingAmount - a.remainingAmount || a.createdAt.localeCompare(b.createdAt);
    return a.createdAt.localeCompare(b.createdAt); // oldest first (FIFO)
  });

  let pool = round2(lump);
  const out: Allocation[] = [];
  for (const loan of order) {
    if (pool <= 0.001) break;
    const amount = round2(Math.min(round2(loan.remainingAmount), pool));
    if (amount <= 0) continue;
    out.push({ loanId: loan.id, amount });
    pool = round2(pool - amount);
  }
  return out;
}

// Total remaining across a set of loans (2 dp).
export function totalRemaining(loans: AllocatableLoan[]): number {
  return round2(loans.reduce((a, l) => a + Math.max(0, l.remainingAmount), 0));
}
