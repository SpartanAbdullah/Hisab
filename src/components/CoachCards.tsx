import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, TrendingUp, Repeat, Target, Sparkles, PenLine, ChevronRight } from 'lucide-react';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { CoachCard, CoachKind, CoachTone } from '../lib/coachInsights';

const KIND_ICON: Record<CoachKind, typeof AlertTriangle> = {
  budget_over: AlertTriangle,
  overdue_receivable: Clock,
  budget_pace: TrendingUp,
  renewals_soon: Repeat,
  goal_behind: Target,
  top_category: Sparkles,
  log_nudge: PenLine,
};

const TONE: Record<CoachTone, { bg: string; text: string }> = {
  pay: { bg: 'bg-pay-50', text: 'text-pay-text' },
  warn: { bg: 'bg-warn-50', text: 'text-warn-600' },
  receive: { bg: 'bg-receive-50', text: 'text-receive-text' },
  accent: { bg: 'bg-accent-100', text: 'text-accent-600' },
  info: { bg: 'bg-info-50', text: 'text-info-600' },
};

function copyFor(card: CoachCard, t: ReturnType<typeof useT>): { title: string; body: string } {
  const p = card.params;
  const money = (amt: unknown, cur: unknown) => formatMoney(Number(amt), String(cur));
  switch (card.kind) {
    case 'budget_over':
      return { title: t('coach_budget_over_t').replace('{category}', String(p.category)), body: t('coach_budget_over_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'overdue_receivable':
      return { title: t('coach_overdue_t'), body: t('coach_overdue_b').replace('{count}', String(p.count)) };
    case 'budget_pace':
      return { title: t('coach_pace_t').replace('{category}', String(p.category)), body: t('coach_pace_b').replace('{pct}', String(p.pct)).replace('{days}', String(p.daysLeft)) };
    case 'renewals_soon':
      return { title: t('coach_renew_t').replace('{count}', String(p.count)), body: t('coach_renew_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'goal_behind':
      return { title: t('coach_goal_t').replace('{title}', String(p.title)), body: t('coach_goal_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'top_category':
      return { title: t('coach_top_t').replace('{category}', String(p.category)), body: t('coach_top_b').replace('{count}', String(p.count)).replace('{amount}', money(p.amount, p.currency)) };
    case 'log_nudge':
      return { title: t('coach_log_t').replace('{days}', String(p.days)), body: t('coach_log_b') };
  }
}

export function CoachCards({ cards }: { cards: CoachCard[] }) {
  const t = useT();
  const navigate = useNavigate();
  if (cards.length === 0) return null;

  return (
    <div>
      <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 flex items-center gap-1.5">
        <Sparkles size={12} className="text-accent-500" /> {t('coach_title')}
      </h2>
      <div className="space-y-2">
        {cards.map((card) => {
          const Icon = KIND_ICON[card.kind];
          const tone = TONE[card.tone];
          const { title, body } = copyFor(card, t);
          return (
            <button
              key={card.id}
              onClick={() => navigate(card.href)}
              className="w-full flex items-center gap-3 rounded-2xl bg-cream-card border border-cream-border p-3.5 text-left press-lg"
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tone.bg} ${tone.text}`}>
                <Icon size={16} strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">{title}</p>
                <p className="text-[11px] text-ink-500 mt-0.5 truncate">{body}</p>
              </div>
              <ChevronRight size={15} className="text-ink-300 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
