import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  committeesDb, committeeMembersDb, committeePaymentsDb, CommitteeDrawError, toCommitteeDrawError,
  type CommitteeWitnessRotation, type CommitteeWitnessRevocation, type CommitteePatch,
} from '../lib/supabaseDb';
import { canReorderCommittee } from '../lib/committeeMath';
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
  /**
   * Mint a NEW witness link, server-side. Returns the raw token exactly once —
   * the caller must share it immediately and must never persist it. Rotating
   * invalidates any link already out there. (Audit M19; replaces the old
   * client-minted `ensureShareToken`, which the DB now refuses.)
   */
  rotateWitnessToken: (committeeId: string) => Promise<CommitteeWitnessRotation>;
  /** Kill the current witness link. Idempotent. */
  revokeWitnessToken: (committeeId: string) => Promise<CommitteeWitnessRevocation>;
  /** UX-24: publish initials instead of names on the public witness page. */
  setWitnessInitialsOnly: (committeeId: string, initialsOnly: boolean) => Promise<void>;
  /**
   * Post-creation editing (audit UX-25). Goes through `update_committee`, which
   * validates the whole patch against the kameti's lifecycle state before
   * writing anything. THROWS a `CommitteeDrawError` carrying one of
   * KAMETI_LOCKED_PAYMENTS / KAMETI_LOCKED_DRAW / KAMETI_INVALID_PATCH (or
   * NOT_ORGANISER / NOT_FOUND) — the caller must translate it; there is no
   * silent-failure path.
   */
  updateCommittee: (committeeId: string, patch: CommitteePatch) => Promise<void>;
  /** Appends a member AND a round. Same error contract as `updateCommittee`. */
  addMember: (committeeId: string, input: { name: string; phone?: string | null }) => Promise<void>;
  /** Removes a member, compacts the slots above them, drops a round. Same error contract. */
  removeMember: (committeeId: string, memberId: string) => Promise<void>;
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

/**
 * Kameti reminders are DATE-driven: the local planner recomputes every round's
 * due date from the committee row, so anything that moves a round (a payment
 * completing it, an edited start date or cadence, a member added or removed,
 * a kameti marked completed) has to force a re-plan. Forced so the debounce
 * cannot swallow it; a no-op on web, where there is no native scheduler.
 */
function nudgeReminderSchedule(feature: string): void {
  void import('../lib/notificationScheduler')
    .then((m) => m.rescheduleNotifications({ force: true }))
    .catch((err) => {
      reportError(err, { feature: `${feature}.nudgeReminderSchedule` });
    });
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

  // ── Witness link lifecycle (audit M19 / UX-24) ─────────────────────────
  // The token used to be minted HERE, on the organiser's phone, stored in
  // plaintext, and never expired — so anyone who ever saw a link could read
  // the kameti's full member roster forever, and there was no un-share path
  // at all. It is now server-minted, stored only as a SHA-256, expires in 90
  // days and can be revoked.
  //
  // The raw token is returned exactly once and is NOT written into the store:
  // holding it in Zustand would put it in every devtools snapshot and every
  // error report for the rest of the session, which is the same mistake in a
  // different place. Only the lifecycle metadata is cached.
  rotateWitnessToken: async (committeeId) => {
    let result: CommitteeWitnessRotation;
    try {
      result = await committeesDb.rotateWitnessToken(committeeId);
    } catch (err) {
      reportError(err, { feature: 'committeeStore.rotateWitnessToken', extra: { committeeId } });
      return { status: 'UNKNOWN' };
    }
    if (result.status !== 'ok') return result;
    const { expiresAt, initialsOnly } = result;
    set((s) => ({
      committees: s.committees.map((c) =>
        c.id === committeeId
          ? {
              ...c,
              shareToken: null,
              witnessExpiresAt: expiresAt,
              witnessRevokedAt: null,
              witnessInitialsOnly: initialsOnly,
            }
          : c,
      ),
    }));
    return result;
  },

  revokeWitnessToken: async (committeeId) => {
    let result: CommitteeWitnessRevocation;
    try {
      result = await committeesDb.revokeWitnessToken(committeeId);
    } catch (err) {
      reportError(err, { feature: 'committeeStore.revokeWitnessToken', extra: { committeeId } });
      return { status: 'UNKNOWN' };
    }
    if (result.status !== 'ok') return result;
    const revokedAt = new Date().toISOString();
    set((s) => ({
      committees: s.committees.map((c) =>
        c.id === committeeId ? { ...c, shareToken: null, witnessRevokedAt: revokedAt } : c,
      ),
    }));
    return result;
  },

  // An ordinary owner-writable column — the p2 guard trigger deliberately
  // leaves it alone, so no RPC is involved. Takes effect on the NEXT witness
  // page load; it does not invalidate the link.
  setWitnessInitialsOnly: async (committeeId, initialsOnly) => {
    await committeesDb.update(committeeId, { witnessInitialsOnly: initialsOnly });
    set((s) => ({
      committees: s.committees.map((c) => (c.id === committeeId ? { ...c, witnessInitialsOnly: initialsOnly } : c)),
    }));
  },

  // ── Post-creation editing (audit 06-user-experience UX-25) ──────────────
  // Before this, the organiser's only structural action was deleting the whole
  // kameti: a typo'd contribution amount, a wrong start date or a member who
  // never actually joined cost them the entire record.
  //
  // Every one of the three actions below is a THIN wrapper. The rules live in
  // the server (supabase-migration-p2-kameti-editing.sql) because the client is
  // not where they can be enforced — `committees` has a plain owner UPDATE
  // policy, so any device holding the anon key can PATCH the row directly. The
  // store's job is to convert the refusal into the app's stable code space and
  // to keep the local mirror honest afterwards.
  //
  // They deliberately RETHROW rather than swallowing: an edit that appears to
  // save and didn't is exactly the class of bug tasks/lessons.md is about.
  updateCommittee: async (committeeId, patch) => {
    let updated: Awaited<ReturnType<typeof committeesDb.patch>>;
    try {
      updated = await committeesDb.patch(committeeId, patch);
    } catch (err) {
      const editErr = toCommitteeDrawError(err);
      reportError(err, { feature: 'committeeStore.updateCommittee', extra: { committeeId, code: editErr.code } });
      throw editErr;
    }
    set((s) => ({
      committees: s.committees.map((c) => (c.id === committeeId ? { ...c, ...updated } : c)),
      // A switch to ballot clears every slot; a switch to fixed assigns them in
      // creation order. Both happen server-side inside the same transaction, so
      // the local slots are stale either way — refetching is cheaper to reason
      // about than re-deriving the same ordering twice.
      members: patch.payoutMethod === undefined
        ? s.members
        : s.members.map((m) => (m.committeeId === committeeId ? { ...m, slot: null } : m)),
    }));
    if (patch.payoutMethod !== undefined) {
      await get().loadAll({ force: true }).catch((err) => {
        reportError(err, { feature: 'committeeStore.updateCommittee.reload', extra: { committeeId } });
      });
    }
    // The round-due reminders are DATE-driven off start_date/cadence (and are
    // silenced by status='completed'), so an edit to any of those re-times
    // them. Forced so the debounce can't swallow it; no-op on web.
    if (patch.startDate !== undefined || patch.cadence !== undefined || patch.status !== undefined) {
      nudgeReminderSchedule('committeeStore.updateCommittee');
    }
  },

  addMember: async (committeeId, input) => {
    let result;
    try {
      result = await committeesDb.addMember(committeeId, input);
    } catch (err) {
      const editErr = toCommitteeDrawError(err);
      reportError(err, { feature: 'committeeStore.addMember', extra: { committeeId, code: editErr.code } });
      throw editErr;
    }
    set((s) => ({
      committees: s.committees.map((c) =>
        c.id === committeeId ? { ...c, memberCount: result.memberCount, totalRounds: result.totalRounds } : c,
      ),
      members: [...s.members, result.member],
    }));
    // One more round exists now, so one more due date does too.
    nudgeReminderSchedule('committeeStore.addMember');
  },

  removeMember: async (committeeId, memberId) => {
    let result;
    try {
      result = await committeesDb.removeMember(committeeId, memberId);
    } catch (err) {
      const editErr = toCommitteeDrawError(err);
      reportError(err, { feature: 'committeeStore.removeMember', extra: { committeeId, code: editErr.code } });
      throw editErr;
    }
    const { removedSlot } = result;
    set((s) => ({
      committees: s.committees.map((c) =>
        c.id === committeeId ? { ...c, memberCount: result.memberCount, totalRounds: result.totalRounds } : c,
      ),
      // Mirror the server's compaction exactly: every slot ABOVE the removed
      // one moves down by one. Getting this wrong locally would render a
      // schedule with a "—" round until the next refetch.
      members: s.members
        .filter((m) => m.id !== memberId)
        .map((m) =>
          m.committeeId === committeeId && removedSlot != null && m.slot != null && m.slot > removedSlot
            ? { ...m, slot: m.slot - 1 }
            : m,
        ),
      payments: s.payments.filter((p) => p.memberId !== memberId),
    }));
    nudgeReminderSchedule('committeeStore.removeMember');
  },

  setFixedOrder: async (committeeId, orderedMemberIds) => {
    // A ballot that has been drawn is frozen — reordering slots by hand would
    // keep the honest seed but replace the order it produced (the second half
    // of audit M10). And a kameti with even ONE contribution recorded is no
    // longer safe to reorder either: this writes committee_members.slot
    // directly, so shuffling slots after a round's payment was logged would
    // silently re-point who that money was ever for. There is no server RPC
    // guarding this path — only tg_committee_members_draw_locked's drawn-only
    // refusal — so `canReorderCommittee` (the client mirror of
    // committeeEditState, committeeMath.ts) is the ONLY protection against
    // the `collecting` half of this. Keep the two in step.
    const c = get().committees.find((x) => x.id === committeeId);
    if (c) {
      const check = canReorderCommittee(
        c,
        get().members.filter((m) => m.committeeId === committeeId),
        get().payments.filter((p) => p.committeeId === committeeId),
      );
      if (!check.ok) {
        // Reuse the same coded refusals `update_committee` raises for these
        // two states, so the UI's existing exhaustive error mapping
        // (committeeErrorText.ts) already has a sentence for both — no new
        // code needed for a rule that is exactly the editing matrix.
        throw new CommitteeDrawError(check.reason === 'drawn' ? 'KAMETI_LOCKED_DRAW' : 'KAMETI_LOCKED_PAYMENTS');
      }
    }
    const slotById = new Map(orderedMemberIds.map((id, i) => [id, i + 1]));
    const drawnAt = new Date().toISOString();

    // ORDER MATTERS (audit p0-kameti-draw): while the kameti is still
    // `payout_method = 'ballot'`, the member trigger refuses ANY slot write
    // with BALLOT_SLOTS_SERVER_ONLY — the slot is the draw's output, and that
    // refusal is exactly what stops a hand-written order from bricking the
    // RPC. So flip the method to 'fixed' FIRST, then write the slots.
    //
    // `drawn_at` is stamped LAST, on purpose. If a slot write fails halfway,
    // the kameti is left as an undrawn fixed committee — retryable, and the
    // page still offers the ordering UI. Stamping it up front would instead
    // leave "a draw exists but no member has a slot", which renders as the
    // locked state and offers the user nothing.
    try {
      await committeesDb.update(committeeId, { payoutMethod: 'fixed' });
      await Promise.all(orderedMemberIds.map((id, i) => committeeMembersDb.update(id, { slot: i + 1 })));
      await committeesDb.update(committeeId, { drawnAt });
    } catch (err) {
      // The guards fire on plain table writes, so a raw PostgrestError reaches
      // here. Convert it to the same stable code space the RPC uses, or the
      // UI has nothing to translate.
      const drawErr = toCommitteeDrawError(err);
      reportError(err, { feature: 'committeeStore.setFixedOrder', extra: { committeeId, code: drawErr.code } });
      throw drawErr;
    }

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
    // reminder must die (and unticking must bring it back).
    nudgeReminderSchedule('committeeStore.setPaid');
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
