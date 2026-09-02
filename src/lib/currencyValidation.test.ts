import { describe, expect, it } from 'vitest';
import {
  plausibilityCheck,
  approxOther,
  requiresDeliberateConfirm,
  checkMoneyAmount,
  CURRENCY_BOUNDS,
  MAX_MONEY_MAGNITUDE,
} from './currencyValidation';
import { SUPPORTED_CURRENCIES } from '../db/types';

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

  it('passes any amount for an UNRECOGNISED currency code', () => {
    // Validating the code itself is the DB whitelist's job, not this
    // function's — but every SHIPPED currency must now have bounds (below).
    expect(plausibilityCheck(999_999, 'USD').passed).toBe(true);
  });
});

// ── Audit V-2 / F-15: bounds existed for AED and PKR only ──────────────────
describe('CURRENCY_BOUNDS covers every shipped currency', () => {
  it('has a window for all eight SUPPORTED_CURRENCIES', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(CURRENCY_BOUNDS[currency], `no bounds for ${currency}`).toBeDefined();
    }
    // No stragglers: the map and the shipped list agree exactly, so adding a
    // ninth currency without bounds fails here instead of silently shipping
    // an unbounded one.
    expect(Object.keys(CURRENCY_BOUNDS).sort()).toEqual([...SUPPORTED_CURRENCIES].sort());
  });

  it('gives every currency a sane, ordered window', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const { min, max } = CURRENCY_BOUNDS[currency];
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(min);
      expect(max).toBeLessThan(MAX_MONEY_MAGNITUDE);
    }
  });

  it('blocks a figure typed in the wrong Gulf currency (the KWD case)', () => {
    // 40,000 is an ordinary AED salary figure and an absurd KWD one — a KWD is
    // worth ~12 AED. This is exactly the typo the six new windows exist for;
    // before this change it passed silently.
    expect(plausibilityCheck(40_000, 'AED').passed).toBe(false); // warn (AED↔PKR)
    expect(plausibilityCheck(40_000, 'KWD').severity).toBe('block');
    expect(plausibilityCheck(40_000, 'OMR').severity).toBe('block');
    expect(plausibilityCheck(40_000, 'BHD').severity).toBe('block');
  });

  it('accepts ordinary amounts in each of the six newly-bounded currencies', () => {
    expect(plausibilityCheck(1_200, 'SAR').passed).toBe(true);
    expect(plausibilityCheck(1_200, 'QAR').passed).toBe(true);
    expect(plausibilityCheck(25_000, 'PHP').passed).toBe(true);
    expect(plausibilityCheck(150, 'OMR').passed).toBe(true);
    expect(plausibilityCheck(150, 'BHD').passed).toBe(true);
    expect(plausibilityCheck(150, 'KWD').passed).toBe(true);
  });

  it('warns rather than blocks on a suspiciously small figure', () => {
    expect(plausibilityCheck(0.01, 'PHP').severity).toBe('warn');
    expect(plausibilityCheck(0.01, 'SAR').severity).toBe('warn');
  });
});

// ── Audit V-1 / F-9: the store-level gate ──────────────────────────────────
describe('checkMoneyAmount', () => {
  it('rejects everything that is not a finite number', () => {
    expect(checkMoneyAmount(Number.NaN)).toBe('not_a_number');
    expect(checkMoneyAmount(Number.POSITIVE_INFINITY)).toBe('not_a_number');
    expect(checkMoneyAmount(Number.NEGATIVE_INFINITY)).toBe('not_a_number');
    // parseFloat('') and a missing form field both arrive as these.
    expect(checkMoneyAmount(undefined as unknown as number)).toBe('not_a_number');
    expect(checkMoneyAmount(null as unknown as number)).toBe('not_a_number');
    expect(checkMoneyAmount('50' as unknown as number)).toBe('not_a_number');
  });

  it('rejects zero and negatives by default', () => {
    expect(checkMoneyAmount(0)).toBe('not_positive');
    expect(checkMoneyAmount(-0.01)).toBe('not_positive');
    expect(checkMoneyAmount(-99_999)).toBe('not_positive');
  });

  it('accepts zero only when the caller opts in, and never a negative', () => {
    // Zero-cash investment rows (bonus shares at price 0) and a zero opening
    // balance are the only legitimate zeroes.
    expect(checkMoneyAmount(0, { allowZero: true })).toBeNull();
    expect(checkMoneyAmount(-0.01, { allowZero: true })).toBe('not_positive');
  });

  it('rejects absurd magnitudes at the shared 1e12 ceiling', () => {
    expect(checkMoneyAmount(MAX_MONEY_MAGNITUDE)).toBe('too_large');
    expect(checkMoneyAmount(MAX_MONEY_MAGNITUDE + 1)).toBe('too_large');
    expect(checkMoneyAmount(1e300)).toBe('too_large');
    // Just inside is fine — the ceiling is a garbage-data guard, not a policy
    // on how much money a person may record.
    expect(checkMoneyAmount(MAX_MONEY_MAGNITUDE - 1)).toBeNull();
  });

  it('stays cent-exact below the ceiling (the reason 1e12 was chosen)', () => {
    // Math.round(x * 100) / 100 is the rounding used app-wide; it is exact
    // only while x * 100 <= Number.MAX_SAFE_INTEGER.
    expect(MAX_MONEY_MAGNITUDE * 100).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('accepts ordinary money', () => {
    expect(checkMoneyAmount(0.01)).toBeNull();
    expect(checkMoneyAmount(1)).toBeNull();
    expect(checkMoneyAmount(1_234.56)).toBeNull();
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
  it('now has a threshold for every shipped currency, not just AED/PKR', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const big = CURRENCY_BOUNDS[currency].max;
      expect(
        requiresDeliberateConfirm({ amount: big, currency }),
        `${currency} near its ceiling should ask for a deliberate confirm`,
      ).toBe(true);
    }
  });
  it('is true when plausibility warned', () => {
    expect(requiresDeliberateConfirm({ plausibilityWarn: true })).toBe(true);
  });
});
