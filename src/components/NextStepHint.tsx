import { ArrowRight, CheckCircle2, Lightbulb, type LucideIcon } from 'lucide-react';

type Tone = 'accent' | 'receive' | 'pay' | 'warn' | 'info';

interface Props {
  icon?: LucideIcon;
  status: string;
  next: string;
  tone?: Tone;
  actionLabel?: string;
  onAction?: () => void;
}

const TONES: Record<Tone, { shell: string; iconBox: string; icon: string; status: string }> = {
  accent: {
    shell: 'bg-accent-50 border-accent-100',
    iconBox: 'bg-accent-100',
    icon: 'text-accent-600',
    status: 'text-accent-600',
  },
  receive: {
    shell: 'bg-receive-50 border-receive-100',
    iconBox: 'bg-receive-100',
    icon: 'text-receive-text',
    status: 'text-receive-text',
  },
  pay: {
    shell: 'bg-pay-50 border-pay-100',
    iconBox: 'bg-pay-100',
    icon: 'text-pay-text',
    status: 'text-pay-text',
  },
  warn: {
    shell: 'bg-warn-50 border-cream-border',
    iconBox: 'bg-cream-card',
    icon: 'text-warn-600',
    status: 'text-warn-600',
  },
  info: {
    shell: 'bg-info-50 border-cream-border',
    iconBox: 'bg-cream-card',
    icon: 'text-info-600',
    status: 'text-info-600',
  },
};

export function NextStepHint({
  icon: Icon = Lightbulb,
  status,
  next,
  tone = 'info',
  actionLabel,
  onAction,
}: Props) {
  const t = TONES[tone];

  return (
    <div className={`rounded-[18px] border ${t.shell} p-4 flex items-start gap-3`}>
      <div className={`w-9 h-9 rounded-xl ${t.iconBox} ${t.icon} flex items-center justify-center shrink-0`}>
        <Icon size={16} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={12} className={t.status} />
          <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${t.status}`}>
            Current status
          </p>
        </div>
        <p className="text-[13px] font-semibold text-ink-900 tracking-tight mt-1 leading-snug">
          {status}
        </p>
        <p className="text-[12px] text-ink-600 mt-1.5 leading-relaxed">{next}</p>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-900 active:opacity-70 transition-opacity"
          >
            {actionLabel}
            <ArrowRight size={12} strokeWidth={2.4} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
