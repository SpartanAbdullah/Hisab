// The persisted coverage floor — the storage half (docs/performance.md §7.1).
//
// `mirrorSyncPolicy.test.ts` proves the RULES in isolation. This file proves
// the wiring: that the real `mirrorCache` writes the floor where it says it
// does, carries it across an ordinary sync, and drops it on exactly the events
// that can leave the mirror unable to back it — no more, no less.
//
// The "no more" half is the one that needs a test at all. A blanket "clear the
// floor whenever anything happens" would pass every safety assertion here and
// silently make persisting a floor worthless: it would be gone again by the
// next daily refresh. The control case below (a windowed refresh that prunes
// nothing) is what pins that down.
//
// Dexie cannot run in the Node suite, so `../db` is replaced by an in-memory
// table that keeps Dexie's shape (get/put/bulkPut/delete/bulkDelete/clear/
// toArray). Everything under test — `loadCacheFirst`, `refreshMirror`,
// `reconcileWindow`, `applyCoverageOutcome`, `writeSyncState` — is the real
// implementation.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => {
  class FakeTable {
    rows = new Map<string, Record<string, unknown>>();
    readonly keyField: string;
    constructor(keyField: string) { this.keyField = keyField; }
    async toArray() { return [...this.rows.values()].map((row) => ({ ...row })); }
    async get(key: string) {
      const row = this.rows.get(key);
      return row ? { ...row } : undefined;
    }
    async put(row: Record<string, unknown>) { this.rows.set(String(row[this.keyField]), { ...row }); }
    async bulkPut(rows: Record<string, unknown>[]) { for (const row of rows) await this.put(row); }
    async delete(key: string) { this.rows.delete(key); }
    async bulkDelete(keys: string[]) { for (const key of keys) this.rows.delete(key); }
    async clear() { this.rows.clear(); }
  }

  const tables = new Map<string, FakeTable>();
  const tableFor = (name: string): FakeTable => {
    const existing = tables.get(name);
    if (existing) return existing;
    // Everything the app mirrors is keyed by `id`; the sync row by `key`.
    const created = new FakeTable(name === 'mirrorSync' ? 'key' : 'id');
    tables.set(name, created);
    return created;
  };

  return {
    db: new Proxy({} as Record<string, FakeTable>, {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return tableFor(property);
      },
    }),
    SUPPORTED_CURRENCIES: ['AED', 'PKR'],
    __tableFor: tableFor,
    __wipe: () => { for (const table of tables.values()) table.rows.clear(); },
  };
});

import * as fakeDb from '../db';
import {
  clearMirrorCoverage,
  loadCacheFirst,
  mirrorSyncKey,
  readMirrorCoverage,
  readMirrorCoverageSeed,
  writeMirrorCoverage,
  type RemoteFetchResult,
} from './mirrorCache';

const tableFor = (fakeDb as unknown as { __tableFor: (name: string) => { rows: Map<string, Record<string, unknown>> } }).__tableFor;
const wipe = (fakeDb as unknown as { __wipe: () => void }).__wipe;

const KEY = 'transactions';
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface Row extends Record<string, unknown> {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const row = (id: string, ageHours: number): Row => ({
  id,
  createdAt: iso(-ageHours * HOUR),
  updatedAt: iso(-ageHours * HOUR),
});

/** Rows inside the window, newest first, plus two the window never reaches. */
const RECENT = [row('r1', 1), row('r2', 2), row('r3', 3)];
const ANCIENT = [row('a1', 30_000), row('a2', 30_001)];
const WINDOW_FLOOR = iso(-24 * HOUR);

function syncRow(): Record<string, unknown> | undefined {
  return tableFor('mirrorSync').rows.get(mirrorSyncKey(KEY));
}

function setCursors(patch: Record<string, unknown>) {
  const current = syncRow();
  if (!current) throw new Error('no sync row yet — run a load first');
  tableFor('mirrorSync').rows.set(mirrorSyncKey(KEY), { ...current, ...patch });
}

function mirrorIds(): string[] {
  return [...tableFor('transactions').rows.keys()].sort();
}

const base = (fetchRemote: () => Promise<Row[] | RemoteFetchResult<Row>>, onRefreshed?: (rows: Row[]) => void) => ({
  key: KEY,
  table: (fakeDb as unknown as { db: Record<string, never> }).db.transactions as never,
  fetchRemote,
  fetchUpdatedSince: async () => [] as Row[],
  fetchDeletedSince: async () => [] as { id: string; deletedAt: string }[],
  getUpdatedAt: (r: Row) => r.updatedAt,
  windowKeyOf: (r: Row) => r.createdAt,
  sort: (a: Row, b: Row) => b.createdAt.localeCompare(a.createdAt),
  onRefreshed,
});

/**
 * Force a full refresh and wait for it to finish.
 *
 * With rows already in the mirror `loadCacheFirst` runs the refresh in the
 * background, so the test resolves on `onRefreshed` — which the mirror fires
 * only after the reconcile, the coverage decision and the cursor write have all
 * landed. A cold mirror is awaited inline and never calls it.
 */
async function forceFullRefresh(fetchRemote: () => Promise<Row[] | RemoteFetchResult<Row>>) {
  if (syncRow()) setCursors({ lastFullRefreshAt: iso(-25 * HOUR), dirtyAt: null });
  let done: () => void = () => {};
  const refreshed = new Promise<void>((resolve) => { done = resolve; });
  const result = await loadCacheFirst<Row>(base(fetchRemote, () => done()));
  if (result.fromCache) await refreshed;
}

/** A windowed fetch: partial by construction, complete from the floor onward. */
const windowed = (rows: Row[], over: Partial<RemoteFetchResult<Row>> = {}): RemoteFetchResult<Row> => ({
  rows,
  truncated: true,
  completeFrom: WINDOW_FLOOR,
  serverTruncated: false,
  ...over,
});

beforeEach(async () => {
  wipe();
  localStorage.removeItem(`hisaab:mirror:${mirrorSyncKey(KEY).split(':')[0]}:${KEY}:syncedAt`);
  // A cold load establishes the mirror rows AND the sync row every case below
  // starts from. Awaited inline (empty mirror ⇒ no background refresh).
  await loadCacheFirst<Row>(base(async () => windowed([...RECENT])));
  await writeMirrorCoverage(KEY, { since: null, complete: true });
});

describe('the persisted floor: where it lives', () => {
  it('round-trips through the sync row', async () => {
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: true });
    await writeMirrorCoverage(KEY, { since: WINDOW_FLOOR, complete: false });
    expect(await readMirrorCoverage(KEY)).toEqual({ since: WINDOW_FLOOR, complete: false });
  });

  it('never invents a sync row just to hold a floor', async () => {
    // A floor with no cursor beside it could never be trusted anyway, and a
    // fabricated `lastSyncedAt` would make the next load skip a real refresh.
    wipe();
    await writeMirrorCoverage(KEY, { since: null, complete: true });
    expect(syncRow()).toBeUndefined();
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
  });

  it('survives an ordinary incremental sync', async () => {
    // The regression this guards: `writeSyncState` rebuilds the row from an
    // object literal on every poll. Without carrying these two fields forward
    // the floor would be gone by the next background sync.
    setCursors({ lastSyncedAt: iso(-10 * 60 * 1000), lastFullRefreshAt: iso(-HOUR) });
    const result = await loadCacheFirst<Row>(base(async () => {
      throw new Error('an incremental sync must not full-fetch');
    }));
    expect(result.fromCache).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: true });
  });

  it('clearMirrorCoverage drops it to nothing proven', async () => {
    await clearMirrorCoverage(KEY);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
    // ...and leaves the cursors alone, so the next load still diffs.
    expect(syncRow()?.lastSyncedAt).toBeTruthy();
  });
});

describe('the persisted floor: what invalidates it', () => {
  it('CONTROL — a windowed refresh that prunes nothing keeps the floor', async () => {
    // The case that must NOT invalidate. Every daily refresh looks like this;
    // if it dropped the floor, persisting one would buy nothing at all.
    let fetches = 0;
    await forceFullRefresh(async () => { fetches += 1; return windowed([...RECENT]); });
    // Not passing because nothing happened: the refresh really ran.
    expect(fetches).toBe(1);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: true });
  });

  it('an in-window reconcile that pruned a row drops the floor', async () => {
    // r2 vanished from the server without a tombstone the incremental feed
    // could report — the exact repair the daily refresh exists for. It is also
    // indistinguishable from a short page, so the claim goes.
    await forceFullRefresh(async () => windowed(RECENT.filter((r) => r.id !== 'r2')));
    expect(mirrorIds()).toEqual(['r1', 'r3']);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
  });

  it('a server truncation warning drops the floor even though nothing was removed', async () => {
    await forceFullRefresh(async () => windowed([...RECENT], { serverTruncated: true }));
    expect(mirrorIds()).toEqual(['r1', 'r2', 'r3']);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
  });

  it('a clear-and-replace takes the floor with it', async () => {
    // No `completeFrom` ⇒ the mirror clears and refills from this fetch alone.
    await forceFullRefresh(async () => [...RECENT, ...ANCIENT]);
    expect(mirrorIds()).toEqual(['a1', 'a2', 'r1', 'r2', 'r3']);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
  });

  it('an unwindowed truncated fetch drops the floor', async () => {
    await forceFullRefresh(async () => ({ rows: [...RECENT], truncated: true }));
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: false });
  });

  it('a remote DELETION reported by the tombstone feed does NOT drop the floor', async () => {
    // The counter-case to the reconcile above: `fetchDeletedSince` names the
    // ids the server says are gone, so it leaves no hole. Invalidating here
    // would drop the floor every time a user deletes an expense.
    setCursors({ lastSyncedAt: iso(-10 * 60 * 1000), lastFullRefreshAt: iso(-HOUR) });
    let done: () => void = () => {};
    const refreshed = new Promise<void>((resolve) => { done = resolve; });
    await loadCacheFirst<Row>({
      ...base(async () => { throw new Error('must not full-fetch'); }, () => done()),
      fetchDeletedSince: async () => [{ id: 'r2', deletedAt: iso(0) }],
    });
    await refreshed;
    expect(mirrorIds()).toEqual(['r1', 'r3']);
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: true });
  });
});

describe('readMirrorCoverageSeed', () => {
  const seed = () => readMirrorCoverageSeed(KEY, { hasCache: true, canIncremental: true });

  it('hands back the floor when an incremental sync is what runs next', async () => {
    setCursors({ lastSyncedAt: iso(-10 * 60 * 1000), lastFullRefreshAt: iso(-HOUR) });
    expect(await seed()).toEqual({ since: null, complete: true });
  });

  it('refuses the floor when the daily full refresh is due', async () => {
    setCursors({ lastSyncedAt: iso(-10 * 60 * 1000), lastFullRefreshAt: iso(-25 * HOUR) });
    expect(await seed()).toEqual({ since: null, complete: false });
    // The floor itself is untouched — it is simply not believed yet.
    expect(await readMirrorCoverage(KEY)).toEqual({ since: null, complete: true });
  });

  it('refuses the floor when the mirror has nothing to serve', async () => {
    setCursors({ lastSyncedAt: iso(-10 * 60 * 1000), lastFullRefreshAt: iso(-HOUR) });
    expect(await readMirrorCoverageSeed(KEY, { hasCache: false, canIncremental: true }))
      .toEqual({ since: null, complete: false });
  });
});
