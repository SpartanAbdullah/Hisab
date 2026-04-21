import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { activitiesDb } from '../lib/supabaseDb';
import type { ActivityLog, ActivityType } from '../db';

interface ActivityState {
  activities: ActivityLog[];
  loading: boolean;
  loadActivities: () => Promise<void>;
  logActivity: (type: ActivityType, description: string, entityId: string, entityType: string) => Promise<void>;
  getByEntity: (entityId: string) => Promise<ActivityLog[]>;
  reset: () => void;
}

const INITIAL_ACTIVITY_STATE = {
  activities: [] as ActivityLog[],
  loading: false,
};

export const useActivityStore = create<ActivityState>((set) => ({
  ...INITIAL_ACTIVITY_STATE,

  reset: () => set(INITIAL_ACTIVITY_STATE),

  loadActivities: async () => {
    set({ loading: true });
    const activities = await activitiesDb.getAll();
    set({ activities, loading: false });
  },

  logActivity: async (type, description, relatedEntityId, relatedEntityType) => {
    const entry: ActivityLog = {
      id: uuid(),
      type,
      description,
      relatedEntityId,
      relatedEntityType,
      timestamp: new Date().toISOString(),
    };
    await activitiesDb.add(entry);
    set((s) => ({ activities: [entry, ...s.activities].slice(0, 100) }));
  },

  getByEntity: async (entityId) => {
    return activitiesDb.getByEntity(entityId);
  },
}));
