import { supabase } from './supabase';
import type {
  Account, Transaction, Loan, EmiSchedule, Goal,
  ActivityLog, UpcomingExpense, SplitGroup, GroupExpense, GroupSettlement,
  GroupMember, GroupInvite, GroupEvent, AppNotification, Person,
  LinkedRequest, LinkedRequestKind, SettlementRequest, Currency,
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
  async get(id: string): Promise<Transaction | null> {
    const { data, error } = await supabase
      .from('transactions').select('*')
      .eq('id', id).eq('user_id', getUserId()).single();
    if (error) return null;
    return data ? mapTransaction(data) : null;
  },
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
      related_person: t.relatedPerson, person_id: t.personId ?? null, related_loan_id: t.relatedLoanId,
      related_goal_id: t.relatedGoalId, conversion_rate: t.conversionRate,
      category: t.category, notes: t.notes, created_at: t.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Transaction>) {
    const row: Record<string, unknown> = {};
    if (changes.type !== undefined) row.type = changes.type;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.sourceAccountId !== undefined) row.source_account_id = changes.sourceAccountId;
    if (changes.destinationAccountId !== undefined) row.destination_account_id = changes.destinationAccountId;
    if (changes.relatedPerson !== undefined) row.related_person = changes.relatedPerson;
    if (changes.personId !== undefined) row.person_id = changes.personId;
    if (changes.relatedLoanId !== undefined) row.related_loan_id = changes.relatedLoanId;
    if (changes.relatedGoalId !== undefined) row.related_goal_id = changes.relatedGoalId;
    if (changes.conversionRate !== undefined) row.conversion_rate = changes.conversionRate;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    const { error } = await supabase.from('transactions').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('transactions').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Narrow helper used only by the Phase 1B-A backfill. Deliberately separate
  // from the general `update` path so the write surface is grep-auditable.
  async setPersonId(id: string, personId: string) {
    const { error } = await supabase
      .from('transactions').update({ person_id: personId })
      .eq('id', id).eq('user_id', getUserId());
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
      id: l.id, user_id: getUserId(), person_name: l.personName, person_id: l.personId ?? null, type: l.type,
      total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
      currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Loan>) {
    const row: Record<string, unknown> = {};
    if (changes.personName !== undefined) row.person_name = changes.personName;
    if (changes.personId !== undefined) row.person_id = changes.personId;
    if (changes.totalAmount !== undefined) row.total_amount = changes.totalAmount;
    if (changes.remainingAmount !== undefined) row.remaining_amount = changes.remainingAmount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.notes !== undefined) row.notes = changes.notes;
    const { error } = await supabase.from('loans').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('loans').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Narrow helper used only by the Phase 1B-A backfill. See transactionsDb.setPersonId.
  async setPersonId(id: string, personId: string) {
    const { error } = await supabase
      .from('loans').update({ person_id: personId })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// PERSONS (contacts)
// ══════════════════════════════════════
export const personsDb = {
  async getAll(): Promise<Person[]> {
    const { data, error } = await supabase
      .from('persons').select('*')
      .eq('user_id', getUserId())
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapPerson);
  },
  async add(p: Person) {
    const { error } = await supabase.from('persons').insert({
      id: p.id, user_id: getUserId(), name: p.name, phone: p.phone ?? null,
      linked_profile_id: p.linkedProfileId ?? null,
      created_at: p.createdAt, updated_at: p.updatedAt,
    });
    if (error) throw error;
  },
  // Phase 2A: narrow helper — writes ONLY the linked_profile_id column.
  // Returns the Supabase error object untouched on failure so callers can
  // detect the unique-index violation (23505) and surface a clean message.
  async setLinkedProfileId(id: string, linkedProfileId: string | null) {
    const { error } = await supabase
      .from('persons').update({ linked_profile_id: linkedProfileId })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Phase 2A: SECURITY DEFINER RPC. Caller must pass the already-normalised
  // code (same rules as collaboration.normalizePublicCode). Returns null if
  // no match, the resolver's own code, or an invalid code.
  async lookupProfileByCode(normalisedCode: string): Promise<{ profileId: string; displayName: string } | null> {
    const { data, error } = await supabase.rpc('lookup_profile_by_code', { code: normalisedCode });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      profileId: (row.profile_id as string) ?? '',
      displayName: (row.display_name as string) ?? 'Hisaab user',
    };
  },
};

// ══════════════════════════════════════
// LINKED TRANSACTION REQUESTS (Phase 2B)
// Cloud-only. Writes go through RLS (insert) or SECURITY DEFINER RPCs
// (accept / reject / cancel). No Dexie mirror.
// ══════════════════════════════════════
export const linkedRequestsDb = {
  async getAll(): Promise<LinkedRequest[]> {
    const me = getUserId();
    const { data, error } = await supabase
      .from('linked_transaction_requests')
      .select('*')
      .or(`from_user_id.eq.${me},to_user_id.eq.${me}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapLinkedRequest);
  },
  async insert(input: {
    id: string;
    toUserId: string;
    personId: string;
    kind: LinkedRequestKind;
    amount: number;
    currency: Currency;
    note: string;
  }) {
    const { error } = await supabase.from('linked_transaction_requests').insert({
      id: input.id,
      from_user_id: getUserId(),
      to_user_id: input.toUserId,
      person_id: input.personId,
      kind: input.kind,
      amount: input.amount,
      currency: input.currency,
      note: input.note,
    });
    if (error) throw error;
  },
  async accept(requestId: string): Promise<LinkedRequest> {
    const { data, error } = await supabase.rpc('accept_linked_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: accept returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
  async reject(requestId: string, reason?: string): Promise<LinkedRequest> {
    const { data, error } = await supabase.rpc('reject_linked_request', {
      request_id: requestId,
      reason: reason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: reject returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
  async cancel(requestId: string): Promise<LinkedRequest> {
    const { data, error } = await supabase.rpc('cancel_linked_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: cancel returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
};

function mapLinkedRequest(r: Record<string, unknown>): LinkedRequest {
  return {
    id: r.id as string,
    fromUserId: r.from_user_id as string,
    toUserId: r.to_user_id as string,
    personId: (r.person_id as string) ?? null,
    kind: r.kind as LinkedRequest['kind'],
    amount: Number(r.amount),
    currency: r.currency as LinkedRequest['currency'],
    note: (r.note as string) ?? '',
    status: r.status as LinkedRequest['status'],
    rejectionReason: (r.rejection_reason as string) ?? null,
    requesterLoanId: (r.requester_loan_id as string) ?? null,
    responderLoanId: (r.responder_loan_id as string) ?? null,
    requesterTxnId: (r.requester_txn_id as string) ?? null,
    responderTxnId: (r.responder_txn_id as string) ?? null,
    loanPairId: (r.loan_pair_id as string) ?? null,
    createdAt: r.created_at as string,
    respondedAt: (r.responded_at as string) ?? null,
  };
}

function mapSettlementRequest(r: Record<string, unknown>): SettlementRequest {
  return {
    id: r.id as string,
    loanPairId: r.loan_pair_id as string,
    requesterLoanId: r.requester_loan_id as string,
    responderLoanId: r.responder_loan_id as string,
    fromUserId: r.from_user_id as string,
    toUserId: r.to_user_id as string,
    amount: Number(r.amount),
    currency: r.currency as SettlementRequest['currency'],
    note: (r.note as string) ?? '',
    status: r.status as SettlementRequest['status'],
    rejectionReason: (r.rejection_reason as string) ?? null,
    requesterTxnId: (r.requester_txn_id as string) ?? null,
    responderTxnId: (r.responder_txn_id as string) ?? null,
    requesterAccountId: (r.requester_account_id as string) ?? null,
    createdAt: r.created_at as string,
    respondedAt: (r.responded_at as string) ?? null,
  };
}

// ══════════════════════════════════════
// LINKED SETTLEMENT REQUESTS (Phase 2C-A)
// Cloud-only. Ledger-only semantics: accept writes mirrored repayment
// transactions with null account ids and decrements remaining_amount on
// both loans. No account balance movement anywhere in 2C-A.
// ══════════════════════════════════════
export const settlementRequestsDb = {
  async getAll(): Promise<SettlementRequest[]> {
    const me = getUserId();
    const { data, error } = await supabase
      .from('linked_settlement_requests')
      .select('*')
      .or(`from_user_id.eq.${me},to_user_id.eq.${me}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapSettlementRequest);
  },
  async insert(input: {
    id: string;
    loanPairId: string;
    requesterLoanId: string;
    responderLoanId: string;
    toUserId: string;
    amount: number;
    currency: Currency;
    note: string;
    requesterAccountId?: string | null;
  }) {
    const { error } = await supabase.from('linked_settlement_requests').insert({
      id: input.id,
      loan_pair_id: input.loanPairId,
      requester_loan_id: input.requesterLoanId,
      responder_loan_id: input.responderLoanId,
      from_user_id: getUserId(),
      to_user_id: input.toUserId,
      amount: input.amount,
      currency: input.currency,
      note: input.note,
      requester_account_id: input.requesterAccountId ?? null,
    });
    if (error) throw error;
  },
  async accept(requestId: string): Promise<SettlementRequest> {
    const { data, error } = await supabase.rpc('accept_settlement_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: accept returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
  },
  async reject(requestId: string, reason?: string): Promise<SettlementRequest> {
    const { data, error } = await supabase.rpc('reject_settlement_request', {
      request_id: requestId,
      reason: reason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: reject returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
  },
  async cancel(requestId: string): Promise<SettlementRequest> {
    const { data, error } = await supabase.rpc('cancel_settlement_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: cancel returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
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
  async deleteByLoan(loanId: string) {
    const { error } = await supabase.from('emi_schedules').delete().eq('loan_id', loanId).eq('user_id', getUserId());
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
    const userId = getUserId();
    const [{ data: owned, error: ownedError }, { data: memberships, error: membersError }] = await Promise.all([
      supabase
        .from('split_groups').select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('group_members').select('group_id')
        .eq('profile_id', userId)
        .eq('status', 'connected'),
    ]);

    if (ownedError) throw ownedError;
    if (membersError && membersError.code !== 'PGRST116') throw membersError;

    const ids = Array.from(new Set([...(owned ?? []).map(row => String(row.id)), ...((memberships ?? []).map(row => String(row.group_id)))]));
    if (ids.length === 0) return [];

    const { data, error } = await supabase
      .from('split_groups').select('*')
      .in('id', ids)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroup);
  },
  async add(g: SplitGroup) {
    const { error } = await supabase.from('split_groups').insert({
      id: g.id, user_id: getUserId(), name: g.name, emoji: g.emoji,
      members: g.members, currency: g.currency, settled: g.settled,
      created_at: g.createdAt, created_by: g.createdBy ?? getUserId(),
      join_code: g.joinCode ?? null,
      join_code_normalized: g.joinCodeNormalized ?? null,
    });
    if (error) throw error;
  },
  async get(id: string): Promise<SplitGroup | null> {
    const { data, error } = await supabase
      .from('split_groups').select('*')
      .eq('id', id).single();
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
  async get(id: string): Promise<GroupExpense | null> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();
    if (error) return null;
    return data ? mapGroupExpense(data) : null;
  },
  async getByGroup(groupId: string): Promise<GroupExpense[]> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupExpense);
  },
  // Returns every expense across every group the caller can see. RLS on
  // group_expenses already limits this to groups the user is a member of,
  // so this is the batched counterpart to getByGroup — two queries for
  // the whole Groups tab instead of 2N.
  async getAllVisible(): Promise<GroupExpense[]> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .is('deleted_at', null)
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
      created_by: e.createdBy ?? getUserId(),
      updated_by: e.updatedBy ?? getUserId(),
      version: e.version ?? 1,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<GroupExpense>) {
    const row: Record<string, unknown> = {};
    if (changes.description !== undefined) row.description = changes.description;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.paidBy !== undefined) row.paid_by = changes.paidBy;
    if (changes.splitType !== undefined) row.split_type = changes.splitType;
    if (changes.splits !== undefined) row.splits = changes.splits;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.updatedBy !== undefined) row.updated_by = changes.updatedBy;
    if (changes.deletedAt !== undefined) row.deleted_at = changes.deletedAt;
    if (changes.deletedBy !== undefined) row.deleted_by = changes.deletedBy;
    if (changes.version !== undefined) row.version = changes.version;
    const { error } = await supabase.from('group_expenses').update(row).eq('id', id);
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('group_expenses')
      .update({ deleted_at: new Date().toISOString(), deleted_by: getUserId() })
      .eq('id', id);
    if (error) throw error;
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_expenses').delete().eq('group_id', groupId);
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
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupSettlement);
  },
  // Batched counterpart — RLS scopes to groups the user can see.
  async getAllVisible(): Promise<GroupSettlement[]> {
    const { data, error } = await supabase
      .from('group_settlements').select('*')
      .is('deleted_at', null)
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
      created_by: s.createdBy ?? getUserId(),
      updated_by: s.updatedBy ?? getUserId(),
    });
    if (error) throw error;
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_settlements').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

export const groupMembersDb = {
  async getByGroup(groupId: string): Promise<GroupMember[]> {
    const { data, error } = await supabase
      .from('group_members').select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapGroupMember);
  },
  async add(member: GroupMember & { groupId: string; invitedBy?: string | null }) {
    const { error } = await supabase.from('group_members').insert({
      id: member.id,
      group_id: member.groupId,
      profile_id: member.profileId ?? null,
      display_name: member.name,
      role: member.role ?? (member.isOwner ? 'owner' : 'member'),
      status: member.status ?? (member.profileId ? 'connected' : 'guest'),
      invited_by: member.invitedBy ?? getUserId(),
      joined_at: member.joinedAt ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  },
  async addMany(groupId: string, members: GroupMember[]) {
    if (members.length === 0) return;
    const rows = members.map(member => ({
      id: member.id,
      group_id: groupId,
      profile_id: member.profileId ?? null,
      display_name: member.name,
      role: member.role ?? (member.isOwner ? 'owner' : 'member'),
      status: member.status ?? (member.profileId ? 'connected' : 'guest'),
      invited_by: getUserId(),
      joined_at: member.joinedAt ?? null,
      created_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('group_members').insert(rows);
    if (error) throw error;
  },
  async update(id: string, changes: Partial<GroupMember>) {
    const row: Record<string, unknown> = {};
    if (changes.name !== undefined) row.display_name = changes.name;
    if (changes.profileId !== undefined) row.profile_id = changes.profileId;
    if (changes.role !== undefined) row.role = changes.role;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.joinedAt !== undefined) row.joined_at = changes.joinedAt;
    const { error } = await supabase.from('group_members').update(row).eq('id', id);
    if (error) throw error;
  },
  async getMine(): Promise<Array<{ groupId: string; memberId: string }>> {
    const { data, error } = await supabase
      .from('group_members').select('id, group_id')
      .eq('profile_id', getUserId())
      .eq('status', 'connected');
    if (error) throw error;
    return (data ?? []).map(row => ({ groupId: String(row.group_id), memberId: String(row.id) }));
  },
};

export const groupInvitesDb = {
  async add(invite: GroupInvite) {
    const { error } = await supabase.from('group_invites').insert({
      id: invite.id,
      group_id: invite.groupId,
      token_hash: invite.tokenHash,
      created_by: invite.createdBy,
      linked_member_id: invite.linkedMemberId,
      expires_at: invite.expiresAt,
      revoked_at: invite.revokedAt,
      accepted_by: invite.acceptedBy,
      accepted_at: invite.acceptedAt,
      created_at: invite.createdAt,
    });
    if (error) throw error;
  },
  async getByTokenHash(tokenHash: string): Promise<GroupInvite | null> {
    const { data, error } = await supabase
      .from('group_invites').select('*')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .single();
    if (error) return null;
    return data ? mapGroupInvite(data) : null;
  },
  async getActiveByGroup(groupId: string): Promise<GroupInvite[]> {
    const { data, error } = await supabase
      .from('group_invites').select('*')
      .eq('group_id', groupId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupInvite);
  },
  async update(id: string, changes: Partial<GroupInvite>) {
    const row: Record<string, unknown> = {};
    if (changes.revokedAt !== undefined) row.revoked_at = changes.revokedAt;
    if (changes.acceptedBy !== undefined) row.accepted_by = changes.acceptedBy;
    if (changes.acceptedAt !== undefined) row.accepted_at = changes.acceptedAt;
    if (changes.linkedMemberId !== undefined) row.linked_member_id = changes.linkedMemberId;
    const { error } = await supabase.from('group_invites').update(row).eq('id', id);
    if (error) throw error;
  },
};

export const groupEventsDb = {
  async getByGroup(groupId: string): Promise<GroupEvent[]> {
    const { data, error } = await supabase
      .from('group_events').select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupEvent);
  },
  async add(event: GroupEvent) {
    const { error } = await supabase.from('group_events').insert({
      id: event.id,
      group_id: event.groupId,
      actor_profile_id: event.actorProfileId,
      event_type: event.eventType,
      entity_type: event.entityType,
      entity_id: event.entityId,
      summary: event.summary,
      payload: event.payload,
      created_at: event.createdAt,
    });
    if (error) throw error;
  },
};

export const notificationsDb = {
  async getAll(): Promise<AppNotification[]> {
    const { data, error } = await supabase
      .from('notifications').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []).map(mapNotification);
  },
  async addMany(notifications: AppNotification[]) {
    if (notifications.length === 0) return;
    const { error } = await supabase.from('notifications').insert(
      notifications.map(notification => ({
        id: notification.id,
        user_id: notification.userId,
        group_id: notification.groupId,
        event_id: notification.eventId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        read_at: notification.readAt,
        created_at: notification.createdAt,
      })),
    );
    if (error) throw error;
  },
  async markRead(id: string) {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  async markAllRead() {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', getUserId())
      .is('read_at', null);
    if (error) throw error;
  },
  async markGroupRead(groupId: string) {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', getUserId())
      .eq('group_id', groupId)
      .is('read_at', null);
    if (error) throw error;
  },
};

export const profilesDb = {
  async getCurrent(): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabase
      .from('profiles').select('*')
      .eq('id', getUserId())
      .single();
    if (error) return null;
    return data ?? null;
  },
  async updateCurrent(changes: Record<string, unknown>) {
    const { error } = await supabase.from('profiles').update(changes).eq('id', getUserId());
    if (error) throw error;
  },
  async findByPublicCode(normalizedCode: string): Promise<{ id: string; name: string; publicCode: string } | null> {
    // Uses SECURITY DEFINER RPC so we can resolve strangers by their public
    // code without opening up a read policy on profiles.
    const { data, error } = await supabase.rpc('lookup_profile_by_public_code', {
      code_normalized: normalizedCode,
    });
    if (error || !data || data.length === 0) return null;
    const row = data[0] as { id: string; name: string; public_code: string };
    return { id: row.id, name: row.name ?? '', publicCode: row.public_code ?? '' };
  },
};

export const accountDeletionDb = {
  async softDeleteCurrentUser() {
    const { error } = await supabase.rpc('soft_delete_current_user');
    if (error) throw error;
  },
};

export const groupsLookupDb = {
  async findByJoinCode(normalizedCode: string): Promise<{ id: string; name: string; emoji: string; currency: string } | null> {
    const { data, error } = await supabase.rpc('lookup_group_by_join_code', {
      code_normalized: normalizedCode,
    });
    if (error || !data || data.length === 0) return null;
    const row = data[0] as { id: string; name: string; emoji: string; currency: string };
    return { id: row.id, name: row.name ?? '', emoji: row.emoji ?? '', currency: row.currency ?? 'PKR' };
  },

  // Atomic join: SECURITY DEFINER RPC resolves the code and upserts the
  // caller's membership in one step. Needed because a non-member can't read
  // split_groups directly — the prior "lookup → re-fetch → insert" flow
  // always failed at the re-fetch step under strict RLS.
  async joinByCode(
    normalizedCode: string,
    displayName: string,
  ): Promise<{ groupId: string; memberId: string; wasAlreadyConnected: boolean } | null> {
    const { data, error } = await supabase.rpc('join_group_by_code', {
      p_code_normalized: normalizedCode,
      p_display_name: displayName,
    });
    if (error) {
      // Bubble the Postgres message up so the UI layer can classify it
      // ("Group code not found", "Not authenticated", …).
      throw new Error(error.message || 'Join failed');
    }
    if (!data || data.length === 0) return null;
    const row = data[0] as { group_id: string; member_id: string; was_already_connected: boolean };
    return {
      groupId: row.group_id,
      memberId: row.member_id,
      wasAlreadyConnected: Boolean(row.was_already_connected),
    };
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
    personId: (r.person_id as string) ?? null,
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
    personId: (r.person_id as string) ?? null,
    type: r.type as Loan['type'], totalAmount: Number(r.total_amount),
    remainingAmount: Number(r.remaining_amount), currency: r.currency as Loan['currency'],
    status: r.status as Loan['status'], notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
  };
}

function mapPerson(r: Record<string, unknown>): Person {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    linkedProfileId: (r.linked_profile_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
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
    createdBy: (r.created_by as string) ?? (r.user_id as string) ?? null,
    joinCode: (r.join_code as string) ?? null,
    joinCodeNormalized: (r.join_code_normalized as string) ?? null,
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
    createdBy: (r.created_by as string) ?? null,
    updatedBy: (r.updated_by as string) ?? null,
    deletedAt: (r.deleted_at as string) ?? null,
    deletedBy: (r.deleted_by as string) ?? null,
    version: Number(r.version ?? 1),
  };
}

function mapGroupSettlement(r: Record<string, unknown>): GroupSettlement {
  return {
    id: r.id as string, groupId: r.group_id as string,
    fromMember: r.from_member as string, toMember: r.to_member as string,
    amount: Number(r.amount), date: (r.date as string) ?? '',
    note: (r.note as string) ?? '', createdAt: r.created_at as string,
    createdBy: (r.created_by as string) ?? null,
    updatedBy: (r.updated_by as string) ?? null,
    deletedAt: (r.deleted_at as string) ?? null,
    deletedBy: (r.deleted_by as string) ?? null,
  };
}

function mapGroupMember(r: Record<string, unknown>): GroupMember {
  const role = (r.role as GroupMember['role']) ?? 'member';
  return {
    id: r.id as string,
    name: (r.display_name as string) ?? '',
    isOwner: role === 'owner',
    profileId: (r.profile_id as string) ?? null,
    role,
    status: (r.status as GroupMember['status']) ?? 'guest',
    joinedAt: (r.joined_at as string) ?? null,
  };
}

function mapGroupInvite(r: Record<string, unknown>): GroupInvite {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    tokenHash: r.token_hash as string,
    createdBy: r.created_by as string,
    linkedMemberId: (r.linked_member_id as string) ?? null,
    expiresAt: (r.expires_at as string) ?? null,
    revokedAt: (r.revoked_at as string) ?? null,
    acceptedBy: (r.accepted_by as string) ?? null,
    acceptedAt: (r.accepted_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapGroupEvent(r: Record<string, unknown>): GroupEvent {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    actorProfileId: (r.actor_profile_id as string) ?? null,
    eventType: r.event_type as GroupEvent['eventType'],
    entityType: r.entity_type as GroupEvent['entityType'],
    entityId: r.entity_id as string,
    summary: (r.summary as string) ?? '',
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}

function mapNotification(r: Record<string, unknown>): AppNotification {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    groupId: (r.group_id as string) ?? null,
    eventId: (r.event_id as string) ?? null,
    type: r.type as AppNotification['type'],
    title: (r.title as string) ?? '',
    body: (r.body as string) ?? '',
    readAt: (r.read_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}
