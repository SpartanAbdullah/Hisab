// One helper, one fallback — audit 2026-09 item UX-34.
//
// THE BUG THIS EXISTS TO KILL
// `localStorage.getItem('hisaab_primary_currency')` was inlined at ~24 call
// sites with TWO different fallbacks. ~19 screens fell back to 'AED'
// (HomePage, TransactionsPage, AccountsPage, BudgetsPage, …) while four fell
// back to 'PKR' (AnalyticsPage, CreateGroupModal, CreateCommitteeModal, the
// QuickEntry confirmation). Whenever the key is missing — a fresh device, a
// cleared browser, a signed-in user whose profile sync hasn't landed yet —
// the same session could create a group in PKR while every balance screen
// reported AED. Group and kameti currency is FIXED AT CREATION, so that is a
// permanent data error, not a cosmetic one.
//
// THE RULE (documented once, here)
// The primary currency is the user's ONBOARDING choice, mirrored from
// profiles.primary_currency into localStorage by App.tsx on sign-in and
// written by onboardingStore.completeOnboarding. localStorage is a cache of
// that server-side choice, never an independent source of truth.
//
// When the cache is missing OR holds a value that is not a supported
// currency, the fallback is AED — because that is what OnboardingPage itself
// pre-selects (`useState<Currency>('AED')`), so it is the value the largest
// share of users actually chose, and because it is what the majority of
// screens already assumed. PKR is never a fallback; it is only ever an
// explicit user choice.
//
// Pure and colocated-tested per the repo's testing philosophy: no React, no
// store import, safe under the Node test environment (vitest.setup.ts
// polyfills localStorage).

// Imported from db/types, not the db barrel: the barrel re-exports the Dexie
// instance, and this module must stay loadable in the Node test environment.
import { CURRENCY_CODES } from './currencies';
import type { Currency } from '../db/types';

/** The localStorage key that mirrors profiles.primary_currency. */
export const PRIMARY_CURRENCY_KEY = 'hisaab_primary_currency';

/**
 * The single fallback used app-wide when no primary currency is known.
 * Matches OnboardingPage's pre-selected default.
 */
export const DEFAULT_PRIMARY_CURRENCY: Currency = 'AED';

// Validated against the FULL ISO 4217 list, not the eight legacy codes
// (founder decision 2026-09-04). Checking the legacy list here would silently
// reset a user who picked USD/GBP/EUR back to AED on every read — the exact
// class of bug this module exists to kill. Deliberately case-SENSITIVE: an
// exact ISO code is what onboarding and profiles.primary_currency write, so
// anything else is a tampered or corrupted mirror, not a currency choice.
function isSupported(value: string | null | undefined): value is Currency {
  return !!value && CURRENCY_CODES.includes(value);
}

/**
 * Narrows an arbitrary stored/remote value to a supported Currency, falling
 * back to DEFAULT_PRIMARY_CURRENCY. Exported so callers that already hold a
 * profile row (or a route param) get the identical rule without touching
 * localStorage.
 */
export function resolvePrimaryCurrency(raw: string | null | undefined): Currency {
  return isSupported(raw) ? raw : DEFAULT_PRIMARY_CURRENCY;
}

/**
 * The user's primary currency. Reads the profile mirror in localStorage and
 * applies the one documented fallback. Never throws — a storage-less
 * environment (SSR, a locked-down WebView, a test) yields the default.
 */
export function getPrimaryCurrency(): Currency {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PRIMARY_CURRENCY;
    return resolvePrimaryCurrency(localStorage.getItem(PRIMARY_CURRENCY_KEY));
  } catch {
    return DEFAULT_PRIMARY_CURRENCY;
  }
}
