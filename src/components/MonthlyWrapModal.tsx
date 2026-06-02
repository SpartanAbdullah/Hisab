import { useEffect, useState } from 'react';
import { Sparkles, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { useTransactionStore } from '../stores/transactionStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import {
  computeMonthlyWrap,
  shouldShowMonthlyWrap,
  markWrapShown,
  type WrapStats,
} from '../lib/monthlyWrap';
import { formatMoney } from '../lib/constants';
import type { Currency } from '../db';

// Spotify-Wrapped-style end-of-month summary. Triggers on app boot:
// - we're at least 24h into a new month
// - we haven't already shown this month's wrap
// - there are >= 3 transactions in the prior month in the user's primary currency
//
// All the cleverness is in monthlyWrap.ts; this component is the surface.
export function MonthlyWrapModal() {
  const transactions = useTransactionStore((s) => s.transactions);
  const user = useSupabaseAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<WrapStats | null>(null);

  useEffect(() => {
    if (!user?.id || transactions.length === 0) return;
    const primaryCurrency =
      (localStorage.getItem('hisaab_primary_currency') as Currency) ?? 'AED';
    const computed = computeMonthlyWrap(transactions, primaryCurrency);
    if (!shouldShowMonthlyWrap(computed)) return;
    // Intentional: one-shot computation + scheduled open at mount. Deriving
    // `stats` in render would recompute on every transaction change and is
    // gated by `shouldShowMonthlyWrap`, so it's bounded but wasteful.
    setStats(computed);
    // Small delay so the wrap doesn't fight with auth/onboarding paint.
    const timer = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(timer);
    // `transactions` deliberately omitted — we only check at mount/auth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, transactions.length]);

  const handleClose = () => {
    setOpen(false);
    if (stats) markWrapShown(stats.monthKey);
  };

  const handleShare = async () => {
    if (!stats) return;
    const text = buildShareText(stats);
    // The Web Share API is optional on Navigator. We avoid `'share' in
    // navigator` because TS narrows the else branch to `never` once that
    // predicate is true. Casting to a permissive shape keeps both paths
    // typeable without losing runtime correctness.
    const nav = typeof navigator === 'undefined'
      ? null
      : (navigator as Navigator & {
          share?: (data: { text: string; title?: string }) => Promise<void>;
        });
    if (nav?.share) {
      try {
        await nav.share({ text, title: 'My Hisaab Wrap' });
      } catch {
        // User cancelled or share failed silently — fine.
      }
    } else if (nav?.clipboard) {
      try {
        await nav.clipboard.writeText(text);
      } catch {
        // Clipboard blocked — show nothing extra.
      }
    }
  };

  if (!stats) return null;

  const trendArrow = stats.spendChangePercent == null
    ? ''
    : stats.spendChangePercent < 0
      ? '↓'
      : '↑';
  const trendLabel = stats.spendChangePercent == null
    ? ''
    : `${trendArrow} ${Math.abs(stats.spendChangePercent).toFixed(0)}% vs last month`;

  return (
    <Modal open={open} onClose={handleClose} title={stats.monthLabel}>
      <div className="space-y-4">
        {/* Lead card */}
        <div className="rounded-2xl bg-navy-800 text-white p-5 bg-navy-bloom">
          <div className="flex items-center gap-2 text-white/70">
            <Sparkles size={14} />
            <p className="text-[10.5px] font-bold uppercase tracking-[0.12em]">
              Your Hisaab Wrap
            </p>
          </div>
          <p className="text-[20px] font-semibold tracking-tight mt-2 leading-snug">
            {stats.headline}
          </p>
          {trendLabel && (
            <p className="text-[12px] text-white/65 mt-2 tabular-nums">{trendLabel}</p>
          )}
        </div>

        {/* Three-up stat strip */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard
            label="Spent"
            value={formatMoney(stats.totalSpent, stats.primaryCurrency)}
            tone="pay"
          />
          <StatCard
            label="Earned"
            value={formatMoney(stats.totalIncome, stats.primaryCurrency)}
            tone="receive"
          />
          <StatCard
            label="Net"
            value={`${stats.net >= 0 ? '+' : ''}${formatMoney(stats.net, stats.primaryCurrency)}`}
            tone={stats.net >= 0 ? 'receive' : 'pay'}
          />
        </div>

        {/* Top categories */}
        {stats.topCategories.length > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-500">
              Where it went
            </p>
            <div className="mt-2.5 space-y-2">
              {stats.topCategories.map((c) => (
                <div key={c.category}>
                  <div className="flex items-baseline justify-between tabular-nums">
                    <p className="text-[13px] font-semibold text-ink-900">{c.category}</p>
                    <p className="text-[12px] text-ink-700">
                      {formatMoney(c.amount, stats.primaryCurrency)}
                      <span className="text-ink-400 ml-1.5">· {c.share.toFixed(0)}%</span>
                    </p>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-cream-soft overflow-hidden">
                    <div
                      className="h-full bg-accent-500"
                      style={{ width: `${Math.min(c.share, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Biggest + busiest day */}
        <div className="grid grid-cols-2 gap-2.5">
          {stats.biggestExpense && (
            <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-500">
                Biggest hit
              </p>
              <p className="text-[16px] font-semibold text-ink-900 tabular-nums mt-1">
                {formatMoney(stats.biggestExpense.amount, stats.biggestExpense.currency)}
              </p>
              <p className="text-[11px] text-ink-500 truncate">
                {stats.biggestExpense.category || 'Uncategorised'}
              </p>
            </div>
          )}
          {stats.bigSpendDay && (
            <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-500">
                Busiest day
              </p>
              <p className="text-[16px] font-semibold text-ink-900 tabular-nums mt-1">
                {formatMoney(stats.bigSpendDay.amount, stats.primaryCurrency)}
              </p>
              <p className="text-[11px] text-ink-500">
                {new Date(stats.bigSpendDay.date).toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleShare}
            className="cta-secondary flex-1 flex items-center justify-center gap-1.5"
          >
            <Share2 size={12} /> Share
          </button>
          <button onClick={handleClose} className="cta-primary flex-1">
            See you next month
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  tone: 'receive' | 'pay';
}

function StatCard({ label, value, tone }: StatCardProps) {
  return (
    <div className="rounded-2xl bg-cream-card border border-cream-border p-3">
      <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink-500">
        {label}
      </p>
      <p
        className={`text-[15px] font-semibold tabular-nums mt-1 ${
          tone === 'receive' ? 'text-receive-text' : 'text-pay-text'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function buildShareText(stats: WrapStats): string {
  const lines = [
    `My ${stats.monthLabel} Hisaab Wrap ✨`,
    '',
    `Spent: ${formatMoney(stats.totalSpent, stats.primaryCurrency)}`,
    `Earned: ${formatMoney(stats.totalIncome, stats.primaryCurrency)}`,
  ];
  if (stats.topCategories[0]) {
    lines.push(`Biggest category: ${stats.topCategories[0].category} (${stats.topCategories[0].share.toFixed(0)}%)`);
  }
  lines.push('', 'Tracked with Hisaab.');
  return lines.join('\n');
}
