import { describe, expect, it } from 'vitest';
import { buildRepaymentGroups } from './repaymentGroups';
import type { Loan } from '../db';

function loan(over: Partial<Loan> & Pick<Loan, 'id'>): Loan {
  return {
    personName: 'Ali',
    personId: null,
    type: 'given',
    totalAmount: 100,
    remainingAmount: 100,
    currency: 'AED',
    status: 'active',
    notes: '',
    createdAt: '2026-01-01',
    ...over,
  };
}

const none = new Set<string>();

describe('buildRepaymentGroups — grouping', () => {
  it('groups by personId when present, name otherwise', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'a', personId: 'p1', personName: 'Ali' }),
        loan({ id: 'b', personId: 'p1', personName: 'Ali' }),
        loan({ id: 'c', personName: ' ali ' }), // no personId — separate bucket from p1
      ],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === 'given:AED:p1')?.loans.map((l) => l.id).sort()).toEqual(['a', 'b']);
    expect(groups.find((g) => g.key === 'given:AED:ali')?.loans.map((l) => l.id)).toEqual(['c']);
  });

  it('splits per currency — never nets AED against PKR', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'a', personId: 'p1', currency: 'AED', remainingAmount: 100 }),
        loan({ id: 'b', personId: 'p1', currency: 'PKR', remainingAmount: 5000 }),
      ],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups.map((g) => g.key).sort()).toEqual(['given:AED:p1', 'given:PKR:p1']);
    expect(groups.find((g) => g.currency === 'AED')?.totalRemaining).toBe(100);
    expect(groups.find((g) => g.currency === 'PKR')?.totalRemaining).toBe(5000);
  });

  it('filters by direction: received → given, paid → taken', () => {
    const both = [
      loan({ id: 'g', type: 'given' }),
      loan({ id: 't', type: 'taken' }),
    ];
    const received = buildRepaymentGroups({ loans: both, direction: 'received', linkedLoanIds: none });
    const paid = buildRepaymentGroups({ loans: both, direction: 'paid', linkedLoanIds: none });
    expect(received.flatMap((g) => g.loans.map((l) => l.id))).toEqual(['g']);
    expect(received[0].direction).toBe('given');
    expect(paid.flatMap((g) => g.loans.map((l) => l.id))).toEqual(['t']);
    expect(paid[0].direction).toBe('taken');
  });

  it('excludes settled loans entirely', () => {
    const groups = buildRepaymentGroups({
      loans: [loan({ id: 'a' }), loan({ id: 'b', status: 'settled', remainingAmount: 0 })],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups[0].loans.map((l) => l.id)).toEqual(['a']);
  });
});

describe('buildRepaymentGroups — linked split', () => {
  it('routes linked loans to `linked`, keeps them out of the allocatable cap', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'local', personId: 'p1', remainingAmount: 100 }),
        loan({ id: 'mirrored', personId: 'p1', remainingAmount: 400 }),
      ],
      direction: 'received',
      linkedLoanIds: new Set(['mirrored']),
    });
    const g = groups[0];
    expect(g.allocatable.map((l) => l.id)).toEqual(['local']);
    expect(g.linked.map((l) => l.id)).toEqual(['mirrored']);
    expect(g.allocatableRemaining).toBe(100);
    expect(g.totalRemaining).toBe(500);
  });

  it('a fully-linked group has an empty allocatable set', () => {
    const groups = buildRepaymentGroups({
      loans: [loan({ id: 'm1', personId: 'p1' })],
      direction: 'received',
      linkedLoanIds: new Set(['m1']),
    });
    expect(groups[0].allocatable).toHaveLength(0);
    expect(groups[0].allocatableRemaining).toBe(0);
  });

  it('near-zero remainings are not allocatable', () => {
    const groups = buildRepaymentGroups({
      loans: [loan({ id: 'dust', remainingAmount: 0.01 }), loan({ id: 'real', remainingAmount: 50 })],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups[0].allocatable.map((l) => l.id)).toEqual(['real']);
  });
});

describe('buildRepaymentGroups — filters and order', () => {
  it('personIdFilter keeps only that person (and drops null-personId strangers)', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'a', personId: 'p1' }),
        loan({ id: 'b', personId: 'p2' }),
        loan({ id: 'c', personId: null, personName: 'Ali' }),
      ],
      direction: 'received',
      linkedLoanIds: none,
      personIdFilter: 'p1',
    });
    expect(groups.flatMap((g) => g.loans.map((l) => l.id))).toEqual(['a']);
  });

  it('query matches person name or loan note, case-insensitive', () => {
    const loans = [
      loan({ id: 'a', personId: 'p1', personName: 'Bilal' }),
      loan({ id: 'b', personId: 'p2', personName: 'Sara', notes: 'Eid udhaar' }),
    ];
    const byName = buildRepaymentGroups({ loans, direction: 'received', linkedLoanIds: none, query: 'bil' });
    const byNote = buildRepaymentGroups({ loans, direction: 'received', linkedLoanIds: none, query: 'EID' });
    expect(byName.flatMap((g) => g.loans.map((l) => l.id))).toEqual(['a']);
    expect(byNote.flatMap((g) => g.loans.map((l) => l.id))).toEqual(['b']);
  });

  it('sorts groups by totalRemaining desc and loans within by remaining desc', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'small', personId: 'p1', remainingAmount: 10 }),
        loan({ id: 'big1', personId: 'p2', remainingAmount: 300 }),
        loan({ id: 'big2', personId: 'p2', remainingAmount: 700 }),
      ],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups.map((g) => g.key)).toEqual(['given:AED:p2', 'given:AED:p1']);
    expect(groups[0].loans.map((l) => l.id)).toEqual(['big2', 'big1']);
  });

  it('sums with 2 dp rounding', () => {
    const groups = buildRepaymentGroups({
      loans: [
        loan({ id: 'a', personId: 'p1', remainingAmount: 33.33 }),
        loan({ id: 'b', personId: 'p1', remainingAmount: 33.34 }),
      ],
      direction: 'received',
      linkedLoanIds: none,
    });
    expect(groups[0].allocatableRemaining).toBe(66.67);
    expect(groups[0].totalRemaining).toBe(66.67);
  });
});
