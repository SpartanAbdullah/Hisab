import { tStatic } from './i18n';
import type { GroupExpense, GroupMember, SplitDetail, SplitGroup } from '../db';

export const INACTIVE_GROUP_MEMBER_MESSAGE =
  "This member has left the group and can't be included in new expenses.";
export const NEED_TWO_ACTIVE_MEMBERS_MESSAGE =
  'You need at least two active members to split an expense.';

export function isActiveGroupMember(member: GroupMember): boolean {
  return member.status === 'connected';
}

export function getActiveGroupMembers(group: SplitGroup): GroupMember[] {
  return group.members.filter(isActiveGroupMember);
}

export function getInactiveGroupMembers(group: SplitGroup): GroupMember[] {
  return group.members.filter((member) => !isActiveGroupMember(member));
}

export function validateNewGroupExpenseParticipants(
  group: SplitGroup,
  paidBy: string,
  splits: SplitDetail[],
): string | null {
  const activeMembers = getActiveGroupMembers(group);
  if (activeMembers.length < 2) return NEED_TWO_ACTIVE_MEMBERS_MESSAGE;
  const activeMemberIds = new Set(activeMembers.map((member) => member.id));
  if (!activeMemberIds.has(paidBy)) return INACTIVE_GROUP_MEMBER_MESSAGE;
  if (splits.some((split) => !activeMemberIds.has(split.memberId))) {
    return INACTIVE_GROUP_MEMBER_MESSAGE;
  }
  return null;
}

export function validateNewSettlementParticipants(
  group: SplitGroup,
  fromMember: string,
  toMember: string,
): string | null {
  const activeMemberIds = new Set(getActiveGroupMembers(group).map((member) => member.id));
  return activeMemberIds.has(fromMember) && activeMemberIds.has(toMember)
    ? null
    : INACTIVE_GROUP_MEMBER_MESSAGE;
}

export function expenseParticipantsChanged(existing: GroupExpense, next: GroupExpense): boolean {
  return existing.groupId !== next.groupId ||
    existing.paidBy !== next.paidBy ||
    JSON.stringify(existing.splits) !== JSON.stringify(next.splits);
}

export function friendlyGroupParticipantError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error ?? '');
  if (/not_enough_active_group_members/i.test(message)) return NEED_TWO_ACTIVE_MEMBERS_MESSAGE;
  if (/inactive_group_member|not an active connected member/i.test(message)) {
    return INACTIVE_GROUP_MEMBER_MESSAGE;
  }
  // Server trigger mirrors (supabase-migration-p1-money-bounds.sql): raw
  // `RAISE EXCEPTION 'CODE: detail'` text on a group expense/split write.
  if (/GROUP_SPLITS_DO_NOT_SUM/.test(message)) return tStatic('grp_err_splits_mismatch');
  if (/INVALID_GROUP_SPLIT_AMOUNT/.test(message)) return tStatic('grp_err_invalid_split_amount');
  if (/INVALID_GROUP_SPLIT_MEMBER/.test(message)) return tStatic('grp_err_invalid_split_member');
  return message;
}
