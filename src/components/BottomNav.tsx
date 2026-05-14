import { NavLink } from 'react-router-dom';
import { Home, ArrowLeftRight, Users, HandCoins, Plus } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useT } from '../lib/i18n';

interface Props {
  onQuickEntry: () => void;
}

// Sukoon bottom nav: 4 tab slots + center FAB for full_tracker (symmetric
// 2 left / FAB / 2 right). Splits-only collapses to 3 tabs + FAB since its
// surface set is smaller (no Ledger). Inbox is reachable only from the
// bell icon in the Home navy hero with its own coral pending-count badge;
// Settings via the avatar tap. The FAB always opens Quick Entry — the old
// context-aware fan-out is gone; page-specific add actions live as a "+"
// chip in each page's TopBar.
export function BottomNav({ onQuickEntry }: Props) {
  const modalCount = useUIStore((s) => s.modalCount);
  const mode = useAppModeStore((s) => s.mode);
  const t = useT();

  if (modalCount > 0) return null;

  const isSplits = mode === 'splits_only';
  const leftPair = isSplits
    ? [
        { to: '/', icon: Home, label: t('nav_home') },
        { to: '/loans', icon: HandCoins, label: t('nav_loans') },
      ]
    : [
        { to: '/', icon: Home, label: t('nav_home') },
        { to: '/transactions', icon: ArrowLeftRight, label: t('nav_transactions') },
      ];

  // Right side: full_tracker has both People (Loans) and Groups; splits-only
  // already has Loans on the left so the right side is just Groups.
  const rightTabs = isSplits
    ? [{ to: '/groups', icon: Users, label: t('nav_groups') }]
    : [
        { to: '/loans', icon: HandCoins, label: t('nav_loans') },
        { to: '/groups', icon: Users, label: t('nav_groups') },
      ];

  // 5 cols when both sides have 2 tabs, 4 cols for splits-only's 2+1 layout.
  const gridClass = isSplits ? 'grid-cols-4' : 'grid-cols-5';

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
