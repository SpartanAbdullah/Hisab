import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  splitGroupsDb,
  groupExpensesDb,
  groupSettlementsDb,
  groupMembersDb,
  groupInvitesDb,
  groupEventsDb,
  groupsLookupDb,
  groupMembershipDb,
  groupArchiveDb,
  groupOwnershipDb,
  transactionsDb,
} from '../lib/supabaseDb';
import {
  buildInviteUrl,
  generateInviteToken,
  sha256Hex,
  generateGroupCodeCandidate,
  normalizeGroupCode,
} from '../lib/collaboration';
import type {
  GroupExpenseBalanceRow,
  GroupSettlementBalanceRow,
  GroupArchiveResult,
  LeaveGroupResult,
  PendingGroupInvitation,
} from '../lib/supabaseDb';
import type { JoinCodeFailureStatus, InviteAcceptFailureStatus } from '../lib/joinCodeStatus';

/** Outcome of a join-by-code attempt. Failures are data, not exceptions. */
export type JoinGroupOutcome =
  | { status: 'ok'; groupId: string }
  | { status: JoinCodeFailureStatus };

/** Outcome of redeeming an invite link. Same "failures are data" contract:
 *  accept_group_invite returns a status object rather than raising, so its
 *  rate-limit ledger row survives (audit H3 / H1). */
export type AcceptInviteOutcome =
  | { status: 'ok'; groupId: string; wasAlreadyConnected: boolean }
  | { status: InviteAcceptFailureStatus; retryAfterSeconds?: number };
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
} from '../db';
import { useActivityStore } from './activityStore';
import { useTransactionStore } from './transactionStore';
import { buildInternalNote, parseInternalNote } from '../lib/internalNotes';
import { tStatic } from '../lib/i18n';
import { refreshAfterSuccessfulLeave } from '../lib/groupLeave';
import { computePairwiseDebts } from '../lib/groupDebts';
import { coreExpenseFieldsChanged } from '../lib/groupExpenseDiff';
import { isSettlementSuccess, settlementFailureMessage } from '../lib/groupSettlementResult';
import {
  expenseParticipantsChanged,
  validateNewGroupExpenseParticipants,
  validateNewSettlementParticipants,
} from '../lib/groupActiveMembers';
import { MAX_MONEY_MAGNITUDE } from '../lib/currencyValidation';

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
  // Per-group flag: "the current user paid for an expense in this group that
  // isn't reconciled yet". Drives the small red dot on group cards so the
  // user knows which groups need their attention without opening each one.
  unreconciledFlags: Record<string, boolean>;
  // Group invitations the user has NOT accepted. An 'invited' member fails
  // is_group_member(), so RLS hides the group row entirely — without this list
  // (fed by the list_pending_group_memberships RPC) the invitation is
  // invisible and undecidable. See consent-guards.sql §2.6.
  pendingInvitations: PendingGroupInvitation[];

  loadGroups: () => Promise<void>;
  loadBalances: () => Promise<void>;
  loadUnreconciledFlags: (currentUserId: string) => Promise<void>;
  createGroup: (name: string, emoji: string, members: ResolvedMemberInput[], currency: Currency) => Promise<SplitGroup>;
  // Throws on refusal. supabase-migration-audit-p0-group-deletion-guard.sql
  // blocks the hard delete of a SHARED group with GROUP_HAS_OTHER_MEMBERS /
  // GROUP_HAS_OUTSTANDING_BALANCES — callers must catch and offer Archive.
  deleteGroup: (id: string) => Promise<void>;
  leaveGroup: (id: string) => Promise<LeaveGroupResult>;
  // Pending-invitation door (consent-guards.sql §2.5/§2.6).
  loadPendingInvitations: () => Promise<void>;
  acceptGroupMembership: (groupId: string) => Promise<LeaveGroupResult>;
  declineGroupMembership: (groupId: string) => Promise<LeaveGroupResult>;
  // Owner-only lifecycle actions (group-deletion-guard §6, account-deletion §5).
  archiveGroup: (groupId: string) => Promise<GroupArchiveResult>;
  unarchiveGroup: (groupId: string) => Promise<GroupArchiveResult>;
  transferGroupOwnership: (groupId: string, newOwnerMemberId: string) => Promise<LeaveGroupResult>;
  // Owner-only join-code rotation; the server re-stamps a fresh 14-day expiry.
  // Resolves with the new human-readable code.
  refreshJoinCode: (groupId: string) => Promise<string>;
  createInvite: (groupId: string, linkedMemberId?: string | null) => Promise<{ url: string; invite: GroupInvite }>;
  acceptInvite: (token: string) => Promise<AcceptInviteOutcome>;
  // Returns a status instead of throwing: the join RPC reports
  // RATE_LIMITED / INVALID_OR_EXPIRED_CODE / … as data now (audit C5).
  joinGroupByCode: (rawCode: string) => Promise<JoinGroupOutcome>;
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
  // Undo a wrongly recorded settle-up (wrong row, wrong amount, double-record
  // from two phones). Creator-only; debts self-correct on reload since all
  // balance math derives from the settlement rows.
  deleteSettlement: (groupId: string, settlementId: string) => Promise<void>;

  getSimplifiedDebts: (groupId: string) => Promise<SimplifiedDebt[]>;
  // Raw direct "you owe X to Y" debts with no rerouting — the default settle-up view.
  getPairwiseDebts: (groupId: string) => Promise<SimplifiedDebt[]>;
  getMyBalance: (groupId: string) => Promise<number>;
  reset: () => void;
}

const INITIAL_SPLIT_STATE = {
  groups: [] as SplitGroup[],
  loading: false,
  balances: {} as Record<string, number>,
  balancesLoaded: false,
  unreconciledFlags: {} as Record<string, boolean>,
  pendingInvitations: [] as PendingGroupInvitation[],
};

function getCurrentUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

function getCurrentUserName(): string {
  return localStorage.getItem('hisaab_user_name') ?? 'You';
}

function sameDisplayName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLocaleLowerCase() === (b ?? '').trim().toLocaleLowerCase();
}

// SplitsPage triggers loadBalances and loadUnreconciledFlags in parallel.
// Both want the same `group_expenses` rows. Without dedup that's two
// identical queries on every Groups-tab visit. This single-slot promise
// cache collapses concurrent reads into one fetch; the slot clears once
// the promise resolves so the next invocation (e.g. after an expense
// write) hits the network again.
let inflightBalanceExpenses: Promise<GroupExpenseBalanceRow[]> | null = null;
function fetchSharedBalanceExpenses(): Promise<GroupExpenseBalanceRow[]> {
  if (inflightBalanceExpenses) return inflightBalanceExpenses;
  const p = groupExpensesDb.getAllVisibleForBalances().finally(() => {
    if (inflightBalanceExpenses === p) inflightBalanceExpenses = null;
  });
  inflightBalanceExpenses = p;
  return p;
}

async function claimPaidByMemberIfMine(
  group: SplitGroup,
  paidByMemberId: string,
  currentUserId: string,
): Promise<GroupMember | undefined> {
  const member = group.members.find(item => item.id === paidByMemberId);
  if (!member) return undefined;
  if (member.status !== 'connected') return undefined;
  if (member.profileId === currentUserId) return member;
  if (member.profileId && member.profileId !== currentUserId) return undefined;
  if (!sameDisplayName(member.name, getCurrentUserName())) return undefined;

  const joinedAt = member.joinedAt ?? new Date().toISOString();
  await groupMembersDb.update(member.id, {
    profileId: currentUserId,
    status: 'connected',
    joinedAt,
  });

  const claimed: GroupMember = {
    ...member,
    profileId: currentUserId,
    status: 'connected',
    joinedAt,
  };

  group.members = group.members.map(item => item.id === claimed.id ? claimed : item);
  return claimed;
}

function patchGroupMemberInState(
  set: (partial: Partial<SplitState> | ((state: SplitState) => Partial<SplitState>)) => void,
  groupId: string,
  member: GroupMember,
) {
  set((state) => ({
    groups: state.groups.map((item) =>
      item.id === groupId
        ? {
            ...item,
            members: item.members.map((existing) =>
              existing.id === member.id ? member : existing,
            ),
          }
        : item,
    ),
  }));
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

/**
 * True when we can PROVE the caller is no longer a live participant: they hold
 * a membership row in this group and its status is not 'connected' (they left,
 * declined, or have an invitation they never accepted).
 *
 * Every group write path now requires a CONNECTED membership — expenses and
 * settlements are validated by tg_group_expenses_require_connected_members /
 * tg_group_settlements_require_connected_members, and is_group_member() still
 * means 'connected' only. So a creator who has since left can no longer edit or
 * delete even their OWN rows, and "only the member who added this can change
 * it" would be an actively misleading explanation.
 *
 * Deliberately NOT "no member row found": legacy groups can carry an owner seat
 * with a null profile_id, and blocking those would be a regression for a user
 * the server would still accept. Absence of proof is not proof of absence — we
 * fall through to the pre-existing behaviour instead.
 */
function isKnownNonMember(group: SplitGroup, userId: string): boolean {
  const membership = group.members.find(member => member.profileId === userId);
  return Boolean(membership) && membership?.status !== 'connected';
}

// ── Group fan-out is SERVER-SIDE now ───────────────────────────────────────
// `fanOutGroupUpdate` used to live here: after every group write it inserted
// the group_events activity row and one notifications row per other connected
// member, from the ACTOR's device, swallowing every failure with
// console.error. Two audit findings killed it:
//
//   • 08-notifications.md N-2 — an actor who went offline / had the app killed
//     / closed the tab between the money write and the fan-out meant the other
//     members were never notified and no activity row existed at all. No retry
//     path (the outbox scaffold is inert).
//   • 05-security.md H5 / 08-notifications.md N-3 — writing those rows required
//     an RLS policy letting any co-member insert arbitrary title/body for any
//     other member, which the push trigger then forwarded verbatim as
//     app-branded HIGH-priority FCM. Phishing through the app's own chrome.
//
// Both rows are now written by AFTER triggers on group_expenses /
// group_settlements / group_members, in the same transaction as the write
// itself, with the text composed from a fixed server template catalog and a
// per-actor rate limit. See supabase-migration-audit-p0-notifications.sql.
// Nothing in this file may write notifications or group_events again.

export const useSplitStore = create<SplitState>((set, get) => ({
  ...INITIAL_SPLIT_STATE,

  reset: () => set(INITIAL_SPLIT_STATE),

  loadGroups: async () => {
    set({ loading: true });
    try {
      const groups = await splitGroupsDb.getAll();
      // One batched query for ALL members across all visible groups,
      // bucketed client-side. Replaces the prior N round-trips
      // (hydrateGroup per group) with 1.
      const ids = groups.map((g) => g.id);
      const membersByGroup = await groupMembersDb.getByGroups(ids).catch(() => new Map());
      const hydrated = groups.map((group) => {
        const members = membersByGroup.get(group.id);
        return members && members.length > 0 ? { ...group, members } : group;
      });
      set({ groups: hydrated });
    } finally {
      set({ loading: false });
    }
  },

  // Compute per-group "my balance" in one shot: two batched queries for
  // every expense and settlement the user can see (RLS scopes both to groups
  // they belong to), then a pure in-memory pass. This collapses what used to
  // be 2N round-trips into 2, eliminating the "All settled → real numbers"
  // flash users were seeing on the Groups tab.
  //
  // The expenses fetch uses the narrow balance projection — ~5 columns
  // instead of the full row — and is deduped against any inflight
  // loadUnreconciledFlags call so the same data isn't downloaded twice
  // (the splits page kicks both off in parallel).
  loadBalances: async () => {
    const currentUserId = localStorage.getItem('hisaab_supabase_uid');
    if (!currentUserId) {
      set({ balances: {}, balancesLoaded: true });
      return;
    }
    try {
      const [allExpenses, allSettlements] = await Promise.all([
        fetchSharedBalanceExpenses(),
        groupSettlementsDb.getAllVisibleForBalances(),
      ]);

      // Group the fetches by groupId once so the per-group pass is O(1) lookup.
      const expensesByGroup = new Map<string, GroupExpenseBalanceRow[]>();
      for (const e of allExpenses) {
        const bucket = expensesByGroup.get(e.groupId) ?? [];
        bucket.push(e);
        expensesByGroup.set(e.groupId, bucket);
      }
      const settlementsByGroup = new Map<string, GroupSettlementBalanceRow[]>();
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

  // Returns "this group has at least one expense the current user paid for
  // that isn't reconciled yet" — only the payer can reconcile their own
  // expenses, so the indicator is actionable: it tells the user which
  // groups need their attention, not just which groups have unreconciled
  // entries by anyone.
  //
  // Shares its expense fetch with loadBalances via fetchSharedBalanceExpenses
  // so a SplitsPage load that runs both in parallel does a SINGLE round-trip
  // for the expenses table, not two.
  loadUnreconciledFlags: async (currentUserId: string) => {
    if (!currentUserId) {
      set({ unreconciledFlags: {} });
      return;
    }
    try {
      const allExpenses = await fetchSharedBalanceExpenses();
      const memberIdByGroup = new Map<string, string>();
      const userName = getCurrentUserName();
      for (const group of get().groups) {
        const me = group.members.find((m) => m.profileId === currentUserId)
          ?? group.members.find((m) => !m.profileId && sameDisplayName(m.name, userName));
        if (me) memberIdByGroup.set(group.id, me.id);
      }
      const flags: Record<string, boolean> = {};
      for (const exp of allExpenses) {
        const myMemberId = memberIdByGroup.get(exp.groupId);
        if (!myMemberId) continue;
        if (exp.paidBy !== myMemberId) continue;
        if (exp.isReconciled) continue;
        flags[exp.groupId] = true;
      }
      set({ unreconciledFlags: flags });
    } catch (err) {
      console.error('loadUnreconciledFlags failed', err);
    }
  },

  createGroup: async (name, emoji, resolvedMembers, currency) => {
    const now = new Date().toISOString();
    const currentUserId = getCurrentUserId();
    const ownerName = getCurrentUserName();

    // Dedupe: ignore the owner if they accidentally added their own code, and
    // collapse duplicate profileIds to a single member row.
    //
    // Everyone but the owner is created as 'invited', NOT 'connected' (audit
    // H6 / SEC-05). Adding a stranger to a group is an invitation, not a fact:
    // tg_group_members_require_invite_consent forces status='invited',
    // role='member', joined_at=NULL on any client insert naming another user,
    // and only accept_group_membership can promote it. Writing 'connected'
    // here would have made the UI claim, until the next reload, that people
    // had joined who had not — and joinedAt is a fact about acceptance, so it
    // stays null too.
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
        status: 'invited',
        profileId: r.profileId,
        joinedAt: null,
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

    // The group_members insert above fires the server-side fan-out: every
    // invited member gets a "you were invited to <group>" notification
    // (tg_group_members_notify_invited) plus the durable group_events row,
    // written in that transaction. That trigger is REQUIRED, not decorative —
    // the notifications INSERT policy demands is_group_member() for the
    // recipient, which an 'invited' user fails, so a client fan-out could not
    // reach them at all.
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
    if (!normalized) return { status: 'INVALID_CODE' };

    // One atomic RPC handles: code lookup, membership upsert, status flip.
    // The caller no longer needs to be able to SELECT split_groups before
    // joining — the old two-step flow failed because strict RLS blocks that
    // pre-read for non-members. See supabase-migration-join-by-code-rpc.sql.
    //
    // Failure is now a status, not a throw (audit C5 /
    // supabase-migration-audit-p0-join-abuse-limits.sql) — the old RAISE was
    // rolling back the rate-limiter's own evidence row.
    const result = await groupsLookupDb.joinByCode(normalized, getCurrentUserName());
    if (result.status !== 'ok') return { status: result.status };

    // member_joined fan-out is emitted by the group_members trigger inside the
    // join RPC's own transaction — including the "already connected" no-op
    // case, which the trigger skips because no status/profile transition
    // happened. That replaces the old client-side spam guard here.
    await get().loadGroups();
    return { status: 'ok', groupId: result.groupId };
  },

  deleteGroup: async (id) => {
    // Personal mirror transactions are deliberately NOT deleted here: they
    // record money that really left the user's accounts, and deleting them
    // would refund balances for spending that genuinely happened. Once the
    // group rows die (FK cascade for every member), the liveness probe in
    // the transaction guards releases each mirror for normal edit/delete.
    //
    // The two explicit ledger wipes that used to run first are GONE. Since
    // supabase-migration-audit-p0-group-ledger-integrity.sql there is no
    // permissive DELETE policy on group_expenses / group_settlements, so both
    // calls were silent 0-row no-ops; the split_groups FK cascade does the
    // work. Keeping them would also have been actively dangerous on a
    // half-migrated database — they would wipe the ledger, and then the
    // deletion guard below would refuse, leaving a surviving group with no
    // money history at all (group-deletion-guard.sql §0.1).
    //
    // This THROWS on refusal (GROUP_HAS_OTHER_MEMBERS /
    // GROUP_HAS_OUTSTANDING_BALANCES) — the caller maps it and offers Archive.
    await splitGroupsDb.delete(id);
    await get().loadGroups();
  },

  leaveGroup: async (id) => {
    // An 'invited' member has not joined, so leave_group is the wrong door:
    // it refuses on a non-zero balance, an unreconciled expense, or a pending
    // invite, and NOT_ACTIVE_MEMBER is the best they could hope for.
    // decline_group_membership is a separate RPC with no gates at all,
    // precisely so a never-accepted user can always refuse (consent-guards
    // §2.5). Deciding here keeps every existing "Leave group" entry point
    // correct without each of them having to know about invitations.
    const currentUserId = getCurrentUserId();
    const group = get().groups.find(item => item.id === id);
    const myMembership = group?.members.find(member => member.profileId === currentUserId);
    if (myMembership?.status === 'invited') {
      return get().declineGroupMembership(id);
    }

    const result = await groupMembershipDb.leave(id);
    return refreshAfterSuccessfulLeave(result, async () => {
      await get().loadGroups();
      await Promise.all([
        get().loadBalances(),
        get().loadUnreconciledFlags(getCurrentUserId()),
      ]);
    });
  },

  loadPendingInvitations: async () => {
    try {
      set({ pendingInvitations: await groupMembershipDb.listPending() });
    } catch (err) {
      console.error('loadPendingInvitations failed', err);
    }
  },

  acceptGroupMembership: async (groupId) => {
    const result = await groupMembershipDb.accept(groupId);
    if (result.success) {
      // The group only becomes visible (RLS) once the row is 'connected', so
      // the reload has to happen before the UI can show anything about it.
      await get().loadGroups();
      await get().loadPendingInvitations();
      await Promise.all([
        get().loadBalances(),
        get().loadUnreconciledFlags(getCurrentUserId()),
      ]);
    }
    return result;
  },

  declineGroupMembership: async (groupId) => {
    const result = await groupMembershipDb.decline(groupId);
    if (result.success) {
      await get().loadPendingInvitations();
      // A decline from inside the group screen (an 'invited' member who
      // deep-linked in) must also drop the group from the list.
      await get().loadGroups();
    }
    return result;
  },

  archiveGroup: async (groupId) => {
    const result = await groupArchiveDb.archive(groupId);
    if (result.success) await get().loadGroups();
    return result;
  },

  unarchiveGroup: async (groupId) => {
    const result = await groupArchiveDb.unarchive(groupId);
    if (result.success) await get().loadGroups();
    return result;
  },

  transferGroupOwnership: async (groupId, newOwnerMemberId) => {
    const result = await groupOwnershipDb.transfer(groupId, newOwnerMemberId);
    if (result.success) await get().loadGroups();
    return result;
  },

  refreshJoinCode: async (groupId) => {
    // Same generator the create path uses, so the code shape never diverges.
    // The expiry is NOT sent: trg_split_groups_join_code_expiry re-stamps a
    // fresh 14-day window server-side whenever join_code changes, and an
    // explicit value from the client would override it.
    const joinCode = generateGroupCodeCandidate();
    const joinCodeNormalized = normalizeGroupCode(joinCode);
    await splitGroupsDb.rotateJoinCode(groupId, joinCode, joinCodeNormalized);
    await get().loadGroups();
    return joinCode;
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
    // The RAW token goes to the server, which derives the SHA-256 itself
    // (hash_invite_token). Hashing here was the vulnerability: the stored hash
    // was the credential AND every group member could read it, so hashing at
    // rest bought nothing (audit H3 / SEC-07). A leaked hash is now inert.
    const result = await groupsLookupDb.acceptInvite(token, getCurrentUserName());
    if (result.status !== 'ok') {
      return result.retryAfterSeconds === undefined
        ? { status: result.status }
        : { status: result.status, retryAfterSeconds: result.retryAfterSeconds };
    }
    // member_joined fan-out: server-side, from the group_members trigger the
    // accept RPC's own INSERT/UPDATE fires.
    await get().loadGroups();
    return { status: 'ok', groupId: result.groupId, wasAlreadyConnected: result.wasAlreadyConnected };
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
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error('Expense amount must be greater than zero');
    }
    if (input.amount >= MAX_MONEY_MAGNITUDE) {
      throw new Error(tStatic('err_money_amount_too_large'));
    }
    // Client mirror of the server's GROUP_SPLITS_DO_NOT_SUM trigger
    // (supabase-migration-p1-money-bounds.sql, audit 05-security M12). The
    // shares are what EVERY member's client computes balances from
    // (src/lib/groupDebts.ts), so a row whose shares don't reconcile with its
    // amount silently moves everyone else's numbers — and in splits_only mode
    // these rows are the entire money record.
    //
    // Tolerance is 0.01, NOT splitMath's `splitsSumToTotal` (0.005): the
    // 'exact' method in computeShares deliberately accepts a mismatch up to
    // 0.01 (splitMath.ts: `if (Math.abs(total - amount) > 0.01)`), so the
    // tighter helper would reject splits the form itself considers valid.
    // 0.01 is also exactly the server trigger's tolerance, so the two agree.
    if (input.splits.some((split) => !Number.isFinite(split.amount) || split.amount < 0)) {
      throw new Error(tStatic('err_money_amount_negative'));
    }
    const splitsTotal = input.splits.reduce((sum, split) => sum + split.amount, 0);
    if (Math.abs(splitsTotal - input.amount) > 0.01) {
      throw new Error(
        tStatic('err_group_splits_mismatch')
          .replace('{splits}', String(Math.round(splitsTotal * 100) / 100))
          .replace('{amount}', String(input.amount)),
      );
    }

    const currentUserId = getCurrentUserId();
    const participantError = validateNewGroupExpenseParticipants(group, input.paidBy, input.splits);
    if (participantError) throw new Error(participantError);
    const paidByMember = await claimPaidByMemberIfMine(group, input.paidBy, currentUserId);
    if (paidByMember) patchGroupMemberInState(set, group.id, paidByMember);
    if (input.paidFromAccountId && !paidByMember) {
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

    try {
      await groupExpensesDb.add(expense);
    } catch (err) {
      if (linkedTransactionId) {
        await useTransactionStore.getState().deleteTransaction(linkedTransactionId, { allowLinkedGroupExpense: true }).catch((rollbackErr) => {
          console.error('linked group transaction rollback failed', rollbackErr);
        });
      }
      throw err;
    }

    // expense_added notification + group_events row: written by the
    // group_expenses trigger in the insert's own transaction.
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
    // Left the group? Then this is read-only for you, even for rows you wrote
    // yourself — checked BEFORE the creator rule so the message is honest.
    if (isKnownNonMember(group, currentUserId)) {
      throw new Error(tStatic('grp_left_readonly'));
    }
    // Creator-only, enforced BEFORE any side effects. RLS would silently
    // 0-row the shared write anyway — but by then this user's own mirror
    // transaction would already have been mutated, desyncing the two.
    if (existing.createdBy && existing.createdBy !== currentUserId) {
      throw new Error(tStatic('grp_only_creator_edit'));
    }
    const parsedExistingNote = parseInternalNote(existing.notes);
    const existingMeta = parsedExistingNote.meta;
    // The user's visible note must survive edits — it used to be silently
    // erased because every rewrite passed '' as the visible part.
    const visibleNote = parsedExistingNote.visibleNote;
    const nextPaidFromAccountId = changes.paidFromAccountId === undefined
      ? existingMeta.paidFromAccountId
      : changes.paidFromAccountId ?? undefined;

    const nextExpense: GroupExpense = {
      ...existing,
      ...changes,
      notes: existing.notes,
    };

    if (expenseParticipantsChanged(existing, nextExpense)) {
      const participantError = validateNewGroupExpenseParticipants(group, nextExpense.paidBy, nextExpense.splits);
      if (participantError) throw new Error(participantError);
    }

    const paidByMember = await claimPaidByMemberIfMine(group, nextExpense.paidBy, currentUserId);
    if (paidByMember) patchGroupMemberInState(set, group.id, paidByMember);

    if (nextPaidFromAccountId && !paidByMember) {
      throw new Error('Only your own payments can be linked to a personal account');
    }

    // Snapshot the full linked transaction state BEFORE we touch it, so we
    // can replay the inverse if groupExpensesDb.update later fails. Without
    // this, a partial commit leaves the account balance moved (or restored)
    // while the ledger row still reflects the old amount.
    let linkedTransactionId = existingMeta.linkedTransactionId;
    let createdLinkedTransactionId: string | undefined;
    const originalLinkedTx = linkedTransactionId
      ? await transactionsDb.get(linkedTransactionId).catch(() => null)
      : null;
    type Rollback = () => Promise<void>;
    const rollbacks: Rollback[] = [];

    if (linkedTransactionId && nextPaidFromAccountId) {
      await useTransactionStore.getState().updateTransaction(
        linkedTransactionId,
        {
          type: 'expense',
          amount: nextExpense.amount,
          sourceAccountId: nextPaidFromAccountId,
          category: nextExpense.category,
          notes: buildInternalNote(visibleNote, {
            expenseDescription: nextExpense.description,
            groupExpenseId: nextExpense.id,
            groupId: group.id,
            groupName: group.name,
          }),
        },
        { allowLinkedGroupExpense: true },
      );
      if (originalLinkedTx && originalLinkedTx.type === 'expense' && originalLinkedTx.sourceAccountId) {
        // Linked group-expense transactions are always of type 'expense' with
        // a sourceAccountId. Narrow here so updateTransaction's expense-input
        // contract is satisfied.
        const sourceId = originalLinkedTx.sourceAccountId;
        const origAmount = originalLinkedTx.amount;
        const origCategory = originalLinkedTx.category ?? '';
        const origNotes = originalLinkedTx.notes ?? '';
        rollbacks.push(async () => {
          await useTransactionStore.getState().updateTransaction(
            originalLinkedTx.id,
            {
              type: 'expense',
              amount: origAmount,
              sourceAccountId: sourceId,
              category: origCategory,
              notes: origNotes,
            },
            { allowLinkedGroupExpense: true },
          );
        });
      }
    } else if (linkedTransactionId && !nextPaidFromAccountId) {
      await useTransactionStore.getState().deleteTransaction(linkedTransactionId, { allowLinkedGroupExpense: true });
      linkedTransactionId = undefined;
      if (originalLinkedTx) {
        rollbacks.push(async () => {
          // processTransaction will create a NEW id, but we need the old id to
          // preserve any other references. Use the raw transaction store helper.
          await useTransactionStore.getState().restoreTransaction(originalLinkedTx);
        });
      }
    } else if (!linkedTransactionId && nextPaidFromAccountId) {
      const tx = await useTransactionStore.getState().processTransaction({
        type: 'expense',
        amount: nextExpense.amount,
        sourceAccountId: nextPaidFromAccountId,
        category: nextExpense.category,
        notes: buildInternalNote(visibleNote, {
          expenseDescription: nextExpense.description,
          groupExpenseId: nextExpense.id,
          groupId: group.id,
          groupName: group.name,
        }),
      });
      linkedTransactionId = tx.id;
      createdLinkedTransactionId = tx.id;
      rollbacks.push(async () => {
        await useTransactionStore.getState().deleteTransaction(tx.id, { allowLinkedGroupExpense: true });
      });
    }

    // Editing the payer/amount/splits silently changes what people owe, so a
    // reconciled (settled) expense must reopen when any of those change.
    const keepReconciled = !coreExpenseFieldsChanged(existing, nextExpense);
    try {
      await groupExpensesDb.update(id, {
        description: nextExpense.description,
        amount: nextExpense.amount,
        paidBy: nextExpense.paidBy,
        splitType: nextExpense.splitType,
        splits: nextExpense.splits,
        category: nextExpense.category,
        notes: buildInternalNote(visibleNote, {
          linkedTransactionId,
          paidFromAccountId: nextPaidFromAccountId,
        }),
        updatedBy: currentUserId,
        version: (existing.version ?? 1) + 1,
        isReconciled: keepReconciled ? existing.isReconciled ?? false : false,
        reconciledAt: keepReconciled ? existing.reconciledAt ?? null : null,
        reconciledBy: keepReconciled ? existing.reconciledBy ?? null : null,
      // Optimistic lock (audit F-6): the write only lands if nobody else has
      // edited this expense since we read it. A concurrent edit makes this 0
      // rows and throws grp_expense_version_conflict — the mirror rollbacks
      // below then undo our half, so neither side is left desynced.
      }, { expectedVersion: existing.version ?? 1 });
    } catch (err) {
      // Run rollbacks LIFO. Each failure is logged but does not block the
      // others — we want best-effort recovery.
      for (let i = rollbacks.length - 1; i >= 0; i -= 1) {
        await rollbacks[i]().catch((rollbackErr) => {
          console.error('[updateGroupExpense] rollback step failed', rollbackErr);
        });
      }
      // createdLinkedTransactionId kept for telemetry parity with older code paths.
      void createdLinkedTransactionId;
      // Pull the winning version back into the UI before the error surfaces,
      // so the user sees the other person's numbers rather than their own
      // rejected ones sitting there looking saved.
      await get().loadBalances().catch(() => {});
      throw err;
    }

    // expense_updated notification + group_events row: written by the
    // group_expenses trigger, which only fires on money-bearing field changes
    // (so a reconcile flip stays silent, exactly as before).
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
    const paidByMember = group.members.find(member => member.id === existing.paidBy);
    if (paidByMember?.profileId !== currentUserId) {
      throw new Error('Only the member who paid can reconcile this expense');
    }

    await groupExpensesDb.setReconciled(id, isReconciled);

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

    if (isKnownNonMember(group, currentUserId)) {
      throw new Error(tStatic('grp_left_readonly'));
    }
    // Creator-only, checked BEFORE the mirror is touched — otherwise a
    // non-creator's attempt deletes their own mirror while RLS silently
    // keeps the shared row alive.
    if (expense.createdBy && expense.createdBy !== currentUserId) {
      throw new Error(tStatic('grp_only_creator_delete'));
    }

    const meta = parseInternalNote(expense.notes).meta;
    if (meta.linkedTransactionId) {
      await useTransactionStore.getState().deleteTransaction(meta.linkedTransactionId, { allowLinkedGroupExpense: true });
    }

    await groupExpensesDb.delete(id);

    // expense_deleted notification + group_events row: written by the
    // group_expenses trigger on the deleted_at transition.
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

  deleteSettlement: async (groupId, settlementId) => {
    const group = await hydrateGroup(get().groups.find((item) => item.id === groupId) ?? await splitGroupsDb.get(groupId));
    if (!group) throw new Error('Group not found');
    const currentUserId = getCurrentUserId();
    const settlements = await groupSettlementsDb.getByGroup(groupId);
    const settlement = settlements.find((s) => s.id === settlementId);
    if (!settlement) return;
    if (isKnownNonMember(group, currentUserId)) {
      throw new Error(tStatic('grp_left_readonly'));
    }
    // Creator-only, checked client-side for an honest message; the RLS-backed
    // 0-row check in deleteOne is the enforcement backstop.
    if (settlement.createdBy && settlement.createdBy !== currentUserId) {
      throw new Error(tStatic('grp_only_recorder_settlement'));
    }
    await groupSettlementsDb.deleteOne(settlementId);

    // settlement_deleted notification + group_events row: written by the
    // group_settlements trigger on the deleted_at transition. deleteOne's
    // `.is('deleted_at', null)` filter keeps a two-device race idempotent, so
    // the trigger can never fire twice for the same undo either.
    await useActivityStore.getState().logActivity(
      'group_settlement',
      `Removed a settlement in ${group.name}`,
      settlement.id,
      'group_settlement',
    );
  },

  addSettlement: async (input) => {
    const group = await hydrateGroup(get().groups.find((item) => item.id === input.groupId) ?? await splitGroupsDb.get(input.groupId));
    if (!group) throw new Error('Group not found');
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error('Settlement amount must be greater than zero');
    }

    const currentUserId = getCurrentUserId();
    const participantError = validateNewSettlementParticipants(group, input.fromMember, input.toMember);
    if (participantError) throw new Error(participantError);

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

    // The outstanding-amount cap is enforced by the RPC, INSIDE the
    // transaction and under a group row lock (audit F-7). The old client-side
    // check read the debts, computed a cap, then inserted — so two devices
    // recording the same repayment both passed and the pair over-settled.
    // The server cap is max(raw pairwise debt, min(-net(from), net(to))),
    // i.e. exactly the "valid under either the pairwise OR the simplified
    // view" rule the UI offers, so nothing legitimate is newly rejected.
    const result = await groupSettlementsDb.record(settlement);
    if (!isSettlementSuccess(result)) {
      throw new Error(settlementFailureMessage(result, tStatic));
    }

    const fromName = group.members.find((member) => member.id === input.fromMember)?.name ?? 'Someone';
    const toName = group.members.find((member) => member.id === input.toMember)?.name ?? 'someone';

    // settlement_added notification + group_events row: written by the
    // group_settlements trigger inside the RPC's transaction.
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

  getPairwiseDebts: async (groupId) => {
    const group = await getGroupOrFetch(groupId, get().groups);
    if (!group) return [];
    const [expenses, settlements] = await Promise.all([
      groupExpensesDb.getByGroup(groupId),
      groupSettlementsDb.getByGroup(groupId),
    ]);
    return computePairwiseDebts(group.members, expenses, settlements);
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
