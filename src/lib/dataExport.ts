import {
  accountsDb, transactionsDb, loansDb, emiSchedulesDb,
  goalsDb, activitiesDb, upcomingExpensesDb,
  splitGroupsDb, groupExpensesDb, groupSettlementsDb,
} from './supabaseDb';
import { supabase } from './supabase';

const LS_KEYS = [
  'hisaab_onboarded', 'hisaab_user_name', 'hisaab_primary_currency',
  'hisaab_lang', 'hisaab_app_mode', 'hisaab_identifier', 'hisaab_data_version',
];

function getUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

export async function exportAllData(): Promise<string> {
  const [accounts, transactions, loans, emiSchedules, goals, activities, upcomingExpenses, splitGroups] = await Promise.all([
    accountsDb.getAll(),
    transactionsDb.getAll(),
    loansDb.getAll(),
    emiSchedulesDb.getAll(),
    goalsDb.getAll(),
    activitiesDb.getAll(),
    upcomingExpensesDb.getAll(),
    splitGroupsDb.getAll(),
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
    version: 3,
    exportedAt: new Date().toISOString(),
    settings,
    data: {
      accounts, transactions, loans, emiSchedules, goals,
      activityLog: activities, upcomingExpenses, splitGroups,
      groupExpenses: allGroupExpenses, groupSettlements: allGroupSettlements,
    },
  }, null, 2);
}

export async function importData(json: string): Promise<{ success: boolean; message: string }> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed.data || !parsed.version) {
      return { success: false, message: 'Invalid backup file format' };
    }

    const userId = getUserId();
    const tables = [
      'group_settlements', 'group_expenses', 'split_groups',
      'upcoming_expenses', 'activities', 'emi_schedules',
      'goals', 'loans', 'transactions', 'accounts',
    ];

    // Clear all user data (order matters for foreign keys)
    for (const table of tables) {
      await supabase.from(table).delete().eq('user_id', userId);
    }

    const d = parsed.data;

    // Re-insert in correct order
    if (d.accounts?.length) {
      const rows = d.accounts.map((a: Record<string, unknown>) => ({
        id: a.id, user_id: userId, name: a.name, type: a.type,
        currency: a.currency, balance: a.balance, metadata: a.metadata ?? {},
        created_at: a.createdAt,
      }));
      const { error } = await supabase.from('accounts').insert(rows);
      if (error) throw error;
    }

    if (d.transactions?.length) {
      const rows = d.transactions.map((t: Record<string, unknown>) => ({
        id: t.id, user_id: userId, type: t.type, amount: t.amount, currency: t.currency,
        source_account_id: t.sourceAccountId, destination_account_id: t.destinationAccountId,
        related_person: t.relatedPerson, related_loan_id: t.relatedLoanId,
        related_goal_id: t.relatedGoalId, conversion_rate: t.conversionRate,
        category: t.category, notes: t.notes, created_at: t.createdAt,
      }));
      const { error } = await supabase.from('transactions').insert(rows);
      if (error) throw error;
    }

    if (d.loans?.length) {
      const rows = d.loans.map((l: Record<string, unknown>) => ({
        id: l.id, user_id: userId, person_name: l.personName, type: l.type,
        total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
        currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
      }));
      const { error } = await supabase.from('loans').insert(rows);
      if (error) throw error;
    }

    if (d.emiSchedules?.length) {
      const rows = d.emiSchedules.map((e: Record<string, unknown>) => ({
        id: e.id, user_id: userId, loan_id: e.loanId,
        installment_number: e.installmentNumber, due_date: e.dueDate,
        amount: e.amount, status: e.status,
      }));
      const { error } = await supabase.from('emi_schedules').insert(rows);
      if (error) throw error;
    }

    if (d.goals?.length) {
      const rows = d.goals.map((g: Record<string, unknown>) => ({
        id: g.id, user_id: userId, title: g.title,
        target_amount: g.targetAmount, saved_amount: g.savedAmount,
        currency: g.currency, stored_in_account_id: g.storedInAccountId ?? '',
        created_at: g.createdAt,
      }));
      const { error } = await supabase.from('goals').insert(rows);
      if (error) throw error;
    }

    if (d.activityLog?.length) {
      const rows = d.activityLog.map((a: Record<string, unknown>) => ({
        id: a.id, user_id: userId, type: a.type, description: a.description,
        related_entity_id: a.relatedEntityId ?? '', related_entity_type: a.relatedEntityType ?? '',
        timestamp: a.timestamp,
      }));
      const { error } = await supabase.from('activities').insert(rows);
      if (error) throw error;
    }

    if (d.upcomingExpenses?.length) {
      const rows = d.upcomingExpenses.map((e: Record<string, unknown>) => ({
        id: e.id, user_id: userId, title: e.title, amount: e.amount,
        currency: e.currency, due_date: e.dueDate, account_id: e.accountId ?? '',
        category: e.category ?? '', notes: e.notes ?? '',
        is_paid: e.isPaid ?? false, status: e.status ?? 'upcoming',
        reminder_days_before: e.reminderDaysBefore ?? 0, created_at: e.createdAt,
      }));
      const { error } = await supabase.from('upcoming_expenses').insert(rows);
      if (error) throw error;
    }

    if (d.splitGroups?.length) {
      const rows = d.splitGroups.map((g: Record<string, unknown>) => ({
        id: g.id, user_id: userId, name: g.name, emoji: g.emoji ?? '',
        members: g.members, currency: g.currency, settled: g.settled ?? false,
        created_at: g.createdAt,
      }));
      const { error } = await supabase.from('split_groups').insert(rows);
      if (error) throw error;
    }

    if (d.groupExpenses?.length) {
      const rows = d.groupExpenses.map((e: Record<string, unknown>) => ({
        id: e.id, user_id: userId, group_id: e.groupId,
        description: e.description, amount: e.amount, paid_by: e.paidBy,
        split_type: e.splitType, splits: e.splits, category: e.category ?? '',
        date: e.date ?? '', notes: e.notes ?? '', created_at: e.createdAt,
      }));
      const { error } = await supabase.from('group_expenses').insert(rows);
      if (error) throw error;
    }

    if (d.groupSettlements?.length) {
      const rows = d.groupSettlements.map((s: Record<string, unknown>) => ({
        id: s.id, user_id: userId, group_id: s.groupId,
        from_member: s.fromMember, to_member: s.toMember,
        amount: s.amount, date: s.date ?? '', note: s.note ?? '',
        created_at: s.createdAt,
      }));
      const { error } = await supabase.from('group_settlements').insert(rows);
      if (error) throw error;
    }

    // Restore settings
    if (parsed.settings) {
      Object.entries(parsed.settings).forEach(([k, v]) => {
        if (v !== null && v !== undefined) localStorage.setItem(k, v as string);
      });
    }

    return { success: true, message: 'Data restored successfully' };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : 'Import failed' };
  }
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
