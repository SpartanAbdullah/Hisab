import { useState } from 'react';
import { Sparkles, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { markWrapShown, type WrapStats } from '../lib/monthlyWrap';
import { formatMoney } from '../lib/constants';
import { generateWrapCard } from '../lib/wrapCard';
import { shareStatementFile } from '../lib/shareStatement';
import { useT } from '../lib/i18n';

interface Props {
  /** The already-computed wrap. Non-null: mounting this component means "show it". */
  stats: WrapStats;
  /** Lets the gate that mounted this unmount it again after dismissal. */
  onClose?: () => void;
}

// Spotify-Wrapped-style end-of-month summary.
//
// Audit 03-performance H1 / P2 M2c: this component is LAZY now. It reaches
// wrapCard.ts → renderNodeToImage.ts → jspdf + modern-screenshot, so while it
// was statically imported by src/App.tsx that whole image/PDF stack sat in the
// eager import graph of every cold boot (see docs/performance.md §3).
//
// The trigger — "at least into a new month, not shown yet, >= 3 transactions in
// the prior month in the primary currency" — therefore runs in the gate in
// src/App.tsx, which dynamic-imports the (tiny, pure) monthlyWrap.ts, and only
// mounts this component once it has real stats to render.
export function MonthlyWrapModal({ stats, onClose }: Props) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [includeTotals, setIncludeTotals] = useState(false);
  const [sharing, setSharing] = useState(false);

  const handleClose = () => {
    setOpen(false);
    markWrapShown(stats.monthKey);
    onClose?.();
  };

  // Share the Wrapped as a portrait IMAGE card (WhatsApp Status shaped) so it
  // reaches non-users. Exact totals only ride along when the user opts in.
  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const { blob, filename } = await generateWrapCard(stats, { showTotals: includeTotals });
      await shareStatementFile({
        blob,
        filename,
        title: `My ${stats.monthLabel} Hisaab Wrap`,
        text: `My ${stats.monthLabel} — tracked with Hisaab`,
      });
    } catch {
      // Share cancelled / failed silently — fine.
    } finally {
      setSharing(false);
    }
  };

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
              {t('mwm_your_wrap')}
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
              {t('mwm_where_it_went')}
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
                {t('mwm_biggest_hit')}
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
                {t('mwm_busiest_day')}
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

        {/* Privacy: default to "proud numbers"; exact totals are opt-in. */}
        <label className="flex items-center justify-between rounded-2xl bg-cream-card border border-cream-border px-4 py-3 cursor-pointer">
          <span className="text-[12.5px] font-semibold text-ink-800">{t('mwm_include_totals')}</span>
          <input
            type="checkbox"
            checked={includeTotals}
            onChange={(e) => setIncludeTotals(e.target.checked)}
            className="w-4 h-4 accent-accent-600"
          />
        </label>

        <div className="flex gap-2">
          <button
            onClick={handleShare}
            disabled={sharing}
            className="cta-secondary flex-1 flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Share2 size={12} /> {sharing ? t('mwm_preparing') : t('mwm_share_card')}
          </button>
          <button onClick={handleClose} className="cta-primary flex-1">
            {t('mwm_see_next_month')}
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

