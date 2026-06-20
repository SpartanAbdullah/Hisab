import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sparkles, TrendingDown } from 'lucide-react';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useTransactionStore } from '../stores/transactionStore';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { computeMonthlyWrap } from '../lib/monthlyWrap';
import { formatMoney } from '../lib/constants';
import type { Currency } from '../db';

const NAVY_BLOOM =
  'radial-gradient(120% 90% at 80% 10%, rgba(124,92,255,0.32) 0%, rgba(124,92,255,0) 55%), radial-gradient(80% 70% at 10% 100%, rgba(217,97,74,0.18) 0%, rgba(217,97,74,0) 60%)';

// On-demand month-in-review for the AI tab. Reuses the tested computeMonthlyWrap
// logic; the boot-time MonthlyWrapModal stays untouched.
export function WrapPage() {
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const navigate = useNavigate();
  const load = useCallback(() => loadTransactions(), [loadTransactions]);
  const { status, error, retry } = useAsyncLoad(load);

  const cur = (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED';
  const stats = computeMonthlyWrap(transactions, cur);

  if (status === 'error') {
    return (
      <main className="min-h-dvh bg-cream-bg px-5 pt-6">
        <PageErrorState title="Couldn't load your wrap" message={error ?? 'Try again.'} onRetry={retry} />
      </main>
    );
  }

  if (status === 'loading' && transactions.length === 0) {
    return (
      <main className="min-h-dvh bg-cream-bg px-5 pt-6">
        <ListSkeleton rows={4} withAvatar={false} />
      </main>
    );
  }

  if (!stats) {
    return (
      <main className="min-h-dvh bg-cream-bg px-5 pt-6">
        <button onClick={() => navigate(-1)} className="text-[12px] text-ink-500 font-medium mb-4 flex items-center gap-1">
          <ChevronLeft size={14} /> Back
        </button>
        <div className="rounded-2xl bg-cream-card border border-cream-border p-6 text-center">
          <p className="text-[14px] font-semibold text-ink-900">Your wrap isn&rsquo;t ready yet</p>
          <p className="text-[12px] text-ink-500 mt-2 leading-relaxed">
            After a full month with a few logged expenses, a calm month-in-review will appear here — no scores, no judgement.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      {/* navy hero */}
      <div className="relative overflow-hidden text-white" style={{ background: 'var(--color-navy-800)' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: NAVY_BLOOM }} />
        <div className="relative px-5 pt-6 pb-7">
          <button onClick={() => navigate(-1)} aria-label="Back" className="w-9 h-9 rounded-xl flex items-center justify-center bg-white/10 mb-4">
            <ChevronLeft size={16} className="text-white" />
          </button>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={15} className="text-white/80" />
            <span className="text-[11px] font-semibold tracking-[0.14em] uppercase text-white/55">Month in review</span>
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight leading-tight">{stats.monthLabel}, wrapped</h1>

          <div className="grid grid-cols-2 gap-3 mt-5">
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-3.5">
              <p className="text-[10.5px] text-white/55 font-semibold uppercase tracking-[0.04em]">Spent</p>
              <p className="text-[22px] font-semibold tabular-nums mt-1">
                {stats.totalSpent.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                <span className="text-[12px] text-white/50 font-medium ml-1">{cur}</span>
              </p>
            </div>
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-3.5">
              <p className="text-[10.5px] text-white/55 font-semibold uppercase tracking-[0.04em]">Net</p>
              <p className={`text-[22px] font-semibold tabular-nums mt-1 ${stats.net >= 0 ? 'text-[#7BE0C4]' : 'text-[#FFB59E]'}`}>
                {stats.net >= 0 ? '+' : '−'}
                {Math.abs(stats.net).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                <span className="text-[12px] text-white/50 font-medium ml-1">{cur}</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 pt-5 space-y-4">
        {/* top categories */}
        {stats.topCategories.length > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
            <p className="text-[11px] text-ink-500 font-semibold tracking-[0.12em] uppercase mb-3">Where it went</p>
            <div className="space-y-2.5">
              {stats.topCategories.map((c, i) => (
                <div key={c.category} className="flex items-center gap-2.5">
                  <span className="w-24 text-[12px] text-ink-700 truncate shrink-0">{c.category}</span>
                  <div className="flex-1 h-2 rounded-full bg-cream-soft overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.round(c.share * 100)}%`,
                        background: i === 0 ? 'var(--color-pay-600)' : 'var(--color-ink-300)',
                      }}
                    />
                  </div>
                  <span className="w-16 text-right text-[12px] font-semibold text-ink-900 tabular-nums shrink-0">
                    {formatMoney(c.amount, cur).replace(`${cur} `, '')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* biggest expense */}
        {stats.biggestExpense && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-pay-50 flex items-center justify-center shrink-0">
              <TrendingDown size={18} className="text-pay-text" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink-500">Biggest single expense</p>
              <p className="text-[13px] font-semibold text-ink-900 truncate">
                {stats.biggestExpense.notes || stats.biggestExpense.category || 'Expense'}
              </p>
            </div>
            <p className="text-[14px] font-semibold text-pay-text tabular-nums shrink-0">
              {formatMoney(stats.biggestExpense.amount, cur)}
            </p>
          </div>
        )}

        <p className="text-[11px] text-ink-400 text-center leading-relaxed px-4">
          A calm look back — no scores, no judgement. Just what happened.
        </p>
      </div>
    </main>
  );
}
