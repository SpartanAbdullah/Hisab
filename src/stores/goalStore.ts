import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { goalsDb } from '../lib/supabaseDb';
import type { Goal, Currency } from '../db';
import { useActivityStore } from './activityStore';

interface CreateGoalInput {
  title: string;
  targetAmount: number;
  currency: Currency;
  storedInAccountId?: string; // optional label; '' = tracked internally
  targetDate?: string | null; // optional YYYY-MM-DD deadline
}

interface GoalState {
  goals: Goal[];
  loading: boolean;
  loadGoals: () => Promise<void>;
  createGoal: (input: CreateGoalInput) => Promise<Goal>;
  addContribution: (goalId: string, amount: number) => Promise<void>;
  // Fix a mis-typed goal: title/target/deadline any time; currency only while
  // nothing is saved (contributed figures are stored in the goal's currency).
  updateGoal: (goalId: string, changes: Partial<Pick<Goal, 'title' | 'targetAmount' | 'targetDate' | 'currency' | 'storedInAccountId'>>) => Promise<void>;
  // Set savedAmount to a known-true figure — record-only, no balances move.
  // The repair for over-typed direct adds and storedIn-account drift.
  correctSavedAmount: (goalId: string, target: number) => Promise<void>;
  deleteGoal: (goalId: string) => Promise<void>;
  getGoal: (id: string) => Goal | undefined;
  reset: () => void;
}

const INITIAL_GOAL_STATE = {
  goals: [] as Goal[],
  loading: false,
};

export const useGoalStore = create<GoalState>((set, get) => ({
  ...INITIAL_GOAL_STATE,

  reset: () => set(INITIAL_GOAL_STATE),

  loadGoals: async () => {
    set({ loading: true });
    try {
      const goals = await goalsDb.getAll();
      set({ goals });
    } finally {
      set({ loading: false });
    }
  },

  createGoal: async (input) => {
    const goal: Goal = {
      id: uuid(),
      title: input.title,
      targetAmount: input.targetAmount,
      savedAmount: 0,
      currency: input.currency,
      storedInAccountId: input.storedInAccountId ?? '',
      createdAt: new Date().toISOString(),
      targetDate: input.targetDate ?? null,
    };
    await goalsDb.add(goal);
    set((s) => ({ goals: [...s.goals, goal] }));
    await useActivityStore.getState().logActivity(
      'goal_created',
      `Created savings goal "${input.title}" — target: ${input.currency} ${input.targetAmount}`,
      goal.id,
      'goal'
    );
    return goal;
  },

  addContribution: async (goalId, amount) => {
    const goal = get().goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    // Clamp at 0 — a "take out" can never push the saved total negative.
    const newSaved = Math.max(0, Math.round((goal.savedAmount + amount) * 100) / 100);
    await goalsDb.update(goalId, { savedAmount: newSaved });
    set((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount: newSaved } : g)),
    }));
  },

  updateGoal: async (goalId, changes) => {
    const goal = get().goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    if (
      changes.currency !== undefined &&
      changes.currency !== goal.currency &&
      goal.savedAmount > 0.005
    ) {
      // Saved figures are stored in the goal's currency — changing it under
      // them would silently reinterpret the number.
      throw new Error('Currency can only change while nothing is saved yet');
    }
    await goalsDb.update(goalId, changes);
    set((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, ...changes } : g)),
    }));
  },

  correctSavedAmount: async (goalId, target) => {
    const goal = get().goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    const newSaved = Math.max(0, Math.round(target * 100) / 100);
    await goalsDb.update(goalId, { savedAmount: newSaved });
    set((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount: newSaved } : g)),
    }));
    try {
      await useActivityStore.getState().logActivity(
        'goal_contribution',
        `Corrected "${goal.title}" saved amount: ${goal.currency} ${goal.savedAmount} → ${goal.currency} ${newSaved}`,
        goalId,
        'goal',
      );
    } catch (err) {
      console.error('logActivity failed in correctSavedAmount (non-fatal)', err);
    }
  },

  deleteGoal: async (goalId) => {
    const goal = get().goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    // History rows keep their relatedGoalId (labels degrade gracefully) and
    // no balances move — deleting a goal is bookkeeping, not money.
    await goalsDb.delete(goalId);
    set((s) => ({ goals: s.goals.filter((g) => g.id !== goalId) }));
    try {
      await useActivityStore.getState().logActivity(
        'goal_created',
        `Deleted savings goal "${goal.title}"`,
        goalId,
        'goal',
      );
    } catch (err) {
      console.error('logActivity failed in deleteGoal (non-fatal)', err);
    }
  },

  getGoal: (id) => get().goals.find((g) => g.id === id),
}));
