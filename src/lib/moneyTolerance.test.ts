import { describe, it, expect } from 'vitest';
import {
  MONEY_TOLERANCE,
  GROUP_SETTLEMENT_TOLERANCE,
  isZeroMoney,
  moneyEq,
  isZeroGroupSettlement,
  round2,
  SETTLE_TOLERANCE,
  WHO_OWES_TOLERANCE,
} from './moneyTolerance';
import { computePairwiseDebts } from './groupDebts';
import { netBalancesFromDebts, minimizeTransfers } from './settleUpMinimize';

describe('constants', () => {
  it('MONEY_TOLERANCE is 0.005 — the general float-noise epsilon', () => {
    expect(MONEY_TOLERANCE).toBe(0.005);
  });

  it('GROUP_SETTLEMENT_TOLERANCE is 0.01 — the server zero cutoff, a DIFFERENT number on purpose', () => {
    expect(GROUP_SETTLEMENT_TOLERANCE).toBe(0.01);
    expect(GROUP_SETTLEMENT_TOLERANCE).toBeGreaterThan(MONEY_TOLERANCE);
  });

  it('back-compat aliases match MONEY_TOLERANCE (mirrors settleUpMinimize.SETTLE_TOLERANCE / whoOwesMe.WHO_OWES_TOLERANCE)', () => {
    expect(SETTLE_TOLERANCE).toBe(MONEY_TOLERANCE);
    expect(WHO_OWES_TOLERANCE).toBe(MONEY_TOLERANCE);
  });
});

describe('isZeroMoney / moneyEq', () => {
  it('treats anything within MONEY_TOLERANCE as zero, on both sides', () => {
    expect(isZeroMoney(0)).toBe(true);
    expect(isZeroMoney(0.005)).toBe(true);
    expect(isZeroMoney(-0.005)).toBe(true);
  });

  it('treats anything past MONEY_TOLERANCE as real money', () => {
    expect(isZeroMoney(0.0051)).toBe(false);
    expect(isZeroMoney(-0.0051)).toBe(false);
  });

  it('moneyEq compares two amounts through the same tolerance', () => {
    expect(moneyEq(10, 10.004)).toBe(true);
    expect(moneyEq(10, 10.006)).toBe(false);
  });
});

describe('isZeroGroupSettlement', () => {
  it('treats exactly one cent as zero (matches the server)', () => {
    expect(isZeroGroupSettlement(0.01)).toBe(true);
    expect(isZeroGroupSettlement(-0.01)).toBe(true);
  });

  it('treats two cents as real money', () => {
    expect(isZeroGroupSettlement(0.02)).toBe(false);
  });
});

describe('round2', () => {
  it('rounds to cents the same way every netting engine does', () => {
    expect(round2(1.006)).toBe(1.01); // Math.round half-up, matches groupDebts/settleUpMinimize
    expect(round2(1.004)).toBe(1);
  });
});

// ── Server boundary ──────────────────────────────────────────────────────
// Proves the risk this module exists to avoid: MONEY_TOLERANCE (0.005) is
// too loose to safely gate group-settlement decisions, because the server
// draws its own "is this zero" line at 0.01, one full cent higher. These
// tests mirror the actual SQL (cited below) rather than guessing at it.
describe('server boundary — record_group_settlement / leave_group both zero out at 0.01', () => {
  // record_group_settlement, supabase-migration-audit-p0-group-concurrency.sql:
  //   v_cap := group_settlement_cap(...)                                  (:379)
  //   IF v_cap <= 0.01 THEN ALREADY_SETTLED                               (:381)
  //   IF v_amount > v_cap + 0.005 THEN EXCEEDS_OUTSTANDING                (:389)
  // group_settlement_cap itself (:263):
  //   RETURN GREATEST(v_pair, v_flow, 0)
  //   where v_pair is the direct pairwise debt (mirrors computePairwiseDebts,
  //   comment at :215-219) and v_flow = LEAST(-net(from), net(to)) when the
  //   payer is a net debtor and the payee a net creditor.
  function serverSettlementCap(directPairDebt: number, netFrom: number, netTo: number): number {
    const flow = netFrom < 0 && netTo > 0 ? Math.min(-netFrom, netTo) : 0;
    return Math.max(directPairDebt, flow, 0);
  }
  function serverWouldRecordSettlement(directPairDebt: number, netFrom: number, netTo: number, amount: number): boolean {
    const cap = serverSettlementCap(directPairDebt, netFrom, netTo);
    if (cap <= 0.01) return false; // ALREADY_SETTLED
    return amount <= cap + 0.005; // EXCEEDS_OUTSTANDING guard
  }
  // leave_group, supabase-migration-safe-leave-group.sql:142
  function serverWouldBlockLeaving(net: number): boolean {
    return Math.abs(net) > 0.01;
  }

  it('an exact one-cent net position is "square enough" to leave, server-side', () => {
    expect(serverWouldBlockLeaving(0.01)).toBe(false);
    expect(serverWouldBlockLeaving(-0.01)).toBe(false);
    expect(serverWouldBlockLeaving(0.02)).toBe(true);
  });

  it('the server refuses to record a settlement of an exact one-cent, no-direct-debt gap', () => {
    // Two people whose OVERALL net differs by exactly one cent and who never
    // transacted directly (v_pair = 0) — the shape minimizeTransfers can
    // produce as the tail of a longer chain (see docs/who-owes-me.md
    // "Tolerance rule" for the worked multi-person example).
    expect(serverWouldRecordSettlement(0, -0.01, 0.01, 0.01)).toBe(false);
  });

  it('MONEY_TOLERANCE alone would show that one-cent gap as real, payable money — the server disagrees', () => {
    expect(isZeroMoney(0.01)).toBe(false); // a settleUpMinimize/whoOwesMe-style check calls this real money
    expect(serverWouldRecordSettlement(0, -0.01, 0.01, 0.01)).toBe(false); // ...and the RPC that would record it just refused
  });

  it('GROUP_SETTLEMENT_TOLERANCE keeps computePairwiseDebts in lockstep with the server at the one-cent boundary', () => {
    const debts = computePairwiseDebts(
      [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }],
      [{ paidBy: 'Y', splits: [{ memberId: 'X', amount: 0.01 }] }],
      [],
    );
    // Never offered as a debt — matches serverWouldRecordSettlement(...) === false
    // and serverWouldBlockLeaving(0.01) === false above.
    expect(debts).toEqual([]);
    expect(isZeroGroupSettlement(0.01)).toBe(true);
  });

  it(
    'documents the residual risk: settleUpMinimize (0.005, out of this change\'s scope) CAN still hand out a ' +
      'one-cent transfer between two people with no direct debt that the server then refuses',
    () => {
      // Six-person chain built entirely from real, >0.01 pairwise debts (the
      // only kind computePairwiseDebts ever emits). Two tail balances land
      // exactly one cent apart with no direct edge between them.
      const debts = [
        { from: 'A', fromName: 'A', to: 'B', toName: 'B', amount: 100.0 },
        { from: 'B', fromName: 'B', to: 'C', toName: 'C', amount: 99.99 },
        { from: 'D', fromName: 'D', to: 'E', toName: 'E', amount: 300.0 },
        { from: 'F', fromName: 'F', to: 'D', toName: 'D', amount: 299.99 },
      ];
      const balances = netBalancesFromDebts(debts);
      const byId = new Map(balances.map((b) => [b.id, b.net]));
      expect(byId.get('B')).toBe(0.01); // real net position, from real edges
      expect(byId.get('D')).toBe(-0.01);

      const transfers = minimizeTransfers(balances);
      const tail = transfers.find((t) => (t.from === 'D' && t.to === 'B') || (t.from === 'B' && t.to === 'D'));
      expect(tail?.amount).toBe(0.01);

      // B and D never appear together in `debts` — no direct pairwise debt —
      // so the server's cap for this pair is exactly the flow ceiling, which
      // is itself their one-cent overall gap: ALREADY_SETTLED.
      const netB = byId.get('B') ?? 0;
      const netD = byId.get('D') ?? 0;
      const [netFrom, netTo] = tail?.from === 'D' ? [netD, netB] : [netB, netD];
      expect(serverWouldRecordSettlement(0, netFrom, netTo, tail?.amount ?? 0)).toBe(false);
    },
  );
});
