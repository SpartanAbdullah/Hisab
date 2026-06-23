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
