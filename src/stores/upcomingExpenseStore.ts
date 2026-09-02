import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { upcomingExpensesDb } from '../lib/supabaseDb';
import type { UpcomingExpense, UpcomingExpenseStatus, Currency } from '../db';
import { reportError } from '../lib/errorReporter';

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
  reset: () => void;
}

const INITIAL_UPCOMING_EXPENSE_STATE = {
  expenses: [] as UpcomingExpense[],
  loading: false,
};

// Bill state changed → the Android reminder schedule may hold a stale
// "due today". Forced (the debounce must not swallow a pre-fire-time
// resolution); dynamic import avoids a store↔scheduler cycle; no-op on web.
function nudgeReminderSchedule(): void {
  void import('../lib/notificationScheduler')
    .then((m) => m.rescheduleNotifications({ force: true }))
    .catch((err) => {
      reportError(err, { feature: 'upcomingExpenseStore.nudgeReminderSchedule' });
    });
}

export const useUpcomingExpenseStore = create<UpcomingExpenseState>((set, get) => ({
  ...INITIAL_UPCOMING_EXPENSE_STATE,

  reset: () => set(INITIAL_UPCOMING_EXPENSE_STATE),

  loadExpenses: async () => {
    set({ loading: true });
    try {
      const expenses = await upcomingExpensesDb.getAll();
      set({ expenses });
    } finally {
      set({ loading: false });
    }
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
    nudgeReminderSchedule();
  },

  updateStatus: async (id, status) => {
    const isPaid = status === 'done';
    await upcomingExpensesDb.update(id, { status, isPaid });
    set((s) => ({
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, status, isPaid } : e)),
    }));
    nudgeReminderSchedule();
  },

  deleteExpense: async (id) => {
    await upcomingExpensesDb.delete(id);
    set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }));
    nudgeReminderSchedule();
  },

  getByAccount: (accountId) =>
    get().expenses.filter((e) => e.accountId === accountId && e.status === 'upcoming'),

  getUpcoming: () =>
    get()
      .expenses.filter((e) => e.status === 'upcoming')
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()),
}));
