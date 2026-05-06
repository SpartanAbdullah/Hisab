import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  LogIn,
  Users,
  Receipt,
  Scale,
  HandCoins,
} from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { ActionCard } from '../components/ActionCard';
import { GroupCard } from '../components/GroupCard';
import { PageErrorState } from '../components/PageErrorState';
import { CreateGroupModal } from './CreateGroupModal';
import { JoinGroupModal } from './JoinGroupModal';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

function GroupsListSkeleton() {
  return (
    <div className="px-5 pt-6 space-y-2.5">
      <div className="h-3 w-24 rounded-full bg-slate-100 animate-pulse mb-3" />
      {[0, 1, 2].map(i => (
        <div key={i} className="card-premium p-4 flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 animate-pulse shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-32 rounded-full bg-slate-100 animate-pulse" />
            <div className="h-2.5 w-20 rounded-full bg-slate-100 animate-pulse" />
          </div>
          <div className="h-3.5 w-14 rounded-full bg-slate-100 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// Education block for users with zero groups. Intentionally does NOT repeat
// Create/Join buttons — those already sit above as ActionCards. Having one
// obvious place to start avoids the "two doors to the same room" confusion
// the old design caused.
function GroupsEducationCard() {
  const t = useT();
  const benefits = [
    { icon: Receipt, title: t('groups_edu_split_title'), body: t('groups_edu_split_body') },
    { icon: Scale, title: t('groups_edu_track_title'), body: t('groups_edu_track_body') },
    { icon: HandCoins, title: t('groups_edu_settle_title'), body: t('groups_edu_settle_body') },
  ];
  return (
    <div className="px-5 pt-5">
      <div className="card-premium p-4 rounded-2xl ring-1 ring-indigo-100/50 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center shrink-0">
            <Users size={18} className="text-indigo-600" />
          </div>
          <div className="min-w-0 leading-normal">
            <p className="text-sm font-semibold text-slate-800 tracking-tight truncate">
              {t('groups_edu_title')}
            </p>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {t('groups_edu_subtitle')}
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {benefits.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-slate-50 flex items-center justify-center shrink-0">
                <Icon size={14} className="text-slate-500" />
              </div>
              <div className="min-w-0 leading-normal">
                <p className="text-xs font-semibold text-slate-700 tracking-tight truncate">{title}</p>
                <p className="text-[11px] text-slate-400 truncate">{body}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-slate-400 mt-3 text-center leading-normal">
          {t('groups_edu_hint')}
        </p>
      </div>
    </div>
  );
}

export function SplitsPage() {
  const { groups, loadGroups, balances, balancesLoaded, loadBalances } = useSplitStore();
  const { notifications, loadNotifications } = useNotificationStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const navigate = useNavigate();
  const t = useT();

  // Block page rendering only on the group list load — balances load in the
  // background and have their own per-card skeleton, so a slow balance query
  // never stalls the whole page.
  const load = useCallback(async () => {
    await Promise.all([loadGroups(), loadNotifications()]);
    void loadBalances();
  }, [loadGroups, loadNotifications, loadBalances]);

  const { status, error, retry } = useAsyncLoad(load);

  // Refresh balances whenever groups change (realtime join/leave, post-create).
  useEffect(() => {
    if (groups.length > 0) void loadBalances();
  }, [groups, loadBalances]);

  useEffect(() => {
    const onFocus = () => { void loadNotifications(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadNotifications]);

  const hasGroups = groups.length > 0;
  const isInitialLoading = status === 'loading' && !hasGroups;
  const showEducation = status === 'ready' && !hasGroups;
  const unreadGroupIds = new Set(
    notifications
      .filter(notification => notification.type === 'group_update' && notification.groupId && !notification.readAt)
      .map(notification => notification.groupId as string),
  );

  return (
    <div className="page-shell">
      <PageHeader
        title={t('groups_title')}
        action={<LanguageToggle />}
      />

      {/* Primary action cards — always visible, the single source of truth
          for "add something". Header no longer carries duplicate chips. */}
      <div className="px-5 pt-5">
        <div className="grid grid-cols-2 gap-2.5">
          <ActionCard
            icon={Plus}
            title={t('groups_action_create_title')}
            subtitle={t('groups_action_create_sub')}
            variant="primary"
            onClick={() => setShowCreate(true)}
          />
          <ActionCard
            icon={LogIn}
            title={t('groups_action_join_title')}
            subtitle={t('groups_action_join_sub')}
            variant="secondary"
            onClick={() => setShowJoin(true)}
          />
        </div>
      </div>

      {status === 'error' && (
        <div className="px-5 pt-4">
          <PageErrorState
            variant="inline"
            title={t('groups_load_error_title')}
            message={error ?? t('groups_load_error_msg')}
            onRetry={retry}
          />
        </div>
      )}

      {isInitialLoading && <GroupsListSkeleton />}

      {hasGroups && (
        <div className="px-5 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
              {t('groups_list_heading')}
            </h2>
            <span className="text-[11px] text-slate-400 font-semibold tabular-nums">
              {groups.length}
            </span>
          </div>
          <div className="space-y-2.5">
            {groups.map((g, i) => (
              <div
                key={g.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <GroupCard
                  group={g}
                  balance={balances[g.id] ?? 0}
                  balanceLoaded={balancesLoaded}
                  settledLabel={t('group_settled')}
                  membersLabel={t('group_members_count')}
                  hasUnreadActivity={unreadGroupIds.has(g.id)}
                  onClick={() => navigate(`/group/${g.id}`)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {showEducation && <GroupsEducationCard />}

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
    </div>
  );
}
