// Device PIN: hashing, verification, and brute-force lockout.
//
// Audit 2026-09 (SEC-13 / H7-sub) killed the original scheme: a 4-digit PIN
// run through ONE unsalted SHA-256 round with a hardcoded string ("_hisaab_salt")
// and an in-memory-only lockout that a page refresh reset. A 10,000-entry
// keyspace with a constant salt is a rainbow table someone already has; the
// lockout was decoration.
//
// v2 is PBKDF2-SHA256, 150k iterations, a random per-device 16-byte salt, and
// a lockout persisted to localStorage so killing the app doesn't reset it.
// 150k rounds costs a legitimate user ~100-200ms once per unlock, and turns an
// offline sweep of 10,000 PINs into ~30 minutes of CPU per stolen record —
// enough friction that a snatched phone isn't a free read of the owner's khata.
//
// v1 records are still verified (once) so nobody's existing PIN stops working;
// the first successful v1 unlock rewrites the record as v2. See upgradePin().
//
// Everything here is pure/storage-level so it can be unit-tested in Node
// (vitest runs `environment: 'node'`, where globalThis.crypto.subtle exists on
// Node 20+, and vitest.setup.ts polyfills localStorage).

/** localStorage key holding the PIN record. Kept from v1 so existing PINs are found. */
export const PIN_RECORD_KEY = 'hisaab_pin_hash';
/** localStorage key holding the persisted failed-attempt / lockout state. */
export const PIN_LOCKOUT_KEY = 'hisaab_pin_lockout';

/** PBKDF2 rounds for newly created records. Stored per-record so it can be raised later. */
export const PIN_ITERATIONS = 150_000;
/** Derived key length in bits. */
const PIN_HASH_BITS = 256;
/** Salt length in bytes. */
const PIN_SALT_BYTES = 16;

/** Wrong attempts allowed before the first timed lockout. */
export const PIN_FREE_ATTEMPTS = 5;
/** First lockout duration, in ms. Doubles for each further wrong attempt. */
export const PIN_BASE_LOCKOUT_MS = 30_000;
/** Lockout ceiling, in ms (15 minutes). */
export const PIN_MAX_LOCKOUT_MS = 15 * 60_000;

/**
 * How long the app may sit in the background before the PIN is demanded again.
 * Short enough that a handed-over phone re-locks; long enough that flipping to
 * the camera/WhatsApp to check a receipt mid-entry doesn't punish the owner.
 */
export const PIN_RELOCK_AFTER_MS = 60_000;

/** The legacy (v1) hash was SHA-256 over `pin + LEGACY_SALT`. */
const LEGACY_SALT = '_hisaab_salt';

export interface PinRecordV2 {
  v: 2;
  /** hex-encoded random salt */
  salt: string;
  /** hex-encoded PBKDF2 output */
  hash: string;
  /** iterations actually used for `hash` */
  iters: number;
}

export type StoredPin =
  | { kind: 'v2'; record: PinRecordV2 }
  | { kind: 'v1'; hash: string };

export interface PinLockoutState {
  /** Consecutive wrong attempts since the last success. */
  failedAttempts: number;
  /** Epoch ms until which entry is refused, or null. */
  lockedUntil: number | null;
}

export const EMPTY_LOCKOUT: PinLockoutState = { failedAttempts: 0, lockedUntil: null };

// ── encoding helpers ────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // Non-secure origin (plain http://, not localhost) or an ancient WebView.
    // Callers must treat this as "cannot verify" — never as "unlocked".
    throw new Error('WebCrypto unavailable — PIN cannot be verified on this device');
  }
  return c.subtle;
}

/**
 * Length-independent constant-time-ish comparison of two hex strings.
 * Returns false for a length mismatch, but only after a fixed-cost pass so the
 * timing of a same-length near-miss carries no information about which byte
 * differed. (The length itself is not a secret — hash width is fixed by v.)
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ── hashing ─────────────────────────────────────────────────────────────────

async function pbkdf2Hex(pin: string, saltHex: string, iterations: number): Promise<string> {
  const s = subtle();
  const key = await s.importKey(
    'raw',
    new TextEncoder().encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const salt = fromHex(saltHex);
  const bits = await s.deriveBits(
    // BufferSource typing across lib.dom / node differs on Uint8Array<ArrayBufferLike>.
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PIN_HASH_BITS,
  );
  return toHex(new Uint8Array(bits));
}

/** The exact v1 scheme, reproduced so legacy records still verify. */
async function legacySha256Hex(pin: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(pin + LEGACY_SALT));
  return toHex(new Uint8Array(digest));
}

function randomSaltHex(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('Secure randomness unavailable — cannot create a PIN');
  const salt = new Uint8Array(PIN_SALT_BYTES);
  c.getRandomValues(salt);
  return toHex(salt);
}

/** Build a fresh v2 record for `pin`. */
export async function createPinRecord(pin: string, iterations = PIN_ITERATIONS): Promise<PinRecordV2> {
  const salt = randomSaltHex();
  const hash = await pbkdf2Hex(pin, salt, iterations);
  return { v: 2, salt, hash, iters: iterations };
}

/**
 * Verify `pin` against a parsed record.
 * `needsUpgrade` is true when the record verified but is not current-strength
 * (a v1 record, or a v2 record hashed with fewer rounds than we now use) —
 * the caller should re-write it with createPinRecord on success.
 */
export async function verifyPinAgainst(
  stored: StoredPin,
  pin: string,
): Promise<{ ok: boolean; needsUpgrade: boolean }> {
  if (stored.kind === 'v1') {
    const ok = constantTimeEquals(await legacySha256Hex(pin), stored.hash);
    return { ok, needsUpgrade: ok };
  }
  const { salt, hash, iters } = stored.record;
  const ok = constantTimeEquals(await pbkdf2Hex(pin, salt, iters), hash);
  return { ok, needsUpgrade: ok && iters < PIN_ITERATIONS };
}

// ── record storage ──────────────────────────────────────────────────────────

/**
 * Parse whatever is under PIN_RECORD_KEY.
 * v1 wrote a bare 64-char hex digest; v2 writes JSON. Anything else (a
 * truncated write, a tampered backup import) parses to null — and a null
 * record while the caller believes a PIN is set must mean LOCKED, never open.
 */
export function parsePinRecord(raw: string | null): StoredPin | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<PinRecordV2>;
      if (
        parsed?.v === 2 &&
        typeof parsed.salt === 'string' && /^[0-9a-f]+$/i.test(parsed.salt) &&
        typeof parsed.hash === 'string' && /^[0-9a-f]+$/i.test(parsed.hash) &&
        typeof parsed.iters === 'number' && Number.isFinite(parsed.iters) && parsed.iters > 0
      ) {
        return { kind: 'v2', record: { v: 2, salt: parsed.salt, hash: parsed.hash, iters: parsed.iters } };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return { kind: 'v1', hash: trimmed };
  return null;
}

export function readStoredPin(): StoredPin | null {
  try {
    return parsePinRecord(localStorage.getItem(PIN_RECORD_KEY));
  } catch {
    return null;
  }
}

export function writeStoredPin(record: PinRecordV2): void {
  localStorage.setItem(PIN_RECORD_KEY, JSON.stringify(record));
}

export function clearStoredPin(): void {
  try {
    localStorage.removeItem(PIN_RECORD_KEY);
  } catch { /* storage off */ }
}

/** True when *anything* usable is stored — i.e. the app must show the lock screen. */
export function hasStoredPin(): boolean {
  return readStoredPin() !== null;
}

// ── lockout schedule ────────────────────────────────────────────────────────

/**
 * How long to lock out after `failedAttempts` consecutive wrong entries.
 * 1-4 → 0 (no delay), 5 → 30s, 6 → 60s, 7 → 2m, 8 → 4m, 9 → 8m, 10+ → 15m cap.
 */
export function lockoutDelayMs(failedAttempts: number): number {
  if (failedAttempts < PIN_FREE_ATTEMPTS) return 0;
  const steps = failedAttempts - PIN_FREE_ATTEMPTS;
  // 2**steps overflows to Infinity long before it matters; Math.min handles it.
  const delay = PIN_BASE_LOCKOUT_MS * Math.pow(2, steps);
  return Math.min(delay, PIN_MAX_LOCKOUT_MS);
}

/** Next persisted state after one wrong entry. */
export function nextLockoutOnFailure(prev: PinLockoutState, now: number): PinLockoutState {
  const failedAttempts = prev.failedAttempts + 1;
  const delay = lockoutDelayMs(failedAttempts);
  return { failedAttempts, lockedUntil: delay > 0 ? now + delay : null };
}

export function isLockedOut(state: PinLockoutState, now: number): boolean {
  return state.lockedUntil !== null && now < state.lockedUntil;
}

export function remainingLockoutMs(state: PinLockoutState, now: number): number {
  if (!isLockedOut(state, now)) return 0;
  return (state.lockedUntil as number) - now;
}

export function parseLockout(raw: string | null): PinLockoutState {
  if (!raw) return EMPTY_LOCKOUT;
  try {
    const parsed = JSON.parse(raw) as Partial<PinLockoutState>;
    const failedAttempts =
      typeof parsed?.failedAttempts === 'number' && Number.isFinite(parsed.failedAttempts) && parsed.failedAttempts > 0
        ? Math.floor(parsed.failedAttempts)
        : 0;
    const lockedUntil =
      typeof parsed?.lockedUntil === 'number' && Number.isFinite(parsed.lockedUntil)
        ? parsed.lockedUntil
        : null;
    return { failedAttempts, lockedUntil };
  } catch {
    return EMPTY_LOCKOUT;
  }
}

export function readLockout(): PinLockoutState {
  try {
    return parseLockout(localStorage.getItem(PIN_LOCKOUT_KEY));
  } catch {
    return EMPTY_LOCKOUT;
  }
}

export function writeLockout(state: PinLockoutState): void {
  try {
    if (state.failedAttempts === 0 && state.lockedUntil === null) {
      localStorage.removeItem(PIN_LOCKOUT_KEY);
      return;
    }
    localStorage.setItem(PIN_LOCKOUT_KEY, JSON.stringify(state));
  } catch { /* storage off — lockout degrades to in-memory only */ }
}

export function clearLockout(): void {
  try {
    localStorage.removeItem(PIN_LOCKOUT_KEY);
  } catch { /* storage off */ }
}
