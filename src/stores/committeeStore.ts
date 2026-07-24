import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { committeesDb, committeeMembersDb, committeePaymentsDb } from '../lib/supabaseDb';
import { generateSeed, commitmentFor, drawOrder } from '../lib/committeeDraw';
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
  loadAll: () => Promise<void>;
  createCommittee: (input: CreateCommitteeInput) => Promise<Committee>;
  deleteCommittee: (id: string) => Promise<void>;
  runBallot: (committeeId: string) => Promise<void>;
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

export const useCommitteeStore = create<CommitteeState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadAll: async () => {
    set({ loading: true });
    try {
      const [committees, members, payments] = await Promise.all([
        committeesDb.getAll(),
        committeeMembersDb.getAll(),
        committeePaymentsDb.getAll(),
      ]);
      set({ committees, members, payments });
    } finally {
      set({ loading: false });
    }
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

  runBallot: async (committeeId) => {
    const members = get().members.filter((m) => m.committeeId === committeeId);
    // Provably-fair commit-reveal: a random seed + its SHA-256 commitment are
    // stored with the draw so any member can later recompute and verify it.
    const seed = generateSeed();
    const commitment = await commitmentFor(seed);
    const order = drawOrder(members.map((m) => m.id), seed);
    const slotById = new Map(order.map((id, i) => [id, i + 1]));
    const drawnAt = new Date().toISOString();
    await Promise.all(members.map((m) => committeeMembersDb.update(m.id, { slot: slotById.get(m.id) ?? null })));
    await committeesDb.update(committeeId, { payoutMethod: 'ballot', drawnAt, drawSeed: seed, drawCommitment: commitment });
    set((s) => ({
      committees: s.committees.map((c) => (c.id === committeeId ? { ...c, payoutMethod: 'ballot', drawnAt, drawSeed: seed, drawCommitment: commitment } : c)),
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
      .catch(() => {});
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
