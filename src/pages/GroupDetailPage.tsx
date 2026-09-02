import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Handshake, Trash2, Share2, Clock3, Copy, Receipt, Sparkles, Check, LogOut, MoreVertical, UserPlus, Pencil, X, Archive, ArchiveRestore, UserMinus, Crown, RefreshCw, Lock } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { AddGroupExpenseModal } from './AddGroupExpenseModal';
import { EditGroupExpenseModal } from './EditGroupExpenseModal';
import { SettleUpModal } from './SettleUpModal';
import { GroupSettleUpModal } from './GroupSettleUpModal';
import { GroupInviteModal } from '../components/GroupInviteModal';
import { ProgressRing } from '../components/ProgressRing';
import { PageErrorState } from '../components/PageErrorState';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { VerifiedBadge } from '../components/VerifiedBadge';
import { readGroupGuardFailure } from '../lib/groupGuardErrors';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { useToast } from '../components/Toast';
import { subscribeToGroupMembers } from '../lib/realtime';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import type { SplitGroup, GroupExpense, GroupEvent, GroupSettlement } from '../db';

// Compact "May 26, 2026 · 11:39 PM" date format for activity tiles. Sidesteps
// the noisy `toLocaleString()` default ("5/26/2026, 11:39:45 PM") so users can
// scan a date column without parsing slash-separated numerics + seconds.
function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

interface ActivityDisplay {
  icon: ReactNode;
  iconBg: string;
  title: string;
  titleClass?: string;
  subtitle?: string;
  note?: string;
  amount?: string;
  amountClass?: string;
  amountChange?: string;
}

// Maps a GroupEvent + payload to the visual props for its tile. Settlement
// events fall back to the settlements list to recover the note + amount,
// since the event payload only carries member ids and amount and we want
// to surface the "cash diya"-style settler note for context.
function getActivityDisplay(
  event: GroupEvent,
  settlements: GroupSettlement[],
  group: SplitGroup,
  t: ReturnType<typeof useT>,
): ActivityDisplay {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const memberName = (id: string | undefined): string => {
    if (!id) return '?';
    return group.members.find(m => m.id === id)?.name ?? '?';
  };

  switch (event.eventType) {
    case 'settlement_added': {
      const settlement = settlements.find(s => s.id === event.entityId);
      const fromId = typeof payload.fromMember === 'string' ? payload.fromMember : settlement?.fromMember;
      const toId = typeof payload.toMember === 'string' ? payload.toMember : settlement?.toMember;
      const amount = typeof payload.amount === 'number' ? payload.amount : settlement?.amount ?? 0;
      return {
        icon: <Handshake size={16} />,
        iconBg: 'bg-receive-50 text-receive-text',
        title: `${memberName(fromId)} → ${memberName(toId)}`,
        subtitle: 'Settled up',
        note: settlement?.note || undefined,
        amount: formatMoney(amount, group.currency),
        amountClass: 'text-receive-text',
      };
    }
    case 'settlement_deleted': {
      const fromId = typeof payload.fromMember === 'string' ? payload.fromMember : undefined;
      const toId = typeof payload.toMember === 'string' ? payload.toMember : undefined;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      return {
        icon: <Handshake size={16} />,
        iconBg: 'bg-warn-50 text-warn-600',
        title: `${memberName(fromId)} → ${memberName(toId)}`,
        subtitle: 'Settlement removed',
        amount: formatMoney(amount, group.currency),
        amountClass: 'text-warn-600',
      };
    }
    case 'expense_added': {
      const description = typeof payload.description === 'string' ? payload.description : event.summary;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      const paidById = typeof payload.paidBy === 'string' ? payload.paidBy : undefined;
      const actorName = paidById ? memberName(paidById) : '';
      return {
        icon: <Receipt size={16} />,
        iconBg: 'bg-accent-100 text-accent-600',
        title: description,
        subtitle: actorName ? `Added · paid by ${actorName}` : 'Expense added',
        amount: amount > 0 ? formatMoney(amount, group.currency) : undefined,
        amountClass: 'text-ink-900',
      };
    }
    case 'expense_updated': {
      const after = (payload.after ?? {}) as { description?: string; amount?: number };
      const before = (payload.before ?? {}) as { description?: string; amount?: number };
      const description = after.description ?? before.description ?? event.summary;
      const amountChanged = typeof before.amount === 'number' && typeof after.amount === 'number' && Math.abs(before.amount - after.amount) > 0.001;
      return {
        icon: <Pencil size={16} />,
        iconBg: 'bg-warn-50 text-warn-600',
        title: description,
        subtitle: 'Expense updated',
        amount: typeof after.amount === 'number' && after.amount > 0 ? formatMoney(after.amount, group.currency) : undefined,
        amountClass: 'text-ink-900',
        amountChange: amountChanged
          ? `${formatMoney(before.amount as number, group.currency)} → ${formatMoney(after.amount as number, group.currency)}`
          : undefined,
      };
    }
    case 'expense_deleted': {
      const description = typeof payload.description === 'string' ? payload.description : event.summary;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      return {
        icon: <Trash2 size={16} />,
        iconBg: 'bg-pay-50 text-pay-text',
        title: description,
        titleClass: 'line-through text-ink-500',
        subtitle: 'Expense deleted',
        amount: amount > 0 ? formatMoney(amount, group.currency) : undefined,
        amountClass: 'text-ink-500 line-through',
      };
    }
    case 'member_joined':
      return {
        icon: <UserPlus size={16} />,
        iconBg: 'bg-info-50 text-info-600',
        title: event.summary,
        subtitle: 'Joined the group',
      };
    case 'member_invited':
      return {
        icon: <Share2 size={16} />,
        iconBg: 'bg-info-50 text-info-600',
        title: event.summary,
        subtitle: 'Invitation sent',
      };
    case 'group_created':
      return {
        icon: <Sparkles size={16} />,
        iconBg: 'bg-accent-100 text-accent-600',
        title: event.summary,
        subtitle: 'Group created',
      };
    // ── Lifecycle events written by the audit-2026-09 migrations ────────────
    // All four carry a server-composed `summary`, so the title is that
    // sentence and the subtitle is the localized event label.
    case 'group_archived':
      // archive_group, group-deletion-guard.sql §6b.
      // Payload: { groupId, groupName, currency, actorName, archivedAt }
      return {
        icon: <Archive size={16} />,
        iconBg: 'bg-cream-soft text-ink-600',
        title: event.summary,
        subtitle: t('gev_group_archived'),
      };
    case 'group_unarchived':
      // unarchive_group, §6c. Payload: { …, unarchivedAt }
      return {
        icon: <ArchiveRestore size={16} />,
        iconBg: 'bg-receive-50 text-receive-text',
        title: event.summary,
        subtitle: t('gev_group_unarchived'),
      };
    case 'member_account_deleted':
      // delete_current_user, account-deletion.sql §4b. Payload:
      // { memberId, displayName, expensesRetained, settlementsRetained, deletedAt }
      // The retained counts matter: they are the reassurance that this
      // member's money records did NOT disappear with their account.
      return (() => {
        const displayName = typeof payload.displayName === 'string' ? payload.displayName : '';
        const expensesRetained = Number(payload.expensesRetained ?? 0);
        const settlementsRetained = Number(payload.settlementsRetained ?? 0);
        const retained = expensesRetained + settlementsRetained;
        return {
          icon: <UserMinus size={16} />,
          iconBg: 'bg-warn-50 text-warn-600',
          title: displayName || event.summary,
          subtitle: t('gev_member_account_deleted'),
          note: retained > 0 ? event.summary : undefined,
        };
      })();
    case 'group_ownership_transferred':
      // transfer_group_ownership, account-deletion.sql §5. Payload:
      // { newOwnerMemberId, newOwnerProfileId, previousOwnerMemberId }
      return (() => {
        const newOwnerId = typeof payload.newOwnerMemberId === 'string' ? payload.newOwnerMemberId : undefined;
        return {
          icon: <Crown size={16} />,
          iconBg: 'bg-accent-100 text-accent-600',
          title: newOwnerId ? memberName(newOwnerId) : event.summary,
          subtitle: t('gev_ownership_transferred'),
        };
      })();
    default:
      return {
        icon: <Clock3 size={16} />,
        iconBg: 'bg-cream-soft text-ink-500',
        title: event.summary,
      };
  }
}

// Human-readable member status, replacing the raw enum ("connected",
// "invited", "guest"…) that leaked into the UI. Owner wins over status.
// Takes the active translator so the short status words localize.
function memberStatusLabel(t: ReturnType<typeof useT>, status?: string, isOwner?: boolean): string {
  if (isOwner) return t('member_owner');
  if (status === 'connected') return t('member_on_app');
  if (status === 'invited') return t('member_invited');
  return t('member_not_on_app');
}

function memberStatusClass(status?: string, isOwner?: boolean) {
  // Avatar chips render inside the navy hero, so the palette is white-on-dark
  // tints rather than the legacy pastel-on-light. Owner uses the violet accent;
  // connected uses receive green; invited uses warn amber; everyone else
  // (synthetic guest, declined, etc.) falls back to a translucent neutral.
  if (isOwner) return 'bg-accent-500/30 text-white ring-2 ring-accent-500/40';
  if (status === 'connected') return 'bg-receive-600/25 text-white';
  if (status === 'invited') return 'bg-warn-600/30 text-white';
  return 'bg-white/15 text-white/80';
}

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();
  const { groups, getGroupExpenses, getSimplifiedDebts, getPairwiseDebts, deleteGroup, leaveGroup, getGroupEvents, getSettlements, deleteSettlement, loadGroups, setGroupExpenseReconciled, archiveGroup, unarchiveGroup, transferGroupOwnership, refreshJoinCode } = useSplitStore();
  const markGroupRead = useNotificationStore((state) => state.markGroupRead);

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [expenses, setExpenses] = useState<GroupExpense[]>([]);
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [settlements, setSettlements] = useState<GroupSettlement[]>([]);
  const [debts, setDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  const [pairwiseDebts, setPairwiseDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  // Default to RAW direct debts (no rerouting to strangers); "Simplify" is opt-in.
  const [simplify, setSimplify] = useState(false);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'activity'>('expenses');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [showSettleShare, setShowSettleShare] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [editExpense, setEditExpense] = useState<GroupExpense | null>(null);
  const [savingReconciliationId, setSavingReconciliationId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [refreshingCode, setRefreshingCode] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferringMemberId, setTransferringMemberId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // One-time member-status legend. Shown the first time a group has any
  // non-connected member; dismissal persists per-device so it doesn't nag.
  const [legendDismissed, setLegendDismissed] = useState(
    () => localStorage.getItem('hisaab_member_legend_dismissed') === '1',
  );
  const dismissLegend = () => {
    localStorage.setItem('hisaab_member_legend_dismissed', '1');
    setLegendDismissed(true);
  };

  // Dismiss the kebab menu when the user taps outside it.
  useEffect(() => {
    if (!showMenu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMenu]);

  useEffect(() => {
    const nextGroup = groups.find(item => item.id === id);
    if (nextGroup) setGroup(nextGroup);
  }, [groups, id]);

  const reload = useCallback(async () => {
    if (!id) return;
    // Deep-links to /group/:id may land here before the global groups list
    // is hydrated. Kick off loadGroups in parallel so the header renders.
    const needsGroups = useSplitStore.getState().groups.length === 0;
    const [, nextExpenses, nextDebts, nextPairwise, nextEvents, nextSettlements] = await Promise.all([
      needsGroups ? loadGroups() : Promise.resolve(),
      getGroupExpenses(id),
      getSimplifiedDebts(id),
      getPairwiseDebts(id),
      getGroupEvents(id),
      getSettlements(id),
    ]);
    setExpenses(nextExpenses);
    setDebts(nextDebts);
    setPairwiseDebts(nextPairwise);
    setEvents(nextEvents);
    setSettlements(nextSettlements);
  }, [id, getGroupExpenses, getSimplifiedDebts, getPairwiseDebts, getGroupEvents, getSettlements, loadGroups]);

  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(reload);

  useEffect(() => {
    if (!id || loadStatus !== 'ready') return;
    void markGroupRead(id).catch(err => console.error('mark group read failed', err));
  }, [id, loadStatus, markGroupRead]);

  // While this page is open, subscribe to member changes on this group so
  // the header avatars and member count reflect joins/leaves instantly.
  // Realtime refreshes use a fire-and-forget reload — any failure surfaces
  // on the next explicit retry rather than spamming error UI on every poke.
  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToGroupMembers(id, () => {
      void useSplitStore.getState().loadGroups();
      void reload().catch(err => console.error('group realtime reload failed', err));
    });
    return unsubscribe;
  }, [id, reload]);

  // Hard error: the whole page is about this group's data. If it fails,
  // there's nothing useful to show — give the user a retry affordance.
  if (loadStatus === 'error') {
    return (
      <PageErrorState
        title="Couldn't load this group"
        message={loadError ?? 'The group data failed to load.'}
        onRetry={retryLoad}
      />
    );
  }

  if (!group || loadStatus === 'loading') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-mesh">
        <p className="text-ink-500">Loading...</p>
      </div>
    );
  }

  const getMemberName = (memberId: string) => group.members.find(member => member.id === memberId)?.name ?? '?';
  const currentMember = group.members.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))
    ?? group.members.find(member => member.isOwner);
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const isPaidByCurrentUser = (expense: GroupExpense) => {
    const paidByMember = group.members.find(member => member.id === expense.paidBy);
    return paidByMember?.profileId === currentUserId;
  };
  const getSplitTypeLabel = (splitType: GroupExpense['splitType']) => {
    if (splitType === 'equal') return t('group_split_equal');
    if (splitType === 'exact') return t('group_split_exact');
    if (splitType === 'percentage') return t('group_split_pct');
    return t('group_split_shares');
  };
  const getExpenseMeta = (expense: GroupExpense) => {
    const myShare = currentMember
      ? expense.splits.find(split => split.memberId === currentMember.id)?.amount ?? 0
      : 0;
    return {
      paidBy: getMemberName(expense.paidBy),
      split: getSplitTypeLabel(expense.splitType),
      share: formatMoney(myShare, group.currency),
    };
  };

  // Group-level health: total spend, settlements, and how far toward "zero
  // imbalance" the group is. Used both by the summary card and by the
  // per-member rings on the Balances tab.
  const shownDebts = simplify ? debts : pairwiseDebts;
  const totalSpend = expenses.reduce((s, e) => s + e.amount, 0);
  const totalSettled = settlements.reduce((s, x) => s + x.amount, 0);
  const totalOutstanding = shownDebts.reduce((s, d) => s + d.amount, 0);
  const settledRatio = totalOutstanding === 0
    ? 1
    : totalSettled / (totalSettled + totalOutstanding);
  const settledPct = Math.round(Math.max(0, Math.min(1, settledRatio)) * 100);

  // Per-member net balance — positive = owed money, negative = owes money.
  const memberNet = new Map<string, number>();
  for (const member of group.members) memberNet.set(member.id, 0);
  for (const d of shownDebts) {
    memberNet.set(d.to, (memberNet.get(d.to) ?? 0) + d.amount);
    memberNet.set(d.from, (memberNet.get(d.from) ?? 0) - d.amount);
  }
  const maxAbs = Math.max(
    1,
    ...Array.from(memberNet.values()).map(v => Math.abs(v)),
  );
  const memberStats = new Map<string, { paid: number; share: number; settlement: number }>();
  for (const member of group.members) memberStats.set(member.id, { paid: 0, share: 0, settlement: 0 });
  for (const expense of expenses) {
    const paidStats = memberStats.get(expense.paidBy) ?? { paid: 0, share: 0, settlement: 0 };
    paidStats.paid += expense.amount;
    memberStats.set(expense.paidBy, paidStats);

    for (const split of expense.splits) {
      const splitStats = memberStats.get(split.memberId) ?? { paid: 0, share: 0, settlement: 0 };
      splitStats.share += split.amount;
      memberStats.set(split.memberId, splitStats);
    }
  }
  for (const settlement of settlements) {
    const fromStats = memberStats.get(settlement.fromMember) ?? { paid: 0, share: 0, settlement: 0 };
    fromStats.settlement += settlement.amount;
    memberStats.set(settlement.fromMember, fromStats);

    const toStats = memberStats.get(settlement.toMember) ?? { paid: 0, share: 0, settlement: 0 };
    toStats.settlement += settlement.amount;
    memberStats.set(settlement.toMember, toStats);
  }
  const balanceRows = group.members
    .map(member => {
      const stats = memberStats.get(member.id) ?? { paid: 0, share: 0, settlement: 0 };
      return {
        member,
        paid: Math.round(stats.paid * 100) / 100,
        share: Math.round(stats.share * 100) / 100,
        settlement: Math.round(stats.settlement * 100) / 100,
        net: Math.round((memberNet.get(member.id) ?? 0) * 100) / 100,
      };
    })
    .filter(row => row.paid > 0.01 || row.share > 0.01 || row.settlement > 0.01 || Math.abs(row.net) > 0.01)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.paid - a.paid || a.member.name.localeCompare(b.member.name));

  // Archived = frozen and readable. The server blocks every write anyway
  // (tg_block_writes_in_archived_group / tg_block_join_archived_group), so
  // hiding the actions is honesty, not enforcement.
  const isArchived = Boolean(group.archivedAt);
  const isOwner = Boolean(currentMember?.isOwner);
  // transfer_group_ownership only accepts a connected, profile-linked member of
  // the same group — mirror that filter so the picker can never offer a
  // candidate the RPC will reject with INVALID_NEW_OWNER.
  const transferCandidates = group.members.filter(
    (member) => member.status === 'connected' && member.profileId && member.profileId !== currentUserId,
  );
  const joinCodeExpiresAt = group.joinCodeExpiresAt ? new Date(group.joinCodeExpiresAt) : null;
  const joinCodeExpired = joinCodeExpiresAt !== null
    && Number.isFinite(joinCodeExpiresAt.getTime())
    && joinCodeExpiresAt.getTime() < Date.now();
  const joinCodeExpiryLabel = joinCodeExpiresAt && Number.isFinite(joinCodeExpiresAt.getTime())
    ? joinCodeExpired
      ? t('grp_code_expired')
      : t('grp_code_expires').replace(
          '{date}',
          joinCodeExpiresAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        )
    : null;

  // Archive is the non-destructive alternative and, for a group with other
  // members or unsettled ex-members, the ONLY end state available: the delete
  // guard refuses, and leave_group refuses too once a balance is stuck
  // (group-deletion-guard.sql, residual risk R1).
  const handleArchive = async (confirmFirst = true) => {
    if (archiving) return false;
    if (confirmFirst) {
      const ok = await confirmDestructive({
        title: t('grp_archive_confirm_title'),
        description: t('grp_archive_confirm_body'),
        confirmLabel: t('grp_archive_action'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return false;
    }
    setArchiving(true);
    try {
      const result = await archiveGroup(group.id);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_archived_done') : t('grp_archive_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) await reload();
      return result.success;
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_archive_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
      return false;
    } finally {
      setArchiving(false);
    }
  };

  const handleUnarchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      const result = await unarchiveGroup(group.id);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_unarchived_done') : t('grp_unarchive_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) await reload();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_unarchive_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setArchiving(false);
    }
  };

  const handleDelete = async () => {
    // Unsettled debts vanish with the group — say so explicitly instead of
    // the generic body, so nobody deletes away money they're still owed.
    const outstanding = pairwiseDebts.reduce((s, d) => s + d.amount, 0);
    const ok = await confirmDestructive({
      title: t('group_delete_confirm'),
      description: outstanding > 0.005
        ? `${t('group_delete_unsettled').replace('{amount}', formatMoney(outstanding, group.currency))} ${t('del_group_body')}`
        : t('del_group_body'),
      confirmLabel: 'Delete group',
    });
    if (!ok) return;

    // supabase-migration-audit-p0-group-deletion-guard.sql refuses a client
    // hard-delete of a SHARED group. Previously this call had no try/catch at
    // all, so a refusal surfaced as an unhandled rejection and the user got
    // nothing. Both tiers are dead ends by design — Archive is the way out, so
    // it is offered as the primary action right here rather than being buried
    // back in the menu.
    try {
      await deleteGroup(group.id);
      navigate('/groups');
    } catch (err) {
      const blocker = readGroupGuardFailure(err);
      if (blocker?.code === 'GROUP_HAS_OTHER_MEMBERS' || blocker?.code === 'GROUP_HAS_OUTSTANDING_BALANCES') {
        const isMembers = blocker.code === 'GROUP_HAS_OTHER_MEMBERS';
        const body = isMembers ? t('grp_del_blocked_members_body') : t('grp_del_blocked_balances_body');
        const archiveInstead = await confirmDestructive({
          title: isMembers ? t('grp_del_blocked_members_title') : t('grp_del_blocked_balances_title'),
          // The server DETAIL names the members / amounts — keep it, it is the
          // difference between "someone" and "Bilal owes AED 150.00".
          description: blocker.detail ? `${body}\n\n${blocker.detail}` : body,
          confirmLabel: t('grp_del_archive_cta'),
          cancelLabel: t('not_now'),
          tone: 'warning',
        });
        if (archiveInstead) await handleArchive(false);
        return;
      }
      toast.show({
        type: 'error',
        title: t('grp_del_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    }
  };

  // Owner-only handover. The RPC only accepts a member who is connected AND
  // profile-linked, so a group can never be handed to a guest seat or a
  // stranger — the picker below applies exactly that filter.
  const handleTransferOwnership = async (memberId: string) => {
    if (transferringMemberId) return;
    setTransferringMemberId(memberId);
    try {
      const result = await transferGroupOwnership(group.id, memberId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_transfer_done') : t('grp_transfer_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) {
        setShowTransfer(false);
        await reload();
      }
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_transfer_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setTransferringMemberId(null);
    }
  };

  // Join codes expire 14 days after creation or rotation. Rotating retires the
  // old code immediately (anyone still holding it can no longer join), which is
  // exactly why this lives behind an explicit owner action.
  const handleRefreshJoinCode = async () => {
    if (refreshingCode) return;
    setRefreshingCode(true);
    try {
      const nextCode = await refreshJoinCode(group.id);
      await navigator.clipboard.writeText(nextCode).catch(() => {});
      toast.show({
        type: 'success',
        title: t('grp_code_refreshed'),
        subtitle: t('grp_code_refresh_sub'),
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_code_refresh_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRefreshingCode(false);
    }
  };

  const handleRemoveSettlement = async (settlement: (typeof settlements)[number]) => {
    const fromName = group.members.find((m) => m.id === settlement.fromMember)?.name ?? '?';
    const toName = group.members.find((m) => m.id === settlement.toMember)?.name ?? '?';
    const ok = await confirmDestructive({
      title: t('stl_remove_title'),
      description: t('stl_remove_body')
        .replace('{from}', fromName)
        .replace('{to}', toName)
        .replace('{amount}', formatMoney(settlement.amount, group.currency)),
      confirmLabel: t('stl_remove_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deleteSettlement(group.id, settlement.id);
      toast.show({ type: 'success', title: t('stl_removed') });
      void reload();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    }
  };

  const handleLeave = async () => {
    if (leaving) return;
    const ok = await confirmDestructive({
      title: 'Leave this group?',
      description: 'You can leave only after your balances and pending group items are fully resolved.',
      confirmLabel: 'Leave group',
      tone: 'warning',
    });
    if (!ok) return;

    setLeaving(true);
    try {
      const result = await leaveGroup(group.id);
      if (!result.success) {
        toast.show({
          type: 'error',
          title: 'You cannot leave this group yet',
          subtitle: result.userMessage,
          duration: 6000,
        });
        return;
      }
      navigate('/groups');
      toast.show({ type: 'success', title: result.userMessage });
    } catch (err) {
      console.error('Failed to leave group', err);
      toast.show({
        type: 'error',
        title: 'Could not leave this group',
        subtitle: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setLeaving(false);
    }
  };

  const handleGroupExpenseReconcile = async (expense: GroupExpense) => {
    if (savingReconciliationId) return;
    setSavingReconciliationId(expense.id);
    try {
      await setGroupExpenseReconciled(expense.id, !(expense.isReconciled ?? false));
      await reload();
    } catch (err) {
      console.error('Failed to update group expense reconciliation', err);
      toast.show({
        type: 'error',
        title: 'Could not update reconciliation',
        subtitle: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setSavingReconciliationId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={`${group.emoji} ${group.name}`}
          back
          action={
            // Compact 2-icon action row + overflow menu. Previously this row
            // showed Invite + Leave + Delete + LanguageToggle, which on
            // narrow Android screens left almost no room for the group
            // title (a `{emoji} {name}` string that's often long).
            <div className="flex items-center gap-2">
              {/* No new members can join an archived group
                  (tg_block_join_archived_group blocks even the definer join
                  RPCs), so an invite link would be born dead. */}
              {!isArchived && (
                <button
                  onClick={() => setShowInvite(true)}
                  className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                  aria-label="Invite"
                >
                  <Share2 size={14} className="text-white" />
                </button>
              )}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowMenu((v) => !v)}
                  className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={showMenu}
                >
                  <MoreVertical size={14} className="text-white" />
                </button>
                {showMenu && (
                  <div
                    role="menu"
                    className="absolute right-0 top-11 z-30 min-w-[180px] rounded-2xl bg-cream-card border border-cream-border shadow-lg overflow-hidden animate-fade-in"
                  >
                    {currentMember?.profileId === currentUserId && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); handleLeave(); }}
                        disabled={leaving}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft flex items-center gap-2.5 disabled:opacity-50 transition-colors"
                      >
                        <LogOut size={14} className={`text-ink-600 ${leaving ? 'animate-pulse' : ''}`} />
                        {leaving ? 'Leaving…' : 'Leave group'}
                      </button>
                    )}
                    {isOwner && transferCandidates.length > 0 && !isArchived && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowTransfer(true); }}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft flex items-center gap-2.5 border-t border-cream-hairline transition-colors"
                      >
                        <Crown size={14} className="text-ink-600" />
                        {t('grp_transfer_action')}
                      </button>
                    )}
                    {isOwner && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); void (isArchived ? handleUnarchive() : handleArchive()); }}
                        disabled={archiving}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft flex items-center gap-2.5 border-t border-cream-hairline disabled:opacity-50 transition-colors"
                      >
                        {isArchived
                          ? <ArchiveRestore size={14} className="text-ink-600" />
                          : <Archive size={14} className="text-ink-600" />}
                        {isArchived ? t('grp_unarchive_action') : t('grp_archive_action')}
                      </button>
                    )}
                    {isOwner && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); handleDelete(); }}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-pay-text active:bg-pay-50 flex items-center gap-2.5 border-t border-cream-hairline transition-colors"
                      >
                        <Trash2 size={14} className="text-pay-text" />
                        Delete group
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            {group.members.length} {t('group_members_count')} ·{' '}
            {group.members.filter((m) => m.status === 'connected').length} connected ·{' '}
            {group.currency}
          </p>

          <div className="flex items-center gap-1.5 mt-3 overflow-x-auto no-scrollbar">
            {group.members.map((member) => (
              <div key={member.id} className="flex flex-col items-center gap-0.5 shrink-0 w-14">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold ${memberStatusClass(member.status, member.isOwner)}`}
                >
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <span className="text-[9px] text-white/60 truncate w-full text-center">
                  {memberStatusLabel(t, member.status, member.isOwner)}
                </span>
              </div>
            ))}
          </div>

          {/* One-line status legend — appears the first time a group has any
              non-connected member, so the colour coding on the avatars is
              decodable. Dismissible and remembered per-device. */}
          {!legendDismissed && group.members.some((m) => !m.isOwner && m.status !== 'connected') && (
            <div className="mt-2.5 flex items-center gap-3 rounded-xl bg-white/10 px-3 py-2 animate-fade-in">
              <span className="flex items-center gap-1.5 text-[9.5px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-receive-600/70" />
                {t('member_on_app')}
              </span>
              <span className="flex items-center gap-1.5 text-[9.5px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-warn-600/70" />
                {t('member_invited')}
              </span>
              <span className="flex items-center gap-1.5 text-[9.5px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-white/30" />
                {t('member_not_on_app')}
              </span>
              <button
                onClick={dismissLegend}
                className="ml-auto relative -m-2 p-2 text-white/60 active:text-white transition-colors"
                aria-label="Dismiss legend"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body pt-4">

      {/* Archived banner. The server refuses every write in an archived group
          (GROUP_ARCHIVED), so this explains a page whose action bar has gone
          rather than letting the user discover it by tapping. */}
      {isArchived && (
        <div className="px-5 pt-4">
          <div className="rounded-[18px] bg-cream-soft border border-cream-border p-4 flex items-start gap-3 animate-fade-in">
            <div className="w-10 h-10 rounded-2xl bg-cream-card border border-cream-hairline text-ink-500 flex items-center justify-center shrink-0">
              <Lock size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-ink-900 tracking-tight">
                {t('grp_archived_banner_title')}
              </p>
              <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                {t('grp_archived_banner_body')}
              </p>
              {isOwner && (
                <button
                  onClick={() => void handleUnarchive()}
                  disabled={archiving}
                  className="mt-3 rounded-xl bg-ink-900 text-white px-3.5 py-2 text-[11.5px] font-bold flex items-center gap-1.5 disabled:opacity-40 press"
                >
                  <ArchiveRestore size={12} strokeWidth={2.4} /> {t('grp_unarchive_action')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The join code is dead weight on an archived group — nobody new can
          join one (tg_block_join_archived_group), definer RPCs included. */}
      {!isArchived && group.joinCode && (() => {
        // When the owner is the only connected person, the group code card
        // becomes the primary activation surface — bigger, louder, with an
        // explicit "why you're seeing this" headline. Once others have
        // joined, it compacts back into the quiet reference card.
        const connectedCount = group.members.filter(m => m.status === 'connected').length;
        const isSolo = connectedCount <= 1;
        const copyCode = async () => {
          if (!group.joinCode) return;
          await navigator.clipboard.writeText(group.joinCode);
          toast.show({ type: 'success', title: 'Code copied', subtitle: 'Share it so others can join.' });
        };

        if (isSolo) {
          return (
            <div className="px-5 pt-4">
              <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 animate-fade-in">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-100 to-purple-100 text-accent-600 flex items-center justify-center shrink-0">
                    <Sparkles size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-ink-900 tracking-tight">
                      {t('group_solo_invite_title')}
                    </p>
                    <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                      {t('group_solo_invite_body')}
                    </p>
                  </div>
                </div>
                <div className="mt-3.5 flex items-center gap-2.5 bg-cream-soft rounded-2xl px-3.5 py-2.5 border border-cream-border">
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-bold font-mono tracking-tight text-ink-900 truncate">
                      {group.joinCode}
                    </p>
                    {joinCodeExpiryLabel && (
                      <p className={`text-[10px] mt-0.5 font-semibold ${joinCodeExpired ? 'text-pay-text' : 'text-ink-500'}`}>
                        {joinCodeExpiryLabel}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={copyCode}
                    className="shrink-0 rounded-xl bg-ink-900 text-white text-white px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/20"
                  >
                    <Copy size={11} strokeWidth={2.5} /> Copy
                  </button>
                </div>
                {isOwner && (
                  <button
                    onClick={() => void handleRefreshJoinCode()}
                    disabled={refreshingCode}
                    className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent-600 active:opacity-60 disabled:opacity-40 min-h-[36px]"
                  >
                    <RefreshCw size={12} className={refreshingCode ? 'animate-spin' : ''} />
                    {t('grp_code_refresh')}
                  </button>
                )}
              </div>
            </div>
          );
        }

        return (
          <div className="px-5 pt-4">
            <div className="rounded-[18px] bg-cream-card border border-cream-border p-3.5 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
                <Share2 size={16} className="text-accent-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">Group Code</p>
                <p className="text-[15px] font-bold text-ink-900 font-mono tracking-tight">{group.joinCode}</p>
                {joinCodeExpiryLabel && (
                  <p className={`text-[10px] mt-0.5 font-semibold ${joinCodeExpired ? 'text-pay-text' : 'text-ink-500'}`}>
                    {joinCodeExpiryLabel}
                  </p>
                )}
              </div>
              {isOwner && (
                <button
                  onClick={() => void handleRefreshJoinCode()}
                  disabled={refreshingCode}
                  className="shrink-0 rounded-xl bg-cream-card border border-cream-border text-ink-700 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 active:scale-95 transition-all disabled:opacity-40"
                  aria-label={t('grp_code_refresh')}
                  title={t('grp_code_refresh')}
                >
                  <RefreshCw size={12} className={refreshingCode ? 'animate-spin' : ''} />
                </button>
              )}
              <button
                onClick={copyCode}
                className="shrink-0 rounded-xl bg-cream-card border border-cream-border text-ink-700 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 active:scale-95 transition-all"
              >
                <Copy size={12} /> Copy
              </button>
            </div>
          </div>
        );
      })()}

      {/* Group health — total spend on the left, settled-% ring on the right.
          Always present once there's any activity so users have an at-a-glance
          sense of how far from "fully settled" the group is. */}
      {tab !== 'activity' && totalSpend > 0 && (
        <div className="px-5 pt-4">
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">Group spend</p>
              <p className="text-[22px] font-extrabold text-ink-900 tabular-nums tracking-tight mt-0.5 leading-tight">
                {formatMoney(totalSpend, group.currency)}
              </p>
              <p className="text-[11px] text-ink-500 mt-0.5">
                {totalOutstanding === 0 ? (
                  <span className="text-receive-text font-semibold inline-flex items-center gap-1">
                    <VerifiedBadge size={13} title={t('group_settled')} /> {t('group_settled')}
                  </span>
                ) : (
                  <>
                    <span className="text-pay-text font-semibold">{formatMoney(totalOutstanding, group.currency)}</span>
                    <span> outstanding</span>
                  </>
                )}
                <span className="mx-1.5">·</span>{expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}
              </p>
            </div>
            <ProgressRing
              size={56}
              strokeWidth={5}
              progress={settledRatio}
              color={totalOutstanding === 0 ? '#10b981' : '#6366f1'}
              trackColor="#f1f5f9"
            >
              <span className={`text-[11px] font-extrabold tabular-nums ${
                totalOutstanding === 0 ? 'text-receive-text' : 'text-accent-600'
              }`}>
                {settledPct}%
              </span>
            </ProgressRing>
          </div>
        </div>
      )}

      {shownDebts.length > 0 && tab !== 'activity' && (
        <div className="px-5 pt-3">
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 space-y-2.5">
            <div className="flex items-center justify-between pb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-ink-400">
                {simplify ? 'Simplified' : 'Who owes whom'}
              </span>
              <button
                onClick={() => setSimplify((v) => !v)}
                className="text-[10.5px] font-semibold text-accent-600 active:opacity-60"
              >
                {simplify ? 'Show direct' : 'Simplify debts'}
              </button>
            </div>
            {[...shownDebts]
              // Float debts involving "you" to the top — that's what the user
              // most likely came here to act on.
              .map((debt, originalIndex) => ({ debt, originalIndex }))
              .sort((a, b) => {
                const aMe = a.debt.from === currentMember?.id || a.debt.to === currentMember?.id;
                const bMe = b.debt.from === currentMember?.id || b.debt.to === currentMember?.id;
                if (aMe === bMe) return a.originalIndex - b.originalIndex;
                return aMe ? -1 : 1;
              })
              .map(({ debt, originalIndex }) => {
                const fromIsMe = debt.from === currentMember?.id;
                const toIsMe = debt.to === currentMember?.id;
                return (
                  <div key={`${debt.from}-${debt.to}-${originalIndex}`} className="flex items-center justify-between">
                    <p className="text-[12px] text-ink-600">
                      <span className={`font-bold ${fromIsMe ? 'text-accent-600' : 'text-pay-text'}`}>
                        {fromIsMe ? t('label_you') : debt.fromName}
                      </span>
                      {' '}{t('group_owes')}{' '}
                      <span className={`font-bold ${toIsMe ? 'text-accent-600' : 'text-receive-text'}`}>
                        {toIsMe ? t('label_you') : debt.toName}
                      </span>
                    </p>
                    <p className="text-[13px] font-bold text-ink-900 tabular-nums">{formatMoney(debt.amount, group.currency)}</p>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="flex gap-2 px-5 pt-5">
        {(['expenses', 'balances', 'activity'] as const).map(nextTab => (
          <button
            key={nextTab}
            onClick={() => setTab(nextTab)}
            className={`px-4 py-2 rounded-xl text-[12px] font-bold transition-all ${tab === nextTab ? 'bg-ink-900 text-white' : 'bg-cream-card text-ink-500 border border-cream-border'}`}
          >
            {nextTab === 'expenses' ? t('group_expenses') : nextTab === 'balances' ? t('group_balances') : 'Activity'}
          </button>
        ))}
      </div>

      {tab === 'expenses' ? (
        <div className="px-5 pt-4 space-y-2">
          {expenses.length === 0 ? (
            // An archived group with no expenses has nothing to activate —
            // every "add" path is refused server-side, so a CTA would be a
            // dead end. The archived banner above already explains the state.
            isArchived ? (
              <div className="rounded-[18px] bg-cream-card border border-cream-border p-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-cream-soft border border-cream-hairline text-ink-500 mx-auto flex items-center justify-center">
                  <Receipt size={22} />
                </div>
                <p className="text-[13px] font-semibold text-ink-800 mt-3">{t('grp_archived_banner_title')}</p>
              </div>
            ) :
            // Activation card — strong CTA instead of a passive "no expenses"
            // line. When the owner is still alone, a split isn't possible yet
            // (expenses can only involve connected members), so point them at
            // inviting first instead of an "Add expense" button that opens a
            // modal they can't meaningfully complete.
            group.members.filter(m => m.status === 'connected').length <= 1 ? (
              <div className="rounded-[18px] bg-cream-card border border-cream-border p-6 text-center animate-fade-in">
                <div className="mx-auto w-14 h-14 rounded-3xl bg-gradient-to-br from-indigo-50 to-purple-50 text-accent-600 flex items-center justify-center">
                  <UserPlus size={24} strokeWidth={1.8} />
                </div>
                <p className="text-[15px] font-bold text-ink-900 tracking-tight mt-4">
                  {t('group_first_invite_title')}
                </p>
                <p className="text-[12px] text-ink-500 mt-1.5 leading-relaxed max-w-[260px] mx-auto">
                  {t('group_first_invite_body')}
                </p>
                <button
                  onClick={async () => {
                    if (!group.joinCode) return;
                    await navigator.clipboard.writeText(group.joinCode);
                    toast.show({ type: 'success', title: t('group_code_copied'), subtitle: t('group_code_copied_sub') });
                  }}
                  className="mt-5 w-full rounded-2xl py-3 text-[13px] font-bold bg-ink-900 text-white shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
                >
                  <Copy size={14} strokeWidth={2.5} /> {t('group_first_invite_cta')}
                </button>
              </div>
            ) : (
            <div className="rounded-[18px] bg-cream-card border border-cream-border p-6 text-center animate-fade-in">
              <div className="mx-auto w-14 h-14 rounded-3xl bg-gradient-to-br from-indigo-50 to-purple-50 text-accent-600 flex items-center justify-center">
                <Receipt size={24} strokeWidth={1.8} />
              </div>
              <p className="text-[15px] font-bold text-ink-900 tracking-tight mt-4">
                {t('group_first_expense_title')}
              </p>
              <p className="text-[12px] text-ink-500 mt-1.5 leading-relaxed max-w-[260px] mx-auto">
                {t('group_first_expense_body')}
              </p>
              <button
                onClick={() => setShowAddExpense(true)}
                className="mt-5 w-full rounded-2xl py-3 text-[13px] font-bold bg-ink-900 text-white shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
              >
                <Plus size={14} strokeWidth={2.5} /> {t('group_first_expense_cta')}
              </button>
            </div>
            )
          ) : (
            expenses.map((expense, index) => {
              const meta = getExpenseMeta(expense);
              const canReconcile = isPaidByCurrentUser(expense);
              const isReconciled = expense.isReconciled ?? false;
              return (
                <div
                  key={expense.id}
                  onClick={() => setEditExpense(expense)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setEditExpense(expense);
                    }
                  }}
                  className="w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 animate-fade-in active:scale-[0.98] transition-all cursor-pointer"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div className="flex items-center justify-between gap-3">
                    {/* Reconcile button. Using `aria-disabled` instead of the
                        native `disabled` attribute so that even when this
                        button can't act (non-payer / saving), the onClick
                        still fires and stopPropagation prevents the outer
                        card click from opening the edit modal. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!canReconcile || savingReconciliationId === expense.id) return;
                        void handleGroupExpenseReconcile(expense);
                      }}
                      aria-pressed={isReconciled}
                      aria-disabled={!canReconcile || savingReconciliationId === expense.id}
                      aria-label={
                        canReconcile
                          ? isReconciled ? 'Mark expense unreconciled' : 'Mark expense reconciled'
                          : isReconciled ? 'Expense reconciled by payer' : 'Only the payer can reconcile this expense'
                      }
                      title={
                        canReconcile
                          ? isReconciled ? 'Reconciled' : 'Mark reconciled'
                          : isReconciled ? 'Reconciled by payer' : 'Only the payer can reconcile'
                      }
                      className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 transition-all active:scale-95 ${
                        isReconciled
                          ? 'bg-receive-600 border-receive-600 text-white'
                          : canReconcile
                            ? 'bg-cream-card border-cream-border text-transparent hover:border-receive-600'
                            : 'bg-cream-soft border-cream-hairline text-transparent opacity-50 cursor-default'
                      }`}
                    >
                      <Check size={14} strokeWidth={3} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="text-[13px] font-semibold text-ink-900 truncate">{expense.description}</p>
                        {(expense.version ?? 1) > 1 ? (
                          <span
                            className="h-2.5 w-2.5 rounded-full bg-warn-600 ring-2 ring-warn-50 shrink-0"
                            aria-label="Edited expense"
                            title="Edited"
                          />
                        ) : null}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-info-50 px-2 py-1 text-[10px] font-semibold leading-none text-info-600 ring-1 ring-info-50">
                          {t('group_paid_by_short')} <span className="font-extrabold">{meta.paidBy}</span>
                        </span>
                        <span className="rounded-full bg-warn-50 px-2 py-1 text-[10px] font-semibold leading-none text-warn-600 ring-1 ring-warn-50">
                          {t('group_split_short')} <span className="font-extrabold">{meta.split}</span>
                        </span>
                        <span className="rounded-full bg-receive-50 px-2 py-1 text-[10px] font-semibold leading-none text-receive-text ring-1 ring-receive-100">
                          {t('group_your_share_short')} <span className="font-extrabold tabular-nums">{meta.share}</span>
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[14px] font-bold text-ink-900 tabular-nums">{formatMoney(expense.amount, group.currency)}</p>
                      <p className="text-[9px] text-ink-500">{new Date(expense.date).toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : tab === 'balances' ? (
        <div className="px-5 pt-4 pb-44 space-y-2">
          {shownDebts.length > 0 && (
            <button
              onClick={() => setShowSettleShare(true)}
              className="w-full rounded-2xl bg-accent-100 text-accent-600 py-3 text-[13px] font-bold flex items-center justify-center gap-2 press"
            >
              <Share2 size={14} strokeWidth={2.2} /> {t('gsu_cta')}
            </button>
          )}
          {balanceRows.length === 0 ? (
            <div className="rounded-[18px] bg-cream-card border border-cream-border p-6 text-center animate-fade-in">
              <div className="w-12 h-12 rounded-2xl bg-cream-soft border border-cream-hairline text-ink-500 mx-auto flex items-center justify-center">
                <Receipt size={22} />
              </div>
              <p className="text-sm font-semibold text-ink-800 mt-3">No balances yet</p>
              <p className="text-[12px] text-ink-500 mt-1">Add an expense to see paid, share, and final balance for each member.</p>
            </div>
          ) : balanceRows.map(({ member, paid, share, net }, index) => {
            const ringProgress = Math.abs(net) / maxAbs;
            const isPositive = net > 0.01;
            const isNegative = net < -0.01;
            const ringColor = isPositive ? '#10b981' : isNegative ? '#f43f5e' : '#cbd5e1';
            return (
              <div
                key={member.id}
                className="rounded-[18px] bg-cream-card border border-cream-border p-4 animate-fade-in"
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 ${memberStatusClass(member.status, member.isOwner)}`}>
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink-800 truncate">{member.name}</p>
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        {memberStatusLabel(t, member.status, member.isOwner)}
                        {member.id === currentMember?.id ? <span className="font-semibold text-accent-600"> · you</span> : null}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      {isPositive ? (
                        <>
                          <p className="text-[10px] text-receive-text font-bold uppercase tracking-wide">Gets back</p>
                          <p className="text-[13px] font-extrabold text-receive-text tabular-nums">+{formatMoney(net, group.currency)}</p>
                        </>
                      ) : isNegative ? (
                        <>
                          <p className="text-[10px] text-pay-text font-bold uppercase tracking-wide">Has to pay</p>
                          <p className="text-[13px] font-extrabold text-pay-text tabular-nums">-{formatMoney(Math.abs(net), group.currency)}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-[10px] text-ink-500 font-bold uppercase tracking-wide">Balance</p>
                          <p className="text-[11px] text-ink-500">{t('group_settled')}</p>
                        </>
                      )}
                    </div>
                    <ProgressRing
                      size={38}
                      strokeWidth={3}
                      progress={ringProgress}
                      color={ringColor}
                      trackColor="#f1f5f9"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2">
                    <p className="text-[9px] font-bold text-ink-500 uppercase tracking-widest">Paid total</p>
                    <p className="text-[12px] font-bold text-ink-800 tabular-nums mt-0.5">{formatMoney(paid, group.currency)}</p>
                  </div>
                  <div className="rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2">
                    <p className="text-[9px] font-bold text-ink-500 uppercase tracking-widest">Share total</p>
                    <p className="text-[12px] font-bold text-ink-800 tabular-nums mt-0.5">{formatMoney(share, group.currency)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-5 pt-4 space-y-2">
          {events.length === 0 ? (
            <div className="rounded-[18px] bg-cream-card border border-cream-border p-6 text-center">
              <div className="w-12 h-12 rounded-2xl bg-cream-soft border border-cream-hairline text-ink-500 mx-auto flex items-center justify-center">
                <Clock3 size={22} />
              </div>
              <p className="text-sm font-semibold text-ink-800 mt-3">No shared activity yet</p>
              <p className="text-[12px] text-ink-500 mt-1">Adds, edits, deletes, joins, and settlements will appear here for everyone.</p>
            </div>
          ) : (
            events.map((event, index) => {
              const display = getActivityDisplay(event, settlements, group, t);
              return (
                <div
                  key={event.id}
                  className="rounded-[18px] bg-cream-card border border-cream-border p-4 animate-fade-in"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${display.iconBg}`}>
                      {display.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <p className={`text-[13px] font-bold text-ink-900 leading-snug ${display.titleClass ?? ''}`}>
                          {display.title}
                        </p>
                        {display.amount && (
                          <p className={`text-[14px] font-extrabold tabular-nums shrink-0 ${display.amountClass ?? 'text-ink-900'}`}>
                            {display.amount}
                          </p>
                        )}
                      </div>
                      {display.subtitle && (
                        <p className="text-[11px] font-medium text-ink-600 mt-0.5">{display.subtitle}</p>
                      )}
                      {display.amountChange && (
                        <p className="text-[11px] text-ink-500 tabular-nums mt-1">{display.amountChange}</p>
                      )}
                      {display.note && (
                        <p className="text-[11px] text-ink-500 mt-1.5 italic break-words">“{display.note}”</p>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <p className="text-[10px] font-semibold text-ink-400 tabular-nums tracking-wide">
                          {formatActivityTime(event.createdAt)}
                        </p>
                        {/* A wrong settle-up (wrong row, double-record from two
                            phones) used to be permanent — the recorder can now
                            remove it and balances recalculate. */}
                        {event.eventType === 'settlement_added' &&
                          (() => {
                            const settlement = settlements.find((s) => s.id === event.entityId);
                            if (!settlement) return null;
                            if (settlement.createdBy && settlement.createdBy !== currentUserId) return null;
                            return (
                              <button
                                type="button"
                                onClick={() => void handleRemoveSettlement(settlement)}
                                className="text-[10px] font-semibold text-pay-text active:opacity-70 flex items-center gap-1"
                              >
                                <Trash2 size={10} /> {t('stl_remove_cta')}
                              </button>
                            );
                          })()}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Floating action bar — sits just above the BottomNav FAB. Sized
          to match the navy hero TopBar action chips: 36px tall, 12px text,
          rounded-xl. Two-button layout: Add Expense (primary ink-900,
          flex-1) and Settle Up (receive-600, content-width). */}
      {/* Hidden while archived: tg_block_writes_in_archived_group refuses both
          an expense insert and a settlement insert, so offering the buttons
          would only produce a raw GROUP_ARCHIVED error. */}
      {!isArchived && (
      <div className="fixed bottom-[92px] left-0 right-0 px-5 z-30 pointer-events-none">
        <div className="flex gap-2 max-w-[480px] mx-auto pointer-events-auto">
          <button
            onClick={() => setShowAddExpense(true)}
            className="flex-1 h-10 bg-ink-900 text-white rounded-xl text-[12.5px] font-semibold flex items-center justify-center gap-1.5 shadow-lg shadow-navy-900/20 press"
          >
            <Plus size={13} strokeWidth={2.4} /> {t('group_expense_add')}
          </button>
          <button
            onClick={() => setShowSettle(true)}
            className="h-10 px-3.5 rounded-xl text-[12.5px] font-semibold bg-receive-600 text-white flex items-center justify-center gap-1.5 shadow-lg shadow-navy-900/20 press"
          >
            <Handshake size={13} strokeWidth={2.4} /> {t('group_settle')}
          </button>
        </div>
      </div>
      )}

      </div>

      <AddGroupExpenseModal open={showAddExpense} group={group} recentExpenses={expenses} onClose={() => { setShowAddExpense(false); void reload(); }} />
      <EditGroupExpenseModal open={!!editExpense} group={group} expense={editExpense} onClose={() => { setEditExpense(null); void reload(); }} />
      <SettleUpModal open={showSettle} group={group} debts={shownDebts} currentMemberId={currentMember?.id} onClose={() => { setShowSettle(false); void reload(); }} />
      <GroupSettleUpModal open={showSettleShare} group={group} debts={shownDebts} expenses={expenses} simplify={simplify} currentMemberId={currentMember?.id} onClose={() => setShowSettleShare(false)} />
      <GroupInviteModal open={showInvite} group={group} onClose={() => { setShowInvite(false); void reload(); }} />

      {/* Ownership handover — the escape hatch for delete_current_user's
          OWNED_GROUPS_WITH_MEMBERS refusal and for leave_group's
          ONLY_OWNER_ADMIN. Only connected, profile-linked members are offered,
          which is exactly the RPC's own INVALID_NEW_OWNER filter. */}
      <Modal
        open={showTransfer}
        onClose={() => setShowTransfer(false)}
        title={t('grp_transfer_title')}
      >
        <div className="p-5 space-y-3">
          <p className="text-[12px] text-ink-500 leading-relaxed">{t('grp_transfer_body')}</p>
          {transferCandidates.length === 0 ? (
            <p className="text-[12px] text-ink-400 text-center py-6">{t('grp_transfer_none')}</p>
          ) : (
            <div className="space-y-2">
              {transferCandidates.map((member) => (
                <button
                  key={member.id}
                  onClick={() => void handleTransferOwnership(member.id)}
                  disabled={transferringMemberId !== null}
                  className="w-full rounded-2xl bg-cream-card border border-cream-border p-3 flex items-center gap-3 text-left disabled:opacity-40 press"
                >
                  <div className="w-10 h-10 rounded-full bg-cream-soft text-ink-700 flex items-center justify-center text-[12px] font-bold shrink-0">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink-800 truncate">{member.name}</p>
                    <p className="text-[10px] text-ink-500 mt-0.5">{t('member_on_app')}</p>
                  </div>
                  <Crown size={14} className="text-ink-400 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </main>
  );
}
