import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { Loan, LoanType, Currency } from '../db';
import { useActivityStore } from './activityStore';

interface CreateLoanInput {
  personName: string;
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
  applyRepayment: (loanId: string, amount: number) => Promise<void>;
  getLoan: (id: string) => Loan | undefined;
}

export const useLoanStore = create<LoanState>((set, get) => ({
  loans: [],
  loading: false,

  loadLoans: async () => {
    set({ loading: true });
    const loans = await db.loans.toArray();
    set({ loans, loading: false });
  },

  createLoan: async (input) => {
    const loan: Loan = {
      id: uuid(),
      personName: input.personName,
      type: input.type,
      totalAmount: input.totalAmount,
      remainingAmount: input.totalAmount,
      currency: input.currency,
      status: 'active',
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    await db.loans.add(loan);
    set((s) => ({ loans: [...s.loans, loan] }));
    await useActivityStore.getState().logActivity(
      'loan_created',
      `Loan ${input.type === 'given' ? 'given to' : 'taken from'} ${input.personName}: ${input.currency} ${input.totalAmount}`,
      loan.id,
      'loan'
    );
    return loan;
  },

  applyRepayment: async (loanId, amount) => {
    const loan = get().loans.find((l) => l.id === loanId);
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    const newRemaining = Math.max(0, loan.remainingAmount - amount);
    const newStatus = newRemaining === 0 ? 'settled' : 'active';
    await db.loans.update(loanId, { remainingAmount: newRemaining, status: newStatus });
    set((s) => ({
      loans: s.loans.map((l) =>
        l.id === loanId ? { ...l, remainingAmount: newRemaining, status: newStatus } : l
      ),
    }));
    if (newStatus === 'settled') {
      await useActivityStore.getState().logActivity(
        'loan_settled',
        `Loan with ${loan.personName} fully settled`,
        loanId,
        'loan'
      );
    }
  },

  getLoan: (id) => get().loans.find((l) => l.id === id),
}));
