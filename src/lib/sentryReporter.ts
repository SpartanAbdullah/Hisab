import * as Sentry from '@sentry/browser';
import type { ErrorContext, ErrorReporter } from './errorReporter';

// Initialise Sentry from VITE_SENTRY_DSN. Call once at app boot before any
// user-visible code runs. Returns the reporter to pass to setErrorReporter().
// Returns null if no DSN is configured (dev/local), so the caller can fall
// back to the noop reporter.
export function initSentry(): ErrorReporter | null {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn || dsn.length === 0) return null;

  Sentry.init({
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

  const applyContext = (context: ErrorContext | undefined): void => {
    if (!context) return;
    if (context.feature) Sentry.setTag('feature', context.feature);
    if (context.userId) Sentry.setUser({ id: context.userId });
    if (context.extra) Sentry.setContext('extra', context.extra);
  };

  return {
    captureException(error, context) {
      Sentry.withScope((scope) => {
        applyContext(context);
        if (context?.feature) scope.setTag('feature', context.feature);
        Sentry.captureException(error);
      });
    },
    captureMessage(message, context) {
      Sentry.withScope((scope) => {
        applyContext(context);
        if (context?.feature) scope.setTag('feature', context.feature);
        Sentry.captureMessage(message);
      });
    },
  };
}
