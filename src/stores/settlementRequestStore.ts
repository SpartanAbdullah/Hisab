import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { settlementRequestsDb } from '../lib/supabaseDb';
import type { SettlementRequest, Currency } from '../db';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';
import { useAccountStore } from './accountStore';

interface CreateInput {
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note?: string;
  // Phase 2C-B: optional sender-side opt-in. Null ⇒ ledger-only on both sides.
  requesterAccountId?: string | null;
}

interface SettlementRequestState {
  requests: SettlementRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  createRequest: (input: CreateInput) => Promise<SettlementRequest>;
  accept: (requestId: string) => Promise<SettlementRequest>;
  reject: (requestId: string, reason?: string) => Promise<SettlementRequest>;
  cancel: (requestId: string) => Promise<SettlementRequest>;
  byLoanPair: (loanPairId: string) => SettlementRequest[];
  incomingPending: (myUserId: string) => SettlementRequest[];
  outgoingPending: (myUserId: string) => SettlementRequest[];
  reset: () => void;
}

const INITIAL: Pick<SettlementRequestState, 'requests' | 'loading'> = {
  requests: [],
  loading: false,
};

function upsert(list: SettlementRequest[], next: SettlementRequest): SettlementRequest[] {
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export const useSettlementRequestStore = create<SettlementRequestState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadRequests: async () => {
    set({ loading: true });
    try {
      const requests = await settlementRequestsDb.getAll();
      set({ requests });
    } finally {
      set({ loading: false });
    }
  },

  createRequest: async (input) => {
    const id = uuid();
    await settlementRequestsDb.insert({
      id,
      loanPairId: input.loanPairId,
      requesterLoanId: input.requesterLoanId,
      responderLoanId: input.responderLoanId,
      toUserId: input.toUserId,
      amount: input.amount,
      currency: input.currency,
      note: input.note ?? '',
      requesterAccountId: input.requesterAccountId ?? null,
    });
    await get().loadRequests();
    const inserted = get().requests.find((r) => r.id === id);
    if (!inserted) throw new Error('Settlement request created but could not be reloaded');
    return inserted;
  },

  accept: async (requestId) => {
    const updated = await settlementRequestsDb.accept(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    try {
      await useLoanStore.getState().loadLoans();
      await useTransactionStore.getState().loadTransactions();
      // Phase 2C-B: unconditionally refresh accounts. A no-op for balances
      // on ledger-only settlements; picks up the sender's debit when they
      // had opted in (receiver balances remain unchanged).
      await useAccountStore.getState().loadAccounts();
    } catch (err) {
      console.error('post-settlement-accept reload failed (non-fatal)', err);
    }
    return updated;
  },

  reject: async (requestId, reason) => {
    const updated = await settlementRequestsDb.reject(requestId, reason);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  cancel: async (requestId) => {
    const updated = await settlementRequestsDb.cancel(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  byLoanPair: (loanPairId) =>
    get().requests.filter((r) => r.loanPairId === loanPairId),

  incomingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.toUserId === myUserId),

  outgoingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.fromUserId === myUserId),
}));
