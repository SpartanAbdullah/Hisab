import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { settlementRequestsDb } from '../lib/supabaseDb';
import type { SettlementRequest, Currency } from '../db';
import { translateLinkedWriteError, isDuplicateKeyError } from '../lib/linkedErrorMap';
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
  // Idempotency key (audit 2026-09, F-8) — see linkedRequestStore.CreateInput.
  // `linked_settlement_requests.id` is a client-supplied `text primary key`
  // and create_settlement_request inserts it verbatim, so reusing one id per
  // submit intent turns a double-fire into a 23505 instead of two settlement
  // requests the counterparty could both accept. Omitted ⇒ fresh uuid.
  requestId?: string;
}

interface SettlementRequestState {
  requests: SettlementRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  createRequest: (input: CreateInput) => Promise<SettlementRequest>;
  accept: (requestId: string, responderAccountId?: string | null) => Promise<SettlementRequest>;
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
    const id = input.requestId ?? uuid();
    try {
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
    } catch (err) {
      // Idempotent create (audit F-8): a primary-key collision on OUR intent
      // id means this exact request already landed (double tap, or a retry
      // after an ambiguous failure). Fall through to the reload and return the
      // row that exists; a 23505 from any other constraint still throws below
      // because the id lookup finds nothing.
      if (!isDuplicateKeyError(err)) {
        // linked_settlement_requests carried the same AED/PKR-only currency
        // CHECK (audit F-MIG2 / H6, widened by
        // supabase-migration-audit-p0-currencies.sql). If this build meets a
        // database without that migration, translate the raw SQLSTATE 23514
        // instead of showing the Postgres string. Covers SettleLinkedLoanModal
        // and the bulk AllocateSettlementModal loop.
        throw translateLinkedWriteError(err, 'settlement');
      }
    }
    await get().loadRequests();
    const inserted = get().requests.find((r) => r.id === id);
    if (!inserted) throw new Error('Settlement request created but could not be reloaded');
    return inserted;
  },

  accept: async (requestId, responderAccountId) => {
    const updated = await settlementRequestsDb.accept(requestId, responderAccountId ?? null);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    try {
      await useLoanStore.getState().loadLoans();
      await useTransactionStore.getState().loadTransactions();
      // Unconditionally refresh accounts. A no-op for ledger-only
      // settlements; picks up the sender's opted-in effect and the
      // receiver's landing account chosen just now.
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
