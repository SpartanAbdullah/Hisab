import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  splitGroupsDb,
  groupExpensesDb,
  groupSettlementsDb,
  groupMembersDb,
  groupInvitesDb,
  groupEventsDb,
  notificationsDb,
  groupsLookupDb,
} from '../lib/supabaseDb';
import {
  buildInviteUrl,
  generateInviteToken,
  sha256Hex,
  generateGroupCodeCandidate,
  normalizeGroupCode,
} from '../lib/collaboration';
import type {
  SplitGroup,
  GroupExpense,
  GroupSettlement,
  SplitType,
  SplitDetail,
  GroupMember,
  Currency,
  GroupEvent,
  GroupInvite,
  AppNotification,
} from '../db';
import { useActivityStore } from './activityStore';
import { useTransactionStore } from './transactionStore';
import { buildInternalNote, parseInternalNote } from '../lib/internalNotes';

interface SimplifiedDebt {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
}

export interface ResolvedMemberInput {
  profileId: string;
  name: string;
  publicCode: string;
}

interface SplitState {
  groups: SplitGroup[];
  loading: boolean;
  balances: Record<string, number>;
  balancesLoaded: boolean;

  loadGroups: () => Promise<void>;
  loadBalances: () => Promise<void>;
  createGroup: (name: string, emoji: string, members: ResolvedMemberInput[], currency: Currency) => Promise<SplitGroup>;
  deleteGroup: (id: string) => Promise<void>;
  createInvite: (groupId: string, linkedMemberId?: string | null) => Promise<{ url: string; invite: GroupInvite }>;
  acceptInvite: (token: string) => Promise<{ groupId: string }>;
  joinGroupByCode: (rawCode: string) => Promise<{ groupId: string }>;
  getGroupInvites: (groupId: string) => Promise<GroupInvite[]>;
  getGroupEvents: (groupId: string) => Promise<GroupEvent[]>;

  getGroupExpenses: (groupId: string) => Promise<GroupExpense[]>;
  addGroupExpense: (input: {
    groupId: string;
    description: string;
    amount: number;
    paidBy: string;
    splitType: SplitType;
    splits: SplitDetail[];
    category: string;
    notes?: string;
    paidFromAccountId?: string;
  }) => Promise<GroupExpense>;

  updateGroupExpense: (id: string, changes: Partial<GroupExpense> & { paidFromAccountId?: string | null }) => Promise<void>;
  setGroupExpenseReconciled: (id: string, isReconciled: boolean) => Promise<void>;
  deleteGroupExpense: (id: string) => Promise<void>;
  getSettlements: (groupId: string) => Promise<GroupSettlement[]>;
  addSettlement: (input: {
    groupId: string;
    fromMember: string;
    toMember: string;
    amount: number;
    note?: string;
  }) => Promise<GroupSettlement>;

  getSimplifiedDebts: (groupId: string) => Promise<SimplifiedDebt[]>;
  getMyBalance: (groupId: string) => Promise<number>;
  reset: () => void;
}

const INITIAL_SPLIT_STATE = {
  groups: [] as SplitGroup[],
  loading: false,
  balances: {} as Record<string, number>,
  balancesLoaded: false,
};

function getCurrentUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

function getCurrentUserName(): string {
  return localStorage.getItem('hisaab_user_name') ?? 'You';
}

async function hydrateGroup(group: SplitGroup | null): Promise<SplitGroup | null> {
  if (!group) return null;
  const members = await groupMembersDb.getByGroup(group.id).catch(() => []);
  if (members.length === 0) return group;
  return { ...group, members };
}

// Prefer the already-hydrated group from the in-memory store when the cache
// is warm. Cuts 2 DB round-trips per group on list pages (was re-fetching the
// group row + member rows on every getMyBalance call despite loadGroups having
// just loaded them). Only falls through to the DB when the group isn't in the
// store yet — e.g. deep-linked into GroupDetailPage.
async function getGroupOrFetch(id: string, memoGroups: SplitGroup[]): Promise<SplitGroup | null> {
  const memo = memoGroups.find(g => g.id === id);
  if (memo && memo.members.length > 0) return memo;
  return hydrateGroup(await splitGroupsDb.get(id));
}

function findCurrentMember(group: SplitGroup): GroupMember | undefined {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  return group.members.find(member => member.profileId === userId) ?? group.members.find(member => member.isOwner);
}

function getNotificationRecipients(group: SplitGroup, actorProfileId: string): string[] {
  return Array.from(new Set(
    group.members
      .filter(member => member.profileId && member.profileId !== actorProfileId && member.status === 'connected')
      .map(member => member.profileId as string),
  ));
}

// Side-effect fan-out for group writes. Logs failures but never throws —
// notifications and activity events must not bring down the caller's write.
// The DB rows that matter (the group, members, expense, settlement) have
// already committed by the time we reach here.
async function fanOutGroupUpdate(
  group: SplitGroup,
  event: GroupEvent,
  notificationTitle: string,
  notificationBody: string,
) {
  try {
    await groupEventsDb.add(event);
  } catch (err) {
    console.error('fanOut: group event insert failed (non-fatal)', err);
  }

  const recipients = getNotificationRecipients(group, event.actorProfileId ?? '');
  if (recipients.length === 0) return;

  const notifications: AppNotification[] = recipients.map((userId) => ({
    id: uuid(),
    userId,
    groupId: group.id,
    eventId: event.id,
    type: 'group_update',
    title: notificationTitle,
    body: notificationBody,
    readAt: null,
    createdAt: event.createdAt,
  }));
  try {
    await notificationsDb.addMany(notifications);
  } catch (err) {
    console.error('fanOut: notifications insert failed (non-fatal)', err);
  }
}

export const useSplitStore = create<SplitState>((set, get) => ({
  ...INITIAL_SPLIT_STATE,

  reset: () => set(INITIAL_SPLIT_STATE),

  loadGroups: async () => {
    set({ loading: true });
    try {
      const groups = await splitGroupsDb.getAll();
      const hydrated = await Promise.all(groups.map((group) => hydrateGroup(group)));
      set({ groups: hydrated.filter(Boolean) as SplitGroup[] });
    } finally {
      set({ loading: false });
    }
  },

  // Compute per-group "my balance" in one shot: two batched queries for
  // every expense and settlement the user can see (RLS scopes both to groups
  // they belong to), then a pure in-memory pass. This collapses what used to
  // be 2N round-trips into 2, eliminating the "All settled → real numbers"
  // flash users were seeing on the Groups tab.
  loadBalances: async () => {
    const currentUserId = localStorage.getItem('hisaab_supabase_uid');
    if (!currentUserId) {
      set({ balances: {}, balancesLoaded: true });
      return;
    }
    try {
      const [allExpenses, allSettlements] = await Promise.all([
        groupExpensesDb.getAllVisible(),
        groupSettlementsDb.getAllVisible(),
      ]);

      // Group the fetches by groupId once so the per-group pass is O(1) lookup.
      const expensesByGroup = new Map<string, typeof allExpenses>();
      for (const e of allExpenses) {
        const bucket = expensesByGroup.get(e.groupId) ?? [];
        bucket.push(e);
        expensesByGroup.set(e.groupId, bucket);
      }
      const settlementsByGroup = new Map<string, typeof allSettlements>();
      for (const s of allSettlements) {
        const bucket = settlementsByGroup.get(s.groupId) ?? [];
        bucket.push(s);
        settlementsByGroup.set(s.groupId, bucket);
      }

      const balances: Record<string, number> = {};
      for (const group of get().groups) {
        const me = group.members.find(m => m.profileId === currentUserId);
        if (!me) { balances[group.id] = 0; continue; }
        let net = 0;
        for (const e of expensesByGroup.get(group.id) ?? []) {
          if (e.paidBy === me.id) net += e.amount;
          for (const s of e.splits) if (s.memberId === me.id) net -= s.amount;
        }
        for (const s of settlementsByGroup.get(group.id) ?? []) {
          if (s.fromMember === me.id) net += s.amount;
          if (s.toMember === me.id) net -= s.amount;
        }
        balances[group.id] = Math.round(net * 100) / 100;
      }
      set({ balances, balancesLoaded: true });
    } catch (err) {
      console.error('loadBalances failed', err);
      // Keep existing balances; mark loaded so UI doesn't spin forever.
      set({ balancesLoaded: true });
    }
  },

  createGroup: async (name, emoji, resolvedMembers, currency) => {
    const now = new Date().toISOString();
    const currentUserId = getCurrentUserId();
    const ownerName = getCurrentUserName();

    // Dedupe: ignore the owner if they accidentally added their own code, and
    // collapse duplicate profileIds to a single member row.
    const seenProfileIds = new Set<string>([currentUserId]);
    const extraMembers: GroupMember[] = [];
    for (const r of resolvedMembers) {
      if (seenProfileIds.has(r.profileId)) continue;
      seenProfileIds.add(r.profileId);
      extraMembers.push({
        id: uuid(),
        name: r.name || r.publicCode,
        isOwner: false,
        role: 'member',
        status: 'connected',
        profileId: r.profileId,
        joinedAt: now,
      });
    }

    const members: GroupMember[] = [
      {
        id: uuid(),
        name: ownerName,
        isOwner: true,
        profileId: currentUserId,
        role: 'owner',
        status: 'connected',
        joinedAt: now,
      },
      ...extraMembers,
    ];

    const joinCode = generateGroupCodeCandidate();
    const joinCodeNormalized = normalizeGroupCode(joinCode);

    const group: SplitGroup = {
      id: uuid(),
      name,
      emoji,
      members,
      currency,
      settled: false,
      createdAt: now,
      createdBy: currentUserId,
      joinCode,
      joinCodeNormalized,
    };

    // Critical writes — if either fails, we must roll back so the user
    // doesn't end up with a phantom group. Previously an exception here
    // (or in the downstream side-effects) bubbled to the UI as "error"
    // even though rows had committed, tempting the user to retry and
    // accumulate duplicates.
    try {
      await splitGroupsDb.add(group);
      await groupMembersDb.addMany(group.id, members);
    } catch (err) {
      await splitGroupsDb.delete(group.id).catch(() => {});
      throw err;
    }

    await fanOutGroupUpdate(
      group,
      {
        id: uuid(),
        groupId: group.id,
        actorProfileId: currentUserId,
        eventType: 'group_created',
        entityType: 'group',
        entityId: group.id,
        summary: `${ownerName} added you to ${group.name}`,
        payload: { groupName: group.name, joinCode },
        createdAt: now,
      },
      `Added to ${group.name}`,
      `${ownerName} added you to a shared group.`,
    );

    await get().loadGroups();
    try {
      await useActivityStore.getState().logActivity('group_created', `Created group "${name}"`, group.id, 'group');
    } catch (err) {
      console.error('activity log failed (non-fatal)', err);
    }
    return group;
  },

  joinGroupByCode: async (rawCode) => {
    const normalized = normalizeGroupCode(rawCode);
    if (!normalized) throw new Error('Enter a group code');

    // One atomic RPC handles: code lookup, membership upsert, status flip.
    // The caller no longer needs to be able to SELECT split_groups before
    // joining — the old two-step flow failed because strict RLS blocks that
    // pre-read for non-members. See supabase-migration-join-by-code-rpc.sql.
    const result = await groupsLookupDb.joinByCode(normalized, getCurrentUserName());
    if (!result) throw new Error('Group code not found');

    const currentUserId = getCurrentUserId();
    const now = new Date().toISOString();

    // After the RPC commits, the caller is a connected member, so the usual
    // RLS-guarded reads work. Only fire member_joined fan-out if this was
    // an actual transition — re-joining an already-connected group would
    // otherwise spam notifications on every paste of the code.
    if (!result.wasAlreadyConnected) {
      const nextGroup = await hydrateGroup(await splitGroupsDb.get(result.groupId));
      if (nextGroup) {
        await fanOutGroupUpdate(
          nextGroup,
          {
            id: uuid(),
            groupId: nextGroup.id,
            actorProfileId: currentUserId,
            eventType: 'member_joined',
            entityType: 'member',
            entityId: result.memberId,
            summary: `${getCurrentUserName()} joined ${nextGroup.name}`,
            payload: { memberId: result.memberId, via: 'join_code' },
            createdAt: now,
          },
          `${getCurrentUserName()} joined ${nextGroup.name}`,
          `${getCurrentUserName()} is now connected to the group.`,
        );
      }
    }

    await get().loadGroups();
    return { groupId: result.groupId };
  },

  deleteGroup: async (id) => {
    await groupExpensesDb.deleteByGroup(id);
    await groupSettlementsDb.deleteByGroup(id);
    await splitGroupsDb.delete(id);
    await get().loadGroups();
  },

  createInvite: async (groupId, linkedMemberId = null) => {
    const group = await hydrateGroup(get().groups.find(item => item.id === groupId) ?? await splitGroupsDb.get(groupId));
    if (!group) throw new Error('Group not found');

    const token = generateInviteToken();
    const now = new Date().toISOString();
    const invite: GroupInvite = {
      id: uuid(),
      groupId,
      tokenHash: await sha256Hex(token),
      createdBy: getCurrentUserId(),
      linkedMemberId,
      expiresAt: null,
      revokedAt: null,
      acceptedBy: null,
      acceptedAt: null,
      createdAt: now,
    };

    await groupInvitesDb.add(invite);

    if (linkedMemberId) {
      await groupMembersDb.update(linkedMemberId, { status: 'invited' });
      await get().loadGroups();
    }

    return { url: buildInviteUrl(token), invite };
  },

  acceptInvite: async (token) => {
    const currentUserId = getCurrentUserId();
    const tokenHash = await sha256Hex(token);
    const invite = await groupInvitesDb.getByTokenHash(tokenHash);
    if (!invite) throw new Error('Invite not found');
    if (invite.acceptedAt) {
      return { groupId: invite.groupId };
    }
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new Error('Invite expired');
    }

    const group = await hydrateGroup(await splitGroupsDb.get(invite.groupId));
    if (!group) throw new Error('Group not found');

    const now = new Date().toISOString();
    const existingMember = group.members.find(member => member.profileId === currentUserId);
    let joinedMemberId = existingMember?.id ?? invite.linkedMemberId ?? null;

    if (invite.linkedMemberId) {
      await groupMembersDb.update(invite.linkedMemberId, {
        profileId: currentUserId,
        status: 'connected',
        joinedAt: now,
      });
      joinedMemberId = invite.linkedMemberId;
    } else if (!existingMember) {
      const newMember: GroupMember = {
        id: uuid(),
        name: getCurrentUserName(),
        isOwner: false,
        profileId: currentUserId,
        role: 'member',
        status: 'connected',
        joinedAt: now,
      };
      await groupMembersDb.add({ ...newMember, groupId: group.id });
      joinedMemberId = newMember.id;
    }

    await groupInvitesDb.update(invite.id, {
      acceptedBy: currentUserId,
      acceptedAt: now,
    });

    const nextGroup = await hydrateGroup(await splitGroupsDb.get(group.id));
    if (nextGroup) {
      await fanOutGroupUpdate(
        nextGroup,
        {
          id: uuid(),
          groupId: nextGroup.id,
          actorProfileId: currentUserId,
          eventType: 'member_joined',
          entityType: 'member',
          entityId: joinedMemberId ?? currentUserId,
          summary: `${getCurrentUserName()} joined ${nextGroup.name}`,
          payload: { memberId: joinedMemberId, groupName: nextGroup.name },
          createdAt: now,
        },
        `${getCurrentUserName()} joined ${nextGroup.name}`,
        `${getCurrentUserName()} is now connected to the group.`,
      );
    }

    await get().loadGroups();
    return { groupId: invite.groupId };
  },

  getGroupInvites: async (groupId) => {
    return groupInvitesDb.getActiveByGroup(groupId);
  },

  getGroupEvents: async (groupId) => {
    return groupEventsDb.getByGroup(groupId);
  },

  getGroupExpenses: async (groupId) => {
    return groupExpensesDb.getByGroup(groupId);
  },

  addGroupExpense: async (input) => {
    const group = await hydrateGroup(get().groups.find((item) => item.id === input.groupId) ?? await splitGroupsDb.get(input.groupId));
    if (!group) throw new Error('Group not found');

    const currentUserId = getCurrentUserId();
    const currentMember = findCurrentMember(group);
    if (input.paidFromAccountId && input.paidBy !== currentMember?.id) {
      throw new Error('Only your own payments can be linked to a personal account');
    }

    const expense: GroupExpense = {
      id: uuid(),
      groupId: input.groupId,
      description: input.description,
      amount: input.amount,
      paidBy: input.paidBy,
      splitType: input.splitType,
      splits: input.splits,
      category: input.category || 'General',
      date: new Date().toISOString(),
      notes: input.notes || '',
      createdAt: new Date().toISOString(),
      createdBy: currentUserId,
      updatedBy: currentUserId,
      version: 1,
      isReconciled: false,
      reconciledAt: null,
      reconciledBy: null,
    };

    let linkedTransactionId: string | undefined;
    if (input.paidFromAccountId) {
      const tx = await useTransactionStore.getState().processTransaction({
        type: 'expense',
        amount: input.amount,
        sourceAccountId: input.paidFromAccountId,
        category: input.category || 'General',
        notes: buildInternalNote(input.notes || '', {
          expenseDescription: input.description,
          groupExpenseId: expense.id,
          groupId: group.id,
          groupName: group.name,
        }),
      });
      linkedTransactionId = tx.id;
    }

    expense.notes = buildInternalNote(input.notes || '', {
      linkedTransactionId,
      paidFromAccountId: input.paidFromAccountId,
    });

    await groupExpensesDb.add(expense);

    const actorName = currentMember?.name ?? getCurrentUserName();
    await fanOutGroupUpdate(
      group,
      {
        id: uuid(),
        groupId: group.id,
        actorProfileId: currentUserId,
        eventType: 'expense_added',
        entityType: 'group_expense',
        entityId: expense.id,
        summary: `${actorName} added ${expense.description} (${expense.amount})`,
        payload: {
          description: expense.description,
          amount: expense.amount,
          paidBy: expense.paidBy,
        },
        createdAt: expense.createdAt,
      },
      `${actorName} added an expense`,
      `${expense.description} for ${expense.amount} was added in ${group.name}.`,
    );

    await useActivityStore.getState().logActivity(
      'group_expense',
      `Added "${expense.description}" in ${group.name}`,
      expense.id,
      'group_expense',
    );

    return expense;
  },

  updateGroupExpense: async (id, changes) => {
    const existing = await groupExpensesDb.get(id);
    if (!existing) throw new Error('Group expense not found');

    const group = await hydrateGroup(get().groups.find((item) => item.id === existing.groupId) ?? await splitGroupsDb.get(existing.groupId));
    if (!group) throw new Error('Group not found');

    const currentUserId = getCurrentUserId();
    const currentMember = findCurrentMember(group);
    const existingMeta = parseInternalNote(existing.notes).meta;
    const nextPaidFromAccountId = changes.paidFromAccountId === undefined
      ? existingMeta.paidFromAccountId
      : changes.paidFromAccountId ?? undefined;

    const nextExpense: GroupExpense = {
      ...existing,
      ...changes,
      notes: existing.notes,
    };

    if (nextPaidFromAccountId && nextExpense.paidBy !== currentMember?.id) {
      throw new Error('Only your own payments can be linked to a personal account');
    }

    let linkedTransactionId = existingMeta.linkedTransactionId;

    if (linkedTransactionId && nextPaidFromAccountId) {
      await useTransactionStore.getState().updateTransaction(
        linkedTransactionId,
        {
          type: 'expense',
          amount: nextExpense.amount,
          sourceAccountId: nextPaidFromAccountId,
          category: nextExpense.category,
          notes: buildInternalNote('', {
            expenseDescription: nextExpense.description,
            groupExpenseId: nextExpense.id,
            groupId: group.id,
            groupName: group.name,
          }),
        },
        { allowLinkedGroupExpense: true },
      );
    } else if (linkedTransactionId && !nextPaidFromAccountId) {
      await useTransactionStore.getState().deleteTransaction(linkedTransactionId, { allowLinkedGroupExpense: true });
      linkedTransactionId = undefined;
    } else if (!linkedTransactionId && nextPaidFromAccountId) {
      const tx = await useTransactionStore.getState().processTransaction({
        type: 'expense',
        amount: nextExpense.amount,
        sourceAccountId: nextPaidFromAccountId,
        category: nextExpense.category,
        notes: buildInternalNote('', {
          expenseDescription: nextExpense.description,
          groupExpenseId: nextExpense.id,
          groupId: group.id,
          groupName: group.name,
        }),
      });
      linkedTransactionId = tx.id;
    }

    await groupExpensesDb.update(id, {
      description: nextExpense.description,
      amount: nextExpense.amount,
      paidBy: nextExpense.paidBy,
      splitType: nextExpense.splitType,
      splits: nextExpense.splits,
      category: nextExpense.category,
      notes: buildInternalNote('', {
        linkedTransactionId,
        paidFromAccountId: nextPaidFromAccountId,
      }),
      updatedBy: currentUserId,
      version: (existing.version ?? 1) + 1,
      isReconciled: existing.paidBy === nextExpense.paidBy ? existing.isReconciled ?? false : false,
      reconciledAt: existing.paidBy === nextExpense.paidBy ? existing.reconciledAt ?? null : null,
      reconciledBy: existing.paidBy === nextExpense.paidBy ? existing.reconciledBy ?? null : null,
    });

    const actorName = currentMember?.name ?? getCurrentUserName();
    await fanOutGroupUpdate(
      group,
      {
        id: uuid(),
        groupId: group.id,
        actorProfileId: currentUserId,
        eventType: 'expense_updated',
        entityType: 'group_expense',
        entityId: existing.id,
        summary: `${actorName} updated ${existing.description}`,
        payload: {
          before: { description: existing.description, amount: existing.amount, paidBy: existing.paidBy },
          after: { description: nextExpense.description, amount: nextExpense.amount, paidBy: nextExpense.paidBy },
        },
        createdAt: new Date().toISOString(),
      },
      `${actorName} updated an expense`,
      `${existing.description} was changed in ${group.name}.`,
    );

    await useActivityStore.getState().logActivity(
      'group_expense',
      `Updated "${nextExpense.description}" in ${group.name}`,
      nextExpense.id,
      'group_expense',
    );
  },

  setGroupExpenseReconciled: async (id, isReconciled) => {
    const existing = await groupExpensesDb.get(id);
    if (!existing) throw new Error('Group expense not found');

    const group = await hydrateGroup(get().groups.find((item) => item.id === existing.groupId) ?? await splitGroupsDb.get(existing.groupId));
    if (!group) throw new Error('Group not found');

    const currentUserId = getCurrentUserId();
    const currentMember = group.members.find(member => member.profileId === currentUserId);
    if (existing.paidBy !== currentMember?.id) {
      throw new Error('Only the member who paid can reconcile this expense');
    }

    const changes: Partial<GroupExpense> = {
      isReconciled,
      reconciledAt: isReconciled ? new Date().toISOString() : null,
      reconciledBy: isReconciled ? currentUserId : null,
    };

    await groupExpensesDb.update(id, changes);

    const linkedTransactionId = parseInternalNote(existing.notes).meta.linkedTransactionId;
    if (linkedTransactionId) {
      await useTransactionStore.getState().setReconciled(linkedTransactionId, isReconciled);
    }
  },

  deleteGroupExpense: async (id) => {
    const expense = await groupExpensesDb.get(id);
    if (!expense) return;

    const group = await hydrateGroup(get().groups.find((item) => item.id === expense.groupId) ?? await splitGroupsDb.get(expense.groupId));
    if (!group) throw new Error('Group not found');

    const currentUserId = getCurrentUserId();
    const currentMember = findCurrentMember(group);

    const meta = parseInternalNote(expense.notes).meta;
    if (meta.linkedTransactionId) {
      await useTransactionStore.getState().deleteTransaction(meta.linkedTransactionId, { allowLinkedGroupExpense: true });
    }

    await groupExpensesDb.delete(id);

    const actorName = currentMember?.name ?? getCurrentUserName();
    await fanOutGroupUpdate(
      group,
      {
        id: uuid(),
        groupId: group.id,
        actorProfileId: currentUserId,
        eventType: 'expense_deleted',
        entityType: 'group_expense',
        entityId: expense.id,
        summary: `${actorName} deleted ${expense.description}`,
        payload: {
          description: expense.description,
          amount: expense.amount,
          paidBy: expense.paidBy,
        },
        createdAt: new Date().toISOString(),
      },
      `${actorName} deleted an expense`,
      `${expense.description} was removed from ${group.name}.`,
    );

    await useActivityStore.getState().logActivity(
      'group_expense',
      `Deleted "${expense.description}" in ${group.name}`,
      expense.id,
      'group_expense',
    );
  },

  getSettlements: async (groupId) => {
    return groupSettlementsDb.getByGroup(groupId);
  },

  addSettlement: async (input) => {
    const group = await hydrateGroup(get().groups.find((item) => item.id === input.groupId) ?? await splitGroupsDb.get(input.groupId));
    if (!group) throw new Error('Group not found');

    const currentUserId = getCurrentUserId();
    const settlement: GroupSettlement = {
      id: uuid(),
      groupId: input.groupId,
      fromMember: input.fromMember,
      toMember: input.toMember,
      amount: input.amount,
      date: new Date().toISOString(),
      note: input.note || '',
      createdAt: new Date().toISOString(),
      createdBy: currentUserId,
      updatedBy: currentUserId,
    };
    await groupSettlementsDb.add(settlement);

    const fromName = group.members.find((member) => member.id === input.fromMember)?.name ?? 'Someone';
    const toName = group.members.find((member) => member.id === input.toMember)?.name ?? 'someone';

    await fanOutGroupUpdate(
      group,
      {
        id: uuid(),
        groupId: group.id,
        actorProfileId: currentUserId,
        eventType: 'settlement_added',
        entityType: 'group_settlement',
        entityId: settlement.id,
        summary: `${fromName} settled with ${toName}`,
        payload: {
          fromMember: input.fromMember,
          toMember: input.toMember,
          amount: input.amount,
        },
        createdAt: settlement.createdAt,
      },
      `${fromName} settled up`,
      `${fromName} settled ${input.amount} with ${toName} in ${group.name}.`,
    );

    await useActivityStore.getState().logActivity(
      'group_settlement',
      `${fromName} settled with ${toName} in ${group.name}`,
      settlement.id,
      'group_settlement',
    );
    return settlement;
  },

  getSimplifiedDebts: async (groupId) => {
    const group = await getGroupOrFetch(groupId, get().groups);
    if (!group) return [];

    // Expenses + settlements in parallel — they don't depend on each other.
    const [expenses, settlements] = await Promise.all([
      groupExpensesDb.getByGroup(groupId),
      groupSettlementsDb.getByGroup(groupId),
    ]);

    const balances = new Map<string, number>();
    group.members.forEach(member => balances.set(member.id, 0));

    for (const expense of expenses) {
      balances.set(expense.paidBy, (balances.get(expense.paidBy) ?? 0) + expense.amount);
      for (const split of expense.splits) {
        balances.set(split.memberId, (balances.get(split.memberId) ?? 0) - split.amount);
      }
    }

    for (const settlement of settlements) {
      balances.set(settlement.fromMember, (balances.get(settlement.fromMember) ?? 0) + settlement.amount);
      balances.set(settlement.toMember, (balances.get(settlement.toMember) ?? 0) - settlement.amount);
    }

    const creditors: { id: string; amount: number }[] = [];
    const debtors: { id: string; amount: number }[] = [];

    balances.forEach((balance, id) => {
      const rounded = Math.round(balance * 100) / 100;
      if (rounded > 0.01) creditors.push({ id, amount: rounded });
      else if (rounded < -0.01) debtors.push({ id, amount: Math.abs(rounded) });
    });

    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);

    const debts: SimplifiedDebt[] = [];
    let creditorIndex = 0;
    let debtorIndex = 0;
    while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
      const amount = Math.min(creditors[creditorIndex].amount, debtors[debtorIndex].amount);
      if (amount > 0.01) {
        const fromMember = group.members.find(member => member.id === debtors[debtorIndex].id);
        const toMember = group.members.find(member => member.id === creditors[creditorIndex].id);
        debts.push({
          from: debtors[debtorIndex].id,
          fromName: fromMember?.name ?? '?',
          to: creditors[creditorIndex].id,
          toName: toMember?.name ?? '?',
          amount: Math.round(amount * 100) / 100,
        });
      }
      creditors[creditorIndex].amount -= amount;
      debtors[debtorIndex].amount -= amount;
      if (creditors[creditorIndex].amount < 0.01) creditorIndex += 1;
      if (debtors[debtorIndex].amount < 0.01) debtorIndex += 1;
    }

    return debts;
  },

  getMyBalance: async (groupId) => {
    const group = await getGroupOrFetch(groupId, get().groups);
    if (!group) return 0;

    const currentMember = findCurrentMember(group);
    if (!currentMember) return 0;

    const debts = await get().getSimplifiedDebts(groupId);
    let balance = 0;
    for (const debt of debts) {
      if (debt.to === currentMember.id) balance += debt.amount;
      if (debt.from === currentMember.id) balance -= debt.amount;
    }
    return Math.round(balance * 100) / 100;
  },
}));
