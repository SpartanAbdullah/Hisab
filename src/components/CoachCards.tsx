import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { Tile3D } from './Tile3D';
import type { ClayTint } from '../lib/clay';
import type { CoachCard, CoachKind, CoachTone } from '../lib/coachInsights';

// A rendered 3D icon per insight kind (public/3d, see src/lib/clay.ts). The
// lucide glyph each card used to carry is replaced 1:1 — the meaning still
// lives in the title, the icon is decoration by construction (Icon3D is
// alt="" aria-hidden).
//
// NOTE on names: the CC0 pack's art does not always match its filename —
// `handshake` renders a thumbs-up and `bell` renders a megaphone. Picked by
// what the asset LOOKS like, not by what it is called: `phone` (a handset)
// is the "go nudge them" cue for an overdue receivable.
const KIND_ICON: Record<CoachKind, string> = {
  budget_over: 'wallet',
  overdue_receivable: 'phone',
  budget_pace: 'chart',
  renewals_soon: 'calendar',
  goal_behind: 'target',
  // A shopping bag for "here is where your money went" — `receipt` renders a
  // plain text document, which reads as paperwork, not as spending.
  top_category: 'bag',
  // An alarm clock for "you haven't logged anything in N days" — `chat`
  // (speech bubbles) said nothing about a lapsed habit.
  log_nudge: 'alarm',
};

// Tone → clay tint. The old tone only coloured a 36px icon chip; carrying it
// into the tint keeps the same signal ("this one is about money going out" /
// "this one is a warning") on a surface the user can now read at a glance,
// instead of flattening every insight onto one colour.
const TONE_TINT: Record<CoachTone, ClayTint> = {
  pay: 'coral',
  warn: 'gold',
  receive: 'mint',
  accent: 'accent',
  info: 'sky',
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
      {/* Tiles, not cards: every insight navigates, and §10.1 is explicit
          that a surface which needs a tap is tier 1. The lip + 2px press
          replaces the chevron as the affordance. `pt-5`/`space-y-6` give
          the floating icons the 17px of overhang they need — this list must
          never sit inside an overflow-hidden ancestor. */}
      <div className="space-y-6 pt-5">
        {cards.map((card) => {
          const { title, body } = copyFor(card, t);
          return (
            <Tile3D
              key={card.id}
              tint={TONE_TINT[card.tone]}
              icon={KIND_ICON[card.kind]}
              title={title}
              subtitle={body}
              onClick={() => navigate(card.href)}
            />
          );
        })}
      </div>
    </div>
  );
}
