import { Button } from './Button';
import type { LucideIcon } from 'lucide-react';

type Tone = 'indigo' | 'accent' | 'receive' | 'pay' | 'warn';

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  // Tiny italic line below description. Use for personality copy in Roman Urdu
  // / English that explains why the empty state isn't a bug — e.g.
  // "Abhi koi qarz nahi — sukoon hai 🌙". Optional.
  subhint?: string;
  actionLabel?: string;
  onAction?: () => void;
  // Optional second CTA rendered as a ghost button under the primary.
  // Use when the empty state has a "create new" + "join existing" duality.
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  // Visual tone of the icon halo. Defaults to indigo to match existing call
  // sites. accent = Sukoon violet, receive = forest green, pay = warm coral.
  tone?: Tone;
  // Compact variant for inline-in-card empty states (e.g. an account with
  // zero transactions inside its detail page). Reduces vertical padding
  // and icon size.
  size?: 'default' | 'compact';
}

const TONES: Record<Tone, { halo: string; ring: string; icon: string; bloom: string }> = {
  indigo: {
    halo: 'from-accent-50 to-accent-100',
    ring: 'ring-accent-100',
    icon: 'text-accent-600',
    bloom: 'before:bg-accent-500/20',
  },
  accent: {
    halo: 'from-accent-50 to-accent-100',
    ring: 'ring-accent-100',
    icon: 'text-accent-600',
    bloom: 'before:bg-accent-500/20',
  },
  receive: {
    halo: 'from-receive-50 to-receive-100',
    ring: 'ring-receive-100',
    icon: 'text-receive-600',
    bloom: 'before:bg-receive-600/15',
  },
  pay: {
    halo: 'from-pay-50 to-pay-100',
    ring: 'ring-pay-100',
    icon: 'text-pay-600',
    bloom: 'before:bg-pay-600/15',
  },
  warn: {
    halo: 'from-warn-50 to-warn-50',
    ring: 'ring-warn-50',
    icon: 'text-warn-600',
    bloom: 'before:bg-warn-600/15',
  },
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  subhint,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  tone = 'indigo',
  size = 'default',
}: Props) {
  const t = TONES[tone];
  const isCompact = size === 'compact';
  // The bloom is a soft blurred circle behind the icon container, sized
  // larger than the container so the edges feather out. Pure decoration —
  // does not capture pointer events.
  const iconBoxSize = isCompact ? 'w-14 h-14' : 'w-20 h-20';
  const iconSize = isCompact ? 26 : 32;
  const containerPadding = isCompact ? 'py-10 px-6' : 'py-16 px-8';

  return (
    <div className={`flex flex-col items-center justify-center text-center ${containerPadding}`}>
      <div
        className={`relative ${iconBoxSize} rounded-[28px] bg-gradient-to-br ${t.halo} ${t.icon} flex items-center justify-center mb-5 shadow-sm ring-1 ${t.ring} before:absolute before:inset-0 before:-z-10 before:rounded-[40px] before:blur-2xl before:opacity-70 ${t.bloom}`}
      >
        <Icon size={iconSize} strokeWidth={1.5} />
      </div>
      <h3 className="font-bold text-[15px] text-ink-800 tracking-tight">{title}</h3>
      <p className="text-[13px] text-ink-500 mt-1.5 max-w-[260px] leading-relaxed">{description}</p>
      {subhint && (
        <p className="text-[11.5px] text-ink-400 italic mt-2 max-w-[240px]">{subhint}</p>
      )}
      {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
        <div className="mt-6 flex flex-col items-stretch gap-2 min-w-[200px]">
          {actionLabel && onAction && (
            <Button variant="gradient" size="md" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <button
              onClick={onSecondaryAction}
              className="text-[12px] font-semibold text-ink-500 active:text-ink-700 py-2 transition-colors"
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
