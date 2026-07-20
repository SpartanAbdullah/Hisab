// Credit-card credit clamping. A card's balance IS its available credit, so
// crediting it past metadata.creditLimit is always a modeling error — the bank
// never "owes" the user headroom beyond the limit. Every path that credits a
// card as a side effect of another record (cash-advance loan repayments) must
// clamp to the card's remaining headroom; a bill already paid by transfer
// leaves zero headroom and the credit leg is skipped entirely, so the same
// debt can never be credited back twice (the Available-27,650-over-Limit-16,500
// bug). Direct transfers stay unclamped — an explicit "I moved money" is
// recorded as typed — the UI surfaces the overpaid state instead.

export interface CardLike {
  type: string;
  balance: number;
  metadata: Record<string, string>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * How much more this card can be credited before hitting its limit.
 * Returns null when the account is not a credit card or has no limit set —
 * callers treat null as "no clamp applies".
 */
export function cardCreditHeadroom(card: CardLike): number | null {
  if (card.type !== 'credit_card') return null;
  const limit = parseFloat(card.metadata.creditLimit || '0');
  if (!(limit > 0)) return null;
  return Math.max(0, round2(limit - card.balance));
}

export interface ClampedCardCredit {
  /** What actually gets credited to the card (0 when the bill is covered). */
  credited: number;
  /** The part of the requested credit the card could not absorb. */
  skipped: number;
}

/**
 * Clamp a requested card credit to the card's remaining headroom.
 * With no limit configured the full amount passes through.
 */
export function clampCardCredit(card: CardLike, requested: number): ClampedCardCredit {
  const amount = round2(requested);
  if (!(amount > 0)) return { credited: 0, skipped: 0 };
  const headroom = cardCreditHeadroom(card);
  if (headroom === null) return { credited: amount, skipped: 0 };
  const credited = round2(Math.min(amount, headroom));
  return { credited, skipped: round2(amount - credited) };
}
