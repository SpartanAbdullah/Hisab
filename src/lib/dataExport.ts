import {
  accountsDb, transactionsDb, loansDb, emiSchedulesDb,
  goalsDb, activitiesDb, upcomingExpensesDb,
  splitGroupsDb, groupExpensesDb, groupSettlementsDb,
  investmentMarketsDb, investmentTradesDb, investmentPricesDb,
} from './supabaseDb';
import { supabase } from './supabase';
import { runSafeMutation } from './mutationSafety';
import { reportError } from './errorReporter';
import {
  BACKUP_SETTINGS_ALLOWLIST,
  CURRENT_BACKUP_VERSION,
  backupRejectMessageKey,
  validateBackupFile,
  type BackupCollection,
} from './backupImport';
import type { I18nKey } from './i18n';

// Audit M8: ONE list, in and out — we export exactly the preference keys we
// are willing to restore. `hisaab_identifier` used to be exported here; it
// binds the local PIN hash to an identity, so it belonged in neither
// direction. See backupImport.ts for the full exclusion rationale.
const LS_KEYS: readonly string[] = BACKUP_SETTINGS_ALLOWLIST;

function getUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

export async function exportAllData(): Promise<string> {
  const [accounts, transactions, loans, emiSchedules, goals, activities, upcomingExpenses, splitGroups, investmentMarkets, investmentTrades, investmentPrices] = await Promise.all([
    accountsDb.getAll(),
    transactionsDb.getAll(),
    loansDb.getAll(),
    emiSchedulesDb.getAll(),
    goalsDb.getAll(),
    activitiesDb.getAll(),
    upcomingExpensesDb.getAll(),
    splitGroupsDb.getAll(),
    // Graceful pre-migration export: if the investment tables don't exist
    // yet, back up everything else instead of failing the whole export.
    investmentMarketsDb.getAll().catch(() => []),
    investmentTradesDb.getAll().catch(() => []),
    investmentPricesDb.getAll().catch(() => []),
  ]);

  // Fetch group expenses and settlements for each group
  const allGroupExpenses = [];
  const allGroupSettlements = [];
  for (const g of splitGroups) {
    const expenses = await groupExpensesDb.getByGroup(g.id);
    const settlements = await groupSettlementsDb.getByGroup(g.id);
    allGroupExpenses.push(...expenses);
    allGroupSettlements.push(...settlements);
  }

  const settings: Record<string, string | null> = {};
  LS_KEYS.forEach(k => { settings[k] = localStorage.getItem(k); });

  return JSON.stringify({
    version: CURRENT_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    data: {
      accounts, transactions, loans, emiSchedules, goals,
      activityLog: activities, upcomingExpenses, splitGroups,
      groupExpenses: allGroupExpenses, groupSettlements: allGroupSettlements,
      investmentMarkets, investmentTrades, investmentPrices,
    },
  }, null, 2);
}

type Row = Record<string, unknown>;

export interface ImportResult {
  success: boolean;
  /** English fallback — kept for logs and for callers that predate messageKey. */
  message: string;
  /** i18n key the UI should render instead of `message`. */
  messageKey: I18nKey;
}

// Physical tables, children-first. Used for the pre-import wipe and, reversed,
// for re-inserting the rollback snapshot.
const DELETE_ORDER = [
  'group_settlements', 'group_expenses', 'split_groups',
  'upcoming_expenses', 'activities', 'emi_schedules',
  'goals', 'loans', 'transactions', 'accounts',
  // children before parent (investment_trades FK-references markets)
  'investment_prices', 'investment_trades', 'investment_markets',
] as const;

// PostgREST caps a single SELECT at the project's max-rows setting (1000 by
// default). Reading the rollback snapshot in one shot would silently truncate
// a large account and turn "rollback" into data loss, so every read pages.
const PAGE_SIZE = 1000;
// And every write chunks, so a big restore can't blow the request body limit.
const INSERT_CHUNK = 500;

// One entry per backup collection, in FK-safe INSERT order (parents first).
// The mappers are pure: they run BEFORE anything is deleted, so a file that
// blows up during mapping costs the user nothing.
const INSERT_PLAN: {
  collection: BackupCollection;
  table: string;
  map: (row: Row, userId: string) => Row;
}[] = [
  {
    collection: 'accounts',
    table: 'accounts',
    map: (a, userId) => ({
      id: a.id, user_id: userId, name: a.name, type: a.type,
      currency: a.currency, balance: a.balance, metadata: a.metadata ?? {},
      created_at: a.createdAt,
    }),
  },
  {
    collection: 'transactions',
    table: 'transactions',
    map: (t, userId) => ({
      id: t.id, user_id: userId, type: t.type, amount: t.amount, currency: t.currency,
      // BOTH account ids are legitimately null in splits_only (ledger-only)
      // mode — a ledger repayment row has no account on either leg
      // (tasks/lessons.md). `?? null` is explicit so those rows survive the
      // round-trip instead of depending on a column default.
      source_account_id: t.sourceAccountId ?? null,
      destination_account_id: t.destinationAccountId ?? null,
      related_person: t.relatedPerson ?? null, person_id: t.personId ?? null,
      related_loan_id: t.relatedLoanId ?? null,
      related_goal_id: t.relatedGoalId ?? null, conversion_rate: t.conversionRate ?? null,
      // Conditional so restore still works on a pre-investments database;
      // without it a restored buy/sell loses its trade link and deleting it
      // later would orphan the trade row (phantom shares).
      ...(t.relatedInvestmentId != null ? { related_investment_id: t.relatedInvestmentId } : {}),
      category: t.category, notes: t.notes, created_at: t.createdAt,
      is_reconciled: t.isReconciled ?? false,
      reconciled_at: t.reconciledAt ?? null,
      reconciled_by: t.reconciledBy ?? null,
      receipt_path: t.receiptPath ?? null,
    }),
  },
  {
    collection: 'loans',
    table: 'loans',
    map: (l, userId) => ({
      id: l.id, user_id: userId, person_name: l.personName, type: l.type,
      total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
      currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
    }),
  },
  {
    collection: 'emiSchedules',
    table: 'emi_schedules',
    map: (e, userId) => ({
      id: e.id, user_id: userId, loan_id: e.loanId,
      installment_number: e.installmentNumber, due_date: e.dueDate,
      amount: e.amount, status: e.status,
    }),
  },
  {
    collection: 'goals',
    table: 'goals',
    map: (g, userId) => ({
      id: g.id, user_id: userId, title: g.title,
      target_amount: g.targetAmount, saved_amount: g.savedAmount,
      currency: g.currency, stored_in_account_id: g.storedInAccountId ?? '',
      created_at: g.createdAt,
    }),
  },
  {
    collection: 'investmentMarkets',
    table: 'investment_markets',
    map: (m, userId) => ({
      id: m.id, user_id: userId, name: m.name, currency: m.currency,
      created_at: m.createdAt,
    }),
  },
  {
    collection: 'investmentTrades',
    table: 'investment_trades',
    map: (tr, userId) => ({
      id: tr.id, user_id: userId, market_id: tr.marketId, symbol: tr.symbol,
      name: tr.name ?? '', kind: tr.kind, quantity: tr.quantity,
      price_per_unit: tr.pricePerUnit, amount: tr.amount, fees: tr.fees,
      account_id: tr.accountId ?? null, transaction_id: tr.transactionId ?? null,
      traded_at: tr.tradedAt, notes: tr.notes ?? '', created_at: tr.createdAt,
    }),
  },
  {
    collection: 'investmentPrices',
    table: 'investment_prices',
    map: (p, userId) => ({
      id: p.id, user_id: userId, market_id: p.marketId, symbol: p.symbol,
      price: p.price, as_of: p.asOf, created_at: p.createdAt,
    }),
  },
  {
    collection: 'activityLog',
    table: 'activities',
    map: (a, userId) => ({
      id: a.id, user_id: userId, type: a.type, description: a.description,
      related_entity_id: a.relatedEntityId ?? '', related_entity_type: a.relatedEntityType ?? '',
      timestamp: a.timestamp,
    }),
  },
  {
    collection: 'upcomingExpenses',
    table: 'upcoming_expenses',
    map: (e, userId) => ({
      id: e.id, user_id: userId, title: e.title, amount: e.amount,
      currency: e.currency, due_date: e.dueDate, account_id: e.accountId ?? '',
      category: e.category ?? '', notes: e.notes ?? '',
      is_paid: e.isPaid ?? false, status: e.status ?? 'upcoming',
      reminder_days_before: e.reminderDaysBefore ?? 0, created_at: e.createdAt,
    }),
  },
  {
    collection: 'splitGroups',
    table: 'split_groups',
    map: (g, userId) => ({
      id: g.id, user_id: userId, name: g.name, emoji: g.emoji ?? '',
      members: g.members, currency: g.currency, settled: g.settled ?? false,
      created_at: g.createdAt,
    }),
  },
  {
    collection: 'groupExpenses',
    table: 'group_expenses',
    map: (e, userId) => ({
      id: e.id, user_id: userId, group_id: e.groupId,
      description: e.description, amount: e.amount, paid_by: e.paidBy,
      split_type: e.splitType, splits: e.splits, category: e.category ?? '',
      date: e.date ?? '', notes: e.notes ?? '', created_at: e.createdAt,
    }),
  },
  {
    collection: 'groupSettlements',
    table: 'group_settlements',
    map: (s, userId) => ({
      id: s.id, user_id: userId, group_id: s.groupId,
      from_member: s.fromMember, to_member: s.toMember,
      amount: s.amount, date: s.date ?? '', note: s.note ?? '',
      created_at: s.createdAt,
    }),
  },
];

async function selectAllRows(table: string, userId: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    const page = (data ?? []) as Row[];
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function insertRows(table: string, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + INSERT_CHUNK));
    if (error) throw new Error(`Could not write ${table}: ${error.message}`);
  }
}

async function deleteAllUserRows(userId: string): Promise<void> {
  for (const table of DELETE_ORDER) {
    const { error } = await supabase.from(table).delete().eq('user_id', userId);
    if (error) throw new Error(`Could not clear ${table}: ${error.message}`);
  }
}

/**
 * Restore a backup file.
 *
 * Audit 2026-09, security M8. Supabase has no client-side transaction, so
 * "transactional" here is the repo's compensation pattern (mutationSafety.ts),
 * in four strictly ordered phases:
 *
 *   1. VALIDATE the whole file — shape, version, every collection, every row
 *      id — and MAP every insert payload. Nothing has been touched yet, so a
 *      malformed or hostile file costs the user exactly nothing. The old code
 *      checked `parsed.data && parsed.version` and then deleted 13 tables.
 *   2. SNAPSHOT the current cloud rows (paged, so a >1000-row table is not
 *      silently truncated) and register the inverse on the MutationScope.
 *   3. DELETE, then INSERT. Any failure throws; rollback re-wipes and re-inserts
 *      the snapshot LIFO.
 *   4. Only once the data has landed, write the ALLOWLISTED settings keys.
 *      Never `Object.entries(file.settings)` — that let a WhatsApp-forwarded
 *      file plant hisaab_pin_hash / hisaab_supabase_uid / a push token.
 *
 * Both app modes: the transaction mapper keeps BOTH account ids null for
 * splits_only ledger rows, so a ledger-only user's repayment records survive
 * the round-trip.
 */
export async function importData(json: string): Promise<ImportResult> {
  // ── Phase 1: validate + map, before anything is touched ──────────────────
  const validation = validateBackupFile(json);
  if (!validation.ok) {
    return {
      success: false,
      message: `Invalid backup file (${validation.reason}${validation.collection ? `: ${validation.collection}` : ''})`,
      messageKey: backupRejectMessageKey(validation.reason),
    };
  }

  let userId: string;
  try {
    userId = getUserId();
  } catch {
    return { success: false, message: 'Not authenticated', messageKey: 'import_err_auth' };
  }

  let plan: { table: string; rows: Row[] }[];
  try {
    plan = INSERT_PLAN.map(({ collection, table, map }) => ({
      table,
      rows: validation.data[collection].map(row => map(row, userId)),
    }));
  } catch (err) {
    reportError(err, { feature: 'dataExport.importData:map' });
    return { success: false, message: 'Backup file could not be read', messageKey: 'import_err_shape' };
  }

  // ── Phases 2 & 3: snapshot, wipe, insert — with a registered inverse ─────
  let rollbackFailed = false;
  try {
    await runSafeMutation(
      async (scope) => {
        const snapshot: { table: string; rows: Row[] }[] = [];
        for (const table of DELETE_ORDER) {
          snapshot.push({ table, rows: await selectAllRows(table, userId) });
        }

        scope.register(async () => {
          // Undo whatever landed, then put the user's own data back. Snapshot
          // rows are re-inserted parents-first (DELETE_ORDER reversed).
          await deleteAllUserRows(userId);
          for (const entry of [...snapshot].reverse()) {
            if (entry.rows.length) await insertRows(entry.table, entry.rows);
          }
        });

        await deleteAllUserRows(userId);
        for (const step of plan) {
          if (step.rows.length) await insertRows(step.table, step.rows);
        }
      },
      (errors) => {
        // The inverse itself failed — the account is now in a mixed state and
        // the user must be told, not handed a generic "import failed".
        rollbackFailed = true;
        reportError(errors[0] ?? new Error('rollback failed'), { feature: 'dataExport.importData:rollback' });
      },
    );
  } catch (err) {
    reportError(err, { feature: 'dataExport.importData' });
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Import failed',
      messageKey: rollbackFailed ? 'import_err_rollback_failed' : 'import_err_rolled_back',
    };
  }

  // ── Phase 4: allowlisted settings only, and only after the data landed ───
  try {
    for (const [key, value] of Object.entries(validation.settings)) {
      if (typeof value === 'string') localStorage.setItem(key, value);
    }
  } catch (err) {
    // Preferences are cosmetic next to the rows we just restored — don't fail
    // a successful import over a storage quota error.
    reportError(err, { feature: 'dataExport.importData:settings' });
  }

  return { success: true, message: 'Data restored successfully', messageKey: 'settings_import_success' };
}


export function downloadJSON(data: string, filename: string) {
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
