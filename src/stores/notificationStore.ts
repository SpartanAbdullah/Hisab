import { create } from 'zustand';
import { notificationsDb, notificationPrefsDb } from '../lib/supabaseDb';
import { resetInstantNotify, surfaceNewNotifications } from '../lib/instantNotify';
import { countAttentionNotifications, type NotificationMuteState } from '../lib/notificationCounts';
import type { AppNotification } from '../db';
import { reportError } from '../lib/errorReporter';

/** The user's global quiet-hours window, mirrored from the `notification_prefs`
 *  global row (docs/notifications.md §3). Both null = no window configured. */
export interface QuietHoursState {
  start: number | null;
  end: number | null;
  tz: string;
}

const NO_QUIET_HOURS: QuietHoursState = { start: null, end: null, tz: 'Asia/Karachi' };

interface NotificationState {
  notifications: AppNotification[];
  loading: boolean;
  /** Unread items that actually need the reader. See notificationCounts.ts —
   *  self-caused rows and rows from muted groups are excluded (audit N-7). */
  unreadCount: number;
  /** The user's own mute preferences, mirrored from `notification_prefs`.
   *  Empty when the M5 migration is not applied yet — which reads as "nothing
   *  muted", i.e. the pre-M5 behaviour. */
  mutes: NotificationMuteState;
  /** Mirrors quiet_hours_start/_end/tz off the global prefs row. Read-only
   *  until an M5 migration is applied — then behaves as "no window". */
  quietHours: QuietHoursState;
  /** The global (group_id null) row's `muted` flag — same bit as
   *  `mutes.allMuted`, exposed under its own name so SettingsPage's
   *  "Pause all notifications" toggle (docs/notifications.md §8.2) doesn't
   *  need to reach into the mute-count shape used for badge counting. */
  globalMuted: boolean;
  loadNotifications: () => Promise<void>;
  loadPrefs: () => Promise<void>;
  setGroupMuted: (groupId: string, muted: boolean) => Promise<void>;
  /** Mute or unmute EVERYTHING (the global prefs row). In-app Inbox/bell keep
   *  writing and counting as normal — only push delivery stops; see the
   *  toggle copy in SettingsPage.tsx. */
  setGlobalMuted: (muted: boolean) => Promise<void>;
  setQuietHours: (start: number | null, end: number | null, tz?: string) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markGroupRead: (groupId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reset: () => void;
}

const INITIAL_NOTIFICATION_STATE = {
  notifications: [] as AppNotification[],
  loading: false,
  unreadCount: 0,
  mutes: {} as NotificationMuteState,
  quietHours: NO_QUIET_HOURS,
  globalMuted: false,
};

// Ids the user marked read locally this session. A realtime reload that races
// the write — or hits a read replica that hasn't caught up — must NOT resurrect
// a just-read notification as unread (the "counter stays at 1" bug). We force
// these read on every reload until sign-out clears the set.
const locallyRead = new Set<string>();

// The signed-in user id, kept here so the pure counter can drop rows this user
// caused themselves. Set on every load from the rows themselves: every row is
// addressed to its owner, so notifications[0].userId IS the current user. That
// avoids a store-to-store import (notificationStore is on the eager boot path;
// supabaseAuthStore is not something it should drag in).
let selfUserId: string | null = null;

function applyLocalReads(notifications: AppNotification[], nowIso: string): AppNotification[] {
  if (locallyRead.size === 0) return notifications;
  return notifications.map((n) =>
    !n.readAt && locallyRead.has(n.id) ? { ...n, readAt: nowIso } : n,
  );
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  ...INITIAL_NOTIFICATION_STATE,

  reset: () => {
    locallyRead.clear();
    selfUserId = null;
    resetInstantNotify();
    set(INITIAL_NOTIFICATION_STATE);
  },

  /** Mirror the user's notification_prefs rows. Best-effort: the accessor
   *  already swallows a missing table (migration applied by hand), and a
   *  failure here must never stop notifications from loading. */
  loadPrefs: async () => {
    try {
      const rows = await notificationPrefsDb.getAll();
      const mutes: NotificationMuteState = {
        allMuted: rows.some((r) => r.groupId === null && r.muted),
        mutedGroupIds: new Set(
          rows.filter((r) => r.muted && r.groupId).map((r) => r.groupId as string),
        ),
      };
      // Quiet hours live only on the global (group_id IS NULL) row.
      const globalRow = rows.find((r) => r.groupId === null);
      const quietHours: QuietHoursState = globalRow
        ? { start: globalRow.quietHoursStart, end: globalRow.quietHoursEnd, tz: globalRow.tz }
        : NO_QUIET_HOURS;
      set((state) => ({
        mutes,
        quietHours,
        globalMuted: mutes.allMuted ?? false,
        unreadCount: countAttentionNotifications(state.notifications, selfUserId, mutes),
      }));
    } catch (err) {
      reportError(err, { feature: 'notificationStore.loadPrefs' });
    }
  },

  setQuietHours: async (start, end, tz) => {
    const previous = get().quietHours;
    const zone = tz || previous.tz || (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Asia/Karachi'; }
    })();
    // Optimistic, same shape as setGroupMuted: the pickers must reflect the
    // choice instantly, and roll back if the write fails.
    set({ quietHours: { start, end, tz: zone } });
    try {
      await notificationPrefsDb.setQuietHours(start, end, zone);
    } catch (err) {
      set({ quietHours: previous });
      reportError(err, { feature: 'notificationStore.setQuietHours', extra: { start, end, tz: zone } });
      throw err;
    }
  },

  setGroupMuted: async (groupId, muted) => {
    // Optimistic: the toggle must register instantly, and the count that
    // drives the bell has to move with it.
    const previous = get().mutes;
    const ids = new Set(previous.mutedGroupIds ?? []);
    if (muted) ids.add(groupId); else ids.delete(groupId);
    const next: NotificationMuteState = { allMuted: previous.allMuted, mutedGroupIds: ids };
    set((state) => ({
      mutes: next,
      unreadCount: countAttentionNotifications(state.notifications, selfUserId, next),
    }));
    try {
      await notificationPrefsDb.setMuted(groupId, muted);
    } catch (err) {
      // Roll the optimistic toggle back — a mute that silently did not save
      // is worse than one that visibly failed.
      set((state) => ({
        mutes: previous,
        unreadCount: countAttentionNotifications(state.notifications, selfUserId, previous),
      }));
      reportError(err, { feature: 'notificationStore.setGroupMuted', extra: { groupId, muted } });
      throw err;
    }
  },

  setGlobalMuted: async (muted) => {
    // Optimistic, same shape as setGroupMuted: the switch must flip instantly
    // and roll back if the write fails. Updates both `globalMuted` (the
    // Settings toggle's own field) and `mutes.allMuted` (what the badge
    // counter and every per-group check actually read) together so they
    // never disagree mid-flight.
    const previousMutes = get().mutes;
    const previousGlobal = get().globalMuted;
    const nextMutes: NotificationMuteState = { ...previousMutes, allMuted: muted };
    set((state) => ({
      mutes: nextMutes,
      globalMuted: muted,
      unreadCount: countAttentionNotifications(state.notifications, selfUserId, nextMutes),
    }));
    try {
      await notificationPrefsDb.setMuted(null, muted);
    } catch (err) {
      set((state) => ({
        mutes: previousMutes,
        globalMuted: previousGlobal,
        unreadCount: countAttentionNotifications(state.notifications, selfUserId, previousMutes),
      }));
      reportError(err, { feature: 'notificationStore.setGlobalMuted', extra: { muted } });
      throw err;
    }
  },

  loadNotifications: async () => {
    set({ loading: true });
    try {
      const fetched = await notificationsDb.getAll();
      const notifications = applyLocalReads(fetched, new Date().toISOString());
      // Every row is addressed to its owner, so the first row names the
      // signed-in user. Keeps the previous value when the list is empty.
      selfUserId = notifications[0]?.userId ?? selfUserId;
      set((state) => ({
        notifications,
        // Audit N-7: only inbound, unread, non-muted items count. The old
        // `filter(n => !n.readAt).length` counted rows this user caused and
        // rows from groups they had muted.
        unreadCount: countAttentionNotifications(notifications, selfUserId, state.mutes),
      }));
      // Anything that arrived while the app was backgrounded becomes a real
      // tray notification here. Deliberately not awaited: the in-app list is
      // already updated above and must never wait on the OS bridge.
      void surfaceNewNotifications(notifications, get().mutes);
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
        unreadCount: countAttentionNotifications(notifications, selfUserId, state.mutes),
      };
    });
    try {
      await notificationsDb.markRead(id);
    } catch (err) {
      reportError(err, { feature: 'notificationStore.markRead', extra: { notificationId: id } });
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
        unreadCount: countAttentionNotifications(notifications, selfUserId, state.mutes),
      };
    });
    try {
      await notificationsDb.markGroupRead(groupId);
    } catch (err) {
      reportError(err, { feature: 'notificationStore.markGroupRead', extra: { groupId } });
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
      reportError(err, { feature: 'notificationStore.markAllRead' });
    }
  },
}));
