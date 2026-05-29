import type { Table } from 'dexie';
import { db } from '../db';

const DEFAULT_FRESH_MS = 2 * 60 * 1000;
const DEFAULT_FULL_REFRESH_MS = 24 * 60 * 60 * 1000;

interface CacheFirstOptions<T> {
  key: string;
  table: Table<T, string>;
  fetchRemote: () => Promise<T[]>;
  fetchUpdatedSince?: (lastSyncedAt: string) => Promise<T[]>;
  getUpdatedAt?: (row: T) => string | null | undefined;
  sort?: (a: T, b: T) => number;
  freshMs?: number;
  fullRefreshMs?: number;
}

function cacheKey(key: string): string {
  const userId = localStorage.getItem('hisaab_supabase_uid') ?? 'anonymous';
  return `hisaab:mirror:${userId}:${key}:syncedAt`;
}

async function readSyncState(key: string): Promise<{
  lastSyncedAt: string | null;
  lastFullRefreshAt: string | null;
}> {
  try {
    const state = await db.mirrorSync.get(key);
    if (state) {
      return {
        lastSyncedAt: state.lastSyncedAt,
        lastFullRefreshAt: state.lastFullRefreshAt,
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
  return { lastSyncedAt: legacySyncedAt, lastFullRefreshAt: legacySyncedAt };
}

async function writeSyncState(
  key: string,
  lastSyncedAt: string,
  lastFullRefreshAt?: string | null,
) {
  try {
    const previous = await db.mirrorSync.get(key);
    await db.mirrorSync.put({
      key,
      lastSyncedAt,
      lastFullRefreshAt: lastFullRefreshAt ?? previous?.lastFullRefreshAt ?? null,
    });
  } catch (error) {
    reportMirrorError('sync-state write', error);
  }
  localStorage.setItem(cacheKey(key), String(new Date(lastSyncedAt).getTime()));
}

function sortRows<T>(rows: T[], sort?: (a: T, b: T) => number): T[] {
  return sort ? [...rows].sort(sort) : rows;
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
  if (isStorageUnavailable(error)) return;
  console.error(`[mirrorCache] ${action} failed`, error);
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
): string {
  const timestamps = rows
    .map((row) => getUpdatedAt?.(row))
    .filter((value): value is string => Boolean(value));
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
  const remote = sortRows(await fetchRemote(), sort);
  await replaceMirror(table, remote);
  const syncedAt = maxSyncedAt(remote, getUpdatedAt);
  await writeSyncState(key, syncedAt, new Date().toISOString());
  return remote;
}

async function refreshMirrorIncremental<T>({
  key,
  table,
  fetchUpdatedSince,
  sort,
  getUpdatedAt,
}: CacheFirstOptions<T> & { fetchUpdatedSince: (lastSyncedAt: string) => Promise<T[]> }): Promise<T[]> {
  const state = await readSyncState(key);
  if (!state.lastSyncedAt) return [];
  const changed = await fetchUpdatedSince(state.lastSyncedAt);
  if (changed.length === 0) {
    await writeSyncState(key, new Date().toISOString());
    return [];
  }
  await mirrorBulkPut(table, changed);
  await writeSyncState(key, maxSyncedAt(changed, getUpdatedAt));
  return sortRows(await readMirror(table), sort);
}

export async function loadCacheFirst<T>({
  key,
  table,
  fetchRemote,
  fetchUpdatedSince,
  getUpdatedAt,
  sort,
  freshMs = DEFAULT_FRESH_MS,
  fullRefreshMs = DEFAULT_FULL_REFRESH_MS,
}: CacheFirstOptions<T>): Promise<{ rows: T[]; fromCache: boolean }> {
  const cached = await readMirror(table, sort);
  const hasCache = cached.length > 0;
  const state = await readSyncState(key);
  const lastSyncedMs = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0;
  const lastFullRefreshMs = state.lastFullRefreshAt ? new Date(state.lastFullRefreshAt).getTime() : 0;
  const isFresh = Date.now() - lastSyncedMs < freshMs;
  const needsFullRefresh = Date.now() - lastFullRefreshMs > fullRefreshMs;

  if (hasCache && isFresh) {
    return { rows: cached, fromCache: true };
  }

  if (hasCache) {
    if (fetchUpdatedSince && !needsFullRefresh) {
      void refreshMirrorIncremental({ key, table, fetchRemote, fetchUpdatedSince, getUpdatedAt, sort }).catch((err) => {
        console.error(`[mirrorCache] background incremental refresh failed for ${key}`, err);
      });
    } else {
      void refreshMirror({ key, table, fetchRemote, getUpdatedAt, sort }).catch((err) => {
        console.error(`[mirrorCache] background refresh failed for ${key}`, err);
      });
    }
    return { rows: cached, fromCache: true };
  }

  return { rows: await refreshMirror({ key, table, fetchRemote, getUpdatedAt, sort }), fromCache: false };
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

export function markMirrorStale(key: string) {
  localStorage.removeItem(cacheKey(key));
  void db.mirrorSync.delete(key).catch((error) => reportMirrorError('sync-state delete', error));
}
