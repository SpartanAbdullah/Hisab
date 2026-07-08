import { useCallback, useState } from 'react';
import { Target, CalendarClock, CheckCircle, XCircle, GraduationCap, HeartPulse, PartyPopper, Plane, Home, Zap, MoreHorizontal, Plus } from 'lucide-react';
import { useGoalStore } from '../stores/goalStore';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useTransactionStore } from '../stores/transactionStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { differenceInDays, format } from 'date-fns';
import { AddGoalModal } from './AddGoalModal';
import { AddUpcomingExpenseModal } from './AddUpcomingExpenseModal';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import type { Goal } from '../db';

const GOAL_MILESTONES = [25, 50, 75, 100];

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
  Education: { bg: 'bg-info-50', text: 'text-info-600' },
  Medical: { bg: 'bg-pay-100', text: 'text-pay-600' },
  Event: { bg: 'bg-accent-100', text: 'text-accent-600' },
  Travel: { bg: 'bg-info-50', text: 'text-info-600' },
  Rent: { bg: 'bg-warn-50', text: 'text-warn-600' },
  Utilities: { bg: 'bg-warn-50', text: 'text-warn-600' },
  Other: { bg: 'bg-cream-soft', text: 'text-ink-600' },
};

export function GoalsPage() {
  const { goals, loadGoals, addContribution } = useGoalStore();
  const { accounts, loadAccounts } = useAccountStore();
  const { expenses, loadExpenses, markPaid, updateStatus } = useUpcomingExpenseStore();
  const processTransaction = useTransactionStore(s => s.processTransaction);
  const t = useT();
  const toast = useToast();

  // Marking a bill "Done" only hides the reminder — it never moved money. Make
  // that explicit and offer a one-tap way to record the actual spend, so a user
  // who assumed "Done" logged the payment isn't left with a wrong balance.
  const handleBillDone = (exp: (typeof expenses)[number]) => {
    void markPaid(exp.id);
    const account = accounts.find(a => a.id === exp.accountId);
    toast.show({
      type: 'success',
      title: t('upcoming_done_toast').replace('{title}', exp.title),
      action: account
        ? {
            label: t('upcoming_log_expense'),
            onPress: () => {
              void processTransaction({
                type: 'expense',
                sourceAccountId: exp.accountId,
                amount: exp.amount,
                category: exp.category,
                notes: exp.title,
              }).then(() => {
                toast.show({
                  type: 'success',
                  title: t('upcoming_logged').replace('{amount}', formatMoney(exp.amount, exp.currency)),
                });
              });
            },
          }
        : undefined,
    });
  };
  const [showAdd, setShowAdd] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);
  // "Add money" sheet for a specific goal — a simple set-aside that grows the
  // saved bar. It does NOT move money between accounts (keeps the model clear).
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [addAmount, setAddAmount] = useState('');
  const [addMode, setAddMode] = useState<'add' | 'out'>('add');
  const [savingAdd, setSavingAdd] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([loadGoals(), loadAccounts(), loadExpenses()]);
  }, [loadGoals, loadAccounts, loadExpenses]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const upcomingExpenses = expenses
    .filter(e => e.status === 'upcoming')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const closeAdd = () => {
    setSelectedGoal(null);
    setAddAmount('');
    setAddMode('add');
  };
  const submitAdd = async () => {
    if (!selectedGoal) return;
    const amt = parseFloat(addAmount);
    if (!amt || amt <= 0) return;

    // Commitment-aware take-out: a dated goal that hasn't reached its date yet
    // gets a gentle confirm so savings aren't raided on impulse (a soft "lock"
    // built on the existing targetDate — no schema, behavioural friction only).
    if (addMode === 'out' && selectedGoal.targetDate) {
      const td = new Date(selectedGoal.targetDate);
      if (differenceInDays(td, new Date()) > 0) {
        const ok = await confirmDestructive({
          title: t('goal_locked_title'),
          description: t('goal_locked_body').replace('{date}', format(td, 'd MMM yyyy')),
          confirmLabel: t('goal_take_out'),
          tone: 'warning',
        });
        if (!ok) return;
      }
    }

    setSavingAdd(true);
    try {
      const beforePct = selectedGoal.targetAmount > 0 ? (selectedGoal.savedAmount / selectedGoal.targetAmount) * 100 : 0;
      await addContribution(selectedGoal.id, addMode === 'out' ? -amt : amt);
      // Celebrate crossing a milestone on the way up (25/50/75/100%).
      const crossed = addMode === 'add' && selectedGoal.targetAmount > 0
        ? GOAL_MILESTONES.filter((m) => beforePct < m && ((selectedGoal.savedAmount + amt) / selectedGoal.targetAmount) * 100 >= m).pop()
        : undefined;
      if (crossed) {
        toast.show({
          type: 'success',
          title: crossed >= 100 ? t('goal_reached') : t('goal_milestone').replace('{pct}', String(crossed)),
        });
      } else {
        toast.show({ type: 'success', title: addMode === 'out' ? t('goal_take_out') : t('goal_add_money') });
      }
      closeAdd();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('err_could_not_save') });
    } finally {
      setSavingAdd(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('goals_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAdd(true)}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[12px] font-semibold text-white transition-colors"
                aria-label="Add goal"
              >
                <Plus size={12} strokeWidth={2.4} /> Goal
              </button>
              <button
                onClick={() => setShowAddExpense(true)}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[12px] font-semibold text-white transition-colors"
                aria-label="Add upcoming expense"
              >
                <Plus size={12} strokeWidth={2.4} /> Bill
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {goals.length} {goals.length === 1 ? 'goal' : 'goals'}
            {upcomingExpenses.length > 0 && <> · {upcomingExpenses.length} upcoming</>}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">

      {loadStatus === 'error' && (
        <PageErrorState
          variant="inline"
          title="Couldn't load goals"
          message={loadError ?? 'Some data failed to load.'}
          onRetry={retryLoad}
        />
      )}

      {/* First-load skeleton — never flash "No goals yet" before the
          goals + upcoming-expenses queries finish. */}
      {loadStatus === 'loading' && goals.length === 0 && upcomingExpenses.length === 0 && (
        <div className="px-5 pt-5"><ListSkeleton rows={3} /></div>
      )}

      {/* Upcoming Expenses Section */}
      {upcomingExpenses.length > 0 && (
        <div className="px-5 pt-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5">
              <CalendarClock size={12} /> {t('upcoming_title')}
            </h2>
            <button
              onClick={() => setShowAddExpense(true)}
              className="text-[11px] font-semibold text-accent-600 flex items-center gap-1 active:opacity-70"
              aria-label="Add upcoming expense"
            >
              <Plus size={11} strokeWidth={2.5} /> Bill
            </button>
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
              const catColor = categoryColorMap[exp.category] ?? { bg: 'bg-cream-soft', text: 'text-ink-500' };

              // Color-coded card tint
              const cardTint = isOverdue || isUrgent
                ? '!border-pay-100/60 !bg-pay-50/20'
                : isDueToday
                  ? '!border-warn-50/60 !bg-warn-50/20'
                  : isSoon
                    ? '!border-warn-50/60'
                    : '!border-receive-100/60 !bg-receive-50/10';

              return (
                <div key={exp.id}
                  className={`rounded-2xl bg-cream-card border border-cream-border p-4 animate-fade-in ${cardTint}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${catColor.bg} ${catColor.text}`}>
                      <CatIcon size={18} strokeWidth={1.8} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[13px] text-ink-900 tracking-tight truncate">{exp.title}</p>
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        {account?.name ?? 'Unknown'} — {format(new Date(exp.dueDate), 'dd MMM yyyy')}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[14px] font-bold tabular-nums text-ink-900">
                        {formatMoney(exp.amount, exp.currency)}
                      </p>
                      <p className={`text-[10px] font-bold mt-0.5 ${
                        isOverdue ? 'text-pay-600' :
                        isDueToday ? 'text-warn-600' :
                        isUrgent ? 'text-pay-text' :
                        isSoon ? 'text-warn-600' :
                        'text-receive-600'
                      }`}>
                        {isOverdue ? t('upcoming_overdue') :
                         isDueToday ? t('upcoming_due_today') :
                         `${daysLeft} ${t('upcoming_due_in')}`}
                      </p>
                    </div>
                  </div>

                  {/* Low balance warning */}
                  {hasInsufficientBalance && (
                    <div className="mt-2.5 bg-pay-50 rounded-xl px-3 py-2 flex items-center gap-2">
                      <span className="text-[10px]">&#x26a0;&#xfe0f;</span>
                      <p className="text-[10px] text-pay-600 font-bold">
                        {t('upcoming_low_balance')} — {account?.name}: {formatMoney(account?.balance ?? 0, exp.currency)}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => handleBillDone(exp)}
                      className="flex-1 min-h-[44px] py-2 rounded-xl border border-receive-100 text-receive-600 text-[11px] font-bold flex items-center justify-center gap-1.5 active:bg-receive-50 transition-all"
                    >
                      <CheckCircle size={12} /> {t('upcoming_status_done')}
                    </button>
                    <button onClick={() => {
                        // Instant cancel with an Undo — the Cancel button sits
                        // right next to Done, so a mis-tap should be painless.
                        const prev = exp.status;
                        void updateStatus(exp.id, 'cancelled');
                        toast.show({
                          type: 'success',
                          title: t('upcoming_cancelled'),
                          action: { label: t('undo'), onPress: () => void updateStatus(exp.id, prev) },
                        });
                      }}
                      className="min-h-[44px] py-2 px-3 rounded-xl border border-pay-100 text-pay-text flex items-center gap-1.5 active:bg-pay-50 transition-all text-[11px] font-bold"
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
          <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5">
            <Target size={12} /> {t('goals_title')}
          </h2>
        )}
        {loadStatus === 'ready' && goals.length === 0 && upcomingExpenses.length === 0 && (
          <EmptyState icon={Target} tone="receive" title={t('empty_goals_title')} description={t('empty_goals_desc')} subhint={t('empty_goals_subhint')} actionLabel={t('empty_goals_cta')} onAction={() => setShowAdd(true)} />
        )}
        {goals.map((g, i) => {
          const progress = g.targetAmount > 0 ? (g.savedAmount / g.targetAmount) * 100 : 0;
          const account = g.storedInAccountId ? accounts.find(a => a.id === g.storedInAccountId) : null;
          const isComplete = progress >= 100;
          // "How much more" + a soft pace estimate from the average saved per
          // month since the goal was created.
          const remaining = Math.max(0, g.targetAmount - g.savedAmount);
          const monthsElapsed = Math.max(
            1,
            differenceInDays(new Date(), new Date(g.createdAt)) / 30,
          );
          const pace = g.savedAmount / monthsElapsed;
          const monthsToGo = pace > 0 ? Math.ceil(remaining / pace) : 0;
          // Deadline (optional): suggest a monthly save + an on-track/behind
          // signal based on linear expected progress from createdAt → target.
          const targetDate = g.targetDate ? new Date(g.targetDate) : null;
          const daysToTarget = targetDate ? differenceInDays(targetDate, new Date()) : null;
          const monthsLeft = daysToTarget != null ? Math.max(0, daysToTarget / 30) : null;
          const monthlyNeeded = monthsLeft != null && monthsLeft > 0 ? remaining / monthsLeft : remaining;
          const onTrack = (() => {
            if (!targetDate) return null;
            const totalDays = differenceInDays(targetDate, new Date(g.createdAt));
            if (totalDays <= 0) return g.savedAmount >= g.targetAmount;
            const elapsed = differenceInDays(new Date(), new Date(g.createdAt));
            const expected = g.targetAmount * Math.min(1, Math.max(0, elapsed / totalDays));
            return g.savedAmount >= expected - 0.01;
          })();
          return (
            <div key={g.id}
              className={`rounded-2xl bg-cream-card border border-cream-border p-5 animate-fade-in ${isComplete ? '!border-receive-100/60' : ''}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-3.5">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                  isComplete ? 'bg-gradient-to-br from-receive-100 to-receive-50 text-receive-600' : 'bg-gradient-to-br from-accent-100 to-accent-50 text-accent-600'
                }`}>
                  {isComplete ? <span className="text-lg">&#x1f389;</span> : <Target size={22} strokeWidth={1.8} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[14px] text-ink-900 tracking-tight">{g.title}</p>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    {account ? `${account.name} · ${g.currency}` : g.currency}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-[14px] font-bold tabular-nums ${isComplete ? 'text-receive-600' : 'text-accent-600'}`}>
                    {Math.round(progress)}%
                  </p>
                  {isComplete && <p className="text-[10px] text-receive-600 font-bold">{t('goal_done')}</p>}
                </div>
              </div>

              <div className="mt-4 bg-cream-soft/60 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    isComplete ? 'bg-gradient-to-r from-receive-600 to-receive-700' : 'bg-gradient-to-r from-accent-500 to-accent-600'
                  }`}
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-[11px] text-ink-500 tabular-nums">
                <span>{t('goal_saved')}: {formatMoney(g.savedAmount, g.currency)}</span>
                <span>{t('goal_target')}: {formatMoney(g.targetAmount, g.currency)}</span>
              </div>

              {!isComplete && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-ink-700 tabular-nums">
                      {t('goal_to_go').replace('{amount}', formatMoney(remaining, g.currency))}
                    </p>
                    {targetDate ? (
                      daysToTarget != null && daysToTarget < 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-pay-50 text-pay-text px-2 py-0.5 text-[10px] font-semibold">
                          {t('goal_date_passed')}
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${onTrack ? 'bg-receive-50 text-receive-text' : 'bg-warn-50 text-warn-700'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${onTrack ? 'bg-receive-600' : 'bg-warn-600'}`} />
                          {onTrack ? t('goal_on_track') : t('goal_behind')}
                        </span>
                      )
                    ) : pace > 0 ? (
                      <p className="text-[11px] text-ink-400 tabular-nums">
                        {t('goal_pace').replace('{n}', String(monthsToGo))}
                      </p>
                    ) : null}
                  </div>
                  {targetDate && (
                    <p className="text-[10.5px] text-ink-400 tabular-nums">
                      {t('goal_by_date').replace('{date}', format(targetDate, 'd MMM yyyy'))}
                      {daysToTarget != null && daysToTarget >= 0 && remaining > 0 && onTrack !== false && (
                        <> · {t('goal_save_monthly').replace('{amount}', formatMoney(Math.ceil(monthlyNeeded), g.currency))}</>
                      )}
                    </p>
                  )}
                  {/* When behind, the recomputed monthlyNeeded IS the catch-up
                      amount (remaining ÷ months-left rises as you fall behind).
                      Surface it as a clear, self-correcting nudge. */}
                  {targetDate && onTrack === false && daysToTarget != null && daysToTarget >= 0 && remaining > 0 && (
                    <p className="text-[10.5px] font-semibold text-warn-700 tabular-nums">
                      {t('goal_catch_up').replace('{amount}', formatMoney(Math.ceil(monthlyNeeded), g.currency))}
                    </p>
                  )}
                </div>
              )}

              {!isComplete && (
                <button onClick={() => setSelectedGoal(g)}
                  className="mt-4 w-full py-2.5 rounded-2xl border-2 border-dashed border-accent-100 text-accent-600 text-[12px] font-bold active:bg-accent-50 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
                >{t('goal_add_money')}</button>
              )}
            </div>
          );
        })}
      </div>

      </div>

      <AddGoalModal open={showAdd} onClose={() => setShowAdd(false)} />
      <AddUpcomingExpenseModal open={showAddExpense} onClose={() => setShowAddExpense(false)} />
      <Modal
        open={!!selectedGoal}
        onClose={closeAdd}
        title={selectedGoal ? t('goal_add_to').replace('{title}', selectedGoal.title) : ''}
        footer={
          <button
            onClick={submitAdd}
            disabled={savingAdd || !(parseFloat(addAmount) > 0)}
            className="cta-primary"
          >
            {savingAdd ? t('goal_creating') : addMode === 'out' ? t('goal_take_out') : t('goal_add_money')}
          </button>
        }
      >
        {selectedGoal && (
          <div className="space-y-4">
            <div className="bg-cream-soft/80 rounded-2xl p-3.5 border border-cream-hairline flex items-center justify-between">
              <span className="text-[12px] text-ink-600">{t('goal_saved')}</span>
              <span className="text-[14px] font-bold tabular-nums text-ink-900">
                {formatMoney(selectedGoal.savedAmount, selectedGoal.currency)} / {formatMoney(selectedGoal.targetAmount, selectedGoal.currency)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setAddMode('add')}
                className={`justify-center text-[12.5px] font-semibold ${addMode === 'add' ? 'selector-base selector-selected' : 'selector-base'}`}
              >{t('goal_add_money')}</button>
              <button type="button" onClick={() => setAddMode('out')}
                className={`justify-center text-[12.5px] font-semibold ${addMode === 'out' ? 'selector-base selector-selected' : 'selector-base'}`}
              >{t('goal_take_out')}</button>
            </div>
            <div>
              <label className="form-label">{t('goal_amount_label')} ({selectedGoal.currency})</label>
              <input
                type="number"
                step="0.01"
                value={addAmount}
                onChange={(e) => setAddAmount(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="input-field text-center text-xl font-bold tabular-nums"
              />
            </div>
            <p className="text-[12px] text-ink-500 bg-cream-soft/80 border border-cream-hairline rounded-2xl p-3 leading-relaxed">
              {t('goal_track_note')}
            </p>
          </div>
        )}
      </Modal>
    </main>
  );
}
