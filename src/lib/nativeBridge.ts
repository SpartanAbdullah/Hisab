// Capacitor native-only initialisation. Loaded only when running inside the
// Capacitor WebView (isNativeRuntime() true). The dynamic imports keep these
// plugin entry-points out of the web bundle.
//
// Wires:
//   - Status bar colour + style (Sukoon navy + light icons)
//   - Splash screen (auto-hides after the React tree first paints)
//   - Hardware back button → React Router history.back() / app exit
//   - Deep links → react-router navigate() for `/join/:token` etc.
//
// Call once from App.tsx after the router is mounted. Safe to call again on
// hot-reload — every listener registration tracks its handle and re-uses it.

import { isNativeRuntime } from './runtime';
import { rescheduleNotifications } from './notificationScheduler';
import { useUIStore } from '../stores/uiStore';

type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;
type CanGoBackFn = () => boolean;

let initialised = false;

export async function initNativeBridge(opts: {
  navigate: NavigateFn;
  canGoBack: CanGoBackFn;
}): Promise<void> {
  if (initialised) return;
  if (!isNativeRuntime()) return;
  initialised = true;

  try {
    const { App: CapApp } = await import('@capacitor/app');
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { SplashScreen } = await import('@capacitor/splash-screen');

    // Status bar: Sukoon navy, light icons. Try/catch each call so a single
    // plugin failure doesn't abort the rest of the boot.
    StatusBar.setBackgroundColor({ color: '#0B0E2A' }).catch(() => {});
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});

    // The native splash auto-hides after launchShowDuration, but call hide()
    // anyway in case the React tree paints faster — avoids a brief blank
    // screen between Capacitor's splash and the first paint.
    SplashScreen.hide().catch(() => {});

    // Hardware back button → router history when there's something to pop,
    // otherwise exit the app. This is the single most important Capacitor
    // wire-up: without it, every back press kills the app immediately.
    CapApp.addListener('backButton', () => {
      // A back press first dismisses the topmost open modal (closing it, or
      // prompting to discard unsaved input) instead of navigating the page
      // underneath. Only when nothing is open do we pop history / exit.
      if (useUIStore.getState().closeTopModal()) return;
      if (opts.canGoBack()) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });

    // Deep links — fired when the OS hands the app an https://usehisaab.com/join/XYZ
    // (or capacitor://) URL. We extract the path and route the router.
    CapApp.addListener('appUrlOpen', ({ url }) => {
      try {
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        if (path && path !== '/') opts.navigate(path, { replace: true });
      } catch {
        // Malformed URL — ignore. The OS already handed us a sanitised URL,
        // so this is mostly a defensive guard against custom-scheme oddities.
      }
    });

    // App resume — fired when the user brings Hisaab back to the
    // foreground after backgrounding it. Supabase's JS client refreshes
    // its session automatically on most events, but the access-token
    // refresh job pauses while the WebView is suspended, so after a long
    // background the cached session can be stale. Explicitly nudging
    // getSession() forces a refresh-and-reload of `auth.user` so any
    // gated UI re-evaluates with the live state.
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      // Dynamic import so we don't pay this dependency cost on web boot.
      import('./supabase')
        .then(({ supabase }) => supabase.auth.getSession())
        .catch((err) => {
          console.error('[nativeBridge] session refresh on resume failed', err);
        });
      // Re-derive the reminder schedule from live state on every resume —
      // anything the user paid while the app was open (or on another
      // device, once stores refresh) stops ringing here.
      void rescheduleNotifications();
    });

    // Notification taps route into the app (href stashed at schedule time).
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      void LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
        const href = (event.notification.extra as { href?: string } | undefined)?.href;
        if (href) opts.navigate(href);
      });
    } catch {
      // Plugin unavailable (older binary) — reminders simply stay off.
    }
  } catch (err) {
    console.error('[nativeBridge] init failed', err);
  }
}
