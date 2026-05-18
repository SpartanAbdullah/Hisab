// Outbox runner — drains queued mutations into Supabase as connectivity
// allows. Currently a SCAFFOLD: the dispatch table that maps OutboxOpKind
// onto an actual Supabase call lives at the bottom marked TODO. Adding a
// handler there is the work of one PR per store.
//
// Operational model:
//   1. The runner is started once per signed-in session in App.tsx.
//   2. Every 30 seconds (and on every `online` event) it sweeps outbox
//      rows whose nextAttemptAt is in the past.
//   3. For each row it calls the dispatch table. On success it deletes the
//      row. On failure it bumps attempts, records the error, and schedules
//      the next attempt with exponential backoff.
//   4. After 10 failed attempts a row enters "stuck" state — the runner
//      stops retrying it automatically. The Settings page surfaces a
//      "stuck operations" count and lets the user retry or discard.

import { db, type OutboxEntry, type OutboxOpKind } from '../db/database';

const SWEEP_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000; // 5s, 10s, 20s, 40s … capped at 5 min

let sweepHandle: number | null = null;
let isRunning = false;

export function startOutboxRunner(): void {
  if (sweepHandle != null) return;
  // Initial sweep on start so any pre-existing outbox rows flush before
  // the user can pile more in.
  void sweepOnce().catch(() => {
    // Errors here are non-fatal — the timer will retry.
  });
  sweepHandle = window.setInterval(() => {
    void sweepOnce().catch(() => {
      /* Logged inside sweepOnce */
    });
  }, SWEEP_INTERVAL_MS);
  window.addEventListener('online', triggerImmediateSweep);
}

export function stopOutboxRunner(): void {
  if (sweepHandle != null) {
    window.clearInterval(sweepHandle);
    sweepHandle = null;
  }
  window.removeEventListener('online', triggerImmediateSweep);
}

function triggerImmediateSweep() {
  void sweepOnce().catch(() => {
    /* swallow */
  });
}

async function sweepOnce(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const nowIso = new Date().toISOString();
    const ready = await db.outbox
      .where('nextAttemptAt')
      .belowOrEqual(nowIso)
      .toArray();
    for (const entry of ready) {
      if (entry.attempts >= MAX_ATTEMPTS) continue;
      try {
        await dispatch(entry);
        await db.outbox.delete(entry.id);
      } catch (err) {
        const attempts = entry.attempts + 1;
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** entry.attempts, 5 * 60_000);
        await db.outbox.update(entry.id, {
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          nextAttemptAt: new Date(Date.now() + backoff).toISOString(),
        });
      }
    }
  } finally {
    isRunning = false;
  }
}

// Public helper for stores: enqueue an op for eventual flush.
export async function enqueueOutboxOp(kind: OutboxOpKind, payload: unknown): Promise<void> {
  const entry: OutboxEntry = {
    id: crypto.randomUUID(),
    kind,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
  };
  await db.outbox.add(entry);
  // Best-effort: try to flush immediately. If offline, sweep will pick
  // it up on reconnect.
  void sweepOnce().catch(() => {
    /* swallow */
  });
}

// Inspection helpers for the Settings "stuck operations" panel.
export async function getStuckOps(): Promise<OutboxEntry[]> {
  return db.outbox.where('id').above('').and((e) => e.attempts >= MAX_ATTEMPTS).toArray();
}

export async function retryStuckOp(id: string): Promise<void> {
  await db.outbox.update(id, {
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
  });
  triggerImmediateSweep();
}

export async function discardStuckOp(id: string): Promise<void> {
  await db.outbox.delete(id);
}

// ─────────────────────────────────────────────────────────────────
// Dispatch table. Each handler MUST be idempotent — the runner may
// retry on transient network failures even after the server processed
// the op. Use the entry's id as the client-side primary key when
// possible so reinsertions are a no-op.
//
// TODO (per-store rewire): replace each `throw` with a real handler that
// calls the corresponding supabaseDb function with the payload. Then
// update the matching store to write to the outbox INSTEAD of awaiting
// the Supabase call directly. The mirror (Dexie) is the source of truth
// for UI reads while offline; the outbox is the path back to Supabase.
// ─────────────────────────────────────────────────────────────────

async function dispatch(entry: OutboxEntry): Promise<void> {
  switch (entry.kind) {
    case 'transaction.create':
    case 'transaction.update':
    case 'transaction.delete':
    case 'account.update_balance':
    case 'loan.create':
    case 'loan.update':
    case 'budget.create':
    case 'budget.update':
    case 'budget.delete':
    case 'recurring.create':
    case 'recurring.update':
    case 'remittance.create':
      // Scaffold: handlers live in a follow-up PR per store. Until
      // wired, throwing keeps the entry in the outbox so it doesn't get
      // silently dropped.
      throw new Error(`Outbox dispatch not yet implemented for ${entry.kind}`);
    default: {
      const _exhaustive: never = entry.kind;
      throw new Error(`Unknown outbox op kind: ${_exhaustive as string}`);
    }
  }
}
