import { describe, it, expect } from 'vitest';
import {
  computePosition,
  computePositions,
  simulateTimeline,
  sortTrades,
  totalReturn,
  unrealizedPnl,
  marketValue,
  validateTradeInput,
  type TradeLike,
} from './investmentMath';

let seq = 0;
function trade(over: Partial<TradeLike> & { kind: TradeLike['kind'] }): TradeLike {
  seq += 1;
  return {
    id: `t${seq}`,
    quantity: 0,
    pricePerUnit: 0,
    amount: 0,
    fees: 0,
    tradedAt: `2026-01-${String(seq).padStart(2, '0')}T10:00:00.000Z`,
    createdAt: `2026-01-${String(seq).padStart(2, '0')}T10:00:00.000Z`,
    ...over,
  };
}
const buy = (qty: number, price: number, fees = 0, over: Partial<TradeLike> = {}) =>
  trade({ kind: 'buy', quantity: qty, pricePerUnit: price, fees, ...over });
const sell = (qty: number, price: number, fees = 0, over: Partial<TradeLike> = {}) =>
  trade({ kind: 'sell', quantity: qty, pricePerUnit: price, fees, ...over });
const dividend = (amount: number, fees = 0, over: Partial<TradeLike> = {}) =>
  trade({ kind: 'dividend', amount, fees, ...over });

describe('computePosition — buys', () => {
  it('single buy: fee capitalizes into cost basis and avg cost', () => {
    const pos = computePosition([buy(100, 2.0, 10)]);
    expect(pos.quantity).toBe(100);
    expect(pos.costBasis).toBe(210);
    expect(pos.avgCost).toBeCloseTo(2.1);
    expect(pos.realizedPnl).toBe(0);
  });

  it('two buys at different prices/fees → weighted avg with fees', () => {
    // 100 @ 2.00 + 10 fee = 210; 50 @ 3.00 + 5 fee = 155; total 365 / 150
    const pos = computePosition([buy(100, 2.0, 10), buy(50, 3.0, 5)]);
    expect(pos.quantity).toBe(150);
    expect(pos.costBasis).toBeCloseTo(365);
    expect(pos.avgCost).toBeCloseTo(365 / 150);
  });
});

describe('computePosition — sells (average cost)', () => {
  it('partial sell: realized = qty*(price − avg) − sellFee; basis drops by qty*avg; avg unchanged', () => {
    const pos = computePosition([buy(100, 2.0, 10), sell(40, 2.5, 4)]);
    // avg = 2.10; realized = 40*(2.5−2.1) − 4 = 12
    expect(pos.realizedPnl).toBeCloseTo(12);
    expect(pos.quantity).toBe(60);
    expect(pos.costBasis).toBeCloseTo(210 - 40 * 2.1);
    expect(pos.avgCost).toBeCloseTo(2.1);
  });

  it('sell-all: quantity and basis are exactly 0 (float dust killed)', () => {
    // 0.1 + 0.1 + 0.1 accumulates float dust (0.30000000000000004); selling
    // the nominal 0.3 must still zero the position exactly.
    const pos = computePosition([
      buy(0.1, 3, 0.01),
      buy(0.1, 3.1, 0.01),
      buy(0.1, 2.9, 0.01),
      sell(0.3, 3.05, 0.02),
    ]);
    expect(pos.quantity).toBe(0);
    expect(pos.costBasis).toBe(0);
    expect(pos.avgCost).toBe(0);
  });

  it('zero-position re-entry starts a fresh basis, unaffected by history', () => {
    const pos = computePosition([buy(10, 5, 0), sell(10, 8, 0), buy(20, 3, 6)]);
    expect(pos.realizedPnl).toBeCloseTo(30);
    expect(pos.quantity).toBe(20);
    expect(pos.avgCost).toBeCloseTo((20 * 3 + 6) / 20);
  });
});

describe('computePosition — dividends', () => {
  it('adds amount − fees to dividends; quantity untouched', () => {
    const pos = computePosition([buy(100, 2, 0), dividend(50, 7.5)]);
    expect(pos.dividends).toBeCloseTo(42.5);
    expect(pos.quantity).toBe(100);
  });

  it('dividend at zero position is allowed (record-date payout after exit)', () => {
    const pos = computePosition([buy(10, 5, 0), sell(10, 5, 0), dividend(25, 0)]);
    expect(pos.dividends).toBe(25);
    expect(pos.quantity).toBe(0);
  });
});

describe('computePosition — defensive invalid sells', () => {
  it('a sell exceeding held qty is skipped and reported, never negative', () => {
    const pos = computePosition([buy(10, 2, 0), sell(50, 3, 5, { id: 'bad-sell' })]);
    expect(pos.quantity).toBe(10);
    expect(pos.invalidTradeIds).toEqual(['bad-sell']);
    expect(pos.realizedPnl).toBe(0);
    expect(pos.feesPaid).toBe(0); // skipped trade contributes nothing
  });
});

describe('ordering', () => {
  it('equal tradedAt broken by createdAt then id', () => {
    const a = buy(1, 1, 0, { id: 'b', tradedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:01Z' });
    const b = buy(1, 1, 0, { id: 'a', tradedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:01Z' });
    const c = buy(1, 1, 0, { id: 'c', tradedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z' });
    expect(sortTrades([a, b, c]).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('at an identical trade time, buys replay before sells regardless of entry order', () => {
    const s = sell(5, 2, 0, { id: 'a-sell', tradedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T09:00:00Z' });
    const b = buy(5, 2, 0, { id: 'z-buy', tradedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T10:00:00Z' });
    expect(sortTrades([s, b]).map((t) => t.id)).toEqual(['z-buy', 'a-sell']);
    // And the position replays cleanly instead of flagging a false oversell.
    const pos = computePosition([s, b]);
    expect(pos.invalidTradeIds).toEqual([]);
    expect(pos.quantity).toBe(0);
  });
});

describe('simulateTimeline', () => {
  it('rejects a sell larger than held, reporting held qty', () => {
    const trades = [buy(100, 2, 0)];
    const res = simulateTimeline(trades, { add: sell(150, 2.5, 0, { id: 'candidate' }) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violation.tradeId).toBe('candidate');
      expect(res.violation.heldQty).toBe(100);
      expect(res.violation.attemptedQty).toBe(150);
    }
  });

  it('rejects a backdated sell inserted before its buy', () => {
    const trades = [buy(100, 2, 0, { tradedAt: '2026-03-10T00:00:00Z' })];
    const res = simulateTimeline(trades, {
      add: sell(50, 2.5, 0, { tradedAt: '2026-03-05T00:00:00Z' }),
    });
    expect(res.ok).toBe(false);
  });

  it('blocks removing a buy that a later sell depends on', () => {
    const b = buy(100, 2, 0, { id: 'the-buy' });
    const s = sell(80, 2.5, 0);
    expect(simulateTimeline([b, s], { removeId: 'the-buy' }).ok).toBe(false);
  });

  it('removing a sell or a dividend is always fine', () => {
    const b = buy(100, 2, 0);
    const s = sell(80, 2.5, 0, { id: 's1' });
    const d = dividend(10, 0, { id: 'd1' });
    expect(simulateTimeline([b, s, d], { removeId: 's1' }).ok).toBe(true);
    expect(simulateTimeline([b, s, d], { removeId: 'd1' }).ok).toBe(true);
  });

  it('accepts a valid sell', () => {
    expect(simulateTimeline([buy(100, 2, 0)], { add: sell(100, 1.9, 2) }).ok).toBe(true);
  });

  it('historical bad data (already-invalid sell) does not block new valid entries', () => {
    const trades = [
      buy(10, 2, 0),
      sell(50, 3, 0, { id: 'bad-old-sell' }), // invalid residue from a sync race
    ];
    // computePosition skips the bad sell → 10 held; a new sell of 5 is fine.
    expect(simulateTimeline(trades, { add: sell(5, 2.5, 0, { id: 'new-sell' }) }).ok).toBe(true);
    // But a new OVERSELL still reports against the candidate, not the residue.
    const res = simulateTimeline(trades, { add: sell(50, 2.5, 0, { id: 'new-oversell' }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violation.tradeId).toBe('new-oversell');
    // And deleting the only buy is still fine (the bad sell stays skipped).
    expect(simulateTimeline(trades, { removeId: trades[0].id }).ok).toBe(true);
  });
});

describe('valuation', () => {
  it('unrealizedPnl and marketValue against a last price', () => {
    const pos = computePosition([buy(100, 2.0, 10)]); // basis 210
    expect(marketValue(pos, 2.5)).toBe(250);
    expect(unrealizedPnl(pos, 2.5)).toBe(40);
  });

  it('totalReturn composes realized + unrealized + dividends on a mixed fixture', () => {
    const pos = computePosition([buy(100, 2.0, 10), sell(40, 2.5, 4), dividend(30, 3)]);
    const ret = totalReturn(pos, 2.2);
    // realized 12; unrealized = 60*2.2 − 60*2.1 = 6; dividends 27
    expect(ret.realized).toBeCloseTo(12);
    expect(ret.unrealized).toBeCloseTo(6);
    expect(ret.dividends).toBeCloseTo(27);
    expect(ret.total).toBeCloseTo(45);
  });

  it('null price → unrealized and total are null, realized + dividends still reported', () => {
    const pos = computePosition([buy(10, 2, 0), dividend(5, 0)]);
    const ret = totalReturn(pos, null);
    expect(ret.unrealized).toBeNull();
    expect(ret.total).toBeNull();
    expect(ret.dividends).toBe(5);
  });

  it('rounds money outputs to 2dp', () => {
    const pos = computePosition([buy(3, 1.111, 0.111), sell(1, 2.222, 0.111)]);
    expect(Number.isInteger(pos.realizedPnl * 100)).toBe(true);
    expect(Number.isInteger(pos.feesPaid * 100)).toBe(true);
  });
});

describe('computePositions', () => {
  it('groups by symbol independently', () => {
    const trades = [
      { ...buy(10, 2, 0), symbol: 'EMAAR' },
      { ...buy(5, 100, 0), symbol: 'HBL' },
      { ...sell(4, 3, 0), symbol: 'EMAAR' },
    ];
    const map = computePositions(trades);
    expect(map.get('EMAAR')?.quantity).toBe(6);
    expect(map.get('HBL')?.quantity).toBe(5);
  });
});

describe('validateTradeInput', () => {
  it('rejects non-positive qty on buy/sell', () => {
    expect(validateTradeInput({ kind: 'buy', quantity: 0, pricePerUnit: 1, amount: 0, fees: 0 })).toBeTruthy();
    expect(validateTradeInput({ kind: 'sell', quantity: -2, pricePerUnit: 1, amount: 0, fees: 0 })).toBeTruthy();
  });
  it('rejects dividend where fees >= gross', () => {
    expect(validateTradeInput({ kind: 'dividend', quantity: 0, pricePerUnit: 0, amount: 5, fees: 5 })).toBeTruthy();
  });
  it('rejects sell whose fees exceed proceeds', () => {
    expect(validateTradeInput({ kind: 'sell', quantity: 1, pricePerUnit: 1, amount: 0, fees: 2 })).toBeTruthy();
  });
  it('accepts sane inputs', () => {
    expect(validateTradeInput({ kind: 'buy', quantity: 10, pricePerUnit: 2.5, amount: 0, fees: 1 })).toBeNull();
    expect(validateTradeInput({ kind: 'dividend', quantity: 0, pricePerUnit: 0, amount: 50, fees: 7.5 })).toBeNull();
  });
});
