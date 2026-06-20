import { describe, expect, it } from 'vitest';
import { plausibilityCheck, approxOther, requiresDeliberateConfirm } from './currencyValidation';

describe('plausibilityCheck', () => {
  it('blocks zero, negative and NaN', () => {
    expect(plausibilityCheck(0, 'AED').severity).toBe('block');
    expect(plausibilityCheck(-5, 'AED').severity).toBe('block');
    expect(plausibilityCheck(Number.NaN, 'AED').severity).toBe('block');
  });

  it('blocks absurdly large amounts (gross typo)', () => {
    const r = plausibilityCheck(60_000, 'AED');
    expect(r.passed).toBe(false);
    expect(r.severity).toBe('block');
  });

  it('warns when an AED amount looks like a PKR figure', () => {
    const r = plausibilityCheck(25_000, 'AED');
    expect(r.passed).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/PKR/);
  });

  it('warns when a PKR amount looks like an AED figure', () => {
    const r = plausibilityCheck(50, 'PKR');
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/AED/);
  });

  it('passes normal amounts', () => {
    expect(plausibilityCheck(500, 'AED').passed).toBe(true);
    expect(plausibilityCheck(38_000, 'PKR').passed).toBe(true);
  });

  it('passes any amount for currencies without bounds', () => {
    expect(plausibilityCheck(999_999, 'USD').passed).toBe(true);
  });
});

describe('approxOther', () => {
  it('converts AED to an approximate PKR string', () => {
    expect(approxOther(500, 'AED')).toBe('≈ 38,000 PKR');
  });
  it('converts PKR to an approximate AED string', () => {
    expect(approxOther(38_000, 'PKR')).toBe('≈ 500 AED');
  });
  it('returns null for unsupported currencies', () => {
    expect(approxOther(10, 'USD')).toBeNull();
  });
});

describe('requiresDeliberateConfirm', () => {
  it('is true for cross-user actions', () => {
    expect(requiresDeliberateConfirm({ crossUser: true })).toBe(true);
  });
  it('is true for irreversible cascades and currency-locked creates', () => {
    expect(requiresDeliberateConfirm({ irreversibleCascade: true })).toBe(true);
    expect(requiresDeliberateConfirm({ currencyLocked: true })).toBe(true);
  });
  it('is true when an amount is over the high threshold', () => {
    expect(requiresDeliberateConfirm({ amount: 6_000, currency: 'AED' })).toBe(true);
    expect(requiresDeliberateConfirm({ amount: 200_000, currency: 'PKR' })).toBe(true);
  });
  it('is false for a small routine single-user add', () => {
    expect(requiresDeliberateConfirm({ amount: 100, currency: 'AED' })).toBe(false);
  });
  it('is true when plausibility warned', () => {
    expect(requiresDeliberateConfirm({ plausibilityWarn: true })).toBe(true);
  });
});
