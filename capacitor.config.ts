import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor configuration for the Hisaab Android wrapper.
// - `webDir` points at the Vite build output; `npx cap sync` copies that into
//   the Android assets folder.
// - `androidScheme` is `https` so the WebView treats the bundled app as a
//   secure origin (required for service worker, crypto.subtle, etc.).
// - Plugin defaults are tuned for a navy/cream finance app aesthetic.
const config: CapacitorConfig = {
  appId: 'com.usehisaab.app',
  appName: 'Hisaab',
  webDir: 'dist',
  server: {
    // Required so the app loads at https://localhost rather than http://,
    // which keeps SW + cross-origin cookies working consistently with PWA.
    androidScheme: 'https',
  },
  android: {
    // App-internal links route through Hisaab's WebView. Disable to fall back
    // to a system browser for any non-app URL.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: {
      // Sukoon navy. Keep style 'DARK' so the status bar icons render white.
      backgroundColor: '#0B0E2A',
      style: 'DARK',
      overlaysWebView: false,
    },
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#0B0E2A',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
