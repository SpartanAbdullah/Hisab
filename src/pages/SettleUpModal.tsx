import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { SplitGroup } from '../db';

interface Debt { from: string; fromName: string; to: string; toName: string; amount: number; }
interface Props { open: boolean; group: SplitGroup; debts: Debt[]; onClose: () => void; }

export function SettleUpModal({ open, group, debts, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { addSettlement } = useSplitStore();
  const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSettle = async () => {
    if (!selectedDebt) return;
    const amt = parseFloat(amount) || selectedDebt.amount;
    setSaving(true);
    try {
      await addSettlement({ groupId: group.id, fromMember: selectedDebt.from, toMember: selectedDebt.to, amount: amt, note });
      toast.show({ type: 'success', title: t('done_btn') });
      setSelectedDebt(null); setAmount(''); setNote('');
      onClose();
    } catch { toast.show({ type: 'error', title: t('error') }); }
    finally { setSaving(false); }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_settle_title')} footer={
      selectedDebt ? (
        <button onClick={handleSettle} disabled={saving}
          className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : t('group_settle_save')}
        </button>
      ) : undefined
    }>
      <div className="p-5 space-y-4">
        {!selectedDebt ? (
          debts.length === 0 ? (
            <p className="text-center text-slate-400 text-sm py-4">{t('group_settled')}</p>
          ) : (
            debts.map((d, i) => (
              <button key={i} onClick={() => { setSelectedDebt(d); setAmount(d.amount.toString()); }}
                className="w-full card-premium p-4 flex items-center justify-between text-left active:scale-[0.98] transition-all">
                <div>
                  <p className="text-[13px] font-semibold text-slate-700">
                    {d.fromName} &rarr; {d.toName}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{t('group_settle').toLowerCase()}</p>
                </div>
                <p className="text-[14px] font-bold text-slate-800 tabular-nums">{formatMoney(d.amount, group.currency)}</p>
              </button>
            ))
          )
        ) : (
          <>
            <div className="bg-indigo-50 rounded-2xl p-4 text-center">
              <p className="text-[12px] text-indigo-600 font-medium">
                {selectedDebt.fromName} &rarr; {selectedDebt.toName}
              </p>
              <p className="text-xl font-bold text-indigo-700 mt-1">{formatMoney(selectedDebt.amount, group.currency)}</p>
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_settle_amount')}</label>
              <input className={inputClass + ' mt-1.5 text-lg font-bold'} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_settle_note')}</label>
              <input className={inputClass + ' mt-1.5'} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Cash diya" />
            </div>
            <button onClick={() => setSelectedDebt(null)} className="text-[12px] text-slate-400 font-medium underline">
              &larr; Back
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
