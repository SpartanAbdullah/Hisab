import Dexie, { type Table } from 'dexie';
import type {
  Account,
  Transaction,
  Loan,
  EmiSchedule,
  Goal,
  ActivityLog,
  UpcomingExpense,
  SplitGroup,
  GroupExpense,
  GroupSettlement,
  Person,
  Budget,
  RecurringTransaction,
  Remittance,
} from './types';

// ──────────────────────────────────────────────────────────────
// Read mirror of authoritative server state
//
// The Dexie database is a READ MIRROR of Supabase, nothing more. Supabase
// remains authoritative for every entity row; Dexie is hydrated from
// Supabase pulls (`mirror.<table>.bulkPut`, see src/lib/mirrorCache.ts) so
// cache-first loaders can paint before the network answers.
//
// There is NO offline write queue. Writes go to Supabase directly and fail
// loudly when the device is offline (`err_offline` copy, OfflineBanner) —
// the app is online-required for writes. The queued-write "outbox" scaffold
// that used to live here never drained a single row and was deleted on
// 2026-09-04 (decision D5, Option A — docs/offline-story.md); schema
// version 8 below drops its object store from existing users' IndexedDB.
// ──────────────────────────────────────────────────────────────

export interface MirrorSyncState {
  key: string;
  lastSyncedAt: string;
  lastFullRefreshAt: string | null;
  // Set when a local write or a remote realtime event changed rows we haven't
  // pulled yet. Deliberately separate from the cursors above: marking a mirror
  // stale must never erase `lastSyncedAt` (that turned every money write into a
  // full-table re-download — audit 03-performance H2). Not indexed, so no Dexie
  // version bump is needed; older rows simply read as undefined.
  dirtyAt?: string | null;
  // ── The persisted history-coverage floor (docs/performance.md §7.1) ──────
  // What the mirror PROVES it holds, surviving a restart. Read together, and
  // read ONLY when the cursors above say an incremental sync is what runs next
  // (`persistedCoverageIsTrustworthy` in src/lib/mirrorSyncPolicy.ts):
  //
  //   coverageComplete: true            → the mirror holds the whole table
  //   coverageSince: ISO, !complete     → it holds every row created at/after it
  //   both absent/null                  → nothing is proven (the safe default)
  //
  // Cleared by every event that can remove rows below the floor — a truncated
  // fetch, a clear-and-replace, an in-window reconcile that pruned rows — and
  // by the mirror wipe itself (the whole per-user Dexie database is deleted at
  // sign-out, so these go with it). Also not indexed: no version bump, and a
  // row written before this shipped simply reads as "nothing proven".
  coverageSince?: string | null;
  coverageComplete?: boolean;
}

export class HisaabDatabase extends Dexie {
  // Mirrored authoritative state (read-only from the app's perspective)
  accounts!: Table<Account, string>;
  transactions!: Table<Transaction, string>;
  loans!: Table<Loan, string>;
  emiSchedules!: Table<EmiSchedule, string>;
  goals!: Table<Goal, string>;
  activityLog!: Table<ActivityLog, string>;
  upcomingExpenses!: Table<UpcomingExpense, string>;
  splitGroups!: Table<SplitGroup, string>;
  groupExpenses!: Table<GroupExpense, string>;
  groupSettlements!: Table<GroupSettlement, string>;
  persons!: Table<Person, string>;
  budgets!: Table<Budget, string>;
  recurringTransactions!: Table<RecurringTransaction, string>;
  remittances!: Table<Remittance, string>;

  // Per-table mirror sync cursors (src/lib/mirrorCache.ts).
  mirrorSync!: Table<MirrorSyncState, string>;

  constructor(databaseName = 'HisaabDB') {
    super(databaseName);

    // Versions 1–5 carried the legacy Hisaab 1.x schema. Every historical
    // version stays declared so Dexie's upgrade path remains valid for
    // anyone who has an older DB in their browser; version 6 reshaped it as
    // the read mirror (plus an `outbox` store that version 8 drops again).
    this.version(1).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
    });
    this.version(2).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
    });
    this.version(3).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
    });
    this.version(4).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, personId, createdAt',
      loans: 'id, personName, personId, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
      persons: 'id, name, createdAt',
    });
    this.version(5).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, personId, createdAt',
      loans: 'id, personName, personId, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
      persons: 'id, name, linkedProfileId, createdAt',
    });
    // Version 6: add Phase 3 entities (budgets, recurring, remittances)
    // and the `outbox` store of the queued-write scaffold. Kept verbatim
    // (Dexie needs the history); the store itself is dropped in version 8.
    this.version(6).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, personId, createdAt',
      loans: 'id, personName, personId, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
      persons: 'id, name, linkedProfileId, createdAt',
      budgets: 'id, category, currency',
      recurringTransactions: 'id, nextDueDate, active',
      remittances: 'id, sentAt, status',
      outbox: 'id, kind, nextAttemptAt, createdAt',
    });
    // Version 7: per-table mirror sync metadata. Lets cache-first loaders do
    // incremental pulls without relying only on localStorage.
    this.version(7).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, personId, createdAt',
      loans: 'id, personName, personId, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
      persons: 'id, name, linkedProfileId, createdAt',
      budgets: 'id, category, currency',
      recurringTransactions: 'id, nextDueDate, active',
      remittances: 'id, sentAt, status',
      outbox: 'id, kind, nextAttemptAt, createdAt',
      mirrorSync: 'key, lastSyncedAt, lastFullRefreshAt',
    });
    // Version 8: drop the `outbox` object store (2026-09-04, decision D5 —
    // docs/offline-story.md, Option A). Nothing ever drained a row from it,
    // so there is no data to migrate; `null` makes Dexie delete the store on
    // next open for anyone who already has v6/v7 on their device. Tables not
    // listed here are inherited from version 7 unchanged.
    this.version(8).stores({ outbox: null });
  }
}

const LEGACY_DATABASE_NAME = 'HisaabDB';
const DATABASE_PREFIX = 'HisaabDB:user:';
const databases = new Map<string, HisaabDatabase>();

function normalizeUserId(userId: string | null | undefined): string {
  return userId?.trim() || 'anonymous';
}

export function getCurrentDatabaseUserId(): string {
  if (typeof localStorage === 'undefined') return 'anonymous';
  return normalizeUserId(localStorage.getItem('hisaab_supabase_uid'));
}

export function databaseNameForUser(userId: string | null | undefined): string {
  return `${DATABASE_PREFIX}${encodeURIComponent(normalizeUserId(userId))}`;
}

export function getDatabaseForUser(userId: string | null | undefined): HisaabDatabase {
  const databaseName = databaseNameForUser(userId);
  const existing = databases.get(databaseName);
  if (existing) return existing;
  const created = new HisaabDatabase(databaseName);
  databases.set(databaseName, created);
  return created;
}

export function getDb(): HisaabDatabase {
  return getDatabaseForUser(getCurrentDatabaseUserId());
}

export async function clearUserDatabase(userId: string | null | undefined): Promise<void> {
  const databaseName = databaseNameForUser(userId);
  databases.get(databaseName)?.close();
  databases.delete(databaseName);
  await Dexie.delete(databaseName);
}

export async function clearLegacyDatabase(): Promise<void> {
  await Dexie.delete(LEGACY_DATABASE_NAME);
}

// Existing stores access `db.accounts`, `db.transactions`, etc. Resolve each
// property against the active user's database so accounts cannot share a
// mirror or a sync cursor.
export const db = new Proxy({} as HisaabDatabase, {
  get(_target, property) {
    const activeDb = getDb();
    const value = Reflect.get(activeDb, property);
    return typeof value === 'function' ? value.bind(activeDb) : value;
  },
});
