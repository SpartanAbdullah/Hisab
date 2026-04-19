import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, LogIn } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { CreateGroupModal } from './CreateGroupModal';
import { JoinGroupModal } from './JoinGroupModal';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';

export function SplitsPage() {
  const { groups, loadGroups } = useSplitStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const navigate = useNavigate();
  const t = useT();

  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    const loadBalances = async () => {
      const store = useSplitStore.getState();
      const b: Record<string, number> = {};
      for (const g of groups) {
        b[g.id] = await store.getMyBalance(g.id);
      }
      setBalances(b);
    };
    if (groups.length > 0) loadBalances();
  }, [groups]);

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader
        title={t('groups_title')}
        action={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={() => setShowJoin(true)} className="bg-slate-100 text-slate-600 rounded-xl px-3 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all">
              <LogIn size={13} strokeWidth={2.5} /> Join
            </button>
            <button onClick={() => setShowCreate(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5">
              <Plus size={13} strokeWidth={2.5} /> {t('naya')}
            </button>
          </div>
        }
      />

      <div className="px-5 pt-5 space-y-2.5">
        {groups.length === 0 ? (
          <div className="card-premium p-8 text-center animate-fade-in">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center">
              <Users size={24} className="text-indigo-500" />
            </div>
            <p className="text-[15px] font-bold text-slate-800 mt-4 tracking-tight">{t('group_empty')}</p>
            <p className="text-[12px] text-slate-400 mt-1.5 leading-relaxed max-w-[260px] mx-auto">
              {t('group_empty_desc')}
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                onClick={() => setShowJoin(true)}
                className="flex-1 rounded-2xl py-3 text-[13px] font-bold bg-slate-100 text-slate-700 active:scale-95 transition-all flex items-center justify-center gap-1.5"
              >
                <LogIn size={14} /> Join Group
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="flex-1 rounded-2xl py-3 text-[13px] font-bold btn-gradient active:scale-95 transition-all flex items-center justify-center gap-1.5"
              >
                <Plus size={14} /> Create Group
              </button>
            </div>
          </div>
        ) : (
          groups.map((g, i) => {
            const bal = balances[g.id] ?? 0;
            return (
              <button
                key={g.id}
                onClick={() => navigate(`/group/${g.id}`)}
                className="w-full card-premium p-4 flex items-center gap-3.5 animate-fade-in text-left"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center text-xl shrink-0">
                  {g.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-bold text-slate-800 truncate">{g.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{g.members.length} {t('group_members_count')}</p>
                </div>
                <div className="text-right shrink-0">
                  {bal > 0 ? (
                    <p className="text-[12px] font-bold text-emerald-600">+{formatMoney(bal, g.currency)}</p>
                  ) : bal < 0 ? (
                    <p className="text-[12px] font-bold text-red-500">-{formatMoney(Math.abs(bal), g.currency)}</p>
                  ) : (
                    <p className="text-[11px] text-slate-400 font-medium">{t('group_settled')}</p>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      <CreateGroupModal open={showCreate} onClose={() => { setShowCreate(false); loadGroups(); }} />
      <JoinGroupModal open={showJoin} onClose={() => { setShowJoin(false); loadGroups(); }} />
    </div>
  );
}
