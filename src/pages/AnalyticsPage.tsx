import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import { useTransactionStore } from '../stores/transactionStore';
import { useSplitStore } from '../stores/splitStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Card3D } from '../components/Card3D';
import { ListSkeleton } from '../components/ListSkeleton';
import { PageErrorState } from '../components/PageErrorState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import {
  dailySpending,
  dailySpendingFromSeries,
  endOfMonthExact,
  groupByCategory,
  groupByCategoryFromSummary,
  monthlyTrend,
  monthlyTrendFromSummary,
  sumByCurrency,
  sumByCurrencyFromSummary,
  summaryCurrencies,
  topExpenses,
  topExpensesFromRows,
  toTopExpenseRow,
  totalFromSummary,
  type DailySeriesRow,
  type MonthlySummaryRow,
  type TopExpenseRow,
} from '../lib/analytics';
import { analyticsDb } from '../lib/supabaseDb';
import { reportError } from '../lib/errorReporter';
import { parseInternalNote } from '../lib/internalNotes';
import type { Currency, Transaction } from '../db';

// Audit P2 M2 / 03-performance H3: this page used to sum the user's ENTIRE
// transaction history in the browser, on every render pass.
//
// M2(c) moved the summary cards, the currency chips and the category pie into
// `analytics_monthly_summary`. M2(d) — this pass — adds
// `analytics_daily_series` and `analytics_top_expenses`
// (supabase-migration-p2-analytics-aggregates-2.sql) and, because the monthly
// trend's bucket-end bug is now fixed in TypeScript (`endOfMonthExact`), serves
// the trend and the spend-trend card from the SAME monthly-summary RPC over
// their own windows. With all of it answering, this page NO LONGER CALLS
// `loadTransactions()` at all — the unbounded full-history fetch is gone from
// the Analytics surface.
//
// OFF by default, and off means OFF: with the flag unset nothing here calls a
// single RPC, the page loads transactions exactly as it always did, and every
// figure comes from exactly the same expression as before.
//
// FAILS SOFT: if ANY of the five calls errors (unapplied migration → PGRST202,
// offline, timeout), the failure is reported and the page falls back to
// `loadTransactions()` + the client aggregation. A finance app must never
// answer "how much did I spend" with a blank card because a request failed.
const ANALYTICS_RPC_ENABLED = import.meta.env.VITE_ANALYTICS_RPC === 'true';

type Period = 'this_month' | 'last_month' | '3months' | 'year';

/** The top-expenses list length. One constant, both paths (and the RPC's p_limit). */
const TOP_EXPENSE_LIMIT = 5;

// `now` is passed in rather than read inside, so the period window, the
// previous window and the trend buckets are all cut from ONE instant. Two
// `new Date()` calls a millisecond apart across a midnight boundary would
// otherwise put the cards and the chart in different months.
function getDateRange(period: Period, now: Date): [Date, Date] {
  switch (period) {
    case 'this_month': return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    // endOfMonthExact, not `new Date(y, m, 0, 23, 59, 59)`: the old form
    // dropped the last 999 ms of the month — see src/lib/analytics.ts.
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 1)];
    case '3months': return [new Date(now.getFullYear(), now.getMonth() - 2, 1), now];
    case 'year': return [new Date(now.getFullYear(), 0, 1), now];
  }
}

/** How many month buckets the trend chart shows for a period. */
function trendMonthsFor(period: Period): number {
  return period === 'year' ? 12 : period === '3months' ? 3 : 2;
}

/** The window covering every bucket `monthlyTrend` will walk, whole months. */
function trendRange(period: Period, now: Date): [Date, Date] {
  const months = trendMonthsFor(period);
  return [
    new Date(now.getFullYear(), now.getMonth() - (months - 1), 1),
    endOfMonthExact(now.getFullYear(), now.getMonth()),
  ];
}

function inRange(tx: Transaction, start: Date, end: Date) {
  const date = new Date(tx.createdAt);
  return date >= start && date <= end;
}

// The comparable window immediately before the selected period — used for the
// "vs previous period" spend trend. Every end is `endOfMonthExact` now: the old
// `…, 0, 23, 59, 59` form silently excluded anything stamped in the final
// 999 ms of the month from BOTH the period and its comparison.
function previousRange(period: Period, now: Date): [Date, Date] {
  switch (period) {
    case 'this_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 1)];
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 2, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 2)];
    case '3months': return [new Date(now.getFullYear(), now.getMonth() - 5, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 3)];
    case 'year': return [new Date(now.getFullYear() - 1, 0, 1), endOfMonthExact(now.getFullYear() - 1, 11)];
  }
}

// `sumByCurrency` used to live here; it moved verbatim into src/lib/analytics.ts
// so the RPC path (`sumByCurrencyFromSummary`) has something a unit test can be
// proven equal to. Behaviour is unchanged — same filter, same sort.

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

// Takes the raw note rather than a Transaction, because the top-expenses list
// is now fed by `TopExpenseRow` (six columns) on the RPC path and by a narrowed
// Transaction on the client path — one renderer, one shape.
function getTransactionSubtitle(notes: string) {
  const parsedNote = parseInternalNote(notes);
  return parsedNote.visibleNote || parsedNote.meta.expenseDescription || '';
}

export function AnalyticsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { transactions, loadTransactions } = useTransactionStore();
  // The client-side fallback aggregation is a "must be complete" consumer —
  // see loadEverything below (docs/performance.md §7).
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const { loadGroups } = useSplitStore();
  // The selected period AND the instant it was selected at, as ONE state value.
  // Every window on the screen — the period, its previous comparable window and
  // the trend buckets — is cut from that single instant, so the cards and the
  // charts can never disagree about which month it is (a page left open across
  // midnight used to be able to do exactly that).
  const [{ period, now }, setPeriodState] = useState<{ period: Period; now: Date }>(
    () => ({ period: 'this_month', now: new Date() }),
  );
  const setPeriod = useCallback(
    (next: Period) => setPeriodState({ period: next, now: new Date() }),
    [],
  );
  const [selectedCurrency, setSelectedCurrency] = useState<Currency | null>(null);

  // Audit UX-09: Analytics was the sole core page still firing a
  // fire-and-forget effect. It had no error state (a failed fetch was
  // indistinguishable from "you have no spending data" — a lie in a finance
  // app) and it rendered the empty state on the very first frame, before the
  // store's Supabase fetch had returned. Same useAsyncLoad + skeleton +
  // PageErrorState contract as HomePage/TransactionsPage/AccountsPage.
  // ── SQL-side analytics (audit P2 M2) ─────────────────────────────────────
  // `rpcFailed` is the fallback latch: once ANY of the five calls errors, this
  // page behaves exactly as it did before M2 — it loads the full history and
  // aggregates in the browser. `loadEverything`'s identity changes with it, so
  // useAsyncLoad re-runs and actually fetches the rows the fallback needs.
  const [rpcFailed, setRpcFailed] = useState(false);
  const needsClientRows = !ANALYTICS_RPC_ENABLED || rpcFailed;

  const loadEverything = useCallback(async () => {
    // Groups are loaded in both modes; the transaction rows only when the
    // client aggregation is the one that will run.
    //
    // When it does run it must run on the COMPLETE history, not the store's
    // default 12-month window: the period selector offers "this year" and "all
    // time", and `monthlyTrend` walks six months back regardless of the
    // selected period. A windowed store would render those as smaller numbers
    // with no visible difference from real ones — the single worst failure mode
    // a finance app has. `ensureTransactionHistory` is a no-op once coverage is
    // complete, so this costs one walk per session, not one per period tap.
    await Promise.all([
      // `loadTransactions` first so the warm Dexie mirror still serves the
      // rows; `ensureTransactionHistory` then resolves without a request
      // whenever that load already proved completeness (every user under the
      // 1000-row floor), and pages the rest in when it did not.
      needsClientRows
        ? loadTransactions().then(() => ensureTransactionHistory({ all: true }))
        : Promise.resolve(),
      loadGroups(),
    ]);
  }, [needsClientRows, loadTransactions, ensureTransactionHistory, loadGroups]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(loadEverything);

  const [start, end] = useMemo(() => getDateRange(period, now), [period, now]);

  // The rows the RPC path holds. Null in four cases, each of which falls
  // straight back to the client aggregation below: the flag is off, the calls
  // have not resolved yet, they failed, or the period changed and the answer we
  // hold belongs to the previous window. The window travels WITH the rows, so a
  // period switch invalidates them by comparison rather than by an extra
  // synchronous setState inside the effect (react-hooks/set-state-in-effect).
  const windowKey = `${start.getTime()}:${end.getTime()}`;
  const [rpcResult, setRpcResult] = useState<{
    key: string;
    /** The selected period — cards, chips, pie. */
    summary: MonthlySummaryRow[];
    /** The trend's own window (whole months back from now). */
    trend: MonthlySummaryRow[];
    /** The comparable previous window — the spend-trend card. */
    previous: MonthlySummaryRow[];
    daily: DailySeriesRow[];
    top: TopExpenseRow[];
  } | null>(null);

  useEffect(() => {
    if (!ANALYTICS_RPC_ENABLED || rpcFailed) return;
    let cancelled = false;
    const [trendStart, trendEnd] = trendRange(period, now);
    const [prevStart, prevEnd] = previousRange(period, now);
    // Five aggregate calls in parallel, each returning tens of rows, replacing
    // a paged walk of the entire transactions table.
    Promise.all([
      analyticsDb.monthlySummary(start, end),
      analyticsDb.monthlySummary(trendStart, trendEnd),
      analyticsDb.monthlySummary(prevStart, prevEnd),
      analyticsDb.dailySeries(start, end),
      analyticsDb.topExpenses(start, end, TOP_EXPENSE_LIMIT),
    ])
      .then(([summary, trend, previous, daily, top]) => {
        if (!cancelled) setRpcResult({ key: windowKey, summary, trend, previous, daily, top });
      })
      .catch((err) => {
        if (cancelled) return;
        reportError(err, { feature: 'AnalyticsPage.analyticsRpcs' });
        // Latch the fallback: re-running the RPCs on every period change when
        // the migration simply is not applied would be five failed requests a
        // tap. One failure, one fallback, for the life of the screen.
        setRpcFailed(true);
        setRpcResult(null);
      });
    return () => { cancelled = true; };
  }, [start, end, windowKey, period, now, rpcFailed]);

  const rpc = rpcResult?.key === windowKey ? rpcResult : null;
  const rpcRows = rpc?.summary ?? null;
  // On the RPC path the skeleton is owned by the RPC's own in-flight state —
  // `transactions` is deliberately empty and never arrives.
  const isInitialLoading = needsClientRows
    ? loadStatus === 'loading' && transactions.length === 0
    : rpc === null && loadStatus !== 'error';

  const periodTransactions = useMemo(
    () => transactions.filter(tx => inRange(tx, start, end)),
    [transactions, start, end],
  );
  const currencies = useMemo(() => {
    if (rpcRows) return summaryCurrencies(rpcRows);
    const activeCurrencies = new Set<Currency>();
    periodTransactions
      .filter(tx => tx.type === 'expense' || tx.type === 'income')
      .forEach(tx => activeCurrencies.add(tx.currency));
    return Array.from(activeCurrencies).sort();
  }, [periodTransactions, rpcRows]);
  // UX-34: was the PKR-fallback outlier while ~19 other screens fell back to
  // AED. One helper, one fallback — see src/lib/primaryCurrency.ts.
  const primaryCurrency = getPrimaryCurrency();
  const chartCurrency = selectedCurrency && currencies.includes(selectedCurrency)
    ? selectedCurrency
    : currencies.includes(primaryCurrency)
      ? primaryCurrency
      : currencies[0] ?? primaryCurrency;
  const chartTransactions = useMemo(
    () => transactions.filter(tx => tx.currency === chartCurrency),
    [transactions, chartCurrency],
  );

  // Carry the selected period + currency into the drill-in so it shows the same
  // window the user is looking at, not a hardcoded current-month/primary view.
  const insightHref = (category: string) =>
    `/hisaab-ai/insight/${encodeURIComponent(category)}?from=${start.toISOString()}&to=${end.toISOString()}&cur=${chartCurrency}`;

  const categories = useMemo(
    () => (rpcRows
      ? groupByCategoryFromSummary(rpcRows, chartCurrency)
      : groupByCategory(chartTransactions, start, end)),
    [rpcRows, chartCurrency, chartTransactions, start, end],
  );
  const trend = useMemo(
    () => (rpc
      ? monthlyTrendFromSummary(rpc.trend, chartCurrency, trendMonthsFor(period), now)
      : monthlyTrend(chartTransactions, trendMonthsFor(period), now)),
    [rpc, chartCurrency, chartTransactions, period, now],
  );
  const daily = useMemo(
    () => (rpc
      ? dailySpendingFromSeries(rpc.daily, chartCurrency, start, end)
      : dailySpending(chartTransactions, start, end)),
    [rpc, chartCurrency, chartTransactions, start, end],
  );
  const topExp = useMemo(
    () => (rpc
      ? topExpensesFromRows(rpc.top, chartCurrency, TOP_EXPENSE_LIMIT)
      : topExpenses(chartTransactions, start, end, TOP_EXPENSE_LIMIT).map(toTopExpenseRow)),
    [rpc, chartCurrency, chartTransactions, start, end],
  );

  // Spend trend vs the previous comparable window, in the chart currency.
  const spendCompare = useMemo(() => {
    const cur = rpc
      ? totalFromSummary(rpc.summary, 'expense', chartCurrency)
      : chartTransactions.filter((tx) => tx.type === 'expense' && inRange(tx, start, end)).reduce((s, tx) => s + tx.amount, 0);
    const prev = rpc
      ? totalFromSummary(rpc.previous, 'expense', chartCurrency)
      : (() => {
          const [pStart, pEnd] = previousRange(period, now);
          return chartTransactions.filter((tx) => tx.type === 'expense' && inRange(tx, pStart, pEnd)).reduce((s, tx) => s + tx.amount, 0);
        })();
    if (prev <= 0) return null;
    return { pct: Math.round(((cur - prev) / prev) * 100) };
  }, [rpc, chartCurrency, chartTransactions, period, start, end, now]);

  const spentByCurrency = useMemo(
    () => (rpcRows
      ? sumByCurrencyFromSummary(rpcRows, 'expense')
      : sumByCurrency(transactions, 'expense', start, end)),
    [rpcRows, transactions, start, end],
  );
  const incomeByCurrency = useMemo(
    () => (rpcRows
      ? sumByCurrencyFromSummary(rpcRows, 'income')
      : sumByCurrency(transactions, 'income', start, end)),
    [rpcRows, transactions, start, end],
  );
  const hasAnyData = spentByCurrency.length > 0 || incomeByCurrency.length > 0;

  // Net = income − spent, kept per-currency (never summed across currencies).
  // Ordered largest-magnitude first so the headline line is the dominant one.
  const netByCurrency = useMemo(() => {
    const byCur = new Map<Currency, number>();
    for (const { currency, amount } of incomeByCurrency) byCur.set(currency, (byCur.get(currency) ?? 0) + amount);
    for (const { currency, amount } of spentByCurrency) byCur.set(currency, (byCur.get(currency) ?? 0) - amount);
    return Array.from(byCur.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.currency.localeCompare(b.currency));
  }, [incomeByCurrency, spentByCurrency]);

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: t('analytics_this_month') },
    { key: 'last_month', label: t('analytics_last_month') },
    { key: '3months', label: t('analytics_3months') },
    { key: 'year', label: t('analytics_year') },
  ];
  const periodLabel = periods.find((p) => p.key === period)?.label ?? '';

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar title={t('analytics_title')} back action={<LanguageToggle />} />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {t('analytics_hero_sub')}
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

      {/* Period echo beside the cards so the figures are never ambiguous. */}
      <div className="px-5 pt-4 flex items-center justify-between gap-2">
        <p className="text-[10px] text-ink-500 font-semibold uppercase tracking-[0.12em]">
          {t('analytics_showing')} · {periodLabel}
        </p>
      </div>

      {/* Summary cards. 3D clay tier 2 — informational, never tappable. The
          tint carries the money direction the page already colours the
          numbers with: coral out, mint in. */}
      <div className="px-5 pt-2 grid grid-cols-2 gap-2.5">
        <Card3D tint="coral" padding="sm">
          <p className="text-[10px] text-ink-500 font-bold uppercase tracking-widest">{t('analytics_total_spent')}</p>
          <MoneyLines totals={spentByCurrency} tone="expense" />
        </Card3D>
        <Card3D tint="mint" padding="sm">
          <p className="text-[10px] text-ink-500 font-bold uppercase tracking-widest">{t('analytics_total_income')}</p>
          <MoneyLines totals={incomeByCurrency} tone="income" />
        </Card3D>
      </div>

      {/* Spend trend vs the previous comparable period (chart currency). For
          spending, up is coral (watch out), down is green (nice). */}
      {spendCompare && (
        <div className="px-5 pt-2.5">
          <div className="rounded-2xl bg-cream-card border border-cream-border px-4 py-3 flex items-center justify-between gap-2">
            <p className="text-[11px] text-ink-500 font-semibold uppercase tracking-widest">{t('analytics_spend_trend')} · {chartCurrency}</p>
            {spendCompare.pct === 0 ? (
              <span className="text-[12px] font-semibold text-ink-500">{t('analytics_no_change')}</span>
            ) : (
              <span className={`inline-flex items-center gap-1 text-[12.5px] font-bold ${spendCompare.pct > 0 ? 'text-pay-text' : 'text-receive-text'}`}>
                {spendCompare.pct > 0 ? <TrendingUp size={13} strokeWidth={2.4} /> : <TrendingDown size={13} strokeWidth={2.4} />}
                {Math.abs(spendCompare.pct)}% {t('analytics_vs_prev')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Net (income − spent) per currency. Coloured + signed so it's never
          colour-only: a leading +/− pairs with the receive/pay tint. */}
      {hasAnyData && netByCurrency.length > 0 && (
        <div className="px-5 pt-2.5">
          <div className="rounded-2xl bg-cream-card border border-cream-border px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-[10px] text-ink-500 font-bold uppercase tracking-widest shrink-0">{t('analytics_net')} · {periodLabel}</p>
            <div className="flex flex-col items-end gap-0.5 min-w-0">
              {netByCurrency.map(({ currency, amount }) => {
                const positive = amount >= 0;
                return (
                  <p
                    key={currency}
                    className={`text-[14px] font-bold tabular-nums leading-tight ${positive ? 'text-receive-text' : 'text-pay-text'}`}
                  >
                    {positive ? '+' : '−'}{formatMoney(Math.abs(amount), currency)}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
                    ? 'bg-ink-900 text-white'
                    : 'bg-cream-card border border-cream-border text-ink-500'
                }`}
              >
                {currency}
              </button>
            ))}
          </div>
        </div>
      )}

      {loadStatus === 'error' ? (
        // A failed fetch must never masquerade as "no spending data".
        <div className="px-5 pt-6">
          <PageErrorState
            variant="inline"
            message={loadError ?? undefined}
            onRetry={retryLoad}
          />
        </div>
      ) : isInitialLoading ? (
        <div className="px-5 pt-6">
          <ListSkeleton rows={4} withAvatar={false} />
        </div>
      ) : !hasAnyData ? (
        // Only once the first load has RESOLVED — every store starts at [].
        loadStatus === 'ready' ? (
          <EmptyState
            icon={TrendingUp}
            clayIcon="chart"
            tone="accent"
            title={t('analytics_no_data')}
            description={t('analytics_empty_desc')}
            actionLabel={t('analytics_empty_cta')}
            onAction={() => navigate('/transactions')}
          />
        ) : null
      ) : (
        <>
          {/* Category Pie Chart */}
          {categories.length > 0 && (
            <div className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">{t('analytics_categories')}</h2>
                <span className="rounded-full bg-cream-soft px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
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
                      <button
                        key={c.category}
                        onClick={() => navigate(insightHref(c.category))}
                        className="w-full flex items-center gap-2 min-h-[44px] text-left active:opacity-70 transition-opacity"
                      >
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                        <span className="text-[11px] text-ink-600 truncate flex-1">{c.category}</span>
                        <span className="text-[11px] font-bold text-ink-800 tabular-nums">{c.percentage}%</span>
                        <ChevronRight size={12} className="text-ink-300 shrink-0" />
                      </button>
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
                <span className="rounded-full bg-cream-soft px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={trend}>
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={40} />
                    <Tooltip formatter={(value: unknown) => formatMoney(Number(value), chartCurrency)} />
                    <Bar dataKey="income" fill="#0F9D7B" radius={[4, 4, 0, 0]} name="Income" />
                    <Bar dataKey="expense" fill="#D9614A" radius={[4, 4, 0, 0]} name="Expense" />
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
                <span className="rounded-full bg-cream-soft px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={daily}>
                    <XAxis dataKey="day" tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(value: unknown) => formatMoney(Number(value), chartCurrency)} />
                    <Bar dataKey="amount" fill="#5B47E8" radius={[3, 3, 0, 0]} />
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
                <span className="rounded-full bg-cream-soft px-2 py-1 text-[10px] font-bold text-ink-500">{chartCurrency}</span>
              </div>
              <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-cream-hairline">
                {topExp.map(tx => {
                  const subtitle = getTransactionSubtitle(tx.notes);
                  const cat = tx.category || 'Other';
                  return (
                    <button
                      key={tx.id}
                      onClick={() => navigate(insightHref(cat))}
                      className="w-full px-4 py-3 min-h-[44px] flex items-center justify-between text-left active:bg-cream-soft transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold text-ink-800 truncate">{cat}</p>
                        {subtitle ? <p className="text-[10px] text-ink-500 truncate">{subtitle}</p> : null}
                      </div>
                      <p className="text-[13px] font-bold text-pay-text tabular-nums shrink-0 ml-2">−{formatMoney(tx.amount, tx.currency)}</p>
                      <ChevronRight size={13} className="text-ink-300 shrink-0 ml-1.5" />
                    </button>
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
