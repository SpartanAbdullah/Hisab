import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { goalsDb } from '../lib/supabaseDb';
import type { Goal, Currency } from '../db';
import { useActivityStore } from './activityStore';

interface CreateGoalInput {
  title: string;
  targetAmount: number;
  currency: Currency;
  storedInAccountId: string; // empty string = internal tracking
}

interface GoalState {
  goals: Goal[];
  loading: boolean;
  loadGoals: () => Promise<void>;
  createGoal: (input: CreateGoalInput) => Promise<Goal>;
  addContribution: (goalId: string, amount: number) => Promise<void>;
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
    const goals = await goalsDb.getAll();
    set({ goals, loading: false });
  },

  createGoal: async (input) => {
    const goal: Goal = {
      id: uuid(),
      title: input.title,
      targetAmount: input.targetAmount,
      savedAmount: 0,
      currency: input.currency,
      storedInAccountId: input.storedInAccountId,
      createdAt: new Date().toISOString(),
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
    const newSaved = Math.round((goal.savedAmount + amount) * 100) / 100;
    await goalsDb.update(goalId, { savedAmount: newSaved });
    set((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount: newSaved } : g)),
    }));
  },

  getGoal: (id) => get().goals.find((g) => g.id === id),
}));
