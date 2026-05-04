import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { parseInternalNote } from '../lib/internalNotes';
import type { SplitGroup, GroupExpense, SplitType, SplitDetail } from '../db';

interface Props {
  open: boolean;
  group: SplitGroup;
  expense: GroupExpense | null;
  onClose: () => void;
}

const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Health', 'General'];

export function EditGroupExpenseModal({ open, group, expense, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { updateGroupExpense, deleteGroupExpense } = useSplitStore();
  const { accounts, loadAccounts } = useAccountStore();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  const currentMemberId = group.members.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))?.id ?? '';
  const shouldTrackExpense = paidBy === currentMemberId && accounts.length > 0;

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  useEffect(() => {
    if (expense && open) {
      const meta = parseInternalNote(expense.notes).meta;
      setDescription(expense.description);
      setAmount(String(expense.amount));
      setPaidBy(expense.paidBy);
      setSplitType(expense.splitType);
      setSelectedMembers(expense.splits.map(split => split.memberId));
      setCategory(expense.category || 'General');
      setPaidFromAccountId(meta.paidFromAccountId ?? '');
      if (expense.splitType === 'exact') {
        const values: Record<string, string> = {};
        expense.splits.forEach(split => { values[split.memberId] = String(split.amount); });
        setExactAmounts(values);
      }
    }
  }, [expense, open]);

  useEffect(() => {
    if (!open) return;
    if (!shouldTrackExpense) {
      setPaidFromAccountId('');
      return;
    }
    if (!paidFromAccountId || !accounts.some(account => account.id === paidFromAccountId)) {
      setPaidFromAccountId(accounts[0]?.id ?? '');
    }
  }, [open, shouldTrackExpense, paidFromAccountId, accounts]);

  const amt = parseFloat(amount) || 0;

  const toggleMember = (id: string) => {
    setSelectedMembers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const computeSplits = (): { valid: boolean; splits: SplitDetail[]; error?: string } => {
    if (selectedMembers.length === 0) return { valid: false, splits: [], error: t('fill_all') };
    if (splitType === 'equal') {
      const base = Math.floor((amt * 100) / selectedMembers.length) / 100;
      const remainder = Math.round((amt - base * selectedMembers.length) * 100) / 100;
      return {
        valid: true,
        splits: selectedMembers.map((id, index) => ({
          memberId: id,
          amount: index === selectedMembers.length - 1 ? base + remainder : base,
        })),
      };
    }
    if (splitType === 'exact') {
      const splits = selectedMembers.map(id => ({ memberId: id, amount: parseFloat(exactAmounts[id] || '0') }));
      const total = splits.reduce((sum, split) => sum + split.amount, 0);
      if (Math.abs(total - amt) > 0.01) return { valid: false, splits, error: t('group_total_mismatch') };
      return { valid: true, splits };
    }
    return { valid: true, splits: selectedMembers.map(id => ({ memberId: id, amount: amt / selectedMembers.length })) };
  };

  const handleSave = async () => {
    if (!expense) return;
    if (!description.trim() || amt <= 0 || !paidBy) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    if (shouldTrackExpense && !paidFromAccountId) {
      toast.show({ type: 'error', title: 'Select the account you paid from' });
      return;
    }
    const { valid, splits, error } = computeSplits();
    if (!valid) {
      toast.show({ type: 'error', title: error || t('error') });
      return;
    }
    setSaving(true);
    try {
      await updateGroupExpense(expense.id, {
        description: description.trim(),
        amount: amt,
        paidBy,
        splitType,
        splits,
        category,
        paidFromAccountId: shouldTrackExpense ? paidFromAccountId : null,
      });
      toast.show({ type: 'success', title: 'Expense updated!' });
      onClose();
    } catch {
      toast.show({ type: 'error', title: t('error') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!expense) return;
    if (confirm('Delete this expense?')) {
      await deleteGroupExpense(expense.id);
      toast.show({ type: 'success', title: 'Expense deleted' });
      onClose();
    }
  };

  const inputClass = 'w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all';

  return (
    <Modal open={open} onClose={onClose} title="Edit Expense" footer={
      <div className="flex gap-2">
        <button onClick={handleDelete} className="px-4 py-3.5 rounded-2xl bg-red-50 text-red-500 active:bg-red-100 transition-all">
          <Trash2 size={16} />
        </button>
        <button onClick={handleSave} disabled={saving || !description.trim() || amt <= 0}
          className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : 'Save Changes'}
        </button>
      </div>
    }>
      <div className="space-y-5 p-5">
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_desc')}</label>
          <input className={`${inputClass} mt-1.5`} value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_amount')}</label>
          <input className={`${inputClass} mt-1.5 text-lg font-bold`} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_paid_by')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {group.members.map(member => (
              <button key={member.id} onClick={() => setPaidBy(member.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${paidBy === member.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                {member.name}
              </button>
            ))}
          </div>
        </div>

        {shouldTrackExpense && (
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Paid From</label>
            <div className="space-y-2 mt-1.5">
              {accounts.map(account => (
                <button key={account.id} onClick={() => setPaidFromAccountId(account.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all ${
                    paidFromAccountId === account.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                  }`}>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-700">{account.name}</p>
                    <p className="text-[10px] text-slate-400 capitalize">{account.type.replace('_', ' ')}</p>
                  </div>
                  <p className="text-[13px] font-bold text-slate-700 tabular-nums">{formatSignedMoney(account.balance, account.currency)}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_split_between')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {group.members.map(member => (
              <button key={member.id} onClick={() => toggleMember(member.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${selectedMembers.includes(member.id) ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                {member.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_split_type')}</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['equal', 'exact'] as SplitType[]).map(split => (
              <button key={split} onClick={() => setSplitType(split)}
                className={`py-2 rounded-xl text-[11px] font-bold transition-all ${splitType === split ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {split === 'equal' ? t('group_split_equal') : t('group_split_exact')}
              </button>
            ))}
          </div>
        </div>

        {amt > 0 && selectedMembers.length > 0 && splitType === 'equal' && (
          <p className="text-[12px] text-slate-500 bg-slate-50 rounded-xl px-3 py-2.5 text-center font-medium">
            {t('group_each_pays')}: <span className="font-bold text-slate-800">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
          </p>
        )}

        {amt > 0 && splitType === 'exact' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2">
            <span className="text-[12px] text-slate-600 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="flex-1 border border-slate-200/60 rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
              value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
          </div>
        ))}

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('category')}</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {CATEGORIES.map(item => (
              <button key={item} onClick={() => setCategory(item)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${category === item ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
