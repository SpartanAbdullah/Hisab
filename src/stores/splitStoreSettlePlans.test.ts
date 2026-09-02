// splitStore's settle-up selectors now delegate to the shared pure module.
//
// WHY THIS FILE EXISTS: `getSimplifiedDebts` used to carry a SECOND, inline
// copy of the greedy minimization (docs/who-owes-me.md §6b). That copy used a
// 0.01 tolerance instead of the repo's 0.005, sorted with no id tiebreak (so
// its output could shift with Map iteration order under ties), and had NO
// count guard — greedy is a heuristic, and on some balance sets it needs MORE
// transfers than the direct graph, so the "simplified" toggle could hand the
// user a bigger plan than the one it claimed to simplify.
//
// These tests pin the store's output to `buildSettlePlans` for real fixtures,
// so the two implementations can never drift apart again.
//
// The store's DB layer is mocked; the sibling stores it notifies are stubbed
// out so the module graph stays small. Nothing here touches money.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FixtureExpense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  paidBy: string;
  splitType: 'equal';
  splits: { memberId: string; amount: number }[];
  category: string;
  notes: string;
  date: string;
  createdAt: string;
}

interface FixtureSettlement {
  id: string;
  groupId: string;
  fromMember: string;
  toMember: string;
  amount: number;
  date: string;
  note: string;
  createdAt: string;
}

interface FixtureMember {
  id: string;
  name: string;
  isOwner: boolean;
  profileId: string | null;
}

const fixture: {
  members: FixtureMember[];
  expenses: FixtureExpense[];
  settlements: FixtureSettlement[];
} = { members: [], expenses: [], settlements: [] };

vi.mock('../lib/supabaseDb', () => {
  const notImplemented = () => {
    throw new Error('not used by these tests');
  };
  return {
    splitGroupsDb: {
      get: async (id: string) =>
        id === 'g1'
          ? {
              id: 'g1',
              name: 'Dubai Trip',
              emoji: '🏖️',
              members: [],
              currency: 'AED',
              settled: false,
              createdAt: '2026-01-01T00:00:00Z',
            }
          : null,
      getAll: async () => [],
    },
    groupMembersDb: {
      getByGroup: async (id: string) => (id === 'g1' ? fixture.members : []),
      getByGroups: async () => new Map(),
      update: notImplemented,
    },
    groupExpensesDb: {
      getByGroup: async (id: string) => (id === 'g1' ? fixture.expenses : []),
      getAllVisibleForBalances: async () => [],
    },
    groupSettlementsDb: {
      getByGroup: async (id: string) => (id === 'g1' ? fixture.settlements : []),
      getAllVisibleForBalances: async () => [],
    },
    groupInvitesDb: {},
    groupEventsDb: {},
    groupsLookupDb: {},
    groupMembershipDb: {},
    groupArchiveDb: {},
    groupOwnershipDb: {},
    transactionsDb: {},
  };
});

vi.mock('./activityStore', () => ({
  useActivityStore: { getState: () => ({ logActivity: async () => {} }) },
}));
vi.mock('./transactionStore', () => ({
  useTransactionStore: { getState: () => ({}) },
}));

const { useSplitStore } = await import('./splitStore');
const { computePairwiseDebts } = await import('../lib/groupDebts');
const { buildSettlePlans } = await import('../lib/settleUpMinimize');

function member(id: string, name: string, isOwner = false): FixtureMember {
  return { id, name, isOwner, profileId: null };
}

function expense(
  id: string,
  paidBy: string,
  amount: number,
  splits: { memberId: string; amount: number }[],
): FixtureExpense {
  return {
    id,
    groupId: 'g1',
    description: id,
    amount,
    paidBy,
    splitType: 'equal',
    splits,
    category: 'Food & Dining',
    notes: '',
    date: '2026-02-01T00:00:00Z',
    createdAt: '2026-02-01T00:00:00Z',
  };
}

/** What the store SHOULD return, computed straight from the pure module. */
function expectedPlans() {
  return buildSettlePlans({
    currency: 'AED',
    debts: computePairwiseDebts(fixture.members, fixture.expenses, fixture.settlements),
  });
}

beforeEach(() => {
  useSplitStore.getState().reset();
  fixture.members = [member('a', 'Ali', true), member('b', 'Bilal'), member('c', 'Sara')];
  fixture.expenses = [];
  fixture.settlements = [];
});

describe('splitStore.getSettlePlans', () => {
  it('returns EXACTLY what buildSettlePlans produces for the group fixture', async () => {
    // Ali owes Bilal 50; Bilal owes Sara 50.
    fixture.expenses = [
      expense('e1', 'b', 50, [{ memberId: 'a', amount: 50 }]),
      expense('e2', 'c', 50, [{ memberId: 'b', amount: 50 }]),
    ];

    const plans = await useSplitStore.getState().getSettlePlans('g1');
    expect(plans).toEqual(expectedPlans());
  });

  it('exposes both plans plus the honesty counters the toggle needs', async () => {
    fixture.expenses = [
      expense('e1', 'b', 50, [{ memberId: 'a', amount: 50 }]),
      expense('e2', 'c', 50, [{ memberId: 'b', amount: 50 }]),
    ];

    const plans = await useSplitStore.getState().getSettlePlans('g1');
    expect(plans?.currency).toBe('AED');
    expect(plans?.direct.count).toBe(2);
    expect(plans?.minimized.count).toBe(1);
    expect(plans?.transfersSaved).toBe(1);
    // The one minimized transfer is Ali → Sara: two people who never split a
    // bill with each other. The toggle owes the user that warning.
    expect(plans?.rerouted).toHaveLength(1);
    expect(plans?.rerouted[0]).toMatchObject({ from: 'a', to: 'c', amount: 50 });
    expect(plans?.minimizedFellBackToDirect).toBe(false);
  });

  it('settlements pay debts down, and the plans follow', async () => {
    fixture.expenses = [expense('e1', 'b', 50, [{ memberId: 'a', amount: 50 }])];
    fixture.settlements = [
      {
        id: 's1',
        groupId: 'g1',
        fromMember: 'a',
        toMember: 'b',
        amount: 50,
        date: '2026-02-02T00:00:00Z',
        note: '',
        createdAt: '2026-02-02T00:00:00Z',
      },
    ];

    const plans = await useSplitStore.getState().getSettlePlans('g1');
    expect(plans).toEqual(expectedPlans());
    expect(plans?.direct.count).toBe(0);
    expect(plans?.minimized.count).toBe(0);
  });

  it('is null for a group that cannot be read', async () => {
    expect(await useSplitStore.getState().getSettlePlans('nope')).toBeNull();
  });
});

describe('splitStore.getSimplifiedDebts', () => {
  it('is the minimized plan of getSettlePlans, unchanged in shape', async () => {
    fixture.expenses = [
      expense('e1', 'b', 50, [{ memberId: 'a', amount: 50 }]),
      expense('e2', 'c', 50, [{ memberId: 'b', amount: 50 }]),
    ];

    const debts = await useSplitStore.getState().getSimplifiedDebts('g1');
    expect(debts).toEqual(expectedPlans().minimized.transfers);
    // GroupDetailPage / GroupSettleUpModal read these five fields.
    expect(debts[0]).toEqual({
      from: 'a',
      fromName: 'Ali',
      to: 'c',
      toName: 'Sara',
      amount: 50,
    });
  });

  it('NEVER hands back a "simplified" plan bigger than the direct one', async () => {
    // Nets a:−4 b:−3 c:+2 d:+2 e:+3 settle DIRECTLY in 3 transfers; the greedy
    // pass needs 4. The old inline implementation returned all 4 under the
    // "Simplified" label. buildSettlePlans falls back to direct instead.
    fixture.members = [
      member('a', 'Ali', true),
      member('b', 'Bilal'),
      member('c', 'Sara'),
      member('d', 'Danish'),
      member('e', 'Erum'),
    ];
    fixture.expenses = [
      expense('e1', 'e', 3, [{ memberId: 'b', amount: 3 }]),
      expense('e2', 'c', 2, [{ memberId: 'a', amount: 2 }]),
      expense('e3', 'd', 2, [{ memberId: 'a', amount: 2 }]),
    ];

    const plans = await useSplitStore.getState().getSettlePlans('g1');
    expect(plans?.direct.count).toBe(3);
    expect(plans?.minimizedFellBackToDirect).toBe(true);
    expect(plans?.transfersSaved).toBe(0);

    const debts = await useSplitStore.getState().getSimplifiedDebts('g1');
    expect(debts).toHaveLength(3);
    expect(debts).toEqual(expectedPlans().direct.transfers);
    // Falling back to direct means nobody is asked to pay a stranger.
    expect(plans?.rerouted).toEqual([]);
  });

  it('is an empty list for a group that cannot be read', async () => {
    expect(await useSplitStore.getState().getSimplifiedDebts('nope')).toEqual([]);
  });
});
