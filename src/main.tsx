import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/serviceWorker';
import {
  beginDeferredReporter,
  installGlobalErrorHandlers,
  resolveDeferredReporter,
} from './lib/errorReporter';
import { initTelemetry, trackAppOpened } from './lib/telemetry';
import { initTheme } from './stores/themeStore';

// Apply the saved appearance (light/dark/system) before first React paint.
// CSP blocks an inline <head> script, so this runs as early as the module
// graph allows; the initial loading screen is dark navy regardless, so there
// is no jarring light flash.
initTheme();

// Activate Sentry if VITE_SENTRY_DSN is set; otherwise the noop reporter
// stays active and dev-mode logs go to the console.
//
// Audit 2026-09 H1 / quick win #13: the SDK is no longer in the entry graph.
// `import.meta.env.VITE_SENTRY_DSN` is statically replaced at build time, so a
// build WITHOUT a DSN never reaches the `import()` below — the chunk is never
// fetched, never parsed. With a DSN, the fetch is deferred to the first idle
// slot after first paint; everything reported before it resolves is buffered
// by beginDeferredReporter() and replayed, so no boot error is lost.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn && sentryDsn.length > 0) {
  beginDeferredReporter();
  const loadSentry = () => {
    void import('./lib/sentryReporter')
      .then((m) => m.loadSentryReporter())
      .catch(() => null)
      // Always resolves — a failed chunk fetch must still flush the queue
      // (to the noop reporter) rather than buffer forever.
      .then((reporter) => resolveDeferredReporter(reporter ?? null));
  };
  // `timeout` guarantees it still runs on a device that never goes idle.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(loadSentry, { timeout: 3000 });
  } else {
    setTimeout(loadSentry, 0);
  }
}
installGlobalErrorHandlers();

// Product telemetry. Triple-gated: no VITE_POSTHOG_KEY, or no stored consent,
// means the SDK is never even downloaded (it lives behind a dynamic import) and
// no request is made. Consent is device-level and defaults to OFF, so a fresh
// install is silent until the user turns it on in Settings.
initTelemetry();
trackAppOpened();

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
