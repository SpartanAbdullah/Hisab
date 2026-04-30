import { create } from 'zustand';

interface UIState {
  modalCount: number;
  modalClosers: Array<{ id: string; close: () => void }>;
  openModal: (close?: () => void) => string;
  closeModal: (id?: string) => void;
  closeTopModal: () => boolean;
  isModalOpen: () => boolean;
  reset: () => void;
}

let modalId = 0;

export const useUIStore = create<UIState>((set, get) => ({
  modalCount: 0,
  modalClosers: [],
  openModal: (close) => {
    const id = `modal-${++modalId}`;
    set(s => ({
      modalCount: s.modalCount + 1,
      modalClosers: close ? [...s.modalClosers, { id, close }] : s.modalClosers,
    }));
    return id;
  },
  closeModal: (id) => set(s => ({
    modalCount: Math.max(0, s.modalCount - 1),
    modalClosers: id ? s.modalClosers.filter(closer => closer.id !== id) : s.modalClosers.slice(0, -1),
  })),
  closeTopModal: () => {
    const { modalClosers } = get();
    const topModal = modalClosers[modalClosers.length - 1];
    if (!topModal) return false;
    topModal.close();
    return true;
  },
  isModalOpen: () => get().modalCount > 0,
  reset: () => set({ modalCount: 0, modalClosers: [] }),
}));
