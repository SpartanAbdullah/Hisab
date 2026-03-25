import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { ActivityLog, ActivityType } from '../db';

interface ActivityState {
  activities: ActivityLog[];
  loading: boolean;
  loadActivities: () => Promise<void>;
  logActivity: (type: ActivityType, description: string, entityId: string, entityType: string) => Promise<void>;
  getByEntity: (entityId: string) => Promise<ActivityLog[]>;
}

export const useActivityStore = create<ActivityState>((set) => ({
  activities: [],
  loading: false,

  loadActivities: async () => {
    set({ loading: true });
    const activities = await db.activityLog.orderBy('timestamp').reverse().limit(100).toArray();
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
    await db.activityLog.add(entry);
    set((s) => ({ activities: [entry, ...s.activities].slice(0, 100) }));
  },

  getByEntity: async (entityId) => {
    return db.activityLog.where('relatedEntityId').equals(entityId).reverse().sortBy('timestamp');
  },
}));
