import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRESH_MS,
  DEFAULT_FULL_REFRESH_MS,
  clearCursorDirty,
  coverageSurvives,
  emptyCursor,
  isCursorDirty,
  markCursorDirty,
  noPersistedCoverage,
  normalizePersistedCoverage,
  persistedCoverageIsTrustworthy,
  planMirrorRefresh,
  seedCoverage,
  type MirrorCursor,
} from './mirrorSyncPolicy';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function syncedCursor(overrides: Partial<MirrorCursor> = {}): MirrorCursor {
  return {
    // Synced 10 minutes ago (outside the 2-minute freshness window),
    // full-refreshed an hour ago (inside the 24h window).
    lastSyncedAt: iso(NOW - 10 * 60 * 1000),
    lastFullRefreshAt: iso(NOW - 60 * 60 * 1000),
    dirtyAt: null,
    ...overrides,
  };
}

const plan = (cursor: MirrorCursor, over: Partial<Parameters<typeof planMirrorRefresh>[0]> = {}) =>
  planMirrorRefresh({ cursor, hasCache: true, canIncremental: true, now: NOW, ...over });

describe('markCursorDirty', () => {
  it('preserves both cursors so a local write never forces a full refetch', () => {
    const before = syncedCursor();
    const after = markCursorDirty(before, iso(NOW));
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(after.lastFullRefreshAt).toBe(before.lastFullRefreshAt);
    expect(isCursorDirty(after)).toBe(true);
  });

  it('N successive writes do not reset the incremental cursor (audit H2)', () => {
    const start = syncedCursor();
    let cursor = start;
    for (let i = 0; i < 25; i += 1) {
      cursor = markCursorDirty(cursor, iso(NOW + i * 1000));
      // Every intermediate state must still know where it last synced, and must
      // still plan an incremental diff — never a full table download.
      expect(cursor.lastSyncedAt).toBe(start.lastSyncedAt);
      expect(cursor.lastFullRefreshAt).toBe(start.lastFullRefreshAt);
      expect(plan(cursor)).toBe('incremental-blocking');
    }
    // Re-marking keeps the OLDEST unacknowledged change.
    expect(cursor.dirtyAt).toBe(iso(NOW));
  });

  it('clearCursorDirty leaves the cursors alone', () => {
    const dirty = markCursorDirty(syncedCursor(), iso(NOW));
    const cleared = clearCursorDirty(dirty);
    expect(cleared.dirtyAt).toBeNull();
    expect(cleared.lastSyncedAt).toBe(dirty.lastSyncedAt);
    expect(cleared.lastFullRefreshAt).toBe(dirty.lastFullRefreshAt);
  });
});

describe('planMirrorRefresh', () => {
  it('serves cache when fresh and clean', () => {
    expect(plan(syncedCursor({ lastSyncedAt: iso(NOW - 30 * 1000) }))).toBe('cache');
  });

  it('a dirty mirror beats the freshness window', () => {
    // The F-RT1 symptom: a settlement accepted 5 seconds ago rendered stale
    // because the 2-minute window short-circuited the network entirely.
    const justSynced = syncedCursor({ lastSyncedAt: iso(NOW - 5 * 1000) });
    expect(plan(justSynced)).toBe('cache');
    expect(plan(markCursorDirty(justSynced, iso(NOW)))).toBe('incremental-blocking');
  });

  it('refreshes in the background when merely stale', () => {
    expect(plan(syncedCursor())).toBe('incremental-background');
  });

  it('boundary: exactly at the freshness window is no longer fresh', () => {
    expect(plan(syncedCursor({ lastSyncedAt: iso(NOW - DEFAULT_FRESH_MS) }))).toBe('incremental-background');
    expect(plan(syncedCursor({ lastSyncedAt: iso(NOW - DEFAULT_FRESH_MS + 1) }))).toBe('cache');
  });

  it('keeps the daily full refresh even when a diff would be possible', () => {
    const stale = syncedCursor({ lastFullRefreshAt: iso(NOW - DEFAULT_FULL_REFRESH_MS - 1) });
    expect(plan(stale)).toBe('full');
    expect(plan(markCursorDirty(stale, iso(NOW)))).toBe('full');
  });

  it('full refresh when there is nothing cached', () => {
    expect(plan(syncedCursor(), { hasCache: false })).toBe('full');
    expect(plan(emptyCursor(), { hasCache: false })).toBe('full');
  });

  it('full refresh when there is no watermark to diff from', () => {
    expect(plan(syncedCursor({ lastSyncedAt: null }))).toBe('full');
  });

  it('falls back to full refresh for keys with no incremental fetcher', () => {
    const fresh = syncedCursor({ lastSyncedAt: iso(NOW - 30 * 1000) });
    expect(plan(fresh, { canIncremental: false })).toBe('cache');
    expect(plan(syncedCursor(), { canIncremental: false })).toBe('full');
    expect(plan(markCursorDirty(fresh, iso(NOW)), { canIncremental: false })).toBe('full');
  });

  it('tolerates unparseable timestamps by refreshing rather than trusting them', () => {
    expect(plan(syncedCursor({ lastFullRefreshAt: 'not-a-date' }))).toBe('full');
  });
});

// ── The persisted coverage floor (docs/performance.md §7.1) ────────────────
// Everything below decides whether a claim read back off disk may be believed.
// The asymmetry is the point: getting it wrong in one direction costs a fetch,
// getting it wrong in the other makes a statement of account understate a debt.

const FIVE_YEAR_FLOOR = { since: '2021-09-02T00:00:00.000Z', complete: false };
const COMPLETE_FLOOR = { since: null, complete: true };

describe('normalizePersistedCoverage', () => {
  it('a row written before this shipped proves nothing', () => {
    expect(normalizePersistedCoverage({})).toEqual(noPersistedCoverage());
    expect(normalizePersistedCoverage(undefined)).toEqual(noPersistedCoverage());
    expect(normalizePersistedCoverage(null)).toEqual(noPersistedCoverage());
  });

  it('reads both fields back verbatim', () => {
    expect(normalizePersistedCoverage({ coverageSince: FIVE_YEAR_FLOOR.since, coverageComplete: false }))
      .toEqual(FIVE_YEAR_FLOOR);
    expect(normalizePersistedCoverage({ coverageSince: null, coverageComplete: true }))
      .toEqual(COMPLETE_FLOOR);
  });

  it('a half-written row degrades to LESS of a claim, never more', () => {
    // An empty string is not an instant; a non-boolean is not completeness.
    expect(normalizePersistedCoverage({ coverageSince: '', coverageComplete: false }))
      .toEqual(noPersistedCoverage());
    expect(normalizePersistedCoverage({ coverageComplete: undefined, coverageSince: null }))
      .toEqual(noPersistedCoverage());
    expect(normalizePersistedCoverage({ coverageComplete: 'yes' as unknown as boolean, coverageSince: null }))
      .toEqual(noPersistedCoverage());
  });
});

describe('persistedCoverageIsTrustworthy', () => {
  const trust = (cursor: MirrorCursor, over: Partial<Parameters<typeof planMirrorRefresh>[0]> = {}) =>
    persistedCoverageIsTrustworthy({ cursor, hasCache: true, canIncremental: true, now: NOW, ...over });

  it('trusts the floor when an incremental sync is what runs next', () => {
    // Served straight from cache...
    expect(trust(syncedCursor({ lastSyncedAt: iso(NOW - 30 * 1000) }))).toBe(true);
    // ...and the two incremental plans, which only ever ADD rows.
    expect(trust(syncedCursor())).toBe(true);
    expect(trust(markCursorDirty(syncedCursor(), iso(NOW)))).toBe(true);
  });

  it('does NOT trust it when the daily full refresh is due', () => {
    // The whole reason that refresh exists is that the incremental cursor can
    // have missed a tombstone. Until it lands, the mirror is not known-good.
    expect(trust(syncedCursor({ lastFullRefreshAt: iso(NOW - DEFAULT_FULL_REFRESH_MS - 1) }))).toBe(false);
  });

  it('does NOT trust it with no cache, no watermark, or an unreadable stamp', () => {
    expect(trust(syncedCursor(), { hasCache: false })).toBe(false);
    expect(trust(syncedCursor({ lastSyncedAt: null }))).toBe(false);
    expect(trust(syncedCursor({ lastFullRefreshAt: 'not-a-date' }))).toBe(false);
    expect(trust(emptyCursor(), { hasCache: false })).toBe(false);
  });

  it('seedCoverage hands back nothing at all when the floor is not trusted', () => {
    const trusted = { cursor: syncedCursor(), hasCache: true, canIncremental: true, now: NOW };
    const due = { ...trusted, cursor: syncedCursor({ lastFullRefreshAt: iso(NOW - DEFAULT_FULL_REFRESH_MS - 1) }) };

    expect(seedCoverage(COMPLETE_FLOOR, trusted)).toEqual(COMPLETE_FLOOR);
    expect(seedCoverage(FIVE_YEAR_FLOOR, trusted)).toEqual(FIVE_YEAR_FLOOR);
    // Not "trust it a little" — a narrowed claim is still a claim.
    expect(seedCoverage(COMPLETE_FLOOR, due)).toEqual(noPersistedCoverage());
    expect(seedCoverage(FIVE_YEAR_FLOOR, due)).toEqual(noPersistedCoverage());
  });
});

describe('coverageSurvives', () => {
  const outcome = (over: Partial<Parameters<typeof coverageSurvives>[0]> = {}) =>
    coverageSurvives({ truncated: false, replacedWholeMirror: false, prunedRowCount: 0, ...over });

  it('an ordinary windowed merge leaves the floor standing', () => {
    // The common case by far: nothing removed, nothing under-reported. If this
    // returned false the floor would be dropped on every daily refresh and
    // persisting one would buy nothing.
    expect(outcome()).toBe(true);
  });

  it('a server that under-reported is not evidence for anything', () => {
    expect(outcome({ truncated: true })).toBe(false);
  });

  it('a clear-and-replace takes the floor with it', () => {
    expect(outcome({ replacedWholeMirror: true })).toBe(false);
  });

  it('an in-window reconcile that pruned rows drops the floor', () => {
    // A genuine tombstone and a short page inside the window are
    // indistinguishable here, and the second would leave a hole ABOVE the floor.
    expect(outcome({ prunedRowCount: 1 })).toBe(false);
    expect(outcome({ prunedRowCount: 42 })).toBe(false);
  });
});
