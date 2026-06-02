import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import type { SplitGroup } from '../db';
import { friendlyGroupParticipantError, validateNewSettlementParticipants } from '../lib/groupActiveMembers';

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
  const [error, setError] = useState('');
  const activeDebts = debts.filter((debt) =>
    validateNewSettlementParticipants(group, debt.from, debt.to) === null
  );

  const handleSettle = async () => {
    if (!selectedDebt) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (amt > selectedDebt.amount + 0.00001) {
      setError(`Amount cannot exceed the outstanding ${formatMoney(selectedDebt.amount, group.currency)}.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await addSettlement({ groupId: group.id, fromMember: selectedDebt.from, toMember: selectedDebt.to, amount: amt, note });
      toast.show({
        type: 'success',
        title: 'Settlement saved',
        subtitle: `${selectedDebt.fromName} paid ${selectedDebt.toName} ${formatMoney(amt, group.currency)}.`,
      });
      setSelectedDebt(null); setAmount(''); setNote('');
      onClose();
    } catch (error) {
      const message = friendlyGroupParticipantError(error) || (error instanceof Error ? error.message : t('error'));
      setError(message);
      toast.show({ type: 'error', title: 'Settlement not saved', subtitle: message });
    }
    finally { setSaving(false); }
  };

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-white transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_settle_title')} footer={
      selectedDebt ? (
        <button onClick={handleSettle} disabled={saving}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : t('group_settle_save')}
        </button>
      ) : undefined
    }>
      <div className="p-5 space-y-4">
        {!selectedDebt ? (
          activeDebts.length === 0 ? (
            <p className="text-center text-ink-500 text-sm py-4">{t('group_settled')}</p>
          ) : (
            activeDebts.map((d, i) => (
              <button key={i} onClick={() => { setSelectedDebt(d); setAmount(d.amount.toString()); setError(''); }}
                className="w-full rounded-2xl bg-cream-card border border-cream-border p-4 flex items-center justify-between text-left active:scale-[0.98] transition-all">
                <div>
                  <p className="text-[13px] font-semibold text-ink-800">
                    {d.fromName} &rarr; {d.toName}
                  </p>
                  <p className="text-[10px] text-ink-500 mt-0.5">{t('group_settle').toLowerCase()}</p>
                </div>
                <p className="text-[14px] font-bold text-ink-900 tabular-nums">{formatMoney(d.amount, group.currency)}</p>
              </button>
            ))
          )
        ) : (
          <>
            <div className="bg-accent-100 rounded-2xl p-4 text-center">
              <p className="text-[12px] text-accent-600 font-medium">
                {selectedDebt.fromName} &rarr; {selectedDebt.toName}
              </p>
              <p className="text-xl font-bold text-accent-600 mt-1">{formatMoney(selectedDebt.amount, group.currency)}</p>
            </div>
            <div>
              <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_settle_amount')}</label>
              <input className={inputClass + ' mt-1.5 text-lg font-bold'} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2">
                {error}
              </p>
            )}
            <div>
              <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_settle_note')}</label>
              <input className={inputClass + ' mt-1.5'} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Cash diya" />
            </div>
            <button onClick={() => { setSelectedDebt(null); setError(''); }} className="text-[12px] text-ink-500 font-medium underline">
              &larr; Back
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
