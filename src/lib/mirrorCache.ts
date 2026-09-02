import type { Table } from 'dexie';
import { db } from '../db';
import { getCurrentDatabaseUserId } from '../db/database';
import {
  DEFAULT_FRESH_MS,
  DEFAULT_FULL_REFRESH_MS,
  planMirrorRefresh,
  type MirrorCursor,
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
    });
  } catch (error) {
    reportMirrorError('sync-state write', error);
  }
  localStorage.setItem(cacheKey(key), String(new Date(lastSyncedAt).getTime()));
}

function sortRows<T>(rows: T[], sort?: (a: T, b: T) => number): T[] {
  return sort ? [...rows].sort(sort) : rows;
}

function normalizeRemote<T>(value: T[] | RemoteFetchResult<T>): { rows: T[]; truncated: boolean } {
  if (Array.isArray(value)) return { rows: value, truncated: false };
  return { rows: value.rows, truncated: value.truncated === true };
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

async function refreshMirror<T>({
  key,
  table,
  fetchRemote,
  sort,
  getUpdatedAt,
}: CacheFirstOptions<T>): Promise<T[]> {
  const markSnapshot = currentMark(mirrorSyncKey(key));
  const result = normalizeRemote(await fetchRemote());
  const remote = sortRows(result.rows, sort);

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

  const syncedAt = maxSyncedAt(remote, getUpdatedAt);
  await writeSyncState(key, syncedAt, {
    lastFullRefreshAt: new Date().toISOString(),
    markSnapshot,
  });
  return result.truncated ? await readMirror(table, sort) : remote;
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
