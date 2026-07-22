import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { recurringTransactionsDb } from '../lib/supabaseDb';
import { validateRecurringStart } from '../lib/recurringStartValidation';
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
    // Server-of-last-resort: refuse an absurd start date (years off = a typo)
    // before it materialises retroactive entries. The modal handles the softer
    // "this is in the past" warning.
    const startCheck = validateRecurringStart(input.nextDueDate, new Date().toISOString().slice(0, 10));
    if (!startCheck.ok && startCheck.severity === 'block') {
      throw new Error(startCheck.reason ?? 'Pick a valid start date.');
    }
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
    // Compare-and-set: if another device already advanced this template,
    // don't advance it AGAIN (which would silently skip a month) — refresh
    // to the server's truth instead.
    const won = await recurringTransactionsDb.advanceIfDue(id, template.nextDueDate, next);
    if (!won) {
      await get().loadTemplates();
      return;
    }
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? { ...t, nextDueDate: next } : t)),
    }));
  },
}));

// Number of days in the given UTC month (month is 0-indexed). Day 0 of the
// *next* month is the last day of this one.
function daysInUTCMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// Adds one cadence unit to the given YYYY-MM-DD date string and returns the
// new YYYY-MM-DD. Day-anchored math (no time), so DST boundaries don't shift
// the date.
//
// Month/year steps CLAMP to the last valid day instead of overflowing: a
// subscription due Jan 31 advances to Feb 28, not "Mar 3" (JS Date's naive
// Feb-31→Mar-3 rollover, which silently skipped February entirely and drifted
// the due day forward every month). Subscriptions and rent cluster at month
// end, so this matters. Note: after clamping into a short month the anchor
// day is not restored (Jan 31 → Feb 28 → Mar 28); true "always the last day"
// / "always the 31st" semantics need a stored anchor day — a Phase 2 field.
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
    case 'monthly': {
      const day = base.getUTCDate();
      // Month-end anchoring: a due date sitting on the LAST day of its month
      // stays on the last day (Jan 31 → Feb 28 → Mar 31), instead of the old
      // permanent drift to the 28th after every short month. Mid-month days
      // clamp only when the target month is shorter.
      const wasMonthEnd = day === daysInUTCMonth(base.getUTCFullYear(), base.getUTCMonth());
      base.setUTCDate(1); // park on the 1st so the month step can't overflow
      base.setUTCMonth(base.getUTCMonth() + 1);
      const dim = daysInUTCMonth(base.getUTCFullYear(), base.getUTCMonth());
      base.setUTCDate(wasMonthEnd ? dim : Math.min(day, dim));
      break;
    }
    case 'yearly': {
      const day = base.getUTCDate();
      const month = base.getUTCMonth();
      base.setUTCDate(1); // park on the 1st so the year step can't overflow (Feb 29)
      base.setUTCFullYear(base.getUTCFullYear() + 1);
      base.setUTCDate(Math.min(day, daysInUTCMonth(base.getUTCFullYear(), month)));
      break;
    }
  }
  return base.toISOString().slice(0, 10);
}
