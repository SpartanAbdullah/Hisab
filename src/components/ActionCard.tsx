import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  variant: 'primary' | 'secondary';
  onClick: () => void;
}

// Large, thumb-sized entry-point card. Two variants so a page can show a
// clear primary/secondary pair (e.g. Create vs Join) without reinventing
// styling each time. Designed to fill a 2-column grid on mobile.
export function ActionCard({ icon: Icon, title, subtitle, variant, onClick }: Props) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      className={`relative text-left p-4 rounded-3xl active:scale-[0.97] transition-all overflow-hidden ${
        isPrimary
          ? 'bg-gradient-to-br from-indigo-500 via-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-500/25'
          : 'bg-white border border-slate-200/70 text-slate-700 shadow-sm shadow-slate-500/5'
      }`}
    >
      <div
        className={`w-10 h-10 rounded-2xl flex items-center justify-center mb-3 ${
          isPrimary ? 'bg-white/15 backdrop-blur-sm' : 'bg-indigo-50 text-indigo-600'
        }`}
      >
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <p className={`text-[14px] font-bold tracking-tight ${isPrimary ? 'text-white' : 'text-slate-800'}`}>
        {title}
      </p>
      <p className={`text-[11px] mt-0.5 ${isPrimary ? 'text-white/75' : 'text-slate-400'}`}>
        {subtitle}
      </p>
    </button>
  );
}
