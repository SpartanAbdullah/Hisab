import { create } from 'zustand';

async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + '_hisaab_salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hasPin: !!localStorage.getItem('hisaab_pin_hash'),
  isLocked: !!localStorage.getItem('hisaab_pin_hash'),
  identifier: localStorage.getItem('hisaab_identifier') ?? '',
  failedAttempts: 0,
  lockedUntil: null,

  checkAuth: () => {
    const hasPin = !!localStorage.getItem('hisaab_pin_hash');
    set({ hasPin, isLocked: hasPin, identifier: localStorage.getItem('hisaab_identifier') ?? '' });
  },

  setPin: async (pin) => {
    const hashed = await hashPin(pin);
    localStorage.setItem('hisaab_pin_hash', hashed);
    set({ hasPin: true, isLocked: false });
  },

  removePin: () => {
    localStorage.removeItem('hisaab_pin_hash');
    set({ hasPin: false, isLocked: false });
  },

  verifyPin: async (pin) => {
    const { lockedUntil, failedAttempts } = get();
    if (lockedUntil && Date.now() < lockedUntil) return false;

    const stored = localStorage.getItem('hisaab_pin_hash');
    if (!stored) { set({ isLocked: false }); return true; }

    const hashed = await hashPin(pin);
    if (hashed === stored) {
      set({ isLocked: false, failedAttempts: 0, lockedUntil: null });
      return true;
    }

    const newFailed = failedAttempts + 1;
    if (newFailed >= 3) {
      set({ failedAttempts: newFailed, lockedUntil: Date.now() + 30000 });
    } else {
      set({ failedAttempts: newFailed });
    }
    return false;
  },

  lock: () => set({ isLocked: true }),

  setIdentifier: (id) => {
    localStorage.setItem('hisaab_identifier', id);
    set({ identifier: id });
  },
}));
