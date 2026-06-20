import { describe, expect, it } from 'vitest';
import { equalSplits, splitsSumToTotal } from './splitMath';

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
