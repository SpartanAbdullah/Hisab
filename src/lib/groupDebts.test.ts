import { describe, expect, it } from 'vitest';
import { computePairwiseDebts } from './groupDebts';

const members = [
  { id: 'A', name: 'Ali' },
  { id: 'B', name: 'Bilal' },
  { id: 'C', name: 'Cara' },
];

describe('computePairwiseDebts', () => {
  it('attributes each split to the payer (and skips the payer\'s own share)', () => {
    const debts = computePairwiseDebts(
      members,
      [{ paidBy: 'A', splits: [{ memberId: 'A', amount: 34 }, { memberId: 'B', amount: 33 }, { memberId: 'C', amount: 33 }] }],
      [],
    );
    expect(debts).toHaveLength(2);
    expect(debts.find((d) => d.from === 'B' && d.to === 'A')?.amount).toBe(33);
    expect(debts.find((d) => d.from === 'C' && d.to === 'A')?.amount).toBe(33);
  });

  it('nets reciprocal debts between a pair into one direction', () => {
    const debts = computePairwiseDebts(
      members,
      [
        { paidBy: 'A', splits: [{ memberId: 'A', amount: 30 }, { memberId: 'B', amount: 30 }] }, // B owes A 30
        { paidBy: 'B', splits: [{ memberId: 'A', amount: 10 }, { memberId: 'B', amount: 10 }] }, // A owes B 10
      ],
      [],
    );
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ from: 'B', to: 'A', amount: 20 });
  });

  it('does NOT reroute debts to a stranger (the anti-Splitwise property)', () => {
    // A paid for B (B owes A 50); C paid for A (A owes C 50).
    // Simplified would tell B to pay C. Pairwise keeps both direct debts.
    const debts = computePairwiseDebts(
      members,
      [
        { paidBy: 'A', splits: [{ memberId: 'A', amount: 0 }, { memberId: 'B', amount: 50 }] },
        { paidBy: 'C', splits: [{ memberId: 'C', amount: 0 }, { memberId: 'A', amount: 50 }] },
      ],
      [],
    );
    expect(debts).toHaveLength(2);
    expect(debts.find((d) => d.from === 'B' && d.to === 'A')?.amount).toBe(50);
    expect(debts.find((d) => d.from === 'A' && d.to === 'C')?.amount).toBe(50);
    // crucially, B is never told to pay C
    expect(debts.find((d) => d.from === 'B' && d.to === 'C')).toBeUndefined();
  });

  it('reduces a pair debt by a settlement between them', () => {
    const debts = computePairwiseDebts(
      members,
      [{ paidBy: 'A', splits: [{ memberId: 'A', amount: 0 }, { memberId: 'B', amount: 30 }] }],
      [{ fromMember: 'B', toMember: 'A', amount: 30 }],
    );
    expect(debts).toHaveLength(0);
  });

  it('handles a partial settlement', () => {
    const debts = computePairwiseDebts(
      members,
      [{ paidBy: 'A', splits: [{ memberId: 'B', amount: 30 }] }],
      [{ fromMember: 'B', toMember: 'A', amount: 10 }],
    );
    expect(debts[0]).toMatchObject({ from: 'B', to: 'A', amount: 20 });
  });

  it('returns nothing for an all-settled group', () => {
    expect(computePairwiseDebts(members, [], [])).toEqual([]);
  });

  it('uses member names and sorts by amount descending', () => {
    const debts = computePairwiseDebts(
      members,
      [{ paidBy: 'A', splits: [{ memberId: 'B', amount: 10 }, { memberId: 'C', amount: 80 }] }],
      [],
    );
    expect(debts[0]).toMatchObject({ from: 'C', toName: 'Ali', amount: 80 });
    expect(debts[1]).toMatchObject({ from: 'B', fromName: 'Bilal', amount: 10 });
  });
});
