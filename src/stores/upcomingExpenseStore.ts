import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { upcomingExpensesDb } from '../lib/supabaseDb';
import type { UpcomingExpense, UpcomingExpenseStatus, Currency } from '../db';

interface CreateExpenseInput {
  title: string;
  amount: number;
  currency: Currency;
  dueDate: string;
  accountId: string;
  category: string;
  notes: string;
  reminderDaysBefore: number;
}

interface UpcomingExpenseState {
  expenses: UpcomingExpense[];
  loading: boolean;
  loadExpenses: () => Promise<void>;
  createExpense: (input: CreateExpenseInput) => Promise<UpcomingExpense>;
  markPaid: (id: string) => Promise<void>;
  updateStatus: (id: string, status: UpcomingExpenseStatus) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  getByAccount: (accountId: string) => UpcomingExpense[];
  getUpcoming: () => UpcomingExpense[];
}

export const useUpcomingExpenseStore = create<UpcomingExpenseState>((set, get) => ({
  expenses: [],
  loading: false,

  loadExpenses: async () => {
    set({ loading: true });
    const expenses = await upcomingExpensesDb.getAll();
    set({ expenses, loading: false });
  },

  createExpense: async (input) => {
    const expense: UpcomingExpense = {
      id: uuid(),
      title: input.title,
      amount: input.amount,
      currency: input.currency,
      dueDate: input.dueDate,
      accountId: input.accountId,
      category: input.category,
      notes: input.notes,
      isPaid: false,
      status: 'upcoming',
      reminderDaysBefore: input.reminderDaysBefore,
      createdAt: new Date().toISOString(),
    };
    await upcomingExpensesDb.add(expense);
    set((s) => ({ expenses: [...s.expenses, expense] }));
    return expense;
  },

  markPaid: async (id) => {
    await upcomingExpensesDb.update(id, { isPaid: true, status: 'done' as UpcomingExpenseStatus });
    set((s) => ({
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, isPaid: true, status: 'done' as UpcomingExpenseStatus } : e)),
    }));
  },

  updateStatus: async (id, status) => {
    const isPaid = status === 'done';
    await upcomingExpensesDb.update(id, { status, isPaid });
    set((s) => ({
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, status, isPaid } : e)),
    }));
  },

  deleteExpense: async (id) => {
    await upcomingExpensesDb.delete(id);
    set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }));
  },

  getByAccount: (accountId) =>
    get().expenses.filter((e) => e.accountId === accountId && e.status === 'upcoming'),

  getUpcoming: () =>
    get()
      .expenses.filter((e) => e.status === 'upcoming')
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()),
}));
