import { useEffect, useState } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import {
  PlusCircle, ArrowLeftRight, HandCoins, CheckCircle,
  Target, CreditCard, Clock, Landmark, Pencil, Trash2,
  Users, ArrowRightLeft, BellRing,
  type LucideIcon,
} from 'lucide-react';
import { useActivityStore } from '../stores/activityStore';
import { useNotificationStore } from '../stores/notificationStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { useT } from '../lib/i18n';

const iconMap: Record<string, LucideIcon> = {
  account_created: PlusCircle,
  account_deleted: Trash2,
  transaction_created: ArrowLeftRight,
  loan_created: HandCoins,
  loan_settled: CheckCircle,
  emi_paid: CreditCard,
  goal_created: Target,
  goal_contribution: Target,
  opening_balance: Landmark,
  transaction_modified: Pencil,
  transaction_deleted: Trash2,
  transfer: ArrowRightLeft,
  group_created: Users,
  group_expense: Users,
  group_settlement: CheckCircle,
};

const styleMap: Record<string, { icon: string; card: string }> = {
  account_created: { icon: 'text-blue-500 bg-gradient-to-br from-blue-50 to-blue-100/50', card: 'border-l-4 border-l-blue-400' },
  account_deleted: { icon: 'text-red-500 bg-gradient-to-br from-red-50 to-red-100/50', card: 'border-l-4 border-l-red-400' },
  transaction_created: { icon: 'text-indigo-500 bg-gradient-to-br from-indigo-50 to-indigo-100/50', card: 'border-l-4 border-l-indigo-400' },
  opening_balance: { icon: 'text-indigo-500 bg-gradient-to-br from-indigo-50 to-indigo-100/50', card: 'border-l-4 border-l-indigo-400' },
  loan_created: { icon: 'text-amber-500 bg-gradient-to-br from-amber-50 to-amber-100/50', card: 'border-l-4 border-l-amber-400' },
  emi_paid: { icon: 'text-teal-500 bg-gradient-to-br from-teal-50 to-teal-100/50', card: 'border-l-4 border-l-teal-400' },
  loan_settled: { icon: 'text-emerald-500 bg-gradient-to-br from-emerald-50 to-emerald-100/50', card: 'border-l-4 border-l-emerald-400' },
  group_settlement: { icon: 'text-emerald-500 bg-gradient-to-br from-emerald-50 to-emerald-100/50', card: 'border-l-4 border-l-emerald-400' },
  goal_created: { icon: 'text-purple-500 bg-gradient-to-br from-purple-50 to-purple-100/50', card: 'border-l-4 border-l-purple-400' },
  goal_contribution: { icon: 'text-purple-500 bg-gradient-to-br from-purple-50 to-purple-100/50', card: 'border-l-4 border-l-purple-400' },
  transaction_modified: { icon: 'text-orange-500 bg-gradient-to-br from-orange-50 to-orange-100/50', card: 'border-l-4 border-l-orange-400' },
  transaction_deleted: { icon: 'text-red-500 bg-gradient-to-br from-red-50 to-red-100/50', card: 'border-l-4 border-l-red-400' },
  transfer: { icon: 'text-cyan-500 bg-gradient-to-br from-cyan-50 to-cyan-100/50', card: 'border-l-4 border-l-cyan-400' },
  group_created: { icon: 'text-pink-500 bg-gradient-to-br from-pink-50 to-pink-100/50', card: 'border-l-4 border-l-pink-400' },
  group_expense: { icon: 'text-pink-500 bg-gradient-to-br from-pink-50 to-pink-100/50', card: 'border-l-4 border-l-pink-400' },
};

const defaultStyle = { icon: 'text-ink-500 bg-cream-soft', card: 'border-l-4 border-l-slate-300' };

type Tab = 'shared' | 'personal';

export function ActivityPage() {
  const { activities, loadActivities } = useActivityStore();
  const { notifications, loadNotifications, markAllRead, unreadCount } = useNotificationStore();
  const t = useT();
  // Default to Shared so any unread notifications surface immediately. The
  // tab choice is intentionally session-local — we don't persist it, since
  // most visits to /activity are short and people land here from the bell
  // badge expecting to see what's new first.
  const [tab, setTab] = useState<Tab>('shared');

  useEffect(() => {
    void loadActivities();
    void loadNotifications();
  }, [loadActivities, loadNotifications]);

  function getDateLabel(dateStr: string): string {
    const date = new Date(dateStr);
    if (isToday(date)) return t('activity_today');
    if (isYesterday(date)) return t('activity_yesterday');
    return format(date, 'dd MMM yyyy');
  }

  const grouped = activities.reduce((acc, activity) => {
    const label = getDateLabel(activity.timestamp);
    if (!acc[label]) acc[label] = [];
    acc[label].push(activity);
    return acc;
  }, {} as Record<string, typeof activities>);

  const hasAnyItems = notifications.length > 0 || activities.length > 0;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('activity_title')}
          back
          action={
            <div className="flex items-center gap-2">
              {tab === 'shared' && unreadCount > 0 && (
                <button
                  onClick={() => void markAllRead()}
                  className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[11.5px] font-semibold text-white transition-colors"
                  aria-label="Mark all read"
                >
                  Mark read
                </button>
              )}
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {tab === 'shared'
              ? `${notifications.length} shared${unreadCount > 0 ? ` · ${unreadCount} unread` : ''}`
              : `${activities.length} personal ${activities.length === 1 ? 'event' : 'events'}`}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Tab pills — Shared / Personal. The red dot on Shared signals
            unread shared notifications regardless of which tab is active,
            so unread state lives at the tab level only (per the spec) and
            not on individual notification rows. */}
        <div className="flex gap-2">
          <TabPill
            label="Shared"
            active={tab === 'shared'}
            onClick={() => setTab('shared')}
            showDot={unreadCount > 0}
          />
          <TabPill
            label="Personal"
            active={tab === 'personal'}
            onClick={() => setTab('personal')}
          />
        </div>

        {!hasAnyItems ? (
          <EmptyState
            icon={Clock}
            title={t('empty_activity_title')}
            description={t('empty_activity_desc')}
          />
        ) : tab === 'shared' ? (
          notifications.length === 0 ? (
            <div className="rounded-2xl bg-cream-card border border-cream-border p-4 text-[12px] text-ink-500 text-center">
              No shared notifications yet.
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.map((notification, index) => (
                <div
                  key={notification.id}
                  className="rounded-2xl bg-cream-card border border-cream-border p-4 flex items-start gap-3 animate-fade-in"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div className="w-9 h-9 rounded-xl bg-warn-50 text-warn-600 flex items-center justify-center shrink-0 mt-0.5">
                    <BellRing size={15} strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-ink-800 leading-snug tracking-tight">
                      {notification.title}
                    </p>
                    <p className="text-[12px] text-ink-500 mt-1">
                      {notification.body}
                    </p>
                    <p className="text-[10px] text-ink-500 mt-1">
                      {format(new Date(notification.createdAt), 'dd MMM, h:mm a')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activities.length === 0 ? (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4 text-[12px] text-ink-500 text-center">
            No personal activity yet.
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([dateLabel, items]) => (
              <div key={dateLabel}>
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
                  {dateLabel}
                </p>
                <div className="space-y-2">
                  {items.map((activity, index) => {
                    const Icon = iconMap[activity.type] ?? ArrowLeftRight;
                    const style = styleMap[activity.type] ?? defaultStyle;
                    return (
                      <div
                        key={activity.id}
                        className={`rounded-2xl bg-cream-card border border-cream-border p-4 flex items-start gap-3 animate-fade-in ${style.card}`}
                        style={{ animationDelay: `${index * 30}ms` }}
                      >
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${style.icon}`}>
                          <Icon size={15} strokeWidth={1.8} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] text-ink-800 leading-snug tracking-tight">
                            {activity.description}
                          </p>
                          <p className="text-[10px] text-ink-500 mt-1">
                            {format(new Date(activity.timestamp), 'h:mm a')}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function TabPill({
  label,
  active,
  onClick,
  showDot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  showDot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-colors relative ${
        active
          ? 'bg-ink-900 text-white'
          : 'bg-cream-card text-ink-500 border border-cream-border'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {showDot && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-pay-600 shrink-0"
            aria-label="Unread"
          />
        )}
      </span>
    </button>
  );
}
