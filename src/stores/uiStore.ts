import { create } from 'zustand';

interface UIState {
  modalCount: number;
  // Stack of close handlers for the open <Modal>s (top of stack = most recent).
  // Lets the Android hardware back button dismiss the topmost modal instead of
  // navigating the page underneath it.
  modalStack: Array<() => void>;
  openModal: (close: () => void) => void;
  closeModal: (close: () => void) => void;
  // Closes the topmost open modal. Returns true if there was one to close.
  closeTopModal: () => boolean;
  isModalOpen: () => boolean;
  reset: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  modalCount: 0,
  modalStack: [],
  openModal: (close) => set(s => {
    const modalStack = [...s.modalStack, close];
    return { modalStack, modalCount: modalStack.length };
  }),
  closeModal: (close) => set(s => {
    const modalStack = s.modalStack.filter(c => c !== close);
    return { modalStack, modalCount: modalStack.length };
  }),
  closeTopModal: () => {
    const { modalStack } = get();
    if (modalStack.length === 0) return false;
    modalStack[modalStack.length - 1]();
    return true;
  },
  isModalOpen: () => get().modalCount > 0,
  reset: () => set({ modalCount: 0, modalStack: [] }),
}));
