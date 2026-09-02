import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { remittancesDb } from '../lib/supabaseDb';
import type { Remittance, RemittanceChannel, RemittanceStatus, Currency } from '../db';
import { useTransactionStore } from './transactionStore';
import { reportError } from '../lib/errorReporter';

interface CreateInput {
  sourceAccountId: string;
  sourceCurrency: Currency;
  sourceAmount: number;
  destinationAccountId: string | null;
  destinationCurrency: Currency;
  destinationAmount: number;
  channel: RemittanceChannel;
  feeAmount: number;
  feeCurrency: Currency;
  recipientName: string;
  notes: string;
  sentAt: string;
}

interface RemittanceState {
  remittances: Remittance[];
  loading: boolean;
  loadRemittances: () => Promise<void>;
  createRemittance: (input: CreateInput) => Promise<Remittance>;
  markReceived: (id: string, receivedAt?: string) => Promise<void>;
  deleteRemittance: (id: string) => Promise<void>;
  reset: () => void;
}

const INITIAL = { remittances: [] as Remittance[], loading: false };

export const useRemittanceStore = create<RemittanceState>((set, get) => ({
  ...INITIAL,
  reset: () => set(INITIAL),

  loadRemittances: async () => {
    set({ loading: true });
    try {
      const remittances = await remittancesDb.getAll();
      set({ remittances });
    } finally {
      set({ loading: false });
    }
  },

  createRemittance: async (input) => {
    // Effective rate = destination received per 1 unit of source SENT (after
    // the source-side fee). This is the number users compare across channels:
    // "what did 1 AED actually become in PKR after fees?"
    // When the fee is in a different currency we treat it as zero on the
    // source side — a true cross-currency fee subtraction needs an FX rate
    // we don't have here.
    const netSource =
      input.feeCurrency === input.sourceCurrency
        ? Math.max(input.sourceAmount - input.feeAmount, 0.0001)
        : input.sourceAmount;
    const effectiveRate = input.destinationAmount / netSource;
    const sentAtIso = input.sentAt || new Date().toISOString();

    // Materialise the source-side debit as a real Transaction so the user's
    // account balance reflects the transfer. We do NOT auto-create the
    // destination-side credit when destinationAccountId is null (cash-pickup
    // case); the user can mark received later and link an account then.
    let sourceTxnId: string | null = null;
    try {
      const tx = await useTransactionStore.getState().processTransaction({
        type: 'expense',
        sourceAccountId: input.sourceAccountId,
        amount: input.sourceAmount,
        category: 'Remittance',
        notes: input.notes
          ? `Remittance → ${input.recipientName}: ${input.notes}`
          : `Remittance → ${input.recipientName}`,
      });
      sourceTxnId = tx.id;
    } catch (err) {
      // If the source debit fails (insufficient balance, etc.) the
      // remittance record never gets persisted — surface the error.
      reportError(err, { feature: 'remittanceStore.createRemittance.sourceDebit' });
      throw err instanceof Error ? err : new Error('Source debit failed');
    }

    const r: Remittance = {
      id: uuid(),
      sourceAccountId: input.sourceAccountId,
      sourceCurrency: input.sourceCurrency,
      sourceAmount: input.sourceAmount,
      destinationAccountId: input.destinationAccountId,
      destinationCurrency: input.destinationCurrency,
      destinationAmount: input.destinationAmount,
      channel: input.channel,
      feeAmount: input.feeAmount,
      feeCurrency: input.feeCurrency,
      effectiveRate,
      status: 'pending' as RemittanceStatus,
      recipientName: input.recipientName,
      notes: input.notes,
      sourceTxnId,
      destinationTxnId: null,
      sentAt: sentAtIso,
      receivedAt: null,
      createdAt: new Date().toISOString(),
    };
    await remittancesDb.add(r);
    set((s) => ({ remittances: [r, ...s.remittances] }));
    return r;
  },

  markReceived: async (id, receivedAt) => {
    const iso = receivedAt ?? new Date().toISOString();
    const existing = get().remittances.find((r) => r.id === id);
    if (!existing) return;

    // If the user linked a destination account at creation time, materialise
    // the credit now. Otherwise this is purely a status change — the cash
    // landed somewhere outside Hisaab and that's a deliberate choice.
    let destinationTxnId: string | null = existing.destinationTxnId;
    if (existing.destinationAccountId && !existing.destinationTxnId) {
      try {
        const tx = await useTransactionStore.getState().processTransaction({
          type: 'income',
          destinationAccountId: existing.destinationAccountId,
          amount: existing.destinationAmount,
          category: 'Remittance',
          notes: `Remittance received from ${existing.recipientName}`,
        });
        destinationTxnId = tx.id;
      } catch (err) {
        reportError(err, { feature: 'remittanceStore.markReceived.destinationCredit', extra: { remittanceId: id } });
        throw err instanceof Error ? err : new Error('Destination credit failed');
      }
    }

    await remittancesDb.update(id, {
      status: 'received' as RemittanceStatus,
      receivedAt: iso,
    });
    set((s) => ({
      remittances: s.remittances.map((r) =>
        r.id === id ? { ...r, status: 'received', receivedAt: iso, destinationTxnId } : r,
      ),
    }));
  },

  deleteRemittance: async (id) => {
    await remittancesDb.delete(id);
    set((s) => ({ remittances: s.remittances.filter((r) => r.id !== id) }));
  },
}));
