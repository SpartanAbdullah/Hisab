import { supabase } from './supabase';
import { tStatic } from './i18n';
import {
  joinStatusFromThrown,
  parseJoinByCodeResponse,
  inviteStatusFromThrown,
  parseAcceptInviteResponse,
  type JoinCodeResult,
  type InviteAcceptResult,
} from './joinCodeStatus';
import {
  parseGroupPreviewResponse,
  previewStatusFromThrown,
  type GroupPreviewResult,
} from './groupPreview';
import { isMemberAlreadyExistsError } from './groupGuardErrors';
import {
  isMissingFunctionError,
  linkStatusFromThrown,
  parseLinkByCodeResponse,
  parseUnlinkResponse,
  type ContactLinkResult,
  type ContactUnlinkResult,
} from './contactLinkStatus';
import { fetchAllPages, type PagedFetchResult } from './pagedFetch';
import type { RecordSettlementResult } from './groupSettlementResult';
import type {
  Account, Transaction, Loan, EmiSchedule, Goal,
  ActivityLog, UpcomingExpense, SplitGroup, GroupExpense, GroupSettlement,
  GroupMember, GroupInvite, GroupEvent, AppNotification, Person,
  LinkedRequest, LinkedRequestKind, SettlementRequest, Currency,
  Budget, RecurringTransaction, Remittance, CustomCategory,
  Committee, CommitteeMember, CommitteePayment,
  InvestmentMarket, InvestmentTrade, InvestmentPrice,
} from '../db';

export interface DeletedRow {
  id: string;
  deletedAt: string;
}

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
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAccount);
  },
  async getUpdatedSince(updatedAfter: string): Promise<Account[]> {
    const { data, error } = await supabase
      .from('accounts').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAccount);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('accounts').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(a: Account) {
    const { error } = await supabase.from('accounts').insert({
      id: a.id, user_id: getUserId(), name: a.name, type: a.type,
      currency: a.currency, balance: a.balance, metadata: a.metadata, created_at: a.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Account>) {
    // Balance updates MUST go through applyBalanceDelta (optimistic lock).
    // Updating balance through this path is permitted only as a last-resort
    // (e.g. reconciliation), so we leave it in place but log a warning.
    if (changes.balance !== undefined && import.meta.env.DEV) {
      console.warn('[accountsDb.update] balance changed without optimistic lock — prefer accountsDb.applyBalanceDelta');
    }
    const row: Record<string, unknown> = {};
    if (changes.balance !== undefined) row.balance = changes.balance;
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.metadata !== undefined) row.metadata = changes.metadata;
    const { error } = await supabase.from('accounts').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Optimistic-locked balance mutation. Calls the apply_account_balance_delta RPC
  // which performs `UPDATE accounts SET balance = balance + $delta WHERE balance = $expected`.
  // Throws { code: 'BALANCE_CONFLICT' } if expected_balance didn't match — caller
  // should refresh the local row and retry.
  async applyBalanceDelta(id: string, expectedBalance: number, delta: number): Promise<number> {
    const { data, error } = await supabase.rpc('apply_account_balance_delta', {
      p_account_id: id,
      p_delta: delta,
      p_expected_balance: expectedBalance,
    });
    if (error) {
      const err = error as { message?: string };
      if (err?.message?.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as Error & { code: string };
        conflict.code = 'BALANCE_CONFLICT';
        throw conflict;
      }
      throw error;
    }
    return typeof data === 'number' ? data : Number(data);
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('accounts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  async count(): Promise<number> {
    const { count, error } = await supabase
      .from('accounts').select('id', { count: 'exact', head: true })
      .eq('user_id', getUserId())
      .is('deleted_at', null);
    if (error) throw error;
    return count ?? 0;
  },
};

// ══════════════════════════════════════
// TRANSACTIONS
// ══════════════════════════════════════
// Well under the PostgREST max-rows cap (hosted default 1000) so a short page
// genuinely means "end of table" rather than "the server stopped early".
const TRANSACTION_PAGE_SIZE = 500;

export const transactionsDb = {
  async get(id: string): Promise<Transaction | null> {
    const { data, error } = await supabase
      .from('transactions').select('*')
      .eq('id', id).eq('user_id', getUserId()).is('deleted_at', null).single();
    if (error) return null;
    return data ? mapTransaction(data) : null;
  },
  /**
   * Complete transaction history. Keyset-paged: an unbounded `select('*')` is
   * silently truncated by PostgREST at its max-rows cap (~1000), and the mirror
   * then deleted the overflow locally — invisible history loss about a year in
   * (audit 04-supabase F-FE1). Use `getAllPaged` when you need to know whether
   * the result is complete before overwriting a local copy.
   */
  async getAll(): Promise<Transaction[]> {
    return (await transactionsDb.getAllPaged()).rows;
  },
  async getAllPaged(): Promise<PagedFetchResult<Transaction>> {
    const userId = getUserId();
    return fetchAllPages<Transaction>({
      label: 'transactions.getAll',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      cursorOf: (t) => t.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapTransaction);
      },
    });
  },
  async getUpdatedSince(updatedAfter: string): Promise<Transaction[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<Transaction>({
      label: 'transactions.getUpdatedSince',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      // mapTransaction falls back to created_at, so this is never null.
      cursorOf: (t) => t.updatedAt ?? null,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        query = cursor
          ? query.gte('updated_at', cursor)
          : query.gt('updated_at', updatedAfter);
        const { data, error } = await query
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapTransaction);
      },
    });
    return rows;
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<DeletedRow>({
      label: 'transactions.getDeletedSince',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (r) => r.id,
      cursorOf: (r) => r.deletedAt ?? null,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('id, deleted_at')
          .eq('user_id', userId);
        query = cursor
          ? query.gte('deleted_at', cursor)
          : query.gt('deleted_at', deletedAfter);
        const { data, error } = await query
          .order('deleted_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapDeletedRow);
      },
    });
    return rows;
  },
  async add(t: Transaction) {
    const { error } = await supabase.from('transactions').upsert({
      id: t.id, user_id: getUserId(), type: t.type, amount: t.amount, currency: t.currency,
      source_account_id: t.sourceAccountId, destination_account_id: t.destinationAccountId,
      related_person: t.relatedPerson, person_id: t.personId ?? null, related_loan_id: t.relatedLoanId,
      related_goal_id: t.relatedGoalId,
      // Only sent when set: keeps every NON-investment entry working on a
      // database that hasn't applied supabase-migration-investments.sql yet
      // (an unknown column in the payload would fail the whole insert).
      ...(t.relatedInvestmentId != null ? { related_investment_id: t.relatedInvestmentId } : {}),
      conversion_rate: t.conversionRate,
      category: t.category, notes: t.notes, created_at: t.createdAt,
      is_reconciled: t.isReconciled ?? false,
      reconciled_at: t.reconciledAt ?? null,
      reconciled_by: t.reconciledBy ?? null,
      receipt_path: t.receiptPath ?? null,
      deleted_at: null,
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
    if (changes.relatedInvestmentId !== undefined) row.related_investment_id = changes.relatedInvestmentId;
    if (changes.conversionRate !== undefined) row.conversion_rate = changes.conversionRate;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.isReconciled !== undefined) row.is_reconciled = changes.isReconciled;
    if (changes.reconciledAt !== undefined) row.reconciled_at = changes.reconciledAt;
    if (changes.reconciledBy !== undefined) row.reconciled_by = changes.reconciledBy;
    if (changes.receiptPath !== undefined) row.receipt_path = changes.receiptPath;
    const { error } = await supabase.from('transactions').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('transactions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
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
  async get(id: string): Promise<Loan | null> {
    const { data, error } = await supabase
      .from('loans').select('*')
      .eq('id', id).eq('user_id', getUserId()).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    return data ? mapLoan(data) : null;
  },
  /**
   * Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): an unbounded
   * `select('*')` is silently truncated by PostgREST at its max-rows cap
   * (~1000), and the mirror would then delete the overflow locally — the same
   * invisible history loss transactionsDb.getAll used to cause.
   */
  async getAll(): Promise<Loan[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<Loan>({
      label: 'loans.getAll',
      pageSize: 500,
      idOf: (l) => l.id,
      cursorOf: (l) => l.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('loans').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapLoan);
      },
    });
    return rows;
  },
  async getUpdatedSince(updatedAfter: string): Promise<Loan[]> {
    const { data, error } = await supabase
      .from('loans').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapLoan);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('loans').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(l: Loan) {
    const { error } = await supabase.from('loans').upsert({
      id: l.id, user_id: getUserId(), person_name: l.personName, person_id: l.personId ?? null, type: l.type,
      total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
      currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
      deleted_at: null,
    });
    if (error) throw error;
  },
  // Optimistic-locked remaining-amount mutation — the loan twin of
  // accountsDb.applyBalanceDelta. Calls apply_loan_remaining_delta
  // (supabase-migration-audit-p0-loan-concurrency.sql), which performs
  // `remaining_amount = round(GREATEST(0, remaining_amount + delta), 2)` ONLY
  // when remaining_amount still equals p_expected_remaining, and re-derives
  // status in the same statement. Returns the new remaining amount.
  // Throws { code: 'LOAN_REMAINING_CONFLICT' } when the row moved under us
  // (another device/tab) and { code: 'LOAN_NOT_FOUND' } when it is gone or not
  // ours — src/lib/loanRemainingDelta.ts owns the refetch-and-retry ladder.
  // Every remainingAmount write must come through here (audit F-2 / C-1); the
  // absolute `update` path below is for the other columns.
  async applyRemainingDelta(id: string, expectedRemaining: number, delta: number): Promise<number> {
    const { data, error } = await supabase.rpc('apply_loan_remaining_delta', {
      p_loan_id: id,
      p_delta: delta,
      p_expected_remaining: expectedRemaining,
    });
    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      for (const code of ['LOAN_REMAINING_CONFLICT', 'LOAN_NOT_FOUND'] as const) {
        if (message.includes(code)) {
          const coded = new Error(code) as Error & { code: string };
          coded.code = code;
          throw coded;
        }
      }
      throw error;
    }
    return typeof data === 'number' ? data : Number(data);
  },
  async update(id: string, changes: Partial<Loan>) {
    // remaining_amount MUST go through applyRemainingDelta (optimistic lock).
    // It is still accepted here for the linked-loan/backfill paths that write a
    // whole row, but a bare absolute write is the F-2 lost-update bug.
    if (changes.remainingAmount !== undefined && import.meta.env.DEV) {
      console.warn('[loansDb.update] remainingAmount changed without optimistic lock — prefer loansDb.applyRemainingDelta');
    }
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
    const { error } = await supabase
      .from('loans')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
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

// The pre-RPC direct write, kept ONLY for a database that has not had
// supabase-migration-audit-p0-consent-guards.sql applied yet (PostgREST
// PGRST202 / 42883: the function isn't there). Migrations in this repo are
// applied by hand, so a client build can meet either database; on a migrated
// one this path is rejected by the guard trigger with 42501 and must never be
// reached. Not exported — both link entry points fall back through here.
async function legacyDirectContactLink(
  personId: string,
  profileId: string,
  displayName: string,
): Promise<ContactLinkResult> {
  const { error } = await supabase
    .from('persons').update({ linked_profile_id: profileId })
    .eq('id', personId).eq('user_id', getUserId());
  if (error) return { status: linkStatusFromThrown(error) };
  // Best-effort ping, exactly as apply_verified_contact_link does server-side:
  // a notification failure must never undo a link that already succeeded.
  try {
    await personsDb.notifyContactLinked(profileId);
  } catch (err) {
    console.error('notifyContactLinked failed (non-fatal)', err);
  }
  // The reciprocal side is unknowable from here without another round trip;
  // 'pending' is the fail-closed answer (it only shows the waiting copy).
  return { status: 'ok', profileId, displayName: displayName || 'Hisaab user', linkState: 'pending' };
}

export const personsDb = {
  async getAll(): Promise<Person[]> {
    const { data, error } = await supabase
      .from('persons').select('*')
      .eq('user_id', getUserId())
      .is('archived_at', null)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapPerson);
  },
  // linked_profile_id is deliberately NOT sent (audit 2026-09 C6 / H2): the
  // consent-guard trigger rejects a non-null value from a client role on
  // INSERT too, and a link may only be created through link_contact_by_code or
  // link_contact_by_discovery.
  async add(p: Person) {
    const { error } = await supabase.from('persons').insert({
      id: p.id, user_id: getUserId(), name: p.name, phone: p.phone ?? null,
      created_at: p.createdAt, updated_at: p.updatedAt,
    });
    if (error) throw error;
  },
  // Create a contact link from the OTHER person's public code. The RPC checks
  // the code server-side (shared 20/hour lookup window), writes the column as
  // definer, and fires notify_contact_linked itself — so the client no longer
  // does either. Never throws on a business outcome; read `.status`.
  //
  // `legacy` keeps a build that lands BEFORE the migration working: when the
  // function is absent we fall back to the old direct write (still permitted
  // there, since the guard trigger arrives in the same file as the RPC).
  async linkByCode(
    personId: string,
    codeNormalized: string,
    legacy?: { profileId: string; displayName: string } | null,
  ): Promise<ContactLinkResult> {
    const { data, error } = await supabase.rpc('link_contact_by_code', {
      p_person_id: personId,
      p_code_normalized: codeNormalized,
    });
    if (!error) return parseLinkByCodeResponse(data);
    // A missing link_contact_by_code means the whole consent-guard file is
    // unapplied, so link_contact_by_discovery is missing too — go straight to
    // the legacy write instead of burning a round trip discovering that.
    if (isMissingFunctionError(error) && legacy?.profileId) {
      return legacyDirectContactLink(personId, legacy.profileId, legacy.displayName);
    }
    return { status: linkStatusFromThrown(error) };
  },
  // The code-LESS link: a phone-discovery hit carries a profile id and no
  // public code. The RPC does NOT trust that pairing — it re-runs the discovery
  // match server-side (this contact's saved phone, normalised the same way
  // phoneIdentity.toE164Candidates does it, against the target's phone_e164
  // while their phone_discoverable opt-in still holds), so we can only link
  // someone lookup_hisaab_users_by_phone would have returned anyway. Charged to
  // the phone-discovery window (20/hour) on a miss, not on a match.
  //
  // Same status vocabulary and same JSON shape as link_contact_by_code, hence
  // the shared parser. Never throws on a business outcome; read `.status`.
  async linkByProfileId(
    personId: string,
    profileId: string,
    displayName: string,
  ): Promise<ContactLinkResult> {
    const { data, error } = await supabase.rpc('link_contact_by_discovery', {
      p_person_id: personId,
      p_profile_id: profileId,
    });
    if (!error) return parseLinkByCodeResponse(data);
    // ONLY "the function isn't there" falls back. A 42501 must NOT: on a
    // migrated database the discovery RPC is the supported path, so a rejection
    // is a real answer and retrying the forbidden write would just relabel it.
    if (isMissingFunctionError(error)) {
      return legacyDirectContactLink(personId, profileId, displayName);
    }
    return { status: linkStatusFromThrown(error) };
  },
  // Clears the link. Same semantics as the old PATCH, minus the ability to
  // point the column anywhere.
  async unlinkProfile(personId: string): Promise<ContactUnlinkResult> {
    const { data, error } = await supabase.rpc('unlink_contact_profile', {
      p_person_id: personId,
    });
    if (!error) return parseUnlinkResponse(data);
    if (isMissingFunctionError(error)) {
      const { error: legacyError } = await supabase
        .from('persons').update({ linked_profile_id: null })
        .eq('id', personId).eq('user_id', getUserId());
      if (legacyError) return { status: linkStatusFromThrown(legacyError) };
      return { status: 'ok', wasLinked: true, unlinkedProfileId: null };
    }
    return { status: linkStatusFromThrown(error) };
  },
  async setPhone(id: string, phone: string | null) {
    const { error } = await supabase
      .from('persons').update({ phone })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async archiveIfSettled(id: string): Promise<ArchiveContactResult> {
    const { data, error } = await supabase.rpc('archive_contact_if_settled', {
      p_contact_id: id,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as ArchiveContactResult['reasonCode']) ?? 'CONTACT_NOT_FOUND',
      userMessage: (row?.user_message as string) ?? 'This contact could not be removed.',
      payableAmount: (row?.payable_amount as Record<string, number>) ?? {},
      receivableAmount: (row?.receivable_amount as Record<string, number>) ?? {},
    };
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
  // Tell the code owner that the caller just linked them (consensual — the
  // owner shared their code). SECURITY DEFINER RPC, guarded server-side so you
  // can only ping someone you've actually linked. Best-effort at the call site.
  async notifyContactLinked(profileId: string): Promise<void> {
    const { error } = await supabase.rpc('notify_contact_linked', { target_profile_id: profileId });
    if (error) throw error;
  },
  // Archived contacts are hidden from getAll; this is the explicit window
  // into them (the "Archived" section on ContactsPage).
  async getArchived(): Promise<Person[]> {
    const { data, error } = await supabase
      .from('persons').select('*')
      .eq('user_id', getUserId())
      .not('archived_at', 'is', null)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapPerson);
  },
  // SECURITY DEFINER RPC (supabase-migration-contacts-merge-unarchive.sql):
  // reassigns every reference from the LOCAL source contact to the target
  // atomically server-side, then archives the source.
  async merge(sourceId: string, targetId: string): Promise<MergePersonResult> {
    const { data, error } = await supabase.rpc('merge_person', {
      p_source_id: sourceId,
      p_target_id: targetId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as MergePersonResult['reasonCode']) ?? 'CONTACT_NOT_FOUND',
      userMessage: (row?.user_message as string) ?? 'These contacts could not be merged.',
      movedLoans: Number(row?.moved_loans ?? 0),
      movedTransactions: Number(row?.moved_transactions ?? 0),
    };
  },
  // SECURITY DEFINER RPC — the protect-archive trigger blocks direct client
  // writes to archived_at, so restoring goes through the same door.
  async unarchive(id: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('unarchive_contact', { p_contact_id: id });
    if (error) throw error;
    return Boolean(data);
  },
};

export interface MergePersonResult {
  success: boolean;
  reasonCode: 'MERGED' | 'CONTACT_NOT_FOUND' | 'LINKED_CONTACT' | 'SAME_CONTACT';
  userMessage: string;
  movedLoans: number;
  movedTransactions: number;
}

// ══════════════════════════════════════
// CONTACT LINK REQUESTS
// The "someone added you — add them back?" ask. Reads go through RLS
// (participants only); every write is a SECURITY DEFINER RPC, because
// accepting writes a persons row into the ACCEPTER's ledger and declining
// must be unforgeable by the adder.
// See supabase-migration-connections-push-discovery.sql.
// ══════════════════════════════════════
export interface ContactLinkRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** Display-name snapshot of the adder — the receiver can't read profiles. */
  fromName: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
  respondedAt: string | null;
}

function mapContactLinkRequest(row: Record<string, unknown>): ContactLinkRequest {
  return {
    id: String(row.id ?? ''),
    fromUserId: String(row.from_user_id ?? ''),
    toUserId: String(row.to_user_id ?? ''),
    fromName: String(row.from_name ?? '') || 'A Hisaab user',
    status: (row.status as ContactLinkRequest['status']) ?? 'pending',
    createdAt: String(row.created_at ?? ''),
    respondedAt: row.responded_at ? String(row.responded_at) : null,
  };
}

export interface RespondContactLinkResult {
  success: boolean;
  reasonCode: 'ACCEPTED' | 'DECLINED' | 'ALREADY_ACCEPTED' | 'ALREADY_DECLINED' | 'NOT_FOUND' | 'NOT_YOURS';
  personId: string | null;
}

export const contactLinksDb = {
  async getAll(): Promise<ContactLinkRequest[]> {
    const me = getUserId();
    const { data, error } = await supabase
      .from('contact_link_requests')
      .select('*')
      .or(`from_user_id.eq.${me},to_user_id.eq.${me}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => mapContactLinkRequest(row as Record<string, unknown>));
  },
  async respond(requestId: string, accept: boolean): Promise<RespondContactLinkResult> {
    const { data, error } = await supabase.rpc('respond_contact_link', {
      p_request_id: requestId,
      p_accept: accept,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as RespondContactLinkResult['reasonCode']) ?? 'NOT_FOUND',
      personId: row?.person_id ? String(row.person_id) : null,
    };
  },
};

// ══════════════════════════════════════
// PHONE DISCOVERY  (opt-in, both directions)
// The RPC compares E.164 numbers server-side and returns only the ones that
// matched — it never discloses a number the caller didn't already have.
// ══════════════════════════════════════
export interface PhoneMatch {
  phoneE164: string;
  profileId: string;
  displayName: string;
}

export const phoneDiscoveryDb = {
  /** Look up which of `numbers` (E.164) belong to discoverable Hisaab users.
   *  Max 60 per call, rate-limited server-side to 20 calls/hour. */
  async lookup(numbers: string[]): Promise<PhoneMatch[]> {
    if (numbers.length === 0) return [];
    const { data, error } = await supabase.rpc('lookup_hisaab_users_by_phone', {
      p_numbers: numbers,
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      phoneE164: String(row.phone_e164 ?? ''),
      profileId: String(row.profile_id ?? ''),
      displayName: String(row.display_name ?? '') || 'Hisaab user',
    }));
  },
  /** Set (or clear, with null) the current user's own discoverable number. */
  async setMyPhone(e164: string | null, discoverable: boolean): Promise<void> {
    const { error } = await supabase
      .from('profiles')
      .update({ phone_e164: e164, phone_discoverable: e164 ? discoverable : false })
      .eq('id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// PUSH TOKENS (FCM)
// ══════════════════════════════════════
export const pushTokensDb = {
  async register(token: string, platform: 'android' | 'ios' | 'web' = 'android'): Promise<void> {
    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_platform: platform,
    });
    if (error) throw error;
  },
  async unregister(token: string): Promise<void> {
    const { error } = await supabase
      .from('device_push_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// LINKED TRANSACTION REQUESTS (Phase 2B)
// Cloud-only. Writes go through RLS (insert) or SECURITY DEFINER RPCs
// (accept / reject / cancel). No Dexie mirror.
// ══════════════════════════════════════
export const linkedRequestsDb = {
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a long-lived
  // pair of connected users can accumulate an unbounded request history the
  // same way transactions did.
  async getAll(): Promise<LinkedRequest[]> {
    const me = getUserId();
    const { rows } = await fetchAllPages<LinkedRequest>({
      label: 'linkedRequests.getAll',
      pageSize: 500,
      idOf: (r) => r.id,
      cursorOf: (r) => r.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('linked_transaction_requests')
          .select('*')
          .or(`from_user_id.eq.${me},to_user_id.eq.${me}`);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapLinkedRequest);
      },
    });
    return rows;
  },
  async insert(input: {
    id: string;
    toUserId: string;
    personId: string;
    kind: LinkedRequestKind;
    amount: number;
    currency: Currency;
    note: string;
    // Phase 2D: when set, marks the request as a "sync past record" rather
    // than a brand-new loan announcement. The accept RPC enforces the
    // sender-owns / status-active / person-id-matches invariants on the
    // referenced loan; we don't re-check them here.
    preExistingLoanId?: string | null;
    // Sender's opted-in account: debited (lent) / credited (borrowed) on
    // accept. Forbidden together with preExistingLoanId (DB-enforced).
    requesterAccountId?: string | null;
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
      pre_existing_loan_id: input.preExistingLoanId ?? null,
      requester_account_id: input.requesterAccountId ?? null,
    });
    if (error) throw error;
  },
  async accept(requestId: string, responderAccountId?: string | null): Promise<LinkedRequest> {
    // Only send the account param when actually set: the {request_id}-only
    // shape also resolves against a pre-migration one-arg RPC, so ledger-only
    // accepts keep working even before the SQL migration is applied.
    const { data, error } = await supabase.rpc('accept_linked_request',
      responderAccountId
        ? { request_id: requestId, responder_account_id: responderAccountId }
        : { request_id: requestId });
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
    preExistingLoanId: (r.pre_existing_loan_id as string) ?? null,
    requesterAccountId: (r.requester_account_id as string) ?? null,
    responderAccountId: (r.responder_account_id as string) ?? null,
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
    responderAccountId: (r.responder_account_id as string) ?? null,
    createdAt: r.created_at as string,
    respondedAt: (r.responded_at as string) ?? null,
  };
}

// ══════════════════════════════════════
// LINKED SETTLEMENT REQUESTS (Phase 2C-A)
// Cloud-only. Accept writes mirrored repayment transactions and decrements
// remaining_amount on both loans. Account balances move only for the sides
// that opted in (sender at create, receiver at accept) — null stays
// ledger-only.
// ══════════════════════════════════════
export const settlementRequestsDb = {
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same unbounded
  // history risk as linkedRequestsDb.getAll.
  async getAll(): Promise<SettlementRequest[]> {
    const me = getUserId();
    const { rows } = await fetchAllPages<SettlementRequest>({
      label: 'settlementRequests.getAll',
      pageSize: 500,
      idOf: (r) => r.id,
      cursorOf: (r) => r.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('linked_settlement_requests')
          .select('*')
          .or(`from_user_id.eq.${me},to_user_id.eq.${me}`);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapSettlementRequest);
      },
    });
    return rows;
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
    const { error } = await supabase.rpc('create_settlement_request', {
      request_id: input.id,
      loan_pair_id: input.loanPairId,
      requester_loan_id: input.requesterLoanId,
      responder_loan_id: input.responderLoanId,
      to_user_id: input.toUserId,
      amount: input.amount,
      currency: input.currency,
      note: input.note,
      requester_account_id: input.requesterAccountId ?? null,
    });
    if (error) throw error;
  },
  async accept(requestId: string, responderAccountId?: string | null): Promise<SettlementRequest> {
    // Same conditional-params shape as linkedRequestsDb.accept — see there.
    const { data, error } = await supabase.rpc('accept_settlement_request',
      responderAccountId
        ? { request_id: requestId, responder_account_id: responderAccountId }
        : { request_id: requestId });
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
  /**
   * Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same unbounded
   * `select('*')` risk as loansDb.getAll. installment_number is NOT unique
   * across loans (every loan starts at 1), so it is not itself a valid
   * keyset cursor on its own — the `id` order-by tiebreak is what keeps the
   * (installment_number, id) pair a stable total order; fetchAllPages only
   * ever compares the installment_number cursor value.
   */
  async getAll(): Promise<EmiSchedule[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<EmiSchedule>({
      label: 'emiSchedules.getAll',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => String(e.installmentNumber),
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('emi_schedules').select('*')
          .eq('user_id', userId);
        // Inclusive bound — rows sharing an installment_number (across
        // different loans) can straddle a page boundary; fetchAllPages
        // de-duplicates the overlap by id.
        if (cursor) query = query.gte('installment_number', Number(cursor));
        const { data, error } = await query
          .order('installment_number', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapEmi);
      },
    });
    return rows;
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
  // Re-date an instalment (the statement-day re-anchor migration). Kept
  // separate from update() — which is deliberately status-only — because
  // due_date is otherwise immutable after creation.
  async setDueDate(id: string, dueDate: string) {
    const { error } = await supabase.from('emi_schedules').update({ due_date: dueDate }).eq('id', id).eq('user_id', getUserId());
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
      target_date: g.targetDate ?? null,
      created_at: g.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Goal>) {
    const row: Record<string, unknown> = {};
    if (changes.savedAmount !== undefined) row.saved_amount = changes.savedAmount;
    if (changes.title !== undefined) row.title = changes.title;
    if (changes.targetAmount !== undefined) row.target_amount = changes.targetAmount;
    if (changes.targetDate !== undefined) row.target_date = changes.targetDate ?? null;
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
  // Owner-only join-code rotation. Join codes expire 14 days after creation or
  // rotation — trg_split_groups_join_code_expiry
  // (supabase-migration-audit-p0-join-abuse-limits.sql SECTION 2) re-stamps
  // join_code_expires_at server-side whenever join_code changes, so this write
  // deliberately does NOT send an expiry of its own (an explicit value would
  // win over the trigger). The owner-scoped `user_id` filter mirrors delete().
  async rotateJoinCode(id: string, joinCode: string, joinCodeNormalized: string) {
    const { error } = await supabase
      .from('split_groups')
      .update({ join_code: joinCode, join_code_normalized: joinCodeNormalized })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GROUP EXPENSES
// ══════════════════════════════════════
// Lean projection used by the splits dashboard for balance + unreconciled-flag
// computation. Includes only the columns those passes actually read, so a
// 1000-row return on a heavy splitter ships ~4 KB instead of ~40 KB.
export interface GroupExpenseBalanceRow {
  groupId: string;
  paidBy: string;
  amount: number;
  splits: GroupExpense['splits'];
  isReconciled: boolean;
}

export interface GroupSettlementBalanceRow {
  groupId: string;
  fromMember: string;
  toMember: string;
  amount: number;
}

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
  //
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a heavy
  // splitter's all-groups expense feed is exactly the unbounded-select shape
  // that used to silently truncate at PostgREST's max-rows cap.
  async getAllVisible(): Promise<GroupExpense[]> {
    const { rows } = await fetchAllPages<GroupExpense>({
      label: 'groupExpenses.getAllVisible',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => e.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_expenses').select('*')
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupExpense);
      },
    });
    return rows;
  },
  // Same shape as getAllVisible but only the columns the dashboard balance +
  // unreconciled-flag passes consume. The splits JSONB is still selected
  // because the per-member-share math needs it; everything else (notes,
  // payload, audit columns) is dropped.
  async getAllVisibleForBalances(): Promise<GroupExpenseBalanceRow[]> {
    const { data, error } = await supabase
      .from('group_expenses')
      .select('group_id, paid_by, amount, splits, is_reconciled')
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      groupId: r.group_id as string,
      paidBy: r.paid_by as string,
      amount: Number(r.amount),
      splits: (r.splits ?? []) as GroupExpense['splits'],
      isReconciled: Boolean(r.is_reconciled),
    }));
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
      is_reconciled: e.isReconciled ?? false,
      reconciled_at: e.reconciledAt ?? null,
      reconciled_by: e.reconciledBy ?? null,
    });
    if (error) throw error;
  },
  // `expectedVersion` turns this into an optimistic-lock write (audit F-6).
  // The `version` column was written on every edit but NEVER compared, so two
  // people editing the same expense was last-writer-wins and one person's
  // splits silently replaced the other's. With it, the losing writer matches
  // 0 rows and gets a conflict error instead of quietly winning; the DB-side
  // backstop (group_expenses_version_guard in
  // supabase-migration-audit-p0-group-concurrency.sql) makes the increment
  // mandatory so a caller cannot opt out by just not sending a new version.
  async update(id: string, changes: Partial<GroupExpense>, opts?: { expectedVersion?: number }) {
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
    if (changes.isReconciled !== undefined) row.is_reconciled = changes.isReconciled;
    if (changes.reconciledAt !== undefined) row.reconciled_at = changes.reconciledAt;
    if (changes.reconciledBy !== undefined) row.reconciled_by = changes.reconciledBy;
    // .select() makes RLS-filtered writes VISIBLE: creator-only policies turn
    // a non-creator's update into 0 affected rows, which supabase-js otherwise
    // reports as success — the "edited but nothing changed" trap.
    let query = supabase.from('group_expenses').update(row).eq('id', id);
    if (opts?.expectedVersion !== undefined) {
      query = query.eq('version', opts.expectedVersion);
    }
    const { data, error } = await query.select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      // 0 rows means one of two very different things. Read the live version
      // back to tell them apart, so a conflict is never reported as "you're
      // not the creator" (and, more importantly, never as success).
      if (opts?.expectedVersion !== undefined) {
        const { data: current } = await supabase
          .from('group_expenses')
          .select('version')
          .eq('id', id)
          .is('deleted_at', null)
          .maybeSingle();
        if (current && Number(current.version) !== opts.expectedVersion) {
          throw new Error(tStatic('grp_expense_version_conflict'));
        }
      }
      throw new Error(tStatic('grp_only_creator_edit'));
    }
  },
  // Liveness probe for mirror-transaction guards. Unlike get(), this
  // DISTINGUISHES "row really gone" (0 rows → false) from transport/auth
  // failures (throws) — a flaky connection must keep the guard, not release
  // it and let a live group's mirror be deleted out from under the group.
  async probeExists(id: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('group_expenses')
      .select('id')
      .eq('id', id)
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).length > 0;
  },
  async setReconciled(id: string, isReconciled: boolean): Promise<void> {
    const { error } = await supabase.rpc('reconcile_group_expense', {
      p_expense_id: id,
      p_is_reconciled: isReconciled,
    });
    if (error) throw error;
  },
  async delete(id: string) {
    const { data, error } = await supabase
      .from('group_expenses')
      .update({ deleted_at: new Date().toISOString(), deleted_by: getUserId() })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      throw new Error(tStatic('grp_only_creator_delete'));
    }
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
  //
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same
  // unbounded-select truncation risk as groupExpensesDb.getAllVisible.
  async getAllVisible(): Promise<GroupSettlement[]> {
    const { rows } = await fetchAllPages<GroupSettlement>({
      label: 'groupSettlements.getAllVisible',
      pageSize: 500,
      idOf: (s) => s.id,
      cursorOf: (s) => s.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_settlements').select('*')
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupSettlement);
      },
    });
    return rows;
  },
  // Narrow projection for the dashboard balance pass — only the four columns
  // the running-sum needs. Roughly halves payload on heavy splitters.
  async getAllVisibleForBalances(): Promise<GroupSettlementBalanceRow[]> {
    const { data, error } = await supabase
      .from('group_settlements')
      .select('group_id, from_member, to_member, amount')
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      groupId: r.group_id as string,
      fromMember: r.from_member as string,
      toMember: r.to_member as string,
      amount: Number(r.amount),
    }));
  },
  // Record a settlement through the hardened RPC. The outstanding-amount cap
  // used to be a client-side check between two reads and an insert, so two
  // devices recording the same repayment both passed it and the pair
  // over-settled (audit 12-qa-review.md F-7). record_group_settlement takes a
  // group row lock, recomputes the cap under it, and inserts — all in one
  // transaction. Failures come back as DATA (reason_code), never as a raw
  // Postgres error string.
  async record(s: GroupSettlement): Promise<RecordSettlementResult> {
    const { data, error } = await supabase.rpc('record_group_settlement', {
      p_settlement_id: s.id,
      p_group_id: s.groupId,
      p_from_member: s.fromMember,
      p_to_member: s.toMember,
      p_amount: s.amount,
      p_note: s.note ?? '',
      p_date: s.date,
    });
    if (error) throw error;
    return (data ?? {}) as RecordSettlementResult;
  },
  // Soft-delete one settlement (tombstone; every read filters deleted_at).
  // .select() surfaces RLS-filtered 0-row writes as an honest error, and the
  // deleted_at filter makes a two-device race idempotent (second write 0-rows
  // instead of double-tombstoning and double-fanning-out).
  async deleteOne(id: string) {
    const { data, error } = await supabase
      .from('group_settlements')
      .update({ deleted_at: new Date().toISOString(), deleted_by: getUserId() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      throw new Error(tStatic('grp_only_recorder_settlement'));
    }
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_settlements').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

// supabase-migration-audit-p0-consent-guards.sql §2.2 raises SQLSTATE 23505
// (MEMBER_ALREADY_EXISTS) when a client INSERTs a second membership row for a
// profile that already has one in that group — the supported way back in for
// someone who declined is the join code, not a re-invite. Without this the user
// sees a raw Postgres unique-violation string.
function translateMemberInsertError(error: unknown): unknown {
  return isMemberAlreadyExistsError(error)
    ? new Error(tStatic('grp_member_already_exists'))
    : error;
}

export const groupMembersDb = {
  async getByGroup(groupId: string): Promise<GroupMember[]> {
    const { data, error } = await supabase
      .from('group_members').select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapGroupMember);
  },
  // Batched fetch for loadGroups: gets every member row for the given groups
  // in one round-trip and returns them grouped by group_id. Replaces the
  // N+1 pattern of calling getByGroup() once per group during list-page load.
  async getByGroups(groupIds: string[]): Promise<Map<string, GroupMember[]>> {
    const grouped = new Map<string, GroupMember[]>();
    if (groupIds.length === 0) return grouped;
    const { data, error } = await supabase
      .from('group_members').select('*')
      .in('group_id', groupIds)
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      const gid = String((row as Record<string, unknown>).group_id);
      const bucket = grouped.get(gid) ?? [];
      bucket.push(mapGroupMember(row as Record<string, unknown>));
      grouped.set(gid, bucket);
    }
    return grouped;
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
    if (error) throw translateMemberInsertError(error);
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
    if (error) throw translateMemberInsertError(error);
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
  // getByTokenHash is GONE. It had no caller, and after
  // supabase-migration-audit-p0-consent-guards.sql §3.2 it could not work:
  // token_hash is no longer readable OR filterable by client roles, and the
  // hash stopped being the credential (the raw token is, and only the server
  // may derive its digest).
  //
  // Explicit column list, NOT select('*'): the table-wide SELECT grant was
  // revoked and only these nine columns were granted back, so a star select now
  // fails with "permission denied for column token_hash". This list is exactly
  // what mapGroupInvite reads.
  async getActiveByGroup(groupId: string): Promise<GroupInvite[]> {
    const { data, error } = await supabase
      .from('group_invites')
      .select('id, group_id, created_by, linked_member_id, expires_at, revoked_at, accepted_by, accepted_at, created_at')
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
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a long-lived
  // group's activity feed is unbounded the same way the all-groups reads are.
  async getByGroup(groupId: string): Promise<GroupEvent[]> {
    const { rows } = await fetchAllPages<GroupEvent>({
      label: 'groupEvents.getByGroup',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => e.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_events').select('*')
          .eq('group_id', groupId);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupEvent);
      },
    });
    return rows;
  },
  // NOTE: there is deliberately no add(). Group activity rows are written by
  // the fan-out triggers in supabase-migration-audit-p0-notifications.sql, in
  // the same transaction as the money write, and the client INSERT policy on
  // group_events is dropped there. Client-written events were best-effort —
  // an actor who went offline between the expense insert and the fan-out left
  // no activity record at all (audit 08-notifications.md N-2) — and let any
  // member author arbitrary `summary` text into the shared feed.
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
  // NOTE: there is deliberately no addMany(). Clients can only ever insert a
  // notification for THEMSELVES now (the INSERT policy in
  // supabase-migration-audit-p0-notifications.sql), and nothing in the app
  // needs to. The old fan-out let any co-member write arbitrary title/body
  // rows into another member's Inbox — forwarded verbatim as app-branded
  // HIGH-priority FCM push (audit 05-security.md H5 / 08-notifications.md
  // N-3). Every cross-user notification is now trigger-written.
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

// ══════════════════════════════════════
// NOTIFICATION PREFERENCES (audit 08-notifications.md N-10)
// ──────────────────────────────────────
// Per-recipient fatigue controls, from
// supabase-migration-p2-notification-maturity.sql §2. One row per
// (user, group); `groupId === null` is the GLOBAL row and the only place
// quiet hours and the timezone are read from — a per-group row carries only
// `muted`.
//
// EVERY read here tolerates the table not existing: the migration is applied
// by hand in Studio (CLAUDE.md), so a shipped client WILL run against a
// database without it for some window. Failing soft means "no prefs" —
// nothing muted, no quiet hours — which is exactly the pre-M5 behaviour.
// ══════════════════════════════════════
export interface NotificationPref {
  groupId: string | null;
  muted: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  tz: string;
}

function mapNotificationPref(r: Record<string, unknown>): NotificationPref {
  return {
    groupId: (r.group_id as string) ?? null,
    muted: r.muted === true,
    quietHoursStart: typeof r.quiet_hours_start === 'number' ? r.quiet_hours_start : null,
    quietHoursEnd: typeof r.quiet_hours_end === 'number' ? r.quiet_hours_end : null,
    tz: (r.tz as string) || 'Asia/Karachi',
  };
}

export const notificationPrefsDb = {
  async getAll(): Promise<NotificationPref[]> {
    const { data, error } = await supabase
      .from('notification_prefs').select('*')
      .eq('user_id', getUserId());
    // Table absent (migration pending) → behave as if the user has no
    // preferences rather than breaking every notification load.
    if (error) return [];
    return (data ?? []).map(mapNotificationPref);
  },

  /** Mute/unmute one group, or — with groupId null — everything. Upserts on
   *  the (user_id, COALESCE(group_id,'')) unique index. */
  async setMuted(groupId: string | null, muted: boolean): Promise<void> {
    const userId = getUserId();
    const { data } = await supabase
      .from('notification_prefs').select('id')
      .eq('user_id', userId)
      .filter('group_id', groupId === null ? 'is' : 'eq', groupId === null ? null : groupId)
      .maybeSingle();
    if (data?.id) {
      const { error } = await supabase
        .from('notification_prefs')
        .update({ muted, updated_at: new Date().toISOString() })
        .eq('id', data.id as string);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('notification_prefs')
      .insert({ user_id: userId, group_id: groupId, muted });
    if (error) throw error;
  },

  /** Set (or clear, with nulls) the global quiet-hours window. Always writes
   *  the global row — quiet hours are never per-group. */
  async setQuietHours(startHour: number | null, endHour: number | null, tz?: string): Promise<void> {
    const userId = getUserId();
    const zone = tz
      || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Asia/Karachi'; } })();
    const { data } = await supabase
      .from('notification_prefs').select('id')
      .eq('user_id', userId)
      .is('group_id', null)
      .maybeSingle();
    const patch = {
      quiet_hours_start: startHour,
      quiet_hours_end: endHour,
      tz: zone,
      updated_at: new Date().toISOString(),
    };
    if (data?.id) {
      const { error } = await supabase
        .from('notification_prefs').update(patch).eq('id', data.id as string);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('notification_prefs')
      .insert({ user_id: userId, group_id: null, muted: false, ...patch });
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
    // lookup_profile_by_public_code was dropped by prelaunch-hardening (it
    // leaked the target's code); lookup_profile_by_code is the throttled
    // replacement and returns only profile_id + display_name. The caller
    // already holds the code it typed, so echo that back as publicCode.
    const { data, error } = await supabase.rpc('lookup_profile_by_code', { code: normalizedCode });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.profile_id) return null;
    return { id: row.profile_id as string, name: (row.display_name as string) ?? '', publicCode: normalizedCode };
  },
};

export const accountDeletionDb = {
  async deleteCurrentUser() {
    const { error } = await supabase.rpc('delete_current_user');
    if (error) throw error;
  },
};

export interface LeaveGroupResult {
  success: boolean;
  reasonCode: string;
  userMessage: string;
  payableAmount: number;
  receivableAmount: number;
  currency: string | null;
}

// accept_group_membership / decline_group_membership / transfer_group_ownership
// all return leave_group's { success, reason_code, user_message } shape on
// purpose (consent-guards.sql §2.5, account-deletion.sql §5), so one parser
// serves all four.
function parseLeaveGroupShape(data: unknown, fallbackMessage: string): LeaveGroupResult {
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(result.success),
    reasonCode: String(result.reason_code ?? 'UNKNOWN'),
    userMessage: String(result.user_message ?? fallbackMessage),
    payableAmount: Number(result.payable_amount ?? 0),
    receivableAmount: Number(result.receivable_amount ?? 0),
    currency: result.currency ? String(result.currency) : null,
  };
}

/** One row of list_pending_group_memberships (consent-guards.sql §2.6) — the
 *  ONLY window an invited user has onto a group they have not accepted, since
 *  is_group_member() still means 'connected' and the split_groups SELECT policy
 *  hides the row entirely. Scalar fields only: no member list, no ledger, no
 *  join code. */
export interface PendingGroupInvitation {
  groupId: string;
  memberId: string;
  groupName: string;
  groupEmoji: string;
  currency: string;
  invitedBy: string | null;
  invitedByName: string;
  invitedAt: string | null;
}

export const groupMembershipDb = {
  async leave(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('leave_group', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not leave this group');
    return parseLeaveGroupShape(data, 'Could not leave this group.');
  },

  // Invitations the caller has NOT accepted yet. Returns [] rather than
  // throwing on an un-migrated database: a missing RPC must not break the
  // Groups tab, it just means there are no pending invitations to show.
  async listPending(): Promise<PendingGroupInvitation[]> {
    const { data, error } = await supabase.rpc('list_pending_group_memberships');
    if (error) {
      if (isMissingFunctionError(error)) return [];
      throw error;
    }
    if (!Array.isArray(data)) return [];
    return data.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        groupId: String(row.group_id ?? ''),
        memberId: String(row.member_id ?? ''),
        groupName: String(row.group_name ?? ''),
        groupEmoji: String(row.group_emoji ?? ''),
        currency: String(row.currency ?? 'PKR'),
        invitedBy: row.invited_by ? String(row.invited_by) : null,
        invitedByName: String(row.invited_by_name ?? ''),
        invitedAt: row.invited_at ? String(row.invited_at) : null,
      };
    }).filter(row => row.groupId !== '');
  },

  // The invitee promotes their OWN status='invited' row to 'connected'. No
  // other party can call it for them (auth.uid() must equal profile_id).
  async accept(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('accept_group_membership', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not accept this invitation');
    return parseLeaveGroupShape(data, 'Could not accept this invitation.');
  },

  // Unconditional refusal. Deliberately a SEPARATE RPC from leave_group and
  // deliberately carrying NONE of its balance / reconciliation gates — that is
  // the whole point of consent-guards §2.5: a never-accepted user must always
  // be able to say no, or an attacker could conscript them and then wedge the
  // exit shut with an expense.
  async decline(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('decline_group_membership', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not decline this invitation');
    return parseLeaveGroupShape(data, 'Could not decline this invitation.');
  },
};

/** archive_group / unarchive_group return leave_group's shape plus the new
 *  archived_at, so the client can update its mirror without a re-fetch. */
export interface GroupArchiveResult {
  success: boolean;
  reasonCode: string;
  userMessage: string;
  archivedAt: string | null;
}

function parseArchiveResult(data: unknown, fallbackMessage: string): GroupArchiveResult {
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(result.success),
    reasonCode: String(result.reason_code ?? 'UNKNOWN'),
    userMessage: String(result.user_message ?? fallbackMessage),
    archivedAt: result.archived_at ? String(result.archived_at) : null,
  };
}

// Owner-only, non-destructive alternative to deleting a shared group
// (supabase-migration-audit-p0-group-deletion-guard.sql §6). archived_at may
// NOT be PATCHed directly — split_groups_protect_archive refuses that with
// GROUP_ARCHIVE_RPC_ONLY — so the group_event and the member notification can
// never be skipped.
export const groupArchiveDb = {
  async archive(groupId: string): Promise<GroupArchiveResult> {
    const { data, error } = await supabase.rpc('archive_group', { p_group_id: groupId });
    if (error) throw error;
    return parseArchiveResult(data, 'Could not archive this group.');
  },
  async unarchive(groupId: string): Promise<GroupArchiveResult> {
    const { data, error } = await supabase.rpc('unarchive_group', { p_group_id: groupId });
    if (error) throw error;
    return parseArchiveResult(data, 'Could not reopen this group.');
  },
};

// Owner-only ownership handover (supabase-migration-audit-p0-account-deletion
// .sql §5). The target must already be a connected, profile-linked member of
// the same group, so a group can never be handed to a stranger. This is the
// resolution path for BOTH delete_current_user's OWNED_GROUPS_WITH_MEMBERS
// refusal and leave_group's ONLY_OWNER_ADMIN refusal.
export const groupOwnershipDb = {
  async transfer(groupId: string, newOwnerMemberId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('transfer_group_ownership', {
      p_group_id: groupId,
      p_new_owner_member_id: newOwnerMemberId,
    });
    if (error) throw new Error(error.message || 'Could not transfer ownership');
    return parseLeaveGroupShape(data, 'Could not transfer ownership.');
  },
};

export const groupsLookupDb = {
  async findByJoinCode(normalizedCode: string): Promise<{ id: string; name: string; emoji: string; currency: string } | null> {
    void normalizedCode;
    throw new Error('Direct group-code lookup is disabled. Join through joinByCode().');
  },

  // Sighted join (audit 2026-09, UX-18). findByJoinCode above stays disabled —
  // a non-member genuinely cannot SELECT split_groups — so the preview goes
  // through a SECURITY DEFINER RPC with a FIXED, minimal projection:
  // {name, emoji, member_count, currency, owner_display_name, is_archived}.
  // No group id, no member list, no money. See
  // supabase-migration-p1-group-preview.sql.
  //
  // Like joinByCode, this never throws for a business outcome — the RPC
  // RETURNs a status object rather than raising, because a RAISE would roll
  // back the join_code_attempts row that charges the miss (audit H1's root
  // cause). Misses share join_group_by_code's own 5-per-5-minute window, so
  // previewing cannot double an attacker's guess rate.
  //
  // A thrown error is mapped, not propagated: an un-migrated database yields
  // 'UNAVAILABLE', which callers treat as a soft failure and fall back to the
  // legacy code-echo confirm. A missing preview must never block a real join.
  async previewByCode(normalizedCode: string): Promise<GroupPreviewResult> {
    try {
      const { data, error } = await supabase.rpc('preview_group_by_code', {
        p_code_normalized: normalizedCode,
      });
      if (error) return { status: previewStatusFromThrown(error) };
      return parseGroupPreviewResponse(data);
    } catch (err) {
      return { status: previewStatusFromThrown(err) };
    }
  },

  // Atomic join: SECURITY DEFINER RPC resolves the code and upserts the
  // caller's membership in one step. Needed because a non-member can't read
  // split_groups directly — the prior "lookup → re-fetch → insert" flow
  // always failed at the re-fetch step under strict RLS.
  //
  // Audit 2026-09 (C5 / security H1): the RPC now returns a jsonb status
  // object rather than raising, because a RAISE rolled back the very
  // join_code_attempts row the brute-force limiter counts. This never throws
  // for a business outcome — callers switch on `status`. The try/catch is kept
  // deliberately: migrations are hand-applied, so prod may briefly still run
  // the old RETURNS TABLE + RAISE version, and its thrown message is mapped
  // into the same vocabulary.
  async joinByCode(
    normalizedCode: string,
    displayName: string,
  ): Promise<JoinCodeResult> {
    try {
      const { data, error } = await supabase.rpc('join_group_by_code', {
        p_code_normalized: normalizedCode,
        p_display_name: displayName,
      });
      if (error) return { status: joinStatusFromThrown(error) };
      return parseJoinByCodeResponse(data);
    } catch (err) {
      return { status: joinStatusFromThrown(err) };
    }
  },
  // Invite-link redemption. Audit 2026-09 (H3 / SEC-07,
  // supabase-migration-audit-p0-consent-guards.sql §3.5): the RAW token goes to
  // the server, which derives the SHA-256 itself with hash_invite_token. The
  // client no longer hashes anything — that was the bug, because the stored
  // hash WAS the password and RLS handed it to every group member. The
  // parameter was renamed p_invite_token_hash -> p_invite_token so an
  // un-updated client fails loudly instead of silently hashing a hash.
  //
  // Like joinByCode, this returns a status and never throws for a business
  // outcome: the RPC must RETURN rather than RAISE or the
  // invite_accept_attempts row the rate limiter counts would roll back.
  //
  // Graceful fallback: migrations are hand-applied, so prod may still run the
  // OLD RETURNS TABLE function, which does not know the new argument name.
  // PGRST202 / 42883 means exactly that — retry once against the legacy
  // signature with the locally-computed hash, so existing invite links keep
  // working in the window before the migration lands.
  async acceptInvite(
    rawToken: string,
    displayName: string,
  ): Promise<InviteAcceptResult> {
    try {
      const { data, error } = await supabase.rpc('accept_group_invite', {
        p_invite_token: rawToken,
        p_display_name: displayName,
      });
      if (!error) return parseAcceptInviteResponse(data);
      if (!isMissingFunctionError(error)) return { status: inviteStatusFromThrown(error) };

      // Dynamic import keeps supabaseDb free of a static edge to collaboration,
      // which itself lazily imports this module.
      const { sha256Hex } = await import('./collaboration');
      const legacy = await supabase.rpc('accept_group_invite', {
        p_invite_token_hash: await sha256Hex(rawToken),
        p_display_name: displayName,
      });
      if (legacy.error) return { status: inviteStatusFromThrown(legacy.error) };
      return parseAcceptInviteResponse(legacy.data);
    } catch (err) {
      return { status: inviteStatusFromThrown(err) };
    }
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
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapDeletedRow(r: Record<string, unknown>): DeletedRow {
  return {
    id: r.id as string,
    deletedAt: r.deleted_at as string,
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
    relatedInvestmentId: (r.related_investment_id as string) ?? null,
    conversionRate: r.conversion_rate != null ? Number(r.conversion_rate) : null,
    category: (r.category as string) ?? '', notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    isReconciled: Boolean(r.is_reconciled),
    reconciledAt: (r.reconciled_at as string) ?? null,
    reconciledBy: (r.reconciled_by as string) ?? null,
    receiptPath: (r.receipt_path as string) ?? null,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
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
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
    loanPairId: (r.loan_pair_id as string) ?? null,
  };
}

function mapPerson(r: Record<string, unknown>): Person {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    linkedProfileId: (r.linked_profile_id as string) ?? null,
    archivedAt: (r.archived_at as string) ?? null,
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
    targetDate: (r.target_date as string) ?? null,
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
    // Added by audit-p0-join-abuse-limits / audit-p0-group-deletion-guard.
    // Tolerate their absence so a client running against a pre-migration
    // database still renders the group (undefined ⇒ "no expiry known",
    // "not archived").
    joinCodeExpiresAt: (r.join_code_expires_at as string) ?? null,
    archivedAt: (r.archived_at as string) ?? null,
    archivedBy: (r.archived_by as string) ?? null,
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
    isReconciled: Boolean(r.is_reconciled),
    reconciledAt: (r.reconciled_at as string) ?? null,
    reconciledBy: (r.reconciled_by as string) ?? null,
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
    // Never selected any more (consent-guards §3.2 revoked the column grant).
    // Left optional so a row read by some other path still maps cleanly.
    tokenHash: (r.token_hash as string) ?? undefined,
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
    // Added by supabase-migration-audit-p0-notifications.sql. Tolerate their
    // absence so a client running against a pre-migration database (or a row
    // written by an older trigger) still renders the stored title/body.
    template: (r.template as string) ?? null,
    params: (r.params && typeof r.params === 'object' && !Array.isArray(r.params)
      ? r.params
      : {}) as Record<string, unknown>,
    actorId: (r.actor_id as string) ?? null,
    // Added by supabase-migration-p2-notification-maturity.sql. Same
    // tolerance as template/params above: a pre-migration database simply
    // returns nothing here and the client falls back to its own derivation
    // (notificationHref / notificationChannel in notificationContent.ts).
    collapseKey: (r.collapse_key as string) ?? null,
    channelId: (r.channel_id as string) ?? null,
    href: (r.href as string) ?? null,
    readAt: (r.read_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// BUDGETS (Phase 3)
// ══════════════════════════════════════
export const budgetsDb = {
  async getAll(): Promise<Budget[]> {
    const { data, error } = await supabase
      .from('budgets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('category', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapBudget);
  },
  async getUpdatedSince(updatedAfter: string): Promise<Budget[]> {
    const { data, error } = await supabase
      .from('budgets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapBudget);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('budgets').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(b: Budget) {
    const { error } = await supabase.from('budgets').insert({
      id: b.id, user_id: getUserId(), category: b.category,
      monthly_amount: b.monthlyAmount, currency: b.currency,
      warn_at_percent: b.warnAtPercent, created_at: b.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Budget>) {
    const row: Record<string, unknown> = {};
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.monthlyAmount !== undefined) row.monthly_amount = changes.monthlyAmount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.warnAtPercent !== undefined) row.warn_at_percent = changes.warnAtPercent;
    const { error } = await supabase.from('budgets').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('budgets')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapBudget(r: Record<string, unknown>): Budget {
  return {
    id: r.id as string,
    category: r.category as string,
    monthlyAmount: Number(r.monthly_amount),
    currency: r.currency as Currency,
    warnAtPercent: Number(r.warn_at_percent ?? 80),
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

// ══════════════════════════════════════
// CUSTOM CATEGORIES (user-defined expense/income names)
// Hard-delete table — see supabase-migration-custom-categories.sql.
// ══════════════════════════════════════
export const customCategoriesDb = {
  async getAll(): Promise<CustomCategory[]> {
    const { data, error } = await supabase
      .from('custom_categories').select('*')
      .eq('user_id', getUserId())
      .order('type', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapCustomCategory);
  },
  async add(c: CustomCategory) {
    const { error } = await supabase.from('custom_categories').insert({
      id: c.id, user_id: getUserId(), type: c.type, name: c.name,
      created_at: c.createdAt, updated_at: c.updatedAt ?? c.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<CustomCategory>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    const { error } = await supabase
      .from('custom_categories').update(row)
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('custom_categories').delete()
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapCustomCategory(r: Record<string, unknown>): CustomCategory {
  return {
    id: r.id as string,
    type: r.type as CustomCategory['type'],
    name: r.name as string,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

// ══════════════════════════════════════
// KAMETI / COMMITTEES (no-custody ROSCA tracker)
// See supabase-migration-committees.sql.
// ══════════════════════════════════════

// Stable failure codes raised by perform_committee_draw (see
// supabase-migration-audit-p0-kameti-draw.sql). PostgREST surfaces the RAISE
// text verbatim in error.message, so we match on the token rather than on
// Postgres error codes.
export const COMMITTEE_DRAW_ERRORS = [
  'ALREADY_DRAWN', 'NOT_ORGANISER', 'NOT_FOUND', 'NOT_ACTIVE',
  'TOO_FEW_MEMBERS', 'NOT_AUTHENTICATED', 'DRAW_LOCKED', 'DRAW_FIELDS_ARE_SERVER_ONLY',
] as const;
export type CommitteeDrawErrorCode = (typeof COMMITTEE_DRAW_ERRORS)[number];

export class CommitteeDrawError extends Error {
  readonly code: CommitteeDrawErrorCode | 'UNKNOWN';
  constructor(code: CommitteeDrawErrorCode | 'UNKNOWN', message?: string) {
    super(message ?? code);
    this.name = 'CommitteeDrawError';
    this.code = code;
  }
}

function toCommitteeDrawError(err: unknown): CommitteeDrawError {
  const message = (err as { message?: string })?.message ?? String(err);
  const code = COMMITTEE_DRAW_ERRORS.find((c) => message.includes(c));
  return new CommitteeDrawError(code ?? 'UNKNOWN', message);
}

export interface CommitteeDrawResult {
  drawnAt: string;
  drawSeed: string;
  drawCommitment: string;
  drawScheme: string;
  /** Member ids in slot order — index 0 holds slot 1. */
  order: string[];
}

export const committeesDb = {
  async getAll(): Promise<Committee[]> {
    const { data, error } = await supabase
      .from('committees').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapCommittee);
  },
  async add(c: Committee) {
    const { error } = await supabase.from('committees').insert({
      id: c.id, user_id: getUserId(), name: c.name, currency: c.currency,
      contribution_amount: c.contributionAmount, member_count: c.memberCount,
      cadence: c.cadence, total_rounds: c.totalRounds, start_date: c.startDate,
      payout_method: c.payoutMethod, status: c.status, notes: c.notes,
      drawn_at: c.drawnAt ?? null, created_at: c.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Committee>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.payoutMethod !== undefined) row.payout_method = changes.payoutMethod;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.drawnAt !== undefined) row.drawn_at = changes.drawnAt;
    // drawSeed / drawCommitment are deliberately NOT writable from here. Audit
    // 2026-09 M10: a client-written seed lets the organiser brute-force one that
    // yields a hand-picked order. Only perform_committee_draw() may set them,
    // and a trigger rejects any other write — see
    // supabase-migration-audit-p0-kameti-draw.sql.
    if (changes.shareToken !== undefined) row.share_token = changes.shareToken;
    const { error } = await supabase.from('committees').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    // Hard delete — FKs cascade members + payments.
    const { error } = await supabase.from('committees').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // The ballot draw. Runs ENTIRELY server-side inside one transaction: the seed
  // comes from Postgres entropy the organiser never sees or supplies, the order
  // is computed in SQL, and a drawn-guard makes a second call fail with
  // ALREADY_DRAWN. The client's only job afterwards is to recompute the same
  // order from the published seed and confirm it (src/lib/committeeDraw.ts).
  async performDraw(committeeId: string): Promise<CommitteeDrawResult> {
    const { data, error } = await supabase.rpc('perform_committee_draw', { p_committee_id: committeeId });
    if (error) throw toCommitteeDrawError(error);
    const raw = data as Record<string, unknown> | null;
    const order = Array.isArray(raw?.order) ? (raw.order as string[]) : [];
    if (!raw || order.length === 0) throw new CommitteeDrawError('UNKNOWN', 'perform_committee_draw returned no order');
    return {
      drawnAt: String(raw.drawnAt),
      drawSeed: String(raw.drawSeed),
      drawCommitment: String(raw.drawCommitment),
      drawScheme: String(raw.drawScheme),
      order,
    };
  },
  // Read-only witness snapshot via the anon SECURITY DEFINER RPC. No auth
  // required — used by the public witness page. Returns null for a bad token.
  async getWitness(token: string): Promise<{ committee: Committee; members: CommitteeMember[]; payments: CommitteePayment[] } | null> {
    const { data, error } = await supabase.rpc('get_committee_witness', { p_token: token });
    if (error) throw error;
    if (!data) return null;
    const raw = data as { committee: Record<string, unknown>; members: Record<string, unknown>[]; payments: { memberId: string; round: number }[] };
    const c = raw.committee;
    const committee: Committee = {
      id: c.id as string, name: c.name as string, currency: c.currency as Currency,
      contributionAmount: Number(c.contributionAmount), memberCount: Number(c.memberCount),
      cadence: c.cadence as Committee['cadence'], totalRounds: Number(c.totalRounds),
      startDate: c.startDate as string, payoutMethod: c.payoutMethod as Committee['payoutMethod'],
      status: c.status as Committee['status'], notes: '',
      drawnAt: (c.drawnAt as string) ?? null, drawSeed: (c.drawSeed as string) ?? null,
      drawCommitment: (c.drawCommitment as string) ?? null,
      createdAt: c.createdAt as string,
    };
    const members: CommitteeMember[] = raw.members.map((m) => ({
      id: m.id as string, committeeId: committee.id, name: m.name as string, phone: null, personId: null,
      slot: m.slot != null ? Number(m.slot) : null, isOrganizer: Boolean(m.isOrganizer),
      payoutReceivedAt: (m.payoutReceivedAt as string) ?? null, exitedAt: (m.exitedAt as string) ?? null,
      createdAt: '',
    }));
    const payments: CommitteePayment[] = raw.payments.map((p, i) => ({
      id: `${p.memberId}-${p.round}-${i}`, committeeId: committee.id, memberId: p.memberId, round: p.round, paidAt: '',
    }));
    return { committee, members, payments };
  },
};

export const committeeMembersDb = {
  async getAll(): Promise<CommitteeMember[]> {
    const { data, error } = await supabase
      .from('committee_members').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapCommitteeMember);
  },
  async addMany(members: CommitteeMember[]) {
    if (members.length === 0) return;
    const rows = members.map((m) => ({
      id: m.id, committee_id: m.committeeId, user_id: getUserId(), name: m.name,
      phone: m.phone ?? null, person_id: m.personId ?? null, slot: m.slot ?? null,
      is_organizer: m.isOrganizer, payout_received_at: m.payoutReceivedAt ?? null,
      exited_at: m.exitedAt ?? null, created_at: m.createdAt,
    }));
    const { error } = await supabase.from('committee_members').insert(rows);
    if (error) throw error;
  },
  async update(id: string, changes: Partial<CommitteeMember>) {
    const row: Record<string, unknown> = {};
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.phone !== undefined) row.phone = changes.phone;
    if (changes.slot !== undefined) row.slot = changes.slot;
    if (changes.payoutReceivedAt !== undefined) row.payout_received_at = changes.payoutReceivedAt;
    if (changes.exitedAt !== undefined) row.exited_at = changes.exitedAt;
    const { error } = await supabase.from('committee_members').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('committee_members').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const committeePaymentsDb = {
  async getAll(): Promise<CommitteePayment[]> {
    const { data, error } = await supabase
      .from('committee_payments').select('*')
      .eq('user_id', getUserId());
    if (error) throw error;
    return (data ?? []).map(mapCommitteePayment);
  },
  async add(p: CommitteePayment) {
    const { error } = await supabase.from('committee_payments').insert({
      id: p.id, committee_id: p.committeeId, user_id: getUserId(),
      member_id: p.memberId, round: p.round, paid_at: p.paidAt,
    });
    if (error) throw error;
  },
  async remove(memberId: string, round: number) {
    const { error } = await supabase
      .from('committee_payments').delete()
      .eq('user_id', getUserId()).eq('member_id', memberId).eq('round', round);
    if (error) throw error;
  },
};

function mapCommittee(r: Record<string, unknown>): Committee {
  return {
    id: r.id as string,
    name: r.name as string,
    currency: r.currency as Currency,
    contributionAmount: Number(r.contribution_amount),
    memberCount: Number(r.member_count),
    cadence: r.cadence as Committee['cadence'],
    totalRounds: Number(r.total_rounds),
    startDate: r.start_date as string,
    payoutMethod: r.payout_method as Committee['payoutMethod'],
    status: r.status as Committee['status'],
    notes: (r.notes as string) ?? '',
    drawnAt: (r.drawn_at as string) ?? null,
    drawSeed: (r.draw_seed as string) ?? null,
    drawCommitment: (r.draw_commitment as string) ?? null,
    shareToken: (r.share_token as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

function mapCommitteeMember(r: Record<string, unknown>): CommitteeMember {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    personId: (r.person_id as string) ?? null,
    slot: r.slot != null ? Number(r.slot) : null,
    isOrganizer: Boolean(r.is_organizer),
    payoutReceivedAt: (r.payout_received_at as string) ?? null,
    exitedAt: (r.exited_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapCommitteePayment(r: Record<string, unknown>): CommitteePayment {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    memberId: r.member_id as string,
    round: Number(r.round),
    paidAt: r.paid_at as string,
  };
}

export interface ArchiveContactResult {
  success: boolean;
  reasonCode: 'ARCHIVED' | 'CONTACT_NOT_FOUND' | 'LINKED_CONTACT' | 'BALANCE_NOT_SETTLED';
  userMessage: string;
  payableAmount: Record<string, number>;
  receivableAmount: Record<string, number>;
}

// ══════════════════════════════════════
// RECURRING TRANSACTIONS (Phase 3)
// ══════════════════════════════════════
export const recurringTransactionsDb = {
  async getAll(): Promise<RecurringTransaction[]> {
    const { data, error } = await supabase
      .from('recurring_transactions').select('*')
      .eq('user_id', getUserId())
      .order('next_due_date', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapRecurring);
  },
  async add(r: RecurringTransaction) {
    const { error } = await supabase.from('recurring_transactions').insert({
      id: r.id, user_id: getUserId(), type: r.type, amount: r.amount, currency: r.currency,
      source_account_id: r.sourceAccountId, destination_account_id: r.destinationAccountId,
      category: r.category, notes: r.notes, cadence: r.cadence, next_due_date: r.nextDueDate,
      active: r.active, label: r.label, created_at: r.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<RecurringTransaction>) {
    const row: Record<string, unknown> = {};
    if (changes.type !== undefined) row.type = changes.type;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.sourceAccountId !== undefined) row.source_account_id = changes.sourceAccountId;
    if (changes.destinationAccountId !== undefined) row.destination_account_id = changes.destinationAccountId;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.cadence !== undefined) row.cadence = changes.cadence;
    if (changes.nextDueDate !== undefined) row.next_due_date = changes.nextDueDate;
    if (changes.active !== undefined) row.active = changes.active;
    if (changes.label !== undefined) row.label = changes.label;
    const { error } = await supabase.from('recurring_transactions').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Compare-and-set due-date advance: only wins if next_due_date is still the
  // value this device expanded. A second device that already advanced makes
  // this 0-row (returns false) instead of double-advancing — the cross-device
  // half of expansion safety (the post itself is deduped by its note stamp).
  async advanceIfDue(id: string, expectedDueDate: string, nextDueDate: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('recurring_transactions')
      .update({ next_due_date: nextDueDate })
      .eq('id', id)
      .eq('user_id', getUserId())
      .eq('next_due_date', expectedDueDate)
      .select('id');
    if (error) throw error;
    return (data ?? []).length > 0;
  },
  async delete(id: string) {
    const { error } = await supabase.from('recurring_transactions').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapRecurring(r: Record<string, unknown>): RecurringTransaction {
  return {
    id: r.id as string,
    type: r.type as RecurringTransaction['type'],
    amount: Number(r.amount),
    currency: r.currency as Currency,
    sourceAccountId: (r.source_account_id as string) ?? null,
    destinationAccountId: (r.destination_account_id as string) ?? null,
    category: (r.category as string) ?? '',
    notes: (r.notes as string) ?? '',
    cadence: r.cadence as RecurringTransaction['cadence'],
    nextDueDate: r.next_due_date as string,
    active: r.active as boolean,
    label: (r.label as string) ?? '',
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// REMITTANCES (Phase 3)
// ══════════════════════════════════════
export const remittancesDb = {
  async getAll(): Promise<Remittance[]> {
    const { data, error } = await supabase
      .from('remittances').select('*')
      .eq('user_id', getUserId())
      .order('sent_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapRemittance);
  },
  async add(r: Remittance) {
    const { error } = await supabase.from('remittances').insert({
      id: r.id, user_id: getUserId(),
      source_account_id: r.sourceAccountId, source_currency: r.sourceCurrency, source_amount: r.sourceAmount,
      destination_account_id: r.destinationAccountId, destination_currency: r.destinationCurrency,
      destination_amount: r.destinationAmount,
      channel: r.channel, fee_amount: r.feeAmount, fee_currency: r.feeCurrency,
      effective_rate: r.effectiveRate, status: r.status,
      recipient_name: r.recipientName, notes: r.notes,
      source_txn_id: r.sourceTxnId, destination_txn_id: r.destinationTxnId,
      sent_at: r.sentAt, received_at: r.receivedAt, created_at: r.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Remittance>) {
    const row: Record<string, unknown> = {};
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.receivedAt !== undefined) row.received_at = changes.receivedAt;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.recipientName !== undefined) row.recipient_name = changes.recipientName;
    const { error } = await supabase.from('remittances').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('remittances').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapRemittance(r: Record<string, unknown>): Remittance {
  return {
    id: r.id as string,
    sourceAccountId: r.source_account_id as string,
    sourceCurrency: r.source_currency as Currency,
    sourceAmount: Number(r.source_amount),
    destinationAccountId: (r.destination_account_id as string) ?? null,
    destinationCurrency: r.destination_currency as Currency,
    destinationAmount: Number(r.destination_amount),
    channel: r.channel as Remittance['channel'],
    feeAmount: Number(r.fee_amount ?? 0),
    feeCurrency: r.fee_currency as Currency,
    effectiveRate: Number(r.effective_rate),
    status: r.status as Remittance['status'],
    recipientName: (r.recipient_name as string) ?? '',
    notes: (r.notes as string) ?? '',
    sourceTxnId: (r.source_txn_id as string) ?? null,
    destinationTxnId: (r.destination_txn_id as string) ?? null,
    sentAt: r.sent_at as string,
    receivedAt: (r.received_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// INVESTMENTS (record-keeping tracker: markets, trades, manual prices)
// Soft-delete tables — see supabase-migration-investments.sql. Positions are
// derived client-side from trades (investmentMath.ts); no holdings table.
// ══════════════════════════════════════
export const investmentMarketsDb = {
  async getAll(): Promise<InvestmentMarket[]> {
    const { data, error } = await supabase
      .from('investment_markets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapInvestmentMarket);
  },
  async add(m: InvestmentMarket) {
    const { error } = await supabase.from('investment_markets').insert({
      id: m.id, user_id: getUserId(), name: m.name, currency: m.currency,
      created_at: m.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<InvestmentMarket>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.currency !== undefined) row.currency = changes.currency;
    const { error } = await supabase.from('investment_markets').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('investment_markets')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const investmentTradesDb = {
  async getAll(): Promise<InvestmentTrade[]> {
    const { data, error } = await supabase
      .from('investment_trades').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('traded_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapInvestmentTrade);
  },
  // Upsert with deleted_at: null so LIFO rollback re-insertion works even if
  // a soft-deleted row with the same id lingers (transactions.add precedent).
  async add(t: InvestmentTrade) {
    const { error } = await supabase.from('investment_trades').upsert({
      id: t.id, user_id: getUserId(), market_id: t.marketId,
      symbol: t.symbol, name: t.name, kind: t.kind,
      quantity: t.quantity, price_per_unit: t.pricePerUnit, amount: t.amount,
      fees: t.fees, account_id: t.accountId, transaction_id: t.transactionId,
      traded_at: t.tradedAt, notes: t.notes, created_at: t.createdAt,
      deleted_at: null,
    });
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('investment_trades')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const investmentPricesDb = {
  async getAll(): Promise<InvestmentPrice[]> {
    const { data, error } = await supabase
      .from('investment_prices').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map(mapInvestmentPrice);
  },
  // Upsert on the (user, market, symbol) unique key — one manual price per
  // ticker, updated in place.
  async upsert(p: InvestmentPrice) {
    const { error } = await supabase.from('investment_prices').upsert({
      id: p.id, user_id: getUserId(), market_id: p.marketId, symbol: p.symbol,
      price: p.price, as_of: p.asOf, created_at: p.createdAt,
      updated_at: new Date().toISOString(), deleted_at: null,
    }, { onConflict: 'user_id,market_id,symbol' });
    if (error) throw error;
  },
};

function mapInvestmentMarket(r: Record<string, unknown>): InvestmentMarket {
  return {
    id: r.id as string,
    name: r.name as string,
    currency: r.currency as Currency,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapInvestmentTrade(r: Record<string, unknown>): InvestmentTrade {
  return {
    id: r.id as string,
    marketId: r.market_id as string,
    symbol: r.symbol as string,
    name: (r.name as string) ?? '',
    kind: r.kind as InvestmentTrade['kind'],
    quantity: Number(r.quantity),
    pricePerUnit: Number(r.price_per_unit),
    amount: Number(r.amount),
    fees: Number(r.fees),
    accountId: (r.account_id as string) ?? null,
    transactionId: (r.transaction_id as string) ?? null,
    tradedAt: r.traded_at as string,
    notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapInvestmentPrice(r: Record<string, unknown>): InvestmentPrice {
  return {
    id: r.id as string,
    marketId: r.market_id as string,
    symbol: r.symbol as string,
    price: Number(r.price),
    asOf: r.as_of as string,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// APP CONFIG (audit H9 / MF-12) — remote kill switch, read before login
// ─────────────────────────────────────────────────────────────────────────────
// The one row in this gateway that is NOT user-scoped. `app_config` is a
// singleton, world-readable row (`id = 'default'`) holding the minimum client
// version the backend still supports — see supabase-migration-p1-app-config.sql
// for the schema, the RLS (SELECT to anon AND authenticated, no client writes)
// and the release policy for raising the floor.
//
// Deliberately does NOT call getUserId(): the version gate runs BEFORE the auth
// gate in src/App.tsx, so this must work with no session at all. A client too
// old to authenticate correctly against a changed schema is exactly the one we
// need to stop.

/** The `app_config` singleton, camel-cased. All fields may be null. */
export interface AppConfigRecord {
  minSupportedVersion: string | null;
  minSupportedVersionCode: number | null;
  messageEn: string | null;
  messageUr: string | null;
  updatedAt: string | null;
}

export const appConfigDb = {
  /**
   * Read the singleton config row. Returns null when the row is absent —
   * including when the migration has not been applied yet, since PostgREST
   * reports a missing table as an error the caller treats the same way
   * (fail open). Callers MUST treat both null and a thrown error as "allowed";
   * `isSupported()` in src/lib/versionGate.ts does exactly that.
   */
  async get(): Promise<AppConfigRecord | null> {
    const { data, error } = await supabase
      .from('app_config')
      .select('min_supported_version, min_supported_version_code, message_en, message_ur, updated_at')
      .eq('id', 'default')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as Record<string, unknown>;
    const code = Number(r.min_supported_version_code);
    return {
      minSupportedVersion: typeof r.min_supported_version === 'string' ? r.min_supported_version : null,
      minSupportedVersionCode: Number.isFinite(code) ? code : null,
      messageEn: typeof r.message_en === 'string' ? r.message_en : null,
      messageUr: typeof r.message_ur === 'string' ? r.message_ur : null,
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC MONEY ENGINE — L4 pilot (audit MF-01 / O-1 / F-4)
// ─────────────────────────────────────────────────────────────────────────────
// One server-side transaction per money move, so a flaky network can no longer
// leave money half-moved. `src/lib/mutationSafety.ts:10-13` states the ceiling
// this raises: "Compensations may themselves fail (the same network outage that
// killed the forward write usually kills the inverse)."
//
// Contract, error tokens, artifact table and the Docker evidence live in
// supabase-migration-p3-atomic-transfer.sql and docs/server-side-money-engine.md.
//
// Why this section sits at the END of the file rather than inside the
// `transactionsDb` literal: several agents were editing this file concurrently
// when it was written, and an append is conflict-free. It is a namespace object
// in the same `xxxDb` shape as every other gateway above.

/** Everything `transfer_between_accounts` needs. Amounts are raw JS numbers. */
export interface AtomicTransferInput {
  /** Client-generated uuid. Doubles as the idempotency key on retry. */
  transactionId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  /** Source-currency amount, exactly as it is stored on the transaction row. */
  amount: number;
  /**
   * What the caller expects to land in the destination. Cross-checked by the
   * server (0.01 tolerance), never trusted. Null = "server decides", which is
   * what a same-currency move sends.
   */
  destinationAmount: number | null;
  /** Null for same-currency, else destination-per-source (the client's shape). */
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** The compare-and-swap expectations — the locally-known balances. */
  expectedSourceBalance: number;
  expectedDestinationBalance: number;
  /**
   * Skip the insufficient-balance guard. The reversal/repair hatch only
   * (mirrors REVERSAL_NEEDS_NEGATIVE). The create path always leaves this
   * false, which is exactly what `checkBalance` does today — including for a
   * credit-card source, whose `balance` IS its available credit.
   */
  allowNegative?: boolean;
}

export interface AtomicTransferResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  /** Server truth after the move — apply these, do not recompute them. */
  sourceBalance: number;
  destinationBalance: number;
  /** What actually landed. Null on a replay (the row is the record). */
  destinationAmount: number | null;
  conversionRate: number | null;
}

/**
 * A stale compare-and-swap. Carries the same `code` the account CAS already
 * throws, so `accountStore`-style refetch-and-retry-once ladders work
 * unchanged; the fresh balances ride along so a retry needs no extra fetch.
 */
export interface AtomicTransferConflict extends Error {
  code: 'BALANCE_CONFLICT';
  sourceBalance: number | null;
  destinationBalance: number | null;
}

/** The server half of `checkBalance`. `message` is the same bilingual string. */
export interface AtomicTransferInsufficient extends Error {
  code: 'INSUFFICIENT_BALANCE';
  accountName: string;
  available: number;
  requested: number;
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicTransferUnavailable extends Error {
  code: 'ATOMIC_TRANSFER_UNAVAILABLE';
}

function parseRpcDetail(error: unknown): Record<string, unknown> | null {
  const detail = (error as { details?: unknown })?.details;
  if (typeof detail !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // DETAIL is prose on the non-money errors (SAME_ACCOUNT, …). Not a failure.
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const atomicMoneyDb = {
  /**
   * The whole account→account transfer — both balance legs AND the
   * transactions row — in ONE Postgres transaction.
   *
   * Idempotent on `transactionId`: a retry after a dropped reply returns
   * `{ replay: true }` with the current balances instead of moving money twice.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT             — refetch and retry once (accountStore ladder)
   *   INSUFFICIENT_BALANCE         — message is already the user-facing string
   *   ATOMIC_TRANSFER_UNAVAILABLE  — supabase-migration-p3-atomic-transfer.sql
   *                                  is not applied; the caller must fall back
   *                                  to the legacy two-leg path
   * Anything else is rethrown untouched.
   */
  async transferAtomic(input: AtomicTransferInput): Promise<AtomicTransferResult> {
    const { data, error } = await supabase.rpc('transfer_between_accounts', {
      p_transaction_id: input.transactionId,
      p_source_account_id: input.sourceAccountId,
      p_destination_account_id: input.destinationAccountId,
      p_amount: input.amount,
      p_destination_amount: input.destinationAmount,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_expected_source_balance: input.expectedSourceBalance,
      p_expected_destination_balance: input.expectedDestinationBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicTransferConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.sourceBalance = numberOrNull(detail?.source_balance);
        conflict.destinationBalance = numberOrNull(detail?.destination_balance);
        throw conflict;
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today
        // (src/stores/transactionStore.ts:195-204) so the toast the user sees
        // is byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('transfer_between_accounts')) {
        const err = new Error(
          'transfer_between_accounts is not available — apply supabase-migration-p3-atomic-transfer.sql or unset VITE_ATOMIC_TRANSFER.',
        ) as AtomicTransferUnavailable;
        err.code = 'ATOMIC_TRANSFER_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const sourceBalance = numberOrNull(row.source_balance);
    const destinationBalance = numberOrNull(row.destination_balance);
    if (sourceBalance === null || destinationBalance === null) {
      // A success reply we cannot read is not a success: the caller would
      // write nonsense into the balance store.
      throw new Error('transfer_between_accounts returned no balances');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      sourceBalance,
      destinationBalance,
      destinationAmount: numberOrNull(row.destination_amount),
      conversionRate: numberOrNull(row.conversion_rate),
    };
  },
};
