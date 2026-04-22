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

export function buildInviteUrl(token: string): string {
  if (typeof window === 'undefined') return `/join/${token}`;
  return `${window.location.origin}/join/${token}`;
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
  return personsDb.lookupProfileByCode(normalised);
}
