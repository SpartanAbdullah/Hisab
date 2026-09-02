// Turns a freshly-arrived server notification into a real Android tray
// notification, immediately.
//
// Why this exists: Hisaab's only delivery channel used to be the in-app
// list. A backgrounded app therefore "notified" nobody — the user found out
// when they next opened it. FCM (see pushRegistration.ts) covers the case
// where Android has killed the process; this covers the far more common one
// where the app is merely in the background and its realtime socket is still
// alive. Between them the "I had to close and reopen the app" gap closes.
//
// Rules that keep it from becoming noise:
//   • Only fires when the app is NOT the thing the user is looking at.
//     A tray notification for a row they can already see is spam.
//   • Only unread, only recent — a cold boot must never dump three days of
//     history into the tray. The first load PRIMES the seen-set silently.
//   • Ids are derived from the notification row id, so the same row can
//     never surface twice (reloads, reconnects, multi-tab).
//   • Fires with no `schedule`, so it is delivered rather than pending —
//     notificationScheduler's cancel-all-pending sweep can't eat it.
import { isNativeRuntime } from './runtime';
import { notificationHref, renderNotificationContent } from './notificationContent';
import { tStatic } from './i18n';
import type { AppNotification } from '../db';

// FNV-1a 32-bit, kept positive and under Android's int32 notification-id
// ceiling. Deliberately a local copy rather than an import of the planner's
// identical helper: notificationStore imports THIS module, and reaching into
// notificationPlanner would drag its whole dependency graph (card statements,
// committee math, budget store) into the eager boot chunk on web, where none
// of it is ever used.
function androidNotificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483646 + 1;
}

// Anything older than this was already missed by other means; surfacing it
// now would be archaeology, not a notification.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A single reconnect can deliver a small burst. More than this and we are
// almost certainly replaying history, so stay quiet.
const MAX_PER_BATCH = 3;

const seen = new Set<string>();
let primed = false;

/** True when the user cannot currently see the app. On Capacitor the
 *  WebView's document goes hidden as the activity backgrounds, so this is
 *  the same signal on web and native. */
function appIsHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden';
}

/** Mark everything currently known as already-surfaced without notifying.
 *  Called on the first load of a session so boot is silent. */
export function primeInstantNotify(notifications: AppNotification[]): void {
  for (const n of notifications) seen.add(n.id);
  primed = true;
}

/** Forget the seen-set. Sign-out only — the next user's first load primes
 *  again from scratch. */
export function resetInstantNotify(): void {
  seen.clear();
  primed = false;
}

/** Surface anything in `notifications` that we have not surfaced before.
 *  Safe to call on every load; no-op on web and while the app is visible. */
export async function surfaceNewNotifications(notifications: AppNotification[]): Promise<void> {
  if (!primed) {
    primeInstantNotify(notifications);
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh: AppNotification[] = [];
  for (const n of notifications) {
    if (seen.has(n.id)) continue;
    // Mark seen REGARDLESS of whether we end up showing it. A notification
    // skipped because the app was open must not pop the moment it hides.
    seen.add(n.id);
    if (n.readAt) continue;
    const at = new Date(n.createdAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    fresh.push(n);
  }

  if (fresh.length === 0) return;
  if (!isNativeRuntime()) return;
  if (!appIsHidden()) return;
  if (fresh.length > MAX_PER_BATCH) return;

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return;
    await LocalNotifications.schedule({
      notifications: fresh.map((n) => {
        // Render template+params through i18n so a tray notification arrives
        // in the reader's language, not the sender's (audit N-1). Rows without
        // a template fall back to the server-composed text.
        const content = renderNotificationContent(n, tStatic);
        return {
          id: androidNotificationId(`instant:${n.id}`),
          title: content.title || 'Hisaab',
          body: content.body,
          // Deep-links group rows to the group itself instead of dumping the
          // user at the top of /groups to hunt (audit N-8).
          extra: { href: notificationHref(n) },
          smallIcon: 'ic_stat_hisaab',
        };
      }),
    });
  } catch (err) {
    // Delivery is best-effort by design: the in-app list is the source of
    // truth and has already been updated by the caller.
    console.error('[instantNotify] surface failed (non-fatal)', err);
  }
}
