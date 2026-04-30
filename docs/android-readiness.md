# Hisaab 2.0 Android Readiness Notes

## Runtime Detection

The app has a browser-safe runtime helper in `src/lib/runtime.ts`.

It detects:

- normal web browser runtime
- PWA/standalone runtime via `display-mode: standalone` and iOS `navigator.standalone`
- future Capacitor/native runtime without importing Capacitor, by checking for `window.Capacitor` and native URL schemes such as `capacitor:`

This keeps the current web/PWA behavior intact while giving native-specific UI a single place to branch later.

## PWA Install Prompt

`PWAInstallPrompt` now uses the runtime helper. It continues to work in web browsers, but it will not show when:

- the app is already installed/running standalone as a PWA
- the app later runs inside a Capacitor/native shell

## Service Worker

Service worker registration remains unchanged in `index.html`.

Before adding Capacitor, revisit this and consider making registration conditional so the native wrapper does not keep a stale web shell cache. A safe future policy is:

- keep service worker enabled for hosted web/PWA
- skip service worker registration for Capacitor/native runtime

Do not make that change until the native runtime bootstrap exists and can be tested.

