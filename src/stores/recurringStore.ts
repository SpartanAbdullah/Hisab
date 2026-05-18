import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { recurringTransactionsDb } from '../lib/supabaseDb';
import type { RecurringTransaction, RecurringCadence, Currency } from '../db';

interface CreateInput {
  type: RecurringTransaction['type'];
  amount: number;
  currency: Currency;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  category: string;
  notes: string;
  cadence: RecurringCadence;
  nextDueDate: string;
  label: string;
}

interface RecurringState {
  templates: RecurringTransaction[];
  loading: boolean;
  loadTemplates: () => Promise<void>;
  createTemplate: (input: CreateInput) => Promise<RecurringTransaction>;
  updateTemplate: (id: string, changes: Partial<RecurringTransaction>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  // Used by the runner after a template materialises into a real Transaction.
  // Advances nextDueDate by the template's cadence and persists.
  advanceTemplate: (id: string) => Promise<void>;
  reset: () => void;
}

const INITIAL = { templates: [] as RecurringTransaction[], loading: false };

export const useRecurringStore = create<RecurringState>((set, get) => ({
  ...INITIAL,
  reset: () => set(INITIAL),

  loadTemplates: async () => {
    set({ loading: true });
    try {
      const templates = await recurringTransactionsDb.getAll();
      set({ templates });
    } finally {
      set({ loading: false });
    }
  },

  createTemplate: async (input) => {
    const t: RecurringTransaction = {
      id: uuid(),
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      sourceAccountId: input.sourceAccountId,
      destinationAccountId: input.destinationAccountId,
      category: input.category,
      notes: input.notes,
      cadence: input.cadence,
      nextDueDate: input.nextDueDate,
      active: true,
      label: input.label || input.category,
      createdAt: new Date().toISOString(),
    };
    await recurringTransactionsDb.add(t);
    set((s) => ({ templates: [...s.templates, t] }));
    return t;
  },

  updateTemplate: async (id, changes) => {
    await recurringTransactionsDb.update(id, changes);
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? { ...t, ...changes } : t)),
    }));
  },

  deleteTemplate: async (id) => {
    await recurringTransactionsDb.delete(id);
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
  },

  advanceTemplate: async (id) => {
    const template = get().templates.find((t) => t.id === id);
    if (!template) return;
    const next = advanceDate(template.nextDueDate, template.cadence);
    await recurringTransactionsDb.update(id, { nextDueDate: next });
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? { ...t, nextDueDate: next } : t)),
    }));
  },
}));

// Adds one cadence unit to the given YYYY-MM-DD date string and returns the
// new YYYY-MM-DD. Day-anchored math (no time), so DST boundaries don't shift
// the date.
export function advanceDate(yyyyMmDd: string, cadence: RecurringCadence): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const base = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  switch (cadence) {
    case 'daily':
      base.setUTCDate(base.getUTCDate() + 1);
      break;
    case 'weekly':
      base.setUTCDate(base.getUTCDate() + 7);
      break;
    case 'monthly':
      base.setUTCMonth(base.getUTCMonth() + 1);
      break;
    case 'yearly':
      base.setUTCFullYear(base.getUTCFullYear() + 1);
      break;
  }
  return base.toISOString().slice(0, 10);
}
