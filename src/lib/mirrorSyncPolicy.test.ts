import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRESH_MS,
  DEFAULT_FULL_REFRESH_MS,
  clearCursorDirty,
  emptyCursor,
  isCursorDirty,
  markCursorDirty,
  planMirrorRefresh,
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
