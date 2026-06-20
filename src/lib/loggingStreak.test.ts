import { describe, expect, it } from 'vitest';
import { computeLoggingStreak } from './loggingStreak';

const T = '2026-06-20';

describe('computeLoggingStreak', () => {
  it('counts consecutive days including today', () => {
    const r = computeLoggingStreak(['2026-06-18', '2026-06-19', '2026-06-20'], T);
    expect(r.streak).toBe(3);
    expect(r.loggedToday).toBe(true);
  });

  it('keeps the streak alive when today is not yet logged but yesterday was', () => {
    const r = computeLoggingStreak(['2026-06-18', '2026-06-19'], T);
    expect(r.streak).toBe(2);
    expect(r.loggedToday).toBe(false);
  });

  it('resets when there is a gap (no today and no yesterday)', () => {
    const r = computeLoggingStreak(['2026-06-15', '2026-06-16'], T);
    expect(r.streak).toBe(0);
    expect(r.loggedToday).toBe(false);
  });

  it('counts multiple entries on the same day once', () => {
    const r = computeLoggingStreak(
      ['2026-06-20T08:00:00Z', '2026-06-20T20:00:00Z', '2026-06-19T10:00:00Z'],
      T,
    );
    expect(r.streak).toBe(2);
  });

  it('handles a single day', () => {
    expect(computeLoggingStreak(['2026-06-20'], T)).toEqual({ streak: 1, loggedToday: true });
  });

  it('returns zero for no history', () => {
    expect(computeLoggingStreak([], T)).toEqual({ streak: 0, loggedToday: false });
  });

  it('ignores future-dated noise beyond today without crashing', () => {
    const r = computeLoggingStreak(['2026-06-25', '2026-06-20', '2026-06-19'], T);
    expect(r.streak).toBe(2);
  });

  it('accepts ISO datetimes and date-only strings interchangeably', () => {
    const r = computeLoggingStreak(['2026-06-19T23:30:00Z', '2026-06-20'], '2026-06-20T09:00:00Z');
    expect(r.streak).toBe(2);
    expect(r.loggedToday).toBe(true);
  });
});
