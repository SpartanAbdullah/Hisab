import { supabase } from './supabase';
import type {
  Account, Transaction, Loan, EmiSchedule, Goal,
  ActivityLog, UpcomingExpense, SplitGroup, GroupExpense, GroupSettlement,
} from '../db';

// Helper to get current user ID (cached in localStorage by App.tsx)
function getUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

// ══════════════════════════════════════
// ACCOUNTS
// ══════════════════════════════════════
export const accountsDb = {
  async getAll(): Promise<Account[]> {
    const { data, error } = await supabase
      .from('accounts').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAccount);
  },
  async add(a: Account) {
    const { error } = await supabase.from('accounts').insert({
      id: a.id, user_id: getUserId(), name: a.name, type: a.type,
      currency: a.currency, balance: a.balance, metadata: a.metadata, created_at: a.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Account>) {
    const row: Record<string, unknown> = {};
    if (changes.balance !== undefined) row.balance = changes.balance;
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.metadata !== undefined) row.metadata = changes.metadata;
    const { error } = await supabase.from('accounts').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('accounts').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async count(): Promise<number> {
    const { count, error } = await supabase
      .from('accounts').select('id', { count: 'exact', head: true })
      .eq('user_id', getUserId());
    if (error) throw error;
    return count ?? 0;
  },
};

// ══════════════════════════════════════
// TRANSACTIONS
// ══════════════════════════════════════
export const transactionsDb = {
  async getAll(): Promise<Transaction[]> {
    const { data, error } = await supabase
      .from('transactions').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapTransaction);
  },
  async add(t: Transaction) {
    const { error } = await supabase.from('transactions').insert({
      id: t.id, user_id: getUserId(), type: t.type, amount: t.amount, currency: t.currency,
      source_account_id: t.sourceAccountId, destination_account_id: t.destinationAccountId,
      related_person: t.relatedPerson, related_loan_id: t.relatedLoanId,
      related_goal_id: t.relatedGoalId, conversion_rate: t.conversionRate,
      category: t.category, notes: t.notes, created_at: t.createdAt,
    });
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('transactions').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// LOANS
// ══════════════════════════════════════
export const loansDb = {
  async getAll(): Promise<Loan[]> {
    const { data, error } = await supabase
      .from('loans').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapLoan);
  },
  async add(l: Loan) {
    const { error } = await supabase.from('loans').insert({
      id: l.id, user_id: getUserId(), person_name: l.personName, type: l.type,
      total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
      currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Loan>) {
    const row: Record<string, unknown> = {};
    if (changes.remainingAmount !== undefined) row.remaining_amount = changes.remainingAmount;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.notes !== undefined) row.notes = changes.notes;
    const { error } = await supabase.from('loans').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('loans').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// EMI SCHEDULES
// ══════════════════════════════════════
export const emiSchedulesDb = {
  async getAll(): Promise<EmiSchedule[]> {
    const { data, error } = await supabase
      .from('emi_schedules').select('*')
      .eq('user_id', getUserId())
      .order('installment_number', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapEmi);
  },
  async bulkAdd(entries: EmiSchedule[]) {
    const rows = entries.map(e => ({
      id: e.id, user_id: getUserId(), loan_id: e.loanId,
      installment_number: e.installmentNumber, due_date: e.dueDate,
      amount: e.amount, status: e.status,
    }));
    const { error } = await supabase.from('emi_schedules').insert(rows);
    if (error) throw error;
  },
  async update(id: string, changes: Partial<EmiSchedule>) {
    const row: Record<string, unknown> = {};
    if (changes.status !== undefined) row.status = changes.status;
    const { error } = await supabase.from('emi_schedules').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GOALS
// ══════════════════════════════════════
export const goalsDb = {
  async getAll(): Promise<Goal[]> {
    const { data, error } = await supabase
      .from('goals').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGoal);
  },
  async add(g: Goal) {
    const { error } = await supabase.from('goals').insert({
      id: g.id, user_id: getUserId(), title: g.title,
      target_amount: g.targetAmount, saved_amount: g.savedAmount,
      currency: g.currency, stored_in_account_id: g.storedInAccountId,
      created_at: g.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Goal>) {
    const row: Record<string, unknown> = {};
    if (changes.savedAmount !== undefined) row.saved_amount = changes.savedAmount;
    if (changes.title !== undefined) row.title = changes.title;
    const { error } = await supabase.from('goals').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('goals').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// ACTIVITIES
// ══════════════════════════════════════
export const activitiesDb = {
  async getAll(): Promise<ActivityLog[]> {
    const { data, error } = await supabase
      .from('activities').select('*')
      .eq('user_id', getUserId())
      .order('timestamp', { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []).map(mapActivity);
  },
  async add(a: ActivityLog) {
    const { error } = await supabase.from('activities').insert({
      id: a.id, user_id: getUserId(), type: a.type, description: a.description,
      related_entity_id: a.relatedEntityId, related_entity_type: a.relatedEntityType,
      timestamp: a.timestamp,
    });
    if (error) throw error;
  },
  async getByEntity(entityId: string): Promise<ActivityLog[]> {
    const { data, error } = await supabase
      .from('activities').select('*')
      .eq('user_id', getUserId())
      .eq('related_entity_id', entityId)
      .order('timestamp', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapActivity);
  },
};

// ══════════════════════════════════════
// UPCOMING EXPENSES
// ══════════════════════════════════════
export const upcomingExpensesDb = {
  async getAll(): Promise<UpcomingExpense[]> {
    const { data, error } = await supabase
      .from('upcoming_expenses').select('*')
      .eq('user_id', getUserId())
      .order('due_date', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapUpcoming);
  },
  async add(e: UpcomingExpense) {
    const { error } = await supabase.from('upcoming_expenses').insert({
      id: e.id, user_id: getUserId(), title: e.title, amount: e.amount,
      currency: e.currency, due_date: e.dueDate, account_id: e.accountId,
      category: e.category, notes: e.notes, is_paid: e.isPaid,
      status: e.status, reminder_days_before: e.reminderDaysBefore,
      created_at: e.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<UpcomingExpense>) {
    const row: Record<string, unknown> = {};
    if (changes.isPaid !== undefined) row.is_paid = changes.isPaid;
    if (changes.status !== undefined) row.status = changes.status;
    const { error } = await supabase.from('upcoming_expenses').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('upcoming_expenses').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// SPLIT GROUPS
// ══════════════════════════════════════
export const splitGroupsDb = {
  async getAll(): Promise<SplitGroup[]> {
    const { data, error } = await supabase
      .from('split_groups').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroup);
  },
  async add(g: SplitGroup) {
    const { error } = await supabase.from('split_groups').insert({
      id: g.id, user_id: getUserId(), name: g.name, emoji: g.emoji,
      members: g.members, currency: g.currency, settled: g.settled,
      created_at: g.createdAt,
    });
    if (error) throw error;
  },
  async get(id: string): Promise<SplitGroup | null> {
    const { data, error } = await supabase
      .from('split_groups').select('*')
      .eq('id', id).eq('user_id', getUserId()).single();
    if (error) return null;
    return data ? mapGroup(data) : null;
  },
  async delete(id: string) {
    const { error } = await supabase.from('split_groups').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GROUP EXPENSES
// ══════════════════════════════════════
export const groupExpensesDb = {
  async getByGroup(groupId: string): Promise<GroupExpense[]> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .eq('group_id', groupId).eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupExpense);
  },
  async add(e: GroupExpense) {
    const { error } = await supabase.from('group_expenses').insert({
      id: e.id, user_id: getUserId(), group_id: e.groupId,
      description: e.description, amount: e.amount, paid_by: e.paidBy,
      split_type: e.splitType, splits: e.splits, category: e.category,
      date: e.date, notes: e.notes, created_at: e.createdAt,
    });
    if (error) throw error;
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_expenses').delete().eq('group_id', groupId).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GROUP SETTLEMENTS
// ══════════════════════════════════════
export const groupSettlementsDb = {
  async getByGroup(groupId: string): Promise<GroupSettlement[]> {
    const { data, error } = await supabase
      .from('group_settlements').select('*')
      .eq('group_id', groupId).eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupSettlement);
  },
  async add(s: GroupSettlement) {
    const { error } = await supabase.from('group_settlements').insert({
      id: s.id, user_id: getUserId(), group_id: s.groupId,
      from_member: s.fromMember, to_member: s.toMember,
      amount: s.amount, date: s.date, note: s.note,
      created_at: s.createdAt,
    });
    if (error) throw error;
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_settlements').delete().eq('group_id', groupId).eq('user_id', getUserId());
    if (error) throw error;
  },
};


// ══════════════════════════════════════
// Mapping helpers: snake_case DB → camelCase app types
// ══════════════════════════════════════

function mapAccount(r: Record<string, unknown>): Account {
  return {
    id: r.id as string, name: r.name as string, type: r.type as Account['type'],
    currency: r.currency as Account['currency'], balance: Number(r.balance),
    metadata: (r.metadata ?? {}) as Record<string, string>, createdAt: r.created_at as string,
  };
}

function mapTransaction(r: Record<string, unknown>): Transaction {
  return {
    id: r.id as string, type: r.type as Transaction['type'], amount: Number(r.amount),
    currency: r.currency as Transaction['currency'],
    sourceAccountId: (r.source_account_id as string) ?? null,
    destinationAccountId: (r.destination_account_id as string) ?? null,
    relatedPerson: (r.related_person as string) ?? null,
    relatedLoanId: (r.related_loan_id as string) ?? null,
    relatedGoalId: (r.related_goal_id as string) ?? null,
    conversionRate: r.conversion_rate != null ? Number(r.conversion_rate) : null,
    category: (r.category as string) ?? '', notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
  };
}

function mapLoan(r: Record<string, unknown>): Loan {
  return {
    id: r.id as string, personName: r.person_name as string,
    type: r.type as Loan['type'], totalAmount: Number(r.total_amount),
    remainingAmount: Number(r.remaining_amount), currency: r.currency as Loan['currency'],
    status: r.status as Loan['status'], notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
  };
}

function mapEmi(r: Record<string, unknown>): EmiSchedule {
  return {
    id: r.id as string, loanId: r.loan_id as string,
    installmentNumber: Number(r.installment_number), dueDate: r.due_date as string,
    amount: Number(r.amount), status: r.status as EmiSchedule['status'],
  };
}

function mapGoal(r: Record<string, unknown>): Goal {
  return {
    id: r.id as string, title: r.title as string,
    targetAmount: Number(r.target_amount), savedAmount: Number(r.saved_amount),
    currency: r.currency as Goal['currency'],
    storedInAccountId: (r.stored_in_account_id as string) ?? '',
    createdAt: r.created_at as string,
  };
}

function mapActivity(r: Record<string, unknown>): ActivityLog {
  return {
    id: r.id as string, type: r.type as ActivityLog['type'],
    description: (r.description as string) ?? '',
    relatedEntityId: (r.related_entity_id as string) ?? '',
    relatedEntityType: (r.related_entity_type as string) ?? '',
    timestamp: r.timestamp as string,
  };
}

function mapUpcoming(r: Record<string, unknown>): UpcomingExpense {
  return {
    id: r.id as string, title: r.title as string,
    amount: Number(r.amount), currency: r.currency as UpcomingExpense['currency'],
    dueDate: r.due_date as string, accountId: (r.account_id as string) ?? '',
    category: (r.category as string) ?? '', notes: (r.notes as string) ?? '',
    isPaid: Boolean(r.is_paid), status: r.status as UpcomingExpense['status'],
    reminderDaysBefore: Number(r.reminder_days_before ?? 0),
    createdAt: r.created_at as string,
  };
}

function mapGroup(r: Record<string, unknown>): SplitGroup {
  return {
    id: r.id as string, name: r.name as string, emoji: (r.emoji as string) ?? '',
    members: r.members as SplitGroup['members'], currency: r.currency as SplitGroup['currency'],
    settled: Boolean(r.settled), createdAt: r.created_at as string,
  };
}

function mapGroupExpense(r: Record<string, unknown>): GroupExpense {
  return {
    id: r.id as string, groupId: r.group_id as string,
    description: (r.description as string) ?? '', amount: Number(r.amount),
    paidBy: r.paid_by as string, splitType: r.split_type as GroupExpense['splitType'],
    splits: r.splits as GroupExpense['splits'], category: (r.category as string) ?? '',
    date: (r.date as string) ?? '', notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
  };
}

function mapGroupSettlement(r: Record<string, unknown>): GroupSettlement {
  return {
    id: r.id as string, groupId: r.group_id as string,
    fromMember: r.from_member as string, toMember: r.to_member as string,
    amount: Number(r.amount), date: (r.date as string) ?? '',
    note: (r.note as string) ?? '', createdAt: r.created_at as string,
  };
}
