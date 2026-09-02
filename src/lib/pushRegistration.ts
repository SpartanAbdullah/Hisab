// Firebase Cloud Messaging registration for the Android wrapper.
//
// This is the half of push delivery that survives the app being KILLED.
// instantNotify.ts covers the still-running-in-background case over the
// realtime socket; FCM covers everything else, because the OS wakes the app
// to deliver rather than relying on our websocket.
//
// The whole module is defensive by design: an Android build with no
// google-services.json has no FCM at all, and registration will simply
// throw. That must never break sign-in, so every failure is logged and
// swallowed — the app degrades to in-app + instant notifications, exactly
// as it behaves today.
//
// Setup (Firebase project, google-services.json, Edge Function secret):
// see docs/push-notifications-setup.md.
import { isNativeRuntime } from './runtime';
import { pushTokensDb } from './supabaseDb';
import { refreshLiveData } from './realtime';
import { tStatic } from './i18n';
import { notificationChannelDefs } from './notificationContent';
import { track } from './telemetry';

type NavigateFn = (to: string) => void;

// Kept so sign-out can delete the row — otherwise the next person to sign
// in on this phone would keep receiving the previous user's notifications.
//
// Audit 2026-09 M5: the in-memory copy alone is not enough. FCM only re-fires
// `registration` after a successful register() round-trip, so a user who
// launches the app offline (or never grants notification permission again)
// and signs out has `currentToken === null` and the device_push_tokens row
// survives forever. Mirroring the token into localStorage makes the cleanup
// survive an app restart. The key is user-scoped and is swept by
// resetAllUserStores(); we also delete it ourselves once unregistered.
export const PUSH_TOKEN_KEY = 'hisaab_push_token';
let currentToken: string | null = null;
let listenersAttached = false;
let starting = false;

function rememberToken(token: string): void {
  currentToken = token;
  try {
    localStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch { /* storage disabled — in-memory copy still covers this session */ }
}

function forgetToken(): string | null {
  let token = currentToken;
  currentToken = null;
  try {
    token = token ?? localStorage.getItem(PUSH_TOKEN_KEY);
    localStorage.removeItem(PUSH_TOKEN_KEY);
  } catch { /* storage disabled — fall back to whatever memory held */ }
  return token;
}

/** Where a push payload should land.
 *
 *  The Edge Function now forwards an explicit `href` computed server-side by
 *  notification_href_for() (supabase-migration-p2-notification-maturity.sql
 *  §3), which is how a "Ali added an expense in Flat 12" push finally opens
 *  Flat 12 instead of the top of /groups (audit 08-notifications.md N-8).
 *
 *  The `type` switch survives as the fallback for pushes sent by a database
 *  that has not applied that migration yet — migrations are applied by hand
 *  (CLAUDE.md), so old and new payloads coexist for a while. */
function hrefForPush(data: Record<string, unknown> | undefined): string {
  const href = typeof data?.href === 'string' ? data.href.trim() : '';
  // Only an in-app absolute path. Anything else (a full URL, a protocol-
  // relative "//evil") is refused rather than handed to navigate().
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  switch (data?.type) {
    case 'group_update':
    case 'invite':
      return '/groups';
    default:
      return '/inbox';
  }
}

/** Maps a resolved in-app href to the notification_opened telemetry
 *  vocabulary. Used for FCM taps here; nativeBridge.ts's LOCAL reminder tap
 *  reports its own fixed 'reminder' type instead — a local notification is a
 *  reminder by construction, regardless of where it happens to route. */
export function notificationOpenTypeFromHref(
  href: string,
): 'reminder' | 'inbox' | 'loan' | 'group' | 'kameti' | 'other' {
  if (href.startsWith('/loan')) return 'loan';
  if (href.startsWith('/kameti')) return 'kameti';
  if (href.startsWith('/groups') || href.startsWith('/group/')) return 'group';
  if (href.startsWith('/inbox')) return 'inbox';
  return 'other';
}

// ── Android notification channels (audit N-10) ─────────────────────────────
// "all pushes are one undifferentiated channel." The four descriptors and the
// reasoning behind their importance levels live in notificationContent.ts, so
// the local-reminder scheduler can create the same set without depending on
// this FCM module. They must exist BEFORE the first push arrives — a message
// naming an unknown channel is dropped without a trace — which is why this
// runs as part of registration rather than lazily.
let channelsCreated = false;

/** Create the four Android channels. No-op off-native, on iOS (the plugin
 *  rejects), and after the first successful run. Never throws — a device that
 *  refuses channel creation still gets the app, it just gets the OS default
 *  channel behaviour. */
export async function ensureNotificationChannels(): Promise<void> {
  if (!isNativeRuntime() || channelsCreated) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    if (typeof PushNotifications.createChannel !== 'function') return;
    for (const def of notificationChannelDefs(tStatic)) {
      await PushNotifications.createChannel(def);
    }
    channelsCreated = true;
  } catch (err) {
    console.error('[push] channel setup failed (non-fatal)', err);
  }
}

export async function startPushRegistration(navigate: NavigateFn): Promise<void> {
  if (!isNativeRuntime()) return;
  if (starting) return;
  starting = true;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Android 13+ needs the runtime POST_NOTIFICATIONS grant. If the user
    // already enabled reminders in Settings this resolves instantly; if they
    // declined, we do NOT re-prompt here — pushing a permission dialog at
    // boot is exactly the pattern users learn to reflex-deny.
    const perm = await PushNotifications.checkPermissions();
    // Catalog #24. This module is Android-only (isNativeRuntime() gates the
    // whole function), so surface is always 'android'.
    track('push_permission_result', { granted: perm.receive === 'granted', surface: 'android' });
    if (perm.receive !== 'granted') {
      starting = false;
      return;
    }

    // Before the first token exists, so no push can arrive naming a channel
    // Android does not know about (which it would drop without a trace).
    await ensureNotificationChannels();

    if (!listenersAttached) {
      listenersAttached = true;

      await PushNotifications.addListener('registration', (token) => {
        rememberToken(token.value);
        void pushTokensDb.register(token.value, 'android').catch((err) => {
          console.error('[push] token registration failed (non-fatal)', err);
        });
      });

      await PushNotifications.addListener('registrationError', (err) => {
        // Almost always "no google-services.json" or a Play-services-less
        // device. Not fatal — the app still works.
        console.error('[push] FCM registration error (non-fatal)', err);
      });

      // Delivered while the app is in the FOREGROUND. Android does not show
      // these in the tray, and we don't want it to — the user is looking at
      // the app. Just refresh so the badge and lists move immediately.
      await PushNotifications.addListener('pushNotificationReceived', () => {
        void refreshLiveData();
      });

      // The user tapped the tray notification.
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = action.notification.data as Record<string, unknown> | undefined;
        void refreshLiveData();
        const href = hrefForPush(data);
        navigate(href);
        // Catalog #25. FCM pushes are server-driven activity, never a local
        // reminder — classify by destination.
        track('notification_opened', { type: notificationOpenTypeFromHref(href) });
      });
    }

    await PushNotifications.register();
  } catch (err) {
    console.error('[push] start failed (non-fatal)', err);
  } finally {
    starting = false;
  }
}

/** Sign-out: drop this device's token so the account that just left stops
 *  receiving pushes here.
 *
 *  ORDERING CONTRACT: this must be awaited BEFORE `supabase.auth.signOut()`.
 *  `pushTokensDb.unregister` is an authenticated DELETE scoped by RLS to the
 *  signed-in user — once the session is gone it can only fail silently, which
 *  is exactly the M5 leak (the row survives and the previous account's loan
 *  and settlement pushes keep landing on a phone they no longer control).
 *  supabaseAuthStore.signOut() owns that ordering; App.tsx's user-became-null
 *  effect is only a backstop.
 *
 *  Best-effort and never throws — a failure costs one stale row, and the local
 *  token record is dropped either way so we do not retry against a dead
 *  session forever. */
export async function stopPushRegistration(): Promise<void> {
  if (!isNativeRuntime()) return;
  const token = forgetToken();
  if (!token) return;
  try {
    await pushTokensDb.unregister(token);
  } catch (err) {
    console.error('[push] token cleanup failed (non-fatal)', err);
  }
}

/** Called from the Settings reminders toggle: once the user has granted
 *  notification permission there, register for push in the same breath so
 *  they don't need a second, separate opt-in. */
export async function requestPushPermissionAndRegister(navigate: NavigateFn): Promise<void> {
  if (!isNativeRuntime()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== 'granted') {
      perm = await PushNotifications.requestPermissions();
    }
    // Catalog #24 — the explicit ask from the Settings reminders toggle.
    // startPushRegistration below fires its own copy off checkPermissions();
    // a harmless duplicate on the rare path where this ends in a fresh grant.
    track('push_permission_result', { granted: perm.receive === 'granted', surface: 'android' });
    if (perm.receive !== 'granted') return;
    await startPushRegistration(navigate);
  } catch (err) {
    console.error('[push] permission request failed (non-fatal)', err);
  }
}
