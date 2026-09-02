// Raw pairwise group debts — "you owe X directly to Y", with NO debt rerouting.
//
// The store's getSimplifiedDebts runs a min-cash-flow pass that can tell you to
// pay a near-stranger you never transacted with (the single biggest trust
// complaint about Splitwise). This computes the DIRECT net obligation between
// each pair of people from the expenses + settlements they actually share, so
// the default view never surprises a low-trust flatmate audience. Simplified
// stays available as an explicit opt-in. Pure + tested.

import { GROUP_SETTLEMENT_TOLERANCE } from './moneyTolerance';

export interface GroupDebt {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
}

interface MemberLike {
  id: string;
  name: string;
}
interface ExpenseLike {
  paidBy: string;
  splits: ReadonlyArray<{ memberId: string; amount: number }>;
}
interface SettlementLike {
  fromMember: string;
  toMember: string;
  amount: number;
}

export function computePairwiseDebts(
  members: ReadonlyArray<MemberLike>,
  expenses: ReadonlyArray<ExpenseLike>,
  settlements: ReadonlyArray<SettlementLike>,
): GroupDebt[] {
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  // owe["debtor|creditor"] = how much debtor owes creditor (directed).
  const owe = new Map<string, number>();
  const add = (debtor: string, creditor: string, amount: number) => {
    if (debtor === creditor) return; // a payer never owes themselves their share
    const k = `${debtor}|${creditor}`;
    owe.set(k, (owe.get(k) ?? 0) + amount);
  };

  for (const e of expenses) {
    for (const s of e.splits) add(s.memberId, e.paidBy, s.amount);
  }
  // A settlement from X to Y is X paying down their debt to Y.
  for (const st of settlements) add(st.fromMember, st.toMember, -st.amount);

  // Net each unordered pair so A↔B collapses to a single direction.
  const seen = new Set<string>();
  const out: GroupDebt[] = [];
  for (const k of owe.keys()) {
    const [a, b] = k.split('|');
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const ab = owe.get(`${a}|${b}`) ?? 0;
    const ba = owe.get(`${b}|${a}`) ?? 0;
    const net = Math.round((ab - ba) * 100) / 100;
    // Tolerance is GROUP_SETTLEMENT_TOLERANCE (0.01), NOT the looser
    // MONEY_TOLERANCE (0.005) used elsewhere in this repo — this exact
    // threshold is what keeps this output in lockstep with the server's
    // record_group_settlement cap and leave_group gate. See moneyTolerance.ts.
    if (net > GROUP_SETTLEMENT_TOLERANCE) {
      out.push({ from: a, fromName: nameOf.get(a) ?? '?', to: b, toName: nameOf.get(b) ?? '?', amount: net });
    } else if (net < -GROUP_SETTLEMENT_TOLERANCE) {
      out.push({ from: b, fromName: nameOf.get(b) ?? '?', to: a, toName: nameOf.get(a) ?? '?', amount: Math.round(-net * 100) / 100 });
    }
  }

  out.sort((x, y) => y.amount - x.amount);
  return out;
}
