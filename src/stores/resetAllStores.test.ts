// Guards the sign-out cleanup contract.
//
// Audit 2026-09 (architecture H-1): resetAllStores.ts used to be a
// hand-maintained list of imports and `.reset()` calls, and it had already
// drifted — budgetStore, recurringStore and remittanceStore each defined a
// reset() that nothing ever called, so the previous user's budgets and
// subscription templates survived in memory into the next session on a shared
// phone. The list is now a registry built from `import.meta.glob`; these tests
// are what make "a new store cannot be forgotten" true rather than aspirational.
//
// Two independent views are compared on purpose:
//   - the RUNTIME registry (what resetAllUserStores will actually call), and
//   - the FILESYSTEM (what stores exist, and which of them declare a reset()).
// A store that exists but is neither registered nor explicitly excluded fails
// the suite.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SCOPED_LOCALSTORAGE_KEYS,
  EXCLUDED_STORE_MODULES,
  isUserScopedStorageKey,
  resetAllUserStores,
  storeResetRegistry,
} from './resetAllStores';

const STORES_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Every `src/stores/*Store.ts` on disk, as glob-relative module paths. */
function storeModulePaths(): string[] {
  return readdirSync(STORES_DIR)
    .filter((name) => name.endsWith('Store.ts') && !name.endsWith('.test.ts'))
    .map((name) => `./${name}`)
    .sort();
}

/** Heuristic that matches how the stores in this repo declare their reset
 *  action (`reset: () => ...` inside the create() literal). */
function declaresResetAction(modulePath: string): boolean {
  const source = readFileSync(new URL(modulePath, import.meta.url), 'utf8');
  return /^\s*reset:\s*\(\)\s*=>/m.test(source);
}

describe('store reset registry', () => {
  it('discovers at least the stores the old hand-written list covered', () => {
    // The pre-rewrite list had 21 entries; the registry must never shrink
    // below that without someone adding an explicit exclusion.
    expect(storeResetRegistry.length).toBeGreaterThanOrEqual(21);
  });

  it('registers every store module exactly once', () => {
    const modules = storeResetRegistry.map((entry) => entry.module);
    expect(modules).toHaveLength(new Set(modules).size);

    const exportNames = storeResetRegistry.map((entry) => entry.exportName);
    expect(exportNames).toHaveLength(new Set(exportNames).size);
  });

  it('accounts for every store file on disk — registered or explicitly excluded', () => {
    const registered = new Set(storeResetRegistry.map((entry) => entry.module));
    const unaccounted = storeModulePaths().filter(
      (modulePath) => !registered.has(modulePath) && !(modulePath in EXCLUDED_STORE_MODULES),
    );
    expect(unaccounted).toEqual([]);
  });

  it('resets every store that declares a reset() action', () => {
    const registered = new Set(storeResetRegistry.map((entry) => entry.module));
    const orphaned = storeModulePaths().filter(
      (modulePath) => declaresResetAction(modulePath) && !registered.has(modulePath),
    );
    // This is the exact H-1 failure mode: a store defines reset() and nothing
    // calls it.
    expect(orphaned).toEqual([]);
  });

  it('keeps the three stores that H-1 found leaking', () => {
    const registered = new Set(storeResetRegistry.map((entry) => entry.module));
    expect(registered.has('./budgetStore.ts')).toBe(true);
    expect(registered.has('./recurringStore.ts')).toBe(true);
    expect(registered.has('./remittanceStore.ts')).toBe(true);
  });

  it('covers the full user-data surface named in the audit', () => {
    const registered = new Set(storeResetRegistry.map((entry) => entry.module));
    for (const name of [
      'account', 'activity', 'appMode', 'auth', 'budget', 'committee',
      'contactLink', 'customCategory', 'emi', 'goal', 'investment',
      'linkedRequest', 'loan', 'notification', 'onboarding', 'person',
      'phoneDiscovery', 'recurring', 'remittance', 'settlementRequest',
      'split', 'transaction', 'ui', 'upcomingExpense',
    ]) {
      expect(registered, `${name}Store must be reset at sign-out`).toContain(`./${name}Store.ts`);
    }
  });

  it('does not carry stale exclusions, and every exclusion states a reason', () => {
    const onDisk = new Set(storeModulePaths());
    for (const [modulePath, reason] of Object.entries(EXCLUDED_STORE_MODULES)) {
      expect(onDisk.has(modulePath), `${modulePath} is excluded but no longer exists`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('excludes only the auth store (cycle) and the theme store (device-scoped)', () => {
    expect(Object.keys(EXCLUDED_STORE_MODULES).sort()).toEqual([
      './supabaseAuthStore.ts',
      './themeStore.ts',
    ]);
  });

  it('exposes a callable reset for every entry', () => {
    for (const entry of storeResetRegistry) {
      expect(typeof entry.reset, entry.module).toBe('function');
      expect(() => entry.reset()).not.toThrow();
    }
  });
});

describe('localStorage sign-out classification', () => {
  it('treats every known per-user key as user-scoped', () => {
    const userKeys = [
      'hisaab_user_name', 'hisaab_email', 'hisaab_identifier', 'hisaab_mobile',
      'hisaab_primary_currency', 'hisaab_app_mode', 'hisaab_onboarded',
      'hisaab_onboarding_intent', 'hisaab_data_version', 'hisaab_pending_invite',
      'hisaab_pin_hash', 'hisaab_pin_lockout', 'hisaab_ai_persona',
      'hisaab_flex_income', 'hisaab_check_last', 'hisaab_net_snapshots',
      'hisaab_qe_last_source', 'hisaab_qe_last_dest', 'hisaab_push_token',
      'hisaab_settlement_snoozes_v1', 'hisaab_wrap_last_shown_v1',
      'hisaab_member_legend_dismissed', 'hisaab_budget_warning_dismissed_v1',
      'hisaab_recurring_run_lock_v1', 'hisaab_payment_reminders_enabled',
      'hisaab_daily_quote_enabled', 'hisaab_quote_last_shown',
      'hisaab_backfill_persons_v1', 'hisaab_backfill_persons_v1:lock',
      'hisaab_backfill_persons_v1:disabled', 'hisaab_supabase_uid',
      'hisaab:mirror:some-uid:accounts:syncedAt',
    ];
    for (const key of userKeys) {
      expect(isUserScopedStorageKey(key), key).toBe(true);
    }
  });

  it('keeps device-level keys', () => {
    for (const key of DEVICE_SCOPED_LOCALSTORAGE_KEYS) {
      expect(isUserScopedStorageKey(key), key).toBe(false);
    }
    expect([...DEVICE_SCOPED_LOCALSTORAGE_KEYS].sort()).toEqual([
      'hisaab_lang', 'hisaab_pwa_dismissed', 'hisaab_theme',
    ]);
  });

  it('clears unknown hisaab_ keys by default (fail-safe against drift)', () => {
    expect(isUserScopedStorageKey('hisaab_some_future_key')).toBe(true);
    expect(isUserScopedStorageKey('hisaab:some:future:key')).toBe(true);
  });

  it('leaves keys it does not own alone', () => {
    // Supabase auth keys are purged by supabaseAuthStore.clearLocalAuthSession().
    expect(isUserScopedStorageKey('sb-abcdef-auth-token')).toBe(false);
    expect(isUserScopedStorageKey('theme')).toBe(false);
  });
});

describe('resetAllUserStores', () => {
  beforeEach(() => {
    // Dexie has no indexedDB under Node; the wipe rejects and is logged.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('sweeps user keys from localStorage and sessionStorage but keeps device keys', async () => {
    localStorage.setItem('hisaab_user_name', 'Asif');
    localStorage.setItem('hisaab_qe_last_source', 'acc-uuid-1');
    localStorage.setItem('hisaab_net_snapshots', '[{"net":1234}]');
    localStorage.setItem('hisaab:mirror:user-1:accounts:syncedAt', '123');
    localStorage.setItem('hisaab_lang', 'ur');
    localStorage.setItem('hisaab_theme', 'dark');
    localStorage.setItem('sb-project-auth-token', 'not-ours');
    sessionStorage.setItem('hisaab_just_verified', '1');

    await resetAllUserStores('user-1');

    expect(localStorage.getItem('hisaab_user_name')).toBeNull();
    expect(localStorage.getItem('hisaab_qe_last_source')).toBeNull();
    expect(localStorage.getItem('hisaab_net_snapshots')).toBeNull();
    expect(localStorage.getItem('hisaab:mirror:user-1:accounts:syncedAt')).toBeNull();
    expect(sessionStorage.getItem('hisaab_just_verified')).toBeNull();

    expect(localStorage.getItem('hisaab_lang')).toBe('ur');
    expect(localStorage.getItem('hisaab_theme')).toBe('dark');
    expect(localStorage.getItem('sb-project-auth-token')).toBe('not-ours');
  });

  it('never rejects, even when the Dexie wipe fails', async () => {
    await expect(resetAllUserStores('user-1')).resolves.toBeUndefined();
  });
});
