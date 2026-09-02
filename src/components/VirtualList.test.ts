import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCK_STEP,
  DEFAULT_INITIAL_BLOCKS,
  clampBlockCount,
  estimateGroupHeight,
  nextBlockCount,
} from './VirtualList';

// Only the PURE window math is tested here (the repo's testing philosophy —
// vitest runs in Node with no DOM). The hook's IntersectionObserver wiring and
// the `content-visibility` block are verified by hand in the browser.

describe('nextBlockCount', () => {
  it('grows by the step and never past the total', () => {
    expect(nextBlockCount(8, 100, 8)).toBe(16);
    expect(nextBlockCount(96, 100, 8)).toBe(100);
    expect(nextBlockCount(100, 100, 8)).toBe(100);
  });

  it('is a no-op when the list is empty', () => {
    expect(nextBlockCount(8, 0, 8)).toBe(0);
  });

  it('shrinks to the total when the list shrank under it (a filter change)', () => {
    // The observer callback can fire with a stale `current` after the filtered
    // list collapsed; the result must still be renderable.
    expect(nextBlockCount(40, 3, 8)).toBe(3);
  });

  it('never returns 0 for a non-empty list — a zero window can never intersect', () => {
    expect(nextBlockCount(0, 5, 0)).toBe(1);
    expect(clampBlockCount(0, 5)).toBe(1);
    expect(clampBlockCount(-3, 5)).toBe(1);
  });
});

describe('estimateGroupHeight', () => {
  it('scales with the row count and is never zero', () => {
    expect(estimateGroupHeight(0)).toBeGreaterThan(0);
    expect(estimateGroupHeight(3)).toBeGreaterThan(estimateGroupHeight(1));
  });
});

describe('defaults', () => {
  it('reveal a screenful first, then a screenful at a time', () => {
    expect(DEFAULT_INITIAL_BLOCKS).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_BLOCK_STEP).toBeGreaterThan(0);
  });
});
