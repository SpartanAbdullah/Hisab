const PUBLIC_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let output = '';
  for (let i = 0; i < bytes.length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

export function generatePublicCodeCandidate(): string {
  return `HSB-${randomString(6, PUBLIC_CODE_ALPHABET)}`;
}

export function generateGroupCodeCandidate(): string {
  return `GRP-${randomString(6, PUBLIC_CODE_ALPHABET)}`;
}

// Strips prefix (HSB-/GRP-), @ sigil, hyphens, and whitespace. Uppercases.
// Normalized form is what's stored in *_normalized columns and what lookup
// functions match against, so "hsb-xyz" and "XYZ" both resolve.
export function normalizePublicCode(code: string): string {
  return code.trim().replace(/^@/, '').replace(/[-\s]/g, '').toUpperCase().replace(/^HSB/, '');
}

export function normalizeGroupCode(code: string): string {
  return code.trim().replace(/^@/, '').replace(/[-\s]/g, '').toUpperCase().replace(/^GRP/, '');
}

export function generateInviteToken(): string {
  return randomString(24, INVITE_ALPHABET);
}

export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getPublicAppUrl(): string {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL as string | undefined;
  const fallbackUrl = typeof window === 'undefined' ? '' : window.location.origin;
  return (configuredUrl?.trim() || fallbackUrl).replace(/\/+$/, '');
}

export function buildAppShareUrl(): string {
  return getPublicAppUrl() || '/';
}

export function buildInviteUrl(token: string): string {
  const publicAppUrl = getPublicAppUrl();
  return publicAppUrl ? `${publicAppUrl}/join/${token}` : `/join/${token}`;
}

// ── Code-lookup budget (audit 2026-09, C6) ─────────────────────────────────
// The server allows 20 code lookups per rolling hour per user, and BOTH
// lookup_profile_by_code (the preview) and link_contact_by_code (the write)
// charge the same window — so the current preview-then-link flow costs 2 per
// completed link. lookup_profile_by_code answers a throttled caller with ZERO
// ROWS, deliberately indistinguishable from "no such code", so the client
// cannot be told it was limited. This mirror of the window exists only to pick
// better copy for a null preview: it counts the charges THIS tab made, so it
// under-reports (never over-reports) and a false "rate limited" message is
// therefore not reachable from a fresh session.
const LOOKUP_WINDOW_MS = 60 * 60 * 1000;
const LOOKUP_BUDGET = 20;
let codeLookupCharges: number[] = [];

/** Record one charge against the shared code_lookup_attempts window. Called by
 *  the preview here and by the link RPC's caller (personStore). */
export function recordCodeLookupCharge(): void {
  const now = Date.now();
  codeLookupCharges = codeLookupCharges.filter((at) => now - at < LOOKUP_WINDOW_MS);
  codeLookupCharges.push(now);
}

/** True when this tab has already spent the hourly budget — i.e. a null
 *  lookup is more likely a throttle than a genuine miss. Heuristic only. */
export function codeLookupBudgetSpent(): boolean {
  const now = Date.now();
  codeLookupCharges = codeLookupCharges.filter((at) => now - at < LOOKUP_WINDOW_MS);
  return codeLookupCharges.length >= LOOKUP_BUDGET;
}

/** Test seam — clears the local mirror of the window. */
export function resetCodeLookupBudget(): void {
  codeLookupCharges = [];
}

// Phase 2A: single place that turns a raw user-entered code into a resolved
// profile (or null). Normalises input, calls the RPC, narrows the shape.
// Callers must gate invocation behind an explicit user action — do NOT call
// on every keystroke.
export async function resolveProfileByCode(
  rawCode: string,
): Promise<{ profileId: string; displayName: string } | null> {
  const normalised = normalizePublicCode(rawCode);
  if (!normalised) return null;
  // Import lazily to avoid a cycle with supabaseDb (which imports lib/).
  const { personsDb } = await import('./supabaseDb');
  recordCodeLookupCharge();
  return personsDb.lookupProfileByCode(normalised);
}
