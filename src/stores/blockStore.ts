import { create } from 'zustand';
import {
  blocksDb,
  reportsDb,
  type BlockRow,
  type ReportInput,
} from '../lib/supabaseDb';
import type { BlockOutcome, ReportOutcome } from '../lib/blockStatus';

import { reportError } from '../lib/errorReporter';

// ───────────────────────────────────────────────────────────────────────────
// Blocking and reporting (audit 2026-09 M17 · docs/trust-and-safety.md).
//
// THIS STORE ONLY EVER HOLDS *MY* BLOCK LIST. There is deliberately no state,
// selector or action here that could answer "has someone blocked me?" — the
// SQL side revoked `is_blocked_either_way` / `has_blocked` from `authenticated`
// precisely so that question has no client-reachable answer, and a convenience
// getter here would re-open it.
//
// Three properties the UI depends on:
//   1. BLOCKING IS IDEMPOTENT. The PK is the pair, so a repeat block collides
//      and `blockOutcomeFromError` reports ALREADY_BLOCKED — a success, not an
//      error the user has to understand.
//   2. UNBLOCKING IS A PURE DELETE (RULE 3). Nothing else changes: contacts,
//      loans, group memberships and ledger rows are untouched by both actions.
//   3. REPORTS ARE WRITE-ONLY. `public.reports` has no SELECT policy at all, so
//      there is no list to fetch and no "my reports" screen to build. The UI
//      must confirm optimistically from the returned outcome.
//
// Mode-agnostic on purpose: blocking is a social action, so `full_tracker` and
// `splits_only` behave identically and neither leaves a money artifact.
// ───────────────────────────────────────────────────────────────────────────

interface BlockState {
  blocks: BlockRow[];
  loading: boolean;
  /** True once a load has completed, so callers can distinguish "empty" from "unknown". */
  loaded: boolean;
  loadBlocks: (options?: { force?: boolean }) => Promise<void>;
  block: (blockedId: string, reason?: string | null) => Promise<BlockOutcome>;
  unblock: (blockedId: string) => Promise<void>;
  report: (input: ReportInput) => Promise<ReportOutcome>;
  /** Ids I have blocked, as a Set for O(1) render-site filtering. */
  blockedIds: () => Set<string>;
  /** Have I blocked this user? Never the reverse question. */
  hasBlocked: (userId: string | null | undefined) => boolean;
  reset: () => void;
}

const INITIAL = { blocks: [] as BlockRow[], loading: false, loaded: false };

// The block list is tiny and changes only when the user acts, but the pages
// that need it (Inbox, Settings, contact sheet, group detail) all mount
// independently — a short freshness window plus an in-flight share keeps four
// mounts from firing four identical queries. Anything that MUST see the server
// passes `{ force: true }`; every mutating action below refreshes locally
// instead, so it never needs to.
const BLOCKS_FRESH_MS = 60_000;
let blocksLoadedAt = 0;
let blocksInFlight: Promise<void> | null = null;

function clearBlockLoadGate(): void {
  blocksLoadedAt = 0;
  blocksInFlight = null;
}

export const useBlockStore = create<BlockState>((set, get) => ({
  ...INITIAL,

  reset: () => {
    clearBlockLoadGate();
    set(INITIAL);
  },

  loadBlocks: async (options) => {
    if (!options?.force) {
      if (blocksInFlight) return blocksInFlight;
      if (blocksLoadedAt > 0 && Date.now() - blocksLoadedAt < BLOCKS_FRESH_MS) return;
    }
    set({ loading: true });
    const run = (async () => {
      try {
        const blocks = await blocksDb.getAll();
        set({ blocks, loaded: true });
        blocksLoadedAt = Date.now();
      } catch (err) {
        // A failed load must NOT look like "nothing is blocked" — leave the
        // previous list in place and say so, or the inbox would silently
        // un-hide a harasser's cards.
        reportError(err, { feature: 'blockStore.loadBlocks' });
      } finally {
        blocksInFlight = null;
        set({ loading: false });
      }
    })();
    blocksInFlight = run;
    return run;
  },

  block: async (blockedId, reason) => {
    let outcome: BlockOutcome;
    try {
      // `blocksDb.block` returns outcomes rather than throwing for the two
      // expected refusals, but it can still throw before the insert (no
      // session) or on a transport failure. Never let that reach a caller as
      // an unhandled rejection — the sheet shows a message either way.
      outcome = await blocksDb.block(blockedId, reason);
    } catch (err) {
      reportError(err, { feature: 'blockStore.block' });
      return 'FAILED';
    }
    if (outcome === 'ok' || outcome === 'ALREADY_BLOCKED') {
      // Optimistic insert so every render site (inbox filter, contact sheet,
      // Settings list) flips in the same frame the sheet closes.
      set((s) =>
        s.blocks.some((b) => b.blockedId === blockedId)
          ? s
          : {
              blocks: [
                { blockedId, reason: reason?.trim() || null, createdAt: new Date().toISOString() },
                ...s.blocks,
              ],
            },
      );
      blocksLoadedAt = Date.now();
    }
    return outcome;
  },

  unblock: async (blockedId) => {
    await blocksDb.unblock(blockedId);
    set((s) => ({ blocks: s.blocks.filter((b) => b.blockedId !== blockedId) }));
    blocksLoadedAt = Date.now();
  },

  // Fire-and-confirm: there is nothing to read back, so the outcome IS the
  // receipt. Never throws for the rate limit — that is a calm message.
  report: async (input) => {
    try {
      return await reportsDb.submit(input);
    } catch (err) {
      reportError(err, { feature: 'blockStore.report', extra: { contextType: input.contextType } });
      return 'FAILED';
    }
  },

  blockedIds: () => new Set(get().blocks.map((b) => b.blockedId)),

  hasBlocked: (userId) => (userId ? get().blocks.some((b) => b.blockedId === userId) : false),
}));
