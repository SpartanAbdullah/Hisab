// Pure decision logic for the Dexie mirror's sync cursor.
//
// Why this exists as its own module: `mirrorCache.ts` owns Dexie + localStorage
// I/O and can't run in the Node unit suite, but the *rules* below are the part
// that regressed (audit 03-performance H2 / 04-supabase F-RT1). Keeping them
// pure makes them testable.
//
// The rule that used to be broken: a LOCAL write called `markMirrorStale`,
// which deleted the whole sync row — both `lastSyncedAt` (the incremental
// cursor) and `lastFullRefreshAt` (the daily full-refresh stamp). With no
// cursor the next load could only do a full unbounded `select *`, so every
// expense entry re-downloaded the entire transactions table. The mirror is
// already correct at that point (`mirrorPut` ran first), so throwing the cursor
// away bought nothing.
//
// The rule now: "stale" is a separate dirty flag. It never touches the cursors.
// A dirty mirror means "something changed, run the incremental diff and block
// on it so the store gets the fresh rows" — not "forget everything you know".

export const DEFAULT_FRESH_MS = 2 * 60 * 1000;
export const DEFAULT_FULL_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface MirrorCursor {
  /** Incremental watermark: rows with `updated_at` after this are unseen. */
  lastSyncedAt: string | null;
  /** When the last full-table pull ran. Drives the daily forced full refresh. */
  lastFullRefreshAt: string | null;
  /**
   * Set by a local write (`markMirrorStale`) or a remote realtime event.
   * Deliberately NOT a cursor — it only says "re-check now", it never erases
   * what we already synced.
   */
  dirtyAt: string | null;
}

export type MirrorRefreshPlan =
  /** Cache is fresh and clean — no network at all. */
  | 'cache'
  /**
   * Something changed and we can diff cheaply: await the incremental fetch so
   * the caller can re-set its store with the fresh rows. This is what stops a
   * cross-device settlement from rendering old balances (F-RT1).
   */
  | 'incremental-blocking'
  /** Freshness window expired but nothing is known to have changed. */
  | 'incremental-background'
  /** No cursor, no cache, or the daily full-refresh window elapsed. */
  | 'full';

function toMs(value: string | null): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function emptyCursor(): MirrorCursor {
  return { lastSyncedAt: null, lastFullRefreshAt: null, dirtyAt: null };
}

export function isCursorDirty(cursor: MirrorCursor): boolean {
  return Boolean(cursor.dirtyAt);
}

/**
 * Mark a mirror dirty. Preserves BOTH cursors — that is the whole point.
 * Re-marking an already-dirty mirror keeps the first `dirtyAt` (the oldest
 * unacknowledged change), so N writes in a row are indistinguishable from one.
 */
export function markCursorDirty(cursor: MirrorCursor, nowIso: string): MirrorCursor {
  return {
    lastSyncedAt: cursor.lastSyncedAt,
    lastFullRefreshAt: cursor.lastFullRefreshAt,
    dirtyAt: cursor.dirtyAt ?? nowIso,
  };
}

/** Clear the dirty flag after a refresh acknowledged it. Cursors advance separately. */
export function clearCursorDirty(cursor: MirrorCursor): MirrorCursor {
  return { ...cursor, dirtyAt: null };
}

export interface MirrorRefreshPlanInput {
  cursor: MirrorCursor;
  /** Whether the local mirror table has any rows to serve. */
  hasCache: boolean;
  /** Whether an incremental fetcher (`getUpdatedSince`) is wired for this key. */
  canIncremental: boolean;
  now?: number;
  freshMs?: number;
  fullRefreshMs?: number;
}

export function planMirrorRefresh(input: MirrorRefreshPlanInput): MirrorRefreshPlan {
  const { cursor, hasCache, canIncremental } = input;
  const now = input.now ?? Date.now();
  const freshMs = input.freshMs ?? DEFAULT_FRESH_MS;
  const fullRefreshMs = input.fullRefreshMs ?? DEFAULT_FULL_REFRESH_MS;

  // Nothing cached: only a full pull can produce a usable list.
  if (!hasCache) return 'full';

  // Daily reconciliation full pull. Wins over everything else so tombstones
  // and rows that missed an `updated_at` bump still get repaired.
  if (now - toMs(cursor.lastFullRefreshAt) > fullRefreshMs) return 'full';

  // No incremental machinery (or no watermark to diff from): the freshness
  // window is the only lever, and catching up means a full pull.
  if (!canIncremental || !cursor.lastSyncedAt) {
    if (isCursorDirty(cursor)) return 'full';
    return now - toMs(cursor.lastSyncedAt) < freshMs ? 'cache' : 'full';
  }

  // A known change beats the freshness window — this is the fix for
  // "user accepts a settlement and stares at pre-settlement balances".
  if (isCursorDirty(cursor)) return 'incremental-blocking';

  if (now - toMs(cursor.lastSyncedAt) < freshMs) return 'cache';
  return 'incremental-background';
}
