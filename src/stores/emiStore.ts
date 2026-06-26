import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { emiSchedulesDb } from '../lib/supabaseDb';
import type { EmiSchedule, EmiStatus } from '../db';
import { addMonths, format } from 'date-fns';
import { useActivityStore } from './activityStore';
import { uncoveredToPaidIds } from '../lib/emiCoverage';

interface GenerateEmiInput {
  loanId: string;
  totalAmount: number;
  installments: number;
  startDate: string;
}

interface EmiState {
  schedules: EmiSchedule[];
  loading: boolean;
  loadSchedules: () => Promise<void>;
  generateSchedule: (input: GenerateEmiInput) => Promise<void>;
  markPaid: (emiId: string) => Promise<void>;
  markAllPaidForLoan: (loanId: string) => Promise<void>;
  // Reconcile-only: flip instalments already covered by money repaid (no money
  // moves). Returns how many it marked. Used to fix a schedule that desynced
  // from the loan's paid-down balance.
  reconcileCovered: (loanId: string, paidAmount: number) => Promise<number>;
  deleteByLoan: (loanId: string) => Promise<void>;
  getByLoan: (loanId: string) => EmiSchedule[];
  reset: () => void;
}

const INITIAL_EMI_STATE = {
  schedules: [] as EmiSchedule[],
  loading: false,
};

export const useEmiStore = create<EmiState>((set, get) => ({
  ...INITIAL_EMI_STATE,

  reset: () => set(INITIAL_EMI_STATE),

  loadSchedules: async () => {
    set({ loading: true });
    try {
      const schedules = await emiSchedulesDb.getAll();
      set({ schedules });
    } finally {
      set({ loading: false });
    }
  },

  generateSchedule: async (input) => {
    const emiAmount = Math.round((input.totalAmount / input.installments) * 100) / 100;
    const entries: EmiSchedule[] = [];
    const startDate = new Date(input.startDate);

    for (let i = 0; i < input.installments; i++) {
      entries.push({
        id: uuid(),
        loanId: input.loanId,
        installmentNumber: i + 1,
        dueDate: format(addMonths(startDate, i), 'yyyy-MM-dd'),
        amount: i === input.installments - 1
          ? Math.round((input.totalAmount - emiAmount * (input.installments - 1)) * 100) / 100
          : emiAmount,
        status: 'upcoming' as EmiStatus,
      });
    }
    await emiSchedulesDb.bulkAdd(entries);
    set((s) => ({ schedules: [...s.schedules, ...entries] }));
  },

  markPaid: async (emiId) => {
    await emiSchedulesDb.update(emiId, { status: 'paid' as EmiStatus });
    set((s) => ({
      schedules: s.schedules.map((e) => (e.id === emiId ? { ...e, status: 'paid' as EmiStatus } : e)),
    }));
    const emi = get().schedules.find((e) => e.id === emiId);
    if (emi) {
      await useActivityStore.getState().logActivity(
        'emi_paid',
        `EMI #${emi.installmentNumber} paid`,
        emi.loanId,
        'loan'
      );
    }
  },

  markAllPaidForLoan: async (loanId) => {
    const pendingSchedules = get().schedules.filter(
      (schedule) => schedule.loanId === loanId && schedule.status !== 'paid'
    );

    if (pendingSchedules.length === 0) return;

    await Promise.all(
      pendingSchedules.map((schedule) =>
        emiSchedulesDb.update(schedule.id, { status: 'paid' as EmiStatus })
      )
    );

    set((s) => ({
      schedules: s.schedules.map((schedule) =>
        schedule.loanId === loanId && schedule.status !== 'paid'
          ? { ...schedule, status: 'paid' as EmiStatus }
          : schedule
      ),
    }));

    await useActivityStore.getState().logActivity(
      'emi_paid',
      pendingSchedules.length === 1
        ? `EMI #${pendingSchedules[0].installmentNumber} paid`
        : `${pendingSchedules.length} EMIs marked paid after full repayment`,
      loanId,
      'loan'
    );
  },

  reconcileCovered: async (loanId, paidAmount) => {
    const ids = uncoveredToPaidIds(
      get().schedules.filter((e) => e.loanId === loanId),
      paidAmount,
    );
    if (ids.length === 0) return 0;
    const idSet = new Set(ids);
    await Promise.all(ids.map((id) => emiSchedulesDb.update(id, { status: 'paid' as EmiStatus })));
    set((s) => ({
      schedules: s.schedules.map((e) => (idSet.has(e.id) ? { ...e, status: 'paid' as EmiStatus } : e)),
    }));
    // Activity log is best-effort — the status is already persisted and a log
    // failure must not surface as a failed reconcile.
    try {
      await useActivityStore.getState().logActivity(
        'emi_paid',
        ids.length === 1
          ? 'Instalment reconciled to a payment already made'
          : `${ids.length} instalments reconciled to payments already made`,
        loanId,
        'loan',
      );
    } catch (err) {
      console.error('logActivity failed in reconcileCovered (non-fatal)', err);
    }
    return ids.length;
  },

  deleteByLoan: async (loanId) => {
    await emiSchedulesDb.deleteByLoan(loanId);
    set((s) => ({
      schedules: s.schedules.filter((schedule) => schedule.loanId !== loanId),
    }));
  },

  getByLoan: (loanId) => get().schedules.filter((e) => e.loanId === loanId).sort((a, b) => a.installmentNumber - b.installmentNumber),
}));
