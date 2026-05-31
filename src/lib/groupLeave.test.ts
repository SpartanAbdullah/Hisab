import { describe, expect, it, vi } from 'vitest';
import { evaluateGroupLeavePolicy, refreshAfterSuccessfulLeave } from './groupLeave';

const eligible = {
  activeMember: true,
  isOnlyOwnerAdmin: false,
  payableAmount: 0,
  receivableAmount: 0,
  hasPendingSettlement: false,
  hasPendingSplitInviteRequest: false,
  hasUnreconciledParticipation: false,
  currency: 'AED',
};

describe('evaluateGroupLeavePolicy', () => {
  it('allows a member with zero balance and no unresolved records to leave', () => {
    expect(evaluateGroupLeavePolicy(eligible)).toMatchObject({
      success: true,
      reasonCode: 'LEFT_GROUP',
      userMessage: 'You left this group.',
    });
  });

  it('blocks a member who owes money with an exact explanation', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, payableAmount: 25 })).toMatchObject({
      success: false,
      reasonCode: 'OUTSTANDING_PAYABLE',
      userMessage: 'You owe AED 25.00 and are owed AED 0.00. Please settle all balances before leaving.',
    });
  });

  it('blocks a member who is owed money with an exact explanation', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, receivableAmount: 12.5 })).toMatchObject({
      success: false,
      reasonCode: 'OUTSTANDING_RECEIVABLE',
      userMessage: 'You owe AED 0.00 and are owed AED 12.50. Please settle all balances before leaving.',
    });
  });

  it('blocks a pending settlement', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, hasPendingSettlement: true })).toMatchObject({
      success: false,
      reasonCode: 'PENDING_SETTLEMENT',
    });
  });

  it('returns the same non-member result for an inactive or guessed group id', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, activeMember: false })).toEqual({
      success: false,
      reasonCode: 'NOT_ACTIVE_MEMBER',
      userMessage: 'You are not an active member of this group.',
      payableAmount: 0,
      receivableAmount: 0,
      currency: null,
    });
  });

  it('blocks the only owner/admin', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, isOnlyOwnerAdmin: true })).toMatchObject({
      success: false,
      reasonCode: 'ONLY_OWNER_ADMIN',
    });
  });

  it('blocks a pending split invite or request', () => {
    expect(evaluateGroupLeavePolicy({ ...eligible, hasPendingSplitInviteRequest: true })).toMatchObject({
      success: false,
      reasonCode: 'PENDING_SPLIT_INVITE_REQUEST',
    });
  });
});

describe('refreshAfterSuccessfulLeave', () => {
  it('refreshes frontend state after a successful leave', async () => {
    const refresh = vi.fn(async () => undefined);
    const result = evaluateGroupLeavePolicy(eligible);

    await refreshAfterSuccessfulLeave(result, refresh);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps local state intact when the server blocks leaving', async () => {
    const refresh = vi.fn(async () => undefined);
    const result = evaluateGroupLeavePolicy({ ...eligible, payableAmount: 10 });

    await refreshAfterSuccessfulLeave(result, refresh);

    expect(refresh).not.toHaveBeenCalled();
  });
});
