import { describe, expect, it } from 'vitest';
import { formatMoney, formatSignedMoney } from './constants';

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
