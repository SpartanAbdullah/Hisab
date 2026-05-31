import { describe, expect, it } from 'vitest';
import {
  expenseParticipantsChanged,
  getActiveGroupMembers,
  getInactiveGroupMembers,
  validateNewGroupExpenseParticipants,
  validateNewSettlementParticipants,
} from './groupActiveMembers';
import type { GroupExpense, SplitGroup } from '../db';

const group: SplitGroup = {
  id: 'group-1',
  name: 'Trip',
  emoji: 'T',
  currency: 'AED',
  settled: false,
  createdAt: '2026-05-31T00:00:00.000Z',
  members: [
    { id: 'owner', name: 'Owner', isOwner: true, status: 'connected' },
    { id: 'active', name: 'Active', isOwner: false, status: 'connected' },
    { id: 'left', name: 'Historical', isOwner: false, status: 'left' },
  ],
};

const historicalExpense: GroupExpense = {
  id: 'expense-1',
  groupId: group.id,
  description: 'Old dinner',
  amount: 30,
  paidBy: 'left',
  splitType: 'equal',
  splits: [{ memberId: 'left', amount: 30 }],
  category: 'Food',
  date: '2026-05-01',
  notes: '',
  createdAt: '2026-05-01T00:00:00.000Z',
};

describe('active-only group transaction members', () => {
  it('keeps left members historical but out of active payer and split lists', () => {
    expect(getActiveGroupMembers(group).map((member) => member.id)).toEqual(['owner', 'active']);
    expect(getInactiveGroupMembers(group).map((member) => member.id)).toEqual(['left']);
  });

  it('blocks a new expense paid by a left member', () => {
    expect(validateNewGroupExpenseParticipants(group, 'left', [{ memberId: 'owner', amount: 30 }]))
      .toContain("has left the group");
  });

  it('blocks new split expenses until two active members exist', () => {
    const solo = { ...group, members: group.members.filter((member) => member.id !== 'active') };
    expect(validateNewGroupExpenseParticipants(solo, 'owner', [{ memberId: 'owner', amount: 30 }]))
      .toBe('You need at least two active members to split an expense.');
  });

  it('excludes a left member from a new equal split payload', () => {
    const equalSplitIds = getActiveGroupMembers(group).map((member) => member.id);
    expect(equalSplitIds).not.toContain('left');
    expect(validateNewGroupExpenseParticipants(group, 'owner', [{ memberId: 'left', amount: 30 }]))
      .toContain("has left the group");
  });

  it('blocks settlements involving a left member', () => {
    expect(validateNewSettlementParticipants(group, 'owner', 'left')).toContain("has left the group");
  });

  it('continues to preserve historical expense references for rendering', () => {
    expect(group.members.find((member) => member.id === historicalExpense.paidBy)?.name).toBe('Historical');
    expect(historicalExpense.splits).toEqual([{ memberId: 'left', amount: 30 }]);
  });

  it('allows the member only after membership is restored to connected', () => {
    const rejoined = {
      ...group,
      members: group.members.map((member) => member.id === 'left' ? { ...member, status: 'connected' as const } : member),
    };
    expect(validateNewGroupExpenseParticipants(rejoined, 'left', [{ memberId: 'left', amount: 30 }])).toBeNull();
    expect(validateNewSettlementParticipants(rejoined, 'owner', 'left')).toBeNull();
  });

  it('allows non-participant edits to historical records but detects participant rewrites', () => {
    expect(expenseParticipantsChanged(historicalExpense, { ...historicalExpense, description: 'Old dinner note' })).toBe(false);
    expect(expenseParticipantsChanged(historicalExpense, { ...historicalExpense, paidBy: 'owner' })).toBe(true);
  });
});
