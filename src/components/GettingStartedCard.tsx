import { Check } from 'lucide-react';
import { useT } from '../lib/i18n';

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
    <div className="rounded-[20px] bg-gradient-to-br from-accent-50 to-cream-card border border-accent-100 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-ink-900 tracking-tight">{t('gs_title')}</p>
          <p className="text-[12px] text-ink-500 mt-0.5">{t('gs_subtitle')}</p>
        </div>
        <span className="text-[11px] font-bold text-accent-600 tabular-nums shrink-0">
          {t('gs_progress').replace('{done}', String(done)).replace('{total}', '2')}
        </span>
      </div>

      <div className="mt-4 space-y-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 rounded-2xl p-3 border ${s.done ? 'bg-receive-50/60 border-receive-100' : 'bg-cream-card border-cream-border'}`}
          >
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${s.done ? 'bg-receive-600 text-white' : s.enabled ? 'bg-accent-100 text-accent-600' : 'bg-cream-soft text-ink-400'}`}>
              {s.done ? <Check size={15} strokeWidth={3} /> : <span className="text-[12px] font-bold">{i + 1}</span>}
            </div>
            <p className={`flex-1 text-[13px] font-semibold ${s.done ? 'text-ink-500 line-through' : s.enabled ? 'text-ink-900' : 'text-ink-400'}`}>
              {s.label}
            </p>
            {!s.done && (
              <button
                onClick={s.onClick}
                disabled={!s.enabled}
                className="shrink-0 px-3 py-1.5 rounded-xl bg-ink-900 text-white text-[11px] font-bold disabled:opacity-30 press-sm"
              >
                {s.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
