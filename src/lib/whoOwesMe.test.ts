import { describe, it, expect } from 'vitest';
import {
  buildAdhocSplitIndex,
  buildWhoOwesMe,
  findLikelyDuplicateRows,
  personKeyOf,
  resolveGroupMemberIdentity,
  resolveMeMemberId,
  whoOwesTotals,
  type WhoOwesGroupInput,
} from './whoOwesMe';
import { buildInternalNote } from './internalNotes';
import type { Currency, GroupMember, Loan, Person, Transaction } from '../db';

// ── Fixtures ───────────────────────────────────────────────────────────────

const loan = (over: Partial<Loan> & { id: string }): Loan => ({
  personName: 'Bilal',
  personId: null,
  type: 'given',
  totalAmount: 100,
  remainingAmount: 100,
  currency: 'AED' as Currency,
  status: 'active',
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const contact = (over: Partial<Person> & { id: string; name: string }): Person => ({
  phone: null,
  linkedProfileId: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const member = (over: Partial<GroupMember> & { id: string; name: string }): GroupMember => ({
  isOwner: false,
  profileId: null,
  ...over,
});

const txn = (over: Partial<Transaction> & { id: string }): Transaction => ({
  type: 'loan_given',
  amount: 100,
  currency: 'AED' as Currency,
  sourceAccountId: null,
  destinationAccountId: null,
  relatedPerson: null,
  relatedLoanId: null,
  relatedGoalId: null,
  conversionRate: null,
  category: '',
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// A Dubai-trip group: me (member m-me, my auth uid), Bilal (linked contact
// c-bilal), and Chand (nobody's contact).
const ME_UID = 'uid-me';
const tripGroup = (debts: WhoOwesGroupInput['debts']): WhoOwesGroupInput => ({
  groupId: 'g-trip',
  groupName: 'Dubai Trip',
  currency: 'AED' as Currency,
  members: [
    member({ id: 'm-me', name: 'Me', isOwner: true, profileId: ME_UID }),
    member({ id: 'm-bilal', name: 'Bilal', profileId: 'uid-bilal' }),
    member({ id: 'm-chand', name: 'Chand' }),
  ],
  debts,
});

const debt = (from: string, fromName: string, to: string, toName: string, amount: number) => ({
  from,
  fromName,
  to,
  toName,
  amount,
});

const bilalContact = contact({ id: 'c-bilal', name: 'Bilal', linkedProfileId: 'uid-bilal' });

// ── personKeyOf ────────────────────────────────────────────────────────────

describe('personKeyOf', () => {
  it('is the contact id when there is one', () => {
    expect(personKeyOf('c-bilal', 'Bilal')).toBe('c-bilal');
  });

  it('falls back to the lowercased trimmed name — the repo-wide rule', () => {
    expect(personKeyOf(null, '  BILAL  ')).toBe('bilal');
  });
});

// ── Group member → person key ──────────────────────────────────────────────

describe('resolveGroupMemberIdentity', () => {
  it('matches on the profile link first — the only provable identification', () => {
    const out = resolveGroupMemberIdentity(member({ id: 'm-bilal', name: 'B. Ahmed', profileId: 'uid-bilal' }), [
      bilalContact,
    ]);
    expect(out).toEqual({ personKey: 'c-bilal', personId: 'c-bilal', personName: 'Bilal', matchedBy: 'profile' });
  });

  it('falls back to a unique name match', () => {
    const out = resolveGroupMemberIdentity(member({ id: 'm-x', name: ' bilal ' }), [
      contact({ id: 'c-bilal', name: 'Bilal' }),
    ]);
    expect(out).toMatchObject({ personKey: 'c-bilal', personId: 'c-bilal', matchedBy: 'name' });
  });

  it('refuses an ambiguous name match — two contacts called Bilal stay unmatched', () => {
    const out = resolveGroupMemberIdentity(member({ id: 'm-x', name: 'Bilal' }), [
      contact({ id: 'c-1', name: 'Bilal' }),
      contact({ id: 'c-2', name: 'bilal' }),
    ]);
    expect(out).toEqual({ personKey: 'bilal', personId: null, personName: 'Bilal', matchedBy: 'none' });
  });

  it('does not let an archived contact win a name guess', () => {
    const out = resolveGroupMemberIdentity(member({ id: 'm-x', name: 'Chand' }), [
      contact({ id: 'c-old', name: 'Chand', archivedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(out.matchedBy).toBe('none');
    expect(out.personKey).toBe('chand');
  });

  it('keys a member who is nobody′s contact by name', () => {
    const out = resolveGroupMemberIdentity(member({ id: 'm-chand', name: 'Chand' }), [bilalContact]);
    expect(out).toEqual({ personKey: 'chand', personId: null, personName: 'Chand', matchedBy: 'none' });
  });
});

describe('resolveMeMemberId', () => {
  it('prefers the explicit id, then the profile match, then the owner', () => {
    const g = tripGroup([]);
    expect(resolveMeMemberId({ ...g, meMemberId: 'm-bilal' }, ME_UID)).toBe('m-bilal');
    expect(resolveMeMemberId(g, ME_UID)).toBe('m-me');
    expect(resolveMeMemberId(g, 'uid-nobody')).toBe('m-me'); // owner fallback
    expect(resolveMeMemberId({ ...g, members: [member({ id: 'm-x', name: 'X' })] }, null)).toBeNull();
  });
});

// ── Ad-hoc split index ─────────────────────────────────────────────────────

describe('buildAdhocSplitIndex', () => {
  it('maps a split-event loan back to its event', () => {
    const index = buildAdhocSplitIndex([
      txn({
        id: 't1',
        relatedLoanId: 'l-lunch',
        notes: buildInternalNote('', { splitEventId: 'se-1', splitLabel: 'Friday lunch' }),
      }),
      txn({ id: 't2', relatedLoanId: 'l-plain', notes: 'just a loan' }),
    ]);
    expect(index.get('l-lunch')).toEqual({ splitEventId: 'se-1', label: 'Friday lunch' });
    expect(index.has('l-plain')).toBe(false);
  });

  it('ignores deleted rows and rows with no loan behind them', () => {
    const meta = buildInternalNote('', { splitEventId: 'se-1', splitLabel: 'Lunch' });
    const index = buildAdhocSplitIndex([
      txn({ id: 't1', relatedLoanId: 'l-1', notes: meta, deletedAt: '2026-02-01T00:00:00.000Z' }),
      txn({ id: 't2', relatedLoanId: null, notes: meta }),
    ]);
    expect(index.size).toBe(0);
  });
});

// ── The aggregator ─────────────────────────────────────────────────────────

describe('buildWhoOwesMe — one person across all three mechanisms', () => {
  const loans: Loan[] = [
    loan({ id: 'l-cash', personId: 'c-bilal', personName: 'Bilal', type: 'given', remainingAmount: 500, notes: 'Cash lent' }),
    loan({ id: 'l-lunch', personId: 'c-bilal', personName: 'Bilal', type: 'given', remainingAmount: 120, notes: 'Friday lunch' }),
  ];
  const rows = buildWhoOwesMe({
    loans,
    contacts: [bilalContact],
    currentProfileId: ME_UID,
    adhocByLoanId: new Map([['l-lunch', { splitEventId: 'se-1', label: 'Friday lunch' }]]),
    groups: [tripGroup([debt('m-me', 'Me', 'm-bilal', 'Bilal', 80)])],
  });

  it('nets a loan, an ad-hoc split and a group debt into ONE row', () => {
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.personKey).toBe('c-bilal');
    expect(row.currency).toBe('AED');
    expect(row.youAreOwed).toBe(620); // 500 loan + 120 ad-hoc
    expect(row.youOwe).toBe(80); // group debt where I am the payer
    expect(row.net).toBe(540);
    expect(row.matchedBy).toBe('profile');
  });

  it('keeps every source, labelled by mechanism, so the number can be explained', () => {
    expect(rows[0].sources).toEqual([
      { kind: 'loan', id: 'l-cash', amount: 500, direction: 'owed_to_me', currency: 'AED', label: 'Cash lent' },
      { kind: 'adhoc', id: 'se-1', amount: 120, direction: 'owed_to_me', currency: 'AED', label: 'Friday lunch' },
      { kind: 'group', id: 'g-trip', amount: 80, direction: 'i_owe', currency: 'AED', label: 'Dubai Trip', memberId: 'm-bilal' },
    ]);
  });

  it('counts an ad-hoc split ONCE — it is a relabelled loan, not extra money', () => {
    const withoutIndex = buildWhoOwesMe({ loans, contacts: [bilalContact] });
    expect(withoutIndex[0].youAreOwed).toBe(620); // same money, plainer labels
    expect(withoutIndex[0].sources.map((s) => s.kind)).toEqual(['loan', 'loan']);
  });
});

describe('buildWhoOwesMe — currency and direction are never merged', () => {
  it('splits one person into one row per currency', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-aed', personId: 'c-bilal', personName: 'Bilal', type: 'given', remainingAmount: 300, currency: 'AED' }),
        loan({ id: 'l-pkr', personId: 'c-bilal', personName: 'Bilal', type: 'taken', remainingAmount: 40000, currency: 'PKR' }),
      ],
      contacts: [bilalContact],
    });
    expect(rows).toHaveLength(2);
    const pkr = rows.find((r) => r.currency === 'PKR')!;
    const aed = rows.find((r) => r.currency === 'AED')!;
    expect(pkr.net).toBe(-40000);
    expect(aed.net).toBe(300);
    // Sorted by |net| desc, so the PKR row leads even though it is "smaller money".
    expect(rows[0].currency).toBe('PKR');
  });

  it('keeps both directions as separate columns on one row', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-1', personId: 'c-bilal', personName: 'Bilal', type: 'given', remainingAmount: 250 }),
        loan({ id: 'l-2', personId: 'c-bilal', personName: 'Bilal', type: 'taken', remainingAmount: 100 }),
      ],
      contacts: [bilalContact],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ youAreOwed: 250, youOwe: 100, net: 150 });
    expect(rows[0].sources.map((s) => s.direction)).toEqual(['owed_to_me', 'i_owe']);
  });
});

describe('buildWhoOwesMe — settled and deleted items are excluded', () => {
  it('drops settled, fully-repaid and deleted loans', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-settled', personName: 'Ali', status: 'settled', remainingAmount: 0 }),
        loan({ id: 'l-zero', personName: 'Ali', remainingAmount: 0 }),
        loan({ id: 'l-dust', personName: 'Ali', remainingAmount: 0.004 }),
        loan({ id: 'l-deleted', personName: 'Ali', remainingAmount: 900, deletedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it('keeps a partially repaid loan at its remaining amount, not its total', () => {
    const rows = buildWhoOwesMe({
      loans: [loan({ id: 'l-1', personName: 'Ali', totalAmount: 1000, remainingAmount: 250 })],
    });
    expect(rows[0].youAreOwed).toBe(250);
  });

  it('ignores a group debt that netted to zero (settled group pair)', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      currentProfileId: ME_UID,
      groups: [tripGroup([debt('m-me', 'Me', 'm-bilal', 'Bilal', 0)])],
    });
    expect(rows).toEqual([]);
  });
});

describe('buildWhoOwesMe — group members who are not contacts', () => {
  it('keys an unknown member by name and flags the weak match', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      contacts: [bilalContact],
      currentProfileId: ME_UID,
      groups: [tripGroup([debt('m-chand', 'Chand', 'm-me', 'Me', 210)])],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      personKey: 'chand',
      personId: null,
      personName: 'Chand',
      youAreOwed: 210,
      matchedBy: 'none',
    });
  });

  it('merges a name-keyed member with a name-keyed loan — the documented ambiguity', () => {
    const rows = buildWhoOwesMe({
      loans: [loan({ id: 'l-1', personName: 'Chand', personId: null, type: 'taken', remainingAmount: 60 })],
      currentProfileId: ME_UID,
      groups: [tripGroup([debt('m-chand', 'Chand', 'm-me', 'Me', 210)])],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ personKey: 'chand', youAreOwed: 210, youOwe: 60, net: 150 });
  });

  it('does NOT merge a contact-backed row with a same-name free-hand loan', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-linked', personId: 'c-bilal', personName: 'Bilal', remainingAmount: 300 }),
        loan({ id: 'l-typed', personId: null, personName: 'Bilal', remainingAmount: 90 }),
      ],
      contacts: [bilalContact],
    });
    expect(rows).toHaveLength(2);
    const hints = findLikelyDuplicateRows(rows);
    expect(hints).toHaveLength(1);
    expect(hints[0].linked.personKey).toBe('c-bilal');
    expect(hints[0].unlinked.personKey).toBe('bilal');
  });

  it('excludes group edges between two OTHER members — not my money', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      currentProfileId: ME_UID,
      groups: [tripGroup([debt('m-chand', 'Chand', 'm-bilal', 'Bilal', 500)])],
    });
    expect(rows).toEqual([]);
  });

  it('counts nothing from a group where "me" cannot be identified', () => {
    const g = tripGroup([debt('m-chand', 'Chand', 'm-bilal', 'Bilal', 500)]);
    const rows = buildWhoOwesMe({
      loans: [],
      groups: [{ ...g, members: g.members.map((m) => member({ ...m, isOwner: false })) }],
      currentProfileId: 'uid-stranger',
    });
    expect(rows).toEqual([]);
  });
});

describe('buildWhoOwesMe — ledger-only (splits_only) mode', () => {
  it('counts loans with no account leg and no transaction rows at all', () => {
    // splits_only writes Loan rows only — no transactions, no accounts. The
    // aggregator reads obligations, so the answer must be identical.
    const loans = [
      loan({ id: 'l-1', personName: 'Ali', type: 'given', remainingAmount: 400, notes: 'Ledger lunch' }),
      loan({ id: 'l-2', personName: 'Ali', type: 'taken', remainingAmount: 150 }),
    ];
    const ledgerRows = buildWhoOwesMe({ loans, adhocByLoanId: buildAdhocSplitIndex([]) });
    expect(ledgerRows[0]).toMatchObject({ personKey: 'ali', youAreOwed: 400, youOwe: 150, net: 250 });
    // Same loans in tracker mode (transactions exist) net identically.
    const trackerRows = buildWhoOwesMe({
      loans,
      adhocByLoanId: buildAdhocSplitIndex([
        txn({ id: 't1', relatedLoanId: 'l-1', notes: buildInternalNote('', { splitEventId: 'se-9', splitLabel: 'Lunch' }) }),
      ]),
    });
    expect(trackerRows[0].net).toBe(250);
    expect(trackerRows[0].sources.map((s) => s.kind)).toEqual(['adhoc', 'loan']);
  });
});

describe('buildWhoOwesMe — linked loans', () => {
  it('marks a mirrored loan so the UI can route it to the cross-user flow', () => {
    const rows = buildWhoOwesMe({
      loans: [loan({ id: 'l-1', personName: 'Ali', remainingAmount: 200, loanPairId: 'pair-1' })],
    });
    expect(rows[0].sources[0].linked).toBe(true);
  });

  it('leaves the flag off an ordinary loan', () => {
    const rows = buildWhoOwesMe({ loans: [loan({ id: 'l-1', personName: 'Ali', remainingAmount: 200 })] });
    expect(rows[0].sources[0].linked).toBeUndefined();
  });
});

describe('buildWhoOwesMe — ordering', () => {
  it('sorts by |net| descending, so the biggest relationship leads', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-1', personName: 'Small', remainingAmount: 10 }),
        loan({ id: 'l-2', personName: 'Big', type: 'taken', remainingAmount: 900 }),
        loan({ id: 'l-3', personName: 'Mid', remainingAmount: 300 }),
      ],
    });
    expect(rows.map((r) => r.personName)).toEqual(['Big', 'Mid', 'Small']);
  });

  it('is stable regardless of input order', () => {
    const loans = [
      loan({ id: 'l-1', personName: 'Ali', remainingAmount: 100 }),
      loan({ id: 'l-2', personName: 'Bilal', remainingAmount: 100 }),
    ];
    const forward = buildWhoOwesMe({ loans });
    const reverse = buildWhoOwesMe({ loans: [...loans].reverse() });
    expect(forward).toEqual(reverse);
  });
});

describe('whoOwesTotals', () => {
  it('totals per currency and never across them', () => {
    const rows = buildWhoOwesMe({
      loans: [
        loan({ id: 'l-1', personName: 'Ali', remainingAmount: 300, currency: 'AED' }),
        loan({ id: 'l-2', personName: 'Bilal', type: 'taken', remainingAmount: 100, currency: 'AED' }),
        loan({ id: 'l-3', personName: 'Ali', remainingAmount: 5000, currency: 'PKR' }),
      ],
    });
    const totals = whoOwesTotals(rows);
    expect(totals).toEqual([
      { currency: 'PKR', youAreOwed: 5000, youOwe: 0, net: 5000, people: 1 },
      { currency: 'AED', youAreOwed: 300, youOwe: 100, net: 200, people: 2 },
    ]);
  });

  it('is empty for no rows', () => {
    expect(whoOwesTotals([])).toEqual([]);
  });
});
