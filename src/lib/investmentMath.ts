// Average-cost position math for the Investment Tracker. Pure + tested —
// positions are always DERIVED by replaying the trade ledger, never stored,
// so they cannot drift from the rows that produced them.
//
// Fee treatment (the standard broker-statement convention, stated in UI copy):
//   buy fees are CAPITALIZED into cost basis (you're not "up" until
//   commissions are covered); sell fees reduce proceeds; dividend fees
//   (withholding / bank charges) reduce dividend income.
// Consequence: realized P/L per sell = qty × (sellPrice − avgCost) − sellFees,
// where avgCost already contains the buy fees — they are never counted twice.

import type { InvestmentTradeKind } from '../db';

// Structural subset of InvestmentTrade so fixtures and hypothetical trades
// don't need every persistence field.
export interface TradeLike {
  id: string;
  kind: InvestmentTradeKind;
  quantity: number;
  pricePerUnit: number;
  amount: number; // gross dividend cash; 0 for buy/sell
  fees: number;
  tradedAt: string;
  createdAt: string;
}

export interface SymbolPosition {
  quantity: number;
  costBasis: number;
  /** 0 when the position is flat. */
  avgCost: number;
  realizedPnl: number;
  dividends: number;
  feesPaid: number;
  /**
   * Sells that would have driven the position negative (bad synced data).
   * They are skipped deterministically rather than corrupting the replay.
   */
  invalidTradeIds: string[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// At an identical trade time, buys replay before sells — the only
// position-consistent interpretation (you can't dispose of shares you haven't
// acquired "at the same moment"), and it keeps same-day/backdated entries
// deterministic regardless of the order they were typed in.
const KIND_ORDER: Record<InvestmentTradeKind, number> = { buy: 0, dividend: 1, sell: 2 };

/**
 * Deterministic replay order: trade date, then buys-before-sells on ties,
 * then creation time, then id — the same on every device regardless of
 * insert order.
 */
export function sortTrades<T extends TradeLike>(trades: readonly T[]): T[] {
  return [...trades].sort(
    (a, b) =>
      a.tradedAt.localeCompare(b.tradedAt) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** Replays one symbol's trades into its current position. */
export function computePosition(trades: readonly TradeLike[]): SymbolPosition {
  let quantity = 0;
  let costBasis = 0;
  let realizedPnl = 0;
  let dividends = 0;
  let feesPaid = 0;
  const invalidTradeIds: string[] = [];

  for (const t of sortTrades(trades)) {
    feesPaid += t.fees;
    if (t.kind === 'buy') {
      costBasis += t.quantity * t.pricePerUnit + t.fees;
      quantity += t.quantity;
    } else if (t.kind === 'sell') {
      if (t.quantity > quantity + 1e-9) {
        // Defensive: never let bad data produce a negative position.
        invalidTradeIds.push(t.id);
        feesPaid -= t.fees; // skipped trades contribute nothing
        continue;
      }
      const avg = quantity > 0 ? costBasis / quantity : 0;
      realizedPnl += t.quantity * (t.pricePerUnit - avg) - t.fees;
      costBasis -= t.quantity * avg;
      quantity -= t.quantity;
      if (quantity <= 1e-9) {
        // Full exit: kill float dust so re-entry starts a genuinely fresh basis.
        quantity = 0;
        costBasis = 0;
      }
    } else {
      // Dividend — qty untouched; allowed at zero position (record-date reality).
      dividends += t.amount - t.fees;
    }
  }

  return {
    quantity,
    costBasis,
    avgCost: quantity > 0 ? costBasis / quantity : 0,
    realizedPnl: round2(realizedPnl),
    dividends: round2(dividends),
    feesPaid: round2(feesPaid),
    invalidTradeIds,
  };
}

/** Groups trades by symbol and replays each. Key = symbol as stored. */
export function computePositions<T extends TradeLike & { symbol: string }>(
  trades: readonly T[],
): Map<string, SymbolPosition> {
  const bySymbol = new Map<string, T[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  const out = new Map<string, SymbolPosition>();
  for (const [symbol, list] of bySymbol) out.set(symbol, computePosition(list));
  return out;
}

export function marketValue(pos: SymbolPosition, lastPrice: number): number {
  return round2(pos.quantity * lastPrice);
}

export function unrealizedPnl(pos: SymbolPosition, lastPrice: number): number {
  return round2(pos.quantity * lastPrice - pos.costBasis);
}

export function totalReturn(
  pos: SymbolPosition,
  lastPrice: number | null,
): { realized: number; unrealized: number | null; dividends: number; total: number | null } {
  const unrealized = lastPrice !== null && lastPrice > 0 ? unrealizedPnl(pos, lastPrice) : null;
  return {
    realized: pos.realizedPnl,
    unrealized,
    dividends: pos.dividends,
    total: unrealized === null ? null : round2(pos.realizedPnl + unrealized + pos.dividends),
  };
}

export type TimelineCheck =
  | { ok: true }
  | { ok: false; violation: { tradeId: string; heldQty: number; attemptedQty: number } };

/**
 * THE guard primitive: replays a symbol's full timeline with a hypothetical
 * mutation applied and reports the first sell that would exceed the shares
 * held at that point. Powers both "can this sell be recorded?" (add — catches
 * oversells including backdated ones) and "can this trade be deleted?"
 * (removeId — catches deleting a buy that a later sell depends on).
 *
 * Sells that are ALREADY invalid in the current data (bad sync residue) are
 * skipped exactly as computePosition skips them — historical bad rows must
 * not lock the user out of otherwise-valid new entries or deletions. Only
 * the candidate, or a previously-valid trade that the change breaks, can
 * report a violation.
 */
export function simulateTimeline(
  trades: readonly TradeLike[],
  change?: { add?: TradeLike; removeId?: string },
): TimelineCheck {
  const preInvalid = new Set(computePosition(trades).invalidTradeIds);
  let working: TradeLike[] = [...trades];
  if (change?.removeId) working = working.filter((t) => t.id !== change.removeId);
  if (change?.add) working.push(change.add);

  let qty = 0;
  for (const t of sortTrades(working)) {
    if (t.kind === 'buy') qty += t.quantity;
    else if (t.kind === 'sell') {
      if (t.quantity > qty + 1e-9) {
        // Already-bad data replays as skipped everywhere — not a new violation.
        if (preInvalid.has(t.id)) continue;
        return { ok: false, violation: { tradeId: t.id, heldQty: qty, attemptedQty: t.quantity } };
      }
      qty -= t.quantity;
    }
    // dividends never touch quantity
  }
  return { ok: true };
}

/** Input validation shared by the store and the money engine. */
export function validateTradeInput(input: {
  kind: InvestmentTradeKind;
  quantity: number;
  pricePerUnit: number;
  amount: number;
  fees: number;
}): string | null {
  if (!Number.isFinite(input.fees) || input.fees < 0) return 'Fees cannot be negative';
  if (input.kind === 'dividend') {
    if (!Number.isFinite(input.amount) || input.amount <= 0) return 'Dividend amount must be more than zero';
    if (input.amount - input.fees <= 0) return 'Fees cannot exceed the dividend amount';
    return null;
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return 'Quantity must be more than zero';
  if (!Number.isFinite(input.pricePerUnit) || input.pricePerUnit < 0) return 'Price cannot be negative';
  if (input.kind === 'sell' && input.quantity * input.pricePerUnit - input.fees < 0) {
    return 'Fees cannot exceed the sale proceeds';
  }
  return null;
}
