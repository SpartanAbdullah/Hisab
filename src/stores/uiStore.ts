import { create } from 'zustand';

interface UIState {
  modalCount: number;
  openModal: () => void;
  closeModal: () => void;
  isModalOpen: () => boolean;
  reset: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  modalCount: 0,
  openModal: () => set(s => ({ modalCount: s.modalCount + 1 })),
  closeModal: () => set(s => ({ modalCount: Math.max(0, s.modalCount - 1) })),
  isModalOpen: () => get().modalCount > 0,
  reset: () => set({ modalCount: 0 }),
}));
