import type { Table } from 'dexie';
import { db } from '../db';
import { getCurrentDatabaseUserId } from '../db/database';
import {
  DEFAULT_FRESH_MS,
  DEFAULT_FULL_REFRESH_MS,
  coverageSurvives,
  noPersistedCoverage,
  normalizePersistedCoverage,
  planMirrorRefresh,
  seedCoverage,
  type MirrorCursor,
  type MirrorWriteOutcome,
  type PersistedCoverage,
} from './mirrorSyncPolicy';
import { reportError } from './errorReporter';

export { DEFAULT_FRESH_MS, DEFAULT_FULL_REFRESH_MS };
export const CORE_MIRROR_KEYS = ['accounts', 'transactions', 'loans', 'budgets'] as const;
export type CoreMirrorKey = typeof CORE_MIRROR_KEYS[number];

export interface MirrorSyncSnapshot {
  key: CoreMirrorKey;
  lastSyncedAt: string | null;
  lastFullRefreshAt: string | null;
  dirtyAt: string | null;
}

/**
 * A collection fetcher may report that the server did not return everything
 * (PostgREST max-rows). Returning the bare array keeps every existing caller
 * working and means "this is the complete set".
 */
export interface RemoteFetchResult<T> {
  rows: T[];
  truncated?: boolean;
  /**
   * Bounded-window fetches (see `src/lib/historyWindow.ts`): the result is the
   * COMPLETE set only for rows at/after this instant.
   *
   * Present ⇒ the mirror merges instead of replacing (a windowed result is
   * partial by construction, and clearing on a partial result is exactly how a
   * year of history used to vanish from Dexie — audit 04-supabase F-FE1) AND
   * reconciles inside the window: a mirror row at/after `completeFrom` that the
   * fetch did not return was deleted elsewhere, so it is pruned. Rows OLDER
   * than `completeFrom` are outside what this fetch can speak for and are left
   * exactly as they are.
   *
   * Requires `windowKeyOf` on the options to read a row's ordering timestamp.
   */
  completeFrom?: string | null;
  /**
   * The SERVER under-reported — `fetchAllPages`' max-rows probe fired.
   *
   * Distinct from `truncated`, which a *windowed* caller sets to mean "this is
   * a partial set by construction, do not clear the mirror" and which is
   * therefore always true on that path. Only this flag is a reason to distrust
   * what came back, and only this flag invalidates the persisted coverage floor
   * (see `serverUnderReported`). Unwindowed callers have no need for it: for
   * them `truncated` already means exactly this.
   */
  serverTruncated?: boolean;
}

interface CacheFirstOptions<T> {
  key: string;
  table: Table<T, string>;
  fetchRemote: () => Promise<T[] | RemoteFetchResult<T>>;
  fetchUpdatedSince?: (lastSyncedAt: string) => Promise<T[]>;
  fetchDeletedSince?: (lastSyncedAt: string) => Promise<{ id: string; deletedAt: string }[]>;
  getUpdatedAt?: (row: T) => string | null | undefined;
  sort?: (a: T, b: T) => number;
  freshMs?: number;
  fullRefreshMs?: number;
  /**
   * Called when a BACKGROUND refresh lands with rows the caller has not seen.
   * Without this the fresh rows reach Dexie only and the Zustand store keeps
   * rendering the pre-refresh snapshot (audit 04-supabase F-RT1, low-finding 3).
   */
  onRefreshed?: (rows: T[]) => void;
  /**
   * The row's ordering timestamp (`createdAt` for transactions). Only read when
   * `fetchRemote` returns `completeFrom`; without it a windowed fetch degrades
   * to a plain merge with no in-window pruning, which is safe but lets a row
   * deleted on another device linger until `fetchDeletedSince` catches it.
   */
  windowKeyOf?: (row: T) => string;
}

export function mirrorSyncKey(key: string, userId = getCurrentDatabaseUserId()): string {
  return `${userId}:${key}`;
}

export function cacheKey(key: string, userId = getCurrentDatabaseUserId()): string {
  return `hisaab:mirror:${userId}:${key}:syncedAt`;
}

// ── Dirty marks ───────────────────────────────────────────────────────────
// `markMirrorStale` is synchronous and fire-and-forget, but the Dexie write it
// schedules is not — a load issued in the same tick would otherwise read a
// stale row. These in-memory counters make the flag visible immediately, and
// the monotonic marks let a refresh clear ONLY the changes it actually saw:
// a realtime event that lands mid-refresh keeps the mirror dirty instead of
// being swallowed.
const staleMarks = new Map<string, number>();
const clearedMarks = new Map<string, number>();

function currentMark(scopedKey: string): number {
  return staleMarks.get(scopedKey) ?? 0;
}

function isDirtyInMemory(scopedKey: string): boolean {
  return currentMark(scopedKey) > (clearedMarks.get(scopedKey) ?? 0);
}

async function readSyncState(key: string): Promise<MirrorCursor> {
  const scopedKey = mirrorSyncKey(key);
  const memoryDirtyAt = isDirtyInMemory(scopedKey) ? new Date().toISOString() : null;
  try {
    const state = await db.mirrorSync.get(scopedKey);
    if (state) {
      return {
        lastSyncedAt: state.lastSyncedAt,
        lastFullRefreshAt: state.lastFullRefreshAt,
        dirtyAt: memoryDirtyAt ?? state.dirtyAt ?? null,
      };
    }
  } catch (error) {
    reportMirrorError('sync-state read', error);
  }

  const raw = localStorage.getItem(cacheKey(key));
  const parsed = raw ? Number(raw) : 0;
  const legacySyncedAt = Number.isFinite(parsed) && parsed > 0
    ? new Date(parsed).toISOString()
    : null;
  return {
    lastSyncedAt: legacySyncedAt,
    lastFullRefreshAt: legacySyncedAt,
    dirtyAt: memoryDirtyAt,
  };
}

interface WriteSyncStateOptions {
  lastFullRefreshAt?: string | null;
  /**
   * `currentMark()` captured BEFORE the refresh started. Anything marked after
   * that has not been fetched, so the dirty flag survives.
   */
  markSnapshot?: number;
}

async function writeSyncState(
  key: string,
  lastSyncedAt: string,
  options: WriteSyncStateOptions = {},
) {
  const scopedKey = mirrorSyncKey(key);
  const snapshot = options.markSnapshot ?? currentMark(scopedKey);
  const stillDirty = currentMark(scopedKey) > snapshot;
  if (!stillDirty) {
    clearedMarks.set(scopedKey, Math.max(clearedMarks.get(scopedKey) ?? 0, snapshot));
  }
  try {
    const previous = await db.mirrorSync.get(scopedKey);
    await db.mirrorSync.put({
      key: scopedKey,
      lastSyncedAt,
      lastFullRefreshAt: options.lastFullRefreshAt ?? previous?.lastFullRefreshAt ?? null,
      dirtyAt: stillDirty ? (previous?.dirtyAt ?? new Date().toISOString()) : null,
      // Carried forward, never re-derived here. This row is written on every
      // sync; rebuilding it from an object literal without these two fields
      // would silently drop the coverage floor on the next successful poll.
      // Invalidation is explicit and happens BEFORE this write (see
      // `applyCoverageOutcome`), so `previous` already reflects it.
      coverageSince: previous?.coverageSince ?? null,
      coverageComplete: previous?.coverageComplete === true,
    });
  } catch (error) {
    reportMirrorError('sync-state write', error);
  }
  localStorage.setItem(cacheKey(key), String(new Date(lastSyncedAt).getTime()));
}

// ── The persisted coverage floor (docs/performance.md §7.1) ────────────────
// The I/O half. Every RULE lives in `mirrorSyncPolicy.ts` and is unit-tested
// there; nothing below decides anything on its own.
//
// The floor rides on the sync row rather than a table of its own so it can
// never outlive the cursors that vouch for it: the row is per-user-scoped, it
// goes when the per-user Dexie database is deleted at sign-out, and a mirror
// with no cursor row has no floor by construction.

export type { PersistedCoverage } from './mirrorSyncPolicy';

/** The floor exactly as stored — believe it only via `readMirrorCoverageSeed`. */
export async function readMirrorCoverage(key: string): Promise<PersistedCoverage> {
  try {
    return normalizePersistedCoverage(await db.mirrorSync.get(mirrorSyncKey(key)));
  } catch (error) {
    reportMirrorError('coverage read', error);
    return noPersistedCoverage();
  }
}

export interface CoverageSeedOptions {
  /** Whether the local mirror table has rows to serve. */
  hasCache: boolean;
  /** Whether an incremental fetcher is wired for this key. */
  canIncremental: boolean;
  now?: number;
  freshMs?: number;
  fullRefreshMs?: number;
}

/**
 * The floor a session may ADOPT on boot — the persisted one when the cursors
 * say an incremental sync is what runs next, otherwise nothing proven.
 *
 * Returns "nothing proven" on any storage failure too: a device with no usable
 * IndexedDB has no mirror to vouch for, so claiming a floor there would be a
 * pure invention.
 */
export async function readMirrorCoverageSeed(
  key: string,
  options: CoverageSeedOptions,
): Promise<PersistedCoverage> {
  try {
    const [persisted, cursor] = await Promise.all([
      readMirrorCoverage(key),
      readSyncState(key),
    ]);
    return seedCoverage(persisted, {
      cursor,
      hasCache: options.hasCache,
      canIncremental: options.canIncremental,
      now: options.now,
      freshMs: options.freshMs,
      fullRefreshMs: options.fullRefreshMs,
    });
  } catch (error) {
    reportMirrorError('coverage seed', error);
    return noPersistedCoverage();
  }
}

/**
 * Record what the mirror now provably holds.
 *
 * REPLACES the stored floor rather than widening it. The caller's floor is the
 * live one — seeded from disk only when it was trustworthy — so writing it back
 * verbatim is what lets an invalidation actually stick: a session that started
 * without trusting a five-year claim overwrites it with the twelve months it
 * just proved, instead of resurrecting the old claim through a union.
 *
 * Only ever updates an EXISTING sync row. A floor with no cursor beside it
 * could never be trusted anyway (`planMirrorRefresh` returns `'full'` with no
 * watermark), and inventing a cursor row here would fabricate one.
 *
 * MUST be called after the rows are in the mirror, never before.
 */
export async function writeMirrorCoverage(key: string, coverage: PersistedCoverage): Promise<void> {
  const scopedKey = mirrorSyncKey(key);
  try {
    const previous = await db.mirrorSync.get(scopedKey);
    if (!previous) return;
    const next = normalizePersistedCoverage({
      coverageSince: coverage.since,
      coverageComplete: coverage.complete,
    });
    if (previous.coverageSince === next.since && previous.coverageComplete === next.complete) return;
    await db.mirrorSync.put({ ...previous, coverageSince: next.since, coverageComplete: next.complete });
  } catch (error) {
    reportMirrorError('coverage write', error);
  }
}

/** Drop the floor back to "nothing proven". */
export async function clearMirrorCoverage(key: string): Promise<void> {
  const scopedKey = mirrorSyncKey(key);
  try {
    const previous = await db.mirrorSync.get(scopedKey);
    if (!previous) return;
    if (previous.coverageSince == null && previous.coverageComplete !== true) return;
    await db.mirrorSync.put({ ...previous, coverageSince: null, coverageComplete: false });
  } catch (error) {
    reportMirrorError('coverage clear', error);
  }
}

/**
 * Apply a refresh's outcome to the floor. Awaited BEFORE `writeSyncState`, so
 * a floor is never left standing next to a cursor that has already moved past
 * the event which invalidated it.
 */
async function applyCoverageOutcome(key: string, outcome: MirrorWriteOutcome): Promise<void> {
  if (coverageSurvives(outcome)) return;
  await clearMirrorCoverage(key);
}

function sortRows<T>(rows: T[], sort?: (a: T, b: T) => number): T[] {
  return sort ? [...rows].sort(sort) : rows;
}

interface NormalizedRemote<T> {
  rows: T[];
  truncated: boolean;
  completeFrom: string | null | undefined;
  serverTruncated: boolean | undefined;
}

function normalizeRemote<T>(value: T[] | RemoteFetchResult<T>): NormalizedRemote<T> {
  if (Array.isArray(value)) {
    return { rows: value, truncated: false, completeFrom: undefined, serverTruncated: undefined };
  }
  return {
    rows: value.rows,
    truncated: value.truncated === true,
    completeFrom: value.completeFrom,
    serverTruncated: value.serverTruncated,
  };
}

/**
 * Did the SERVER fail to hand back what it was asked for?
 *
 * The explicit flag when the caller set one; otherwise `truncated` — but only
 * for an unwindowed caller, for whom that is what `truncated` has always meant.
 * A windowed caller sets `truncated` on every single fetch (a window is partial
 * by construction), so reading it as a truncation warning there would drop the
 * persisted coverage floor on every daily refresh and make persisting one
 * worthless.
 */
function serverUnderReported<T>(result: NormalizedRemote<T>): boolean {
  if (result.serverTruncated !== undefined) return result.serverTruncated;
  return result.completeFrom == null && result.truncated;
}

function isStorageUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  return (
    name === 'MissingAPIError' ||
    name === 'DatabaseClosedError' ||
    /indexeddb api missing|databaseclosederror/i.test(message)
  );
}

function reportMirrorError(action: string, error: unknown) {
  // Storage-unavailable (private mode, quota, no IndexedDB) is an expected
  // environment outcome, not a bug - it stays silent, as before.
  if (isStorageUnavailable(error)) return;
  reportError(error, { feature: `mirrorCache.${action.replace(/[^a-z]+/gi, '_')}`, extra: { action } });
}

async function readMirror<T>(table: Table<T, string>, sort?: (a: T, b: T) => number): Promise<T[]> {
  try {
    return sortRows(await table.toArray(), sort);
  } catch (error) {
    reportMirrorError('read', error);
    return [];
  }
}

async function replaceMirror<T>(table: Table<T, string>, rows: T[]) {
  try {
    await table.clear();
    if (rows.length > 0) await table.bulkPut(rows);
  } catch (error) {
    reportMirrorError('replace', error);
  }
}

function maxSyncedAt<T>(
  rows: T[],
  getUpdatedAt?: (row: T) => string | null | undefined,
  deletedRows: { deletedAt: string }[] = [],
): string {
  const timestamps = [
    ...rows
    .map((row) => getUpdatedAt?.(row))
    .filter((value): value is string => Boolean(value)),
    ...deletedRows.map((row) => row.deletedAt).filter(Boolean),
  ];
  if (timestamps.length === 0) return new Date().toISOString();
  return timestamps.sort().at(-1) ?? new Date().toISOString();
}

/**
 * The merge paths (truncated, and the bounded window) answer from the mirror,
 * because it is the only place that holds BOTH the rows just fetched and the
 * older ones the fetch could not speak for. On a device with no usable
 * IndexedDB — private mode, a locked-down WebView, a quota failure — every
 * mirror write silently no-ops and that read comes back empty, which would hand
 * the caller an empty list while a perfectly good server response sat in hand.
 * Never return less than we just fetched.
 */
function preferMirror<T>(fromMirror: T[], remote: T[]): T[] {
  return fromMirror.length >= remote.length ? fromMirror : remote;
}

/**
 * Reconcile a bounded-window fetch against the mirror.
 *
 * Merge the rows in, then delete the mirror rows INSIDE the window that the
 * server did not return — those are tombstones the incremental
 * `fetchDeletedSince` path may have missed (it is what the daily full refresh's
 * clear-and-replace used to repair). Rows outside the window are untouched:
 * this fetch has no opinion about them.
 *
 * Returns how many rows it pruned — the persisted coverage floor is dropped
 * when that is non-zero, because a short page inside the window is
 * indistinguishable from a genuine tombstone here and would leave a hole above
 * the floor (see `coverageSurvives`).
 */
async function reconcileWindow<T>(
  table: Table<T, string>,
  remote: T[],
  completeFrom: string,
  windowKeyOf: (row: T) => string,
  idOf: (row: T) => string,
): Promise<number> {
  try {
    if (remote.length > 0) await table.bulkPut(remote);
    const seen = new Set(remote.map(idOf));
    const stale: string[] = [];
    for (const row of await table.toArray()) {
      const at = windowKeyOf(row);
      if (!at || at < completeFrom) continue;
      const id = idOf(row);
      if (!seen.has(id)) stale.push(id);
    }
    if (stale.length > 0) await table.bulkDelete(stale);
    return stale.length;
  } catch (error) {
    reportMirrorError('window reconcile', error);
    return 0;
  }
}

async function refreshMirror<T>({
  key,
  table,
  fetchRemote,
  sort,
  getUpdatedAt,
  windowKeyOf,
}: CacheFirstOptions<T>): Promise<T[]> {
  const markSnapshot = currentMark(mirrorSyncKey(key));
  const result = normalizeRemote(await fetchRemote());
  const remote = sortRows(result.rows, sort);

  if (result.completeFrom !== undefined && result.completeFrom !== null && windowKeyOf) {
    // Bounded window: merge + reconcile inside it, never clear.
    const prunedRowCount = await reconcileWindow(
      table,
      remote,
      result.completeFrom,
      windowKeyOf,
      // Dexie tables here are all keyed by a string `id`.
      (row) => (row as unknown as { id: string }).id,
    );
    await applyCoverageOutcome(key, {
      // NOT `result.truncated` — see `serverUnderReported`. On this path the
      // floor is threatened by the reconcile's pruning, not by the window being
      // a window.
      truncated: serverUnderReported(result),
      replacedWholeMirror: false,
      prunedRowCount,
    });
    const syncedAtWindow = maxSyncedAt(remote, getUpdatedAt);
    await writeSyncState(key, syncedAtWindow, {
      lastFullRefreshAt: new Date().toISOString(),
      markSnapshot,
    });
    return preferMirror(await readMirror(table, sort), remote);
  }

  if (result.truncated) {
    // The server did not hand us the whole table. Clearing here is exactly how
    // a year of history used to disappear from the local mirror (F-FE1), so
    // merge instead: rows we didn't see stay put.
    try {
      if (remote.length > 0) await table.bulkPut(remote);
    } catch (error) {
      reportMirrorError('merge', error);
    }
  } else {
    await replaceMirror(table, remote);
  }

  // Both branches here can leave the mirror unable to back a stored floor: a
  // truncated response is a server that just under-reported, and the replace
  // branch cleared the table outright. The load that issued this fetch writes
  // back whatever it actually proved, immediately after.
  await applyCoverageOutcome(key, {
    truncated: serverUnderReported(result),
    replacedWholeMirror: !result.truncated,
    prunedRowCount: 0,
  });

  const syncedAt = maxSyncedAt(remote, getUpdatedAt);
  await writeSyncState(key, syncedAt, {
    lastFullRefreshAt: new Date().toISOString(),
    markSnapshot,
  });
  return result.truncated ? preferMirror(await readMirror(table, sort), remote) : remote;
}

/** Returns the refreshed rows, or `null` when nothing changed since the cursor. */
async function refreshMirrorIncremental<T>({
  key,
  table,
  fetchUpdatedSince,
  fetchDeletedSince,
  sort,
  getUpdatedAt,
}: CacheFirstOptions<T> & { fetchUpdatedSince: (lastSyncedAt: string) => Promise<T[]> }): Promise<T[] | null> {
  const state = await readSyncState(key);
  if (!state.lastSyncedAt) return null;
  const markSnapshot = currentMark(mirrorSyncKey(key));
  const syncStartedAt = new Date().toISOString();
  const [changed, deleted] = await Promise.all([
    fetchUpdatedSince(state.lastSyncedAt),
    fetchDeletedSince ? fetchDeletedSince(state.lastSyncedAt) : Promise.resolve([]),
  ]);
  if (changed.length === 0 && deleted.length === 0) {
    await writeSyncState(key, syncStartedAt, { markSnapshot });
    return null;
  }
  await mirrorBulkPut(table, changed);
  // Deliberately does NOT touch the persisted coverage floor. `fetchDeletedSince`
  // is an explicit tombstone feed — it names the ids the server says are gone and
  // removes exactly those, leaving no hole above the floor. Dropping the floor
  // here would drop it every time the user deletes an expense, which would make
  // persisting one pointless. (`coverageSurvives` states the same rule.)
  await Promise.all(deleted.map((row) => mirrorDelete(table, row.id)));
  await writeSyncState(key, maxSyncedAt(changed, getUpdatedAt, deleted), { markSnapshot });
  return sortRows(await readMirror(table), sort);
}

export async function loadCacheFirst<T>(
  options: CacheFirstOptions<T>,
): Promise<{ rows: T[]; fromCache: boolean }> {
  const { key, table, fetchUpdatedSince, sort, onRefreshed, freshMs, fullRefreshMs } = options;
  const cached = await readMirror(table, sort);
  const cursor = await readSyncState(key);
  const plan = planMirrorRefresh({
    cursor,
    hasCache: cached.length > 0,
    canIncremental: Boolean(fetchUpdatedSince),
    freshMs,
    fullRefreshMs,
  });

  if (plan === 'cache') {
    return { rows: cached, fromCache: true };
  }

  if (plan === 'incremental-blocking' && fetchUpdatedSince) {
    // Something is known to have changed (local write, or a realtime event from
    // another device / the other side of a cross-user RPC). Awaiting a small
    // diff is what lets the caller re-set its store with correct balances.
    try {
      const rows = await refreshMirrorIncremental({ ...options, fetchUpdatedSince });
      if (rows) return { rows, fromCache: false };
    } catch (error) {
      // Offline or a flaky hop must never blank the screen: fall back to cache.
      reportError(error, { feature: 'mirrorCache.incrementalRefreshBlocking', extra: { mirror: key } });
    }
    return { rows: cached, fromCache: true };
  }

  if (plan === 'incremental-background' && fetchUpdatedSince) {
    void refreshMirrorIncremental({ ...options, fetchUpdatedSince })
      .then((rows) => {
        if (rows && onRefreshed) onRefreshed(rows);
      })
      .catch((err) => {
        reportError(err, { feature: 'mirrorCache.incrementalRefreshBackground', extra: { mirror: key } });
      });
    return { rows: cached, fromCache: true };
  }

  // 'full' — and the incremental fallbacks above when no fetcher is wired.
  if (cached.length > 0) {
    void refreshMirror(options)
      .then((rows) => {
        if (onRefreshed) onRefreshed(rows);
      })
      .catch((err) => {
        reportError(err, { feature: 'mirrorCache.backgroundRefresh', extra: { mirror: key } });
      });
    return { rows: cached, fromCache: true };
  }

  return { rows: await refreshMirror(options), fromCache: false };
}

export async function mirrorPut<T>(table: Table<T, string>, row: T) {
  try {
    await table.put(row);
  } catch (error) {
    reportMirrorError('put', error);
  }
}

export async function mirrorBulkPut<T>(table: Table<T, string>, rows: T[]) {
  try {
    if (rows.length > 0) await table.bulkPut(rows);
  } catch (error) {
    reportMirrorError('bulkPut', error);
  }
}

export async function mirrorDelete<T>(table: Table<T, string>, id: string) {
  try {
    await table.delete(id);
  } catch (error) {
    reportMirrorError('delete', error);
  }
}

/**
 * Mark a mirror as having unseen changes.
 *
 * This used to DELETE the sync row, which threw away the incremental cursor and
 * the daily-full-refresh stamp — so every money write forced a full unbounded
 * re-download of the table (audit 03-performance H2). The mirror is already
 * correct at this point (`mirrorPut` runs first), so all we need is a flag that
 * says "run the diff on the next load". Both cursors are preserved.
 */
export function markMirrorStale(key: string) {
  const scopedKey = mirrorSyncKey(key);
  staleMarks.set(scopedKey, currentMark(scopedKey) + 1);
  const dirtyAt = new Date().toISOString();
  void (async () => {
    try {
      const previous = await db.mirrorSync.get(scopedKey);
      // No persisted cursor yet — the in-memory mark carries this session, and
      // a cold start with no cursor full-refreshes anyway.
      if (!previous || previous.dirtyAt) return;
      await db.mirrorSync.put({ ...previous, dirtyAt });
    } catch (error) {
      reportMirrorError('sync-state dirty', error);
    }
  })();
}

export async function getCoreMirrorSyncSnapshots(): Promise<MirrorSyncSnapshot[]> {
  return Promise.all(
    CORE_MIRROR_KEYS.map(async (key) => ({
      key,
      ...(await readSyncState(key)),
    })),
  );
}
