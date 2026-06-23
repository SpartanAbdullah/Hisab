import { create } from 'zustand';

// Appearance preference. Device-scoped (like language) — NOT cleared on logout,
// and persisted to localStorage under hisaab_theme. The actual `.dark` class is
// applied to <html>; an inline script in index.html applies it before first
// paint to avoid a light flash, and this store keeps it in sync afterwards.
export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'hisaab_theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveIsDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark());
}

function applyThemeClass(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolveIsDark(mode));
}

function readStoredMode(): ThemeMode {
  const raw = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) as ThemeMode | null;
  return raw === 'dark' || raw === 'system' ? raw : 'light';
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    try { localStorage.setItem(KEY, mode); } catch { /* storage disabled — class still applies */ }
    applyThemeClass(mode);
    set({ mode });
  },
}));

// Call once at boot. Applies the current preference and, while on "system",
// follows OS changes live.
export function initTheme(): void {
  const mode = useThemeStore.getState().mode;
  applyThemeClass(mode);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (useThemeStore.getState().mode === 'system') applyThemeClass('system');
    });
  }
}
