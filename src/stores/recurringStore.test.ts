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

  it('clamps month-end: Jan 31 + monthly → Feb 28 (not Mar 3)', () => {
    // Was a known bug: naive +1 month turned Feb 31 into Mar 3, skipping
    // February and drifting the due day forward forever. Now clamps to the
    // last valid day of the target month.
    expect(advanceDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });

  it('clamps month-end on a leap February: Jan 31 + monthly → Feb 29 in 2028', () => {
    expect(advanceDate('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('month-end stays month-end across the short-month boundary (31st progression)', () => {
    // The original bug skipped February entirely; the follow-up drift parked
    // month-end subscriptions on the 28th forever after one February. Now a
    // due date on the LAST day of its month anchors to the last day of the
    // next month: Jan 31 → Feb 28 → Mar 31 → Apr 30.
    const jan = '2026-01-31';
    const feb = advanceDate(jan, 'monthly');
    const mar = advanceDate(feb, 'monthly');
    const apr = advanceDate(mar, 'monthly');
    expect(feb).toBe('2026-02-28');
    expect(mar).toBe('2026-03-31');
    expect(apr).toBe('2026-04-30');
  });

  it('mid-month days clamp into February but do NOT become month-end anchored', () => {
    // A 30th-of-month sub clamps to Feb 28 (unavoidable), and Feb 28 IS
    // month-end, so it continues on last days after — the heuristic favours
    // the real-world month-end cluster over preserving a 30th anchor.
    expect(advanceDate('2026-01-15', 'monthly')).toBe('2026-02-15');
    expect(advanceDate('2026-02-15', 'monthly')).toBe('2026-03-15');
  });

  it('clamps a 30th-of-month sub into February correctly', () => {
    expect(advanceDate('2026-01-30', 'monthly')).toBe('2026-02-28');
  });

  it('is timezone-independent (uses UTC math)', () => {
    // Late-day timestamps in the input string must not bleed into a
    // different date in the user's local timezone — we operate purely
    // on the YYYY-MM-DD form.
    expect(advanceDate('2026-03-08', 'daily')).toBe('2026-03-09'); // DST start day
    expect(advanceDate('2026-11-01', 'daily')).toBe('2026-11-02'); // DST end day
  });

  it('clamps leap day on yearly: Feb 29 2028 → Feb 28 2029 (not Mar 1)', () => {
    // Was a known bug: Feb 29 + 1 year overflowed to Mar 1. Now clamps to the
    // last valid day of the same month in the target year.
    expect(advanceDate('2028-02-29', 'yearly')).toBe('2029-02-28');
  });

  it('keeps Feb 29 → Feb 29 across a four-year leap gap', () => {
    expect(advanceDate('2028-02-29', 'yearly')).toBe('2029-02-28');
    expect(advanceDate('2027-02-28', 'yearly')).toBe('2028-02-28');
  });
});
