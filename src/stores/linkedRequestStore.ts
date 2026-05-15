import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { linkedRequestsDb } from '../lib/supabaseDb';
import type { LinkedRequest, LinkedRequestKind, Currency, Loan } from '../db';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';
import { usePersonStore } from './personStore';

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

export interface SyncPastRecordsResult {
  // Loans the user has with this person that COULD be synced (active,
  // remaining > 0, not already linked, not already pending sync).
  syncable: Loan[];
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
  // Returns the set of loans that haven't been synced to the linked
  // contact yet. UI uses this to decide whether to show the "Sync past
  // records" card on ContactDetailSheet and to render the count.
  syncableLoansFor: (personId: string) => Loan[];
  // Fires N linked-request inserts in parallel — one per syncable loan
  // tagged to this person. Returns the (synced, created) pair so the
  // caller can render a confirmation summary.
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

  syncableLoansFor: (personId) => {
    const allRequests = get().requests;
    // A loan is already syncing (or has been synced) if any non-cancelled
    // request references it via pre_existing_loan_id. Cancelled requests
    // free the slot — the user is free to retry. Once accepted the loan
    // is linked and shouldn't show up either.
    const blockedLoanIds = new Set(
      allRequests
        .filter((r) => r.preExistingLoanId && r.status !== 'cancelled' && r.status !== 'rejected')
        .map((r) => r.preExistingLoanId as string),
    );
    const loans = useLoanStore.getState().loans;
    return loans.filter(
      (l) =>
        l.personId === personId &&
        l.status === 'active' &&
        l.remainingAmount > 0.01 &&
        !blockedLoanIds.has(l.id),
    );
  },

  syncPastRecords: async (personId) => {
    const person = usePersonStore.getState().persons.find((p) => p.id === personId);
    if (!person) throw new Error('Contact not found');
    if (!person.linkedProfileId) {
      throw new Error('Contact is not linked to a Hisaab user yet');
    }
    const syncable = get().syncableLoansFor(personId);
    if (syncable.length === 0) return { syncable, created: [] };

    // Build requests in parallel. We send each loan's CURRENT remaining
    // amount (not original total) so the receiver sees what's actually
    // open between them. The local sender-side loan keeps its full
    // history — the existing accept_linked_request RPC reuses it on
    // acceptance, no duplicate row created.
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

    return { syncable, created };
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
