import { create } from 'zustand';
import { notificationsDb } from '../lib/supabaseDb';
import type { AppNotification } from '../db';

interface NotificationState {
  notifications: AppNotification[];
  loading: boolean;
  unreadCount: number;
  loadNotifications: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markGroupRead: (groupId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reset: () => void;
}

const INITIAL_NOTIFICATION_STATE = {
  notifications: [] as AppNotification[],
  loading: false,
  unreadCount: 0,
};

export const useNotificationStore = create<NotificationState>((set) => ({
  ...INITIAL_NOTIFICATION_STATE,

  reset: () => set(INITIAL_NOTIFICATION_STATE),

  loadNotifications: async () => {
    set({ loading: true });
    try {
      const notifications = await notificationsDb.getAll();
      set({
        notifications,
        unreadCount: notifications.filter(notification => !notification.readAt).length,
      });
    } finally {
      set({ loading: false });
    }
  },

  markRead: async (id) => {
    await notificationsDb.markRead(id);
    const readAt = new Date().toISOString();
    set((state) => {
      const notifications = state.notifications.map(notification =>
        notification.id === id ? { ...notification, readAt } : notification,
      );
      return {
        notifications,
        unreadCount: notifications.filter(notification => !notification.readAt).length,
      };
    });
  },

  markGroupRead: async (groupId) => {
    await notificationsDb.markGroupRead(groupId);
    const readAt = new Date().toISOString();
    set((state) => {
      const notifications = state.notifications.map(notification =>
        notification.groupId === groupId && !notification.readAt ? { ...notification, readAt } : notification,
      );
      return {
        notifications,
        unreadCount: notifications.filter(notification => !notification.readAt).length,
      };
    });
  },

  markAllRead: async () => {
    await notificationsDb.markAllRead();
    const readAt = new Date().toISOString();
    set((state) => ({
      notifications: state.notifications.map(notification => ({ ...notification, readAt })),
      unreadCount: 0,
    }));
  },
}));
