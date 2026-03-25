import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import type { Loan } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  loan: Loan;
}

export function RepaymentModal({ open, onClose, loan }: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { getLoan } = useLoanStore();
  const toast = useToast();
  const t = useT();

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmData, setConfirmData] = useState<{
    title: string; description: string;
    changes: Array<{ accountName: string; currency: string; before: number; after: number }>;
  }>({ title: '', description: '', changes: [] });

  const isGiven = loan.type === 'given';
  const selectedAccount = accounts.find(a => a.id === accountId);
  const isCrossCurrency = selectedAccount ? selectedAccount.currency !== loan.currency : false;
  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  const handleClose = () => {
    setAmount(''); setAccountId(''); setConversionRate(''); setNotes('');
    onClose();
  };

  const canSubmit = () => {
    const amt = parseFloat(amount);
    if (!(amt > 0) || !accountId) return false;
    if (isCrossCurrency && !parseFloat(conversionRate)) return false;
    return true;
  };

  const handleSubmit = async () => {
    const amt = parseFloat(amount);
    if (!amt || !accountId) return;
    setSaving(true);
    try {
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];
      const acc = accounts.find(a => a.id === accountId);
      if (!acc) throw new Error('Account not found');

      const rate = parseFloat(conversionRate) || undefined;

      if (isGiven) {
        // Money comes into our account (someone paying us back)
        const addAmt = isCrossCurrency && rate ? Math.round(amt * rate * 100) / 100 : amt;
        changes.push({ accountName: acc.name, currency: acc.currency, before: acc.balance, after: acc.balance + addAmt });
        await processTransaction({
          type: 'repayment',
          amount: amt,
          loanId: loan.id,
          destinationAccountId: accountId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
        });
      } else {
        // Money leaves our account (we're paying back)
        const deductAmt = isCrossCurrency && rate ? Math.round(amt / rate * 100) / 100 : amt;
        changes.push({ accountName: acc.name, currency: acc.currency, before: acc.balance, after: acc.balance - deductAmt });
        await processTransaction({
          type: 'repayment',
          amount: amt,
          loanId: loan.id,
          sourceAccountId: accountId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
        });
      }

      const freshLoan = getLoan(loan.id);
      setConfirmData({
        title: `${t('loan_repay')} — Done!`,
        description: `${formatMoney(amt, loan.currency)} ${isGiven ? 'received from' : 'repaid to'} ${loan.personName}`,
        changes,
      });
      setShowConfirmation(true);
      setAmount(''); setAccountId(''); setConversionRate(''); setNotes('');

      void freshLoan;
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: err instanceof Error ? err.message : 'Failed',
      });
    } finally { setSaving(false); }
  };

  return (
    <>
      <Modal
        open={open && !showConfirmation}
        onClose={handleClose}
        title={`${t('repay_title')} — ${loan.personName}`}
        footer={
          <button
            onClick={handleSubmit}
            disabled={saving || !canSubmit()}
            className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
          >
            {saving ? t('repay_paying') : t('repay_confirm')}
          </button>
        }
      >
        <div className="space-y-4">
          {/* Loan summary */}
          <div className={`rounded-2xl p-4 border ${isGiven ? 'bg-emerald-50/50 border-emerald-100/60' : 'bg-red-50/50 border-red-100/60'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                  {isGiven ? t('loan_receivable') : t('loan_payable')}
                </p>
                <p className="text-lg font-bold tabular-nums tracking-tight mt-1 text-slate-800">
                  {formatMoney(loan.remainingAmount, loan.currency)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-slate-400">Total</p>
                <p className="text-[13px] font-semibold text-slate-500 tabular-nums">
                  {formatMoney(loan.totalAmount, loan.currency)}
                </p>
              </div>
            </div>
          </div>

          {/* Amount */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              {t('repay_amount')} ({loan.currency})
            </label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className={`${inputClass} text-center text-xl font-bold tabular-nums`}
              autoFocus
            />
            {/* Quick fill remaining */}
            <button
              type="button"
              onClick={() => setAmount(String(loan.remainingAmount))}
              className="mt-2 text-[11px] text-indigo-600 font-bold active:opacity-70"
            >
              Full amount: {formatMoney(loan.remainingAmount, loan.currency)}
            </button>
          </div>

          {/* Account selection */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              {isGiven ? t('repay_receive_in') : t('repay_pay_from')}
            </label>
            <div className="space-y-2">
              {accounts.map(a => {
                const meta = currencyMeta[a.currency];
                return (
                  <button key={a.id} type="button" onClick={() => { setAccountId(a.id); setConversionRate(''); }}
                    className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                      accountId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta?.flag}</span>
                      <div>
                        <p className="text-[13px] font-semibold text-slate-700">{a.name}</p>
                        <p className="text-[10px] text-slate-400 capitalize">{a.type.replace('_', ' ')}</p>
                      </div>
                    </div>
                    <p className="text-[13px] font-bold text-slate-700 tabular-nums">{formatMoney(a.balance, a.currency)}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* BATCH6: Cross-currency conversion card */}
          {isCrossCurrency && selectedAccount && (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border border-blue-100/60 space-y-3 animate-fade-in">
              <p className="text-[11px] font-bold text-blue-600 uppercase tracking-widest">{t('conv_title')}</p>
              <p className="text-[12px] text-slate-600">
                Loan: <span className="font-bold">{loan.currency}</span> — Account: <span className="font-bold">{selectedAccount.currency}</span>
              </p>
              <div>
                <label className="block text-[11px] font-bold text-slate-500 mb-1.5">
                  {t('conv_rate')} 1 {loan.currency} = ___ {selectedAccount.currency}
                </label>
                <input type="number" step="0.0001" value={conversionRate} onChange={e => setConversionRate(e.target.value)}
                  placeholder="e.g. 78.50" className={inputClass} />
              </div>
              {conversionRate && parseFloat(conversionRate) > 0 && parseFloat(amount) > 0 && (
                <div className="bg-white rounded-xl p-3 text-center border border-blue-100/60 animate-fade-in">
                  <p className="text-[10px] text-slate-400">{isGiven ? t('conv_will_get') : 'Will deduct'}</p>
                  <p className="text-lg font-bold text-emerald-600 tabular-nums">
                    {isGiven
                      ? formatMoney(Math.round(parseFloat(amount) * parseFloat(conversionRate) * 100) / 100, selectedAccount.currency)
                      : formatMoney(Math.round(parseFloat(amount) / parseFloat(conversionRate) * 100) / 100, selectedAccount.currency)
                    }
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              {t('quick_note')}
            </label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional..."
              className={inputClass}
            />
          </div>
        </div>
      </Modal>

      <ConfirmationSheet
        open={showConfirmation}
        onClose={() => { setShowConfirmation(false); onClose(); }}
        title={confirmData.title}
        description={confirmData.description}
        balanceChanges={confirmData.changes}
      />
    </>
  );
}
