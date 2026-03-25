import { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useTransactionStore } from '../stores/transactionStore';
import { useSplitStore } from '../stores/splitStore';
import { useAppModeStore } from '../stores/appModeStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { groupByCategory, monthlyTrend, dailySpending, topExpenses } from '../lib/analytics';

type Period = 'this_month' | 'last_month' | '3months' | 'year';

function getDateRange(period: Period): [Date, Date] {
  const now = new Date();
  switch (period) {
    case 'this_month': return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)];
    case '3months': return [new Date(now.getFullYear(), now.getMonth() - 2, 1), now];
    case 'year': return [new Date(now.getFullYear(), 0, 1), now];
  }
}

export function AnalyticsPage() {
  const t = useT();
  const mode = useAppModeStore(s => s.mode);
  const { transactions, loadTransactions } = useTransactionStore();
  const { groups, loadGroups, getGroupExpenses } = useSplitStore();
  const [period, setPeriod] = useState<Period>('this_month');

  useEffect(() => { loadTransactions(); loadGroups(); }, [loadTransactions, loadGroups]);

  const [start, end] = useMemo(() => getDateRange(period), [period]);

  const categories = useMemo(() => groupByCategory(transactions, start, end), [transactions, start, end]);
  const trend = useMemo(() => monthlyTrend(transactions, period === 'year' ? 12 : period === '3months' ? 3 : 2), [transactions, period]);
  const daily = useMemo(() => dailySpending(transactions, start, end), [transactions, start, end]);
  const topExp = useMemo(() => topExpenses(transactions, start, end), [transactions, start, end]);

  const totalSpent = categories.reduce((s, c) => s + c.amount, 0);
  const totalIncome = transactions.filter(tx => tx.type === 'income' && new Date(tx.createdAt) >= start && new Date(tx.createdAt) <= end).reduce((s, tx) => s + tx.amount, 0);
  const currency = localStorage.getItem('hisaab_primary_currency') || 'PKR';

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: t('analytics_this_month') },
    { key: 'last_month', label: t('analytics_last_month') },
    { key: '3months', label: t('analytics_3months') },
    { key: 'year', label: t('analytics_year') },
  ];

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader title={t('analytics_title')} action={<LanguageToggle />} />

      {/* Period selector */}
      <div className="px-5 pt-4 flex gap-2 overflow-x-auto no-scrollbar">
        {periods.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`shrink-0 px-3.5 py-2 rounded-xl text-[11px] font-bold transition-all ${period === p.key ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200/60 text-slate-500'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="px-5 pt-4 grid grid-cols-2 gap-2.5">
        <div className="card-premium p-4">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{t('analytics_total_spent')}</p>
          <p className="text-lg font-bold text-red-500 mt-1 tabular-nums">{formatMoney(totalSpent, currency)}</p>
        </div>
        <div className="card-premium p-4">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{t('analytics_total_income')}</p>
          <p className="text-lg font-bold text-emerald-600 mt-1 tabular-nums">{formatMoney(totalIncome, currency)}</p>
        </div>
      </div>

      {totalSpent === 0 && totalIncome === 0 ? (
        <div className="px-5 pt-12 text-center">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-slate-400 text-sm">{t('analytics_no_data')}</p>
        </div>
      ) : (
        <>
          {/* Category Pie Chart */}
          {categories.length > 0 && (
            <div className="px-5 pt-6">
              <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('analytics_categories')}</h2>
              <div className="card-premium p-4">
                <div className="flex items-center">
                  <ResponsiveContainer width="50%" height={140}>
                    <PieChart>
                      <Pie data={categories} dataKey="amount" nameKey="category" cx="50%" cy="50%" outerRadius={55} innerRadius={30}>
                        {categories.map((c, i) => <Cell key={i} fill={c.color} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5 pl-2">
                    {categories.slice(0, 5).map(c => (
                      <div key={c.category} className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                        <span className="text-[11px] text-slate-600 truncate flex-1">{c.category}</span>
                        <span className="text-[11px] font-bold text-slate-700 tabular-nums">{c.percentage}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Monthly Trend */}
          {trend.length > 0 && (
            <div className="px-5 pt-6">
              <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('analytics_trend')}</h2>
              <div className="card-premium p-4">
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={trend}>
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={40} />
                    <Tooltip formatter={(value: number) => formatMoney(value, currency)} />
                    <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} name="Income" />
                    <Bar dataKey="expense" fill="#ef4444" radius={[4, 4, 0, 0]} name="Expense" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Daily Spending */}
          {daily.some(d => d.amount > 0) && (
            <div className="px-5 pt-6">
              <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('analytics_daily')}</h2>
              <div className="card-premium p-4">
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={daily}>
                    <XAxis dataKey="day" tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(value: number) => formatMoney(value, currency)} />
                    <Bar dataKey="amount" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Expenses */}
          {topExp.length > 0 && (
            <div className="px-5 pt-6">
              <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('analytics_top')}</h2>
              <div className="card-premium divide-y divide-slate-100/60">
                {topExp.map(tx => (
                  <div key={tx.id} className="px-4 py-3 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-semibold text-slate-700 truncate">{tx.category || 'Other'}</p>
                      <p className="text-[10px] text-slate-400 truncate">{tx.notes || ''}</p>
                    </div>
                    <p className="text-[13px] font-bold text-red-500 tabular-nums shrink-0 ml-2">{formatMoney(tx.amount, tx.currency)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
