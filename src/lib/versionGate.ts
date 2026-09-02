// Minimum-supported-version gate (audit 2026-09 item H9 / MF-12).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// Hisaab ships on three release tracks that are NOT synchronised:
//   1. the PWA        — Vercel, deployed on every push to main (minutes);
//   2. the Android app — a hand-built AAB, Play review + staged rollout + a
//      user-driven store update (days to weeks; there is no OTA layer, and the
//      service worker is deliberately disabled on native, src/lib/serviceWorker.ts);
//   3. the database   — 40+ root `supabase-migration-*.sql` files applied BY
//      HAND in Supabase Studio, usually before the code that needs them.
// Track 3 therefore moves ahead of track 2 by default. An installed binary from
// six weeks ago keeps calling RPCs whose contracts have since changed, and most
// money paths log-and-continue rather than fail loudly. Until this file existed
// there was no versions table, no boot compatibility check, and no kill switch.
//
// ─────────────────────────────────────────────────────────────────────────────
// RELEASE POLICY — read before writing a migration
// ─────────────────────────────────────────────────────────────────────────────
//  • Keep every schema/RPC change ADDITIVE and backwards-compatible while there
//    is no OTA path (Capgo/Appflow are named but unbuilt — see
//    docs/updating-the-android-app.md). New nullable columns, new RPCs, new
//    OPTIONAL parameters. Never rename, repurpose, drop, or tighten an existing
//    RPC's contract in place: an old binary is a supported client.
//  • Bump `min_supported_version` / `min_supported_version_code` ONLY when a
//    genuinely breaking migration ships — and only AFTER the fixed build is
//    live on Vercel and rolled out to 100% on Play. Raising the floor before
//    the fix is available locks users out of an app they cannot update.
//  • This is a kill switch, not a nag. It hard-blocks the app with no
//    "remind me later". Cost of a wrong bump is every user, instantly.
//  • The gate FAILS OPEN. A missing row, a network error, an unparseable
//    version — all mean "allowed". We would rather run a stale client than
//    brick a working one because a fetch timed out on a 3G connection.
//  • Both app modes (`full_tracker` and `splits_only`) are treated identically:
//    the skew being defended against is binary-vs-schema, which is
//    mode-agnostic. Nothing here reads or branches on appModeStore.
//
// The same policy is restated at the top of supabase-migration-p1-app-config.sql
// (with the exact Studio UPDATE to run), so whoever touches either side sees it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS COMPARED, AND WHY IT DIFFERS PER SURFACE
// ─────────────────────────────────────────────────────────────────────────────
//  • Web/PWA: the semver from package.json, injected at build time as
//    `__APP_VERSION__` (see vite.config.ts `define`). The deployed bundle IS
//    the version, so semver is the only identity available.
//  • Android: the `versionCode` from android/app/build.gradle, read at runtime
//    via `@capacitor/app`'s getInfo().build. versionCode — not versionName —
//    is the identity Play guarantees is monotonic, and a hotfix can legitimately
//    ship the same versionName with a higher versionCode. Semver is used as the
//    fallback only when the plugin cannot tell us the build number.

import { isNativeRuntime } from './runtime';

/** The `app_config` row, as read by `appConfigDb.get()` (src/lib/supabaseDb.ts). */
export interface AppVersionConfig {
  minSupportedVersion: string | null;
  minSupportedVersionCode: number | null;
  messageEn: string | null;
  messageUr: string | null;
}

/** What this running client is. `currentCode` is null on web (no build number). */
export interface AppVersionIdentity {
  current: string;
  currentCode: number | null;
}

const SEMVER_SEGMENTS = 3;

/**
 * Split a version string into numeric segments.
 *
 * Tolerant on purpose — this value comes from a hand-edited Studio row and a
 * hand-edited package.json, and the consequence of over-strictness is a false
 * lockout. A leading `v` is stripped; pre-release/build metadata
 * (`-beta.1`, `+sha`) is DROPPED rather than ordered (Hisaab ships no
 * pre-releases, and treating `1.4.0-beta` as `1.4.0` fails open); missing
 * segments read as 0, so `1.2` === `1.2.0`; any non-numeric segment reads as 0.
 */
function parseSemver(value: string): number[] {
  const core = String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/, 1)[0];
  const parts = core.split('.');
  const out: number[] = [];
  for (let i = 0; i < SEMVER_SEGMENTS; i += 1) {
    const n = Number.parseInt(parts[i] ?? '', 10);
    out.push(Number.isFinite(n) && n >= 0 ? n : 0);
  }
  return out;
}

/** True when the string looks like something we can meaningfully compare. */
function isComparableSemver(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  return /^v?\d+(\.\d+)*([-+].*)?$/.test(value.trim());
}

/**
 * Numeric semver comparison. Returns <0 if a < b, 0 if equal, >0 if a > b.
 * Segment-wise and numeric, so `1.10.0` > `1.9.0` (a string compare gets this
 * wrong, and getting it wrong here means locking out the newest build).
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < SEMVER_SEGMENTS; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Is this client allowed to run against the current backend?
 *
 * Fails OPEN in every ambiguous case: no config (fetch failed / row missing /
 * migration not applied yet), a floor that isn't a usable version, or a native
 * build whose number we could not read AND whose semver floor is unusable.
 */
export function isSupported(
  identity: AppVersionIdentity,
  config: AppVersionConfig | null | undefined,
): boolean {
  if (!config) return true;

  // Native: versionCode is the authoritative identity. Only compared when BOTH
  // sides are real numbers — if getInfo() failed we fall through to semver
  // rather than guessing.
  if (identity.currentCode !== null && Number.isFinite(identity.currentCode)) {
    const floor = config.minSupportedVersionCode;
    if (typeof floor === 'number' && Number.isFinite(floor)) {
      return identity.currentCode >= floor;
    }
  }

  // Web (and the native fallback): semver.
  if (!isComparableSemver(config.minSupportedVersion)) return true;
  if (!isComparableSemver(identity.current)) return true;
  return compareSemver(identity.current, config.minSupportedVersion) >= 0;
}

/** Copy for the update screen: the server's override, or null to use i18n. */
export function updateMessageFor(
  config: AppVersionConfig | null | undefined,
  lang: 'ur' | 'en',
): string | null {
  if (!config) return null;
  const preferred = lang === 'ur' ? config.messageUr : config.messageEn;
  const fallback = lang === 'ur' ? config.messageEn : config.messageUr;
  const pick = (value: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return pick(preferred) ?? pick(fallback);
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime identity resolution (not pure — excluded from the unit suite)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The semver of this bundle. `__APP_VERSION__` is a build-time constant that
 * Vite substitutes textually (vite.config.ts). The `typeof` guard keeps this
 * safe under Vitest, where no `define` is configured.
 */
export function getCurrentAppVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
}

/**
 * The Android `versionCode` of the installed binary, or null on web / when the
 * plugin is unavailable (older wrapper build). Dynamic import so the plugin
 * stays out of the web bundle — same pattern as src/lib/nativeBridge.ts.
 */
export async function getNativeBuildCode(): Promise<number | null> {
  if (!isNativeRuntime()) return null;
  try {
    const { App: CapApp } = await import('@capacitor/app');
    const info = await CapApp.getInfo();
    const code = Number.parseInt(String(info.build), 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    // Plugin missing or the call threw — fall back to the semver comparison.
    return null;
  }
}

/** Resolve what this client is, for `isSupported()`. */
export async function resolveVersionIdentity(): Promise<AppVersionIdentity> {
  return {
    current: getCurrentAppVersion(),
    currentCode: await getNativeBuildCode(),
  };
}

/** Play Store listing — the only place a native user can get a newer binary. */
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.usehisaab.app';
