// Penny-exact split allocators.
//
// The invariant across every method: the shares always sum to the total to the
// cent — no money created or lost. The LAST participant absorbs the rounding
// remainder. Kept as pure, tested helpers so every split surface (the group
// expense form, the AI quick-split path, ad-hoc splits) behaves identically —
// the audit flagged split rounding as untested, this closes it.

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

export type ShareMethod = 'equal' | 'exact' | 'percentage' | 'shares';

// Error CODES, not messages — this module is UI- and language-agnostic. Callers
// map them onto their own i18n keys.
export type ShareErrorCode =
  | 'no_participants'
  | 'exact_mismatch'
  | 'percentage_mismatch'
  | 'shares_zero';

export interface ComputeSharesInput {
  amount: number;
  participantIds: string[];
  method: ShareMethod;
  /** Raw form values keyed by participant id; parsed leniently ('' → 0). */
  exact?: Record<string, string>;
  percentages?: Record<string, string>;
  shares?: Record<string, string>;
}

export interface ComputeSharesResult {
  valid: boolean;
  splits: SplitDetail[];
  error?: ShareErrorCode;
}

function num(raw: string | undefined, fallback = 0): number {
  const parsed = parseFloat(raw ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Distribute `amount` in the given proportions, then hand the last participant
// whatever cent-level remainder is left so the shares reconcile exactly.
// Percentage and share splits used to round each slice independently, which
// left a stray cent on totals like 3 × 33.33% — the money had to land
// somewhere, and silently vanishing is not an option in a ledger.
function proportionalSplits(
  amount: number,
  participantIds: string[],
  weights: number[],
  totalWeight: number,
): SplitDetail[] {
  const splits = participantIds.map((id, index) => ({
    memberId: id,
    amount: round2((weights[index] / totalWeight) * amount),
  }));
  const allocated = round2(splits.reduce((sum, s) => sum + s.amount, 0));
  const remainder = round2(amount - allocated);
  if (remainder !== 0 && splits.length > 0) {
    const last = splits[splits.length - 1];
    last.amount = round2(last.amount + remainder);
  }
  return splits;
}

export function computeShares(input: ComputeSharesInput): ComputeSharesResult {
  const { amount, participantIds, method } = input;

  if (participantIds.length === 0) {
    return { valid: false, splits: [], error: 'no_participants' };
  }

  if (method === 'equal') {
    return { valid: true, splits: equalSplits(amount, participantIds) };
  }

  if (method === 'exact') {
    const splits = participantIds.map((id) => ({
      memberId: id,
      amount: num(input.exact?.[id]),
    }));
    const total = splits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(total - amount) > 0.01) {
      return { valid: false, splits, error: 'exact_mismatch' };
    }
    return { valid: true, splits };
  }

  if (method === 'percentage') {
    const pcts = participantIds.map((id) => num(input.percentages?.[id]));
    const totalPct = pcts.reduce((sum, p) => sum + p, 0);
    if (Math.abs(totalPct - 100) > 0.01) {
      return {
        valid: false,
        splits: participantIds.map((id, i) => ({ memberId: id, amount: round2((pcts[i] / 100) * amount) })),
        error: 'percentage_mismatch',
      };
    }
    return { valid: true, splits: proportionalSplits(amount, participantIds, pcts, totalPct) };
  }

  // shares — default weight 1 so an untouched field still means "one share"
  const weights = participantIds.map((id) => num(input.shares?.[id], 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    return { valid: false, splits: [], error: 'shares_zero' };
  }
  return { valid: true, splits: proportionalSplits(amount, participantIds, weights, totalWeight) };
}
