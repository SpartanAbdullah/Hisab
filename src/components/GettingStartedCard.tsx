import { Check } from 'lucide-react';
import { useT } from '../lib/i18n';
import { Card3D } from './Card3D';
import { Button } from './Button';

interface Props {
  accountCount: number;
  transactionCount: number;
  onAddAccount: () => void;
  onLogEntry: () => void;
}

// A two-step "first win" for brand-new users: add an account, then log the
// first entry. Shows live progress and disappears once both are done — the
// populated dashboard is the reward. Replaces the lone add-account CTA so the
// path to value is guided rather than a dead-end empty state.
export function GettingStartedCard({ accountCount, transactionCount, onAddAccount, onLogEntry }: Props) {
  const t = useT();
  const hasAccount = accountCount > 0;
  const hasEntry = transactionCount > 0;
  if (hasAccount && hasEntry) return null;

  const done = (hasAccount ? 1 : 0) + (hasEntry ? 1 : 0);
  const steps = [
    { done: hasAccount, label: t('gs_step_account'), cta: t('gs_cta_add'), onClick: onAddAccount, enabled: true },
    { done: hasEntry, label: t('gs_step_entry'), cta: t('gs_cta_log'), onClick: onLogEntry, enabled: hasAccount },
  ];

  return (
    // 3D clay (docs/design-system.md §10). This is the very first thing a new
    // user sees, so it gets the illustration: a piggybank floating over an
    // accent clay card. The card itself is informational (the two step rows
    // carry the taps), so it is a Card3D, not a tile.
    <Card3D tint="accent" padding="lg" icon="piggybank">
      {/* The counter sits on the TITLE line only. It used to be centred
          against the whole title+subtitle block, which squeezed the subtitle
          into a two-line wrap between it and the icon gutter (worst in roman
          Urdu, where "Do chhote step — phir aap tayyar hain" is longer). The
          subtitle now gets the full content width; only the title shares its
          row, and the icon gutter comes from Card3D's `icon` prop. */}
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[15px] font-bold text-ink-900 tracking-tight min-w-0">{t('gs_title')}</p>
        <span className="text-[11px] font-bold text-accent-600 tabular-nums shrink-0">
          {t('gs_progress').replace('{done}', String(done)).replace('{total}', '2')}
        </span>
      </div>
      <p className="text-[12px] text-ink-600 mt-0.5">{t('gs_subtitle')}</p>

      {/* `icon` puts a 64px inline-end gutter on the WHOLE card, which is
          right for the two lines that sit under the art and wrong for the
          step rows below it. -me-10 hands those 40px back, landing the rows
          on the card's own 24px lg padding. */}
      <div className="mt-4 space-y-2 -me-10">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 rounded-2xl p-3 ${s.done ? 'bg-receive-50/70' : 'bg-cream-card'}`}
          >
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${s.done ? 'bg-receive-600 text-white' : s.enabled ? 'bg-accent-100 text-accent-600' : 'bg-cream-soft text-ink-400'}`}>
              {s.done ? <Check size={15} strokeWidth={3} /> : <span className="text-[12px] font-bold">{i + 1}</span>}
            </div>
            <p className={`flex-1 text-[13px] font-semibold ${s.done ? 'text-ink-600 line-through' : s.enabled ? 'text-ink-900' : 'text-ink-400'}`}>
              {s.label}
            </p>
            {!s.done && (
              <Button
                depth
                size="sm"
                onClick={s.onClick}
                disabled={!s.enabled}
                className="shrink-0 !text-[11px] font-bold"
              >
                {s.cta}
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card3D>
  );
}
