import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Handshake, Trash2 } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { LanguageToggle } from '../components/LanguageToggle';
import { AddGroupExpenseModal } from './AddGroupExpenseModal';
import { SettleUpModal } from './SettleUpModal';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { SplitGroup, GroupExpense } from '../db';

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT();
  const { groups, getGroupExpenses, getSimplifiedDebts, deleteGroup } = useSplitStore();

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [expenses, setExpenses] = useState<GroupExpense[]>([]);
  const [debts, setDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  const [tab, setTab] = useState<'expenses' | 'balances'>('expenses');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showSettle, setShowSettle] = useState(false);

  useEffect(() => {
    const g = groups.find(g => g.id === id);
    if (g) setGroup(g);
  }, [groups, id]);

  const reload = async () => {
    if (!id) return;
    const [exps, debts] = await Promise.all([getGroupExpenses(id), getSimplifiedDebts(id)]);
    setExpenses(exps);
    setDebts(debts);
  };

  useEffect(() => { reload(); }, [id]);

  if (!group) return <div className="min-h-dvh flex items-center justify-center bg-mesh"><p className="text-slate-400">Loading...</p></div>;

  const getMemberName = (memberId: string) => group.members.find(m => m.id === memberId)?.name ?? '?';
  const owner = group.members.find(m => m.isOwner);

  const handleDelete = async () => {
    if (confirm(t('group_delete_confirm'))) {
      await deleteGroup(group.id);
      navigate('/groups');
    }
  };

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      {/* Header */}
      <header className="sticky top-0 glass border-b border-slate-100/60 px-5 py-3.5 z-40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors">
              <ArrowLeft size={16} className="text-slate-500" />
            </button>
            <span className="text-xl">{group.emoji}</span>
            <h1 className="text-[17px] font-bold tracking-tight text-slate-800">{group.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={handleDelete} className="w-8 h-8 rounded-xl flex items-center justify-center bg-red-50 active:bg-red-100 transition-colors">
              <Trash2 size={14} className="text-red-400" />
            </button>
          </div>
        </div>

        {/* Member avatars */}
        <div className="flex items-center gap-1 mt-3 overflow-x-auto no-scrollbar">
          {group.members.map(m => (
            <div key={m.id} className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ${m.isOwner ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>
              {m.name.charAt(0).toUpperCase()}
            </div>
          ))}
          <span className="text-[10px] text-slate-400 ml-1.5">{group.members.length} {t('group_members_count')}</span>
        </div>
      </header>

      {/* Simplified Debts Card */}
      {debts.length > 0 && (
        <div className="px-5 pt-4">
          <div className="card-premium p-4 space-y-2.5">
            {debts.map((d, i) => (
              <div key={i} className="flex items-center justify-between">
                <p className="text-[12px] text-slate-600">
                  <span className="font-bold text-red-500">{d.fromName}</span>
                  {' '}{t('group_owes')}{' '}
                  <span className="font-bold text-emerald-600">{d.toName}</span>
                </p>
                <p className="text-[13px] font-bold text-slate-800 tabular-nums">{formatMoney(d.amount, group.currency)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 px-5 pt-5">
        {(['expenses', 'balances'] as const).map(tb => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`px-4 py-2 rounded-xl text-[12px] font-bold transition-all ${tab === tb ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
            {tb === 'expenses' ? t('group_expenses') : t('group_balances')}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'expenses' ? (
        <div className="px-5 pt-4 space-y-2">
          {expenses.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <p className="text-sm">{t('group_no_expenses')}</p>
            </div>
          ) : (
            expenses.map((exp, i) => (
              <div key={exp.id} className="card-premium p-4 animate-fade-in" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{exp.description}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {getMemberName(exp.paidBy)} {t('group_paid_by').toLowerCase()} &middot; {exp.splitType}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[14px] font-bold text-slate-800 tabular-nums">{formatMoney(exp.amount, group.currency)}</p>
                    <p className="text-[9px] text-slate-400">{new Date(exp.date).toLocaleDateString()}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="px-5 pt-4 space-y-2">
          {group.members.map(m => {
            const owedToMe = debts.filter(d => d.from === m.id && d.to === owner?.id).reduce((s, d) => s + d.amount, 0);
            const iOwe = debts.filter(d => d.to === m.id && d.from === owner?.id).reduce((s, d) => s + d.amount, 0);
            if (m.isOwner) return null;
            return (
              <div key={m.id} className="card-premium p-4 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-[12px] font-bold text-slate-600">
                    {m.name.charAt(0).toUpperCase()}
                  </div>
                  <p className="text-[13px] font-semibold text-slate-700">{m.name}</p>
                </div>
                <div className="text-right">
                  {owedToMe > 0 ? (
                    <p className="text-[12px] font-bold text-emerald-600">+{formatMoney(owedToMe, group.currency)}</p>
                  ) : iOwe > 0 ? (
                    <p className="text-[12px] font-bold text-red-500">-{formatMoney(iOwe, group.currency)}</p>
                  ) : (
                    <p className="text-[11px] text-slate-400">{t('group_settled')}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action buttons */}
      <div className="fixed bottom-24 left-0 right-0 px-5 z-30">
        <div className="flex gap-2.5 max-w-[480px] mx-auto">
          <button onClick={() => setShowAddExpense(true)}
            className="flex-1 btn-gradient rounded-2xl py-3 text-sm font-bold shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2">
            <Plus size={16} /> {t('group_expense_add')}
          </button>
          <button onClick={() => setShowSettle(true)}
            className="px-5 rounded-2xl py-3 text-sm font-bold bg-emerald-500 text-white shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 active:scale-95 transition-all">
            <Handshake size={16} /> {t('group_settle')}
          </button>
        </div>
      </div>

      <AddGroupExpenseModal open={showAddExpense} group={group} onClose={() => { setShowAddExpense(false); reload(); }} />
      <SettleUpModal open={showSettle} group={group} debts={debts} onClose={() => { setShowSettle(false); reload(); }} />
    </div>
  );
}
