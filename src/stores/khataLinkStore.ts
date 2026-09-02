import { create } from 'zustand';
import { khataLinksDb } from '../lib/supabaseDb';
import type { KhataLinkCreated, KhataLinkFailureStatus } from '../lib/khataLinkStatus';

// Khata links — the per-counterparty living-balance link (audit P3 / L2).
//
// WHAT THIS STORE DELIBERATELY DOES NOT DO: cache the raw token across a
// reload. The server returns it EXACTLY ONCE and never stores it; persisting a
// capability URL to localStorage would quietly recreate the very thing
// supabase-migration-p3-khata-link.sql exists to prevent (a long-lived,
// readable copy of a live capability). The token lives in memory for as long
// as the share sheet is open, and no longer. Losing it costs one rotate.
//
// The store therefore holds only "what happened on the last create/revoke",
// keyed by contact so two sheets for two contacts never read each other's
// token.

export interface KhataLinkEntry {
  personId: string;
  token: string;
  url: string;
  expiresAt: string;
  initialsOnly: boolean;
  /** Off by default. When true, the public page includes this contact's
   *  loan/transaction notes (capped at 140 chars server-side). */
  showNotes: boolean;
  /** True when minting this link killed an earlier one for the same contact —
   *  the UI must say so, because a URL the user already sent has just died. */
  replacedPrevious: boolean;
  /** When this tab minted it. Only used for "just created" affordances. */
  createdAt: number;
}

interface KhataLinkState {
  /** In-memory only, keyed by person id. Never persisted. */
  links: Record<string, KhataLinkEntry>;
  /** Contact id currently being created/revoked, or null. */
  busyPersonId: string | null;
  /** Last failure, so the sheet can render one honest message. */
  error: KhataLinkFailureStatus | null;

  createLink: (personId: string, initialsOnly?: boolean, showNotes?: boolean) => Promise<KhataLinkEntry | null>;
  revokeLink: (personId: string) => Promise<boolean>;
  /** Drop the in-memory token for one contact (sheet closed, contact deleted). */
  forget: (personId: string) => void;
  clearError: () => void;
  reset: () => void;
}

function toEntry(personId: string, created: KhataLinkCreated): KhataLinkEntry {
  return {
    personId,
    token: created.token,
    url: created.url,
    expiresAt: created.expiresAt,
    initialsOnly: created.initialsOnly,
    showNotes: created.showNotes,
    replacedPrevious: created.replacedPrevious,
    createdAt: Date.now(),
  };
}

export const useKhataLinkStore = create<KhataLinkState>((set, get) => ({
  links: {},
  busyPersonId: null,
  error: null,

  /** Mint or rotate. Rotating is the same call — the server revokes the
   *  previous link first, which is why `replacedPrevious` matters to the UI. */
  createLink: async (personId, initialsOnly, showNotes) => {
    if (get().busyPersonId) return null; // one mint at a time; double-tap is a no-op
    set({ busyPersonId: personId, error: null });
    try {
      const result = await khataLinksDb.create(personId, initialsOnly, showNotes);
      if (result.status !== 'ok') {
        set({ error: result.status });
        return null;
      }
      const entry = toEntry(personId, result);
      set((s) => ({ links: { ...s.links, [personId]: entry } }));
      return entry;
    } finally {
      set({ busyPersonId: null });
    }
  },

  /** Kill the contact's public link. Idempotent server-side; `false` here means
   *  the call failed, NOT that there was nothing to revoke. */
  revokeLink: async (personId) => {
    if (get().busyPersonId) return false;
    set({ busyPersonId: personId, error: null });
    try {
      const result = await khataLinksDb.revoke(personId);
      if (result.status !== 'ok') {
        set({ error: result.status });
        return false;
      }
      // The URL is dead; drop our copy so no UI can still offer to share it.
      set((s) => {
        const links = { ...s.links };
        delete links[personId];
        return { links };
      });
      return true;
    } finally {
      set({ busyPersonId: null });
    }
  },

  forget: (personId) =>
    set((s) => {
      if (!s.links[personId]) return s;
      const links = { ...s.links };
      delete links[personId];
      return { links };
    }),

  clearError: () => set({ error: null }),

  // Discovered automatically by resetAllStores' `./*Store.ts` glob. Logging out
  // must not leave a previous user's live capability URL in memory on a shared
  // phone (audit M7/L2 logout-drift reasoning).
  reset: () => set({ links: {}, busyPersonId: null, error: null }),
}));
