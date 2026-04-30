interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

interface WindowWithCapacitor extends Window {
  Capacitor?: unknown;
}

export function isNativeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const maybeNativeWindow = window as WindowWithCapacitor;
  return Boolean(
    maybeNativeWindow.Capacitor ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:',
  );
}

export function isStandaloneRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const navigatorWithStandalone = window.navigator as NavigatorWithStandalone;
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;
}

export function isWebBrowserRuntime(): boolean {
  return !isNativeRuntime();
}

export function shouldShowPwaInstallPrompts(): boolean {
  return isWebBrowserRuntime() && !isStandaloneRuntime();
}

