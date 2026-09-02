// The pure half of the server-side credit-card engine (L4 step 4, branch 5).
//
// `pay_card_bill` (supabase-migration-p3-atomic-goal-and-card.sql) commits the
// wallet debit, the card credit, every cash-advance loan the payment settles,
// every instalment it covers and every row in ONE Postgres transaction. It does
// NOT decide how much of the payment goes to which advance — that decision is
// real, tested business logic with its own engine (src/lib/cardStatement.ts
// `allocateBillPayment`, src/lib/cardCredit.ts `clampCardCredit`, 30+ unit
// tests behind them), and porting it to plpgsql would fork the source of truth.
//
// So: THE CLIENT PLANS, THE SERVER APPLIES — and the server re-validates every
// number it is handed (Σ applied may not exceed what the payment credited to
// the card; each instalment must belong to its loan; a repayment may not credit
// a card past its limit). A lying plan is refused, but the RULE that produced
// it stays here, in TypeScript, where the tests are.
//
// This module owns the one piece of that decision that was previously inline in
// the 640-line `processTransaction` switch: choosing between the
// statement-native allocation and the legacy greedy fallback. Both the legacy
// path and the atomic path call it, so the two cannot drift.

import { allocateBillPayment } from './cardStatement';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CardBillAdvance {
  loanId: string;
  /** The advance's remaining principal, in CARD currency. */
  remaining: number;
  /** Origin date — drives the oldest-first ordering in both strategies. */
  createdAt: string;
  /** This statement's instalment for this plan; 0 when none is due. */
  dueThisCycle: number;
}

export interface CardBillPrincipalLine {
  loanId: string;
  /** Principal to knock off this advance, already 2dp. */
  applied: number;
}

/**
 * How a card-bill payment is split across the advances that card funded.
 *
 * Lifted verbatim from `case 'transfer'`'s credit-card tail
 * (transactionStore.ts:1688-1726) so there is exactly one copy of the rule:
 *
 *   statement-native (the card has a credit limit AND a due day) — this
 *     cycle's instalment(s) first, then revolving purchases, then prepay the
 *     rest oldest-first, then surplus. Paying THIS month's statement steps each
 *     plan by one instalment; paying the full balance still clears everything.
 *
 *   greedy fallback (a card missing a limit or a due day) — wipe the oldest
 *     advance first, whole remaining at a time. Kept byte-for-byte, including
 *     the un-rounded initial `left`, so cards saved before the two-date model
 *     existed behave exactly as they do today.
 *
 * `advances` must already be in oldest-first order (findActiveCashAdvanceLoansForCard
 * sorts by createdAt); the statement-native branch re-sorts defensively inside
 * allocateBillPayment, the greedy one relies on the caller's order — which is
 * precisely what the shipped code does.
 */
export function planCardBillPrincipal(input: {
  /** The payment, in CARD currency (already converted for a cross-currency move). */
  pool: number;
  /** The card has both a positive credit limit and a valid due day. */
  statementNative: boolean;
  /** used − Σ(advance remaining) at payment time, floored at 0. */
  revolvingPurchases: number;
  advances: CardBillAdvance[];
}): CardBillPrincipalLine[] {
  if (input.statementNative && input.advances.length > 0) {
    const alloc = allocateBillPayment({
      payment: input.pool,
      revolvingPurchases: input.revolvingPurchases,
      advances: input.advances,
    });
    return alloc.perLoan.map((l) => ({ loanId: l.loanId, applied: l.principalApplied }));
  }

  let left = input.pool;
  const out: CardBillPrincipalLine[] = [];
  for (const a of input.advances) {
    if (left <= 0.005) break;
    const applied = round2(Math.min(a.remaining, left));
    if (applied <= 0.005) continue;
    out.push({ loanId: a.loanId, applied });
    left = round2(left - applied);
  }
  return out;
}

/** One settlement line as `pay_card_bill` binds it (snake_case, by design —
 *  it is read straight back out by the plpgsql `e ->> 'loan_id'` expressions). */
export interface CardBillPlanPayloadLine {
  loan_id: string;
  applied: number;
  /** The loan's remaining BEFORE this line — the compare-and-swap expectation. */
  expected_remaining: number;
  /** Instalments this line covers. The server re-validates every one. */
  emi_ids: string[];
  /**
   * The ledger-only 'repayment' row this line writes, or null.
   *   bill payment → a uuid (the row the legacy tail writes: both account ids
   *                  NULL, linked back to the transfer by its internal note)
   *   repayment    → null (the MAIN row is the record; a second one would
   *                  double-count the payment)
   */
  row_id: string | null;
  /** Built by buildInternalNote client-side, so the encoding can never fork. */
  row_note: string;
}

export interface CardBillPlanLine {
  loanId: string;
  applied: number;
  expectedRemaining: number;
  emiIds: string[];
  rowId: string | null;
  rowNote: string;
}

/** Camel → the snake_case array the RPC binds. */
export function toCardBillPayload(lines: CardBillPlanLine[]): CardBillPlanPayloadLine[] {
  return lines.map((l) => ({
    loan_id: l.loanId,
    applied: l.applied,
    expected_remaining: l.expectedRemaining,
    emi_ids: l.emiIds,
    row_id: l.rowId,
    row_note: l.rowNote,
  }));
}

/**
 * The client half of the server's lockstep invariant (src/lib/cardStatement.ts
 * :16-19): the cash-advance principal is ALREADY inside the card's `used`, so a
 * payment reduces `used` and the matching share of the loans together. A plan
 * that settles more principal than the payment credited would mint money.
 *
 * Checking here as well as there is not redundancy: a refusal that costs a
 * round-trip on 3G is a refusal the user waits for, and the two halves have to
 * agree or they have forked. The test file asserts they do.
 *
 * Applies to a BILL PAYMENT only. A cash-advance repayment credits the card by
 * a CLAMPED figure that is legitimately smaller than the loan reduction (the
 * rest of the bill was already paid by a transfer, which already credited the
 * card) — enforcing lockstep there would break the very case branch 5 exists to
 * fix.
 */
export function cardBillPlanExceedsPayment(
  lines: CardBillPlanLine[],
  cardCredited: number,
): boolean {
  const applied = round2(lines.reduce((total, l) => total + l.applied, 0));
  return applied > round2(cardCredited) + 0.01;
}
