import { StatusBar, Style } from '@capacitor/status-bar';
import { isNativeRuntime } from './runtime';

const APP_SURFACE_COLOR = '#f8fafc';

export function configureNativeStatusBar() {
  if (!isNativeRuntime()) return;

  void Promise.all([
    StatusBar.setOverlaysWebView({ overlay: false }),
    StatusBar.setBackgroundColor({ color: APP_SURFACE_COLOR }),
    StatusBar.setStyle({ style: Style.Light }),
    StatusBar.show(),
  ]).catch((error) => {
    console.warn('Unable to configure native status bar', error);
  });
}
