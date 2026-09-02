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
// Phase 3 — Offline-first mirror + outbox
//
// The Dexie database now plays a different role than its Hisaab 1.x
// ancestor: it is a READ MIRROR of authoritative server state plus an
// outbox of mutations that haven't reached Supabase yet.
//
// Direction of trust:
//   - Supabase remains authoritative for all entity rows.
//   - Dexie is hydrated from Supabase pulls (`mirror.<table>.bulkPut`).
//   - User mutations write to BOTH Dexie (immediate visibility) and an
//     `outbox` table. The outboxRunner drains the outbox to Supabase as
//     connectivity allows. Successful drains delete the outbox row.
//
// Current commit ships ONLY the schema + outbox primitives. The stores
// are not yet rewired to read from Dexie or write to the outbox — that
// migration happens incrementally store-by-store. See
// `src/lib/outboxRunner.ts` and `src/hooks/useOnlineStatus.ts` for the
// glue that's already wired up.
// ──────────────────────────────────────────────────────────────

export type OutboxOpKind =
  | 'transaction.create'
  | 'transaction.update'
  | 'transaction.delete'
  | 'account.update_balance'
  | 'loan.create'
  | 'loan.update'
  | 'budget.create'
  | 'budget.update'
  | 'budget.delete'
  | 'recurring.create'
  | 'recurring.update'
  | 'remittance.create';

export interface OutboxEntry {
  id: string;                  // uuid
  kind: OutboxOpKind;
  payload: unknown;            // op-specific. JSON-serialisable.
  createdAt: string;           // ISO
  attempts: number;            // bumped on each failed flush
  lastError: string | null;
  // After how many seconds since the last attempt we retry. Exponential
  // backoff lives in the runner; this is the persisted "next try" time.
  nextAttemptAt: string;       // ISO
}

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

  // Mutations queued while offline (or before they reach Supabase).
  outbox!: Table<OutboxEntry, string>;
  mirrorSync!: Table<MirrorSyncState, string>;

  constructor(databaseName = 'HisaabDB') {
    super(databaseName);

    // Versions 1–5 carried the legacy Hisaab 1.x schema. We keep them
    // declared so Dexie's upgrade path stays valid for anyone who has the
    // old DB in their browser, then version 6 reshapes everything as the
    // offline mirror + outbox.
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
    // and the outbox. Indices chosen for the lookups the runner needs:
    // outbox by `nextAttemptAt` (oldest-due-first sweep) and by `kind`
    // (operational visibility / debug filtering).
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
// mirror, sync cursor, or outbox.
export const db = new Proxy({} as HisaabDatabase, {
  get(_target, property) {
    const activeDb = getDb();
    const value = Reflect.get(activeDb, property);
    return typeof value === 'function' ? value.bind(activeDb) : value;
  },
});
