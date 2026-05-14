import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface NavyHeroProps {
  children: ReactNode;
  bloom?: boolean;
  className?: string;
}

// Sukoon's navy hero: the dark band that sits at the top of every screen
// except Quick Entry and the cream-only sheets. The bloom gradient is
// applied via the `.bg-navy-bloom` class in index.css so the gradient
// math stays in one place.
//
// Compose with a sibling that has `.sukoon-body` to get the signature
// 16px slide-under + 24px top radius transition.
export function NavyHero({ children, bloom = true, className }: NavyHeroProps) {
  const surface = bloom ? 'bg-navy-bloom' : 'bg-navy-800';
  return (
    <header className={`${surface} text-white pt-safe relative ${className ?? ''}`}>
      {children}
    </header>
  );
}

interface TopBarProps {
  title?: string;
  back?: boolean;
  action?: ReactNode;
  onBack?: () => void;
  tone?: 'on-navy' | 'on-cream';
}

// Top header row. On the navy hero the back tile is translucent white;
// on the cream body it picks up the slate-100/80 chrome that the rest
// of the codebase already uses (`.nav-icon-button` in index.css).
export function TopBar({ title, back, action, onBack, tone = 'on-navy' }: TopBarProps) {
  const navigate = useNavigate();
  const handleBack = onBack ?? (() => navigate(-1));

  const isOnNavy = tone === 'on-navy';
  const titleClass = isOnNavy
    ? 'text-white tracking-tight'
    : 'text-ink-900 tracking-tight';
  const backTileClass = isOnNavy
    ? 'bg-white/10 active:bg-white/15'
    : 'bg-slate-100/80 active:bg-slate-200';
  const backIconClass = isOnNavy ? 'text-white' : 'text-ink-600';

  return (
    <div className="flex items-center gap-3 px-4 pt-1.5 pb-3 relative z-10">
      {back && (
        <button
          onClick={handleBack}
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${backTileClass}`}
          aria-label="Back"
        >
          <ArrowLeft size={16} className={backIconClass} strokeWidth={2.2} />
        </button>
      )}
      <h1 className={`flex-1 min-w-0 text-[17px] font-semibold truncate ${titleClass}`}>
        {title}
      </h1>
      {action}
    </div>
  );
}
