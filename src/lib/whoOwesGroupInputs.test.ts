import { describe, expect, it } from 'vitest';
import {
  GROUP_COUNTERPARTY_PREFIX,
  groupInputsForWhoOwes,
  groupInputsFromNetBalances,
  groupInputsFromPairwise,
  isGroupCounterpartyId,
  mergeGroupObligations,
  rowsWithPairwiseGroups,
} from './whoOwesGroupInputs';
import { buildWhoOwesMe, whoOwesTotals, type AdhocSplitRef } from './whoOwesMe';
import { computeMeraHisaab, type MeraHisaabTotals } from './meraHisaab';
import type { GroupDebt } from './groupDebts';
import type { Currency, GroupMember, Loan, Person, SplitGroup } from '../db';

const ME = 'profile-me';

function member(id: string, name: string, profileId: string | null = null, isOwner = false): GroupMember {
  return { id, name, isOwner, profileId };
}

function group(overrides: Partial<SplitGroup> = {}): SplitGroup {
  return {
    id: 'g1',
    name: 'Dubai Trip',
    emoji: '🏖️',
    members: [member('m-me', 'Me', ME), member('m-b', 'Bilal')],
    currency: 'AED' as Currency,
    settled: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('groupInputsFromNetBalances', () => {
  it('emits one "you ↔ the group" edge, owed TO you when the net is positive', () => {
    const [input] = groupInputsFromNetBalances([group()], { g1: 400 }, ME);
    expect(input.groupId).toBe('g1');
    expect(input.currency).toBe('AED');
    expect(input.meMemberId).toBe('m-me');
    expect(input.debts).toEqual([
      {
        from: `${GROUP_COUNTERPARTY_PREFIX}g1`,
        fromName: 'Dubai Trip',
        to: 'm-me',
        toName: 'Me',
        amount: 400,
      },
    ]);
  });

  it('flips the edge when you owe the group', () => {
    const [input] = groupInputsFromNetBalances([group()], { g1: -120.5 }, ME);
    expect(input.debts[0]).toMatchObject({
      from: 'm-me',
      to: `${GROUP_COUNTERPARTY_PREFIX}g1`,
      amount: 120.5,
    });
  });

  it('skips square groups, dust, and groups with no balance computed yet', () => {
    expect(groupInputsFromNetBalances([group()], { g1: 0 }, ME)).toEqual([]);
    expect(groupInputsFromNetBalances([group()], { g1: 0.004 }, ME)).toEqual([]);
    expect(groupInputsFromNetBalances([group()], {}, ME)).toEqual([]);
  });

  it('NEVER falls back to the group owner: no profile match ⇒ no obligation', () => {
    // The owner fallback in resolveMeMemberId is wrong for a group the user
    // does not belong to (docs/who-owes-me.md open risk 2). We refuse instead.
    const foreign = group({ members: [member('m-x', 'Xyz', 'someone-else', true)] });
    expect(groupInputsFromNetBalances([foreign], { g1: 400 }, ME)).toEqual([]);
    expect(groupInputsFromNetBalances([group()], { g1: 400 }, null)).toEqual([]);
  });

  it('keeps ARCHIVED groups: archiving closes a group, it does not forgive money', () => {
    const archived = group({ archivedAt: '2026-05-01T00:00:00Z' });
    expect(groupInputsFromNetBalances([archived], { g1: 90 }, ME)).toHaveLength(1);
  });

  it('marks the synthetic counterparty so the UI can tell it from a person', () => {
    const [input] = groupInputsFromNetBalances([group()], { g1: 400 }, ME);
    const other = input.members.find((m) => m.id !== 'm-me');
    expect(isGroupCounterpartyId(other?.id)).toBe(true);
    expect(isGroupCounterpartyId('m-me')).toBe(false);
    expect(isGroupCounterpartyId(undefined)).toBe(false);
  });

  it('never nets two currencies together', () => {
    const inputs = groupInputsFromNetBalances(
      [group(), group({ id: 'g2', name: 'Karachi', currency: 'PKR' as Currency })],
      { g1: 400, g2: -5000 },
      ME,
    );
    const totals = whoOwesTotals(buildWhoOwesMe({ loans: [], groups: inputs, currentProfileId: ME }));
    expect(totals.map((t) => [t.currency, t.net])).toEqual([
      ['PKR', -5000],
      ['AED', 400],
    ]);
  });
});

describe('groupInputsFromNetBalances → buildWhoOwesMe', () => {
  it('produces a GROUP row, not a fabricated person, and the money is exact', () => {
    const inputs = groupInputsFromNetBalances([group()], { g1: 400 }, ME);
    const rows = buildWhoOwesMe({ loans: [], groups: inputs, currentProfileId: ME });

    expect(rows).toHaveLength(1);
    expect(rows[0].personName).toBe('Dubai Trip');
    expect(rows[0].personId).toBeNull();
    expect(rows[0].youAreOwed).toBe(400);
    expect(rows[0].youOwe).toBe(0);
    expect(rows[0].sources).toEqual([
      {
        kind: 'group',
        id: 'g1',
        amount: 400,
        direction: 'owed_to_me',
        currency: 'AED',
        label: 'Dubai Trip',
        memberId: `${GROUP_COUNTERPARTY_PREFIX}g1`,
      },
    ]);
  });
});

describe('mergeGroupObligations', () => {
  const base: MeraHisaabTotals[] = [
    { currency: 'AED', accountsNet: 1000, receivable: 200, payable: 50, net: 1150 },
  ];

  it('adds the group side into the headline and recomputes the net', () => {
    const merged = mergeGroupObligations(base, [
      { currency: 'AED', youAreOwed: 400, youOwe: 100, net: 300, people: 2 },
    ]);
    expect(merged).toEqual([
      { currency: 'AED', accountsNet: 1000, receivable: 600, payable: 150, net: 1450 },
    ]);
  });

  it('adds a currency that exists ONLY in groups', () => {
    const merged = mergeGroupObligations(base, [
      { currency: 'PKR', youAreOwed: 0, youOwe: 5000, net: -5000, people: 1 },
    ]);
    expect(merged.find((e) => e.currency === 'PKR')).toEqual({
      currency: 'PKR',
      accountsNet: 0,
      receivable: 0,
      payable: 5000,
      net: -5000,
    });
    // AED is untouched.
    expect(merged.find((e) => e.currency === 'AED')?.net).toBe(1150);
  });

  it('is a no-op when there are no group obligations', () => {
    expect(mergeGroupObligations(base, [])).toEqual(base);
  });

  it('does not disturb the card-funded cash-advance exclusion', () => {
    // A cash advance drawn on a card that still exists must NOT be counted as
    // a payable — the card already carries it in accountsNet.
    const totals = computeMeraHisaab({
      accounts: [
        {
          id: 'card-1',
          name: 'Card',
          type: 'credit_card',
          balance: 5000,
          currency: 'AED' as Currency,
          metadata: { creditLimit: '10000' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      loans: [
        {
          id: 'l-1',
          personName: 'Bilal',
          personId: null,
          type: 'taken',
          totalAmount: 500,
          remainingAmount: 500,
          currency: 'AED' as Currency,
          status: 'active',
          notes: '',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
      cardFundedLoanIds: new Map([['l-1', 'card-1']]),
    });
    expect(totals[0].payable).toBe(0);

    const merged = mergeGroupObligations(totals, [
      { currency: 'AED', youAreOwed: 0, youOwe: 100, net: -100, people: 1 },
    ]);
    // Only the GROUP's 100 lands in payable; the advance is still excluded.
    expect(merged[0].payable).toBe(100);
    expect(merged[0].accountsNet).toBe(-5000);
    expect(merged[0].net).toBe(-5100);
  });
});

describe('guest members (audit G6 / O4)', () => {
  // A guest is a member row with no profileId and status 'connected'. The
  // adapter must behave identically: "me" is still resolved by profile match,
  // the counterparty is still the GROUP, and the money is still exact.
  const withGuest = group({
    members: [
      member('m-me', 'Me', ME),
      member('m-b', 'Bilal', 'profile-b'),
      { id: 'm-guest', name: 'Kamran', isOwner: false, profileId: null, status: 'connected' },
    ],
  });

  it('resolves "me" and emits the same single group edge when a guest is present', () => {
    const [input] = groupInputsFromNetBalances([withGuest], { g1: 250 }, ME);
    expect(input.meMemberId).toBe('m-me');
    expect(input.debts).toHaveLength(1);
    expect(input.debts[0].amount).toBe(250);
    // The guest is never emitted as a counterparty of its own — the adapter
    // only ever names the group, so there is no guessed person on the row.
    expect(isGroupCounterpartyId(input.debts[0].from)).toBe(true);
  });

  it('a guest-only group still nets correctly for the signed-in member', () => {
    const guestsOnly = group({
      members: [
        member('m-me', 'Me', ME, true),
        { id: 'm-guest', name: 'Kamran', isOwner: false, profileId: null, status: 'connected' },
      ],
    });
    const totals = whoOwesTotals(
      buildWhoOwesMe({
        loans: [],
        groups: groupInputsFromNetBalances([guestsOnly], { g1: -60 }, ME),
        currentProfileId: ME,
      }),
    );
    expect(totals).toEqual([
      expect.objectContaining({ currency: 'AED', youOwe: 60, youAreOwed: 0 }),
    ]);
  });

  it('is skipped when only a guest seat exists and none of them is me', () => {
    // A guest seat can never BE the signed-in user (no profile behind it), so a
    // group the user is not really in must contribute nothing rather than
    // falling back to the owner (docs/who-owes-me.md open risk 2).
    const notMine = group({
      members: [
        member('m-owner', 'Ayesha', 'profile-other', true),
        { id: 'm-guest', name: 'Kamran', isOwner: false, profileId: null, status: 'connected' },
      ],
    });
    expect(groupInputsFromNetBalances([notMine], { g1: 400 }, ME)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Per-PERSON group attribution (docs/who-owes-me.md open risk #1)
// ══════════════════════════════════════════════════════════════════════════

const BILAL_PROFILE = 'profile-b';

function contact(
  id: string,
  name: string,
  linkedProfileId: string | null = null,
  archivedAt: string | null = null,
): Person {
  return {
    id,
    name,
    linkedProfileId,
    archivedAt,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'l-1',
    personName: 'Bilal',
    personId: null,
    type: 'given',
    totalAmount: 100,
    remainingAmount: 100,
    currency: 'AED' as Currency,
    status: 'active',
    notes: 'Lunch',
    createdAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

// A 3-member group: me, Bilal (a real Hisaab user) and Kamran (a GUEST — no
// profileId). Both owe me; the two edges must sum to my net of 400.
const trio = group({
  members: [
    member('m-me', 'Me', ME, true),
    member('m-b', 'Bilal', BILAL_PROFILE),
    { id: 'm-guest', name: 'Kamran', isOwner: false, profileId: null, status: 'connected' },
  ],
});

const trioDebts: GroupDebt[] = [
  { from: 'm-b', fromName: 'Bilal', to: 'm-me', toName: 'Me', amount: 250 },
  { from: 'm-guest', fromName: 'Kamran', to: 'm-me', toName: 'Me', amount: 150 },
];

describe('groupInputsFromPairwise', () => {
  it('emits the real member edges, not a synthetic group counterparty', () => {
    const [input] = groupInputsFromPairwise([trio], { g1: trioDebts }, ME);
    expect(input.meMemberId).toBe('m-me');
    expect(input.members).toHaveLength(3);
    expect(input.debts).toEqual(trioDebts);
    expect(
      input.debts.some((d) => isGroupCounterpartyId(d.from) || isGroupCounterpartyId(d.to)),
    ).toBe(false);
  });

  it('skips groups the pairwise pass never covered, and square covered groups', () => {
    expect(groupInputsFromPairwise([trio], {}, ME)).toEqual([]);
    expect(groupInputsFromPairwise([trio], { g1: [] }, ME)).toEqual([]);
  });

  it('never falls back to the owner: no profile match ⇒ no obligation', () => {
    const foreign = group({ members: [member('m-x', 'Xyz', 'someone-else', true)] });
    expect(groupInputsFromPairwise([foreign], { g1: trioDebts }, ME)).toEqual([]);
    expect(groupInputsFromPairwise([trio], { g1: trioDebts }, null)).toEqual([]);
  });

  it('drops any edge between two OTHER members — never my money', () => {
    const withStrangers: GroupDebt[] = [
      ...trioDebts,
      { from: 'm-guest', fromName: 'Kamran', to: 'm-b', toName: 'Bilal', amount: 999 },
    ];
    const [input] = groupInputsFromPairwise([trio], { g1: withStrangers }, ME);
    expect(input.debts).toEqual(trioDebts);
  });

  it('keeps ARCHIVED groups: archiving closes a group, it does not forgive money', () => {
    const archived = group({ archivedAt: '2026-05-01T00:00:00Z', members: trio.members });
    expect(groupInputsFromPairwise([archived], { g1: trioDebts }, ME)).toHaveLength(1);
  });
});

describe('groupInputsFromPairwise → buildWhoOwesMe: rows are PEOPLE', () => {
  it('splits a 3-member group into two person rows that sum to my net', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      groups: groupInputsFromPairwise([trio], { g1: trioDebts }, ME),
      contacts: [contact('c-bilal', 'Bilal', BILAL_PROFILE)],
      currentProfileId: ME,
    });

    expect(rows.map((r) => [r.personName, r.net])).toEqual([
      ['Bilal', 250],
      ['Kamran', 150],
    ]);
    // The money is EXACTLY what the coarse group-net row carried.
    const net = rows.reduce((sum, r) => sum + r.net, 0);
    const [coarse] = buildWhoOwesMe({
      loans: [],
      groups: groupInputsFromNetBalances([trio], { g1: 400 }, ME),
      currentProfileId: ME,
    });
    expect(net).toBe(coarse.net);
    // ...and no row is the group itself any more.
    expect(rows.some((r) => r.personName === 'Dubai Trip')).toBe(false);
  });

  it('a GUEST member appears by NAME, keyed like a free-typed loan, never verified', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      groups: groupInputsFromPairwise([trio], { g1: trioDebts }, ME),
      contacts: [contact('c-bilal', 'Bilal', BILAL_PROFILE)],
      currentProfileId: ME,
    });
    const kamran = rows.find((r) => r.personName === 'Kamran');
    expect(kamran).toMatchObject({ personKey: 'kamran', personId: null, matchedBy: 'none' });
  });

  it('a member matching a contact MERGES into that contact row (profile link)', () => {
    const rows = buildWhoOwesMe({
      loans: [loan({ personId: 'c-bilal', personName: 'Bilal', remainingAmount: 100 })],
      groups: groupInputsFromPairwise([trio], { g1: trioDebts }, ME),
      contacts: [contact('c-bilal', 'Bilal', BILAL_PROFILE)],
      currentProfileId: ME,
    });
    const bilal = rows.find((r) => r.personKey === 'c-bilal');
    expect(bilal).toBeDefined();
    expect(bilal?.youAreOwed).toBe(350); // 100 loan + 250 group, ONE row
    expect(bilal?.matchedBy).toBe('profile');
    expect(bilal?.sources.map((s) => s.kind).sort()).toEqual(['group', 'loan']);
    expect(rows.filter((r) => r.personName === 'Bilal')).toHaveLength(1);
  });

  it('merges a NAME-matched member into that contact, and says the match is a guess', () => {
    // Kamran the guest has no profile, but exactly one live contact is named
    // Kamran ⇒ rule 2 fires: same row as the loan, matchedBy 'name'.
    const rows = buildWhoOwesMe({
      loans: [loan({ id: 'l-k', personId: 'c-kamran', personName: 'Kamran', remainingAmount: 50 })],
      groups: groupInputsFromPairwise([trio], { g1: trioDebts }, ME),
      contacts: [contact('c-kamran', 'Kamran')],
      currentProfileId: ME,
    });
    const kamran = rows.find((r) => r.personKey === 'c-kamran');
    expect(kamran?.youAreOwed).toBe(200); // 50 loan + 150 group
    expect(kamran?.matchedBy).toBe('name');
  });

  it('refuses a name guess when two live contacts share the name', () => {
    const rows = buildWhoOwesMe({
      loans: [],
      groups: groupInputsFromPairwise([trio], { g1: trioDebts }, ME),
      contacts: [contact('c-k1', 'Kamran'), contact('c-k2', 'Kamran')],
      currentProfileId: ME,
    });
    expect(rows.find((r) => r.personName === 'Kamran')).toMatchObject({
      personKey: 'kamran',
      personId: null,
      matchedBy: 'none',
    });
  });
});

describe('groupInputsForWhoOwes: pairwise first, net-balance fallback', () => {
  const other = group({ id: 'g2', name: 'Karachi', currency: 'PKR' as Currency });

  it('uses pairwise where it exists and the coarse edge where it does not', () => {
    const inputs = groupInputsForWhoOwes(
      [trio, other],
      { pairwiseByGroup: { g1: trioDebts }, balances: { g1: 400, g2: -5000 } },
      ME,
    );
    const g1 = inputs.find((i) => i.groupId === 'g1');
    const g2 = inputs.find((i) => i.groupId === 'g2');
    expect(g1?.debts).toEqual(trioDebts);
    expect(isGroupCounterpartyId(g2?.debts[0].to)).toBe(true);
    // Exactly one input per group — nothing is counted twice.
    expect(inputs).toHaveLength(2);
  });

  it('treats a COVERED but empty group as square, not as "not computed"', () => {
    // A stale `balances` entry must never resurrect a group the pairwise pass
    // just proved square.
    const inputs = groupInputsForWhoOwes(
      [trio],
      { pairwiseByGroup: { g1: [] }, balances: { g1: 400 } },
      ME,
    );
    expect(inputs).toEqual([]);
  });

  it('degrades to the coarse group edge with no pairwise data at all', () => {
    const inputs = groupInputsForWhoOwes([trio], { pairwiseByGroup: {}, balances: { g1: 400 } }, ME);
    expect(inputs).toHaveLength(1);
    expect(isGroupCounterpartyId(inputs[0].debts[0].from)).toBe(true);
  });
});

describe('rowsWithPairwiseGroups', () => {
  const contacts = [contact('c-bilal', 'Bilal', BILAL_PROFILE)];
  const loans = [loan({ personId: 'c-bilal', personName: 'Bilal', remainingAmount: 100 })];

  /** What a page holding only the coarse adapter builds today. */
  const coarseRows = () =>
    buildWhoOwesMe({
      loans,
      groups: groupInputsFromNetBalances([trio], { g1: 400 }, ME),
      contacts,
      currentProfileId: ME,
    });

  it('replaces the group row with the people behind it, conserving the money', () => {
    const before = coarseRows();
    expect(before.find((r) => r.personName === 'Dubai Trip')).toBeDefined();
    const grossBefore = before.reduce((s, r) => s + r.youAreOwed - r.youOwe, 0);

    const after = rowsWithPairwiseGroups(before, {
      groups: [trio],
      pairwiseByGroup: { g1: trioDebts },
      currentProfileId: ME,
      contacts,
    });

    expect(after.find((r) => r.personName === 'Dubai Trip')).toBeUndefined();
    expect(after.map((r) => [r.personName, r.net])).toEqual([
      ['Bilal', 350],
      ['Kamran', 150],
    ]);
    expect(after.reduce((s, r) => s + r.youAreOwed - r.youOwe, 0)).toBe(grossBefore);
  });

  it('hands back the SAME array when there is nothing to re-attribute', () => {
    const before = coarseRows();
    expect(
      rowsWithPairwiseGroups(before, {
        groups: [trio],
        pairwiseByGroup: {},
        currentProfileId: ME,
        contacts,
      }),
    ).toBe(before);
  });

  it('leaves loans, linked loans and ad-hoc splits untouched', () => {
    const before = buildWhoOwesMe({
      loans: [
        ...loans,
        loan({ id: 'l-2', personName: 'Ayesha', personId: null, type: 'taken', remainingAmount: 75 }),
      ],
      groups: groupInputsFromNetBalances([trio], { g1: 400 }, ME),
      contacts,
      currentProfileId: ME,
    });
    const after = rowsWithPairwiseGroups(before, {
      groups: [trio],
      pairwiseByGroup: { g1: trioDebts },
      currentProfileId: ME,
      contacts,
    });
    expect(after.find((r) => r.personName === 'Ayesha')).toEqual(
      before.find((r) => r.personName === 'Ayesha'),
    );
  });

  it('only re-attributes COVERED groups; an uncovered group keeps its coarse row', () => {
    const other = group({
      id: 'g2',
      name: 'Karachi',
      currency: 'AED' as Currency,
      members: trio.members,
    });
    const before = buildWhoOwesMe({
      loans: [],
      groups: groupInputsFromNetBalances([trio, other], { g1: 400, g2: 60 }, ME),
      contacts,
      currentProfileId: ME,
    });
    const after = rowsWithPairwiseGroups(before, {
      groups: [trio, other],
      pairwiseByGroup: { g1: trioDebts },
      currentProfileId: ME,
      contacts,
    });
    expect(after.find((r) => r.personName === 'Karachi')?.net).toBe(60);
    expect(after.find((r) => r.personName === 'Dubai Trip')).toBeUndefined();
    expect(after.reduce((s, r) => s + r.net, 0)).toBe(460);
  });
});

describe('both app modes (full_tracker vs splits_only)', () => {
  // Group tables never touch accounts and this whole pipeline has no account,
  // balance or transaction-as-money input — so the ONLY thing that differs
  // between modes is that a splits_only ad-hoc split writes no transaction
  // rows, leaving `adhocByLoanId` empty (docs/who-owes-me.md §2.2). Money,
  // people and group attribution must be identical either way.
  const contacts = [contact('c-bilal', 'Bilal', BILAL_PROFILE)];
  const loans = [
    loan({ id: 'l-split', personId: 'c-bilal', personName: 'Bilal', remainingAmount: 100 }),
  ];
  const adhoc = new Map<string, AdhocSplitRef>([
    ['l-split', { splitEventId: 'se-1', label: 'Friday lunch' }],
  ]);

  const build = (adhocByLoanId?: Map<string, AdhocSplitRef>) =>
    rowsWithPairwiseGroups(
      buildWhoOwesMe({
        loans,
        groups: groupInputsFromNetBalances([trio], { g1: 400 }, ME),
        contacts,
        currentProfileId: ME,
        adhocByLoanId,
      }),
      { groups: [trio], pairwiseByGroup: { g1: trioDebts }, currentProfileId: ME, contacts },
    );

  it('produces identical people, amounts and group attribution in both modes', () => {
    const fullTracker = build(adhoc); // transaction rows exist ⇒ split labelled
    const ledgerOnly = build(undefined); // no transaction rows at all
    const shape = (rows: ReturnType<typeof build>) =>
      rows.map((r) => [r.personKey, r.currency, r.youAreOwed, r.youOwe, r.net, r.matchedBy]);
    expect(shape(ledgerOnly)).toEqual(shape(fullTracker));

    // Group sources are identical: the group half never sees an account.
    const groupSources = (rows: ReturnType<typeof build>) =>
      rows.flatMap((r) => r.sources.filter((s) => s.kind === 'group'));
    expect(groupSources(ledgerOnly)).toEqual(groupSources(fullTracker));
  });

  it('differs ONLY in the ad-hoc label, exactly as documented', () => {
    const kinds = (rows: ReturnType<typeof build>) =>
      rows.flatMap((r) => r.sources.filter((s) => s.kind !== 'group').map((s) => s.kind));
    expect(kinds(build(adhoc))).toEqual(['adhoc']);
    expect(kinds(build(undefined))).toEqual(['loan']);
  });
});
