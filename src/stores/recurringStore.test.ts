import { describe, expect, it } from 'vitest';
import { advanceDate } from './recurringStore';

describe('advanceDate', () => {
  it('advances daily by 1 day', () => {
    expect(advanceDate('2026-05-15', 'daily')).toBe('2026-05-16');
  });

  it('advances weekly by 7 days', () => {
    expect(advanceDate('2026-05-15', 'weekly')).toBe('2026-05-22');
  });

  it('advances monthly by 1 month', () => {
    expect(advanceDate('2026-05-15', 'monthly')).toBe('2026-06-15');
  });

  it('advances yearly by 1 year', () => {
    expect(advanceDate('2026-05-15', 'yearly')).toBe('2027-05-15');
  });

  it('handles end-of-month → next month (no rollover surprise)', () => {
    // January has 31 days; +1 day should land on Feb 1.
    expect(advanceDate('2026-01-31', 'daily')).toBe('2026-02-01');
  });

  it('handles year boundary on daily', () => {
    expect(advanceDate('2026-12-31', 'daily')).toBe('2027-01-01');
  });

  it('handles year boundary on weekly', () => {
    expect(advanceDate('2026-12-28', 'weekly')).toBe('2027-01-04');
  });

  it('handles year boundary on monthly', () => {
    expect(advanceDate('2026-12-15', 'monthly')).toBe('2027-01-15');
  });

  it('handles month-end edge: Jan 31 + monthly → Mar 3 (JS month overflow)', () => {
    // JS Date overflow: Jan 31 + 1 month becomes Feb 31 which normalises to Mar 3.
    // This documents the current behaviour. If we ever want "last day of month"
    // semantics this test will need to change.
    expect(advanceDate('2026-01-31', 'monthly')).toBe('2026-03-03');
  });

  it('is timezone-independent (uses UTC math)', () => {
    // Late-day timestamps in the input string must not bleed into a
    // different date in the user's local timezone — we operate purely
    // on the YYYY-MM-DD form.
    expect(advanceDate('2026-03-08', 'daily')).toBe('2026-03-09'); // DST start day
    expect(advanceDate('2026-11-01', 'daily')).toBe('2026-11-02'); // DST end day
  });

  it('handles leap years on yearly', () => {
    // Feb 29 2028 + 1 year → Mar 1 2029 (JS Date overflow normalises Feb 29 → Mar 1)
    expect(advanceDate('2028-02-29', 'yearly')).toBe('2029-03-01');
  });
});
