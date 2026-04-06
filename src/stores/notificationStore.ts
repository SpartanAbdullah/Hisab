import { create } from 'zustand';
import { notificationsDb } from '../lib/supabaseDb';
import type { AppNotification } from '../db';

interface NotificationState {
  notifications: AppNotification[];
  loading: boolean;
  unreadCount: number;
  loadNotifications: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  loading: false,
  unreadCount: 0,

  loadNotifications: async () => {
    set({ loading: true });
    const notifications = await notificationsDb.getAll();
    set({
      notifications,
      loading: false,
      unreadCount: notifications.filter(notification => !notification.readAt).length,
    });
  },

  markRead: async (id) => {
    await notificationsDb.markRead(id);
    set((state) => {
      const notifications = state.notifications.map(notification =>
        notification.id === id ? { ...notification, readAt: new Date().toISOString() } : notification,
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
