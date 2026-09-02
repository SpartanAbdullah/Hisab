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

// ── The persisted coverage floor (docs/performance.md §7.1) ─────────────────
//
// `historyCoverage` in the transaction store answers "what does this app PROVE
// it is holding". It was session state: a returning user with a warm five-year
// mirror woke up claiming nothing and paid a full walk on their first
// statement. The floor is now written next to the cursors above so it can
// survive a restart.
//
// The danger this half of the module exists to prevent is the opposite one: a
// persisted claim that OUTLIVES the data it describes. A floor read back from
// disk is a promise about rows that are only still there if nothing removed
// them in between — so it is trusted under exactly one condition, and dropped
// on every event that could have punched a hole in it.

/** The floor as it is stored: the same two fields as `HistoryCoverage`. */
export interface PersistedCoverage {
  /** Complete from this instant onward. `null` + `!complete` = nothing proven. */
  since: string | null;
  /** The whole table is held. `since` is then irrelevant. */
  complete: boolean;
}

export function noPersistedCoverage(): PersistedCoverage {
  return { since: null, complete: false };
}

/**
 * Read the two stored fields into a floor, defaulting to "nothing proven".
 *
 * Deliberately paranoid about the shapes a Dexie row can come back as — a row
 * written before this shipped has neither field, and a partially-written row
 * (`coverageComplete` set, `coverageSince` lost) must degrade to LESS of a
 * claim, never more.
 */
export function normalizePersistedCoverage(
  row: { coverageSince?: string | null; coverageComplete?: boolean } | null | undefined,
): PersistedCoverage {
  if (!row) return noPersistedCoverage();
  const complete = row.coverageComplete === true;
  const since = typeof row.coverageSince === 'string' && row.coverageSince.length > 0
    ? row.coverageSince
    : null;
  if (complete) return { since, complete: true };
  if (!since) return noPersistedCoverage();
  return { since, complete: false };
}

/**
 * May a floor read back from disk be believed?
 *
 * ONLY when the very next thing this mirror will do is an incremental sync —
 * i.e. `planMirrorRefresh` is anything but `'full'`. A `'full'` plan means one
 * of three things, and all three say the same thing about the floor:
 *
 * - **no cache** — the mirror is empty, so it holds nothing at all;
 * - **the daily full refresh is due** — that refresh exists precisely because
 *   the incremental cursor can have missed a tombstone or a row that never got
 *   its `updated_at` bumped, so the mirror is not known-good until it lands;
 * - **no usable watermark** — nothing to diff from, so nothing to vouch for
 *   what the mirror contains.
 *
 * A stale floor is worse than an extra fetch: it makes a statement of account
 * compute over rows it only THINKS are all there. So the untrusted case does
 * not "trust a little" — it claims nothing and lets the refresh that is about
 * to run re-establish the floor from what it actually proved.
 */
export function persistedCoverageIsTrustworthy(input: MirrorRefreshPlanInput): boolean {
  return planMirrorRefresh(input) !== 'full';
}

/** The floor to seed a session with: the persisted one, or nothing. */
export function seedCoverage(
  persisted: PersistedCoverage,
  input: MirrorRefreshPlanInput,
): PersistedCoverage {
  return persistedCoverageIsTrustworthy(input) ? persisted : noPersistedCoverage();
}

/** What a mirror-write did, in the only terms the floor cares about. */
export interface MirrorWriteOutcome {
  /** The server did not hand back the whole set (PostgREST max-rows / pager cap). */
  truncated: boolean;
  /** The table was cleared and refilled from this fetch alone. */
  replacedWholeMirror: boolean;
  /** Rows the in-window reconcile deleted because the fetch did not return them. */
  prunedRowCount: number;
}

/**
 * Does the persisted floor survive this write?
 *
 * Three ways a write can leave the mirror unable to back the claim:
 *
 * 1. **`truncated`** — the response was short of the truth. Nothing was
 *    removed (the truncated path merges, never clears — F-FE1), but a server
 *    that just under-reported is not evidence for anything.
 * 2. **`replacedWholeMirror`** — `clear()` then refill. Every row below the
 *    floor is gone unless this one fetch returned it.
 * 3. **`prunedRowCount > 0`** — the in-window reconcile removed rows the fetch
 *    did not return. That is the right repair for a tombstone the incremental
 *    feed missed, but a short page inside the window looks identical from here
 *    and would punch a hole ABOVE the floor.
 *
 * Note what is deliberately NOT here: the incremental path's
 * `fetchDeletedSince`. That is an explicit tombstone list — it names the ids
 * the server says are gone and removes exactly those. It leaves no hole, and
 * invalidating on it would drop the floor every time a user deletes an expense,
 * which would make persisting one pointless.
 */
export function coverageSurvives(outcome: MirrorWriteOutcome): boolean {
  if (outcome.truncated) return false;
  if (outcome.replacedWholeMirror) return false;
  return outcome.prunedRowCount === 0;
}
