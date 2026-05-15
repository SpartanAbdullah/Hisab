import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { linkedRequestsDb } from '../lib/supabaseDb';
import type { LinkedRequest, LinkedRequestKind, Currency, Loan } from '../db';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';
import { usePersonStore } from './personStore';

// Currencies the linked_transaction_requests SQL check constraint allows
// (see supabase-migration-phase2b-linked-requests.sql). The wider
// SUPPORTED_CURRENCIES set is for the local-only ledger; cross-user
// linked records are still AED/PKR-only at the DB layer. Keeping this
// constant local to the store so the client never sends a row the SQL
// would reject — instead we surface the filtered count to the UI.
export const LINKED_REQUEST_CURRENCIES = ['AED', 'PKR'] as const;
export type LinkedRequestCurrency = typeof LINKED_REQUEST_CURRENCIES[number];
function isLinkedRequestCurrency(c: Currency): c is LinkedRequestCurrency {
  return (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(c);
}

interface CreateInput {
  toUserId: string;
  personId: string;
  kind: LinkedRequestKind;
  amount: number;
  currency: Currency;
  note?: string;
  // Phase 2D: when set, the request references an existing sender-side
  // loan instead of creating a fresh one on acceptance.
  preExistingLoanId?: string | null;
}

export interface SyncableLoansBreakdown {
  // Loans eligible to sync right now: active, remaining > 0, currency
  // accepted by linked_transaction_requests, not already in a pending
  // sync request.
  syncable: Loan[];
  // Loans that match the person + active state but have a currency
  // the linked request table doesn't accept yet (everything outside
  // LINKED_REQUEST_CURRENCIES). Surface the count so the UI can be
  // honest about what won't be sent.
  skipped: Loan[];
}

export interface SyncPastRecordsResult extends SyncableLoansBreakdown {
  // The N requests we just created — one per loan in `syncable`.
  created: LinkedRequest[];
}

interface LinkedRequestState {
  requests: LinkedRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  createRequest: (input: CreateInput) => Promise<LinkedRequest>;
  accept: (requestId: string) => Promise<LinkedRequest>;
  reject: (requestId: string, reason?: string) => Promise<LinkedRequest>;
  cancel: (requestId: string) => Promise<LinkedRequest>;
  incomingPending: (myUserId: string) => LinkedRequest[];
  outgoingPending: (myUserId: string) => LinkedRequest[];
  forTab: (tab: 'incoming' | 'outgoing', myUserId: string) => LinkedRequest[];
  // Returns the syncable + skipped split for a person. UI uses syncable
  // to render the per-currency open-balance preview, and skipped to
  // surface "N loans in unsupported currencies were left as local-only".
  syncableBreakdownFor: (personId: string) => SyncableLoansBreakdown;
  // Fires N linked-request inserts in parallel — one per loan in
  // `syncable`. Returns the breakdown + created list so the caller can
  // render a confirmation summary.
  syncPastRecords: (personId: string) => Promise<SyncPastRecordsResult>;
  reset: () => void;
}

const INITIAL: Pick<LinkedRequestState, 'requests' | 'loading'> = {
  requests: [],
  loading: false,
};

function upsert(list: LinkedRequest[], next: LinkedRequest): LinkedRequest[] {
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export const useLinkedRequestStore = create<LinkedRequestState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadRequests: async () => {
    set({ loading: true });
    try {
      const requests = await linkedRequestsDb.getAll();
      set({ requests });
    } finally {
      set({ loading: false });
    }
  },

  createRequest: async (input) => {
    const id = uuid();
    await linkedRequestsDb.insert({
      id,
      toUserId: input.toUserId,
      personId: input.personId,
      kind: input.kind,
      amount: input.amount,
      currency: input.currency,
      note: input.note ?? '',
      preExistingLoanId: input.preExistingLoanId ?? null,
    });
    // Reload to get the canonical row (status, created_at, etc.).
    await get().loadRequests();
    const inserted = get().requests.find((r) => r.id === id);
    if (!inserted) throw new Error('Request created but could not be reloaded');
    return inserted;
  },

  accept: async (requestId) => {
    const updated = await linkedRequestsDb.accept(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    // Pull the newly-mirrored loan + transaction rows. Balances are NOT
    // moved in Phase 2B, so accounts do not need a reload.
    try {
      await useLoanStore.getState().loadLoans();
      await useTransactionStore.getState().loadTransactions();
    } catch (err) {
      console.error('post-accept reload failed (non-fatal)', err);
    }
    return updated;
  },

  reject: async (requestId, reason) => {
    const updated = await linkedRequestsDb.reject(requestId, reason);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  cancel: async (requestId) => {
    const updated = await linkedRequestsDb.cancel(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  syncableBreakdownFor: (personId) => {
    const allRequests = get().requests;
    // A loan is already syncing (or has been synced) if any
    // non-cancelled/non-rejected request references it via
    // pre_existing_loan_id. Cancelled / rejected requests free the slot
    // — the user can retry. Accepted requests should also block, since
    // the loan is now linked.
    const blockedLoanIds = new Set(
      allRequests
        .filter((r) => r.preExistingLoanId && r.status !== 'cancelled' && r.status !== 'rejected')
        .map((r) => r.preExistingLoanId as string),
    );
    const loans = useLoanStore.getState().loans;
    const candidates = loans.filter(
      (l) =>
        l.personId === personId &&
        l.status === 'active' &&
        l.remainingAmount > 0.01 &&
        !blockedLoanIds.has(l.id),
    );
    const syncable: Loan[] = [];
    const skipped: Loan[] = [];
    for (const loan of candidates) {
      if (isLinkedRequestCurrency(loan.currency)) syncable.push(loan);
      else skipped.push(loan);
    }
    return { syncable, skipped };
  },

  syncPastRecords: async (personId) => {
    const person = usePersonStore.getState().persons.find((p) => p.id === personId);
    if (!person) throw new Error('Contact not found');
    if (!person.linkedProfileId) {
      throw new Error('Contact is not linked to a Hisaab user yet');
    }
    const { syncable, skipped } = get().syncableBreakdownFor(personId);
    if (syncable.length === 0) return { syncable, skipped, created: [] };

    // Build requests in parallel. We send each loan's CURRENT remaining
    // amount (not original total) so the receiver sees what's actually
    // open between them. The local sender-side loan keeps its full
    // history — the accept_linked_request RPC reuses it on acceptance,
    // no duplicate row created. Each request carries its OWN currency
    // from the underlying loan; mixed-currency contacts produce one
    // request per currency naturally.
    const created: LinkedRequest[] = await Promise.all(
      syncable.map((loan) =>
        get().createRequest({
          toUserId: person.linkedProfileId!,
          personId: person.id,
          kind: loan.type === 'given' ? 'lent' : 'borrowed',
          amount: loan.remainingAmount,
          currency: loan.currency,
          note: loan.notes ?? '',
          preExistingLoanId: loan.id,
        }),
      ),
    );

    return { syncable, skipped, created };
  },

  incomingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.toUserId === myUserId),

  outgoingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.fromUserId === myUserId),

  forTab: (tab, myUserId) =>
    get().requests.filter((r) =>
      tab === 'incoming' ? r.toUserId === myUserId : r.fromUserId === myUserId,
    ),
}));
