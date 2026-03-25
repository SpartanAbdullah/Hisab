import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { EmiSchedule, EmiStatus } from '../db';
import { addMonths, format } from 'date-fns';
import { useActivityStore } from './activityStore';

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
  getByLoan: (loanId: string) => EmiSchedule[];
}

export const useEmiStore = create<EmiState>((set, get) => ({
  schedules: [],
  loading: false,

  loadSchedules: async () => {
    set({ loading: true });
    const schedules = await db.emiSchedules.toArray();
    set({ schedules, loading: false });
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
    await db.emiSchedules.bulkAdd(entries);
    set((s) => ({ schedules: [...s.schedules, ...entries] }));
  },

  markPaid: async (emiId) => {
    await db.emiSchedules.update(emiId, { status: 'paid' });
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

  getByLoan: (loanId) => get().schedules.filter((e) => e.loanId === loanId).sort((a, b) => a.installmentNumber - b.installmentNumber),
}));
