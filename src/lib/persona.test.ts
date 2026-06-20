import { describe, expect, it } from 'vitest';
import { flavor } from './persona';

const FACT = "You've spent AED 740 on dining this month.";

describe('flavor', () => {
  it('leaves the fact untouched in balanced mode', () => {
    expect(flavor(FACT, 'balanced')).toBe(FACT);
  });

  it('adds a cheeky closer in roast mode (and keeps the fact intact)', () => {
    const out = flavor(FACT, 'roast');
    expect(out.startsWith(FACT)).toBe(true);
    expect(out.length).toBeGreaterThan(FACT.length);
  });

  it('adds a gentle closer in chill mode', () => {
    const out = flavor(FACT, 'chill');
    expect(out.startsWith(FACT)).toBe(true);
    expect(out).not.toBe(FACT);
  });

  it('NEVER roasts a serious (money-tight) reply, even on the roast dial', () => {
    const serious = "Your balance won't cover rent on the 1st.";
    expect(flavor(serious, 'roast', true)).toBe(serious);
  });

  it('is deterministic — same fact always reads the same way', () => {
    expect(flavor(FACT, 'roast')).toBe(flavor(FACT, 'roast'));
  });

  it('returns empty input unchanged', () => {
    expect(flavor('', 'roast')).toBe('');
  });
});
