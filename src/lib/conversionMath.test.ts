import { describe, it, expect } from 'vitest';
import { deriveRate, convertAmount, invertRate, formatRate, rateIsSane, RATE_MIN, RATE_MAX } from './conversionMath';

describe('deriveRate', () => {
  it('derives the to-per-from rate from sent and received amounts', () => {
    // Sent 1,000 AED, 76,500 PKR landed → 1 AED = 76.5 PKR
    expect(deriveRate(1000, 76500)).toBeCloseTo(76.5);
  });

  it('derives sub-1 rates for the opposite direction', () => {
    // Sent 76,500 PKR, 1,000 AED landed → 1 PKR ≈ 0.01307 AED
    expect(deriveRate(76500, 1000)).toBeCloseTo(0.013071895, 6);
  });

  it('round-trips: converting with the derived rate returns what was received', () => {
    const rate = deriveRate(1000, 76500)!;
    expect(convertAmount(1000, rate)).toBe(76500);
  });

  it('rejects missing or nonsense inputs', () => {
    expect(deriveRate(0, 500)).toBeNull();
    expect(deriveRate(1000, 0)).toBeNull();
    expect(deriveRate(-5, 100)).toBeNull();
    expect(deriveRate(NaN, 100)).toBeNull();
    expect(deriveRate(1000, Infinity)).toBeNull();
  });

  it('rejects rates outside the sanity window', () => {
    expect(deriveRate(1, 1000000)).toBeNull(); // rate 1,000,000 > RATE_MAX
    expect(deriveRate(1000000, 1)).toBeNull(); // rate 0.000001 < RATE_MIN
  });
});

describe('rateIsSane', () => {
  it('accepts the documented window and rejects outside it', () => {
    expect(rateIsSane(RATE_MIN)).toBe(true);
    expect(rateIsSane(RATE_MAX)).toBe(true);
    expect(rateIsSane(RATE_MIN / 10)).toBe(false);
    expect(rateIsSane(RATE_MAX * 10)).toBe(false);
    expect(rateIsSane(NaN)).toBe(false);
  });
});

describe('invertRate', () => {
  it('inverts within bounds', () => {
    expect(invertRate(76.5)).toBeCloseTo(0.013071895, 6);
    expect(invertRate(0.0131)).toBeCloseTo(76.336, 2);
  });
  it('returns null for zero/invalid rates', () => {
    expect(invertRate(0)).toBeNull();
    expect(invertRate(-1)).toBeNull();
    expect(invertRate(NaN)).toBeNull();
  });
});

describe('convertAmount', () => {
  it('rounds to 2dp like the store does', () => {
    expect(convertAmount(333.33, 76.5)).toBe(25499.75);
  });
});

describe('formatRate', () => {
  it('keeps big rates readable and small rates meaningful', () => {
    expect(formatRate(76.5)).toBe('76.5');
    expect(formatRate(0.013071895)).toBe('0.01307');
    expect(formatRate(283.4567)).toBe('283.46');
    expect(formatRate(NaN)).toBe('—');
  });
});
