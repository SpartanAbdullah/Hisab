import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ErrorContext,
  type ErrorReporter,
  beginDeferredReporter,
  reportError,
  reportMessage,
  resetDeferredReporter,
  resetErrorReportDedupe,
  resolveDeferredReporter,
  setErrorReporter,
} from './errorReporter';

// Audit 2026-09 H1 / quick win #13: the Sentry SDK is now fetched lazily,
// after first paint. The window between module evaluation and that fetch
// resolving is real (boot store loads, window.onerror during hydration), so
// these tests pin the two properties that keep it safe:
//   1. nothing reported in that window is lost — it is queued and replayed;
//   2. the H1 de-dupe still runs FIRST, so a boot retry loop cannot flood the
//      queue with one repeated failure.

interface Captured { kind: 'exception' | 'message'; payload: unknown; context?: ErrorContext }
let captured: Captured[] = [];
const spyReporter: ErrorReporter = {
  captureException: (error, context) => { captured.push({ kind: 'exception', payload: error, context }); },
  captureMessage: (message, context) => { captured.push({ kind: 'message', payload: message, context }); },
};
const noopReporter: ErrorReporter = { captureException: () => {}, captureMessage: () => {} };

beforeEach(() => {
  captured = [];
  resetDeferredReporter();
  resetErrorReportDedupe();
  setErrorReporter(spyReporter);
});
afterEach(() => {
  resetDeferredReporter();
  setErrorReporter(noopReporter);
  resetErrorReportDedupe();
});

describe('reportError / reportMessage de-dupe (unchanged by the lazy loader)', () => {
  it('sends an identical error from the same feature only once per window', () => {
    const err = new Error('boom');
    reportError(err, { feature: 'store.load' });
    reportError(new Error('boom'), { feature: 'store.load' });
    reportError(err, { feature: 'store.load' });
    expect(captured).toHaveLength(1);
  });

  it('still sends a different error from the same feature', () => {
    reportError(new Error('boom'), { feature: 'store.load' });
    reportError(new Error('other'), { feature: 'store.load' });
    expect(captured).toHaveLength(2);
  });

  it('still sends the same error from a different feature', () => {
    reportError(new Error('boom'), { feature: 'store.load' });
    reportError(new Error('boom'), { feature: 'store.save' });
    expect(captured).toHaveLength(2);
  });

  it('keeps the scope-tag context intact on the way through', () => {
    reportMessage('recovered', { feature: 'mirror.refresh', level: 'warning', extra: { key: 'accounts' } });
    expect(captured[0]).toMatchObject({
      kind: 'message',
      payload: 'recovered',
      context: { feature: 'mirror.refresh', level: 'warning', extra: { key: 'accounts' } },
    });
  });
});

describe('deferred reporter', () => {
  it('buffers instead of dropping while the SDK is loading, then replays in order', () => {
    beginDeferredReporter();
    reportError(new Error('during boot'), { feature: 'boot.one' });
    reportMessage('also during boot', { feature: 'boot.two' });
    // Nothing reaches the reporter yet.
    expect(captured).toHaveLength(0);

    resolveDeferredReporter(spyReporter);
    expect(captured.map((c) => c.context?.feature)).toEqual(['boot.one', 'boot.two']);
    expect(captured[0].kind).toBe('exception');
    expect(captured[1].kind).toBe('message');
  });

  it('installs the resolved reporter and reports synchronously afterwards', () => {
    beginDeferredReporter();
    resolveDeferredReporter(spyReporter);
    reportError(new Error('after load'), { feature: 'after.load' });
    expect(captured).toHaveLength(1);
    expect(captured[0].context?.feature).toBe('after.load');
  });

  it('replays to the already-active reporter when the SDK fails to load', () => {
    beginDeferredReporter();
    reportError(new Error('during boot'), { feature: 'boot.only' });
    // null = no DSN, or the chunk fetch failed. The queue must still drain.
    resolveDeferredReporter(null);
    expect(captured.map((c) => c.context?.feature)).toEqual(['boot.only']);
  });

  it('de-dupes BEFORE queueing, so a retry loop cannot fill the buffer', () => {
    beginDeferredReporter();
    for (let i = 0; i < 20; i += 1) {
      reportError(new Error('offline'), { feature: 'outbox.sweep' });
    }
    resolveDeferredReporter(spyReporter);
    expect(captured).toHaveLength(1);
  });

  it('bounds the queue at 50, dropping the OLDEST and recording the loss', () => {
    beginDeferredReporter();
    // 60 DISTINCT signatures — the de-dupe lets every one through.
    for (let i = 0; i < 60; i += 1) {
      reportError(new Error(`fail-${i}`), { feature: `boot.${i}` });
    }
    resolveDeferredReporter(spyReporter);

    expect(captured).toHaveLength(50);
    // Oldest ten dropped: the survivors start at #10 and end at #59.
    expect(captured[0].context?.feature).toBe('boot.10');
    expect(captured[49].context?.feature).toBe('boot.59');
    // The loss is visible rather than silent.
    expect(captured[0].context?.extra).toMatchObject({ droppedWhilePending: 10 });
  });

  it('is idempotent: a second begin does not clear what is already buffered', () => {
    beginDeferredReporter();
    reportError(new Error('first'), { feature: 'boot.first' });
    beginDeferredReporter();
    reportError(new Error('second'), { feature: 'boot.second' });
    resolveDeferredReporter(spyReporter);
    expect(captured.map((c) => c.context?.feature)).toEqual(['boot.first', 'boot.second']);
  });

  it('resolving without a pending queue is a no-op that still installs the reporter', () => {
    resolveDeferredReporter(spyReporter);
    expect(captured).toHaveLength(0);
    reportError(new Error('later'), { feature: 'later' });
    expect(captured).toHaveLength(1);
  });
});
