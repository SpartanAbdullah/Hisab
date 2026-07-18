import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { loansDb, transactionsDb } from '../lib/supabaseDb';
import { loadCacheFirst, markMirrorStale, mirrorDelete, mirrorPut } from '../lib/mirrorCache';
import { assertLinkedLoanEditAllowed, assertLinkedLoanDeleteAllowed } from '../lib/linkedLoanGuards';
import type { Loan, LoanType, Currency, Transaction } from '../db';
import { useActivityStore } from './activityStore';
import { useEmiStore } from './emiStore';

export interface CreateLoanInput {
  personName: string;
  personId?: string | null;
  type: LoanType;
  totalAmount: number;
  currency: Currency;
  notes?: string;
}

interface LoanState {
  loans: Loan[];
  loading: boolean;
  loadLoans: () => Promise<void>;
  createLoan: (input: CreateLoanInput) => Promise<Loan>;
  applyRepayment: (loanId: string, amount: number, notes?: string) => Promise<void>;
  updateLoan: (loanId: string, changes: Partial<Loan>) => Promise<void>;
  deleteLoan: (loanId: string) => Promise<void>;
  getLoan: (id: string) => Loan | undefined;
  reset: () => void;
}

const INITIAL_LOAN_STATE = {
  loans: [] as Loan[],
  loading: false,
};

export const useLoanStore = create<LoanState>((set, get) => ({
  ...INITIAL_LOAN_STATE,

  reset: () => set(INITIAL_LOAN_STATE),

  loadLoans: async () => {
    set({ loading: true });
    try {
      const { rows: loans } = await loadCacheFirst({
        key: 'loans',
        table: db.loans,
        fetchRemote: loansDb.getAll,
        fetchUpdatedSince: loansDb.getUpdatedSince,
        fetchDeletedSince: loansDb.getDeletedSince,
        getUpdatedAt: (loan) => loan.updatedAt ?? loan.createdAt,
        sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
      });
      set({ loans });
    } finally {
      set({ loading: false });
    }
  },

  createLoan: async (input) => {
    const loan: Loan = {
      id: uuid(),
      personName: input.personName,
      personId: input.personId ?? null,
      type: input.type,
      totalAmount: input.totalAmount,
      remainingAmount: input.totalAmount,
      currency: input.currency,
      status: 'active',
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    loan.updatedAt = loan.createdAt;
    await loansDb.add(loan);
    await mirrorPut(db.loans, loan);
    markMirrorStale('loans');
    set((s) => ({ loans: [...s.loans, loan] }));
    await useActivityStore.getState().logActivity(
      'loan_created',
      `Loan ${input.type === 'given' ? 'given to' : 'taken from'} ${input.personName}: ${input.currency} ${input.totalAmount}`,
      loan.id,
      'loan'
    );
    return loan;
  },

  applyRepayment: async (loanId, amount, notes) => {
    const loan = get().loans.find((l) => l.id === loanId);
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    const newRemaining = Math.max(0, loan.remainingAmount - amount);
    const newStatus = newRemaining === 0 ? 'settled' : 'active';
    const nextLoan = {
      ...loan,
      remainingAmount: newRemaining,
      status: newStatus as Loan['status'],
      updatedAt: new Date().toISOString(),
    };
    await loansDb.update(loanId, { remainingAmount: newRemaining, status: newStatus as Loan['status'] });
    await mirrorPut(db.loans, nextLoan);
    markMirrorStale('loans');
    set((s) => ({
      loans: s.loans.map((l) =>
        l.id === loanId ? nextLoan : l
      ),
    }));

    // Record-keeping: a repayment must leave a trace. Previously the ledger-only
    // path vanished the money into remainingAmount — no history line, no
    // activity, nothing on statements, which is unacceptable for a money app.
    // Write a real repayment transaction row (no account legs — pure record) so
    // loan history, the activity feed and statements all show what was paid and
    // when. Best-effort: the balance update above is the source of truth and
    // must not be failed retroactively if the record write hits a network error.
    const applied = Math.round((loan.remainingAmount - newRemaining) * 100) / 100;
    if (applied > 0.001) {
      const record: Transaction = {
        id: uuid(),
        type: 'repayment',
        amount: applied,
        currency: loan.currency,
        sourceAccountId: null,
        destinationAccountId: null,
        relatedPerson: loan.personName,
        personId: loan.personId ?? null,
        relatedLoanId: loanId,
        relatedGoalId: null,
        conversionRate: null,
        category: '',
        notes: notes?.trim() ?? '',
        createdAt: nextLoan.updatedAt,
      };
      try {
        await transactionsDb.add(record);
        await mirrorPut(db.transactions, record);
        markMirrorStale('transactions');
        // Dynamic import: transactionStore statically imports this store, so a
        // static import back would create a module cycle.
        const { useTransactionStore } = await import('./transactionStore');
        useTransactionStore.setState((s) => ({ transactions: [record, ...s.transactions] }));
      } catch (err) {
        console.error('repayment record write failed (non-fatal)', err);
      }
      try {
        await useActivityStore.getState().logActivity(
          'transaction_created',
          loan.type === 'given'
            ? `Received ${loan.currency} ${applied} from ${loan.personName}`
            : `Repaid ${loan.currency} ${applied} to ${loan.personName}`,
          record.id,
          'transaction',
        );
      } catch (err) {
        console.error('repayment activity log failed (non-fatal)', err);
      }
    }

    if (newStatus === 'settled') {
      await useActivityStore.getState().logActivity(
        'loan_settled',
        `Loan with ${loan.personName} fully settled`,
        loanId,
        'loan'
      );
    }
    // Ledger-only (splits_only) path: this bypasses processTransaction, so
    // reconcile any EMI schedule to the new paid-down balance here too —
    // otherwise a partial (or even full) repayment would orphan the schedule.
    // Best-effort: a reconcile failure must not fail the repayment.
    try {
      await useEmiStore.getState().reconcileCovered(
        loanId,
        Math.round((loan.totalAmount - newRemaining) * 100) / 100,
      );
    } catch (err) {
      console.error('reconcileCovered failed after applyRepayment (non-fatal)', err);
    }
  },

  updateLoan: async (loanId, changes) => {
    const loan = get().loans.find((l) => l.id === loanId);
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    // A mirrored (linked) loan can't have its currency/amount changed on one
    // side — that would diverge from the other user's copy.
    assertLinkedLoanEditAllowed(loan, changes);

    const nextLoan: Loan = {
      ...loan,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await loansDb.update(loanId, changes);
    await mirrorPut(db.loans, nextLoan);
    markMirrorStale('loans');
    set((s) => ({
      loans: s.loans.map((l) => (l.id === loanId ? nextLoan : l)),
    }));
  },

  deleteLoan: async (loanId) => {
    const existing = get().loans.find((l) => l.id === loanId);
    if (existing) assertLinkedLoanDeleteAllowed(existing);
    await loansDb.delete(loanId);
    await mirrorDelete(db.loans, loanId);
    markMirrorStale('loans');
    set((s) => ({
      loans: s.loans.filter((l) => l.id !== loanId),
    }));
  },

  getLoan: (id) => get().loans.find((l) => l.id === id),
}));
