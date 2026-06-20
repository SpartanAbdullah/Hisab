import { NavLink } from 'react-router-dom';
import { Home, Users, HandCoins, Plus, History, Sparkles } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useT } from '../lib/i18n';

interface Props {
  onQuickEntry: () => void;
}

// Sukoon bottom nav: 4 tab slots + center FAB. Home far-left, then the
// FAB, then Hisaab AI and Groups on the right in BOTH modes — the AI tab
// is a money assistant AND a Hisaab guide, useful everywhere. Only slot 2
// changes by mode:
//   full_tracker → Home · Loans · [+] · Hisaab AI · Groups
//   splits_only  → Home · Activity · [+] · Hisaab AI · Groups
// Transactions (full) and Loans (splits) move off the bar to make room;
// both stay reachable from Home's cards. Inbox lives in the top-right page
// chrome with its own coral pending-count badge; Settings via the avatar tap.
export function BottomNav({ onQuickEntry }: Props) {
  const modalCount = useUIStore((s) => s.modalCount);
  const mode = useAppModeStore((s) => s.mode);
  const t = useT();

  if (modalCount > 0) return null;

  const isSplits = mode === 'splits_only';
  const leftPair = [
    { to: '/', icon: Home, label: t('nav_home') },
    isSplits
      ? { to: '/activity', icon: History, label: t('nav_activity') }
      : { to: '/loans', icon: HandCoins, label: t('nav_loans') },
  ];
  const rightTabs = [
    { to: '/hisaab-ai', icon: Sparkles, label: 'Hisaab AI' },
    { to: '/groups', icon: Users, label: t('nav_groups') },
  ];
  // Always 5 cols now (2 left + FAB + 2 right). Stable across modes.
  const gridClass = 'grid-cols-5';

  return (
    <nav
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] z-40"
      style={{
        // Tailwind's bg-white/92 doesn't exist; using the exact Sukoon value
        // keeps the cream body just barely visible through the surface so the
        // nav doesn't feel detached from the rest of the page.
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-cream-border)',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
      }}
    >
      <div className={`grid ${gridClass} items-center h-[62px]`}>
        {leftPair.map((link) => (
          <NavTab key={link.to} {...link} />
        ))}

        {/* Center FAB. -22px lift puts it above the nav surface; the cream-bg
            ring matches the body so the FAB reads as floating, not pasted. */}
        <div className="flex items-center justify-center relative">
          <button
            onClick={onQuickEntry}
            aria-label="Quick entry"
            className="w-[54px] h-[54px] rounded-full flex items-center justify-center text-white active:scale-95 transition-transform"
            style={{
              marginTop: -22,
              // Accent-violet at the top (carrying the bloom hue from the
              // navy hero) deepening into navy at the bottom — the FAB reads
              // as a piece of the hero that's drifted down to the nav.
              background:
                'linear-gradient(160deg, var(--color-accent-500) 0%, var(--color-accent-600) 35%, var(--color-navy-800) 100%)',
              boxShadow:
                '0 10px 22px -4px rgba(11,14,42,0.45), 0 4px 10px -2px rgba(124,92,255,0.35), 0 0 0 4px var(--color-cream-bg)',
            }}
          >
            <Plus size={22} strokeWidth={2.4} />
          </button>
        </div>

        {rightTabs.map((link) => (
          <NavTab key={link.to} {...link} />
        ))}
      </div>
    </nav>
  );
}

interface NavTabProps {
  to: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  badge?: number;
}

function NavTab({ to, icon: Icon, label, badge = 0 }: NavTabProps) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className="flex flex-col items-center gap-0.5 py-1.5 transition-opacity active:opacity-60"
    >
      {({ isActive }) => (
        <>
          <div className="relative">
            <Icon
              size={22}
              strokeWidth={isActive ? 2.2 : 1.7}
              className={isActive ? 'text-ink-900' : 'text-ink-500'}
            />
            {badge > 0 && (
              <span
                className="absolute -top-1.5 -right-2 min-w-[14px] h-3.5 px-1 rounded-full text-white text-[9px] font-bold flex items-center justify-center tabular-nums ring-2 ring-white"
                style={{ background: 'var(--color-pay-600)' }}
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </div>
          <span
            className={`text-[10px] tracking-tight ${
              isActive ? 'text-ink-900 font-semibold' : 'text-ink-500 font-medium'
            }`}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}
