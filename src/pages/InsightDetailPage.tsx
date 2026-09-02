import { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { EmptyState } from '../components/EmptyState';
import { useTransactionStore } from '../stores/transactionStore';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { parseInternalNote } from '../lib/internalNotes';

function primaryCurrency(): string {
  return localStorage.getItem('hisaab_primary_currency') || 'AED';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Drill into one spending category. Honours the period + currency the user had
// selected on Analytics (passed as ?from=&to=&cur=); falls back to the current
// month in the primary currency when opened without them.
export function InsightDetailPage() {
  const t = useT();
  const { category = '' } = useParams();
  const [params] = useSearchParams();
  const cat = decodeURIComponent(category);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const load = useCallback(() => loadTransactions(), [loadTransactions]);
  const { status, error, retry } = useAsyncLoad(load);

  const data = useMemo(() => {
    const cur = params.get('cur') || primaryCurrency();
    const now = new Date();
    const fromParam = params.get('from');
    const toParam = params.get('to');
    const from = fromParam ? new Date(fromParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = toParam ? new Date(toParam) : now;
    const rows = transactions.filter((t) => {
      if (t.type !== 'expense' || t.currency !== cur || (t.category || 'Other') !== cat) return false;
      const d = new Date(t.createdAt);
      return d >= from && d <= to;
    });
    const total = rows.reduce((a, t) => a + t.amount, 0);

    // Trend buckets: by calendar month when the range spans more than one
    // month, else by week-of-month. Keeps the chart meaningful for any period.
    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    const byMonth = spanDays > 32;
    let weekBars: { name: string; amt: number }[];
    if (byMonth) {
      const buckets = new Map<string, number>();
      for (const t of rows) {
        const k = (t.createdAt ?? '').slice(0, 7);
        buckets.set(k, (buckets.get(k) ?? 0) + t.amount);
      }
      weekBars = [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, amt]) => ({ name: MONTHS[parseInt(k.slice(5, 7), 10) - 1] ?? k, amt }));
    } else {
      const weeks = [0, 0, 0, 0, 0];
      for (const t of rows) {
        const day = new Date(t.createdAt).getDate();
        weeks[Math.min(4, Math.floor((day - 1) / 7))] += t.amount;
      }
      weekBars = weeks.map((amt, i) => ({ name: `Wk ${i + 1}`, amt }));
      while (weekBars.length > 1 && weekBars[weekBars.length - 1].amt === 0) weekBars.pop();
    }

    // by merchant (the note carries the merchant/description). Split-group-linked
    // expenses hide their real label behind a [[HISAAB_META:…]] tag, so parse it
    // out — otherwise the breakdown shows a URL-encoded JSON blob as the merchant.
    const byMerchant = new Map<string, { amt: number; count: number }>();
    for (const t of rows) {
      const parsed = parseInternalNote(t.notes);
      const key = parsed.visibleNote.trim()
        || parsed.meta.expenseDescription
        || parsed.meta.groupName
        || 'Other';
      const e = byMerchant.get(key) ?? { amt: 0, count: 0 };
      e.amt += t.amount;
      e.count += 1;
      byMerchant.set(key, e);
    }
    const merchants = [...byMerchant.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.amt - a.amt)
      .slice(0, 8);

    return { cur, total, weekBars, merchants, count: rows.length, byMonth };
  }, [transactions, cat, params]);

  const maxWeek = Math.max(1, ...data.weekBars.map((w) => w.amt));

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader title={cat || 'Category'} back />

      <div className="px-5 pt-5 space-y-4">
        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('idp_err_load')}
            message={error ?? t('err_some_data_failed')}
            onRetry={retry}
          />
        )}

        {status === 'loading' && transactions.length === 0 ? (
          <ListSkeleton rows={3} withAvatar={false} />
        ) : data.count === 0 ? (
          status === 'ready' ? (
            <EmptyState
              icon={TrendingUp}
              tone="accent"
              title={`No ${cat} spending in this period`}
              description="Try a wider range on Analytics, or log expenses in this category to see the breakdown."
            />
          ) : null
        ) : (
          <>
            {/* total */}
            <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
              <p className="text-[11px] text-ink-500 font-semibold tracking-[0.12em] uppercase">
                {t('idp_total_spent')}
              </p>
              <p className="text-[28px] font-bold text-ink-900 tabular-nums mt-1">
                {formatMoney(data.total, data.cur)}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">
                {data.count === 1
                  ? t('idp_across_one')
                  : t('idp_across_many').replace('{n}', String(data.count))}
              </p>
            </div>

            {/* by week */}
            {data.weekBars.length > 0 && (
              <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                <p className="text-[11px] text-ink-500 font-semibold tracking-[0.12em] uppercase mb-3">
                  {data.byMonth ? 'By month' : 'By week'}
                </p>
                <div className="flex items-end gap-2.5 h-28">
                  {data.weekBars.map((w) => (
                    <div key={w.name} className="flex-1 flex flex-col items-center justify-end gap-1.5 h-full">
                      <span className="text-[10px] font-semibold text-ink-700 tabular-nums">
                        {Math.round(w.amt)}
                      </span>
                      <div
                        className="w-full max-w-[34px] rounded-lg"
                        style={{
                          height: `${Math.max(6, Math.round((w.amt / maxWeek) * 80))}px`,
                          background: 'var(--color-accent-500)',
                        }}
                      />
                      <span className="text-[9.5px] text-ink-500">{w.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* by merchant */}
            <div className="rounded-2xl bg-cream-card border border-cream-border overflow-hidden">
              <p className="text-[11px] text-ink-500 font-semibold tracking-[0.12em] uppercase px-4 pt-4 pb-1">
                {t('idp_where_it_went')}
              </p>
              {data.merchants.map((m, i) => (
                <div
                  key={m.name}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${
                    i ? 'border-t border-cream-hairline' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-ink-900 truncate">{m.name}</p>
                    <p className="text-[11px] text-ink-500">
                      {m.count} {m.count === 1 ? 'charge' : 'charges'}
                    </p>
                  </div>
                  <p className="text-[13px] font-semibold text-pay-text tabular-nums shrink-0">
                    −{formatMoney(m.amt, data.cur).replace(`${data.cur} `, '')}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
