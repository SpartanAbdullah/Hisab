import { create } from 'zustand';
import { notificationsDb } from '../lib/supabaseDb';
import { resetInstantNotify, surfaceNewNotifications } from '../lib/instantNotify';
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

// Ids the user marked read locally this session. A realtime reload that races
// the write — or hits a read replica that hasn't caught up — must NOT resurrect
// a just-read notification as unread (the "counter stays at 1" bug). We force
// these read on every reload until sign-out clears the set.
const locallyRead = new Set<string>();

function applyLocalReads(notifications: AppNotification[], nowIso: string): AppNotification[] {
  if (locallyRead.size === 0) return notifications;
  return notifications.map((n) =>
    !n.readAt && locallyRead.has(n.id) ? { ...n, readAt: nowIso } : n,
  );
}

export const useNotificationStore = create<NotificationState>((set) => ({
  ...INITIAL_NOTIFICATION_STATE,

  reset: () => {
    locallyRead.clear();
    resetInstantNotify();
    set(INITIAL_NOTIFICATION_STATE);
  },

  loadNotifications: async () => {
    set({ loading: true });
    try {
      const fetched = await notificationsDb.getAll();
      const notifications = applyLocalReads(fetched, new Date().toISOString());
      set({
        notifications,
        unreadCount: notifications.filter(notification => !notification.readAt).length,
      });
      // Anything that arrived while the app was backgrounded becomes a real
      // tray notification here. Deliberately not awaited: the in-app list is
      // already updated above and must never wait on the OS bridge.
      void surfaceNewNotifications(notifications);
    } finally {
      set({ loading: false });
    }
  },

  markRead: async (id) => {
    // Optimistic-first: the tap registers instantly and can't be undone by a
    // racing reload. The network write is best-effort.
    locallyRead.add(id);
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
    try {
      await notificationsDb.markRead(id);
    } catch (err) {
      console.error('markRead failed (kept read locally)', err);
    }
  },

  markGroupRead: async (groupId) => {
    const readAt = new Date().toISOString();
    set((state) => {
      const notifications = state.notifications.map(notification => {
        if (notification.groupId === groupId && !notification.readAt) {
          locallyRead.add(notification.id);
          return { ...notification, readAt };
        }
        return notification;
      });
      return {
        notifications,
        unreadCount: notifications.filter(notification => !notification.readAt).length,
      };
    });
    try {
      await notificationsDb.markGroupRead(groupId);
    } catch (err) {
      console.error('markGroupRead failed (kept read locally)', err);
    }
  },

  markAllRead: async () => {
    const readAt = new Date().toISOString();
    set((state) => {
      state.notifications.forEach((n) => locallyRead.add(n.id));
      return {
        notifications: state.notifications.map(notification => ({ ...notification, readAt })),
        unreadCount: 0,
      };
    });
    try {
      await notificationsDb.markAllRead();
    } catch (err) {
      console.error('markAllRead failed (kept read locally)', err);
    }
  },
}));
