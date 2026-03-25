import { create } from 'zustand';
import type { AppMode } from '../db';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: (localStorage.getItem('hisaab_app_mode') as AppMode) || 'full_tracker',
  setMode: (mode) => {
    localStorage.setItem('hisaab_app_mode', mode);
    set({ mode });
  },
}));
