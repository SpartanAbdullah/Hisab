import type { LeaveGroupResult } from './supabaseDb';

export interface GroupLeavePolicyInput {
  activeMember: boolean;
  isOnlyOwnerAdmin: boolean;
  payableAmount: number;
  receivableAmount: number;
  hasPendingSettlement: boolean;
  hasPendingSplitInviteRequest: boolean;
  hasUnreconciledParticipation: boolean;
  currency?: string;
}

// Pure mirror of the server-side decision order. The database RPC remains the
// authority; this exists so the leave rules stay explicit and unit-testable.
export function evaluateGroupLeavePolicy(input: GroupLeavePolicyInput): LeaveGroupResult {
  const currency = input.currency ?? 'AED';
  if (!input.activeMember) {
    return blocked('NOT_ACTIVE_MEMBER', 'You are not an active member of this group.');
  }
  if (input.isOnlyOwnerAdmin) {
    return blocked('ONLY_OWNER_ADMIN', "You can't leave because you are the only group admin. Assign another admin first.");
  }
  if (input.payableAmount > 0.01 || input.receivableAmount > 0.01) {
    return {
      ...blocked(
        input.payableAmount > 0.01 ? 'OUTSTANDING_PAYABLE' : 'OUTSTANDING_RECEIVABLE',
        `You owe ${currency} ${input.payableAmount.toFixed(2)} and are owed ${currency} ${input.receivableAmount.toFixed(2)}. Please settle all balances before leaving.`,
      ),
      payableAmount: input.payableAmount,
      receivableAmount: input.receivableAmount,
      currency,
    };
  }
  if (input.hasPendingSettlement) {
    return blocked('PENDING_SETTLEMENT', "You can't leave yet because a pending settlement still needs to be resolved.");
  }
  if (input.hasUnreconciledParticipation) {
    return blocked('UNRECONCILED_PARTICIPATION', "You can't leave yet because you still have an unreconciled group expense. Reconcile it before leaving.");
  }
  if (input.hasPendingSplitInviteRequest) {
    return blocked('PENDING_SPLIT_INVITE_REQUEST', "You can't leave yet because a pending group invitation or request still needs to be resolved.");
  }
  return {
    success: true,
    reasonCode: 'LEFT_GROUP',
    userMessage: 'You left this group.',
    payableAmount: 0,
    receivableAmount: 0,
    currency,
  };
}

export async function refreshAfterSuccessfulLeave(
  result: LeaveGroupResult,
  refresh: () => Promise<void>,
): Promise<LeaveGroupResult> {
  if (result.success) await refresh();
  return result;
}

function blocked(reasonCode: string, userMessage: string): LeaveGroupResult {
  return {
    success: false,
    reasonCode,
    userMessage,
    payableAmount: 0,
    receivableAmount: 0,
    currency: null,
  };
}
