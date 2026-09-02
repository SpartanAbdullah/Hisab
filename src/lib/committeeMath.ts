import { addDays, addWeeks, addMonths } from 'date-fns';
import type { Committee, CommitteeMember, CommitteePayment, CommitteeCadence } from '../db';

// The pool one member receives in a round = contribution × number of members.
export function poolAmount(contributionAmount: number, memberCount: number): number {
  return Math.round(contributionAmount * memberCount * 100) / 100;
}

// Date of a given round (1-based). Round 1 is the start date; each subsequent
// round advances by the cadence.
export function roundDate(startDate: string, cadence: CommitteeCadence, round: number): Date {
  const start = new Date(`${startDate}T00:00:00`);
  const n = Math.max(0, round - 1);
  if (cadence === 'daily') return addDays(start, n);
  if (cadence === 'weekly') return addWeeks(start, n);
  return addMonths(start, n);
}

// The round currently being collected — the latest round whose date has arrived,
// clamped to [1, totalRounds]. Before the start date it's round 1 (upcoming).
export function currentRound(
  startDate: string,
  cadence: CommitteeCadence,
  totalRounds: number,
  today: Date = new Date(),
): number {
  let reached = 0;
  for (let r = 1; r <= totalRounds; r++) {
    if (roundDate(startDate, cadence, r).getTime() <= today.getTime()) reached = r;
  }
  return Math.min(Math.max(reached, 1), totalRounds);
}

export function paymentsForRound(payments: readonly CommitteePayment[], round: number): CommitteePayment[] {
  return payments.filter((p) => p.round === round);
}

export function hasPaid(payments: readonly CommitteePayment[], memberId: string, round: number): boolean {
  return payments.some((p) => p.memberId === memberId && p.round === round);
}

export function paidRoundCount(payments: readonly CommitteePayment[], memberId: string): number {
  return payments.filter((p) => p.memberId === memberId).length;
}

// The member whose slot lands on this round (the round's recipient), if assigned.
export function recipientForRound(members: readonly CommitteeMember[], round: number): CommitteeMember | null {
  return members.find((m) => m.slot === round) ?? null;
}

export interface MemberPosition {
  contributed: number;       // paid so far
  totalDue: number;          // over the whole cycle
  remainingObligation: number;
  received: number;          // pool, if they've taken their payout
  net: number;               // received − contributed (positive = ahead)
}

// Each member's money position. `received` counts the pool only once the
// payout is confirmed (payoutReceivedAt). Over the full cycle net → 0.
export function memberPosition(
  member: CommitteeMember,
  payments: readonly CommitteePayment[],
  contributionAmount: number,
  memberCount: number,
  totalRounds: number,
): MemberPosition {
  const paidRounds = paidRoundCount(payments, member.id);
  const contributed = Math.round(paidRounds * contributionAmount * 100) / 100;
  const totalDue = Math.round(totalRounds * contributionAmount * 100) / 100;
  const received = member.payoutReceivedAt ? poolAmount(contributionAmount, memberCount) : 0;
  return {
    contributed,
    totalDue,
    remainingObligation: Math.max(0, Math.round((totalDue - contributed) * 100) / 100),
    received,
    net: Math.round((received - contributed) * 100) / 100,
  };
}

// Early slots are an interest-free advance (you owe the most afterwards); late
// slots are effectively savings. Used for the honesty hint about slot value.
export type SlotKind = 'early' | 'mid' | 'late';
export function slotKind(slot: number, totalRounds: number): SlotKind {
  if (totalRounds <= 0) return 'mid';
  const third = totalRounds / 3;
  if (slot <= third) return 'early';
  if (slot > totalRounds - third) return 'late';
  return 'mid';
}

// Fisher–Yates shuffle for the ballot. Pure: pass a deterministic random fn in
// tests. Returns the member ids in drawn order → order[i] gets slot i+1.
export function ballotOrder(memberIds: readonly string[], random: () => number): string[] {
  const arr = [...memberIds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ───────────────────────────────────────────────────────────────────────────
// POST-CREATION EDITING (audit 06-user-experience UX-25)
//
// These four functions are the CLIENT MIRROR of the matrix enforced by
// supabase-migration-p2-kameti-editing.sql. The server is the protection —
// update_committee / add_committee_member / remove_committee_member refuse
// anything below, and a trigger refuses the same writes when they arrive as
// raw PostgREST. What lives here is the *explanation*: which field to disable,
// and which sentence to show next to the padlock, so the organiser is never
// offered an edit the server will reject.
//
// Keep the two in step. If a rule changes in the SQL, it changes here, and the
// tests in committeeMath.test.ts + supabase/tests/tests/8w-kameti-editing.sql
// are the pair that catches a drift.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `drawn` keys off `drawSeed`, NOT `drawnAt`. A fixed-order kameti is stamped
 * `drawnAt` at creation ("the order was settled at"), so reading that as the
 * draw would freeze every fixed kameti from birth — which is the dead end
 * UX-25 describes. `drawSeed` is reachable only from perform_committee_draw().
 */
export type CommitteeEditState = 'open' | 'collecting' | 'drawn';

export function committeeEditState(
  committee: Pick<Committee, 'drawSeed'>,
  payments: readonly CommitteePayment[],
): CommitteeEditState {
  if (committee.drawSeed) return 'drawn';
  return payments.length > 0 ? 'collecting' : 'open';
}

/**
 * Contribution amount, currency, cadence, start date and payout method: the
 * fields that re-price rows which already exist. Editable only while nothing
 * has been collected and no ballot has been drawn. Name, emoji, notes and
 * status are never locked.
 */
export function isMoneyShapeEditable(state: CommitteeEditState): boolean {
  return state === 'open';
}

export type MemberAddBlock = 'drawn' | 'payout_confirmed' | 'completed' | 'cycle_over' | 'too_many';
export type MemberAddCheck = { ok: true } | { ok: false; reason: MemberAddBlock };

/** Mirrors add_committee_member's guards, in the same order as the RPC. */
export function canAddCommitteeMember(
  committee: Pick<Committee, 'drawSeed' | 'status' | 'memberCount' | 'totalRounds' | 'startDate' | 'cadence'>,
  members: readonly CommitteeMember[],
  today: Date = new Date(),
): MemberAddCheck {
  if (committee.drawSeed) return { ok: false, reason: 'drawn' };
  if (committee.status !== 'active') return { ok: false, reason: 'completed' };
  // The POOL rule, and it is stricter than "no payments". A confirmed payout
  // means someone has physically received contribution × memberCount; growing
  // the roster afterwards hands the later recipients a bigger pool for the
  // same outlay. Recording contributions is harmless by comparison — the
  // newcomer simply starts in arrears for the elapsed rounds.
  if (members.some((m) => m.payoutReceivedAt)) return { ok: false, reason: 'payout_confirmed' };
  if (committee.memberCount >= 60) return { ok: false, reason: 'too_many' };
  // The appended round must still be ahead of us. (The server decides this on
  // the Asia/Karachi date; on the last day of a cycle the two can differ by
  // one day, and the server wins — the UI just re-shows its refusal.)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (roundDate(committee.startDate, committee.cadence, committee.totalRounds + 1) <= midnight) {
    return { ok: false, reason: 'cycle_over' };
  }
  return { ok: true };
}

export type MemberRemoveBlock =
  | 'drawn' | 'organizer' | 'too_few' | 'member_has_payments'
  | 'payout_received' | 'rounds_collected' | 'not_found';
export type MemberRemoveCheck =
  | { ok: true; slotsShifted: number }
  | { ok: false; reason: MemberRemoveBlock };

/** Mirrors remove_committee_member's guards, in the same order as the RPC. */
export function canRemoveCommitteeMember(
  committee: Pick<Committee, 'drawSeed' | 'memberCount' | 'totalRounds'>,
  members: readonly CommitteeMember[],
  payments: readonly CommitteePayment[],
  memberId: string,
): MemberRemoveCheck {
  const target = members.find((m) => m.id === memberId);
  if (!target) return { ok: false, reason: 'not_found' };
  if (committee.drawSeed) return { ok: false, reason: 'drawn' };
  if (target.isOrganizer) return { ok: false, reason: 'organizer' };
  if (committee.memberCount - 1 < 2) return { ok: false, reason: 'too_few' };
  if (payments.some((p) => p.memberId === memberId)) return { ok: false, reason: 'member_has_payments' };
  if (target.payoutReceivedAt) return { ok: false, reason: 'payout_received' };
  // Removing compacts every slot above the target DOWN by one and drops the
  // last round, so round `from` and everything after it changes meaning. Only
  // an untouched tail of the cycle may be re-shaped.
  const slot = target.slot;
  const from = slot ?? committee.totalRounds;
  if (payments.some((p) => p.round >= from)) return { ok: false, reason: 'rounds_collected' };
  return {
    ok: true,
    slotsShifted: slot == null ? 0 : members.filter((m) => m.slot != null && m.slot > slot).length,
  };
}

export type ReorderBlock = 'collecting' | 'drawn';
export type ReorderCheck = { ok: true } | { ok: false; reason: ReorderBlock };

/**
 * Guards `committeeStore.setFixedOrder` — the reorder-a-fixed-kameti path
 * (UX-25's remaining half). There is no server RPC for this today; the store
 * writes `committee_members.slot` directly, so this client mirror of
 * `committeeEditState` is the ONLY thing standing between "reorder" and a
 * kameti where a payment or a payout already points at a specific slot.
 * Reordering after money has moved would silently re-point who that round's
 * contribution or payout was ever for — the same money-math hazard
 * `isMoneyShapeEditable` guards for the money-shape fields. Only `open` may
 * reorder; `collecting` (a payment already exists) and `drawn` (a ballot
 * result — immutable by definition) both refuse.
 *
 * `members` is accepted for signature parity with `canAddCommitteeMember` /
 * `canRemoveCommitteeMember` and reserved for a future per-member check; the
 * state matrix alone decides today.
 */
export function canReorderCommittee(
  committee: Pick<Committee, 'drawSeed'>,
  members: readonly CommitteeMember[],
  payments: readonly CommitteePayment[],
): ReorderCheck {
  void members;
  const state = committeeEditState(committee, payments);
  if (state === 'open') return { ok: true };
  return { ok: false, reason: state };
}

export interface ScheduleRow {
  round: number;
  date: Date;
  recipientId: string | null;
  pool: number;
}

// The full payout timeline: each round's date, recipient (if slots assigned),
// and pool amount.
export function buildSchedule(committee: Committee, members: readonly CommitteeMember[]): ScheduleRow[] {
  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  const rows: ScheduleRow[] = [];
  for (let r = 1; r <= committee.totalRounds; r++) {
    rows.push({
      round: r,
      date: roundDate(committee.startDate, committee.cadence, r),
      recipientId: recipientForRound(members, r)?.id ?? null,
      pool,
    });
  }
  return rows;
}
