import { useState, useEffect } from 'react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { SplitGroup, GroupExpense, SplitType, SplitDetail } from '../db';
import { Trash2 } from 'lucide-react';

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

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (expense && open) {
      setDescription(expense.description);
      setAmount(String(expense.amount));
      setPaidBy(expense.paidBy);
      setSplitType(expense.splitType);
      setSelectedMembers(expense.splits.map(s => s.memberId));
      setCategory(expense.category || 'General');
      if (expense.splitType === 'exact') {
        const ea: Record<string, string> = {};
        expense.splits.forEach(s => { ea[s.memberId] = String(s.amount); });
        setExactAmounts(ea);
      }
    }
  }, [expense, open]);

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
        splits: selectedMembers.map((id, i) => ({
          memberId: id,
          amount: i === selectedMembers.length - 1 ? base + remainder : base,
        })),
      };
    }
    if (splitType === 'exact') {
      const splits = selectedMembers.map(id => ({ memberId: id, amount: parseFloat(exactAmounts[id] || '0') }));
      const total = splits.reduce((s, x) => s + x.amount, 0);
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
      });
      toast.show({ type: 'success', title: 'Expense updated!' });
      onClose();
    } catch { toast.show({ type: 'error', title: t('error') }); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!expense) return;
    if (confirm('Delete this expense?')) {
      await deleteGroupExpense(expense.id);
      toast.show({ type: 'success', title: 'Expense deleted' });
      onClose();
    }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

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
          <input className={inputClass + ' mt-1.5'} value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_amount')}</label>
          <input className={inputClass + ' mt-1.5 text-lg font-bold'} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_paid_by')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {group.members.map(m => (
              <button key={m.id} onClick={() => setPaidBy(m.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${paidBy === m.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_split_between')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {group.members.map(m => (
              <button key={m.id} onClick={() => toggleMember(m.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${selectedMembers.includes(m.id) ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_split_type')}</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['equal', 'exact'] as SplitType[]).map(st => (
              <button key={st} onClick={() => setSplitType(st)}
                className={`py-2 rounded-xl text-[11px] font-bold transition-all ${splitType === st ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {st === 'equal' ? t('group_split_equal') : t('group_split_exact')}
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
            <span className="text-[12px] text-slate-600 font-medium w-20 truncate">{group.members.find(m => m.id === id)?.name}</span>
            <input className="flex-1 border border-slate-200/60 rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
              value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
          </div>
        ))}

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('category')}</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {CATEGORIES.map(c => (
              <button key={c} onClick={() => setCategory(c)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${category === c ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
