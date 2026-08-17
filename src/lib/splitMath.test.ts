import { describe, expect, it } from 'vitest';
import { computeShares, equalSplits, splitsSumToTotal } from './splitMath';

describe('equalSplits', () => {
  it('splits evenly when it divides cleanly', () => {
    const s = equalSplits(100, ['a', 'b', 'c', 'd']);
    expect(s.map((x) => x.amount)).toEqual([25, 25, 25, 25]);
  });

  it('puts the remainder on the last member (100 / 3)', () => {
    const s = equalSplits(100, ['a', 'b', 'c']);
    expect(s.map((x) => x.amount)).toEqual([33.33, 33.33, 33.34]);
  });

  it('handles a single member', () => {
    expect(equalSplits(42.5, ['solo'])).toEqual([{ memberId: 'solo', amount: 42.5 }]);
  });

  it('returns empty for no members', () => {
    expect(equalSplits(100, [])).toEqual([]);
  });

  it('always sums to the total to the cent (fuzz)', () => {
    const amounts = [10, 100, 33.33, 0.05, 999.99, 7, 1, 250.5, 1000000];
    const counts = [1, 2, 3, 4, 5, 6, 7, 11, 13];
    for (const amount of amounts) {
      for (const n of counts) {
        const ids = Array.from({ length: n }, (_, i) => `m${i}`);
        const splits = equalSplits(amount, ids);
        expect(splits).toHaveLength(n);
        expect(splitsSumToTotal(splits, amount)).toBe(true);
      }
    }
  });

  it('never produces a NaN share', () => {
    for (const s of equalSplits(10, ['a', 'b', 'c'])) {
      expect(Number.isFinite(s.amount)).toBe(true);
    }
  });
});

describe('splitsSumToTotal', () => {
  it('is true when shares match the total', () => {
    expect(splitsSumToTotal([{ memberId: 'a', amount: 50 }, { memberId: 'b', amount: 50 }], 100)).toBe(true);
  });
  it('is false when shares are off by more than a cent', () => {
    expect(splitsSumToTotal([{ memberId: 'a', amount: 40 }], 100)).toBe(false);
  });
});

describe('computeShares', () => {
  const ids = ['a', 'b', 'c'];

  it('rejects an empty participant list', () => {
    const r = computeShares({ amount: 100, participantIds: [], method: 'equal' });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('no_participants');
  });

  it('equal delegates to equalSplits', () => {
    const r = computeShares({ amount: 100, participantIds: ids, method: 'equal' });
    expect(r.valid).toBe(true);
    expect(r.splits.map((s) => s.amount)).toEqual([33.33, 33.33, 33.34]);
  });

  it('exact accepts shares that reconcile', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'exact',
      exact: { a: '50', b: '30', c: '20' },
    });
    expect(r.valid).toBe(true);
    expect(splitsSumToTotal(r.splits, 100)).toBe(true);
  });

  it('exact rejects shares that do not reconcile', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'exact',
      exact: { a: '50', b: '30', c: '5' },
    });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('exact_mismatch');
  });

  it('exact treats blank fields as zero rather than NaN', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'exact',
      exact: { a: '100', b: '', c: undefined as unknown as string },
    });
    expect(r.valid).toBe(true);
    expect(r.splits.map((s) => s.amount)).toEqual([100, 0, 0]);
  });

  it('percentage rejects a total that is not 100', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'percentage',
      percentages: { a: '50', b: '30', c: '10' },
    });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('percentage_mismatch');
  });

  // The whole point of proportionalSplits: 3 × 33.33% of 100 rounds to 99.99,
  // and that stray cent has to land on someone.
  it('percentage stays penny-exact when the slices do not divide cleanly', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'percentage',
      percentages: { a: '33.33', b: '33.33', c: '33.34' },
    });
    expect(r.valid).toBe(true);
    expect(splitsSumToTotal(r.splits, 100)).toBe(true);
  });

  it('shares default an untouched field to one share', () => {
    const r = computeShares({ amount: 90, participantIds: ids, method: 'shares' });
    expect(r.valid).toBe(true);
    expect(r.splits.map((s) => s.amount)).toEqual([30, 30, 30]);
  });

  it('shares weights proportionally and stays penny-exact', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'shares',
      shares: { a: '1', b: '1', c: '1' },
    });
    expect(splitsSumToTotal(r.splits, 100)).toBe(true);
  });

  it('shares rejects an all-zero weighting', () => {
    const r = computeShares({
      amount: 100, participantIds: ids, method: 'shares',
      shares: { a: '0', b: '0', c: '0' },
    });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('shares_zero');
  });

  it('every valid method reconciles to the cent (fuzz)', () => {
    const amounts = [10, 100, 33.33, 0.05, 999.99, 7, 250.5];
    const counts = [1, 2, 3, 5, 7, 11];
    for (const amount of amounts) {
      for (const n of counts) {
        const participantIds = Array.from({ length: n }, (_, i) => `m${i}`);
        for (const method of ['equal', 'shares'] as const) {
          const r = computeShares({ amount, participantIds, method });
          expect(r.valid).toBe(true);
          expect(splitsSumToTotal(r.splits, amount)).toBe(true);
          for (const s of r.splits) expect(Number.isFinite(s.amount)).toBe(true);
        }
      }
    }
  });
});
