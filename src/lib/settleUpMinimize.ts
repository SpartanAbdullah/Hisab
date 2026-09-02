// Settle-up plans — the DIRECT one Hisaab already ships, and a MINIMIZED one.
//
// `groupDebts.computePairwiseDebts` deliberately produces direct obligations
// only: you pay the person you actually transacted with. That is the right
// default for a low-trust flatmate/family audience (it is the single biggest
// trust complaint about Splitwise's "simplify debts"). But Settle Up and
// Splitwise both expose fewest-transfers minimization as an explicit choice,
// and the 2026-09 competitive audit (11-competitive-analysis G4/O7) calls its
// absence the most visible math gap. So this module computes BOTH plans from
// the same debts and hands the UI the numbers to offer an honest toggle.
//
// THE TRADE-OFF, stated plainly (the UI must say this too):
//   · `direct`    — every transfer is between two people who really transacted.
//                   More transfers, zero surprises.
//   · `minimized` — fewer transfers, but money can be routed through people who
//                   never transacted with each other ("pay Bilal, whom you have
//                   never split a bill with"). `rerouted` lists exactly those
//                   transfers so the UI can warn instead of hiding it.
//
// WHAT "MINIMIZED" ACTUALLY MINIMIZES: the transfer COUNT, heuristically. The
// exact fewest-transfers problem is NP-hard (it is set-partition in disguise);
// this is the standard greedy largest-creditor ↔ largest-debtor pass, O(n log n)
// from the two sorts, always ≤ n−1 transfers, and NOT a proven optimum. Greedy
// can genuinely lose to the direct graph — balances (A −4, B −3, C +2, D +2,
// E +3) settle directly in 3 transfers but greedily in 4 — so when greedy comes
// out worse we fall back to the direct plan and flag it
// (`minimizedFellBackToDirect`). The toggle must never offer a "simplified"
// plan that is bigger than the plan it simplifies.
//
// The total money MOVED by `minimized` is Σ(positive balances) — the theoretical
// floor; `direct` always moves at least as much. Fewer transfers is therefore
// not the only saving, but it is the only one worth a toggle.
//
// CURRENCY: one plan per currency, always. `buildSettlePlansByCurrency`
// partitions first and never nets PKR against AED (repo-wide rule).
//
// Pure + tested; no UI, no store, no accounts.

import type { GroupDebt } from './groupDebts';
import { GROUP_SETTLEMENT_TOLERANCE } from './moneyTolerance';

/** Repo-wide "this is zero money" tolerance (statementOfAccount, groupSettleUp). */
export const SETTLE_TOLERANCE = 0.005;

export interface MemberBalance {
  id: string;
  name: string;
  /** Signed: POSITIVE = this person is owed money overall. */
  net: number;
}

export interface Transfer {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
}

export type SettleStrategy = 'direct' | 'minimized';

export interface SettlePlan {
  strategy: SettleStrategy;
  transfers: Transfer[];
  count: number;
  /** Sum of every transfer amount in the plan. */
  total: number;
}

export interface SettlePlans {
  currency: string;
  /** Normalized net position per person (2dp, summing to exactly 0). */
  balances: MemberBalance[];
  direct: SettlePlan;
  minimized: SettlePlan;
  /**
   * direct.count − minimized.count. Always ≥ 0 in the normal case (balances
   * derived from `debts`, so the fallback below can apply). It can go negative
   * only when a caller passes explicit balances the direct plan does not settle.
   */
  transfersSaved: number;
  /**
   * Transfers in `minimized` between two people with NO direct debt between
   * them — the honesty surface for the toggle's warning line.
   */
  rerouted: Transfer[];
  /** True when greedy came out worse than direct and we shipped direct instead. */
  minimizedFellBackToDirect: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function byIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold duplicate ids, round to 2dp, and absorb the last cent so the balances
 * sum to EXACTLY zero.
 *
 * Absorption rule (deterministic, documented because it moves a cent): the
 * residual lands on the entry with the largest |net|, ties broken by the lowest
 * id. Largest-magnitude is the entry where one cent is least visible; the id
 * tiebreak keeps the output stable across input orderings.
 */
export function normalizeBalances(balances: ReadonlyArray<MemberBalance>): MemberBalance[] {
  const merged = new Map<string, MemberBalance>();
  for (const b of balances) {
    const existing = merged.get(b.id);
    if (existing) existing.net = round2(existing.net + b.net);
    else merged.set(b.id, { id: b.id, name: b.name, net: round2(b.net) });
  }

  const out = [...merged.values()];
  if (out.length === 0) return out;

  const sum = round2(out.reduce((s, b) => s + b.net, 0));
  if (sum !== 0) {
    let target = out[0];
    for (const b of out) {
      const better =
        Math.abs(b.net) > Math.abs(target.net) ||
        (Math.abs(b.net) === Math.abs(target.net) && byIdAsc(b.id, target.id) < 0);
      if (better) target = b;
    }
    target.net = round2(target.net - sum);
  }

  return out.sort((a, b) => b.net - a.net || byIdAsc(a.id, b.id));
}

/** Per-person net position implied by a set of pairwise debts. */
export function netBalancesFromDebts(debts: ReadonlyArray<GroupDebt>): MemberBalance[] {
  const raw = new Map<string, MemberBalance>();
  const bump = (id: string, name: string, delta: number) => {
    const existing = raw.get(id);
    if (existing) existing.net = round2(existing.net + delta);
    else raw.set(id, { id, name, net: round2(delta) });
  };
  for (const d of debts) {
    bump(d.from, d.fromName, -d.amount); // the payer is down by what they owe
    bump(d.to, d.toName, d.amount);
  }
  return normalizeBalances([...raw.values()]);
}

/**
 * Greedy debt minimization: repeatedly settle the largest creditor against the
 * largest debtor. Never emits a self-transfer (a balance is either owed or
 * owing, never both) and never emits an amount at or below the tolerance.
 */
export function minimizeTransfers(balances: ReadonlyArray<MemberBalance>): Transfer[] {
  const normalized = normalizeBalances(balances);
  const sortDesc = (a: MemberBalance, b: MemberBalance) => b.net - a.net || byIdAsc(a.id, b.id);

  const creditors = normalized
    .filter((b) => b.net > SETTLE_TOLERANCE)
    .map((b) => ({ ...b }))
    .sort(sortDesc);
  const debtors = normalized
    .filter((b) => b.net < -SETTLE_TOLERANCE)
    .map((b) => ({ ...b, net: round2(-b.net) }))
    .sort(sortDesc);

  const out: Transfer[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const amount = round2(Math.min(creditor.net, debtor.net));
    if (amount > SETTLE_TOLERANCE && creditor.id !== debtor.id) {
      out.push({
        from: debtor.id,
        fromName: debtor.name,
        to: creditor.id,
        toName: creditor.name,
        amount,
      });
    }
    creditor.net = round2(creditor.net - amount);
    debtor.net = round2(debtor.net - amount);
    if (creditor.net <= SETTLE_TOLERANCE) ci += 1;
    if (debtor.net <= SETTLE_TOLERANCE) di += 1;
  }

  return out;
}

/**
 * Post-process a minimized transfer list so it never contains an amount the
 * server would refuse. `record_group_settlement` treats any pair whose cap is
 * <= GROUP_SETTLEMENT_TOLERANCE (0.01) as ALREADY_SETTLED (moneyTolerance.ts),
 * but `minimizeTransfers` above nets at the looser SETTLE_TOLERANCE (0.005)
 * and can legitimately emit a transfer in (0.005, 0.01] between two people
 * with no direct debt — the tail of a longer chain, not a bug in the greedy
 * pairing (worked six-person example in moneyTolerance.test.ts; see
 * docs/who-owes-me.md §8, "Tolerance rule"). Offering that transfer would
 * round-trip to a server error, so:
 *
 *   1. Drop every transfer with amount <= GROUP_SETTLEMENT_TOLERANCE.
 *   2. Re-absorb its amount into the largest SURVIVING transfer that shares
 *      either the same debtor or the same creditor — deterministic: largest
 *      amount wins, ties broken by (from, to) id ascending — so the cents
 *      aren't silently dropped out of the plan total.
 *   3. If no surviving transfer shares either endpoint, absorbing would mean
 *      inventing a transfer between a pair with no plan entry at all — worse
 *      than the ≤1¢ gap we're trying to avoid — so the residual is left on
 *      the balance instead. A residual this small is, by the server's own
 *      rule, already "square": `record_group_settlement` and `leave_group`
 *      both zero out at exactly one cent, so nothing is actually owed there
 *      as far as the server is concerned.
 *
 * Note: absorbing can leave a DIFFERENT pair holding a small residual — adding
 * a dropped transfer's cents onto an existing edge fully settles the dropped
 * transfer's own endpoints but nudges the other end of the edge it landed on.
 * That is unavoidable once a real transfer is removed from a balanced plan;
 * it stays bounded by GROUP_SETTLEMENT_TOLERANCE either way, so it is still
 * "square" to the server. What this function guarantees is narrower, and is
 * exactly what matters: no transfer it emits is one the server would refuse.
 */
export function absorbSubSettlementTransfers(transfers: ReadonlyArray<Transfer>): Transfer[] {
  const kept = transfers
    .filter((t) => t.amount > GROUP_SETTLEMENT_TOLERANCE)
    .map((t) => ({ ...t }));
  const dropped = transfers.filter((t) => t.amount <= GROUP_SETTLEMENT_TOLERANCE);

  for (const drop of dropped) {
    const candidates = kept.filter((t) => t.from === drop.from || t.to === drop.to);
    if (candidates.length === 0) continue; // no safe home for this cent — leave the residual on the balance

    let best = candidates[0];
    for (const c of candidates) {
      const cmp = c.amount - best.amount || byIdAsc(best.from, c.from) || byIdAsc(best.to, c.to);
      if (cmp > 0) best = c;
    }
    best.amount = round2(best.amount + drop.amount);
  }

  return kept.sort((a, b) => b.amount - a.amount || byIdAsc(a.from, b.from) || byIdAsc(a.to, b.to));
}

function planOf(strategy: SettleStrategy, transfers: Transfer[]): SettlePlan {
  return {
    strategy,
    transfers,
    count: transfers.length,
    total: round2(transfers.reduce((s, t) => s + t.amount, 0)),
  };
}

/** The plan Hisaab ships today: one transfer per non-zero pairwise debt. */
export function directTransfers(debts: ReadonlyArray<GroupDebt>): Transfer[] {
  return debts
    .filter((d) => d.amount > SETTLE_TOLERANCE && d.from !== d.to)
    .map((d) => ({
      from: d.from,
      fromName: d.fromName,
      to: d.to,
      toName: d.toName,
      amount: round2(d.amount),
    }))
    .sort((a, b) => b.amount - a.amount || byIdAsc(a.from, b.from) || byIdAsc(a.to, b.to));
}

export interface BuildSettlePlansInput {
  currency: string;
  /** Direct pairwise debts — `computePairwiseDebts` output, NOT the simplified list. */
  debts: ReadonlyArray<GroupDebt>;
  /**
   * Override the net positions the minimized plan is built from. Only needed
   * when the caller has balances from somewhere other than these debts; by
   * default they are derived from `debts` so the two plans always agree.
   */
  balances?: ReadonlyArray<MemberBalance>;
}

export function buildSettlePlans(input: BuildSettlePlansInput): SettlePlans {
  const balances = normalizeBalances(input.balances ?? netBalancesFromDebts(input.debts));
  const direct = planOf('direct', directTransfers(input.debts));
  const greedy = minimizeTransfers(balances);
  // Strip/absorb any transfer the server would refuse as ALREADY_SETTLED
  // before it's ever considered for offering — see the function's doc comment
  // and docs/who-owes-me.md §8.
  const absorbed = absorbSubSettlementTransfers(greedy);

  // Never offer a "simplified" plan with MORE steps than the plan it claims to
  // simplify — greedy is a heuristic and can lose (see the header note). Only
  // fall back when the direct plan actually settles THESE balances: a caller
  // that passed explicit balances unrelated to `debts` must not be handed a
  // shorter plan that leaves people owing money.
  const directSettles = applyTransfers(balances, direct.transfers).every(
    (b) => Math.abs(b.net) <= SETTLE_TOLERANCE,
  );
  const minimizedFellBackToDirect = absorbed.length > direct.count && directSettles;
  const minimized = planOf('minimized', minimizedFellBackToDirect ? [...direct.transfers] : absorbed);

  const directPairs = new Set<string>();
  for (const d of input.debts) {
    directPairs.add(d.from < d.to ? `${d.from}|${d.to}` : `${d.to}|${d.from}`);
  }
  const rerouted = minimized.transfers.filter(
    (t) => !directPairs.has(t.from < t.to ? `${t.from}|${t.to}` : `${t.to}|${t.from}`),
  );

  return {
    currency: input.currency,
    balances,
    direct,
    minimized,
    transfersSaved: direct.count - minimized.count,
    rerouted,
    minimizedFellBackToDirect,
  };
}

export interface CurrencyTaggedDebt extends GroupDebt {
  currency: string;
}

/**
 * One plan pair per currency — PKR is never netted against AED. Member ids must
 * already be consistent across the input rows (within a group they are; across
 * groups the caller must map to person keys first — see whoOwesMe.ts).
 */
export function buildSettlePlansByCurrency(
  debts: ReadonlyArray<CurrencyTaggedDebt>,
): SettlePlans[] {
  const buckets = new Map<string, GroupDebt[]>();
  for (const d of debts) {
    const bucket = buckets.get(d.currency);
    const entry: GroupDebt = {
      from: d.from,
      fromName: d.fromName,
      to: d.to,
      toName: d.toName,
      amount: d.amount,
    };
    if (bucket) bucket.push(entry);
    else buckets.set(d.currency, [entry]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, bucket]) => buildSettlePlans({ currency, debts: bucket }));
}

/**
 * Apply a plan to a set of balances — the assertion helper the tests use, and
 * the honest way for a caller to prove a plan really settles everyone.
 */
export function applyTransfers(
  balances: ReadonlyArray<MemberBalance>,
  transfers: ReadonlyArray<Transfer>,
): MemberBalance[] {
  const out = normalizeBalances(balances).map((b) => ({ ...b }));
  const byId = new Map(out.map((b) => [b.id, b]));
  for (const t of transfers) {
    const payer = byId.get(t.from);
    const payee = byId.get(t.to);
    if (payer) payer.net = round2(payer.net + t.amount); // paying up moves you toward 0
    if (payee) payee.net = round2(payee.net - t.amount);
  }
  return out;
}
