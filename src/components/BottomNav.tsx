import { NavLink } from 'react-router-dom';
import { Home, ArrowLeftRight, Users, Target, Settings, Clock } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useT } from '../lib/i18n';

export function BottomNav() {
  const modalCount = useUIStore(s => s.modalCount);
  const mode = useAppModeStore(s => s.mode);
  const t = useT();

  if (modalCount > 0) return null;

  const splitsLinks = [
    { to: '/', icon: Home, label: t('nav_home') },
    { to: '/groups', icon: Users, label: t('nav_groups') },
    { to: '/activity', icon: Clock, label: t('nav_activity') },
    { to: '/settings', icon: Settings, label: t('nav_settings') },
  ];

  const fullLinks = [
    { to: '/', icon: Home, label: t('nav_home') },
    { to: '/transactions', icon: ArrowLeftRight, label: t('nav_transactions') },
    { to: '/groups', icon: Users, label: t('nav_groups') },
    { to: '/goals', icon: Target, label: t('nav_goals') },
    { to: '/settings', icon: Settings, label: t('nav_settings') },
  ];

  const links = mode === 'splits_only' ? splitsLinks : fullLinks;

  return (
    <div className="fixed bottom-safe left-1/2 -translate-x-1/2 w-[calc(100%-32px)] max-w-[448px] z-50">
      <nav className="glass border border-white/60 rounded-2xl flex justify-around py-2 px-1 shadow-lg shadow-slate-900/[0.06]">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 text-[10px] px-3 py-1.5 rounded-xl transition-all duration-200 active:scale-90 ${
                isActive ? 'text-indigo-600 font-bold' : 'text-slate-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <div className={`p-1.5 rounded-xl transition-all duration-300 ${
                  isActive ? 'bg-indigo-50 shadow-sm shadow-indigo-500/10' : ''
                }`}>
                  <Icon size={19} strokeWidth={isActive ? 2.5 : 1.5} />
                </div>
                <span className="tracking-tight">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
