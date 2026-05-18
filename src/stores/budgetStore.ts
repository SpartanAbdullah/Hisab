import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { budgetsDb } from '../lib/supabaseDb';
import type { Budget, Currency, Transaction } from '../db';

interface CreateBudgetInput {
  category: string;
  monthlyAmount: number;
  currency: Currency;
  warnAtPercent?: number;
}

interface BudgetState {
  budgets: Budget[];
  loading: boolean;
  loadBudgets: () => Promise<void>;
  createBudget: (input: CreateBudgetInput) => Promise<Budget>;
  updateBudget: (id: string, changes: Partial<Budget>) => Promise<void>;
  deleteBudget: (id: string) => Promise<void>;
  reset: () => void;
}

const INITIAL_BUDGET_STATE = {
  budgets: [] as Budget[],
  loading: false,
};

export const useBudgetStore = create<BudgetState>((set) => ({
  ...INITIAL_BUDGET_STATE,

  reset: () => set(INITIAL_BUDGET_STATE),

  loadBudgets: async () => {
    set({ loading: true });
    try {
      const budgets = await budgetsDb.getAll();
      set({ budgets });
    } finally {
      set({ loading: false });
    }
  },

  createBudget: async (input) => {
    const budget: Budget = {
      id: uuid(),
      category: input.category.trim(),
      monthlyAmount: input.monthlyAmount,
      currency: input.currency,
      warnAtPercent: input.warnAtPercent ?? 80,
      createdAt: new Date().toISOString(),
    };
    await budgetsDb.add(budget);
    set((s) => ({ budgets: [...s.budgets, budget].sort((a, b) => a.category.localeCompare(b.category)) }));
    return budget;
  },

  updateBudget: async (id, changes) => {
    await budgetsDb.update(id, changes);
    set((s) => ({
      budgets: s.budgets.map((b) => (b.id === id ? { ...b, ...changes } : b)),
    }));
  },

  deleteBudget: async (id) => {
    await budgetsDb.delete(id);
    set((s) => ({ budgets: s.budgets.filter((b) => b.id !== id) }));
  },
}));

// ── Usage computation helpers ──

export interface BudgetUsage {
  budget: Budget;
  spent: number;       // sum of expenses in matching category + currency this month
  remaining: number;   // monthlyAmount - spent (can be negative when over)
  percent: number;     // 0..>100, capped only at render time
  overWarn: boolean;   // crossed warnAtPercent
  overLimit: boolean;  // spent >= monthlyAmount
}

// Computes usage for every budget against this month's expense transactions.
// Pure function — accepts the data so unit tests can pass fixtures. Currency
// match is strict; a Groceries-AED budget does NOT capture Groceries-PKR
// transactions (they live on different ledgers conceptually).
export function computeBudgetUsages(
  budgets: readonly Budget[],
  transactions: readonly Transaction[],
  asOf: Date = new Date(),
): BudgetUsage[] {
  const monthStart = new Date(asOf.getFullYear(), asOf.getMonth(), 1).getTime();
  const monthEnd = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1).getTime();
  // Bucket once: expense + within month + category lowercased for case-insensitive
  // match (UI categories are sometimes capitalised inconsistently).
  const bucket = new Map<string, number>();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const ts = new Date(t.createdAt).getTime();
    if (ts < monthStart || ts >= monthEnd) continue;
    const key = `${(t.category ?? '').toLowerCase()}::${t.currency}`;
    bucket.set(key, (bucket.get(key) ?? 0) + t.amount);
  }
  return budgets.map((budget) => {
    const key = `${budget.category.toLowerCase()}::${budget.currency}`;
    const spent = bucket.get(key) ?? 0;
    const remaining = budget.monthlyAmount - spent;
    const percent = budget.monthlyAmount > 0 ? (spent / budget.monthlyAmount) * 100 : 0;
    return {
      budget,
      spent: Math.round(spent * 100) / 100,
      remaining: Math.round(remaining * 100) / 100,
      percent: Math.round(percent * 10) / 10,
      overWarn: percent >= budget.warnAtPercent,
      overLimit: spent >= budget.monthlyAmount,
    };
  });
}
