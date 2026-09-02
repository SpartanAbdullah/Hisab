import { create } from 'zustand';
import {
  PIN_RECORD_KEY,
  EMPTY_LOCKOUT,
  clearLockout,
  clearStoredPin,
  createPinRecord,
  hasStoredPin,
  isLockedOut,
  nextLockoutOnFailure,
  readLockout,
  readStoredPin,
  verifyPinAgainst,
  writeLockout,
  writeStoredPin,
  type PinLockoutState,
} from '../lib/pinCrypto';
import { reportError } from '../lib/errorReporter';

// Device PIN state. The hashing, the record format, and the lockout schedule
// all live in src/lib/pinCrypto.ts (unit-tested); this store is the React-facing
// wrapper plus the persistence of the lockout across restarts.
//
// Audit 2026-09 (H7/SEC-13): this store used to hash a 4-digit PIN with a single
// unsalted SHA-256 round and keep the lockout in memory only, so a refresh reset
// it — and nothing in the app ever rendered the lock screen anyway. The gate now
// lives in App.tsx (cold start + resume after PIN_RELOCK_AFTER_MS backgrounded).

interface AuthState {
  hasPin: boolean;
  isLocked: boolean;
  identifier: string;
  failedAttempts: number;
  lockedUntil: number | null;

  checkAuth: () => void;
  setPin: (pin: string) => Promise<void>;
  removePin: () => void;
  verifyPin: (pin: string) => Promise<boolean>;
  lock: () => void;
  setIdentifier: (id: string) => void;
  reset: () => void;
}

/**
 * A PIN record that exists but does not parse (a truncated write, or a tampered
 * "backup" import — see audit M8) must NOT read as "no PIN set". We keep the
 * device locked and let the user out only through Forgot PIN → sign out.
 */
function isPinRecordCorrupt(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PIN_RECORD_KEY);
  } catch {
    return false;
  }
  if (!raw || !raw.trim()) return false;
  return readStoredPin() === null;
}

function pinIsConfigured(): boolean {
  return hasStoredPin() || isPinRecordCorrupt();
}

function initialLockout(): PinLockoutState {
  try {
    return readLockout();
  } catch (err) {
    // A lockout record we cannot read is a security control we cannot honour.
    reportError(err, { feature: 'authStore.initialLockout' });
    return EMPTY_LOCKOUT;
  }
}

const bootPin = pinIsConfigured();
const bootLockout = initialLockout();

export const useAuthStore = create<AuthState>((set, get) => ({
  hasPin: bootPin,
  // Cold start is always locked when a PIN exists — that is the whole point of
  // the feature, and the store is constructed once per app launch.
  isLocked: bootPin,
  identifier: localStorage.getItem('hisaab_identifier') ?? '',
  failedAttempts: bootLockout.failedAttempts,
  lockedUntil: bootLockout.lockedUntil,

  checkAuth: () => {
    const hasPin = pinIsConfigured();
    const lockout = initialLockout();
    set({
      hasPin,
      isLocked: hasPin,
      identifier: localStorage.getItem('hisaab_identifier') ?? '',
      failedAttempts: lockout.failedAttempts,
      lockedUntil: lockout.lockedUntil,
    });
  },

  setPin: async (pin) => {
    // Throws if WebCrypto is unavailable (insecure origin / ancient WebView).
    // The caller surfaces that rather than pretending a PIN was set.
    const record = await createPinRecord(pin);
    writeStoredPin(record);
    clearLockout();
    set({ hasPin: true, isLocked: false, failedAttempts: 0, lockedUntil: null });
  },

  removePin: () => {
    clearStoredPin();
    clearLockout();
    set({ hasPin: false, isLocked: false, failedAttempts: 0, lockedUntil: null });
  },

  verifyPin: async (pin) => {
    const now = Date.now();

    // Re-read the persisted lockout: another tab (or this tab, before a reload)
    // may have burned attempts that in-memory state never saw.
    const persisted = initialLockout();
    const memory: PinLockoutState = {
      failedAttempts: get().failedAttempts,
      lockedUntil: get().lockedUntil,
    };
    const state = persisted.failedAttempts >= memory.failedAttempts ? persisted : memory;
    if (state.failedAttempts !== memory.failedAttempts || state.lockedUntil !== memory.lockedUntil) {
      set({ failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil });
    }
    if (isLockedOut(state, now)) return false;

    if (isPinRecordCorrupt()) {
      // Something rewrote the record. Stay locked; Forgot PIN is the way out.
      set({ hasPin: true, isLocked: true });
      return false;
    }

    const stored = readStoredPin();
    if (!stored) {
      // No PIN is configured at all (removed in Settings, or cleared on sign-out
      // while this screen was mounted). There is nothing to verify against, so
      // drop the gate instead of trapping the owner out of their own data.
      clearLockout();
      set({ hasPin: false, isLocked: false, failedAttempts: 0, lockedUntil: null });
      return true;
    }

    let result: { ok: boolean; needsUpgrade: boolean };
    try {
      result = await verifyPinAgainst(stored, pin);
    } catch (err) {
      // WebCrypto unavailable — we cannot prove the PIN, so we must not open.
      reportError(err, { feature: 'authStore.verifyPin' });
      return false;
    }

    if (result.ok) {
      if (result.needsUpgrade) {
        // Transparent upgrade: a legacy v1 (unsalted SHA-256) record, or a v2
        // record hashed with fewer rounds than we now use, is rewritten at full
        // strength the first time the correct PIN proves itself. Best effort —
        // a failed rewrite must not block a legitimate unlock.
        try {
          writeStoredPin(await createPinRecord(pin));
        } catch (err) {
          reportError(err, { feature: 'authStore.upgradePinRecord' });
        }
      }
      clearLockout();
      set({ isLocked: false, failedAttempts: 0, lockedUntil: null });
      return true;
    }

    const next = nextLockoutOnFailure(state, now);
    writeLockout(next);
    set({ failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil });
    return false;
  },

  // Re-derives hasPin from storage so a lock() after the PIN was removed is a
  // no-op rather than an unopenable screen.
  lock: () => {
    const hasPin = pinIsConfigured();
    set({ hasPin, isLocked: hasPin });
  },

  setIdentifier: (id) => {
    localStorage.setItem('hisaab_identifier', id);
    set({ identifier: id });
  },

  // Local PIN belongs to the prior identity. resetAllUserStores clears
  // `hisaab_pin_hash` and `hisaab_identifier` itself; the lockout key is ours
  // alone, so clear it here or a signed-out device stays timed out.
  reset: () => {
    clearLockout();
    set({
      hasPin: false,
      isLocked: false,
      identifier: '',
      failedAttempts: 0,
      lockedUntil: null,
    });
  },
}));
