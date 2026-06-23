import { describe, it, expect } from 'vitest';
import {
  poolAmount, roundDate, currentRound, hasPaid, paidRoundCount,
  recipientForRound, memberPosition, slotKind, ballotOrder, buildSchedule,
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
