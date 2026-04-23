import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  variant: 'primary' | 'secondary';
  onClick: () => void;
}

// Compact entry-point tile. Horizontal layout (icon beside text) keeps
// vertical footprint tight on mobile while preserving a ≥44px tap area
// thanks to p-3.5 padding around the 40px icon.
export function ActionCard({ icon: Icon, title, subtitle, variant, onClick }: Props) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      className={`relative text-left p-3.5 rounded-2xl transition-all duration-150 hover:scale-[0.98] active:scale-[0.97] overflow-hidden flex items-center gap-3 min-h-[60px] ${
        isPrimary
          ? 'bg-gradient-to-br from-indigo-500 via-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-500/25 hover:shadow-lg hover:shadow-indigo-500/30'
          : 'bg-white border border-slate-200/70 text-slate-700 shadow-sm shadow-slate-500/5 hover:shadow-md hover:shadow-slate-500/10'
      }`}
    >
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
          isPrimary
            ? 'bg-white/15 backdrop-blur-sm ring-1 ring-white/10'
            : 'bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100'
        }`}
      >
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1 leading-normal">
        <p className={`text-sm font-semibold tracking-tight truncate ${isPrimary ? 'text-white' : 'text-slate-800'}`}>
          {title}
        </p>
        <p className={`text-xs mt-0.5 truncate ${isPrimary ? 'text-white/75' : 'text-slate-400'}`}>
          {subtitle}
        </p>
      </div>
    </button>
  );
}
