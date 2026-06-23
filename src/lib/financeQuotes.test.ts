import { describe, it, expect } from 'vitest';
import { FINANCE_QUOTES, quoteForDay, dayOrdinal } from './financeQuotes';

describe('financeQuotes', () => {
  it('every quote is short and attributed', () => {
    expect(FINANCE_QUOTES.length).toBeGreaterThan(10);
    for (const q of FINANCE_QUOTES) {
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.text.length).toBeLessThanOrEqual(110);
      expect(q.author.length).toBeGreaterThan(0);
    }
  });

  it('quoteForDay is deterministic for the same day', () => {
    const d = new Date(2026, 5, 23);
    expect(quoteForDay(d)).toEqual(quoteForDay(new Date(2026, 5, 23, 18, 30)));
  });

  it('rotates across consecutive days and cycles the full list', () => {
    const base = new Date(2026, 0, 1);
    const seen = new Set<string>();
    for (let i = 0; i < FINANCE_QUOTES.length; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      seen.add(quoteForDay(d).text);
    }
    // One full cycle should surface every quote exactly once.
    expect(seen.size).toBe(FINANCE_QUOTES.length);
  });

  it('dayOrdinal advances by one each calendar day', () => {
    expect(dayOrdinal(new Date(2026, 0, 2)) - dayOrdinal(new Date(2026, 0, 1))).toBe(1);
  });
});
