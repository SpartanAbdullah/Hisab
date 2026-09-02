import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, LogIn, Users, Receipt, Scale, HandCoins, KeyRound, Search, X, Mail, Archive } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { GroupCard } from '../components/GroupCard';
import { PageErrorState } from '../components/PageErrorState';
import { NextStepHint } from '../components/NextStepHint';
import { CreateGroupModal } from './CreateGroupModal';
import { JoinGroupModal } from './JoinGroupModal';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';

function GroupsListSkeleton() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3"
        >
          <div className="w-11 h-11 rounded-2xl bg-cream-soft animate-pulse shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-32 rounded-full bg-cream-hairline animate-pulse" />
            <div className="h-2.5 w-20 rounded-full bg-cream-hairline animate-pulse" />
          </div>
          <div className="h-3.5 w-14 rounded-full bg-cream-hairline animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// Onboarding card for users with zero groups. Re-skinned to the Sukoon
// cream-card pattern; copy unchanged.
function GroupsEducationCard() {
  const t = useT();
  const benefits = [
    { icon: Receipt, title: t('groups_edu_split_title'), body: t('groups_edu_split_body') },
    { icon: Scale, title: t('groups_edu_track_title'), body: t('groups_edu_track_body') },
    { icon: HandCoins, title: t('groups_edu_settle_title'), body: t('groups_edu_settle_body') },
  ];
  return (
    <div className="rounded-[18px] bg-cream-card border border-cream-border p-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
          <Users size={18} className="text-accent-600" />
        </div>
        <div className="min-w-0 leading-normal">
          <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
            {t('groups_edu_title')}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5 truncate">
            {t('groups_edu_subtitle')}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {benefits.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
              <Icon size={14} className="text-ink-600" />
            </div>
            <div className="min-w-0 leading-normal">
              <p className="text-[12px] font-semibold text-ink-900 tracking-tight truncate">
                {title}
              </p>
              <p className="text-[11px] text-ink-500 truncate">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-ink-400 mt-3 text-center leading-normal">
        {t('groups_edu_hint')}
      </p>
    </div>
  );
}

// Accept / Decline card for a group the user was added to but has not joined.
// This section is REQUIRED, not a nicety: an 'invited' member fails
// is_group_member(), so the split_groups SELECT policy hides the group row
// entirely (supabase-migration-audit-p0-consent-guards.sql §2.6). Without this
// list — fed by the list_pending_group_memberships RPC, the invitee's only read
// window — the invitation is invisible and undecidable, and the 'invite'
// notification deep-links here for exactly that reason.
function PendingInvitationsSection() {
  const t = useT();
  const toast = useToast();
  const pendingInvitations = useSplitStore((s) => s.pendingInvitations);
  const acceptGroupMembership = useSplitStore((s) => s.acceptGroupMembership);
  const declineGroupMembership = useSplitStore((s) => s.declineGroupMembership);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  if (pendingInvitations.length === 0) return null;

  const handleAccept = async (groupId: string) => {
    if (busyGroupId) return;
    setBusyGroupId(groupId);
    try {
      const result = await acceptGroupMembership(groupId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('ginv_accepted') : t('ginv_accept_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('ginv_accept_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleDecline = async (groupId: string) => {
    if (busyGroupId) return;
    const ok = await confirmDestructive({
      title: t('ginv_decline_confirm_title'),
      description: t('ginv_decline_confirm_body'),
      confirmLabel: t('ginv_decline'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyGroupId(groupId);
    try {
      const result = await declineGroupMembership(groupId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('ginv_declined') : t('ginv_decline_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('ginv_decline_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyGroupId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2.5 px-1">
        <Mail size={12} className="text-warn-600" />
        <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
          {t('ginv_pending_heading')}
        </h2>
        <span className="text-[11px] text-ink-400 font-semibold tabular-nums ml-auto">
          {pendingInvitations.length}
        </span>
      </div>
      <div className="space-y-2.5">
        {pendingInvitations.map((invitation) => (
          <div
            key={invitation.groupId}
            className="rounded-[18px] bg-cream-card border border-warn-100 p-4 animate-fade-in"
          >
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-warn-50 border border-warn-100 flex items-center justify-center text-lg shrink-0">
                {invitation.groupEmoji || '👥'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
                  {invitation.groupName}
                </p>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  {t('ginv_pending_sub').replace('{name}', invitation.invitedByName)}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void handleAccept(invitation.groupId)}
                disabled={busyGroupId !== null}
                className="flex-1 rounded-[14px] bg-ink-900 text-white px-4 py-2.5 text-[12.5px] font-semibold disabled:opacity-40 press"
              >
                {t('ginv_accept')}
              </button>
              <button
                onClick={() => void handleDecline(invitation.groupId)}
                disabled={busyGroupId !== null}
                className="rounded-[14px] bg-cream-soft border border-cream-border text-ink-700 px-4 py-2.5 text-[12.5px] font-semibold disabled:opacity-40 press"
              >
                {t('ginv_decline')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SplitsPage() {
  const { groups, loadGroups, balances, balancesLoaded, loadBalances, unreconciledFlags, loadUnreconciledFlags, loadPendingInvitations } = useSplitStore();
  const { notifications, loadNotifications } = useNotificationStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();
  const t = useT();
  const primaryCurrency = localStorage.getItem('hisaab_primary_currency') ?? 'AED';
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';

  const load = useCallback(async () => {
    await Promise.all([loadGroups(), loadNotifications()]);
    void loadBalances();
    void loadUnreconciledFlags(currentUserId);
    void loadPendingInvitations();
  }, [loadGroups, loadNotifications, loadBalances, loadUnreconciledFlags, loadPendingInvitations, currentUserId]);

  const { status, error, retry } = useAsyncLoad(load);

  useEffect(() => {
    if (groups.length > 0) {
      void loadBalances();
      void loadUnreconciledFlags(currentUserId);
    }
  }, [groups, loadBalances, loadUnreconciledFlags, currentUserId]);

  useEffect(() => {
    const onFocus = () => {
      void loadNotifications();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadNotifications]);

  const hasGroups = groups.length > 0;
  const isInitialLoading = status === 'loading' && !hasGroups;
  const showEducation = status === 'ready' && !hasGroups;
  const unreadGroupIds = new Set(
    notifications
      .filter(
        (notification) =>
          notification.type === 'group_update' &&
          notification.groupId &&
          !notification.readAt,
      )
      .map((notification) => notification.groupId as string),
  );

  // "Across all groups" net — sum of primary-currency group balances. Groups
  // in non-primary currencies are reflected as a small "+ X others" note
  // below the headline so the hero number stays unambiguous.
  const primaryNet = groups
    .filter((g) => g.currency === primaryCurrency)
    .reduce((acc, g) => acc + (balances[g.id] ?? 0), 0);
  const otherCcyGroups = groups.filter((g) => g.currency !== primaryCurrency);
  const q = searchQuery.trim().toLowerCase();
  const matchingGroups = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q))
    : groups;
  // Archived groups stay fully readable but accept nothing new, so they must
  // not sit among the live ones competing for attention. They get their own
  // collapsed section below (group-deletion-guard.sql §3).
  const visibleGroups = matchingGroups.filter((g) => !g.archivedAt);
  const archivedGroups = matchingGroups.filter((g) => Boolean(g.archivedAt));

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('groups_title')}
          action={
            // Compact icon-only action row. Previously "Join code" carried
            // a text label which on narrow Android screens squeezed the
            // page title (flex-1 + truncate) down to almost nothing,
            // making the actions appear to overlap the heading.
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Search"
              >
                <Search size={15} className="text-white" />
              </button>
              <button
                onClick={() => setShowJoin(true)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Join with code"
                title="Join with code"
              >
                <KeyRound size={14} className="text-white" strokeWidth={2.2} />
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Create group"
              >
                <Plus size={15} className="text-white" strokeWidth={2.4} />
              </button>
            </div>
          }
        />

        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            Across all groups · {primaryCurrency}
          </p>
          {hasGroups ? (
            <>
              <div className="mt-1.5">
                <MoneyDisplay
                  amount={primaryNet}
                  currency={primaryCurrency}
                  size={36}
                  tone="on-navy"
                  signed
                />
              </div>
              <p className="text-[12px] text-white/55 mt-2">
                {groups.length} {groups.length === 1 ? 'split' : 'splits'}
                {otherCcyGroups.length > 0 && (
                  <> · +{otherCcyGroups.length} in other currencies</>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
                No splits yet
              </p>
              <p className="text-[12px] text-white/55 mt-1.5 max-w-[260px] leading-relaxed">
                Create one to split expenses with friends, or join one with a code.
              </p>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {showSearch && (
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search groups"
              className="w-full bg-cream-card border border-cream-border rounded-2xl pl-10 pr-10 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-400 press-xs"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('groups_load_error_title')}
            message={error ?? t('groups_load_error_msg')}
            onRetry={retry}
          />
        )}

        {/* Primary action buttons when groups exist — visible but not headline.
            For empty state the GroupsEducationCard carries the explanation. */}
        {hasGroups && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-[14px] bg-ink-900 text-white px-4 py-3 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold press"
            >
              <Plus size={13} strokeWidth={2.4} /> {t('groups_action_create_title')}
            </button>
            <button
              onClick={() => setShowJoin(true)}
              className="rounded-[14px] bg-cream-card border border-cream-border text-ink-800 px-4 py-3 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold press"
            >
              <LogIn size={13} strokeWidth={2.4} /> {t('groups_action_join_title')}
            </button>
          </div>
        )}

        {status === 'ready' && hasGroups && (
          <NextStepHint
            icon={primaryNet === 0 ? Scale : HandCoins}
            tone={primaryNet > 0 ? 'receive' : primaryNet < 0 ? 'pay' : 'info'}
            status={
              q
                ? `${visibleGroups.length} group${visibleGroups.length === 1 ? '' : 's'} match your search.`
                : primaryNet === 0
                ? 'Your primary-currency groups are settled.'
                : primaryNet > 0
                ? `Across groups, you should receive ${formatMoney(primaryNet, primaryCurrency)}.`
                : `Across groups, you should pay ${formatMoney(Math.abs(primaryNet), primaryCurrency)}.`
            }
            next={
              q
                ? 'Clear search to see every split again.'
                : 'Open any group to add an expense, reconcile activity, or settle the balance.'
            }
            actionLabel={q ? 'Clear search' : undefined}
            onAction={q ? () => setSearchQuery('') : undefined}
          />
        )}

        {isInitialLoading && <GroupsListSkeleton />}

        <PendingInvitationsSection />

        {/* When every remaining group is archived, the archived section below
            carries the list — showing an empty "no matches" above it would be
            a lie. */}
        {hasGroups && (visibleGroups.length > 0 || archivedGroups.length === 0) && (() => {
          return (
            <div>
              <div className="flex items-center justify-between mb-2.5 px-1">
                <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  {t('groups_list_heading')}
                </h2>
                <span className="text-[11px] text-ink-400 font-semibold tabular-nums">
                  {visibleGroups.length}
                </span>
              </div>
              {visibleGroups.length === 0 ? (
                <p className="text-[12px] text-ink-400 text-center py-6">
                  No matches for "{searchQuery}"
                </p>
              ) : (
                <div className="space-y-2.5">
                  {visibleGroups.map((g) => {
                    // Outstanding count from this user's per-group net: a
                    // non-zero balance means one balance still to settle in
                    // that group. Reuses the already-loaded balances map so
                    // there's no extra fetch.
                    const groupBalance = balances[g.id] ?? 0;
                    const outstandingCount = Math.abs(groupBalance) > 0.01 ? 1 : 0;
                    return (
                      <GroupCard
                        key={g.id}
                        group={g}
                        balance={groupBalance}
                        balanceLoaded={balancesLoaded}
                        settledLabel={t('group_settled')}
                        membersLabel={t('group_members_count')}
                        hasUnreadActivity={unreadGroupIds.has(g.id)}
                        hasUnreconciled={Boolean(unreconciledFlags[g.id])}
                        outstandingCount={outstandingCount}
                        onClick={() => navigate(`/group/${g.id}`)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {archivedGroups.length > 0 && (
          <div>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="w-full flex items-center gap-1.5 mb-2.5 px-1 text-left"
              aria-expanded={showArchived}
            >
              <Archive size={12} className="text-ink-400" />
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t('grp_archived_section')}
              </h2>
              <span className="text-[11px] text-ink-400 font-semibold tabular-nums ml-auto">
                {archivedGroups.length}
              </span>
            </button>
            {showArchived && (
              <div className="space-y-2.5">
                {archivedGroups.map((g) => {
                  const groupBalance = balances[g.id] ?? 0;
                  return (
                    <GroupCard
                      key={g.id}
                      group={g}
                      balance={groupBalance}
                      balanceLoaded={balancesLoaded}
                      settledLabel={t('group_settled')}
                      membersLabel={t('group_members_count')}
                      hasUnreadActivity={unreadGroupIds.has(g.id)}
                      hasUnreconciled={Boolean(unreconciledFlags[g.id])}
                      outstandingCount={Math.abs(groupBalance) > 0.01 ? 1 : 0}
                      onClick={() => navigate(`/group/${g.id}`)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {showEducation && <GroupsEducationCard />}
      </div>

      <CreateGroupModal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          void loadGroups();
        }}
      />
      <JoinGroupModal
        open={showJoin}
        onClose={() => {
          setShowJoin(false);
          void loadGroups();
        }}
      />
    </main>
  );
}
