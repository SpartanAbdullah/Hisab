import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, LogIn, Users, Receipt, Scale, HandCoins, KeyRound, Search, X } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { GroupCard } from '../components/GroupCard';
import { PageErrorState } from '../components/PageErrorState';
import { CreateGroupModal } from './CreateGroupModal';
import { JoinGroupModal } from './JoinGroupModal';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

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

export function SplitsPage() {
  const { groups, loadGroups, balances, balancesLoaded, loadBalances } = useSplitStore();
  const { notifications, loadNotifications } = useNotificationStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();
  const t = useT();
  const primaryCurrency = localStorage.getItem('hisaab_primary_currency') ?? 'AED';

  const load = useCallback(async () => {
    await Promise.all([loadGroups(), loadNotifications()]);
    void loadBalances();
  }, [loadGroups, loadNotifications, loadBalances]);

  const { status, error, retry } = useAsyncLoad(load);

  useEffect(() => {
    if (groups.length > 0) void loadBalances();
  }, [groups, loadBalances]);

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

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('groups_title')}
          action={
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
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[11.5px] font-semibold text-white transition-colors"
                aria-label="Join with code"
              >
                <KeyRound size={12} strokeWidth={2.4} /> Join code
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Create group"
              >
                <Plus size={15} className="text-white" strokeWidth={2.4} />
              </button>
              <LanguageToggle />
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
                {groups.length} {groups.length === 1 ? 'group' : 'groups'}
                {otherCcyGroups.length > 0 && (
                  <> · +{otherCcyGroups.length} in other currencies</>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
                No groups yet
              </p>
              <p className="text-[12px] text-white/55 mt-1.5 max-w-[260px] leading-relaxed">
                Create one to split expenses, or join an existing group with a code.
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
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-400 active:scale-90"
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
              className="rounded-[14px] bg-ink-900 text-white px-4 py-3 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold active:scale-[0.98] transition-transform"
            >
              <Plus size={13} strokeWidth={2.4} /> {t('groups_action_create_title')}
            </button>
            <button
              onClick={() => setShowJoin(true)}
              className="rounded-[14px] bg-cream-card border border-cream-border text-ink-800 px-4 py-3 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold active:scale-[0.98] transition-transform"
            >
              <LogIn size={13} strokeWidth={2.4} /> {t('groups_action_join_title')}
            </button>
          </div>
        )}

        {isInitialLoading && <GroupsListSkeleton />}

        {hasGroups && (() => {
          const q = searchQuery.trim().toLowerCase();
          const visibleGroups = q
            ? groups.filter((g) => g.name.toLowerCase().includes(q))
            : groups;
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
                  {visibleGroups.map((g) => (
                    <GroupCard
                      key={g.id}
                      group={g}
                      balance={balances[g.id] ?? 0}
                      balanceLoaded={balancesLoaded}
                      settledLabel={t('group_settled')}
                      membersLabel={t('group_members_count')}
                      hasUnreadActivity={unreadGroupIds.has(g.id)}
                      onClick={() => navigate(`/group/${g.id}`)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })()}

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
