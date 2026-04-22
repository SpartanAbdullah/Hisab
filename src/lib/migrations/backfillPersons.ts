// Phase 1B-A: historical backfill of Person rows + person_id FKs.
//
// Scope: strictly backfill. No UI change, no display change. Creates one
// persons row per distinct normalised counterparty name per user, then sets
// person_id on pre-existing loans and loan-related transactions.
//
// Invoked from App.tsx after auth is ready (with a small delay to let the
// rest of boot settle). The function itself ensures the three relevant
// stores are loaded before inspecting data.
//
// Idempotent. Safe to call on every boot: a localStorage flag short-circuits
// subsequent runs, and all writes target rows where person_id IS NULL so
// partial retries cleanly complete remaining work.

import { usePersonStore } from '../../stores/personStore';
import { useLoanStore } from '../../stores/loanStore';
import { useTransactionStore } from '../../stores/transactionStore';
import { loansDb, transactionsDb } from '../supabaseDb';
import type { Loan, Transaction } from '../../db';

const FLAG_KEY = 'hisaab_backfill_persons_v1';
const LOCK_KEY = 'hisaab_backfill_persons_v1:lock';
const DISABLED_KEY = 'hisaab_backfill_persons_v1:disabled';
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_SIZE = 100;
const LARGE_JOB_THRESHOLD = 50;
const IN_SCOPE_TX_TYPES: Transaction['type'][] = ['loan_given', 'loan_taken', 'repayment'];

export interface BackfillResult {
  ran: boolean;
  skippedReason?: 'flag_set' | 'disabled' | 'lock_held' | 'nothing_to_do' | 'not_authenticated';
  personsCreated: number;
  loansUpdated: number;
  transactionsUpdated: number;
  durationMs: number;
}

const ZERO_RESULT = (ran: boolean, skippedReason?: BackfillResult['skippedReason']): BackfillResult => ({
  ran,
  skippedReason,
  personsCreated: 0,
  loansUpdated: 0,
  transactionsUpdated: 0,
  durationMs: 0,
});

// Per-tab in-flight guard so concurrent calls (React StrictMode double-fire,
// rapid remounts) collapse into a single run.
let inflight: Promise<BackfillResult> | null = null;

function normalise(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function flagIsSetForUser(userId: string): boolean {
  try {
    const raw = localStorage.getItem(FLAG_KEY);
    if (!raw) return false;
    const [uid] = raw.split(':');
    return uid === userId;
  } catch {
    return false;
  }
}

function setFlag(userId: string): void {
  try {
    localStorage.setItem(FLAG_KEY, `${userId}:${new Date().toISOString()}`);
  } catch {
    /* storage unavailable — best-effort */
  }
}

function acquireLock(): boolean {
  try {
    const existing = localStorage.getItem(LOCK_KEY);
    if (existing) {
      const t = Date.parse(existing);
      if (Number.isFinite(t) && Date.now() - t < LOCK_TTL_MS) {
        return false; // held by another tab
      }
      // Stale — fall through and overwrite.
    }
    localStorage.setItem(LOCK_KEY, new Date().toISOString());
    return true;
  } catch {
    // If storage is unavailable, proceed without the cross-tab guard. The
    // per-tab inflight promise still prevents local double-runs.
    return true;
  }
}

function releaseLock(): void {
  try {
    localStorage.removeItem(LOCK_KEY);
  } catch {
    /* best-effort */
  }
}

function isDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

async function ensureStoresLoaded(): Promise<void> {
  const personStore = usePersonStore.getState();
  const loanStore = useLoanStore.getState();
  const transactionStore = useTransactionStore.getState();

  const tasks: Promise<unknown>[] = [];
  // Persons may already have been loaded by App.tsx; the load is cheap and
  // idempotent either way.
  tasks.push(personStore.loadPersons());
  if (loanStore.loans.length === 0) tasks.push(loanStore.loadLoans());
  if (transactionStore.transactions.length === 0) tasks.push(transactionStore.loadTransactions());
  await Promise.all(tasks);
}

function needsBackfill(): boolean {
  const loans = useLoanStore.getState().loans;
  const txns = useTransactionStore.getState().transactions;
  const loanNeeds = loans.some(
    (l) => (l.personId == null || l.personId === '') && l.personName && l.personName.trim() !== '',
  );
  if (loanNeeds) return true;
  const txNeeds = txns.some(
    (t) =>
      IN_SCOPE_TX_TYPES.includes(t.type) &&
      (t.personId == null || t.personId === '') &&
      t.relatedPerson != null &&
      t.relatedPerson.trim() !== '',
  );
  return txNeeds;
}

async function runInChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.all(slice.map(fn));
  }
}

async function doRun(userId: string): Promise<BackfillResult> {
  const start = performance.now();

  if (isDisabled()) {
    return { ...ZERO_RESULT(false, 'disabled'), durationMs: performance.now() - start };
  }

  if (flagIsSetForUser(userId)) {
    return { ...ZERO_RESULT(false, 'flag_set'), durationMs: performance.now() - start };
  }

  if (!acquireLock()) {
    return { ...ZERO_RESULT(false, 'lock_held'), durationMs: performance.now() - start };
  }

  let personsCreated = 0;
  let loansUpdated = 0;
  let transactionsUpdated = 0;

  try {
    await ensureStoresLoaded();

    if (!needsBackfill()) {
      setFlag(userId);
      return {
        ran: true,
        skippedReason: 'nothing_to_do',
        personsCreated: 0,
        loansUpdated: 0,
        transactionsUpdated: 0,
        durationMs: performance.now() - start,
      };
    }

    // Reconcile: build nameKey -> personId map, creating persons where needed.
    // Deterministic ordering by createdAt so the oldest spelling wins if a
    // user has multiple cases of the same name.
    const loans = [...useLoanStore.getState().loans].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const txns = [...useTransactionStore.getState().transactions].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    const originalByKey = new Map<string, string>();
    for (const l of loans) {
      const raw = (l.personName ?? '').trim();
      if (!raw) continue;
      const key = normalise(raw);
      if (!key) continue;
      if (!originalByKey.has(key)) originalByKey.set(key, raw);
    }
    for (const t of txns) {
      if (!IN_SCOPE_TX_TYPES.includes(t.type)) continue;
      const raw = (t.relatedPerson ?? '').trim();
      if (!raw) continue;
      const key = normalise(raw);
      if (!key) continue;
      if (!originalByKey.has(key)) originalByKey.set(key, raw);
    }

    const personStore = usePersonStore.getState();
    const existingByKey = new Map<string, string>();
    for (const p of personStore.persons) {
      existingByKey.set(normalise(p.name), p.id);
    }

    const keyToId = new Map<string, string>();
    for (const [key, original] of originalByKey) {
      const existing = existingByKey.get(key);
      if (existing) {
        keyToId.set(key, existing);
        continue;
      }
      // Reuses personStore's in-flight dedupe; also updates store state.
      const person = await personStore.findOrCreateByName(original);
      keyToId.set(key, person.id);
      if (!existing) personsCreated += 1;
    }

    // Loans to update: null person_id + non-empty person_name.
    const loansToUpdate: Loan[] = loans.filter(
      (l) => (l.personId == null || l.personId === '') && !!(l.personName ?? '').trim(),
    );

    if (loansToUpdate.length + txns.length > LARGE_JOB_THRESHOLD) {
      console.info('[hisaab:backfill-persons-v1] large backfill in progress', {
        pendingLoans: loansToUpdate.length,
        scannedTxns: txns.length,
      });
    }

    await runInChunks(loansToUpdate, BATCH_SIZE, async (l) => {
      const key = normalise((l.personName ?? '').trim());
      const personId = keyToId.get(key);
      if (!personId) return;
      await loansDb.setPersonId(l.id, personId);
      useLoanStore.setState((s) => ({
        loans: s.loans.map((row) => (row.id === l.id ? { ...row, personId } : row)),
      }));
      loansUpdated += 1;
    });

    // Transactions to update: in-scope type + null person_id + non-empty related_person.
    const txnsToUpdate: Transaction[] = txns.filter(
      (t) =>
        IN_SCOPE_TX_TYPES.includes(t.type) &&
        (t.personId == null || t.personId === '') &&
        !!(t.relatedPerson ?? '').trim(),
    );

    await runInChunks(txnsToUpdate, BATCH_SIZE, async (t) => {
      const key = normalise((t.relatedPerson ?? '').trim());
      const personId = keyToId.get(key);
      if (!personId) return;
      await transactionsDb.setPersonId(t.id, personId);
      useTransactionStore.setState((s) => ({
        transactions: s.transactions.map((row) => (row.id === t.id ? { ...row, personId } : row)),
      }));
      transactionsUpdated += 1;
    });

    setFlag(userId);

    const durationMs = performance.now() - start;
    console.info('[hisaab:backfill-persons-v1] complete', {
      personsCreated,
      loansUpdated,
      transactionsUpdated,
      durationMs,
    });

    return { ran: true, personsCreated, loansUpdated, transactionsUpdated, durationMs };
  } catch (err) {
    // Do NOT set the flag — next boot retries. Do NOT throw to caller — this
    // is a boot-time effect and must never break the UI.
    console.error('[hisaab:backfill-persons-v1] aborted', err, {
      personsCreated,
      loansUpdated,
      transactionsUpdated,
    });
    return {
      ran: true,
      personsCreated,
      loansUpdated,
      transactionsUpdated,
      durationMs: performance.now() - start,
    };
  } finally {
    releaseLock();
  }
}

export async function runPersonBackfillIfNeeded(userId: string | null | undefined): Promise<BackfillResult> {
  const start = performance.now();
  if (!userId) {
    return { ...ZERO_RESULT(false, 'not_authenticated'), durationMs: performance.now() - start };
  }
  if (inflight) return inflight;
  inflight = doRun(userId).finally(() => {
    inflight = null;
  });
  return inflight;
}
