import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────
// Boot-scoped `profiles` row cache (audit 03-performance M2, 04-supabase §32).
//
// Cold boot used to read the SAME single-row `profiles` record three to four
// times over, from three unrelated call sites that each only wanted one field:
//
//   1. supabaseAuthStore.initialize  → is_deleted            (deleted-account gate)
//   2. supabaseAuthStore.onAuthStateChange(INITIAL_SESSION) → is_deleted  (again)
//   3. onboardingStore.checkOnboarding → onboarding_completed + app_mode
//   4. App.tsx boot effect → name / primary_currency / app_mode / lang
//
// All four resolve within a few hundred ms of each other, against a row that
// cannot change in that window. This module collapses them into ONE request:
// concurrent callers share the in-flight promise, and a caller arriving just
// after it settles reads the memo for FRESH_MS.
//
// Deliberately NOT a general-purpose store:
//   - it is keyed by user id, so a user switch can never serve the wrong row;
//   - the window is short (a boot burst is ~1 s), so nothing outside boot is
//     meaningfully cached and no UI can go stale on it;
//   - `invalidateProfileCache()` is called on every profile WRITE, so an
//     update is never masked by the memo;
//   - direct `profilesDb.getCurrent()` callers (SettingsPage, MyConnectCode,
//     PhoneDiscoverySection) are untouched and keep reading live.
// ─────────────────────────────────────────────────────────────────────────

export type ProfileRow = Record<string, unknown>;

const FRESH_MS = 15_000;

let inflight: { userId: string; promise: Promise<ProfileRow | null> } | null = null;
let memo: { userId: string; row: ProfileRow | null; at: number } | null = null;

async function fetchProfileRow(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return (data as ProfileRow | null) ?? null;
}

/**
 * Read the current user's `profiles` row, sharing one request across every
 * boot-time caller. `force` bypasses both the memo and any in-flight read.
 *
 * Never throws: any PostgREST error (including "no row") resolves to null, so
 * a boot gate decides with what it has — the same failure mode the three
 * original call sites already had (`isDeletedProfile` returned false on error;
 * `profilesDb.getCurrent` returns null on error).
 *
 * The row is fetched by EXPLICIT user id rather than via
 * `profilesDb.getCurrent()`, which derives the id from
 * `localStorage.hisaab_supabase_uid`. `supabaseAuthStore.initialize` runs its
 * deleted-account check BEFORE that key is written, so the localStorage route
 * would fail exactly there and poison the memo with a null row.
 */
export function getCachedProfile(
  userId: string,
  options?: { force?: boolean },
): Promise<ProfileRow | null> {
  if (!userId) return Promise.resolve(null);

  if (options?.force) {
    invalidateProfileCache();
  } else {
    if (memo && memo.userId === userId && Date.now() - memo.at < FRESH_MS) {
      return Promise.resolve(memo.row);
    }
    if (inflight && inflight.userId === userId) return inflight.promise;
  }

  const promise = fetchProfileRow(userId)
    .catch(() => null)
    .then((row) => {
      memo = { userId, row: row ?? null, at: Date.now() };
      return memo.row;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });

  inflight = { userId, promise };
  return promise;
}

/** Drop the memo. Call after any write to `profiles`, and on user change. */
export function invalidateProfileCache(): void {
  memo = null;
  inflight = null;
}
