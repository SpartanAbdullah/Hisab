import { useEffect, useState } from 'react';
import { Target, CalendarClock, CheckCircle, XCircle, GraduationCap, HeartPulse, PartyPopper, Plane, Home, Zap, MoreHorizontal } from 'lucide-react';
import { useGoalStore } from '../stores/goalStore';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { differenceInDays, format } from 'date-fns';
import { AddGoalModal } from './AddGoalModal';
import { AddUpcomingExpenseModal } from './AddUpcomingExpenseModal';
import { QuickEntry } from './QuickEntry';

const categoryIconMap: Record<string, React.ElementType> = {
  Education: GraduationCap,
  Medical: HeartPulse,
  Event: PartyPopper,
  Travel: Plane,
  Rent: Home,
  Utilities: Zap,
  Other: MoreHorizontal,
};

const categoryColorMap: Record<string, { bg: string; text: string }> = {
  Education: { bg: 'bg-blue-100', text: 'text-blue-600' },
  Medical: { bg: 'bg-rose-100', text: 'text-rose-600' },
  Event: { bg: 'bg-purple-100', text: 'text-purple-600' },
  Travel: { bg: 'bg-cyan-100', text: 'text-cyan-600' },
  Rent: { bg: 'bg-amber-100', text: 'text-amber-600' },
  Utilities: { bg: 'bg-yellow-100', text: 'text-yellow-600' },
  Other: { bg: 'bg-slate-100', text: 'text-slate-600' },
};

export function GoalsPage() {
  const { goals, loadGoals } = useGoalStore();
  const { accounts, loadAccounts } = useAccountStore();
  const { expenses, loadExpenses, markPaid, updateStatus } = useUpcomingExpenseStore();
  const t = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showContribute, setShowContribute] = useState(false);

  useEffect(() => { loadGoals(); loadAccounts(); loadExpenses(); }, [loadGoals, loadAccounts, loadExpenses]);

  const upcomingExpenses = expenses
    .filter(e => e.status === 'upcoming')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  return (
    <div className="page-shell">
      <PageHeader title={t('goals_title')} action={<LanguageToggle />} />

      {/* Upcoming Expenses Section */}
      {upcomingExpenses.length > 0 && (
        <div className="px-5 pt-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <CalendarClock size={12} /> {t('upcoming_title')}
            </h2>
            <span className="text-[10px] font-bold text-slate-300">{upcomingExpenses.length}</span>
          </div>
          <div className="space-y-2.5">
            {upcomingExpenses.map((exp, i) => {
              const daysLeft = differenceInDays(new Date(exp.dueDate), new Date());
              const account = accounts.find(a => a.id === exp.accountId);
              const isOverdue = daysLeft < 0;
              const isDueToday = daysLeft === 0;
              const isUrgent = daysLeft >= 1 && daysLeft <= 7;
              const isSoon = daysLeft > 7 && daysLeft <= 30;
              const hasInsufficientBalance = account ? exp.amount > account.balance : false;

              const CatIcon = categoryIconMap[exp.category] ?? CalendarClock;
              const catColor = categoryColorMap[exp.category] ?? { bg: 'bg-slate-100', text: 'text-slate-400' };

              // Color-coded card tint
              const cardTint = isOverdue || isUrgent
                ? '!border-red-200/60 !bg-red-50/20'
                : isDueToday
                  ? '!border-amber-200/60 !bg-amber-50/20'
                  : isSoon
                    ? '!border-amber-100/60'
                    : '!border-emerald-100/60 !bg-emerald-50/10';

              return (
                <div key={exp.id}
                  className={`card-premium p-4 animate-fade-in ${cardTint}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${catColor.bg} ${catColor.text}`}>
                      <CatIcon size={18} strokeWidth={1.8} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[13px] text-slate-800 tracking-tight truncate">{exp.title}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {account?.name ?? 'Unknown'} — {format(new Date(exp.dueDate), 'dd MMM yyyy')}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[14px] font-bold tabular-nums text-slate-800">
                        {formatMoney(exp.amount, exp.currency)}
                      </p>
                      <p className={`text-[10px] font-bold mt-0.5 ${
                        isOverdue ? 'text-red-500' :
                        isDueToday ? 'text-amber-600' :
                        isUrgent ? 'text-red-400' :
                        isSoon ? 'text-amber-500' :
                        'text-emerald-500'
                      }`}>
                        {isOverdue ? t('upcoming_overdue') :
                         isDueToday ? t('upcoming_due_today') :
                         `${daysLeft} ${t('upcoming_due_in')}`}
                      </p>
                    </div>
                  </div>

                  {/* Low balance warning */}
                  {hasInsufficientBalance && (
                    <div className="mt-2.5 bg-red-50 rounded-xl px-3 py-2 flex items-center gap-2">
                      <span className="text-[10px]">&#x26a0;&#xfe0f;</span>
                      <p className="text-[10px] text-red-600 font-bold">
                        {t('upcoming_low_balance')} — {account?.name}: {formatMoney(account?.balance ?? 0, exp.currency)}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => markPaid(exp.id)}
                      className="flex-1 py-2 rounded-xl border border-emerald-200 text-emerald-600 text-[11px] font-bold flex items-center justify-center gap-1.5 active:bg-emerald-50 transition-all"
                    >
                      <CheckCircle size={12} /> {t('upcoming_status_done')}
                    </button>
                    <button onClick={() => updateStatus(exp.id, 'cancelled')}
                      className="py-2 px-3 rounded-xl border border-red-100 text-red-400 flex items-center gap-1.5 active:bg-red-50 transition-all text-[11px] font-bold"
                    >
                      <XCircle size={12} /> {t('upcoming_status_cancel')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Goals Section */}
      <div className="px-5 pt-5 space-y-3">
        {goals.length > 0 && (
          <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
            <Target size={12} /> {t('goals_title')}
          </h2>
        )}
        {goals.length === 0 && upcomingExpenses.length === 0 && (
          <EmptyState icon={Target} title={t('empty_goals_title')} description={t('empty_goals_desc')} actionLabel={t('empty_goals_cta')} onAction={() => setShowAdd(true)} />
        )}
        {goals.map((g, i) => {
          const progress = g.targetAmount > 0 ? (g.savedAmount / g.targetAmount) * 100 : 0;
          const account = g.storedInAccountId ? accounts.find(a => a.id === g.storedInAccountId) : null;
          const isComplete = progress >= 100;
          const isInternal = !g.storedInAccountId;
          return (
            <div key={g.id}
              className={`card-premium p-5 animate-fade-in ${isComplete ? '!border-emerald-100/60' : ''}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-3.5">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                  isComplete ? 'bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-600' : 'bg-gradient-to-br from-purple-100 to-purple-50 text-purple-600'
                }`}>
                  {isComplete ? <span className="text-lg">&#x1f389;</span> : <Target size={22} strokeWidth={1.8} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[14px] text-slate-800 tracking-tight">{g.title}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {account ? `${account.name} — ${g.currency}` : isInternal ? t('goal_internal') : `${g.currency}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-[14px] font-bold tabular-nums ${isComplete ? 'text-emerald-600' : 'text-purple-600'}`}>
                    {Math.round(progress)}%
                  </p>
                  {isComplete && <p className="text-[10px] text-emerald-500 font-bold">{t('goal_done')}</p>}
                </div>
              </div>

              <div className="mt-4 bg-slate-100/60 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    isComplete ? 'bg-gradient-to-r from-emerald-400 to-emerald-500' : 'bg-gradient-to-r from-purple-400 to-violet-500'
                  }`}
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-[11px] text-slate-400 tabular-nums">
                <span>{t('goal_saved')}: {formatMoney(g.savedAmount, g.currency)}</span>
                <span>{t('goal_target')}: {formatMoney(g.targetAmount, g.currency)}</span>
              </div>

              {!isComplete && (
                <button onClick={() => setShowContribute(true)}
                  className="mt-4 w-full py-2.5 rounded-2xl border-2 border-dashed border-purple-200 text-purple-600 text-[12px] font-bold active:bg-purple-50 transition-all"
                >{t('goal_contribute')}</button>
              )}
            </div>
          );
        })}
      </div>

      <AddGoalModal open={showAdd} onClose={() => setShowAdd(false)} />
      <AddUpcomingExpenseModal open={showAddExpense} onClose={() => setShowAddExpense(false)} />
      <QuickEntry open={showContribute} onClose={() => setShowContribute(false)} />
    </div>
  );
}
