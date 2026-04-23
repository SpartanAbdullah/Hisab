import { NavLink } from 'react-router-dom';
import { Home, ArrowLeftRight, Users, Target, Settings, Clock, Inbox } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useT } from '../lib/i18n';

export function BottomNav() {
  const modalCount = useUIStore(s => s.modalCount);
  const mode = useAppModeStore(s => s.mode);
  const t = useT();
  const userId = useSupabaseAuthStore(s => s.user?.id ?? '');
  const linkedPending = useLinkedRequestStore(
    s => s.requests.filter(r => r.status === 'pending' && r.toUserId === userId).length,
  );
  const settlementPending = useSettlementRequestStore(
    s => s.requests.filter(r => r.status === 'pending' && r.toUserId === userId).length,
  );
  const incomingPendingCount = linkedPending + settlementPending;

  if (modalCount > 0) return null;

  const splitsLinks = [
    { to: '/', icon: Home, label: t('nav_home') },
    { to: '/groups', icon: Users, label: t('nav_groups') },
    { to: '/inbox', icon: Inbox, label: t('nav_inbox'), badge: incomingPendingCount },
    { to: '/activity', icon: Clock, label: t('nav_activity') },
    { to: '/settings', icon: Settings, label: t('nav_settings') },
  ];

  const fullLinks = [
    { to: '/', icon: Home, label: t('nav_home') },
    { to: '/transactions', icon: ArrowLeftRight, label: t('nav_transactions') },
    { to: '/groups', icon: Users, label: t('nav_groups') },
    { to: '/goals', icon: Target, label: t('nav_goals') },
    { to: '/inbox', icon: Inbox, label: t('nav_inbox'), badge: incomingPendingCount },
    { to: '/settings', icon: Settings, label: t('nav_settings') },
  ];

  const links = mode === 'splits_only' ? splitsLinks : fullLinks;

  return (
    <div className="fixed bottom-safe left-1/2 -translate-x-1/2 w-[calc(100%-32px)] max-w-[448px] z-50">
      <nav className="glass border border-white/60 rounded-2xl flex justify-around py-2 px-1 shadow-lg shadow-slate-900/[0.06]">
        {links.map((link) => {
          const { to, icon: Icon, label } = link;
          const badge = 'badge' in link ? link.badge : 0;
          return (
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
                  <div className={`relative p-1.5 rounded-xl transition-all duration-300 ${
                    isActive ? 'bg-indigo-50 shadow-sm shadow-indigo-500/10' : ''
                  }`}>
                    <Icon size={19} strokeWidth={isActive ? 2.5 : 1.5} />
                    {badge && badge > 0 ? (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-rose-500 rounded-full ring-2 ring-white" />
                    ) : null}
                  </div>
                  <span className="tracking-tight truncate">{label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
