import { create } from 'zustand';
import { contactLinksDb, type ContactLinkRequest } from '../lib/supabaseDb';
import { usePersonStore } from './personStore';

// Connection consent. When A links B with B's code, A is linked immediately
// (it's A's own private ledger) but B is only ASKED — nothing is written into
// B's contacts until B says yes. This store holds both sides of that ask:
//   • incoming — "Asif added you. Add Asif back?" (B decides)
//   • outgoing — "Waiting for Asif to add you back" (A's honest status)
//
// The accepting side's contact row is created server-side by
// respond_contact_link, so an accept must refetch persons rather than
// synthesise a row locally.
interface ContactLinkState {
  requests: ContactLinkRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  /** Accept (adds them to your contacts) or decline. Returns success. */
  respond: (requestId: string, accept: boolean) => Promise<boolean>;
  /** Pending asks addressed to me — the ones that need a decision. */
  incomingPending: (myId: string) => ContactLinkRequest[];
  /** True while the contact I linked hasn't added me back yet. */
  isAwaitingThem: (myId: string, theirProfileId: string) => boolean;
  reset: () => void;
}

const INITIAL_STATE = {
  requests: [] as ContactLinkRequest[],
  loading: false,
};

export const useContactLinkStore = create<ContactLinkState>((set, get) => ({
  ...INITIAL_STATE,

  reset: () => set(INITIAL_STATE),

  loadRequests: async () => {
    set({ loading: true });
    try {
      const requests = await contactLinksDb.getAll();
      set({ requests });
    } finally {
      set({ loading: false });
    }
  },

  respond: async (requestId, accept) => {
    const result = await contactLinksDb.respond(requestId, accept);
    if (!result.success) return false;
    // Optimistic local status so the card resolves instantly; the realtime
    // echo will confirm it.
    set((s) => ({
      requests: s.requests.map((r) =>
        r.id === requestId
          ? { ...r, status: accept ? 'accepted' : 'declined', respondedAt: new Date().toISOString() }
          : r,
      ),
    }));
    if (accept) {
      // The new contact row was written server-side — refetch rather than
      // guess at its id/name.
      await usePersonStore.getState().loadPersons().catch(() => {});
    }
    return true;
  },

  incomingPending: (myId) =>
    get().requests.filter((r) => r.toUserId === myId && r.status === 'pending'),

  isAwaitingThem: (myId, theirProfileId) =>
    get().requests.some(
      (r) => r.fromUserId === myId && r.toUserId === theirProfileId && r.status === 'pending',
    ),
}));
