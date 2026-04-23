import { useEffect } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import {
  PlusCircle, ArrowLeftRight, HandCoins, CheckCircle,
  Target, CreditCard, Clock, Landmark, Pencil, Trash2,
  Users, ArrowRightLeft, BellRing,
  type LucideIcon,
} from 'lucide-react';
import { useActivityStore } from '../stores/activityStore';
import { useNotificationStore } from '../stores/notificationStore';
import { PageHeader } from '../components/PageHeader';
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

const defaultStyle = { icon: 'text-slate-500 bg-slate-50', card: 'border-l-4 border-l-slate-300' };

export function ActivityPage() {
  const { activities, loadActivities } = useActivityStore();
  const { notifications, loadNotifications, markAllRead, unreadCount } = useNotificationStore();
  const t = useT();

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
    <div className="page-shell">
      <PageHeader
        title={t('activity_title')}
        action={(
          <div className="flex items-center gap-2">
            <LanguageToggle />
            {notifications.length > 0 && (
              <button onClick={() => void markAllRead()} className="text-[10px] font-bold text-indigo-600 bg-indigo-50 rounded-xl px-3 py-2">
                Mark read
              </button>
            )}
          </div>
        )}
      />

      <div className="px-5 pt-5 space-y-5">
        {!hasAnyItems ? (
          <EmptyState icon={Clock} title={t('empty_activity_title')} description={t('empty_activity_desc')} />
        ) : (
          <>
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Shared Updates</p>
                {unreadCount > 0 && (
                  <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-1 rounded-full">
                    {unreadCount} unread
                  </span>
                )}
              </div>

              {notifications.length === 0 ? (
                <div className="card-premium p-4 text-[12px] text-slate-400">No shared notifications yet.</div>
              ) : (
                <div className="space-y-2">
                  {notifications.map((notification, index) => (
                    <div
                      key={notification.id}
                      className={`card-premium !rounded-2xl p-4 flex items-start gap-3 animate-fade-in border-l-4 ${
                        notification.readAt ? 'border-l-slate-200' : 'border-l-amber-400'
                      }`}
                      style={{ animationDelay: `${index * 30}ms` }}
                    >
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                        notification.readAt ? 'bg-slate-50 text-slate-500' : 'bg-amber-50 text-amber-600'
                      }`}>
                        <BellRing size={15} strokeWidth={1.8} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-slate-700 leading-snug tracking-tight">{notification.title}</p>
                        <p className="text-[12px] text-slate-500 mt-1">{notification.body}</p>
                        <p className="text-[10px] text-slate-400 mt-1">{format(new Date(notification.createdAt), 'dd MMM, h:mm a')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">Personal Activity</p>
              {activities.length === 0 ? (
                <div className="card-premium p-4 text-[12px] text-slate-400">No personal activity yet.</div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(grouped).map(([dateLabel, items]) => (
                    <div key={dateLabel}>
                      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">{dateLabel}</p>
                      <div className="space-y-2">
                        {items.map((activity, index) => {
                          const Icon = iconMap[activity.type] ?? ArrowLeftRight;
                          const style = styleMap[activity.type] ?? defaultStyle;
                          return (
                            <div
                              key={activity.id}
                              className={`card-premium !rounded-2xl p-4 flex items-start gap-3 animate-fade-in ${style.card}`}
                              style={{ animationDelay: `${index * 30}ms` }}
                            >
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${style.icon}`}>
                                <Icon size={15} strokeWidth={1.8} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] text-slate-700 leading-snug tracking-tight">{activity.description}</p>
                                <p className="text-[10px] text-slate-400 mt-1">{format(new Date(activity.timestamp), 'h:mm a')}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
