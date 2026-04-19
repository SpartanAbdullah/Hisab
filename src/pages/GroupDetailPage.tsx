import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Handshake, Trash2, Share2, Clock3, Copy } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { LanguageToggle } from '../components/LanguageToggle';
import { AddGroupExpenseModal } from './AddGroupExpenseModal';
import { EditGroupExpenseModal } from './EditGroupExpenseModal';
import { SettleUpModal } from './SettleUpModal';
import { GroupInviteModal } from '../components/GroupInviteModal';
import { ProgressRing } from '../components/ProgressRing';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { useToast } from '../components/Toast';
import { subscribeToGroupMembers } from '../lib/realtime';
import type { SplitGroup, GroupExpense, GroupEvent, GroupSettlement } from '../db';

function memberStatusClass(status?: string, isOwner?: boolean) {
  if (isOwner) return 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-200';
  if (status === 'connected') return 'bg-emerald-100 text-emerald-700';
  if (status === 'invited') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-600';
}

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();
  const { groups, getGroupExpenses, getSimplifiedDebts, deleteGroup, getGroupEvents, getSettlements } = useSplitStore();

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [expenses, setExpenses] = useState<GroupExpense[]>([]);
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [settlements, setSettlements] = useState<GroupSettlement[]>([]);
  const [debts, setDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'activity'>('expenses');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [editExpense, setEditExpense] = useState<GroupExpense | null>(null);

  useEffect(() => {
    const nextGroup = groups.find(item => item.id === id);
    if (nextGroup) setGroup(nextGroup);
  }, [groups, id]);

  const reload = async () => {
    if (!id) return;
    const [nextExpenses, nextDebts, nextEvents, nextSettlements] = await Promise.all([
      getGroupExpenses(id),
      getSimplifiedDebts(id),
      getGroupEvents(id),
      getSettlements(id),
    ]);
    setExpenses(nextExpenses);
    setDebts(nextDebts);
    setEvents(nextEvents);
    setSettlements(nextSettlements);
  };

  useEffect(() => {
    void reload();
  }, [id]);

  // While this page is open, subscribe to member changes on this group so
  // the header avatars and member count reflect joins/leaves instantly.
  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToGroupMembers(id, () => {
      void useSplitStore.getState().loadGroups();
      void reload();
    });
    return unsubscribe;
  }, [id]);

  if (!group) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-mesh">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  const getMemberName = (memberId: string) => group.members.find(member => member.id === memberId)?.name ?? '?';
  const currentMember = group.members.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))
    ?? group.members.find(member => member.isOwner);

  // Group-level health: total spend, settlements, and how far toward "zero
  // imbalance" the group is. Used both by the summary card and by the
  // per-member rings on the Balances tab.
  const totalSpend = expenses.reduce((s, e) => s + e.amount, 0);
  const totalSettled = settlements.reduce((s, x) => s + x.amount, 0);
  const totalOutstanding = debts.reduce((s, d) => s + d.amount, 0);
  const settledRatio = totalOutstanding === 0
    ? 1
    : totalSettled / (totalSettled + totalOutstanding);
  const settledPct = Math.round(Math.max(0, Math.min(1, settledRatio)) * 100);

  // Per-member net balance — positive = owed money, negative = owes money.
  const memberNet = new Map<string, number>();
  for (const member of group.members) memberNet.set(member.id, 0);
  for (const d of debts) {
    memberNet.set(d.to, (memberNet.get(d.to) ?? 0) + d.amount);
    memberNet.set(d.from, (memberNet.get(d.from) ?? 0) - d.amount);
  }
  const maxAbs = Math.max(
    1,
    ...Array.from(memberNet.values()).map(v => Math.abs(v)),
  );

  const handleDelete = async () => {
    if (confirm(t('group_delete_confirm'))) {
      await deleteGroup(group.id);
      navigate('/groups');
    }
  };

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <header className="sticky top-0 glass border-b border-slate-100/60 px-5 pt-safe pb-3.5 z-40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors">
              <ArrowLeft size={16} className="text-slate-500" />
            </button>
            <span className="text-xl">{group.emoji}</span>
            <div className="min-w-0">
              <h1 className="text-[17px] font-bold tracking-tight text-slate-800 truncate">{group.name}</h1>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {group.members.filter(member => member.status === 'connected').length} connected
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={() => setShowInvite(true)} className="w-8 h-8 rounded-xl flex items-center justify-center bg-indigo-50 active:bg-indigo-100 transition-colors">
              <Share2 size={14} className="text-indigo-500" />
            </button>
            <button onClick={handleDelete} className="w-8 h-8 rounded-xl flex items-center justify-center bg-red-50 active:bg-red-100 transition-colors">
              <Trash2 size={14} className="text-red-400" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 mt-3 overflow-x-auto no-scrollbar">
          {group.members.map(member => (
            <div key={member.id} className="flex flex-col items-center gap-1 shrink-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ${memberStatusClass(member.status, member.isOwner)}`}>
                {member.name.charAt(0).toUpperCase()}
              </div>
              <span className="text-[9px] text-slate-400">
                {member.isOwner ? 'owner' : member.status ?? 'guest'}
              </span>
            </div>
          ))}
          <span className="text-[10px] text-slate-400 ml-1.5">{group.members.length} {t('group_members_count')}</span>
        </div>
      </header>

      {group.joinCode && (
        <div className="px-5 pt-4">
          <div className="card-premium p-3.5 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
              <Share2 size={16} className="text-indigo-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Group Code</p>
              <p className="text-[15px] font-bold text-slate-800 font-mono tracking-tight">{group.joinCode}</p>
            </div>
            <button
              onClick={async () => {
                if (!group.joinCode) return;
                await navigator.clipboard.writeText(group.joinCode);
                toast.show({ type: 'success', title: 'Code copied', subtitle: 'Share it so others can join.' });
              }}
              className="shrink-0 rounded-xl bg-slate-100 text-slate-600 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
      )}

      {/* Group health — total spend on the left, settled-% ring on the right.
          Always present once there's any activity so users have an at-a-glance
          sense of how far from "fully settled" the group is. */}
      {tab !== 'activity' && totalSpend > 0 && (
        <div className="px-5 pt-4">
          <div className="card-premium p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Group spend</p>
              <p className="text-[22px] font-extrabold text-slate-800 tabular-nums tracking-tight mt-0.5 leading-tight">
                {formatMoney(totalSpend, group.currency)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {totalOutstanding === 0 ? (
                  <span className="text-emerald-600 font-semibold">All settled</span>
                ) : (
                  <>
                    <span className="text-rose-500 font-semibold">{formatMoney(totalOutstanding, group.currency)}</span>
                    <span> outstanding</span>
                  </>
                )}
                <span className="mx-1.5">·</span>{expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}
              </p>
            </div>
            <ProgressRing
              size={56}
              strokeWidth={5}
              progress={settledRatio}
              color={totalOutstanding === 0 ? '#10b981' : '#6366f1'}
              trackColor="#f1f5f9"
            >
              <span className={`text-[11px] font-extrabold tabular-nums ${
                totalOutstanding === 0 ? 'text-emerald-600' : 'text-indigo-600'
              }`}>
                {settledPct}%
              </span>
            </ProgressRing>
          </div>
        </div>
      )}

      {debts.length > 0 && tab !== 'activity' && (
        <div className="px-5 pt-3">
          <div className="card-premium p-4 space-y-2.5">
            {debts.map((debt, index) => (
              <div key={`${debt.from}-${debt.to}-${index}`} className="flex items-center justify-between">
                <p className="text-[12px] text-slate-600">
                  <span className="font-bold text-red-500">{debt.fromName}</span>
                  {' '}{t('group_owes')}{' '}
                  <span className="font-bold text-emerald-600">{debt.toName}</span>
                </p>
                <p className="text-[13px] font-bold text-slate-800 tabular-nums">{formatMoney(debt.amount, group.currency)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 px-5 pt-5">
        {(['expenses', 'balances', 'activity'] as const).map(nextTab => (
          <button
            key={nextTab}
            onClick={() => setTab(nextTab)}
            className={`px-4 py-2 rounded-xl text-[12px] font-bold transition-all ${tab === nextTab ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}
          >
            {nextTab === 'expenses' ? t('group_expenses') : nextTab === 'balances' ? t('group_balances') : 'Activity'}
          </button>
        ))}
      </div>

      {tab === 'expenses' ? (
        <div className="px-5 pt-4 space-y-2">
          {expenses.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <p className="text-sm">{t('group_no_expenses')}</p>
            </div>
          ) : (
            expenses.map((expense, index) => (
              <button
                key={expense.id}
                onClick={() => setEditExpense(expense)}
                className="w-full text-left card-premium p-4 animate-fade-in active:scale-[0.98] transition-all"
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{expense.description}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {getMemberName(expense.paidBy)} {t('group_paid_by').toLowerCase()} &middot; {expense.splitType}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[14px] font-bold text-slate-800 tabular-nums">{formatMoney(expense.amount, group.currency)}</p>
                    <p className="text-[9px] text-slate-400">{new Date(expense.date).toLocaleDateString()}</p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      ) : tab === 'balances' ? (
        <div className="px-5 pt-4 space-y-2">
          {group.members.map(member => {
            if (member.id === currentMember?.id) return null;
            const owedToMe = debts.filter(debt => debt.from === member.id && debt.to === currentMember?.id).reduce((sum, debt) => sum + debt.amount, 0);
            const iOwe = debts.filter(debt => debt.to === member.id && debt.from === currentMember?.id).reduce((sum, debt) => sum + debt.amount, 0);
            // Ring visualises this member's weight in the group's outstanding
            // imbalance: larger ring = bigger net position either way.
            const net = memberNet.get(member.id) ?? 0;
            const ringProgress = Math.abs(net) / maxAbs;
            const isPositive = net > 0.01;
            const isNegative = net < -0.01;
            const ringColor = isPositive ? '#10b981' : isNegative ? '#f43f5e' : '#cbd5e1';
            return (
              <div key={member.id} className="card-premium p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 ${memberStatusClass(member.status, member.isOwner)}`}>
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-700 truncate">{member.name}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{member.status ?? 'guest'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    {owedToMe > 0 ? (
                      <p className="text-[12px] font-bold text-emerald-600 tabular-nums">+{formatMoney(owedToMe, group.currency)}</p>
                    ) : iOwe > 0 ? (
                      <p className="text-[12px] font-bold text-red-500 tabular-nums">-{formatMoney(iOwe, group.currency)}</p>
                    ) : (
                      <p className="text-[11px] text-slate-400">{t('group_settled')}</p>
                    )}
                  </div>
                  <ProgressRing
                    size={36}
                    strokeWidth={3}
                    progress={ringProgress}
                    color={ringColor}
                    trackColor="#f1f5f9"
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-5 pt-4 space-y-2">
          {events.length === 0 ? (
            <div className="card-premium p-6 text-center">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 mx-auto flex items-center justify-center">
                <Clock3 size={22} />
              </div>
              <p className="text-sm font-semibold text-slate-700 mt-3">No shared activity yet</p>
              <p className="text-[12px] text-slate-400 mt-1">Adds, edits, deletes, joins, and settlements will appear here for everyone.</p>
            </div>
          ) : (
            events.map((event, index) => (
              <div key={event.id} className="card-premium p-4 animate-fade-in" style={{ animationDelay: `${index * 30}ms` }}>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                    <Clock3 size={16} />
                  </div>
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-slate-700 leading-snug">{event.summary}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{new Date(event.createdAt).toLocaleString()}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="fixed bottom-24 left-0 right-0 px-5 z-30">
        <div className="flex gap-2.5 max-w-[480px] mx-auto">
          <button
            onClick={() => setShowAddExpense(true)}
            className="flex-1 btn-gradient rounded-2xl py-3 text-sm font-bold shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
          >
            <Plus size={16} /> {t('group_expense_add')}
          </button>
          <button
            onClick={() => setShowSettle(true)}
            className="px-5 rounded-2xl py-3 text-sm font-bold bg-emerald-500 text-white shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 active:scale-95 transition-all"
          >
            <Handshake size={16} /> {t('group_settle')}
          </button>
        </div>
      </div>

      <AddGroupExpenseModal open={showAddExpense} group={group} onClose={() => { setShowAddExpense(false); void reload(); }} />
      <EditGroupExpenseModal open={!!editExpense} group={group} expense={editExpense} onClose={() => { setEditExpense(null); void reload(); }} />
      <SettleUpModal open={showSettle} group={group} debts={debts} onClose={() => { setShowSettle(false); void reload(); }} />
      <GroupInviteModal open={showInvite} group={group} onClose={() => { setShowInvite(false); void reload(); }} />
    </div>
  );
}
