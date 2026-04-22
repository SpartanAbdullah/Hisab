import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useEmiStore } from '../stores/emiStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import type { LoanType } from '../db';

interface Props { open: boolean; onClose: () => void; }

export function AddLoanModal({ open, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { generateSchedule } = useEmiStore();
  const { loans } = useLoanStore();
  const t = useT();

  const [loanType, setLoanType] = useState<LoanType>('given');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [cashAdvanceSourceId, setCashAdvanceSourceId] = useState('');
  const [notes, setNotes] = useState('');
  const [hasEmi, setHasEmi] = useState(false);
  const [installments, setInstallments] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  void loans;

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  const destinationAccount = accounts.find((account) => account.id === accountId);
  const availableCashAdvanceCards = accounts.filter((account) => (
    account.type === 'credit_card' &&
    account.id !== accountId &&
    (!destinationAccount || account.currency === destinationAccount.currency)
  ));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    const trimmedName = contact.name.trim();
    if (!amt || !trimmedName || !accountId) { setError(t('fill_all')); return; }
    setSaving(true);
    try {
      const person = contact.id
        ? { id: contact.id, name: trimmedName }
        : await usePersonStore.getState().findOrCreateByName(trimmedName);
      const tx = await processTransaction(
        loanType === 'given'
          ? { type: 'loan_given', amount: amt, sourceAccountId: accountId, personName: person.name, personId: person.id, notes }
          : {
              type: 'loan_taken',
              amount: amt,
              destinationAccountId: accountId,
              sourceAccountId: cashAdvanceSourceId || undefined,
              personName: person.name,
              personId: person.id,
              notes,
            }
      );
      if (hasEmi && tx.relatedLoanId && installments && startDate) {
        await generateSchedule({ loanId: tx.relatedLoanId, totalAmount: amt, installments: parseInt(installments), startDate });
      }
      setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
      setHasEmi(false); setInstallments(''); setStartDate('');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  const inputClass = 'w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all';

  return (
    <Modal open={open} onClose={onClose} title={t('loan_new')}
      footer={
        <button type="submit" form="loan-form" disabled={saving}
          className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
        >{saving ? t('loan_creating') : t('loan_create')}</button>
      }
    >
      <form id="loan-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-2.5">
          {(['given', 'taken'] as const).map(tp => (
            <button key={tp} type="button" onClick={() => setLoanType(tp)}
              className={`flex-1 py-3 rounded-2xl text-[13px] font-bold border-2 transition-all active:scale-[0.97] ${
                loanType === tp
                  ? tp === 'given' ? 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white border-transparent shadow-md' : 'bg-gradient-to-r from-amber-500 to-orange-500 text-white border-transparent shadow-md'
                  : 'bg-white text-slate-500 border-slate-200/60'
              }`}
            >{tp === 'given' ? t('loan_i_gave') : t('loan_i_took')}</button>
          ))}
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('loan_to_whom')}</label>
          <ContactPicker value={contact} onChange={setContact} placeholder="Naam likho..." required className={inputClass} />
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Amount</label>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className={`${inputClass} text-center text-lg font-bold tabular-nums`} required />
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{loanType === 'given' ? t('loan_paid_from') : t('loan_received_into')}</label>
          <div className="space-y-2">
            {accounts.map(a => {
              const meta = currencyMeta[a.currency];
              return (
                <button key={a.id} type="button" onClick={() => setAccountId(a.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    accountId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                  }`}
                >
                  <span className="text-[13px] font-semibold text-slate-700 flex items-center gap-1.5"><span>{meta?.flag}</span> {a.name}</span>
                  <span className="text-[12px] text-slate-400 tabular-nums">{a.currency}</span>
                </button>
              );
            })}
          </div>
        </div>

        {loanType === 'taken' && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Cash Advance Source</label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setCashAdvanceSourceId('')}
                className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                  !cashAdvanceSourceId ? 'border-indigo-400 bg-indigo-50/50 text-indigo-700' : 'border-slate-200/60 bg-white text-slate-500'
                }`}
              >
                No credit card
              </button>
              {availableCashAdvanceCards.map(a => (
                <button key={a.id} type="button" onClick={() => setCashAdvanceSourceId(a.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    cashAdvanceSourceId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                  }`}
                >
                  <span className="text-[13px] font-semibold text-slate-700">{a.name}</span>
                  <span className="text-[12px] text-slate-400 tabular-nums">{a.currency}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_note')}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Koi detail..." className={inputClass} />
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-slate-50/80 border border-slate-100/60">
          <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-indigo-600 accent-indigo-600" />
          <span className="text-[13px] text-slate-600 font-medium">{t('loan_set_emi')}</span>
        </label>

        {hasEmi && (
          <div className="grid grid-cols-2 gap-3 animate-fade-in">
            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('loan_installments')}</label>
              <input type="number" value={installments} onChange={e => setInstallments(e.target.value)} placeholder="12" className={inputClass} required />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputClass} required />
            </div>
          </div>
        )}

        {error && <p className="text-[12px] text-red-500 font-semibold bg-red-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
  );
}
