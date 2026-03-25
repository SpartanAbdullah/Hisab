import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { CreateGroupModal } from './CreateGroupModal';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';

export function SplitsPage() {
  const { groups, loadGroups } = useSplitStore();
  const [showCreate, setShowCreate] = useState(false);
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
            <button onClick={() => setShowCreate(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5">
              <Plus size={13} strokeWidth={2.5} /> {t('naya')}
            </button>
          </div>
        }
      />

      <div className="px-5 pt-5 space-y-2.5">
        {groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('group_empty')}
            description={t('group_empty_desc')}
            actionLabel={t('group_new')}
            onAction={() => setShowCreate(true)}
          />
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
    </div>
  );
}
