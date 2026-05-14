import { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useTransactionStore } from '../stores/transactionStore';
import { useSplitStore } from '../stores/splitStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { groupByCategory, monthlyTrend, dailySpending, topExpenses } from '../lib/analytics';
import { parseInternalNote } from '../lib/internalNotes';
import type { Currency, Transaction } from '../db';

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

function inRange(tx: Transaction, start: Date, end: Date) {
  const date = new Date(tx.createdAt);
  return date >= start && date <= end;
}

function sumByCurrency(transactions: Transaction[], type: 'expense' | 'income', start: Date, end: Date) {
  const totals = new Map<Currency, number>();
  transactions
    .filter(tx => tx.type === type && inRange(tx, start, end))
    .forEach(tx => totals.set(tx.currency, (totals.get(tx.currency) ?? 0) + tx.amount));

  return Array.from(totals.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

function MoneyLines({ totals, tone }: { totals: { currency: Currency; amount: number }[]; tone: 'expense' | 'income' }) {
  const color = tone === 'expense' ? 'text-pay-text' : 'text-receive-text';

  if (totals.length === 0) {
    return <p className={`text-lg font-bold mt-1 tabular-nums ${color}`}>0.00</p>;
  }

  return (
    <div className="mt-1 space-y-0.5">
      {totals.map(({ currency, amount }) => (
        <p key={currency} className={`text-[15px] font-bold tabular-nums leading-tight ${color}`}>
          {formatMoney(amount, currency)}
        </p>
      ))}
    </div>
  );
}

function getTransactionSubtitle(tx: Transaction) {
  const parsedNote = parseInternalNote(tx.notes);
  return parsedNote.visibleNote || parsedNote.meta.expenseDescription || '';
}

export function AnalyticsPage() {
  const t = useT();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loadGroups } = useSplitStore();
  const [period, setPeriod] = useState<Period>('this_month');
  const [selectedCurrency, setSelectedCurrency] = useState<Currency | null>(null);

  useEffect(() => { loadTransactions(); loadGroups(); }, [loadTransactions, loadGroups]);

  const [start, end] = useMemo(() => getDateRange(period), [period]);

  const periodTransactions = useMemo(
    () => transactions.filter(tx => inRange(tx, start, end)),
    [transactions, start, end],
  );
  const currencies = useMemo(() => {
    const activeCurrencies = new Set<Currency>();
    periodTransactions
      .filter(tx => tx.type === 'expense' || tx.type === 'income')
      .forEach(tx => activeCurrencies.add(tx.currency));
    return Array.from(activeCurrencies).sort();
  }, [periodTransactions]);
  const primaryCurrency = (localStorage.getItem('hisaab_primary_currency') || 'PKR') as Currency;
  const chartCurrency = selectedCurrency && currencies.includes(selectedCurrency)
    ? selectedCurrency
    : currencies.includes(primaryCurrency)
      ? primaryCurrency
      : currencies[0] ?? primaryCurrency;
  const chartTransactions = useMemo(
    () => transactions.filter(tx => tx.currency === chartCurrency),
    [transactions, chartCurrency],
  );

  const categories = useMemo(() => groupByCategory(chartTransactions, start, end), [chartTransactions, start, end]);
  const trend = useMemo(() => monthlyTrend(chartTransactions, period === 'year' ? 12 : period === '3months' ? 3 : 2), [chartTransactions, period]);
  const daily = useMemo(() => dailySpending(chartTransactions, start, end), [chartTransactions, start, end]);
  const topExp = useMemo(() => topExpenses(chartTransactions, start, end), [chartTransactions, start, end]);

  const spentByCurrency = useMemo(() => sumByCurrency(transactions, 'expense', start, end), [transactions, start, end]);
  const incomeByCurrency = useMemo(() => sumByCurrency(transactions, 'income', start, end), [transactions, start, end]);
  const hasAnyData = spentByCurrency.length > 0 || incomeByCurrency.length > 0;

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: t('analytics_this_month') },
    { key: 'last_month', label: t('analytics_last_month') },
    { key: '3months', label: t('analytics_3months') },
    { key: 'year', label: t('analytics_year') },
  ];

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar title={t('analytics_title')} back action={<LanguageToggle />} />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            Spend & income trends
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] pt-4">
      <div className="px-5 flex gap-2 overflow-x-auto no-scrollbar">
        {periods.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`shrink-0 px-3.5 py-2 rounded-xl text-[11px] font-bold transition-all ${period === p.key ? 'bg-ink-900 text-white' : 'bg-cream-card border border-cream-border text-ink-500'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="px-5 pt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
          <p className="text-[10px] text-ink-500 font-bold uppercase tracking-widest">{t('analytics_total_spent')}</p>
          <MoneyLines totals={spentByCurrency} tone="expense" />
        </div>
        <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
          <p className="text-[10px] text-ink-500 font-bold uppercase tracking-widest">{t('analytics_total_income')}</p>
          <MoneyLines totals={incomeByCurrency} tone="income" />
        </div>
      </div>

      {currencies.length > 1 && (
        <div className="px-5 pt-3">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <span className="text-[10px] font-bold uppercase tracking-widest text-ink-500 shrink-0">{t('analytics_currency')}</span>
            {currencies.map(currency => (
              <button
                key={currency}
                onClick={() => setSelectedCurrency(currency)}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all ${
                  chartCurrency === currency
                    ? 'bg-slate-800 text-white'
                    : 'bg-white border border-slate-200/60 text-ink-500'
                }`}
              >
                {currency}
              </button>
            ))}
          </div>
        </div>
      )}

      {!hasAnyData ? (
        <div className="px-5 pt-12 text-center">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-ink-500 text-sm">{t('analytics_no_data')}</p>
        </div>
      ) : (
        <>
          {/* Category Pie Chart */}
          {categories.length > 0 && (
            <div className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">{t('analytics_categories')}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
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
                        <span className="text-[11px] font-bold text-ink-800 tabular-nums">{c.percentage}%</span>
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
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">{t('analytics_trend')}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={trend}>
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={40} />
                    <Tooltip formatter={(value: unknown) => formatMoney(Number(value), chartCurrency)} />
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
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">{t('analytics_daily')}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={daily}>
                    <XAxis dataKey="day" tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(value: unknown) => formatMoney(Number(value), chartCurrency)} />
                    <Bar dataKey="amount" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Expenses */}
          {topExp.length > 0 && (
            <div className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">{t('analytics_top')}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-slate-100/60">
                {topExp.map(tx => {
                  const subtitle = getTransactionSubtitle(tx);
                  return (
                    <div key={tx.id} className="px-4 py-3 flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold text-ink-800 truncate">{tx.category || 'Other'}</p>
                        {subtitle ? <p className="text-[10px] text-ink-500 truncate">{subtitle}</p> : null}
                      </div>
                      <p className="text-[13px] font-bold text-pay-text tabular-nums shrink-0 ml-2">{formatMoney(tx.amount, tx.currency)}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </main>
  );
}
