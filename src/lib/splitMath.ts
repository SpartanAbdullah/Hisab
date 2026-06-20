// Penny-exact equal-split allocator.
//
// Mirrors the algorithm in AddGroupExpenseModal exactly: everyone pays the
// floored-to-cents base; the LAST member absorbs the rounding remainder so
// the shares always sum to the total to the cent (no money created or lost).
// Kept as a pure, tested helper so the AI quick-split path and the form behave
// identically — the audit flagged split rounding as untested, this closes it.

import type { SplitDetail } from '../db';

export function equalSplits(amount: number, memberIds: string[]): SplitDetail[] {
  const n = memberIds.length;
  if (n === 0) return [];
  const base = Math.floor((amount * 100) / n) / 100;
  const remainder = Math.round((amount - base * n) * 100) / 100;
  return memberIds.map((id, index) => ({
    memberId: id,
    amount:
      index === n - 1
        ? Math.round((base + remainder) * 100) / 100
        : base,
  }));
}

// Convenience: do the shares sum to the total (to the cent)? Used in tests and
// as a defensive check before posting.
export function splitsSumToTotal(splits: SplitDetail[], total: number): boolean {
  const sum = splits.reduce((a, s) => a + s.amount, 0);
  return Math.abs(sum - total) < 0.005;
}
