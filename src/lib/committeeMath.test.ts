import { describe, it, expect } from 'vitest';
import {
  poolAmount, roundDate, currentRound, hasPaid, paidRoundCount,
  recipientForRound, memberPosition, slotKind, ballotOrder, buildSchedule,
  committeeEditState, isMoneyShapeEditable, canAddCommitteeMember, canRemoveCommitteeMember,
  canReorderCommittee,
} from './committeeMath';
import type { Committee, CommitteeMember, CommitteePayment } from '../db';

const committee: Committee = {
  id: 'c1', name: 'Office BC', currency: 'PKR', contributionAmount: 10000,
  memberCount: 5, cadence: 'monthly', totalRounds: 5, startDate: '2026-01-15',
  payoutMethod: 'ballot', status: 'active', notes: '', createdAt: '2026-01-01',
};

const member = (id: string, slot: number | null, received = false): CommitteeMember => ({
  id, committeeId: 'c1', name: id, isOrganizer: false, slot,
  payoutReceivedAt: received ? '2026-02-01' : null, createdAt: '2026-01-01',
});

const pay = (memberId: string, round: number): CommitteePayment => ({
  id: `${memberId}-${round}`, committeeId: 'c1', memberId, round, paidAt: '2026-01-15',
});

// Local Y-M-D — roundDate uses local midnight (for correct local display), so
// assert in local terms, not UTC (toISOString would shift across timezones).
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('poolAmount', () => {
  it('multiplies contribution by member count', () => {
    expect(poolAmount(10000, 5)).toBe(50000);
  });
});

describe('roundDate', () => {
  it('round 1 is the start date; monthly cadence advances by month', () => {
    expect(ymd(roundDate('2026-01-15', 'monthly', 1))).toBe('2026-01-15');
    expect(ymd(roundDate('2026-01-15', 'monthly', 3))).toBe('2026-03-15');
  });
  it('weekly and daily cadences advance correctly', () => {
    expect(ymd(roundDate('2026-01-15', 'weekly', 2))).toBe('2026-01-22');
    expect(ymd(roundDate('2026-01-15', 'daily', 4))).toBe('2026-01-18');
  });
});

describe('currentRound', () => {
  it('clamps before start to round 1 and after end to totalRounds', () => {
    expect(currentRound('2026-01-15', 'monthly', 5, new Date('2025-12-01'))).toBe(1);
    expect(currentRound('2026-01-15', 'monthly', 5, new Date('2027-01-01'))).toBe(5);
  });
  it('returns the latest round whose date has arrived', () => {
    expect(currentRound('2026-01-15', 'monthly', 5, new Date('2026-03-20'))).toBe(3);
  });
});

describe('payment helpers', () => {
  const payments = [pay('a', 1), pay('a', 2), pay('b', 1)];
  it('hasPaid / paidRoundCount reflect the rows', () => {
    expect(hasPaid(payments, 'a', 2)).toBe(true);
    expect(hasPaid(payments, 'b', 2)).toBe(false);
    expect(paidRoundCount(payments, 'a')).toBe(2);
    expect(paidRoundCount(payments, 'b')).toBe(1);
  });
});

describe('recipientForRound', () => {
  it('finds the member whose slot matches the round', () => {
    const members = [member('a', 1), member('b', 2)];
    expect(recipientForRound(members, 2)?.id).toBe('b');
    expect(recipientForRound(members, 3)).toBe(null);
  });
});

describe('memberPosition', () => {
  it('tracks contributed, remaining obligation, received and net', () => {
    const payments = [pay('a', 1), pay('a', 2)];
    const pos = memberPosition(member('a', 1, true), payments, 10000, 5, 5);
    expect(pos.contributed).toBe(20000);
    expect(pos.totalDue).toBe(50000);
    expect(pos.remainingObligation).toBe(30000);
    expect(pos.received).toBe(50000);   // took their pool
    expect(pos.net).toBe(30000);        // ahead by the advance
  });
  it('received is zero until the payout is confirmed', () => {
    const pos = memberPosition(member('b', 5, false), [pay('b', 1)], 10000, 5, 5);
    expect(pos.received).toBe(0);
    expect(pos.net).toBe(-10000);
  });
});

describe('slotKind', () => {
  it('buckets slots into early / mid / late', () => {
    expect(slotKind(1, 12)).toBe('early');
    expect(slotKind(6, 12)).toBe('mid');
    expect(slotKind(12, 12)).toBe('late');
  });
});

describe('ballotOrder', () => {
  it('is a permutation of the input', () => {
    const order = ballotOrder(['a', 'b', 'c', 'd'], () => 0.5);
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(order).toHaveLength(4);
  });
  it('is deterministic for a fixed random fn', () => {
    const seq = [0.1, 0.4, 0.8, 0.2];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    expect(ballotOrder(['a', 'b', 'c', 'd'], rand)).toEqual(ballotOrder(['a', 'b', 'c', 'd'], (() => { let k = 0; return () => seq[k++ % seq.length]; })()));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Post-creation editing (UX-25). These mirror
// supabase/tests/tests/8w-kameti-editing.sql assertion for assertion — the two
// suites together are what catches a drift between the client's "why is this
// field greyed out" copy and the server's actual refusal.
// ───────────────────────────────────────────────────────────────────────────

describe('committeeEditState', () => {
  it('is `drawn` on a real ballot draw, and NEVER on a fixed kameti stamped drawnAt at creation', () => {
    // The trap: createCommittee stamps drawnAt on every fixed kameti, so a
    // drawnAt-based rule would freeze them all from birth.
    const fixedAtBirth = { ...committee, payoutMethod: 'fixed' as const, drawnAt: '2026-01-01', drawSeed: null };
    expect(committeeEditState(fixedAtBirth, [])).toBe('open');
    expect(committeeEditState({ drawSeed: 'abc' }, [])).toBe('drawn');
    expect(committeeEditState({ drawSeed: 'abc' }, [pay('a', 1)])).toBe('drawn');
  });
  it('is `collecting` the moment one contribution exists', () => {
    expect(committeeEditState({ drawSeed: null }, [])).toBe('open');
    expect(committeeEditState({ drawSeed: null }, [pay('a', 1)])).toBe('collecting');
  });
  it('only `open` unlocks the money-shaping fields', () => {
    expect(isMoneyShapeEditable('open')).toBe(true);
    expect(isMoneyShapeEditable('collecting')).toBe(false);
    expect(isMoneyShapeEditable('drawn')).toBe(false);
  });
});

describe('canAddCommitteeMember', () => {
  const base = { ...committee, payoutMethod: 'fixed' as const, startDate: '2026-01-15', totalRounds: 5, memberCount: 5 };
  const roster = [member('a', 1), member('b', 2)];
  const inCycle = new Date('2026-02-01');

  it('allows an add mid-collection while nobody has taken their pool', () => {
    expect(canAddCommitteeMember(base, roster, inCycle)).toEqual({ ok: true });
  });
  it('refuses once ANY payout is confirmed (the pool would grow for the rest)', () => {
    expect(canAddCommitteeMember(base, [member('a', 1, true), member('b', 2)], inCycle))
      .toEqual({ ok: false, reason: 'payout_confirmed' });
  });
  it('refuses after the ballot draw and on a completed kameti', () => {
    expect(canAddCommitteeMember({ ...base, drawSeed: 'seed' }, roster, inCycle))
      .toEqual({ ok: false, reason: 'drawn' });
    expect(canAddCommitteeMember({ ...base, status: 'completed' }, roster, inCycle))
      .toEqual({ ok: false, reason: 'completed' });
  });
  it('refuses when the round the newcomer would receive has already passed', () => {
    // Round 6 of a monthly cycle starting 2026-01-15 falls on 2026-06-15.
    expect(canAddCommitteeMember(base, roster, new Date('2026-06-14'))).toEqual({ ok: true });
    expect(canAddCommitteeMember(base, roster, new Date('2026-06-15')))
      .toEqual({ ok: false, reason: 'cycle_over' });
    expect(canAddCommitteeMember(base, roster, new Date('2027-01-01')))
      .toEqual({ ok: false, reason: 'cycle_over' });
  });
});

describe('canRemoveCommitteeMember', () => {
  // Four slots, four members; the organiser holds slot 1.
  const base = { ...committee, memberCount: 4, totalRounds: 4, drawSeed: null };
  const roster: CommitteeMember[] = [
    { ...member('a', 1), isOrganizer: true },
    member('b', 2), member('c', 3), member('d', 4),
  ];

  it('allows a clean member and reports how many slots shift down', () => {
    expect(canRemoveCommitteeMember(base, roster, [], 'b')).toEqual({ ok: true, slotsShifted: 2 });
    expect(canRemoveCommitteeMember(base, roster, [], 'd')).toEqual({ ok: true, slotsShifted: 0 });
  });
  it('refuses the organiser, an unknown member, and a drop below two members', () => {
    expect(canRemoveCommitteeMember(base, roster, [], 'a')).toEqual({ ok: false, reason: 'organizer' });
    expect(canRemoveCommitteeMember(base, roster, [], 'zzz')).toEqual({ ok: false, reason: 'not_found' });
    expect(canRemoveCommitteeMember({ ...base, memberCount: 2 }, roster, [], 'b'))
      .toEqual({ ok: false, reason: 'too_few' });
  });
  it('refuses after the draw, with payments of their own, or after their payout', () => {
    expect(canRemoveCommitteeMember({ ...base, drawSeed: 'seed' }, roster, [], 'b'))
      .toEqual({ ok: false, reason: 'drawn' });
    expect(canRemoveCommitteeMember(base, roster, [pay('b', 1)], 'b'))
      .toEqual({ ok: false, reason: 'member_has_payments' });
    expect(canRemoveCommitteeMember(base, [roster[0], member('b', 2, true), roster[2], roster[3]], [], 'b'))
      .toEqual({ ok: false, reason: 'payout_received' });
  });
  it('protects rounds that have already been collected, but not the untouched tail', () => {
    // A contribution for round 2 pins slot 2 (and everything above it), because
    // the compaction would re-number the round that money belongs to.
    expect(canRemoveCommitteeMember(base, roster, [pay('a', 2)], 'b'))
      .toEqual({ ok: false, reason: 'rounds_collected' });
    // …while round 1 money leaves the slot-2 member removable.
    expect(canRemoveCommitteeMember(base, roster, [pay('a', 1)], 'b'))
      .toEqual({ ok: true, slotsShifted: 2 });
    // The LAST slot is pinned by any payment in the last round only.
    expect(canRemoveCommitteeMember(base, roster, [pay('a', 1)], 'd'))
      .toEqual({ ok: true, slotsShifted: 0 });
    expect(canRemoveCommitteeMember(base, roster, [pay('a', 4)], 'd'))
      .toEqual({ ok: false, reason: 'rounds_collected' });
  });
  it('an unslotted member is judged against the LAST round (removal drops one)', () => {
    const unslotted = [...roster.slice(0, 3), member('e', null)];
    expect(canRemoveCommitteeMember(base, unslotted, [pay('a', 1)], 'e'))
      .toEqual({ ok: true, slotsShifted: 0 });
    expect(canRemoveCommitteeMember(base, unslotted, [pay('a', 4)], 'e'))
      .toEqual({ ok: false, reason: 'rounds_collected' });
  });
});

describe('canReorderCommittee', () => {
  // Latent path (setFixedOrder has no UI caller today) — mirrors
  // committeeEditState exactly: open unlocks it, any payment or a real draw
  // locks it.
  const roster = [member('a', 1), member('b', 2)];

  it('allows a reorder while the kameti is open', () => {
    expect(canReorderCommittee({ drawSeed: null }, roster, [])).toEqual({ ok: true });
  });
  it('locks the moment one contribution exists', () => {
    expect(canReorderCommittee({ drawSeed: null }, roster, [pay('a', 1)]))
      .toEqual({ ok: false, reason: 'collecting' });
  });
  it('locks a real ballot draw, even with no payments recorded', () => {
    expect(canReorderCommittee({ drawSeed: 'seed' }, roster, []))
      .toEqual({ ok: false, reason: 'drawn' });
  });
});

describe('buildSchedule', () => {
  it('produces a row per round with date, recipient and pool', () => {
    const members = [member('a', 1), member('b', 2), member('c', 3), member('d', 4), member('e', 5)];
    const rows = buildSchedule(committee, members);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ round: 1, recipientId: 'a', pool: 50000 });
    expect(rows[4]).toMatchObject({ round: 5, recipientId: 'e' });
    expect(ymd(rows[2].date)).toBe('2026-03-15');
  });
});
