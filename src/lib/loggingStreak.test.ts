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
    // Noon UTC is safely mid-day for any realistic device offset (this repo
    // does not pin the test process's timezone — see localDate.test.ts for
    // why boundary-crossing instants can't be asserted this way), so this
    // stays about FORMAT handling, not the local-day boundary itself.
    const r = computeLoggingStreak(['2026-06-19T12:00:00Z', '2026-06-20'], '2026-06-20T09:00:00Z');
    expect(r.streak).toBe(2);
    expect(r.loggedToday).toBe(true);
  });

  it('attributes a full ISO timestamp to its LOCAL calendar day, not the UTC day (F-11/F-18)', () => {
    // Same fixed-offset technique as localDate.test.ts: this repo's test
    // process timezone is unpinned, so we can't rely on `new Date(...)`
    // local getters to reproduce a UTC+4 market's midnight gap deterministically.
    // Instead we precompute the LOCAL day a Dubai device would derive via
    // `localIso` (shift the UTC instant by the fixed market offset, then
    // read its UTC calendar fields) and feed that in as an already-resolved
    // bare day-key — exercising the streak-counting logic on the exact
    // value `dayOf` is now required to produce for this instant on a real
    // device, without depending on this process's own offset.
    const loggedAt = new Date('2026-09-02T22:30:00Z'); // 22:30 UTC
    const localDay = new Date(loggedAt.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
    expect(localDay).toBe('2026-09-03'); // already tomorrow at UTC+4
    // If a Sep-2 entry also exists, a Sep-3-local log continues the streak
    // into a 2-day run ending "today" (Sep 3 local) — the old UTC-slice
    // derivation would have filed the 22:30Z entry under Sep 2 instead,
    // making Sep 3 look unlogged and breaking the streak at 1.
    const r = computeLoggingStreak(['2026-09-02', localDay], localDay);
    expect(r).toEqual({ streak: 2, loggedToday: true });
  });
});
