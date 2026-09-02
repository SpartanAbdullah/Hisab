// Lightweight error-reporter abstraction. Production deployments should swap
// `noopReporter` for a real implementation (Sentry, PostHog, etc.) by calling
// `setErrorReporter()` at app boot before any user-visible code runs.
//
// The interface is deliberately minimal so the rest of the app can call
// `reportError(err, context)` without caring which backend is configured.
import { notifyStaleChunkLoadError } from './appRecovery';
import { track } from './telemetry';

export interface ErrorContext {
  /**
   * Stable, greppable grouping key — always `<module>.<method>[.<detail>]`
   * (e.g. `transactionStore.processTransaction.rollback`). Lands as the
   * Sentry `feature` tag, so Sentry can group/alert on it. Never put
   * amounts, names, phone numbers or note text in here — ids only.
   */
  feature?: string;
  /** Authenticated user id, if known. */
  userId?: string;
  /**
   * Severity. Defaults to `error` for reportError and `info` for
   * reportMessage. `info` is the breadcrumb level used for
   * "something recovered silently and an operator should know" events.
   */
  level?: 'info' | 'warning' | 'error';
  /** Arbitrary serialisable extra data. Ids and counts — never PII. */
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

// ─────────────────────────────────────────────────────────────────────────
// Deferred reporter (audit 2026-09 H1 / quick win #13).
//
// `@sentry/browser` is ~262 kB raw / ~87 kB gzip and used to ride in the
// eager import graph via a static `import * as Sentry` in sentryReporter.ts,
// downloaded and parsed on every cold boot whether or not VITE_SENTRY_DSN is
// set. It is now fetched lazily, after first paint, from main.tsx.
//
// That opens a window — module evaluation through to the idle callback
// resolving — in which `reportError` is called synchronously (boot store
// loads, window.onerror during hydration) but no real reporter exists yet.
// Those events are exactly the ones worth keeping, so they are QUEUED and
// replayed once the SDK resolves.
//
// The public API does not change: `reportError`/`reportMessage` stay
// synchronous and never throw. De-duplication runs BEFORE queueing, so a
// boot-time retry loop cannot fill the queue with one repeated failure.
//
// The queue is bounded. Beyond PENDING_QUEUE_MAX the OLDEST event is dropped:
// if something is generating 50+ distinct failures before the SDK has even
// loaded, the most recent ones describe the state the app actually ended up
// in. `droppedWhilePending` is attached to the first replayed event so the
// loss is visible in Sentry rather than silent.
// ─────────────────────────────────────────────────────────────────────────

const PENDING_QUEUE_MAX = 50;

interface PendingEvent {
  kind: 'err' | 'msg';
  payload: unknown;
  context?: ErrorContext;
}

// null = not waiting on anything (the normal steady state, and the state of
// every unit test). A non-null array means a deferred reporter is in flight.
let pendingQueue: PendingEvent[] | null = null;
let droppedWhilePending = 0;

/** Start buffering reports. Call synchronously, BEFORE the loader runs, so
 *  nothing reported in between is lost. Idempotent. */
export function beginDeferredReporter(): void {
  if (pendingQueue === null) {
    pendingQueue = [];
    droppedWhilePending = 0;
  }
}

/** Install the loaded reporter (or `null` if it could not be created — no
 *  DSN, a failed chunk fetch) and flush whatever was buffered. Always safe to
 *  call, even if `beginDeferredReporter` never ran. */
export function resolveDeferredReporter(reporter: ErrorReporter | null): void {
  const queued = pendingQueue;
  const dropped = droppedWhilePending;
  pendingQueue = null;
  droppedWhilePending = 0;
  if (reporter) activeReporter = reporter;
  if (!queued || queued.length === 0) return;
  queued.forEach((event, index) => {
    // The dropped-count rides on the first replayed event only; the queue is
    // otherwise replayed verbatim so features/levels/extras are unchanged.
    const context =
      index === 0 && dropped > 0
        ? { ...event.context, extra: { ...event.context?.extra, droppedWhilePending: dropped } }
        : event.context;
    try {
      if (event.kind === 'err') activeReporter.captureException(event.payload, context);
      else activeReporter.captureMessage(String(event.payload), context);
    } catch {
      // Never let a replay throw — this runs inside an idle callback.
    }
  });
}

/** Test seam: forget any buffered events and stop buffering. */
export function resetDeferredReporter(): void {
  pendingQueue = null;
  droppedWhilePending = 0;
}

function queueWhilePending(event: PendingEvent): boolean {
  if (pendingQueue === null) return false;
  pendingQueue.push(event);
  while (pendingQueue.length > PENDING_QUEUE_MAX) {
    pendingQueue.shift();
    droppedWhilePending += 1;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// De-duplication.
//
// Audit 2026-09 H1: the store layer now reports from ~70 catch sites, several
// of which sit inside retry loops (the outbox sweep, the realtime reload
// debounce, the mirror background refresh). A single offline device could
// otherwise burn the whole Sentry quota in a minute.
//
// Rule: an identical (kind + feature + error signature) report is sent at most
// ONCE per DEDUPE_WINDOW_MS. "Identical" is deliberately coarse — the same
// failure from the same call site is one incident, not two hundred. A
// *different* error from the same site still reports immediately.
// ─────────────────────────────────────────────────────────────────────────

const DEDUPE_WINDOW_MS = 10_000;
const DEDUPE_MAX_KEYS = 500;
const recentReports = new Map<string, number>();

/** Short, PII-free signature for an unknown throwable. */
function signatureOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const shaped = error as { code?: unknown; message?: unknown };
    if (shaped.code != null || shaped.message != null) {
      return `${String(shaped.code ?? '')}:${String(shaped.message ?? '')}`;
    }
  }
  return String(error);
}

function shouldSend(kind: 'err' | 'msg', feature: string | undefined, signature: string): boolean {
  const key = `${kind}|${feature ?? 'unknown'}|${signature.slice(0, 200)}`;
  const now = Date.now();
  const last = recentReports.get(key);
  if (last != null && now - last < DEDUPE_WINDOW_MS) return false;
  recentReports.set(key, now);
  if (recentReports.size > DEDUPE_MAX_KEYS) {
    for (const [k, at] of recentReports) {
      if (now - at >= DEDUPE_WINDOW_MS) recentReports.delete(k);
    }
    // Still oversized (a genuine flood of distinct signatures) — start fresh
    // rather than grow without bound.
    if (recentReports.size > DEDUPE_MAX_KEYS) recentReports.clear();
  }
  return true;
}

/** Test seam: clears the de-dupe window so cases don't leak into each other. */
export function resetErrorReportDedupe(): void {
  recentReports.clear();
}

// Catalog #28 — bridges the error-rate signal into product analytics without
// ever sending a message string: `feature` is bucketed into the closed set
// the schema allows, `kind` is fixed by which function was called. This is
// the ONLY place `error_surfaced` fires — reportMessage() stays a breadcrumb.
function errorSurfacedFeature(
  feature: string | undefined,
): 'react.render' | 'window.onerror' | 'window.unhandledrejection' | 'money_mutation' | 'other' {
  if (feature === 'react.render' || feature === 'window.onerror' || feature === 'window.unhandledrejection') {
    return feature;
  }
  // mutationSafety.ts (src/lib/mutationSafety.ts) is the single wrapper every
  // money-moving flow's compensation/rollback logic goes through — its
  // feature strings are always prefixed 'mutationSafety.'.
  if (feature?.startsWith('mutationSafety.')) return 'money_mutation';
  return 'other';
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    if (!shouldSend('err', context?.feature, signatureOf(error))) return;
    track('error_surfaced', { feature: errorSurfacedFeature(context?.feature) });
    if (queueWhilePending({ kind: 'err', payload: error, context })) return;
    activeReporter.captureException(error, context);
  } catch {
    // Never let the reporter throw.
  }
}

export function reportMessage(message: string, context?: ErrorContext): void {
  try {
    if (!shouldSend('msg', context?.feature, message)) return;
    if (queueWhilePending({ kind: 'msg', payload: message, context })) return;
    activeReporter.captureMessage(message, context);
  } catch {
    // Never let the reporter throw.
  }
}

// Wire up window-level error listeners. Call from main.tsx ONCE.
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    notifyStaleChunkLoadError(event.error ?? event.message);
    reportError(event.error ?? event.message, {
      feature: 'window.onerror',
      extra: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    notifyStaleChunkLoadError(event.reason);
    reportError(event.reason, { feature: 'window.unhandledrejection' });
  });
}
