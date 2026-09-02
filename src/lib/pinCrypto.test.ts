import { describe, it, expect, beforeEach } from 'vitest';
import {
  PIN_RECORD_KEY,
  PIN_LOCKOUT_KEY,
  PIN_ITERATIONS,
  PIN_FREE_ATTEMPTS,
  PIN_BASE_LOCKOUT_MS,
  PIN_MAX_LOCKOUT_MS,
  EMPTY_LOCKOUT,
  constantTimeEquals,
  createPinRecord,
  verifyPinAgainst,
  parsePinRecord,
  readStoredPin,
  writeStoredPin,
  clearStoredPin,
  hasStoredPin,
  lockoutDelayMs,
  nextLockoutOnFailure,
  isLockedOut,
  remainingLockoutMs,
  parseLockout,
  readLockout,
  writeLockout,
  clearLockout,
} from './pinCrypto';

// The exact v1 scheme the old authStore used: one unsalted SHA-256 round over
// `pin + '_hisaab_salt'`, hex-encoded. Reproduced here so the upgrade path is
// tested against the real legacy bytes, not against our own helper.
async function legacyHash(pin: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pin + '_hisaab_salt'),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Keep the suite fast: full-strength (150k) is exercised once; the rest run
// at a low iteration count, which changes nothing about the code paths.
const FAST = 1_000;

beforeEach(() => {
  localStorage.clear();
});

describe('constantTimeEquals', () => {
  it('matches identical strings and rejects any difference', () => {
    expect(constantTimeEquals('abcd', 'abcd')).toBe(true);
    expect(constantTimeEquals('abcd', 'abce')).toBe(false);
    expect(constantTimeEquals('abcd', 'abc')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });
});

describe('hash / verify (v2 PBKDF2)', () => {
  it('round-trips at full strength and rejects the wrong PIN', async () => {
    const record = await createPinRecord('1234');
    expect(record.v).toBe(2);
    expect(record.iters).toBe(PIN_ITERATIONS);
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(await verifyPinAgainst({ kind: 'v2', record }, '1234')).toEqual({
      ok: true,
      needsUpgrade: false,
    });
    expect((await verifyPinAgainst({ kind: 'v2', record }, '1235')).ok).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    const record = await createPinRecord('9999', FAST);
    expect(JSON.stringify(record)).not.toContain('9999');
  });

  it('uses a fresh random salt per record, so the same PIN hashes differently', async () => {
    const a = await createPinRecord('1234', FAST);
    const b = await createPinRecord('1234', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // ...and each still verifies against its own salt.
    expect((await verifyPinAgainst({ kind: 'v2', record: a }, '1234')).ok).toBe(true);
    expect((await verifyPinAgainst({ kind: 'v2', record: b }, '1234')).ok).toBe(true);
  });

  it('flags an under-strength v2 record for upgrade on success only', async () => {
    const weak = await createPinRecord('4321', FAST);
    expect(await verifyPinAgainst({ kind: 'v2', record: weak }, '4321')).toEqual({
      ok: true,
      needsUpgrade: true,
    });
    expect(await verifyPinAgainst({ kind: 'v2', record: weak }, '0000')).toEqual({
      ok: false,
      needsUpgrade: false,
    });
  });
});

describe('legacy v1 records', () => {
  it('parses a bare 64-char hex digest as v1', async () => {
    const hash = await legacyHash('1234');
    expect(parsePinRecord(hash)).toEqual({ kind: 'v1', hash });
  });

  it('verifies a legacy PIN and asks to be upgraded', async () => {
    const stored = parsePinRecord(await legacyHash('1234'));
    expect(stored).not.toBeNull();
    expect(await verifyPinAgainst(stored!, '1234')).toEqual({ ok: true, needsUpgrade: true });
    expect(await verifyPinAgainst(stored!, '4321')).toEqual({ ok: false, needsUpgrade: false });
  });

  it('upgrades in place: after rewriting as v2 the same PIN still opens it', async () => {
    localStorage.setItem(PIN_RECORD_KEY, await legacyHash('1234'));
    const legacy = readStoredPin();
    expect(legacy?.kind).toBe('v1');

    const { ok, needsUpgrade } = await verifyPinAgainst(legacy!, '1234');
    expect(ok && needsUpgrade).toBe(true);

    // What authStore.verifyPin does on a successful legacy unlock.
    writeStoredPin(await createPinRecord('1234', FAST));

    const upgraded = readStoredPin();
    expect(upgraded?.kind).toBe('v2');
    expect((await verifyPinAgainst(upgraded!, '1234')).ok).toBe(true);
    expect((await verifyPinAgainst(upgraded!, '1111')).ok).toBe(false);
    // The legacy digest is gone from storage.
    expect(localStorage.getItem(PIN_RECORD_KEY)).not.toBe(await legacyHash('1234'));
  });
});

describe('parsePinRecord — malformed input is never "no PIN set" by accident', () => {
  it('returns null for junk, and hasStoredPin follows', () => {
    for (const bad of [null, '', '   ', 'not json {', '{}', '{"v":1}', 'zzzz', '{"v":2,"salt":"ab"}']) {
      expect(parsePinRecord(bad)).toBeNull();
    }
    localStorage.setItem(PIN_RECORD_KEY, 'garbage');
    expect(hasStoredPin()).toBe(false);
  });

  it('rejects a v2 record with a non-hex or zero-iteration field', () => {
    expect(parsePinRecord('{"v":2,"salt":"zz","hash":"ab","iters":1000}')).toBeNull();
    expect(parsePinRecord('{"v":2,"salt":"ab","hash":"zz","iters":1000}')).toBeNull();
    expect(parsePinRecord('{"v":2,"salt":"ab","hash":"cd","iters":0}')).toBeNull();
  });

  it('round-trips through storage helpers', async () => {
    expect(hasStoredPin()).toBe(false);
    const record = await createPinRecord('2468', FAST);
    writeStoredPin(record);
    expect(hasStoredPin()).toBe(true);
    expect(readStoredPin()).toEqual({ kind: 'v2', record });
    clearStoredPin();
    expect(hasStoredPin()).toBe(false);
    expect(readStoredPin()).toBeNull();
  });
});

describe('lockout schedule', () => {
  it('gives PIN_FREE_ATTEMPTS free tries, then escalates by doubling to a 15m cap', () => {
    for (let n = 0; n < PIN_FREE_ATTEMPTS; n++) {
      expect(lockoutDelayMs(n)).toBe(0);
    }
    expect(lockoutDelayMs(5)).toBe(30_000);
    expect(lockoutDelayMs(6)).toBe(60_000);
    expect(lockoutDelayMs(7)).toBe(120_000);
    expect(lockoutDelayMs(8)).toBe(240_000);
    expect(lockoutDelayMs(9)).toBe(480_000);
    // 960_000 would exceed the cap.
    expect(lockoutDelayMs(10)).toBe(PIN_MAX_LOCKOUT_MS);
    expect(lockoutDelayMs(50)).toBe(PIN_MAX_LOCKOUT_MS);
    expect(lockoutDelayMs(5)).toBe(PIN_BASE_LOCKOUT_MS);
  });

  it('accumulates failures and stamps lockedUntil once the free tries are gone', () => {
    const now = 1_000_000;
    let state = EMPTY_LOCKOUT;
    for (let i = 1; i < PIN_FREE_ATTEMPTS; i++) {
      state = nextLockoutOnFailure(state, now);
      expect(state.failedAttempts).toBe(i);
      expect(state.lockedUntil).toBeNull();
      expect(isLockedOut(state, now)).toBe(false);
    }
    state = nextLockoutOnFailure(state, now);
    expect(state.failedAttempts).toBe(PIN_FREE_ATTEMPTS);
    expect(state.lockedUntil).toBe(now + 30_000);
    expect(isLockedOut(state, now)).toBe(true);
    expect(remainingLockoutMs(state, now)).toBe(30_000);

    // Window expires.
    expect(isLockedOut(state, now + 30_000)).toBe(false);
    expect(remainingLockoutMs(state, now + 30_000)).toBe(0);

    // ...but the counter survives, so the NEXT miss costs 60s, not 30s.
    const after = nextLockoutOnFailure(state, now + 30_000);
    expect(after.lockedUntil).toBe(now + 30_000 + 60_000);
  });
});

describe('lockout persistence — a restart must not reset it', () => {
  it('survives a storage round-trip', () => {
    const now = 5_000_000;
    let state = EMPTY_LOCKOUT;
    for (let i = 0; i < PIN_FREE_ATTEMPTS + 2; i++) state = nextLockoutOnFailure(state, now);
    writeLockout(state);

    // Simulate an app restart: nothing in memory, everything re-read.
    expect(readLockout()).toEqual(state);
    expect(isLockedOut(readLockout(), now)).toBe(true);
    expect(remainingLockoutMs(readLockout(), now)).toBe(120_000);
  });

  it('writes nothing (and clears) for an empty state', () => {
    localStorage.setItem(PIN_LOCKOUT_KEY, '{"failedAttempts":3,"lockedUntil":null}');
    writeLockout(EMPTY_LOCKOUT);
    expect(localStorage.getItem(PIN_LOCKOUT_KEY)).toBeNull();
    expect(readLockout()).toEqual(EMPTY_LOCKOUT);
  });

  it('treats tampered / missing state as a clean slate rather than throwing', () => {
    expect(parseLockout(null)).toEqual(EMPTY_LOCKOUT);
    expect(parseLockout('nonsense')).toEqual(EMPTY_LOCKOUT);
    expect(parseLockout('{"failedAttempts":"many","lockedUntil":"soon"}')).toEqual(EMPTY_LOCKOUT);
    expect(parseLockout('{"failedAttempts":-4,"lockedUntil":null}')).toEqual(EMPTY_LOCKOUT);
  });

  it('clearLockout wipes the key', () => {
    writeLockout({ failedAttempts: 9, lockedUntil: 1 });
    expect(localStorage.getItem(PIN_LOCKOUT_KEY)).not.toBeNull();
    clearLockout();
    expect(readLockout()).toEqual(EMPTY_LOCKOUT);
  });
});
