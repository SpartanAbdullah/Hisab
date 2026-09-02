// The coverage floor across a restart (docs/performance.md §7.1).
//
// `historyCoverage` was session state: a returning user with a warm five-year
// mirror woke up claiming nothing and paid a full keyset walk on their first
// statement. The floor is now persisted next to the mirror's sync cursors — and
// the whole risk of doing that is a claim which OUTLIVES the data it describes.
// A statement of account built on a stale claim does not look broken. It looks
// finished, and it understates a debt.
//
// So these tests are mostly about the cases where the floor must be IGNORED.
//
// Dexie cannot run in the Node suite, so `../db` is an in-memory table with
// Dexie's shape; a "restart" is the Zustand state being thrown away while that
// table and its sync row survive, which is exactly what a page reload does. The
// store, `mirrorCache` and `mirrorSyncPolicy` are all the real implementations.

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

// The DAL. Only the three paged history reads matter here; the rest exist
// because the store graph imports them by name (a missing named export throws
// at link time) and are never called on a load path.
vi.mock('../lib/supabaseDb', () => {
  const transactions = new Map<string, Record<string, unknown>>();
  const calls = { all: 0, window: 0, range: 0 };
  let serverTruncated = false;

  const sortedDesc = () =>
    [...transactions.values()].sort((a, b) => {
      const ac = String(a.createdAt ?? '');
      const bc = String(b.createdAt ?? '');
      if (ac !== bc) return bc.localeCompare(ac);
      return String(b.id).localeCompare(String(a.id));
    });

  const empty = {
    async getAll() { return []; },
    async get() { return null; },
    async add() {},
    async update() {},
    async delete() {},
  };

  return {
    __seedTransactions: (rows: Record<string, unknown>[]) => {
      transactions.clear();
      for (const row of rows) transactions.set(String(row.id), row);
    },
    __removeRemotely: (id: string) => { transactions.delete(id); },
    __setServerTruncated: (value: boolean) => { serverTruncated = value; },
    __calls: () => ({ ...calls }),
    __resetCalls: () => { calls.all = 0; calls.window = 0; calls.range = 0; },
    __reset: () => {
      transactions.clear();
      serverTruncated = false;
      calls.all = 0; calls.window = 0; calls.range = 0;
    },

    transactionsDb: {
      ...empty,
      async getAll() { return sortedDesc(); },
      async getAllPaged() {
        calls.all += 1;
        return { rows: sortedDesc(), pages: 1, truncated: false };
      },
      async getWindowPaged({ since, minRows = 0 }: { since: string; minRows?: number }) {
        calls.window += 1;
        const all = sortedDesc();
        const rows: Record<string, unknown>[] = [];
        for (const row of all) {
          rows.push(row);
          // Both floors, exactly as `shouldStopWindowPaging` states them.
          if (rows.length >= minRows && String(row.createdAt) < since) break;
        }
        const complete = !serverTruncated && rows.length === all.length;
        return {
          rows,
          pages: 1,
          truncated: serverTruncated,
          complete,
          coveredSince: complete ? null : (serverTruncated ? String(rows[rows.length - 1]?.createdAt ?? since) : since),
        };
      },
      async getRangePaged(from: string, to?: string | null) {
        calls.range += 1;
        return {
          rows: sortedDesc().filter((r) => String(r.createdAt) >= from && (!to || String(r.createdAt) <= to)),
          pages: 1,
          truncated: false,
        };
      },
      async getUpdatedSince() { return []; },
      async getDeletedSince() { return []; },
    },

    accountsDb: { ...empty, async applyBalanceDelta() { return 0; } },
    loansDb: { ...empty, async applyRemainingDelta() { return 0; } },
    emiSchedulesDb: { ...empty, async deleteByLoan() {} },
    goalsDb: { ...empty },
    activitiesDb: { ...empty },
    groupExpensesDb: { async get() { return null; }, async probeExists() { return false; } },
    investmentMarketsDb: { ...empty },
    investmentTradesDb: { ...empty },
    investmentPricesDb: { ...empty, async upsert() {} },
    atomicMoneyDb: {
      async transferAtomic() { throw new Error('not used'); },
      async repaymentAtomic() { throw new Error('not used'); },
      async loanCreateAtomic() { throw new Error('not used'); },
      async goalContributeAtomic() { throw new Error('not used'); },
      async payCardBillAtomic() { throw new Error('not used'); },
    },
  };
});

import * as fakeDb from '../db';
import * as mockDal from '../lib/supabaseDb';
import { mirrorSyncKey, readMirrorCoverage } from '../lib/mirrorCache';
import { coverageSatisfies, emptyCoverage } from '../lib/historyWindow';
import { useAppModeStore } from './appModeStore';
import { useTransactionStore } from './transactionStore';

const tableFor = (fakeDb as unknown as { __tableFor: (n: string) => { rows: Map<string, Record<string, unknown>> } }).__tableFor;
const wipeMirror = (fakeDb as unknown as { __wipe: () => void }).__wipe;
const seedTransactions = (mockDal as unknown as { __seedTransactions: (r: Record<string, unknown>[]) => void }).__seedTransactions;
const removeRemotely = (mockDal as unknown as { __removeRemotely: (id: string) => void }).__removeRemotely;
const setServerTruncated = (mockDal as unknown as { __setServerTruncated: (v: boolean) => void }).__setServerTruncated;
const calls = (mockDal as unknown as { __calls: () => { all: number; window: number; range: number } }).__calls;
const resetCalls = (mockDal as unknown as { __resetCalls: () => void }).__resetCalls;
const resetDal = (mockDal as unknown as { __reset: () => void }).__reset;

const MIRROR_KEY = 'transactions';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/**
 * A genuinely heavy user: enough rows inside the 12-month window to satisfy the
 * 1000-row floor, plus history the window can never reach. Anything smaller and
 * the windowed walk runs to the end of the table and comes back `complete`,
 * which is the one shape where none of this matters.
 */
const RECENT_COUNT = 1005;
const ANCIENT_COUNT = 10;

function seedHeavyUser(ledgerOnly = false) {
  const accounts = ledgerOnly
    ? { sourceAccountId: null, destinationAccountId: null }
    : { sourceAccountId: 'acc-1', destinationAccountId: null };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < RECENT_COUNT; i += 1) {
    rows.push({ id: `recent-${String(i).padStart(4, '0')}`, type: 'expense', amount: 10, currency: 'AED', createdAt: iso(-i * HOUR), updatedAt: iso(-i * HOUR), ...accounts });
  }
  for (let i = 0; i < ANCIENT_COUNT; i += 1) {
    rows.push({ id: `ancient-${i}`, type: 'expense', amount: 10, currency: 'AED', createdAt: iso(-1200 * DAY - i * HOUR), updatedAt: iso(-1200 * DAY - i * HOUR), ...accounts });
  }
  seedTransactions(rows);
}

const syncKey = () => mirrorSyncKey(MIRROR_KEY);
const syncRow = () => tableFor('mirrorSync').rows.get(syncKey());

function setCursors(patch: Record<string, unknown>) {
  const current = syncRow();
  if (!current) throw new Error('no sync row yet — run a load first');
  tableFor('mirrorSync').rows.set(syncKey(), { ...current, ...patch, dirtyAt: null });
}

/** Cursors that make an incremental sync (here: a pure cache hit) the next move. */
const INCREMENTAL_NEXT = { lastSyncedAt: iso(-30 * 1000), lastFullRefreshAt: iso(-HOUR) };
/** Cursors that make the daily reconciliation full refresh the next move. */
const FULL_REFRESH_DUE = { lastSyncedAt: iso(-30 * 1000), lastFullRefreshAt: iso(-25 * HOUR) };

/** Let every fire-and-forget write and background refresh settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A restart: JS memory is gone, the mirror and its sync row are not.
 *
 * Deliberately NOT `reset()` — that is a sign-out, which wipes the persisted
 * floor along with the whole per-user database. This is a page reload.
 */
function restartSession(cursors: Record<string, unknown>) {
  useTransactionStore.setState({
    transactions: [],
    loading: false,
    historyLoading: false,
    historyCoverage: emptyCoverage(),
  });
  setCursors(cursors);
  resetCalls();
}

const load = () => useTransactionStore.getState().loadTransactions();
const ensureAll = () => useTransactionStore.getState().ensureTransactionHistory({ all: true });
const coverage = () => useTransactionStore.getState().historyCoverage;

/** A cold first session that ends holding — and having persisted — everything. */
async function coldSessionProvingEverything() {
  await load();
  await ensureAll();
  await settle();
}

beforeEach(async () => {
  wipeMirror();
  resetDal();
  localStorage.removeItem(`hisaab:mirror:${syncKey().split(':')[0]}:${MIRROR_KEY}:syncedAt`);
  useAppModeStore.setState({ mode: 'full_tracker' });
  useTransactionStore.setState({
    transactions: [],
    loading: false,
    historyLoading: false,
    historyCoverage: emptyCoverage(),
  });
  seedHeavyUser();
});

describe('the first session still pays for what it claims', () => {
  it('a windowed load claims only the window, and persists only that', async () => {
    await load();
    await settle();
    expect(calls().window).toBe(1);
    expect(coverage().complete).toBe(false);
    expect(coverage().since).toBeTruthy();
    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual(coverage());
  });

  it('the full walk that a statement forces is what earns — and stores — completeness', async () => {
    await coldSessionProvingEverything();
    expect(coverage()).toEqual({ since: null, complete: true });
    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual({ since: null, complete: true });
  });
});

describe('after a restart, when an incremental sync is what runs next', () => {
  it('the store adopts the persisted floor instead of claiming nothing', async () => {
    await coldSessionProvingEverything();
    restartSession(INCREMENTAL_NEXT);

    await load();

    // Answered entirely from the mirror — no round trip at all...
    expect(calls()).toEqual({ all: 0, window: 0, range: 0 });
    // ...and yet the session knows what that mirror holds.
    expect(coverage()).toEqual({ since: null, complete: true });
    expect(useTransactionStore.getState().transactions).toHaveLength(RECENT_COUNT + ANCIENT_COUNT);
  });

  it('so the statement no longer pays for a walk it does not need', async () => {
    // The point of the whole exercise (§7.1's first open risk).
    await coldSessionProvingEverything();
    restartSession(INCREMENTAL_NEXT);
    await load();

    await ensureAll();
    expect(calls().all).toBe(0);
  });

  it('a narrower persisted floor is adopted as-is, not rounded up to complete', async () => {
    await load();            // window only — never proved completeness
    await settle();
    const proven = coverage();
    restartSession(INCREMENTAL_NEXT);

    await load();
    expect(coverage()).toEqual(proven);
    expect(coverage().complete).toBe(false);
    // ...and a statement therefore still pays for its walk.
    await ensureAll();
    expect(calls().all).toBe(1);
  });
});

describe('after a restart, when a full refresh is due', () => {
  it('the persisted floor is NOT believed', async () => {
    await coldSessionProvingEverything();
    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual({ since: null, complete: true });

    restartSession(FULL_REFRESH_DUE);
    await load();

    // The daily reconciliation is exactly the moment the mirror is not yet
    // known-good: the incremental cursor can have missed a tombstone. Until it
    // lands, the session claims nothing it did not prove itself.
    expect(coverage().complete).toBe(false);
    // A statement gate reading this refuses to build — which is the behaviour
    // the whole contract exists for.
    expect(coverageSatisfies(coverage(), { all: true })).toBe(false);
  });

  it('the refresh re-establishes the floor from what it actually proved', async () => {
    await coldSessionProvingEverything();
    restartSession(FULL_REFRESH_DUE);

    await load();
    await settle();

    // The background refresh was windowed, so that is all it may claim — the
    // old `complete` is gone from the store AND from disk.
    expect(coverage().complete).toBe(false);
    expect(coverage().since).toBeTruthy();
    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual(coverage());
    expect(calls().window).toBe(1);

    // And the next restart inherits the narrowed floor, never the stale one.
    restartSession(INCREMENTAL_NEXT);
    await load();
    expect(coverage().complete).toBe(false);
  });
});

describe('events that can remove rows below the floor invalidate it', () => {
  it('a server truncation warning', async () => {
    await coldSessionProvingEverything();
    setServerTruncated(true);

    restartSession(FULL_REFRESH_DUE);
    await load();
    await settle();

    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual({ since: null, complete: false });
    // Believed cursors, and still no inherited claim of completeness.
    restartSession(INCREMENTAL_NEXT);
    await load();
    expect(coverage().complete).toBe(false);
  });

  it('a full refresh that finds a row deleted without a tombstone', async () => {
    await coldSessionProvingEverything();
    // Gone from the server, and NOT reported by `getDeletedSince` — the repair
    // the daily reconciliation exists for. The mirror prunes it inside the
    // window, and a pruned row is indistinguishable from a short page.
    removeRemotely('recent-0000');

    restartSession(FULL_REFRESH_DUE);
    await load();
    await settle();

    expect(tableFor('transactions').rows.has('recent-0000')).toBe(false);
    expect((await readMirrorCoverage(MIRROR_KEY)).complete).toBe(false);

    restartSession(INCREMENTAL_NEXT);
    await load();
    expect(coverage().complete).toBe(false);
  });

  it('a sign-out drops the persisted floor, so the next account inherits nothing', async () => {
    await coldSessionProvingEverything();
    useTransactionStore.getState().reset();
    await settle();

    expect(useTransactionStore.getState().historyCoverage).toEqual(emptyCoverage());
    expect(await readMirrorCoverage(MIRROR_KEY)).toEqual({ since: null, complete: false });
  });
});

describe('both app modes behave identically', () => {
  it('a ledger-only user gets the same floor, persisted and re-adopted the same way', async () => {
    async function run(mode: 'full_tracker' | 'splits_only') {
      wipeMirror();
      resetDal();
      useAppModeStore.setState({ mode });
      // In splits_only there are no accounts at all: BOTH account ids are null.
      seedHeavyUser(mode === 'splits_only');
      useTransactionStore.setState({
        transactions: [], loading: false, historyLoading: false, historyCoverage: emptyCoverage(),
      });

      await load();
      const windowed = { ...coverage() };
      await ensureAll();
      await settle();
      const persisted = await readMirrorCoverage(MIRROR_KEY);

      restartSession(INCREMENTAL_NEXT);
      await load();
      const afterRestart = { ...coverage() };
      const roundTripsAfterRestart = calls();

      return {
        windowedComplete: windowed.complete,
        windowedHasFloor: Boolean(windowed.since),
        persisted,
        afterRestart,
        roundTripsAfterRestart,
        rows: useTransactionStore.getState().transactions.length,
      };
    }

    const fullTracker = await run('full_tracker');
    const ledgerOnly = await run('splits_only');

    expect(ledgerOnly).toEqual(fullTracker);
    // ...and not equal by both being empty.
    expect(fullTracker.afterRestart).toEqual({ since: null, complete: true });
    expect(fullTracker.rows).toBe(RECENT_COUNT + ANCIENT_COUNT);
    expect(fullTracker.roundTripsAfterRestart).toEqual({ all: 0, window: 0, range: 0 });
  });
});
