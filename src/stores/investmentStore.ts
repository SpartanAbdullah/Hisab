// Investment Tracker store — markets, trades, manual prices. Cloud-direct
// (committees tier): reads go straight to supabaseDb, positions are derived
// from trades via investmentMath (never materialized, so they cannot drift).
//
// Money split: trades with an accountId run through
// transactionStore.processTransaction (investment_buy/sell/dividend branches)
// so real balances move inside the safe-mutation scope; that path calls back
// into this store only to insert its state row. Trades "held outside Hisaab"
// (accountId null) are recorded here directly — a single insert, no balances.

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { investmentMarketsDb, investmentTradesDb, investmentPricesDb } from '../lib/supabaseDb';
import {
  computePositions,
  simulateTimeline,
  validateTradeInput,
  type SymbolPosition,
} from '../lib/investmentMath';
import type {
  InvestmentMarket, InvestmentTrade, InvestmentPrice, InvestmentTradeKind, Currency,
} from '../db';

export interface CreateMarketInput {
  name: string;
  currency: Currency;
}

// Ledger-only recording (accountId null). Account-linked trades go through
// transactionStore.processTransaction instead — see RecordTradeModal.
export interface RecordOutsideTradeInput {
  marketId: string;
  symbol: string;
  companyName?: string;
  kind: InvestmentTradeKind;
  quantity: number;      // 0 for dividend
  pricePerUnit: number;  // 0 for dividend
  amount: number;        // gross dividend cash; 0 for buy/sell
  fees: number;
  tradedAt?: string;
  notes?: string;
}

export interface HoldingView {
  marketId: string;
  symbol: string;
  companyName: string;
  position: SymbolPosition;
  lastPrice: number | null;
  priceAsOf: string | null;
}

interface InvestmentState {
  markets: InvestmentMarket[];
  trades: InvestmentTrade[];
  prices: InvestmentPrice[];
  loading: boolean;
  loadInvestments: () => Promise<void>;
  createMarket: (input: CreateMarketInput) => Promise<InvestmentMarket>;
  renameMarket: (id: string, name: string) => Promise<void>;
  deleteMarket: (id: string) => Promise<void>;
  recordOutsideTrade: (input: RecordOutsideTradeInput) => Promise<InvestmentTrade>;
  // Deletes a trade with the position-integrity replay guard. Account-linked
  // trades delegate to transactionStore.deleteTransaction (which reverses the
  // balances and removes the trade row inside one mutation scope).
  deleteTrade: (id: string) => Promise<void>;
  updatePrice: (marketId: string, symbol: string, price: number, asOf?: string) => Promise<void>;
  // State-row primitives used by transactionStore's tracked helpers — they
  // do NOT touch balances; the money engine owns that.
  insertTradeRow: (trade: InvestmentTrade) => Promise<void>;
  removeTradeRow: (id: string) => Promise<void>;
  restoreTradeRow: (trade: InvestmentTrade) => Promise<void>;
  getMarket: (id: string) => InvestmentMarket | undefined;
  tradesForSymbol: (marketId: string, symbol: string) => InvestmentTrade[];
  reset: () => void;
}

const INITIAL = {
  markets: [] as InvestmentMarket[],
  trades: [] as InvestmentTrade[],
  prices: [] as InvestmentPrice[],
  loading: false,
};

export const useInvestmentStore = create<InvestmentState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadInvestments: async () => {
    set({ loading: true });
    try {
      const [markets, trades, prices] = await Promise.all([
        investmentMarketsDb.getAll(),
        investmentTradesDb.getAll(),
        investmentPricesDb.getAll(),
      ]);
      set({ markets, trades, prices });
    } finally {
      set({ loading: false });
    }
  },

  createMarket: async (input) => {
    const name = input.name.trim();
    if (!name) throw new Error('Market name is required');
    const exists = get().markets.some((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (exists) throw new Error('A market with this name already exists');
    const market: InvestmentMarket = {
      id: uuid(),
      name,
      currency: input.currency,
      createdAt: new Date().toISOString(),
    };
    await investmentMarketsDb.add(market);
    set((s) => ({ markets: [...s.markets, market] }));
    return market;
  },

  renameMarket: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Market name is required');
    const duplicate = get().markets.some(
      (m) => m.id !== id && m.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) throw new Error('A market with this name already exists');
    await investmentMarketsDb.update(id, { name: trimmed });
    set((s) => ({ markets: s.markets.map((m) => (m.id === id ? { ...m, name: trimmed } : m)) }));
  },

  deleteMarket: async (id) => {
    // Trades are money history — a market with any live trade cannot go.
    // Refresh from the server first: the delete is a SOFT delete, so the
    // DB-level `on delete restrict` never fires and a stale local trades
    // list (trade recorded on another device) must not slip past the guard
    // and orphan those trades behind an invisible market.
    await get().loadInvestments();
    const hasTrades = get().trades.some((t) => t.marketId === id);
    if (hasTrades) throw new Error('This market has trades. Delete them first.');
    await investmentMarketsDb.delete(id);
    set((s) => ({ markets: s.markets.filter((m) => m.id !== id) }));
  },

  recordOutsideTrade: async (input) => {
    const market = get().getMarket(input.marketId);
    if (!market) throw new Error('Market not found');
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error('Symbol is required');
    const validationError = validateTradeInput(input);
    if (validationError) throw new Error(validationError);

    const now = new Date().toISOString();
    const trade: InvestmentTrade = {
      id: uuid(),
      marketId: input.marketId,
      symbol,
      name: input.companyName?.trim() ?? '',
      kind: input.kind,
      quantity: input.kind === 'dividend' ? 0 : input.quantity,
      pricePerUnit: input.kind === 'dividend' ? 0 : input.pricePerUnit,
      amount: input.kind === 'dividend' ? input.amount : 0,
      fees: input.fees,
      accountId: null,
      transactionId: null,
      tradedAt: input.tradedAt ?? now,
      notes: input.notes ?? '',
      createdAt: now,
    };

    if (trade.kind === 'sell') {
      const check = simulateTimeline(get().tradesForSymbol(input.marketId, symbol), { add: trade });
      if (!check.ok) {
        throw new Error(`You only hold ${check.violation.heldQty} — cannot sell ${check.violation.attemptedQty}`);
      }
    }

    await investmentTradesDb.add(trade);
    set((s) => ({ trades: [trade, ...s.trades] }));
    return trade;
  },

  deleteTrade: async (id) => {
    const trade = get().trades.find((t) => t.id === id);
    if (!trade) return;
    // Position integrity: deleting a buy that a later sell depends on would
    // drive the replayed quantity negative at some point in the timeline.
    const check = simulateTimeline(get().tradesForSymbol(trade.marketId, trade.symbol), { removeId: id });
    if (!check.ok) {
      throw new Error('Later sells depend on this buy — delete the newer sell first.');
    }
    if (trade.transactionId) {
      // Dynamic import breaks the static cycle (transactionStore imports this
      // store for its tracked helpers).
      const { useTransactionStore } = await import('./transactionStore');
      await useTransactionStore.getState().deleteTransaction(trade.transactionId, { allowInvestment: true });
      // Normally the delete case removed the trade row inside its mutation
      // scope. If it's still here, the linked transaction no longer existed
      // (deleted elsewhere / restored backup lost the link) — deleteTransaction
      // silently returns in that case, which used to leave this trade
      // undeletable forever. Clean up the orphan row directly; there is no
      // balance left to reverse.
      if (get().trades.some((t) => t.id === id)) {
        await investmentTradesDb.delete(id);
        set((s) => ({ trades: s.trades.filter((t) => t.id !== id) }));
      }
      return;
    }
    await investmentTradesDb.delete(id);
    set((s) => ({ trades: s.trades.filter((t) => t.id !== id) }));
  },

  updatePrice: async (marketId, symbol, price, asOf) => {
    if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be more than zero');
    const normalized = symbol.trim().toUpperCase();
    const existing = get().prices.find((p) => p.marketId === marketId && p.symbol === normalized);
    const row: InvestmentPrice = {
      // Deterministic id: the row is 1:1 with (market, symbol), so deriving
      // the id from that key keeps it stable even when the local prices list
      // is stale (a random uuid here would rewrite the shared row's primary
      // key on every stale upsert).
      id: existing?.id ?? `${marketId}:${normalized}`,
      marketId,
      symbol: normalized,
      price,
      asOf: asOf ?? new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await investmentPricesDb.upsert(row);
    set((s) => ({
      prices: existing
        ? s.prices.map((p) => (p.id === existing.id ? row : p))
        : [...s.prices, row],
    }));
  },

  insertTradeRow: async (trade) => {
    await investmentTradesDb.add(trade);
    set((s) => ({ trades: [trade, ...s.trades] }));
  },

  removeTradeRow: async (id) => {
    await investmentTradesDb.delete(id);
    set((s) => ({ trades: s.trades.filter((t) => t.id !== id) }));
  },

  restoreTradeRow: async (trade) => {
    // add() is an upsert with deleted_at: null, so restoring after a
    // rolled-back delete is the same call as inserting.
    await investmentTradesDb.add(trade);
    set((s) => (s.trades.some((t) => t.id === trade.id) ? s : { trades: [trade, ...s.trades] }));
  },

  getMarket: (id) => get().markets.find((m) => m.id === id),

  tradesForSymbol: (marketId, symbol) => {
    const normalized = symbol.trim().toUpperCase();
    return get().trades.filter((t) => t.marketId === marketId && t.symbol === normalized);
  },
}));

// ── Derived views (pure functions over store data — budgets precedent) ──

/** Holdings for one market (or all when marketId is null), open first. */
export function holdingsFor(
  marketId: string | null,
  trades: InvestmentTrade[],
  prices: InvestmentPrice[],
): HoldingView[] {
  const scoped = marketId ? trades.filter((t) => t.marketId === marketId) : trades;
  // Group per (marketId, symbol) — the same symbol may exist on two markets.
  const byKey = new Map<string, InvestmentTrade[]>();
  for (const t of scoped) {
    const key = `${t.marketId}:${t.symbol}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }
  const out: HoldingView[] = [];
  for (const [key, list] of byKey) {
    const [mId, symbol] = [list[0].marketId, list[0].symbol];
    void key;
    const positions = computePositions(list);
    const position = positions.get(symbol);
    if (!position) continue;
    const priceRow = prices.find((p) => p.marketId === mId && p.symbol === symbol) ?? null;
    const companyName = list.find((t) => t.name)?.name ?? '';
    out.push({
      marketId: mId,
      symbol,
      companyName,
      position,
      lastPrice: priceRow?.price ?? null,
      priceAsOf: priceRow?.asOf ?? null,
    });
  }
  // Open positions first (largest value first), closed at the end.
  return out.sort((a, b) => {
    const aOpen = a.position.quantity > 0 ? 0 : 1;
    const bOpen = b.position.quantity > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aVal = a.position.quantity * (a.lastPrice ?? a.position.avgCost);
    const bVal = b.position.quantity * (b.lastPrice ?? b.position.avgCost);
    return bVal - aVal;
  });
}

export interface CurrencyTotals {
  currency: Currency;
  invested: number;      // open cost basis
  currentValue: number;  // priced holdings at lastPrice; unpriced at cost
  unrealized: number;
  realized: number;
  dividends: number;
  feesPaid: number;
  unpricedCount: number;
}

/** Per-currency portfolio totals — never cross-summed (no FX on hand). */
export function portfolioTotals(
  markets: InvestmentMarket[],
  trades: InvestmentTrade[],
  prices: InvestmentPrice[],
): CurrencyTotals[] {
  const byCurrency = new Map<Currency, CurrencyTotals>();
  for (const market of markets) {
    const holdings = holdingsFor(market.id, trades, prices);
    if (holdings.length === 0) continue;
    const bucket = byCurrency.get(market.currency) ?? {
      currency: market.currency,
      invested: 0, currentValue: 0, unrealized: 0, realized: 0, dividends: 0, feesPaid: 0,
      unpricedCount: 0,
    };
    for (const h of holdings) {
      bucket.invested += h.position.costBasis;
      bucket.realized += h.position.realizedPnl;
      bucket.dividends += h.position.dividends;
      bucket.feesPaid += h.position.feesPaid;
      if (h.position.quantity > 0) {
        if (h.lastPrice !== null) {
          bucket.currentValue += h.position.quantity * h.lastPrice;
          bucket.unrealized += h.position.quantity * h.lastPrice - h.position.costBasis;
        } else {
          bucket.currentValue += h.position.costBasis;
          bucket.unpricedCount += 1;
        }
      }
    }
    byCurrency.set(market.currency, bucket);
  }
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return [...byCurrency.values()].map((b) => ({
    ...b,
    invested: round2(b.invested),
    currentValue: round2(b.currentValue),
    unrealized: round2(b.unrealized),
    realized: round2(b.realized),
    dividends: round2(b.dividends),
    feesPaid: round2(b.feesPaid),
  }));
}
