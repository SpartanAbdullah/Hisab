import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { SplitGroup, SplitType, SplitDetail } from '../db';

interface Props { open: boolean; group: SplitGroup; onClose: () => void; }

const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Health', 'General'];

export function AddGroupExpenseModal({ open, group, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { addGroupExpense } = useSplitStore();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(group.members.find(m => m.isOwner)?.id ?? '');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(group.members.map(m => m.id));
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [saving, setSaving] = useState(false);

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

    if (splitType === 'percentage') {
      const splits = selectedMembers.map(id => {
        const pct = parseFloat(percentages[id] || '0');
        return { memberId: id, amount: Math.round((pct / 100) * amt * 100) / 100 };
      });
      const totalPct = selectedMembers.reduce((s, id) => s + (parseFloat(percentages[id] || '0')), 0);
      if (Math.abs(totalPct - 100) > 0.01) return { valid: false, splits, error: t('group_pct_mismatch') };
      return { valid: true, splits };
    }

    if (splitType === 'shares') {
      const totalShares = selectedMembers.reduce((s, id) => s + (parseFloat(shares[id] || '1')), 0);
      if (totalShares === 0) return { valid: false, splits: [], error: t('fill_all') };
      const splits = selectedMembers.map(id => {
        const sh = parseFloat(shares[id] || '1');
        return { memberId: id, amount: Math.round((sh / totalShares) * amt * 100) / 100 };
      });
      return { valid: true, splits };
    }

    return { valid: false, splits: [] };
  };

  const handleSubmit = async () => {
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
      await addGroupExpense({ groupId: group.id, description: description.trim(), amount: amt, paidBy, splitType, splits, category });
      toast.show({ type: 'success', title: t('acct_created'), subtitle: description });
      setDescription(''); setAmount('');
      onClose();
    } catch { toast.show({ type: 'error', title: t('error') }); }
    finally { setSaving(false); }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_expense_add')} footer={
      <button onClick={handleSubmit} disabled={saving || !description.trim() || amt <= 0}
        className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
        {saving ? t('quick_processing') : t('group_save_expense')}
      </button>
    }>
      <div className="space-y-5 p-5">
        {/* Description */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_desc')}</label>
          <input className={inputClass + ' mt-1.5'} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('group_desc_placeholder')} />
        </div>

        {/* Amount */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_amount')}</label>
          <input className={inputClass + ' mt-1.5 text-lg font-bold'} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
        </div>

        {/* Paid By */}
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

        {/* Split Between */}
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

        {/* Split Type */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_split_type')}</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['equal', 'exact', 'percentage', 'shares'] as SplitType[]).map(st => (
              <button key={st} onClick={() => setSplitType(st)}
                className={`py-2 rounded-xl text-[11px] font-bold transition-all ${splitType === st ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {st === 'equal' ? t('group_split_equal') : st === 'exact' ? t('group_split_exact') : st === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {/* Split inputs */}
        {amt > 0 && selectedMembers.length > 0 && (
          <div className="space-y-2">
            {splitType === 'equal' && (
              <p className="text-[12px] text-slate-500 bg-slate-50 rounded-xl px-3 py-2.5 text-center font-medium">
                {t('group_each_pays')}: <span className="font-bold text-slate-800">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
              </p>
            )}
            {splitType === 'exact' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-slate-600 font-medium w-20 truncate">{group.members.find(m => m.id === id)?.name}</span>
                <input className="flex-1 border border-slate-200/60 rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
                  value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
              </div>
            ))}
            {splitType === 'percentage' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-slate-600 font-medium w-20 truncate">{group.members.find(m => m.id === id)?.name}</span>
                <input className="flex-1 border border-slate-200/60 rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
                  value={percentages[id] || ''} onChange={e => setPercentages({ ...percentages, [id]: e.target.value })} placeholder="%" />
                <span className="text-[11px] text-slate-400">%</span>
              </div>
            ))}
            {splitType === 'shares' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-slate-600 font-medium w-20 truncate">{group.members.find(m => m.id === id)?.name}</span>
                <input className="flex-1 border border-slate-200/60 rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="numeric"
                  value={shares[id] || '1'} onChange={e => setShares({ ...shares, [id]: e.target.value })} placeholder="1" />
                <span className="text-[11px] text-slate-400">shares</span>
              </div>
            ))}
          </div>
        )}

        {/* Category */}
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
