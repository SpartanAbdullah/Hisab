import { describe, it, expect } from 'vitest';
import {
  SETTLE_TOLERANCE,
  absorbSubSettlementTransfers,
  applyTransfers,
  buildSettlePlans,
  buildSettlePlansByCurrency,
  directTransfers,
  minimizeTransfers,
  netBalancesFromDebts,
  normalizeBalances,
  type CurrencyTaggedDebt,
  type MemberBalance,
  type Transfer,
} from './settleUpMinimize';
import { GROUP_SETTLEMENT_TOLERANCE } from './moneyTolerance';
import type { GroupDebt } from './groupDebts';

const debt = (from: string, to: string, amount: number): GroupDebt => ({
  from,
  fromName: from.toUpperCase(),
  to,
  toName: to.toUpperCase(),
  amount,
});

const bal = (id: string, net: number): MemberBalance => ({ id, name: id.toUpperCase(), net });

const settled = (balances: ReadonlyArray<MemberBalance>, transfers: ReadonlyArray<Transfer>) =>
  applyTransfers(balances, transfers).every((b) => Math.abs(b.net) <= SETTLE_TOLERANCE);

describe('normalizeBalances', () => {
  it('folds duplicate ids instead of emitting two rows for one person', () => {
    const out = normalizeBalances([bal('a', 10), bal('a', -4), bal('b', -6)]);
    expect(out).toEqual([
      { id: 'a', name: 'A', net: 6 },
      { id: 'b', name: 'B', net: -6 },
    ]);
  });

  it('absorbs the residual cent so balances sum to exactly zero', () => {
    // 33.33 × 3 vs −100: one cent short.
    const out = normalizeBalances([bal('a', 33.33), bal('b', 33.33), bal('c', 33.33), bal('d', -100)]);
    expect(out.reduce((s, b) => s + b.net, 0)).toBe(0);
    // Largest |net| takes the cent — here the −100 debtor.
    expect(out.find((b) => b.id === 'd')?.net).toBe(-99.99);
  });

  it('breaks an absorption tie on the lowest id, so output is order-independent', () => {
    const forward = normalizeBalances([bal('b', 10.005), bal('a', -10)]);
    const reverse = normalizeBalances([bal('a', -10), bal('b', 10.005)]);
    expect(forward).toEqual(reverse);
    expect(forward.reduce((s, b) => s + b.net, 0)).toBe(0);
  });

  it('returns an empty list unchanged', () => {
    expect(normalizeBalances([])).toEqual([]);
  });
});

describe('netBalancesFromDebts', () => {
  it('nets each person across every debt they appear in', () => {
    // A owes B 120; C owes A 30.  A: −90, B: +120, C: −30
    const out = netBalancesFromDebts([debt('a', 'b', 120), debt('c', 'a', 30)]);
    expect(out).toEqual([
      { id: 'b', name: 'B', net: 120 },
      { id: 'c', name: 'C', net: -30 },
      { id: 'a', name: 'A', net: -90 },
    ]);
  });

  it('is empty when nobody owes anybody', () => {
    expect(netBalancesFromDebts([])).toEqual([]);
  });
});

describe('minimizeTransfers', () => {
  it('collapses a chain into a single transfer (A→B→C becomes A→C)', () => {
    // A owes B 50, B owes C 50 → B is square, A just pays C.
    const balances = netBalancesFromDebts([debt('a', 'b', 50), debt('b', 'c', 50)]);
    const transfers = minimizeTransfers(balances);
    expect(transfers).toEqual([
      { from: 'a', fromName: 'A', to: 'c', toName: 'C', amount: 50 },
    ]);
    expect(settled(balances, transfers)).toBe(true);
  });

  it('pairs the largest creditor with the largest debtor', () => {
    const balances = [bal('a', -30), bal('b', -10), bal('x', 25), bal('y', 15)];
    const transfers = minimizeTransfers(balances);
    expect(transfers[0]).toMatchObject({ from: 'a', to: 'x', amount: 25 });
    expect(transfers).toHaveLength(3);
    expect(settled(balances, transfers)).toBe(true);
  });

  it('returns nothing when everyone is already square', () => {
    expect(minimizeTransfers([bal('a', 0), bal('b', 0)])).toEqual([]);
  });

  it('treats sub-tolerance dust as settled', () => {
    expect(minimizeTransfers([bal('a', 0.004), bal('b', -0.004)])).toEqual([]);
  });

  it('never emits a transfer from a person to themselves', () => {
    const transfers = minimizeTransfers([bal('a', 10), bal('a', -10), bal('b', 5), bal('c', -5)]);
    expect(transfers.every((t) => t.from !== t.to)).toBe(true);
    expect(transfers).toEqual([{ from: 'c', fromName: 'C', to: 'b', toName: 'B', amount: 5 }]);
  });
});

describe('absorbSubSettlementTransfers', () => {
  it('leaves a plan with no sub-settlement transfers untouched', () => {
    const transfers: Transfer[] = [
      { from: 'a', fromName: 'A', to: 'b', toName: 'B', amount: 50 },
      { from: 'c', fromName: 'C', to: 'd', toName: 'D', amount: 25 },
    ];
    expect(absorbSubSettlementTransfers(transfers)).toEqual(
      [...transfers].sort((x, y) => y.amount - x.amount),
    );
  });

  it('drops a lone 1-cent transfer with no other edge to absorb into, leaving the residual on the balance', () => {
    const transfers: Transfer[] = [{ from: 'd', fromName: 'D', to: 'b', toName: 'B', amount: 0.01 }];
    expect(absorbSubSettlementTransfers(transfers)).toEqual([]);
  });

  it('absorbs a dropped cent into the largest surviving transfer sharing the same debtor or creditor', () => {
    const transfers: Transfer[] = [
      { from: 'f', fromName: 'F', to: 'e', toName: 'E', amount: 299.99 }, // shares creditor e
      { from: 'a', fromName: 'A', to: 'e', toName: 'E', amount: 0.01 }, // dropped
      { from: 'a', fromName: 'A', to: 'c', toName: 'C', amount: 99.99 }, // shares debtor a
    ];
    const out = absorbSubSettlementTransfers(transfers);
    expect(out.every((t) => t.amount > GROUP_SETTLEMENT_TOLERANCE)).toBe(true);
    // The larger of the two candidates (f->e, 299.99) wins over (a->c, 99.99).
    expect(out.find((t) => t.from === 'f' && t.to === 'e')?.amount).toBe(300);
    expect(out.find((t) => t.from === 'a' && t.to === 'c')?.amount).toBe(99.99);
    expect(out).toHaveLength(2);
  });

  it(
    'the six-person moneyTolerance.test.ts example (docs/who-owes-me.md §8) no longer offers the ' +
      '1-cent D<->B transfer the server refuses',
    () => {
      // Same debts as moneyTolerance.test.ts's "documents the residual risk" case.
      const debts = [
        debt('a', 'b', 100.0),
        debt('b', 'c', 99.99),
        debt('d', 'e', 300.0),
        debt('f', 'd', 299.99),
      ];
      const balances = netBalancesFromDebts(debts);
      const raw = minimizeTransfers(balances);
      const tail = raw.find((t) => (t.from === 'd' && t.to === 'b') || (t.from === 'b' && t.to === 'd'));
      expect(tail?.amount).toBe(0.01); // minimizeTransfers itself is unchanged — confirms the setup

      const plans = buildSettlePlans({ currency: 'PKR', debts });
      const badTransfer = plans.minimized.transfers.find(
        (t) => (t.from === 'd' && t.to === 'b') || (t.from === 'b' && t.to === 'd'),
      );
      expect(badTransfer).toBeUndefined();
      expect(plans.minimized.transfers.every((t) => t.amount > GROUP_SETTLEMENT_TOLERANCE)).toBe(true);
    },
  );
});

describe('directTransfers', () => {
  it('is one transfer per pairwise debt, largest first', () => {
    const out = directTransfers([debt('a', 'b', 30), debt('c', 'd', 90)]);
    expect(out.map((t) => t.amount)).toEqual([90, 30]);
  });

  it('drops dust and self-debts', () => {
    expect(directTransfers([debt('a', 'b', 0.004), debt('a', 'a', 50)])).toEqual([]);
  });
});

describe('buildSettlePlans', () => {
  it('returns both plans, and minimizing a chain saves a transfer', () => {
    const plans = buildSettlePlans({ currency: 'AED', debts: [debt('a', 'b', 50), debt('b', 'c', 50)] });
    expect(plans.direct.count).toBe(2);
    expect(plans.minimized.count).toBe(1);
    expect(plans.transfersSaved).toBe(1);
    expect(plans.direct.strategy).toBe('direct');
    expect(plans.minimized.strategy).toBe('minimized');
    expect(plans.currency).toBe('AED');
  });

  it('flags the reroute — A never transacted with C but is told to pay them', () => {
    const plans = buildSettlePlans({ currency: 'AED', debts: [debt('a', 'b', 50), debt('b', 'c', 50)] });
    expect(plans.rerouted).toHaveLength(1);
    expect(plans.rerouted[0]).toMatchObject({ from: 'a', to: 'c' });
    // The direct plan pays only people you actually transacted with.
    expect(plans.direct.transfers.map((t) => [t.from, t.to])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('moves the theoretical minimum amount of money in the minimized plan', () => {
    const plans = buildSettlePlans({ currency: 'AED', debts: [debt('a', 'b', 50), debt('b', 'c', 50)] });
    const owedTotal = plans.balances.filter((b) => b.net > 0).reduce((s, b) => s + b.net, 0);
    expect(plans.minimized.total).toBe(owedTotal);
    expect(plans.direct.total).toBeGreaterThanOrEqual(plans.minimized.total);
  });

  it('falls back to direct when greedy is genuinely worse', () => {
    // Nets a:−4 b:−3 c:+2 d:+2 e:+3 settle DIRECTLY in 3 transfers, but greedy
    // needs 4 (a→e 3, a→c 1, b→c 1, b→d 2). The toggle must not offer the
    // bigger plan under the "simplified" label.
    const debts = [debt('b', 'e', 3), debt('a', 'c', 2), debt('a', 'd', 2)];
    const raw = minimizeTransfers(netBalancesFromDebts(debts));
    expect(raw).toHaveLength(4);

    const plans = buildSettlePlans({ currency: 'PKR', debts });
    expect(plans.minimizedFellBackToDirect).toBe(true);
    expect(plans.minimized.count).toBe(3);
    expect(plans.transfersSaved).toBe(0);
    expect(plans.rerouted).toEqual([]);
    expect(settled(plans.balances, plans.minimized.transfers)).toBe(true);
  });

  it('accepts explicit balances, and never falls back to a plan that leaves money owed', () => {
    const plans = buildSettlePlans({
      currency: 'AED',
      debts: [],
      balances: [bal('a', 40), bal('b', -40)],
    });
    expect(plans.direct.count).toBe(0);
    // The empty direct plan is shorter but does NOT settle these balances, so
    // the fallback must not fire.
    expect(plans.minimizedFellBackToDirect).toBe(false);
    expect(plans.minimized.transfers).toEqual([
      { from: 'b', fromName: 'B', to: 'a', toName: 'A', amount: 40 },
    ]);
    expect(plans.rerouted).toHaveLength(1); // no direct edge backs it
    expect(settled(plans.balances, plans.minimized.transfers)).toBe(true);
  });

  it('is all-square when nobody owes anything', () => {
    const plans = buildSettlePlans({ currency: 'AED', debts: [] });
    expect(plans.direct.count).toBe(0);
    expect(plans.minimized.count).toBe(0);
    expect(plans.balances).toEqual([]);
    expect(plans.transfersSaved).toBe(0);
  });
});

describe('buildSettlePlansByCurrency', () => {
  it('produces one plan per currency and never nets across them', () => {
    const debts: CurrencyTaggedDebt[] = [
      { ...debt('a', 'b', 100), currency: 'PKR' },
      { ...debt('b', 'a', 20), currency: 'AED' },
    ];
    const plans = buildSettlePlansByCurrency(debts);
    expect(plans.map((p) => p.currency)).toEqual(['AED', 'PKR']);
    expect(plans[0].minimized.total).toBe(20);
    expect(plans[1].minimized.total).toBe(100);
    // A netted-across-currency implementation would have produced 80 somewhere.
    expect(plans.flatMap((p) => p.minimized.transfers.map((t) => t.amount))).toEqual([20, 100]);
  });

  it('returns nothing for no debts', () => {
    expect(buildSettlePlansByCurrency([])).toEqual([]);
  });
});

// ── Property tests ─────────────────────────────────────────────────────────
// No fast-check in this repo (and adding a dep for one module is not worth it),
// so: a seeded LCG generates the cases. Deterministic, reproducible, and a
// failure prints the seed that produced it.

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomDebts(rand: () => number): GroupDebt[] {
  const people = 2 + Math.floor(rand() * 7); // 2..8 members
  const edges = 1 + Math.floor(rand() * 12);
  const out: GroupDebt[] = [];
  for (let i = 0; i < edges; i += 1) {
    const a = Math.floor(rand() * people);
    let b = Math.floor(rand() * people);
    if (b === a) b = (b + 1) % people;
    const amount = Math.round(rand() * 50000) / 100; // 0..500.00, 2dp
    if (amount <= SETTLE_TOLERANCE) continue;
    const from = `m${a}`;
    const to = `m${b}`;
    out.push({ from, fromName: from.toUpperCase(), to, toName: to.toUpperCase(), amount });
  }
  return out;
}

describe('settle-up plan properties (200 seeded random cases)', () => {
  const cases = Array.from({ length: 200 }, (_, i) => {
    const rand = lcg(i * 7919 + 13);
    return { seed: i, debts: randomDebts(rand) };
  });

  it('both plans zero every balance within tolerance', () => {
    for (const { seed, debts } of cases) {
      const plans = buildSettlePlans({ currency: 'AED', debts });
      expect(settled(plans.balances, plans.direct.transfers), `direct, seed ${seed}`).toBe(true);
      // The minimized plan is checked at GROUP_SETTLEMENT_TOLERANCE (0.01),
      // not the tighter SETTLE_TOLERANCE (0.005): absorbSubSettlementTransfers
      // can legitimately leave a <=1-cent residual on a balance rather than
      // offer a transfer the server would refuse (see its doc comment and
      // docs/who-owes-me.md §8) — and a <=1-cent residual is, by the server's
      // own rule, already "square".
      const minimizedSettled = applyTransfers(plans.balances, plans.minimized.transfers).every(
        (b) => Math.abs(b.net) <= GROUP_SETTLEMENT_TOLERANCE,
      );
      expect(minimizedSettled, `minimized, seed ${seed}`).toBe(true);
    }
  });

  it('the minimized plan is never bigger than the direct plan', () => {
    for (const { seed, debts } of cases) {
      const plans = buildSettlePlans({ currency: 'AED', debts });
      expect(plans.minimized.count, `seed ${seed}`).toBeLessThanOrEqual(plans.direct.count);
      expect(plans.transfersSaved, `seed ${seed}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('never routes a transfer from a person to themselves, and never moves dust', () => {
    for (const { seed, debts } of cases) {
      const plans = buildSettlePlans({ currency: 'AED', debts });
      for (const t of [...plans.direct.transfers, ...plans.minimized.transfers]) {
        expect(t.from, `seed ${seed}`).not.toBe(t.to);
        expect(t.amount, `seed ${seed}`).toBeGreaterThan(SETTLE_TOLERANCE);
        expect(t.amount, `seed ${seed}`).toBe(Math.round(t.amount * 100) / 100);
      }
    }
  });

  it('every minimized transfer is strictly above GROUP_SETTLEMENT_TOLERANCE — never a transfer the server would refuse', () => {
    for (const { seed, debts } of cases) {
      const plans = buildSettlePlans({ currency: 'AED', debts });
      for (const t of plans.minimized.transfers) {
        expect(t.amount, `seed ${seed}`).toBeGreaterThan(GROUP_SETTLEMENT_TOLERANCE);
      }
    }
  });

  it('plan totals sum to exactly the 2dp figure reported', () => {
    for (const { seed, debts } of cases) {
      const plans = buildSettlePlans({ currency: 'AED', debts });
      const owed = Math.round(plans.balances.filter((b) => b.net > 0).reduce((s, b) => s + b.net, 0) * 100) / 100;
      if (!plans.minimizedFellBackToDirect) {
        // absorbSubSettlementTransfers can drop a <=1-cent transfer that has
        // no surviving edge to absorb into (its cents are left as a residual
        // on the balance rather than invented as a new transfer — see its
        // doc comment), so `minimized.total` can now fall up to a few cents
        // short of the theoretical `owed` figure. It must never exceed it,
        // and the shortfall is bounded by one GROUP_SETTLEMENT_TOLERANCE per
        // person who could possibly hold an unabsorbed residual.
        expect(plans.minimized.total, `seed ${seed}`).toBeLessThanOrEqual(owed);
        expect(plans.minimized.total, `seed ${seed}`).toBeGreaterThanOrEqual(
          owed - GROUP_SETTLEMENT_TOLERANCE * plans.balances.length,
        );
      }
      expect(plans.direct.total, `seed ${seed}`).toBeGreaterThanOrEqual(plans.minimized.total - SETTLE_TOLERANCE);
    }
  });

  it('is stable: the same input always yields byte-identical plans', () => {
    for (const { seed, debts } of cases) {
      const a = buildSettlePlans({ currency: 'AED', debts });
      const b = buildSettlePlans({ currency: 'AED', debts: [...debts].reverse() });
      // Ordering of the INPUT debts must not change the minimized plan (the
      // balances are order-independent by construction).
      expect(a.minimized.transfers, `seed ${seed}`).toEqual(b.minimized.transfers);
      expect(a.balances, `seed ${seed}`).toEqual(b.balances);
    }
  });
});
