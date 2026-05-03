import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useEmiStore } from '../stores/emiStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { useToast } from '../components/Toast';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import type { LoanType } from '../db';

interface Props { open: boolean; onClose: () => void; }

export function AddLoanModal({ open, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { generateSchedule } = useEmiStore();
  const { loans } = useLoanStore();
  const toast = useToast();
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
  // Phase 2B: detect if the current form state will branch into a linked
  // request. Used purely to swap the CTA label and show an inline hint.
  const personInStore = contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const wouldBranchToLinked = !!(
    personInStore?.linkedProfileId &&
    selectedAccount &&
    selectedAccount.currency
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    const trimmedName = contact.name.trim();
    if (!amt || !trimmedName || !accountId) { setError(t('fill_all')); return; }
    setSaving(true);
    try {
      const person = contact.id
        ? await ensureResolvedPerson(trimmedName, contact.id)
        : await usePersonStore.getState().findOrCreateByName(trimmedName);

      const selectedAccount = accounts.find((a) => a.id === accountId);
      const txType = loanType === 'given' ? 'loan_given' : 'loan_taken';
      const branch = decideLinkedBranch({
        type: txType,
        person,
        requestCurrency: selectedAccount?.currency,
      });

      if (branch.branch === true) {
        await useLinkedRequestStore.getState().createRequest({
          toUserId: branch.toUserId,
          personId: branch.personId,
          kind: branch.kind,
          amount: amt,
          currency: branch.currency,
          note: notes,
        });
        toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
        setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
        setHasEmi(false); setInstallments(''); setStartDate('');
        onClose();
        return;
      }

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
    } catch (err) { setError(err instanceof Error ? err.message : t('ltr_create_error')); }
    finally { setSaving(false); }
  };

  // Fetch the full Person row (needed for linkedProfileId when the contact
  // was picked from the ContactPicker dropdown rather than typed fresh).
  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  return (
    <Modal open={open} onClose={onClose} title={t('loan_new')}
      footer={
        <button type="submit" form="loan-form" disabled={saving}
          className="cta-primary"
        >{saving ? t('loan_creating') : wouldBranchToLinked ? t('ltr_branch_cta') : t('loan_create')}</button>
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
          <label className="form-label">{t('loan_to_whom')}</label>
          <ContactPicker value={contact} onChange={setContact} placeholder="Naam likho..." required className="input-field" />
          {wouldBranchToLinked ? (
            <p className="text-[11px] text-indigo-600 mt-1.5">{t('ltr_branch_helper')}</p>
          ) : (
            <p className="text-[11px] text-slate-400 mt-1.5">{t('ltr_linked_only_helper')}</p>
          )}
        </div>

        <div>
          <label className="form-label">Amount</label>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" required />
        </div>

        <div>
          <label className="form-label">{loanType === 'given' ? t('loan_paid_from') : t('loan_received_into')}</label>
          <div className="space-y-2">
            {accounts.map(a => {
              const meta = currencyMeta[a.currency];
              return (
                <button key={a.id} type="button" onClick={() => setAccountId(a.id)}
                  className={accountId === a.id ? 'selector-base selector-selected' : 'selector-base'}
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
            <label className="form-label">Cash Advance Source</label>
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
          <label className="form-label">{t('quick_note')}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Koi detail..." className="input-field" />
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-slate-50/80 border border-slate-100/60">
          <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-indigo-600 accent-indigo-600" />
          <span className="text-[13px] text-slate-600 font-medium">{t('loan_set_emi')}</span>
        </label>

        {hasEmi && (
          <div className="grid grid-cols-2 gap-3 animate-fade-in">
            <div>
              <label className="form-label">{t('loan_installments')}</label>
              <input type="number" value={installments} onChange={e => setInstallments(e.target.value)} placeholder="12" className="input-field" required />
            </div>
            <div>
              <label className="form-label">Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-field" required />
            </div>
          </div>
        )}

        {error && <p className="text-[12px] text-red-500 font-semibold bg-red-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
  );
}
