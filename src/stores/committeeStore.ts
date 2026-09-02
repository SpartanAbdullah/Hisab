import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { committeesDb, committeeMembersDb, committeePaymentsDb, CommitteeDrawError } from '../lib/supabaseDb';
import { generateSeed } from '../lib/committeeDraw';
import { reportError } from '../lib/errorReporter';
import type {
  Committee, CommitteeMember, CommitteePayment,
  CommitteeCadence, CommitteePayoutMethod, Currency,
} from '../db';

export interface NewCommitteeMember {
  name: string;
  phone?: string | null;
  isOrganizer?: boolean;
}

export interface CreateCommitteeInput {
  name: string;
  currency: Currency;
  contributionAmount: number;
  cadence: CommitteeCadence;
  startDate: string;
  payoutMethod: CommitteePayoutMethod;
  members: NewCommitteeMember[];
}

interface CommitteeState {
  committees: Committee[];
  members: CommitteeMember[];
  payments: CommitteePayment[];
  loading: boolean;
  /** `force: true` bypasses the in-flight/freshness gate (see below). */
  loadAll: (options?: { force?: boolean }) => Promise<void>;
  createCommittee: (input: CreateCommitteeInput) => Promise<Committee>;
  deleteCommittee: (id: string) => Promise<void>;
  runBallot: (committeeId: string) => Promise<void>;
  /** True once an order exists — the draw CTA must be gone from that moment. */
  isDrawn: (committeeId: string) => boolean;
  ensureShareToken: (committeeId: string) => Promise<string>;
  setFixedOrder: (committeeId: string, orderedMemberIds: string[]) => Promise<void>;
  setPaid: (committeeId: string, memberId: string, round: number, paid: boolean) => Promise<void>;
  confirmPayout: (memberId: string, received: boolean) => Promise<void>;
  updateMember: (memberId: string, changes: { name?: string; phone?: string | null }) => Promise<void>;
  membersOf: (committeeId: string) => CommitteeMember[];
  paymentsOf: (committeeId: string) => CommitteePayment[];
  getCommittee: (id: string) => Committee | undefined;
  reset: () => void;
}

const INITIAL = { committees: [] as Committee[], members: [] as CommitteeMember[], payments: [] as CommitteePayment[], loading: false };

// Audit 03-performance M2: `loadAll` is three unbounded queries and had no
// gate of any kind, so the App boot effect and HomePage's mount effect both
// ran it within the same second — six queries for one set of rows. Kameti data
// is low-churn (a payment tick, a draw), so a short freshness window plus an
// in-flight share is enough; anything that MUST see the server (the
// ALREADY_DRAWN resync) passes `{ force: true }`.
const COMMITTEE_FRESH_MS = 60_000;
let committeesLoadedAt = 0;
let committeesInFlight: Promise<void> | null = null;

/** Test/reset seam — also called from `reset()` so a user switch re-fetches. */
function clearCommitteeLoadGate(): void {
  committeesLoadedAt = 0;
  committeesInFlight = null;
}

export const useCommitteeStore = create<CommitteeState>((set, get) => ({
  ...INITIAL,

  reset: () => {
    clearCommitteeLoadGate();
    set(INITIAL);
  },

  loadAll: async (options) => {
    if (!options?.force) {
      if (committeesInFlight) return committeesInFlight;
      if (committeesLoadedAt > 0 && Date.now() - committeesLoadedAt < COMMITTEE_FRESH_MS) return;
    }
    set({ loading: true });
    const run = (async () => {
      try {
        const [committees, members, payments] = await Promise.all([
          committeesDb.getAll(),
          committeeMembersDb.getAll(),
          committeePaymentsDb.getAll(),
        ]);
        set({ committees, members, payments });
        committeesLoadedAt = Date.now();
      } finally {
        committeesInFlight = null;
        set({ loading: false });
      }
    })();
    committeesInFlight = run;
    return run;
  },

  createCommittee: async (input) => {
    const now = new Date().toISOString();
    const count = input.members.length;
    const committee: Committee = {
      id: uuid(),
      name: input.name.trim(),
      currency: input.currency,
      contributionAmount: input.contributionAmount,
      memberCount: count,
      cadence: input.cadence,
      totalRounds: count,
      startDate: input.startDate,
      payoutMethod: input.payoutMethod,
      status: 'active',
      notes: '',
      // A fixed-order committee is "drawn" at creation (slots assigned in the
      // order added); a ballot is drawn later via runBallot.
      drawnAt: input.payoutMethod === 'fixed' ? now : null,
      createdAt: now,
    };
    const members: CommitteeMember[] = input.members.map((m, i) => ({
      id: uuid(),
      committeeId: committee.id,
      name: m.name.trim(),
      phone: m.phone ?? null,
      personId: null,
      slot: input.payoutMethod === 'fixed' ? i + 1 : null,
      isOrganizer: m.isOrganizer ?? false,
      payoutReceivedAt: null,
      exitedAt: null,
      createdAt: now,
    }));

    await committeesDb.add(committee);
    await committeeMembersDb.addMany(members);
    set((s) => ({ committees: [committee, ...s.committees], members: [...s.members, ...members] }));
    return committee;
  },

  deleteCommittee: async (id) => {
    await committeesDb.delete(id);
    set((s) => ({
      committees: s.committees.filter((c) => c.id !== id),
      members: s.members.filter((m) => m.committeeId !== id),
      payments: s.payments.filter((p) => p.committeeId !== id),
    }));
  },

  // The ballot draw. Audit 2026-09 M10 / F-13: this used to generate the seed,
  // the commitment AND the order on this device and write them in one plain
  // UPDATE, with no drawn-guard anywhere — so the organiser could re-roll until
  // slot 1 was theirs and every witness verification would still pass.
  //
  // The draw is now a single server RPC (see committeesDb.performDraw). This
  // store-level guard is a UX shortcut, not the protection: the real guard is
  // `drawn_at IS NULL` inside the transaction, which raises ALREADY_DRAWN. On
  // that error we resync from the server so the UI stops offering a draw that
  // already happened.
  isDrawn: (committeeId) => {
    const c = get().committees.find((x) => x.id === committeeId);
    if (!c) return false;
    return !!c.drawnAt || !!c.drawSeed || get().members.some((m) => m.committeeId === committeeId && m.slot != null);
  },

  runBallot: async (committeeId) => {
    if (get().isDrawn(committeeId)) throw new CommitteeDrawError('ALREADY_DRAWN');
    let result;
    try {
      result = await committeesDb.performDraw(committeeId);
    } catch (err) {
      // The server refused because an order already exists — our local copy was
      // stale (another device, another tab). Pull the real one back.
      if (err instanceof CommitteeDrawError && err.code === 'ALREADY_DRAWN') {
        // Expected: another device drew first. Only the recovery reload is
        // worth reporting if it too fails.
        // Must hit the server: our copy is known-stale, so the freshness gate
        // would otherwise hand back the very rows that are wrong.
        await get().loadAll({ force: true }).catch((reloadErr) => {
          reportError(reloadErr, { feature: 'committeeStore.runBallot.staleReload', extra: { committeeId } });
        });
      } else {
        reportError(err, { feature: 'committeeStore.runBallot', extra: { committeeId } });
      }
      throw err;
    }
    const { drawnAt, drawSeed, drawCommitment, order } = result;
    const slotById = new Map(order.map((id, i) => [id, i + 1]));
    set((s) => ({
      committees: s.committees.map((c) => (c.id === committeeId ? { ...c, payoutMethod: 'ballot', drawnAt, drawSeed, drawCommitment } : c)),
      members: s.members.map((m) => (m.committeeId === committeeId ? { ...m, slot: slotById.get(m.id) ?? m.slot } : m)),
    }));
  },

  ensureShareToken: async (committeeId) => {
    const existing = get().committees.find((c) => c.id === committeeId);
    if (existing?.shareToken) return existing.shareToken;
    const token = generateSeed() + generateSeed(); // 256-bit hex
    await committeesDb.update(committeeId, { shareToken: token });
    set((s) => ({ committees: s.committees.map((c) => (c.id === committeeId ? { ...c, shareToken: token } : c)) }));
    return token;
  },

  setFixedOrder: async (committeeId, orderedMemberIds) => {
    // A ballot that has been drawn is frozen — reordering slots by hand would
    // keep the honest seed but replace the order it produced (the second half
    // of audit M10). The DB rejects it too (DRAW_LOCKED trigger); this just
    // fails fast with a code the UI can read.
    const c = get().committees.find((x) => x.id === committeeId);
    if (c?.drawSeed) throw new CommitteeDrawError('DRAW_LOCKED');
    const slotById = new Map(orderedMemberIds.map((id, i) => [id, i + 1]));
    const drawnAt = new Date().toISOString();
    await Promise.all(orderedMemberIds.map((id, i) => committeeMembersDb.update(id, { slot: i + 1 })));
    await committeesDb.update(committeeId, { payoutMethod: 'fixed', drawnAt });
    set((s) => ({
      committees: s.committees.map((c) => (c.id === committeeId ? { ...c, payoutMethod: 'fixed', drawnAt } : c)),
      members: s.members.map((m) => (slotById.has(m.id) ? { ...m, slot: slotById.get(m.id)! } : m)),
    }));
  },

  setPaid: async (committeeId, memberId, round, paid) => {
    if (paid) {
      const payment: CommitteePayment = { id: uuid(), committeeId, memberId, round, paidAt: new Date().toISOString() };
      await committeePaymentsDb.add(payment);
      set((s) => ({ payments: [...s.payments, payment] }));
    } else {
      await committeePaymentsDb.remove(memberId, round);
      set((s) => ({ payments: s.payments.filter((p) => !(p.memberId === memberId && p.round === round)) }));
    }
    // Ticking the last member completes the round — its pending day-of
    // reminder must die (and unticking must bring it back). Forced so the
    // debounce can't swallow it; no-op on web.
    void import('../lib/notificationScheduler')
      .then((m) => m.rescheduleNotifications({ force: true }))
      .catch((err) => {
        reportError(err, { feature: 'committeeStore.setPaid.nudgeReminderSchedule' });
      });
  },

  confirmPayout: async (memberId, received) => {
    const payoutReceivedAt = received ? new Date().toISOString() : null;
    await committeeMembersDb.update(memberId, { payoutReceivedAt });
    set((s) => ({ members: s.members.map((m) => (m.id === memberId ? { ...m, payoutReceivedAt } : m)) }));
  },

  // Fix a member's name / WhatsApp number after creation. Deliberately does NOT
  // touch slot or payments, so the draw order and money math are untouched.
  updateMember: async (memberId, changes) => {
    await committeeMembersDb.update(memberId, changes);
    set((s) => ({ members: s.members.map((m) => (m.id === memberId ? { ...m, ...changes } : m)) }));
  },

  membersOf: (committeeId) =>
    get().members.filter((m) => m.committeeId === committeeId).sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999) || a.createdAt.localeCompare(b.createdAt)),
  paymentsOf: (committeeId) => get().payments.filter((p) => p.committeeId === committeeId),
  getCommittee: (id) => get().committees.find((c) => c.id === id),
}));
