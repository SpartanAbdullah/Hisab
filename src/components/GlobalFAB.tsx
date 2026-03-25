import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, Target, CalendarClock, Users, X } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useT } from '../lib/i18n';

interface Props {
  onQuickEntry: () => void;
  onAddGoal: () => void;
  onAddExpense: () => void;
  onAddLoan: () => void;
  onAddGroupExpense?: () => void;
}

export function GlobalFAB({ onQuickEntry, onAddGoal, onAddExpense, onAddLoan, onAddGroupExpense }: Props) {
  const modalCount = useUIStore(s => s.modalCount);
  const mode = useAppModeStore(s => s.mode);
  const location = useLocation();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  if (modalCount > 0) return null;

  // Mode-aware visibility
  const splitsShowPaths = ['/', '/groups'];
  const fullShowPaths = ['/', '/transactions', '/loans', '/goals', '/groups'];
  const showOnPaths = mode === 'splits_only' ? splitsShowPaths : fullShowPaths;
  const isVisible = showOnPaths.some(p => location.pathname === p);
  if (!isVisible) return null;

  const isGoalsTab = location.pathname === '/goals';
  const isLoansTab = location.pathname === '/loans';
  const isGroupsTab = location.pathname === '/groups';

  const handlePress = () => {
    if (isGoalsTab) {
      setMenuOpen(!menuOpen);
    } else if (isLoansTab) {
      onAddLoan();
    } else if (isGroupsTab || (mode === 'splits_only' && location.pathname === '/')) {
      if (onAddGroupExpense) onAddGroupExpense();
      else onQuickEntry();
    } else {
      onQuickEntry();
    }
  };

  return (
    <>
      {menuOpen && (
        <div style={{ position: 'fixed' }} className="inset-0 z-40" onClick={() => setMenuOpen(false)} />
      )}

      {menuOpen && isGoalsTab && (
        <div style={{ position: 'fixed' }} className="bottom-[10.5rem] right-5 z-40 flex flex-col gap-2.5 animate-fade-in">
          <button onClick={() => { setMenuOpen(false); onAddGoal(); }}
            className="flex items-center gap-2.5 bg-white rounded-2xl px-4 py-3 shadow-lg shadow-slate-900/10 border border-slate-100/60 active:scale-95 transition-all">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-100 to-purple-50 flex items-center justify-center">
              <Target size={14} className="text-purple-600" />
            </div>
            <span className="text-[13px] font-semibold text-slate-700">{t('fab_add_goal')}</span>
          </button>
          <button onClick={() => { setMenuOpen(false); onAddExpense(); }}
            className="flex items-center gap-2.5 bg-white rounded-2xl px-4 py-3 shadow-lg shadow-slate-900/10 border border-slate-100/60 active:scale-95 transition-all">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-100 to-amber-50 flex items-center justify-center">
              <CalendarClock size={14} className="text-amber-600" />
            </div>
            <span className="text-[13px] font-semibold text-slate-700">{t('fab_add_expense')}</span>
          </button>
        </div>
      )}

      <button
        onClick={handlePress}
        style={{ position: 'fixed' }}
        className="bottom-24 right-5 w-14 h-14 rounded-2xl btn-gradient shadow-lg shadow-indigo-500/30 flex items-center justify-center active:scale-90 transition-all z-40 animate-glow"
      >
        {menuOpen ? (
          <X size={22} strokeWidth={2.5} className="text-white" />
        ) : isLoansTab ? (
          <Users size={20} strokeWidth={2.5} className="text-white" />
        ) : (
          <Plus size={22} strokeWidth={2.5} className="text-white" />
        )}
      </button>
    </>
  );
}
