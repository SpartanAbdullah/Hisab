import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
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
    const expenses = await db.upcomingExpenses.toArray();
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
    await db.upcomingExpenses.add(expense);
    set((s) => ({ expenses: [...s.expenses, expense] }));
    return expense;
  },

  markPaid: async (id) => {
    await db.upcomingExpenses.update(id, { isPaid: true, status: 'done' as UpcomingExpenseStatus });
    set((s) => ({
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, isPaid: true, status: 'done' as UpcomingExpenseStatus } : e)),
    }));
  },

  updateStatus: async (id, status) => {
    const isPaid = status === 'done';
    await db.upcomingExpenses.update(id, { status, isPaid });
    set((s) => ({
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, status, isPaid } : e)),
    }));
  },

  deleteExpense: async (id) => {
    await db.upcomingExpenses.delete(id);
    set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }));
  },

  getByAccount: (accountId) =>
    get().expenses.filter((e) => e.accountId === accountId && e.status === 'upcoming'),

  getUpcoming: () =>
    get()
      .expenses.filter((e) => e.status === 'upcoming')
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()),
}));
