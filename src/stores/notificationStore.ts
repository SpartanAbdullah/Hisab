import { create } from 'zustand';
import { NOTIFICATION_UNREAD_CAP, notificationsDb, notificationPrefsDb } from '../lib/supabaseDb';
import { primeInstantNotify, resetInstantNotify, surfaceNewNotifications } from '../lib/instantNotify';
import {
  countAttentionNotifications,
  isRequestMirrorNotification,
  staleMirrorNotificationIds,
  type NotificationMuteState,
} from '../lib/notificationCounts';
import {
  DEFAULT_LIST_PAGE_SIZE,
  cursorAfter,
  hasMoreRows,
  mergeNewestFirst,
  type KeysetCursor,
} from '../lib/listPaging';
import type { AppNotification } from '../db';
import { reportError } from '../lib/errorReporter';

/** Rows per page. See `src/lib/listPaging.ts` for why 15. */
const NOTIFICATION_PAGE_SIZE = DEFAULT_LIST_PAGE_SIZE;

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
  /**
   * Exact number of notification rows this user owns on the server, from the
   * `count: 'exact'` that rides along with the first page. `null` until a load
   * has resolved. This is the "M" of "Showing N of M".
   */
  notificationsTotal: number | null;
  /** The server holds rows this store does not — "Load more" has work to do. */
  hasMoreNotifications: boolean;
  /** A `loadMoreNotifications` fetch is in flight. */
  loadingMoreNotifications: boolean;
  loadNotifications: () => Promise<void>;
  /**
   * Fetch the next page of OLDER rows and merge them in. Never replaces, never
   * re-orders what is already held, and deliberately does not re-run the tray
   * surfacing — a row the user is scrolling back to is not news.
   */
  loadMoreNotifications: () => Promise<void>;
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
  /**
   * Retire `linked_request` / `linked_settlement` pings whose request is no
   * longer pending. Runs itself after every load; safe to call directly.
   */
  reconcileRequestMirrors: () => Promise<void>;
  reset: () => void;
}

const INITIAL_NOTIFICATION_STATE = {
  notifications: [] as AppNotification[],
  loading: false,
  unreadCount: 0,
  mutes: {} as NotificationMuteState,
  quietHours: NO_QUIET_HOURS,
  globalMuted: false,
  notificationsTotal: null as number | null,
  hasMoreNotifications: false,
  loadingMoreNotifications: false,
};

// Where the NEXT page of older rows starts. A module variable, not state, for
// the same reason the render window on TransactionsPage is: it describes how
// far the paging walk has got, and it must survive every re-render and every
// realtime reload. `loadNotifications` deliberately does NOT reset it — a
// refresh that arrives while the user is five pages deep must add rows at the
// top, not throw away the four pages they asked for (founder request, point 4).
let pageCursor: KeysetCursor | null = null;

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
    // A user switch must not let the next account inherit a cursor into the
    // previous account's table.
    pageCursor = null;
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

  /**
   * The default load: the newest page PLUS every unread row.
   *
   * It used to be one flat `limit(100)` fetched on boot, on every realtime
   * nudge and on every resume-refresh, with all 100 rendered (founder request
   * 2026-09-03). It is now two small queries issued in PARALLEL — one latency,
   * not two — and the split is what makes paging safe:
   *
   *   * the PAGE bounds what is rendered (15 rows);
   *   * the UNREAD set is complete, so `countAttentionNotifications` — which
   *     this store does not change, and which the bell badge, the Inbox "Info"
   *     tab and the SplitsPage group dots all read through — still counts every
   *     unread row. It sees strictly more than the old 100-row cap did.
   *
   * Rows already held are MERGED, never replaced, so a refresh that lands while
   * the user is several pages deep adds at the top and keeps their position.
   */
  loadNotifications: async () => {
    set({ loading: true });
    try {
      const [page, unread] = await Promise.all([
        notificationsDb.getPage({ limit: NOTIFICATION_PAGE_SIZE }),
        notificationsDb.getUnread(),
      ]);
      const nowIso = new Date().toISOString();
      const fetched = applyLocalReads(mergeNewestFirst(page.rows, unread), nowIso);
      // Every row is addressed to its owner, so the first row names the
      // signed-in user. Keeps the previous value when the list is empty.
      selfUserId = fetched[0]?.userId ?? selfUserId;

      // The unread fetch is AUTHORITATIVE for unread-ness. A row we hold that
      // came back in neither result was read somewhere else (another device,
      // another tab) and must stop counting here too — otherwise a merge-only
      // reload would pin the badge at a number the user can never clear.
      //
      // Restricted to rows OUTSIDE the newest page on purpose: the two queries
      // run in parallel, so a row inserted between them can legitimately be in
      // the page and not in the unread snapshot. The page is authoritative for
      // its own rows. And the reconcile is skipped entirely if the unread read
      // hit its cap, where "not in the set" would stop meaning "read".
      const pageIds = new Set(page.rows.map((n) => n.id));
      const unreadIds = new Set(unread.map((n) => n.id));
      const unreadComplete = unread.length < NOTIFICATION_UNREAD_CAP;

      set((state) => {
        const merged = mergeNewestFirst(state.notifications, fetched);
        const notifications = unreadComplete
          ? merged.map((n) =>
              n.readAt || pageIds.has(n.id) || unreadIds.has(n.id) ? n : { ...n, readAt: nowIso },
            )
          : merged;
        return {
          notifications,
          notificationsTotal: page.total,
          hasMoreNotifications: hasMoreRows({
            loaded: notifications.length,
            total: page.total,
            lastPageSize: page.rows.length,
            pageSize: NOTIFICATION_PAGE_SIZE,
          }),
          // Audit N-7: only inbound, unread, non-muted items count. The old
          // `filter(n => !n.readAt).length` counted rows this user caused and
          // rows from groups they had muted. The PREDICATE IS UNCHANGED by the
          // paging work — only the set it runs over changed, and that set still
          // provably contains every unread row (see `notificationsDb.getUnread`).
          unreadCount: countAttentionNotifications(notifications, selfUserId, state.mutes),
        };
      });
      // The first page defines where paging continues from. Set once: a later
      // refresh must not rewind a user who has already loaded older pages.
      if (!pageCursor) pageCursor = cursorAfter(page.rows);
      // Anything that arrived while the app was backgrounded becomes a real
      // tray notification here. Deliberately not awaited: the in-app list is
      // already updated above and must never wait on the OS bridge.
      void surfaceNewNotifications(get().notifications, get().mutes);
      // Retire request pings whose request is already resolved. Un-awaited for
      // the same reason: the list is rendered, and this only ever REMOVES an
      // unread flag — it can never hold up a load or change what was shown.
      void get().reconcileRequestMirrors();
    } finally {
      set({ loading: false });
    }
  },

  loadMoreNotifications: async () => {
    const { loadingMoreNotifications, hasMoreNotifications } = get();
    if (loadingMoreNotifications || !hasMoreNotifications) return;
    const before = pageCursor;
    if (!before) return;
    set({ loadingMoreNotifications: true });
    try {
      const page = await notificationsDb.getPage({ limit: NOTIFICATION_PAGE_SIZE, before });
      const rows = applyLocalReads(page.rows, new Date().toISOString());
      // Older rows are history, not news: mark them seen so the tray surfacing
      // can never mistake a page the user scrolled back to for fresh arrivals.
      primeInstantNotify(page.rows);
      // Only advance on a page that actually returned something — a cursor
      // rebuilt from an empty page would be null and strand the walk.
      const next = cursorAfter(page.rows);
      if (next) pageCursor = next;
      set((state) => {
        const notifications = mergeNewestFirst(state.notifications, rows);
        return {
          notifications,
          // An EMPTY page is the end of the table, full stop — that beats the
          // row count, which can read stale-high for a moment after a row is
          // deleted elsewhere and would otherwise leave a button that does
          // nothing when tapped.
          hasMoreNotifications:
            page.rows.length === 0
              ? false
              : hasMoreRows({
                  loaded: notifications.length,
                  total: state.notificationsTotal,
                  lastPageSize: page.rows.length,
                  pageSize: NOTIFICATION_PAGE_SIZE,
                }),
          unreadCount: countAttentionNotifications(notifications, selfUserId, state.mutes),
        };
      });
    } catch (err) {
      reportError(err, { feature: 'notificationStore.loadMoreNotifications' });
    } finally {
      set({ loadingMoreNotifications: false });
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

  /**
   * Retire stale request mirrors.
   *
   * Production, the founder's account: 38 unread `linked_request` + 35 unread
   * `linked_settlement` rows against ZERO pending incoming requests. Those
   * pings are dead — the Inbox card each one refers to is resolved and gone,
   * the Info tab excludes mirrors, so NOTHING the user can do clears them, and
   * `unreadCount` (the Activity tab's number) stays wrong forever. Same family
   * as the "counter stays at 1" bug, 73 rows deep.
   *
   * The predicate is pure and tested (`staleMirrorNotificationIds`). This part
   * is the plumbing:
   *   - the two request stores are imported DYNAMICALLY. notificationStore is
   *     on the eager boot path and must not statically drag the loan/
   *     transaction/person/account graph behind linkedRequestStore into it;
   *   - idempotent: rows already read locally are skipped, the write carries
   *     `is('read_at', null)`, and a second run finds nothing to do;
   *   - batched: one UPDATE ... WHERE id IN (…) for the whole set;
   *   - mode-independent: linked requests and settlements exist in
   *     `splits_only` exactly as in full tracker, and nothing here touches an
   *     account, so both modes reconcile identically;
   *   - non-fatal: a failure leaves the rows unread and reports, it never
   *     breaks a load.
   *
   * Server-side follow-up (NOT done here, no migration written): the accept /
   * reject / cancel RPCs should stamp `read_at` on the matching mirror rows in
   * the same transaction, which would make this client pass unnecessary for
   * rows created from then on. See the report.
   */
  reconcileRequestMirrors: async () => {
    try {
      const userId = selfUserId;
      if (!userId) return;
      const notifications = get().notifications;
      // Cheap gate first: no unread mirrors ⇒ nothing to reconcile, and no
      // store is touched. This is the path almost every load takes.
      const mirrors = notifications.filter((n) => !n.readAt && isRequestMirrorNotification(n));
      if (mirrors.length === 0) return;

      const [{ useLinkedRequestStore }, { useSettlementRequestStore }] = await Promise.all([
        import('./linkedRequestStore'),
        import('./settlementRequestStore'),
      ]);
      const linked = useLinkedRequestStore.getState();
      const settlement = useSettlementRequestStore.getState();
      // A load in flight would hand us a half-truth; the next notification
      // load reconciles instead.
      if (linked.loading || settlement.loading) return;

      // THE RACE THIS GUARDS: boot fires the request loads and the
      // notification load in parallel (App.tsx), and an empty `requests` array
      // is indistinguishable from "nothing pending" — which would mark a LIVE
      // request's ping read. But holding an unread mirror of a kind PROVES the
      // user has at least one request row of that kind, so an empty store here
      // is proof of staleness, not of emptiness. Load it, then judge.
      const needLinked = mirrors.some((n) => n.type === 'linked_request') && linked.requests.length === 0;
      const needSettlement = mirrors.some((n) => n.type === 'linked_settlement') && settlement.requests.length === 0;
      if (needLinked || needSettlement) {
        await Promise.all([
          needLinked ? linked.loadRequests() : Promise.resolve(),
          needSettlement ? settlement.loadRequests() : Promise.resolve(),
        ]);
      }

      const ids = staleMirrorNotificationIds({
        notifications,
        linkedRequests: useLinkedRequestStore.getState().requests,
        settlementRequests: useSettlementRequestStore.getState().requests,
        userId,
      }).filter((id) => !locallyRead.has(id));
      if (ids.length === 0) return;
      const stale = new Set(ids);
      const readAt = new Date().toISOString();
      ids.forEach((id) => locallyRead.add(id));
      set((state) => {
        const next = state.notifications.map((n) =>
          stale.has(n.id) && !n.readAt ? { ...n, readAt } : n,
        );
        return {
          notifications: next,
          unreadCount: countAttentionNotifications(next, selfUserId, state.mutes),
        };
      });
      await notificationsDb.markManyRead(ids);
    } catch (err) {
      reportError(err, { feature: 'notificationStore.reconcileRequestMirrors' });
    }
  },
}));
