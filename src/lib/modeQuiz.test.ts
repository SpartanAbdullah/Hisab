import { describe, it, expect } from 'vitest';
import { recommendMode, MODE_QUIZ } from './modeQuiz';

describe('recommendMode', () => {
  it('recommends splits_only when it clearly leads', () => {
    expect(recommendMode(['splits_only', 'splits_only', 'full_tracker'])).toBe('splits_only');
  });

  it('recommends full_tracker when it leads', () => {
    expect(recommendMode(['full_tracker', 'full_tracker', 'splits_only'])).toBe('full_tracker');
  });

  it('breaks ties toward full_tracker (the superset)', () => {
    expect(recommendMode(['full_tracker', 'splits_only'])).toBe('full_tracker');
    expect(recommendMode([])).toBe('full_tracker');
  });
});

describe('MODE_QUIZ', () => {
  it('has three questions, each with at least two options', () => {
    expect(MODE_QUIZ).toHaveLength(3);
    for (const q of MODE_QUIZ) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      for (const o of q.options) expect(o.emoji.length).toBeGreaterThan(0);
    }
  });
});
