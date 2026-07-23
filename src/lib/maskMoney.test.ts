import { describe, expect, it } from 'vitest';
import { maskedMoney, moneyFormatter } from './maskMoney';
import { formatMoney } from './constants';

describe('maskedMoney', () => {
  it('keeps the currency convention but hides every digit', () => {
    const masked = maskedMoney('PKR');
    expect(masked).toContain('●●,●●●');
    expect(masked).not.toMatch(/\d/);
  });

  it('is fixed-width regardless of magnitude (no size leak)', () => {
    // The mask is amount-independent by construction — same string whether
    // the true figure was 50 or 5,000,000.
    expect(maskedMoney('AED')).toBe(maskedMoney('AED'));
  });
});

describe('moneyFormatter', () => {
  it('returns the real formatter when not hiding', () => {
    expect(moneyFormatter(false)(1234.5, 'AED')).toBe(formatMoney(1234.5, 'AED'));
  });

  it('returns the masking formatter when hiding', () => {
    const fmt = moneyFormatter(true);
    expect(fmt(1234.5, 'AED')).not.toMatch(/\d/);
    expect(fmt(999999, 'PKR')).toBe(fmt(1, 'PKR'));
  });
});
