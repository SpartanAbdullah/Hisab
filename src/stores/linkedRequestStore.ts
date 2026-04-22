import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { linkedRequestsDb } from '../lib/supabaseDb';
import type { LinkedRequest, LinkedRequestKind, Currency } from '../db';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';

interface CreateInput {
  toUserId: string;
  personId: string;
  kind: LinkedRequestKind;
  amount: number;
  currency: Currency;
  note?: string;
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

  incomingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.toUserId === myUserId),

  outgoingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.fromUserId === myUserId),

  forTab: (tab, myUserId) =>
    get().requests.filter((r) =>
      tab === 'incoming' ? r.toUserId === myUserId : r.fromUserId === myUserId,
    ),
}));
