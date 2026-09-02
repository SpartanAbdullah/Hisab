// NOTE: `@sentry/browser` is imported for TYPES ONLY here. The runtime import
// is the `await import('@sentry/browser')` inside loadSentryReporter() —
// audit 2026-09 H1 / quick win #13: a static import put the whole ~262 kB
// SDK in the eager graph on every cold boot, DSN or no DSN. `import type` is
// erased by the compiler, so it does not resurrect that edge.
import type * as SentryNs from '@sentry/browser';
import type { ErrorContext, ErrorReporter } from './errorReporter';

// ─────────────────────────────────────────────────────────────────────────
// NATIVE CRASH REPORTING (audit 2026-09 §2.3) — NOT ENABLED.
//
// Only JS errors inside the WebView reach Sentry today. A WebView process
// crash, an ANR, an OOM kill, or a crash inside a Capacitor plugin is
// invisible on the platform where most users live.
//
// The decision, the version evidence, the Gradle answer (spoiler: no Gradle
// changes needed) and the verification checklist are in
// docs/native-crash-reporting.md. `@sentry/capacitor` is NOT installed —
// package.json is deliberately untouched — so the block below is inert until
// the lead runs the install in the next native change window.
//
// To enable, do exactly three things:
//   1. npm install --save-exact @sentry/capacitor@4.3.0 @sentry/browser@10.69.0
//   2. swap the DYNAMIC import inside loadSentryReporter() (keep it dynamic —
//      audit H1; the static import is what put the SDK in the entry graph):
//        const Sentry = await import('@sentry/capacitor');
//        const { init: browserInit } = await import('@sentry/browser');
//      and point the type-only import at '@sentry/capacitor' too.
//   3. replace the Sentry.init({ ... }) call below with:
//
//        Sentry.init(
//          {
//            dsn,
//            environment: import.meta.env.MODE,
//            tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
//            sendDefaultPii: false,
//            enableNative: true,                        // no-op on web
//            anrEnabled: true,                          // main-thread freezes
//            enableWatchdogTerminationTracking: true,   // WebView process death
//            ignoreErrors: [ /* unchanged */ ],
//          },
//          browserInit,                                 // the sibling SDK's init
//        );
//
// Nothing below that call changes: @sentry/capacitor re-exports the same
// withScope / captureException / captureMessage surface, so the `feature`
// tag, the fingerprint and the DSN-absent console fallback all survive.
// ─────────────────────────────────────────────────────────────────────────

// Fetch + initialise Sentry from VITE_SENTRY_DSN. Called once from main.tsx
// AFTER first paint (requestIdleCallback), never during module evaluation.
// Resolves to the reporter to hand to resolveDeferredReporter(), or null if
// no DSN is configured (dev/local) so the caller keeps the noop reporter.
//
// Everything reported between boot and this promise resolving is buffered by
// errorReporter's pending queue and replayed here — see the deferred-reporter
// block in errorReporter.ts.
//
// NOTE: main.tsx checks the DSN ITSELF before importing this module — that is
// deliberate and load-bearing. `import.meta.env.VITE_SENTRY_DSN` is replaced
// at build time, so a DSN-less build turns that check into `if (false)` and
// the bundler never even reaches the `import()`. A `hasSentryDsn()` helper
// exported from here could not do that: calling it would require fetching the
// very chunk we are trying not to fetch. The check below is the second belt,
// for a runtime where the value is somehow empty anyway.
export async function loadSentryReporter(): Promise<ErrorReporter | null> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn || dsn.length === 0) return null;

  // Destructured, NOT `const Sentry = await import(...)`. A namespace binding
  // forces the bundler to keep every export of the SDK alive (measured: 431 kB
  // raw in the lazy chunk); naming the four functions we use lets it tree-shake
  // the rest away exactly as the old static import did.
  const {
    init,
    withScope,
    captureException: sentryCaptureException,
    captureMessage: sentryCaptureMessage,
  } = await import('@sentry/browser');

  init({
    dsn,
    environment: import.meta.env.MODE,
    // Sample everything in dev, 10% in prod. Adjust once you've calibrated
    // expected error volume against your Sentry quota.
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    // Don't send PII automatically. The captureException calls below pass
    // explicit context (feature, userId, extras) so we choose what's
    // attached per-event.
    sendDefaultPii: false,
    // Reduce noise from known third-party scripts (Supabase, browser exts).
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications.',
      'Non-Error promise rejection captured',
    ],
  });

  // Everything is applied to the *event's own* scope, never the global one.
  // (Audit 2026-09 H1: the previous version called the global `Sentry.setTag`
  // / `setUser` / `setContext` inside withScope, so the last-reported feature
  // leaked onto every subsequent unrelated event and broke grouping.)
  const applyContext = (scope: SentryNs.Scope, context: ErrorContext | undefined, fallbackLevel: 'info' | 'error'): void => {
    scope.setLevel(context?.level ?? fallbackLevel);
    if (!context) return;
    if (context.feature) {
      // `feature` is the greppable `<module>.<method>[.<detail>]` key. As a
      // tag it is searchable and alertable; in the fingerprint it keeps two
      // different call sites from collapsing into one Sentry issue.
      scope.setTag('feature', context.feature);
      scope.setTag('feature_module', context.feature.split('.')[0]);
      scope.setFingerprint(['{{ default }}', context.feature]);
    }
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.extra) scope.setContext('extra', context.extra);
  };

  return {
    captureException(error, context) {
      withScope((scope) => {
        applyContext(scope, context, 'error');
        sentryCaptureException(error);
      });
    },
    captureMessage(message, context) {
      withScope((scope) => {
        applyContext(scope, context, 'info');
        sentryCaptureMessage(message, context?.level ?? 'info');
      });
    },
  };
}
