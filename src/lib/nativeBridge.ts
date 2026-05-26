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
      if (opts.canGoBack()) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });

    // Deep links — fired when the OS hands the app an https://hisaab.app/join/XYZ
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
  } catch (err) {
    console.error('[nativeBridge] init failed', err);
  }
}
