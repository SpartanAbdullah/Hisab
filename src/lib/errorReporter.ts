// Lightweight error-reporter abstraction. Production deployments should swap
// `noopReporter` for a real implementation (Sentry, PostHog, etc.) by calling
// `setErrorReporter()` at app boot before any user-visible code runs.
//
// The interface is deliberately minimal so the rest of the app can call
// `reportError(err, context)` without caring which backend is configured.

export interface ErrorContext {
  /** Free-form tag for grouping ("transaction.add", "auth.signOut", etc.). */
  feature?: string;
  /** Authenticated user id, if known. */
  userId?: string;
  /** Arbitrary serialisable extra data. */
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  captureException(error: unknown, context?: ErrorContext): void;
  captureMessage(message: string, context?: ErrorContext): void;
}

const noopReporter: ErrorReporter = {
  captureException(error, context) {
    if (import.meta.env.DEV) {
      console.error('[errorReporter]', context?.feature ?? 'unknown', error, context?.extra);
    }
  },
  captureMessage(message, context) {
    if (import.meta.env.DEV) {
      console.warn('[errorReporter]', context?.feature ?? 'unknown', message, context?.extra);
    }
  },
};

let activeReporter: ErrorReporter = noopReporter;

export function setErrorReporter(reporter: ErrorReporter): void {
  activeReporter = reporter;
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    activeReporter.captureException(error, context);
  } catch {
    // Never let the reporter throw.
  }
}

export function reportMessage(message: string, context?: ErrorContext): void {
  try {
    activeReporter.captureMessage(message, context);
  } catch {
    // Never let the reporter throw.
  }
}

// Wire up window-level error listeners. Call from main.tsx ONCE.
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, {
      feature: 'window.onerror',
      extra: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { feature: 'window.unhandledrejection' });
  });
}
