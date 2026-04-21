import { create } from 'zustand';
import type { AppMode } from '../db';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  reset: () => void;
}

const DEFAULT_MODE: AppMode = 'full_tracker';

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: (localStorage.getItem('hisaab_app_mode') as AppMode) || DEFAULT_MODE,
  setMode: (mode) => {
    localStorage.setItem('hisaab_app_mode', mode);
    set({ mode });
  },
  // localStorage for this key is cleared by resetAllUserStores; reset the
  // in-memory mode to default so the next user doesn't inherit it.
  reset: () => set({ mode: DEFAULT_MODE }),
}));
