import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, ArrowDownLeft, Wallet, Plus, BarChart3 } from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { AccountCard } from '../components/AccountCard';
import { TransactionItem } from '../components/TransactionItem';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ProgressRing } from '../components/ProgressRing';
import { UserAvatar } from '../components/UserAvatar';
import { AddAccountStepper } from './AddAccountStepper';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      resolve();
      return;
    }
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

export function HomePage() {
  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loans, loadLoans } = useLoanStore();
  const { goals, loadGoals } = useGoalStore();
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  const navigate = useNavigate();
  const t = useT();
  const [showAddAccount, setShowAddAccount] = useState(false);

  const userName = localStorage.getItem('hisaab_user_name') ?? 'User';

  // Load account balances first so the mobile dashboard can paint its core
  // money view before supporting widgets compete for network/CPU.
  const loadEverything = useCallback(async () => {
    await loadAccounts();
    await waitForNextPaint();
    await Promise.all([
      loadTransactions(),
      loadLoans(),
      loadGoals(),
      loadExpenses(),
    ]);
  }, [loadAccounts, loadTransactions, loadLoans, loadGoals, loadExpenses]);

  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(loadEverything);

  // FIX 2: Credit cards are liabilities, not assets
  // Net worth = regular account balances + (credit card balance - limit) for each card
  const totals = accounts.reduce(
    (acc, a) => {
      if (a.type === 'credit_card') {
        const limit = parseFloat(a.metadata.creditLimit || '0');
        const used = limit - a.balance; // amount owed
        acc[a.currency] = (acc[a.currency] ?? 0) - used; // subtract liability
      } else {
        acc[a.currency] = (acc[a.currency] ?? 0) + a.balance;
      }
      return acc;
    },
    {} as Record<string, number>
  );

  const recentTxns = transactions.slice(0, 5);
  const getMonthStats = (accountId: string) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTxns = transactions.filter(t => new Date(t.createdAt) >= startOfMonth);
    const income = monthTxns.filter(t => t.type === 'income' && t.destinationAccountId === accountId).reduce((s, t) => s + t.amount, 0);
    const expense = monthTxns.filter(t => t.type === 'expense' && t.sourceAccountId === accountId).reduce((s, t) => s + t.amount, 0);
    return (income > 0 || expense > 0) ? { income, expense } : null;
  };
  const activeLoans = loans.filter(l => l.status === 'active');
  // Keep receivables/payables grouped by currency so AED and PKR don't merge.
  const sumLoansByCurrency = (items: typeof loans) => items.reduce((acc, l) => {
    acc[l.currency] = (acc[l.currency] ?? 0) + l.remainingAmount;
    return acc;
  }, {} as Record<string, number>);
  const receivablesByCurrency = sumLoansByCurrency(activeLoans.filter(l => l.type === 'given'));
  const payablesByCurrency = sumLoansByCurrency(activeLoans.filter(l => l.type === 'taken'));
  const receivableEntries = Object.entries(receivablesByCurrency).filter(([, v]) => v > 0);
  const payableEntries = Object.entries(payablesByCurrency).filter(([, v]) => v > 0);
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Good Night' : hour < 12 ? 'Subah Bakhair' : hour < 17 ? 'Assalam o Alaikum' : hour < 21 ? 'Shaam Bakhair' : 'Good Night';
  const greetingEmoji = hour < 5 ? '\u{1F319}' : hour < 12 ? '\u{1F305}' : hour < 17 ? '\u{2600}\u{FE0F}' : hour < 21 ? '\u{1F306}' : '\u{1F319}';

  // Upcoming expense reminders — within their reminder window
  const [dismissedReminders, setDismissedReminders] = useState<string[]>([]);
  const urgentExpenses = expenses
    .filter(e => e.status === 'upcoming' && !dismissedReminders.includes(e.id))
    .filter(e => {
      const daysLeft = Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const reminderWindow = e.reminderDaysBefore ?? 7;
      return daysLeft <= reminderWindow;
    })
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  return (
    <div className="page-shell">
      {/* Header — calm greeting + avatar anchor on the right. Actions moved
          into their own section headers to keep this row quiet. */}
      <header className="sticky top-0 glass border-b border-slate-100/60 px-5 pt-safe pb-4 z-40">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[11px] text-slate-400 font-medium tracking-wide">{greeting}</p>
            <h1 className="text-[18px] font-extrabold tracking-tight text-slate-800 truncate">
              {userName} <span className="inline-block animate-float">{greetingEmoji}</span>
            </h1>
          </div>
          <UserAvatar name={userName} size={40} onClick={() => navigate('/settings')} />
        </div>
      </header>

      {/* Load-failure banner. Stays visible until retry succeeds so the user
          never has a silently-empty dashboard masquerading as "no data". */}
      {loadStatus === 'error' && (
        <div className="px-5 pt-3">
          <PageErrorState
            variant="inline"
            title="Couldn't refresh your dashboard"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        </div>
      )}

      {/* Smart Insight */}
      {accounts.length > 0 && (() => {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const thisMonthTxns = transactions.filter(t => new Date(t.createdAt) >= startOfMonth);
        const monthExpenses = thisMonthTxns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
        const activeGoal = goals.find(g => g.savedAmount < g.targetAmount);
        const activePayable = activeLoans.find(l => l.type === 'taken');
        const upcomingCount = expenses.filter(e => e.status === 'upcoming' && Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000*60*60*24)) <= 7).length;

        let insightText = '';
        let insightIcon = '\u{1F4A1}';
        if (monthExpenses > 0) {
          insightText = t('insight_month_spent').replace('{amount}', formatMoney(monthExpenses, Object.keys(totals)[0] || 'PKR'));
          insightIcon = '\u{1F4CA}';
        } else if (activeGoal) {
          const pct = Math.round((activeGoal.savedAmount / activeGoal.targetAmount) * 100);
          insightText = `${activeGoal.title} ${pct}% complete hai`;
          insightIcon = '\u{1F3AF}';
        } else if (activePayable) {
          insightText = `${activePayable.personName} ko ${formatMoney(activePayable.remainingAmount, activePayable.currency)} dena baaki hai`;
          insightIcon = '\u{1F4B0}';
        } else if (upcomingCount === 0) {
          insightText = t('insight_no_upcoming');
          insightIcon = '\u{2728}';
        }

        if (!insightText) return null;
        return (
          <div className="px-5 pt-3">
            <div className="bg-indigo-50/80 rounded-2xl px-4 py-2.5 flex items-center gap-2.5 border border-indigo-100/60">
              <span className="text-sm">{insightIcon}</span>
              <p className="text-[11px] text-indigo-700 font-medium">{insightText}</p>
            </div>
          </div>
        );
      })()}

      {/* Upcoming expense reminder banners */}
      {urgentExpenses.length > 0 && (
        <div className="px-5 pt-3 space-y-2">
          {urgentExpenses.slice(0, 2).map(exp => {
            const daysLeft = Math.ceil((new Date(exp.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            return (
              <div key={exp.id} className="bg-amber-50 border border-amber-200/60 rounded-2xl px-4 py-3 flex items-center gap-3 animate-fade-in">
                <span className="text-sm">&#x23f0;</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-amber-800 truncate">
                    Reminder: {exp.title} — {formatMoney(exp.amount, exp.currency)}
                  </p>
                  <p className="text-[10px] text-amber-600">
                    {daysLeft <= 0 ? 'Overdue!' : daysLeft === 1 ? 'Kal dena hai!' : `${daysLeft} din baaqi`}
                  </p>
                </div>
                <button onClick={() => setDismissedReminders(d => [...d, exp.id])}
                  className="text-amber-400 text-[10px] font-bold px-2 py-1 rounded-lg active:bg-amber-100 transition-all">
                  &#x2715;
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Net Worth — one clean white card per currency. The ring on the right
          visualises this month's savings rate: (income − expense) / income.
          Green when saving, rose when net-negative, grey when no activity. */}
      <div className="px-5 pt-5">
        {Object.keys(totals).length > 0 ? (
          <div className="grid grid-cols-1 gap-3">
            {Object.entries(totals).map(([currency, total]) => {
              const meta = currencyMeta[currency];
              const now = new Date();
              const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
              const monthTxns = transactions.filter(tx =>
                new Date(tx.createdAt) >= startOfMonth && tx.currency === currency,
              );
              const monthIncome = monthTxns.filter(tx => tx.type === 'income').reduce((s, tx) => s + tx.amount, 0);
              const monthExpense = monthTxns.filter(tx => tx.type === 'expense').reduce((s, tx) => s + tx.amount, 0);
              const hasActivity = monthIncome > 0 || monthExpense > 0;
              const savingsRate = monthIncome > 0 ? (monthIncome - monthExpense) / monthIncome : 0;
              const ringProgress = hasActivity ? Math.max(0, Math.min(1, savingsRate)) : 0;
              const ringColor = !hasActivity ? '#cbd5e1' : savingsRate >= 0 ? '#10b981' : '#f43f5e';
              const ringLabel = !hasActivity
                ? '—'
                : savingsRate >= 0
                  ? `${Math.round(savingsRate * 100)}%`
                  : '!';
              const accountCount = accounts.filter(a => a.currency === currency).length;

              return (
                <div
                  key={currency}
                  className="card-premium p-4 flex items-center gap-4 animate-scale-in"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px]">{meta?.flag}</span>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Total {currency}
                      </p>
                    </div>
                    <p className="text-[26px] font-extrabold tracking-tight text-slate-800 mt-1 tabular-nums animate-count-up">
                      {formatMoney(total, currency)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
                      {hasActivity && (
                        <span className={`ml-2 font-semibold ${savingsRate >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                          · {savingsRate >= 0 ? 'Saving' : 'Overspending'} this month
                        </span>
                      )}
                    </p>
                  </div>
                  <ProgressRing
                    size={56}
                    strokeWidth={5}
                    progress={ringProgress}
                    color={ringColor}
                    trackColor="#f1f5f9"
                  >
                    <span className={`text-[11px] font-extrabold tabular-nums ${
                      !hasActivity ? 'text-slate-400' : savingsRate >= 0 ? 'text-emerald-600' : 'text-rose-500'
                    }`}>
                      {ringLabel}
                    </span>
                  </ProgressRing>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title={t('home_no_accounts')}
            description={t('home_no_accounts_desc')}
            actionLabel={t('home_create_account')}
            onAction={() => setShowAddAccount(true)}
          />
        )}
      </div>

      {/* Quick Stats Row — one chip per currency, so AED vs PKR stays clear. */}
      {(hasReceivables || hasPayables || goals.length > 0) && (
        <div className="px-5 pt-4 flex gap-2.5 overflow-x-auto no-scrollbar">
          {receivableEntries.map(([cur, amt]) => (
            <button
              key={`recv-${cur}`}
              onClick={() => navigate('/loans')}
              className="shrink-0 card-premium !rounded-2xl px-4 py-3 flex items-center gap-2.5 !border-emerald-100/60"
            >
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100/50 flex items-center justify-center">
                <ArrowDownLeft size={14} className="text-emerald-600" />
              </div>
              <div className="text-left">
                <p className="text-[10px] text-emerald-600 font-semibold tracking-wide">{t('loan_receivable')}</p>
                <p className="text-[13px] font-bold text-emerald-700 tabular-nums">{formatMoney(amt, cur as typeof loans[0]['currency'])}</p>
              </div>
            </button>
          ))}
          {payableEntries.map(([cur, amt]) => (
            <button
              key={`pay-${cur}`}
              onClick={() => navigate('/loans')}
              className="shrink-0 card-premium !rounded-2xl px-4 py-3 flex items-center gap-2.5 !border-red-100/60"
            >
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-red-50 to-red-100/50 flex items-center justify-center">
                <ArrowUpRight size={14} className="text-red-500" />
              </div>
              <div className="text-left">
                <p className="text-[10px] text-red-500 font-semibold tracking-wide">{t('loan_payable')}</p>
                <p className="text-[13px] font-bold text-red-600 tabular-nums">{formatMoney(amt, cur as typeof loans[0]['currency'])}</p>
              </div>
            </button>
          ))}
          {goals.length > 0 && (
            <button
              onClick={() => navigate('/goals')}
              className="shrink-0 card-premium !rounded-2xl px-4 py-3 flex items-center gap-2.5 !border-purple-100/60"
            >
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-50 to-purple-100/50 flex items-center justify-center">
                <span className="text-sm">&#x1f3af;</span>
              </div>
              <div className="text-left">
                <p className="text-[10px] text-purple-600 font-semibold tracking-wide">{goals.length} Goals</p>
                <p className="text-[13px] font-bold text-purple-700">Active</p>
              </div>
            </button>
          )}
        </div>
      )}

      {/* Analytics Banner */}
      {accounts.length > 0 && transactions.length > 0 && (
        <div className="px-5 pt-4">
          <button onClick={() => navigate('/analytics')}
            className="w-full bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 rounded-2xl p-4 flex items-center gap-3 text-white active:scale-[0.98] transition-all shadow-md shadow-indigo-500/20">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center backdrop-blur-sm">
              <BarChart3 size={20} strokeWidth={2} />
            </div>
            <div className="flex-1 text-left">
              <p className="text-[13px] font-bold tracking-tight">{t('analytics_title')}</p>
              <p className="text-[10px] text-white/70">{t('analytics_banner_desc')}</p>
            </div>
            <span className="text-white/60 text-lg">→</span>
          </button>
        </div>
      )}

      {/* Accounts */}
      {accounts.length > 0 && (
        <div className="px-5 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{t('home_accounts')}</h2>
            <button
              onClick={() => setShowAddAccount(true)}
              className="text-[11px] text-indigo-600 font-bold active:opacity-70 tracking-tight flex items-center gap-1"
              aria-label="Add account"
            >
              <Plus size={12} strokeWidth={2.5} /> Add
            </button>
          </div>
          <div className="space-y-2.5">
            {accounts.map((a, i) => {
              // Find nearest upcoming expense for this account (within 30 days)
              const upcomingForAccount = expenses
                .filter(e => e.accountId === a.id && e.status === 'upcoming')
                .filter(e => Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) <= 30)
                .sort((x, y) => new Date(x.dueDate).getTime() - new Date(y.dueDate).getTime());
              const nearest = upcomingForAccount[0] ?? null;
              return (
                <div key={a.id} className="animate-fade-in" style={{ animationDelay: `${i * 60}ms` }}>
                  <AccountCard account={a} onClick={() => navigate(`/account/${a.id}`)} nearestExpense={nearest} monthStats={getMonthStats(a.id)} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upcoming Expenses Dashboard Widget */}
      {(() => {
        const upcomingList = expenses
          .filter(e => e.status === 'upcoming')
          .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
          .slice(0, 3);
        if (upcomingList.length === 0) return null;
        return (
          <div className="px-5 pt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{t('home_upcoming')}</h2>
              <button onClick={() => navigate('/goals')} className="text-[11px] text-indigo-600 font-bold active:opacity-70 tracking-tight">
                {t('home_see_all_upcoming')} &#x2192;
              </button>
            </div>
            <div className="card-premium px-4 divide-y divide-slate-100/60">
              {upcomingList.map(exp => {
                const daysLeft = Math.ceil((new Date(exp.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                return (
                  <div key={exp.id} className="flex items-center gap-3 py-3.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
                      <span className="text-sm">&#x1f4c5;</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-slate-800 truncate tracking-tight">{exp.title}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{exp.category}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[13px] font-bold text-slate-800 tabular-nums">{formatMoney(exp.amount, exp.currency)}</p>
                      <p className={`text-[9px] font-bold mt-0.5 ${daysLeft <= 0 ? 'text-red-500' : daysLeft <= 7 ? 'text-amber-500' : 'text-slate-400'}`}>
                        {daysLeft <= 0 ? 'Overdue' : `${daysLeft} ${t('upcoming_due_in')}`}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Empty dashboard guidance — accounts exist but no transactions yet */}
      {accounts.length > 0 && transactions.length === 0 && (
        <div className="px-5 pt-8 pb-4 flex flex-col items-center text-center animate-fade-in">
          <div className="w-14 h-14 rounded-3xl bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center mb-4 shadow-sm shadow-indigo-500/5">
            <span className="text-2xl">&#x1f4b8;</span>
          </div>
          <p className="text-[14px] font-bold text-slate-700 tracking-tight">{t('empty_dash_title')}</p>
          <p className="text-[12px] text-slate-400 mt-1 max-w-[240px] leading-relaxed">{t('empty_dash_desc')}</p>
          <div className="mt-5 flex items-center gap-2 text-indigo-500 animate-bounce">
            <span className="text-[11px] font-bold tracking-wide">{t('empty_dash_tap')}</span>
            <span className="text-lg">&#x2192;</span>
          </div>
        </div>
      )}

      {/* Recent Transactions */}
      {recentTxns.length > 0 && (
        <div className="px-5 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{t('home_recent')}</h2>
            <button onClick={() => navigate('/transactions')} className="text-[11px] text-indigo-600 font-bold active:opacity-70 tracking-tight">
              {t('home_see_all')} &#x2192;
            </button>
          </div>
          <div className="card-premium px-4 divide-y divide-slate-100/60">
            {recentTxns.map((txn) => (
              <TransactionItem key={txn.id} transaction={txn} />
            ))}
          </div>
        </div>
      )}

      <AddAccountStepper open={showAddAccount} onClose={() => setShowAddAccount(false)} />
    </div>
  );
}
