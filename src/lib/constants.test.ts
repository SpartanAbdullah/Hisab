import { describe, expect, it } from 'vitest';
import { currencySymbol, formatMoney, formatSignedMoney } from './constants';

describe('formatMoney', () => {
  it('formats AED with two decimals', () => {
    expect(formatMoney(1234.5, 'AED')).toBe('AED 1,234.50');
  });

  it('formats PKR with the rupee symbol', () => {
    expect(formatMoney(50000, 'PKR')).toBe('₨ 50,000.00');
  });

  it('formats SAR with the three-letter code', () => {
    expect(formatMoney(100, 'SAR')).toBe('SAR 100.00');
  });

  it('formats PHP with the Philippine peso symbol', () => {
    expect(formatMoney(100, 'PHP')).toBe('₱ 100.00');
  });

  it('falls back to the currency code when no symbol is registered', () => {
    expect(formatMoney(10, 'XYZ')).toBe('XYZ 10.00');
  });

  it('strips sign from absolute value (caller handles sign separately)', () => {
    expect(formatMoney(-500, 'AED')).toBe('AED 500.00');
  });

  it('rounds to two decimals', () => {
    expect(formatMoney(1.005, 'AED')).toBe('AED 1.01'); // banker's may produce 1.00; assert toLocaleString result
    expect(formatMoney(0.1 + 0.2, 'AED')).toBe('AED 0.30');
  });

  it('uses thousands separators', () => {
    expect(formatMoney(1000000, 'AED')).toBe('AED 1,000,000.00');
  });
});

// ISO 4217 minor units, not a hardcoded 2 (founder decision 2026-09-04).
describe('formatMoney across ISO minor units', () => {
  it('renders a zero-decimal currency with no decimals at all', () => {
    expect(formatMoney(1234, 'JPY')).toBe('¥ 1,234');
    expect(formatMoney(1234.56, 'JPY')).toBe('¥ 1,235');
    expect(formatMoney(50000, 'KRW')).toBe('₩ 50,000');
    expect(formatMoney(1500000, 'VND')).toBe('₫ 1,500,000');
  });

  it('renders a three-decimal currency with all three fils', () => {
    expect(formatMoney(12.3456, 'KWD')).toBe('KWD 12.346');
    expect(formatMoney(12.3, 'BHD')).toBe('BHD 12.300');
    expect(formatMoney(1000, 'OMR')).toBe('OMR 1,000.000');
  });

  it('still renders two decimals for everything else', () => {
    expect(formatMoney(99.5, 'USD')).toBe('$ 99.50');
    expect(formatMoney(99.5, 'INR')).toBe('₹ 99.50');
  });

  it('signs zero- and three-decimal currencies correctly', () => {
    expect(formatSignedMoney(-1234, 'JPY')).toBe('-¥ 1,234');
    expect(formatSignedMoney(-12.345, 'KWD')).toBe('-KWD 12.345');
  });
});

describe('currencySymbol', () => {
  it('keeps the eight legacy symbols exactly as shipped', () => {
    expect(currencySymbol('AED')).toBe('AED');
    expect(currencySymbol('PKR')).toBe('₨');
    expect(currencySymbol('PHP')).toBe('₱');
    expect(currencySymbol('SAR')).toBe('SAR');
    expect(currencySymbol('QAR')).toBe('QAR');
    expect(currencySymbol('OMR')).toBe('OMR');
    expect(currencySymbol('KWD')).toBe('KWD');
    expect(currencySymbol('BHD')).toBe('BHD');
  });

  it('uses the ISO symbol for a newly supported currency', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('INR')).toBe('₹');
  });

  it('falls back to the bare code for an unknown currency', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ');
  });
});

describe('formatSignedMoney', () => {
  it('prepends a minus for negative amounts', () => {
    expect(formatSignedMoney(-100, 'AED')).toBe('-AED 100.00');
  });

  it('returns the unsigned form for positive amounts', () => {
    expect(formatSignedMoney(100, 'AED')).toBe('AED 100.00');
  });

  it('returns the unsigned form for zero', () => {
    expect(formatSignedMoney(0, 'AED')).toBe('AED 0.00');
  });
});
