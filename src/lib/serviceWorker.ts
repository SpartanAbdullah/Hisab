import { isNativeRuntime } from './runtime';

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // Capacitor/native shells should load fresh bundled assets directly from the app.
  // Keeping the web service worker there can leave a stale cached web shell in Android.
  if (isNativeRuntime()) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
