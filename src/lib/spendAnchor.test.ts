import { describe, expect, it } from 'vitest';
import { spendAnchor } from './spendAnchor';

describe('spendAnchor', () => {
  it('anchors a meaningful AED sum to a trip home', () => {
    expect(spendAnchor(740, 'AED')).toBe('about a round-trip ticket home ✈️');
  });

  it('anchors a smaller sum to karaks', () => {
    expect(spendAnchor(60, 'AED')).toBe('about 40 karaks ☕');
  });

  it('converts PKR before anchoring', () => {
    // ~AED 500 → trip-home band
    expect(spendAnchor(38_000, 'PKR')).toMatch(/karaks|ticket home/);
  });

  it('returns null for tiny amounts', () => {
    expect(spendAnchor(10, 'AED')).toBeNull();
  });

  it('returns null for very large amounts (no glib comparison)', () => {
    expect(spendAnchor(50_000, 'AED')).toBeNull();
  });

  it('returns null for currencies without a defined comparison', () => {
    expect(spendAnchor(740, 'USD')).toBeNull();
  });

  it('returns null for zero / invalid', () => {
    expect(spendAnchor(0, 'AED')).toBeNull();
    expect(spendAnchor(Number.NaN, 'AED')).toBeNull();
  });
});
