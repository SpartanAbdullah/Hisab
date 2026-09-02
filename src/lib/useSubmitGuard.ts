// ───────────────────────────────────────────────────────────────────────────
// Double-tap protection for money-mutating submit handlers.
//
// WHY A REF AND NOT THE `saving` STATE (audit 2026-09, F-8 / D-1):
// every submit handler in this repo sets a `saving` state flag and disables
// its button, but React state updates are asynchronous — two taps landing
// inside ONE frame both read `saving === false`, both pass any `if (saving)
// return` written against state, and both run the handler. On the low-end
// Android WebViews this app targets that window is wide enough to duplicate an
// expense, a loan, or (worst blast radius) a cross-user debt request mirrored
// onto two people's ledgers.
//
// A ref is written synchronously, so the second tap in the same frame sees the
// flag already set. Keep the existing `saving` STATE for the disabled/label
// UI — this hook is the correctness layer underneath it, not a replacement.
//
// USAGE — wrap the whole handler body so every early return still releases:
//
//   const guard = useSubmitGuard();
//   const handleSubmit = () => guard.run(async () => {
//     if (!valid) return;           // early returns are safe: run() has finally
//     setSaving(true);
//     try { await save(); } finally { setSaving(false); }
//   });
//
// For a form's onSubmit, call `event.preventDefault()` OUTSIDE `run` — a
// dropped second tap must still not let the browser navigate.
//
// IDEMPOTENCY — `useSubmitIntentId` mints one stable id per "submit intent"
// (same form values + same open modal ⇒ same id). Passing that id as the
// primary key of a cross-user request row makes a duplicate insert collide on
// the PK instead of creating a second, independently-acceptable request. The
// id changes as soon as the user edits the form or the modal reopens, so a
// deliberate second request is never suppressed.
// ───────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useRef } from 'react';
import { v4 as uuid } from 'uuid';

export interface SubmitGuard {
  /**
   * Runs `fn` unless a previous run is still in flight, in which case the call
   * is dropped and the promise resolves to `undefined`. `fn` is invoked
   * synchronously, so anything it does before its first `await` (e.g. reading
   * form state) still happens in the tap's own frame.
   */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** True while a guarded run is in flight. Read from the ref, not state. */
  isRunning: () => boolean;
}

export function useSubmitGuard(): SubmitGuard {
  const running = useRef(false);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    try {
      return await fn();
    } finally {
      running.current = false;
    }
  }, []);

  const isRunning = useCallback(() => running.current, []);

  return useMemo(() => ({ run, isRunning }), [run, isRunning]);
}

// ───────────────────────────────────────────────────────────────────────────
// Submit-intent ids
// ───────────────────────────────────────────────────────────────────────────

export interface IntentIdCell {
  /** The form fingerprint this id was minted for. */
  key: string;
  /** The id to send with every attempt at this exact intent. */
  id: string;
}

/**
 * Pure core of `useSubmitIntentId`: keep the existing id while the intent key
 * is unchanged (a retry of the SAME submit), mint a fresh one the moment the
 * key moves (the user edited the form, or the modal closed and reopened).
 */
export function nextIntentId(
  cell: IntentIdCell | null | undefined,
  key: string,
  mint: () => string,
): IntentIdCell {
  if (cell && cell.key === key) return cell;
  return { key, id: mint() };
}

/**
 * Returns a getter for the current submit-intent id. `resetKey` should encode
 * everything that makes this a DIFFERENT record — typically the modal's open
 * flag plus the amount/person/note fields.
 */
export function useSubmitIntentId(resetKey: string): () => string {
  const cell = useRef<IntentIdCell | null>(null);
  return useCallback(() => {
    cell.current = nextIntentId(cell.current, resetKey, uuid);
    return cell.current.id;
  }, [resetKey]);
}
