import { describe, it, expect } from 'vitest';
import { statusSyncToPaid, uncoveredToPaidIds, type CoverableInstallment } from './emiCoverage';

function schedule(parts: Array<[number, number, CoverableInstallment['status']]>): CoverableInstallment[] {
  return parts.map(([installmentNumber, amount, status]) => ({
    id: `i${installmentNumber}`,
    installmentNumber,
    amount,
    status,
  }));
}

describe('uncoveredToPaidIds', () => {
  it('marks the oldest instalments fully covered by the paid amount', () => {
    // 3 × 100; paid 200 covers instalments 1 and 2 only.
    const s = schedule([
      [1, 100, 'upcoming'],
      [2, 100, 'upcoming'],
      [3, 100, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 200)).toEqual(['i1', 'i2']);
  });

  it('does NOT mark an instalment that is only partially covered', () => {
    const s = schedule([
      [1, 100, 'upcoming'],
      [2, 100, 'upcoming'],
    ]);
    // 150 fully covers #1 but only half of #2 → only #1.
    expect(uncoveredToPaidIds(s, 150)).toEqual(['i1']);
  });

  it('marks every instalment on a full payoff (subsumes full-settlement)', () => {
    const s = schedule([
      [1, 100, 'upcoming'],
      [2, 100, 'late'],
      [3, 100, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 300)).toEqual(['i1', 'i2', 'i3']);
  });

  it('skips already-paid instalments but still counts them toward the running total', () => {
    // #1 already paid; paid 200 covers #1 (paid) + #2 → only #2 returned.
    const s = schedule([
      [1, 100, 'paid'],
      [2, 100, 'upcoming'],
      [3, 100, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 200)).toEqual(['i2']);
  });

  it('returns nothing when nothing is covered', () => {
    const s = schedule([[1, 100, 'upcoming']]);
    expect(uncoveredToPaidIds(s, 0)).toEqual([]);
    expect(uncoveredToPaidIds(s, 50)).toEqual([]);
    expect(uncoveredToPaidIds(s, -10)).toEqual([]);
  });

  it('treats a late instalment as eligible to be covered', () => {
    const s = schedule([
      [1, 100, 'late'],
      [2, 100, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 100)).toEqual(['i1']);
  });

  it('tolerates 2dp rounding at the boundary (last instalment absorbs the remainder)', () => {
    // 1000 / 3 = 333.33, last instalment 333.34. Paying the exact total clears all.
    const s = schedule([
      [1, 333.33, 'upcoming'],
      [2, 333.33, 'upcoming'],
      [3, 333.34, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 1000)).toEqual(['i1', 'i2', 'i3']);
    // Paying just the first two instalments worth.
    expect(uncoveredToPaidIds(s, 666.66)).toEqual(['i1', 'i2']);
  });

  it('orders by installmentNumber regardless of input order', () => {
    const s = schedule([
      [3, 100, 'upcoming'],
      [1, 100, 'upcoming'],
      [2, 100, 'upcoming'],
    ]);
    expect(uncoveredToPaidIds(s, 200)).toEqual(['i1', 'i2']);
  });
});

describe('statusSyncToPaid', () => {
  it('matches uncoveredToPaidIds on the forward direction', () => {
    const s = schedule([
      [1, 100, 'upcoming'],
      [2, 100, 'upcoming'],
      [3, 100, 'upcoming'],
    ]);
    expect(statusSyncToPaid(s, 200)).toEqual({ toPaid: ['i1', 'i2'], toUpcoming: [] });
  });

  it('un-marks paid instalments the shrunken paid amount no longer covers (repayment deleted)', () => {
    // All three were paid; a 200 repayment got deleted → only #1 stays covered.
    const s = schedule([
      [1, 100, 'paid'],
      [2, 100, 'paid'],
      [3, 100, 'paid'],
    ]);
    expect(statusSyncToPaid(s, 100)).toEqual({ toPaid: [], toUpcoming: ['i2', 'i3'] });
  });

  it('un-marks everything when the paid amount drops to zero', () => {
    const s = schedule([
      [1, 100, 'paid'],
      [2, 100, 'paid'],
    ]);
    expect(statusSyncToPaid(s, 0)).toEqual({ toPaid: [], toUpcoming: ['i1', 'i2'] });
  });

  it('can move both directions at once for an out-of-order paid gap', () => {
    // #2 was marked paid via a targeted EMI click but #1 was not; total paid
    // covers exactly one instalment → the oldest (#1) should be paid, #2 not.
    const s = schedule([
      [1, 100, 'upcoming'],
      [2, 100, 'paid'],
    ]);
    expect(statusSyncToPaid(s, 100)).toEqual({ toPaid: ['i1'], toUpcoming: ['i2'] });
  });

  it('never un-marks partially covered ones it should keep: boundary rounding', () => {
    const s = schedule([
      [1, 333.33, 'paid'],
      [2, 333.33, 'paid'],
      [3, 333.34, 'paid'],
    ]);
    expect(statusSyncToPaid(s, 666.66)).toEqual({ toPaid: [], toUpcoming: ['i3'] });
    expect(statusSyncToPaid(s, 1000)).toEqual({ toPaid: [], toUpcoming: [] });
  });

  it('clamps a negative paid amount to zero coverage', () => {
    const s = schedule([[1, 100, 'paid']]);
    expect(statusSyncToPaid(s, -50)).toEqual({ toPaid: [], toUpcoming: ['i1'] });
  });
});
