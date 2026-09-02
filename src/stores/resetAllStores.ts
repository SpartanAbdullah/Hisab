// Centralized logout cleanup. Called from supabaseAuthStore.
//
// Clears every Zustand store that holds user-owned or session-tied state so
// the next person who signs in on this device cannot see a millisecond of the
// previous user's accounts, loans, groups, activity, etc. Also wipes the
// user-scoped localStorage keys that back those stores.
//
// ── Why this file is a REGISTRY, not a list ───────────────────────────────
// It used to be 21 hand-written imports plus 21 hand-written `.reset()`
// calls. Audit 2026-09 (architecture H-1) found it had already drifted:
// budgetStore, recurringStore and remittanceStore each defined a reset() that
// nothing in the repo ever called, so user A's budgets and subscription
// templates survived in memory into user B's session on a shared phone — the
// exact leak the comment above promises to prevent.
//
// Both halves are now enrolment-by-default instead of enrolment-by-memory:
//
//   1. Stores are DISCOVERED with `import.meta.glob('./*Store.ts')`. Any new
//      `src/stores/*Store.ts` that exposes a `reset()` action is picked up the
//      moment the file lands — nobody has to remember to edit this file. A
//      store that must NOT be reset has to say so, out loud, in
//      EXCLUDED_STORE_MODULES below.
//   2. localStorage is swept BY PREFIX against a small keep-list of
//      device-level keys, rather than cleared against a list of user keys.
//      A new `hisaab_*` key is therefore cleared by default; only an explicit
//      entry in DEVICE_SCOPED_LOCALSTORAGE_KEYS survives sign-out. (Audit
//      2026-09 security L2: the old allow-list had drifted past
//      hisaab_qe_last_source/dest, which hold the previous user's account
//      UUIDs, and a dozen others.)
//
// Do not import this file from stores themselves — it imports all of them and
// would create cycles.

import { clearLegacyDatabase, clearUserDatabase, getCurrentDatabaseUserId } from '../db/database';

// ─────────────────────────────────────────────────────────────────────────
// Store registry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Store modules that match the glob but are deliberately NOT reset at
 * sign-out. Every entry needs a reason; the registry test asserts this map
 * and the discovered set together account for every `src/stores/*Store.ts`,
 * so silently forgetting a store is not possible.
 *
 * `supabaseAuthStore.ts` is additionally excluded from the glob pattern
 * itself: it imports THIS module, so eagerly importing it back would be a
 * cycle.
 */
export const EXCLUDED_STORE_MODULES: Readonly<Record<string, string>> = {
  './supabaseAuthStore.ts':
    'Owns the sign-out flow and calls this module — importing it back is a cycle. ' +
    'It clears its own user/session state in the same finally block.',
  './themeStore.ts':
    'Device-scoped appearance preference (like language), not user data. ' +
    'Deliberately survives sign-out; the store defines no reset() at all.',
};

/** Minimal structural type for a Zustand vanilla/react store hook. */
type StoreLike = { getState: () => Record<string, unknown> };

function isStoreLike(value: unknown): value is StoreLike {
  return (
    typeof value === 'function' &&
    typeof (value as { getState?: unknown }).getState === 'function'
  );
}

// Eager so the registry is complete before the first sign-out can fire, and
// so a missing store is a build-time/test-time fact rather than a runtime
// surprise. Every one of these modules was already imported by this file
// before the rewrite, so this adds no meaningful bundle weight.
const STORE_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./*Store.ts', '!./supabaseAuthStore.ts'],
  { eager: true },
);

export interface StoreResetEntry {
  /** Module path relative to `src/stores`, e.g. `'./accountStore.ts'`. */
  module: string;
  /** Exported hook name, e.g. `'useAccountStore'`. */
  exportName: string;
  /** Invokes the store's own `reset()` action, read fresh at call time. */
  reset: () => void;
}

function buildStoreResetRegistry(): StoreResetEntry[] {
  const entries: StoreResetEntry[] = [];
  for (const [modulePath, module] of Object.entries(STORE_MODULES)) {
    if (modulePath in EXCLUDED_STORE_MODULES) continue;
    for (const [exportName, exported] of Object.entries(module)) {
      if (!isStoreLike(exported)) continue;
      if (typeof exported.getState().reset !== 'function') continue;
      entries.push({
        module: modulePath,
        exportName,
        // Re-read through getState() so we always call the live action, not a
        // reference captured at module-evaluation time.
        reset: () => {
          const action = exported.getState().reset;
          if (typeof action === 'function') (action as () => void)();
        },
      });
    }
  }
  return entries.sort((a, b) => a.module.localeCompare(b.module));
}

/** Every store that will be reset at sign-out. Exported for the coverage test. */
export const storeResetRegistry: readonly StoreResetEntry[] = buildStoreResetRegistry();

// ─────────────────────────────────────────────────────────────────────────
// localStorage
// ─────────────────────────────────────────────────────────────────────────

/** Prefixes owned by Hisaab. Everything under them is user state unless the
 *  keep-list below says otherwise. (`sb-*` belongs to Supabase auth and is
 *  purged by supabaseAuthStore.clearLocalAuthSession(), not here.) */
const HISAAB_KEY_PREFIXES = ['hisaab_', 'hisaab:'];

/**
 * The ONLY keys that survive sign-out. Everything else under the Hisaab
 * prefixes is treated as belonging to the account that is leaving.
 *
 * Bar for adding an entry: the value must describe the DEVICE, not the
 * person — it must be something you would happily show the next person to
 * pick up this phone.
 */
export const DEVICE_SCOPED_LOCALSTORAGE_KEYS: ReadonlySet<string> = new Set([
  // Interface language. The phone's owner set it; the next signer-in wants it too.
  'hisaab_lang',
  // Light/dark appearance. Same reasoning — themeStore documents itself as device-scoped.
  'hisaab_theme',
  // "Don't show me the PWA install banner again" for THIS browser.
  'hisaab_pwa_dismissed',
]);

function isDeviceScopedKey(key: string): boolean {
  return DEVICE_SCOPED_LOCALSTORAGE_KEYS.has(key);
}

function isHisaabKey(key: string): boolean {
  return HISAAB_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** True when this key must be removed at sign-out. Exported for the test. */
export function isUserScopedStorageKey(key: string): boolean {
  return isHisaabKey(key) && !isDeviceScopedKey(key);
}

/** Removes every user-scoped Hisaab key from one Storage.
 *  Enumerated via length/key(i) — the spec surface every Storage
 *  implementation supports — and snapshotted before deleting, because
 *  removeItem() reindexes a live Storage and a forward loop would skip keys. */
function sweepStorage(storage: Storage): void {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && isUserScopedStorageKey(key)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

// ─────────────────────────────────────────────────────────────────────────

export async function resetAllUserStores(userId = getCurrentDatabaseUserId()): Promise<void> {
  for (const entry of storeResetRegistry) {
    try {
      entry.reset();
    } catch (err) {
      // One store's reset must never abort the others — a half-cleared device
      // is the leak we are here to prevent.
      console.error(`[resetAllUserStores] ${entry.exportName} reset failed (continuing)`, err);
    }
  }

  // Wipes every `hisaab_*` / `hisaab:*` key except the device-level keep-list.
  // That covers the previous user's name, email, currency, app mode, PIN hash
  // and lockout, onboarding + backfill state, remembered Quick Entry accounts,
  // flex-income figure, net-worth snapshots, settlement snoozes, wrap/quote
  // cadence stamps, the reminder opt-in, the FCM token record, and the
  // `hisaab:mirror:*` sync stamps for every user partition on this device.
  try {
    sweepStorage(localStorage);
  } catch (err) {
    console.error('[resetAllUserStores] localStorage sweep failed (continuing)', err);
  }
  try {
    // Same rule for sessionStorage (hisaab_just_verified, the budget-warning
    // dismissal). Short-lived, but free to clear and one less thing to reason
    // about when a second account signs in without closing the tab.
    sweepStorage(sessionStorage);
  } catch (err) {
    console.error('[resetAllUserStores] sessionStorage sweep failed (continuing)', err);
  }

  // Wipe IndexedDB tables. Even though most stores write directly to Supabase
  // (not Dexie), the outbox table and the mirror schema can hold payloads
  // that include user PII (account ids, person names, amounts). Leaving them
  // on a shared device would expose the previous user's state to the next.
  // Await partition deletion before another account can hydrate.
  const results = await Promise.allSettled([
    clearUserDatabase(userId),
    clearLegacyDatabase(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[resetAllUserStores] Dexie wipe failed (non-fatal)', result.reason);
    }
  }
}
