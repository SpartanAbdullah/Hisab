import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { format, isPast } from 'date-fns';
import { CheckCircle, Clock, AlertCircle, RotateCcw } from 'lucide-react';
import { RepaymentModal } from './RepaymentModal';
import { isGroupLinkedNote } from '../lib/internalNotes';
import type { Transaction } from '../db';

export function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { loans, loadLoans } = useLoanStore();
  const { schedules, loadSchedules } = useEmiStore();
  const { transactions, loadTransactions, getByLoan, processTransaction } = useTransactionStore();
  const { accounts, loadAccounts } = useAccountStore();
  const toast = useToast();
  const t = useT();
  const [showRepayment, setShowRepayment] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => { loadLoans(); loadSchedules(); loadTransactions(); loadAccounts(); }, [loadLoans, loadSchedules, loadTransactions, loadAccounts]);

  const loan = loans.find(l => l.id === id);
  if (!loan) return <div className="p-4 text-center text-slate-400">{t('loan_not_found')}</div>;

  const loanTxns = getByLoan(loan.id);
  const emiItems = schedules.filter(e => e.loanId === loan.id).sort((a, b) => a.installmentNumber - b.installmentNumber);
  const progress = ((loan.totalAmount - loan.remainingAmount) / loan.totalAmount) * 100;
  const isGiven = loan.type === 'given';
  const enrichedEmis = emiItems.map(e => ({ ...e, isOverdue: e.status === 'upcoming' && isPast(new Date(e.dueDate)) }));

  void transactions;

  // FIX 6: EMI "Paid Mark Karo" — also apply repayment to loan progress
  const handleMarkEmiPaid = async (emiId: string, emiAmount: number) => {
    try {
      // If loan type is 'given', we need a dest account (money coming in)
      // If loan type is 'taken', we need a source account (money going out)
      // For simplicity with "Mark as Paid" we process the repayment on the loan
      // and let user know the balance updated
      if (isGiven) {
        // Someone paid us — pick first account for receiving
        const destAccount = accounts[0];
        if (!destAccount) { toast.show({ type: 'error', title: t('error'), subtitle: 'No account found' }); return; }
        await processTransaction({
          type: 'repayment',
          amount: emiAmount,
          loanId: loan.id,
          destinationAccountId: destAccount.id,
          emiId,
          notes: `EMI #${emiItems.find(e => e.id === emiId)?.installmentNumber} paid`,
        });
      } else {
        // We paid someone — pick first account for paying
        const srcAccount = accounts[0];
        if (!srcAccount) { toast.show({ type: 'error', title: t('error'), subtitle: 'No account found' }); return; }
        await processTransaction({
          type: 'repayment',
          amount: emiAmount,
          loanId: loan.id,
          sourceAccountId: srcAccount.id,
          emiId,
          notes: `EMI #${emiItems.find(e => e.id === emiId)?.installmentNumber} paid`,
        });
      }
      // Refresh data
      await loadLoans();
      await loadSchedules();
      await loadTransactions();
      await loadAccounts();
      toast.show({ type: 'success', title: `EMI ${t('loan_mark_paid')}`, subtitle: formatMoney(emiAmount, loan.currency) });
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : 'Failed' });
    }
  };

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader title={loan.personName} back
        action={<div className="flex items-center gap-2"><LanguageToggle />{loan.status === 'active' ? (
          <button onClick={() => setShowRepayment(true)} className="bg-emerald-50 text-emerald-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-emerald-500/5">
            <RotateCcw size={13} strokeWidth={2.5} /> {t('loan_repay')}
          </button>
        ) : null}</div>}
      />

      <div className="px-5 pt-5">
        <div className="relative overflow-hidden rounded-3xl p-6 text-white animate-scale-in">
          <div className={`absolute inset-0 bg-gradient-to-br ${isGiven ? 'from-emerald-500 via-emerald-600 to-teal-600' : 'from-red-500 via-red-600 to-rose-600'}`} />
          <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(circle at 70% 30%, rgba(255,255,255,0.3), transparent 60%)' }} />
          <div className="relative">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center text-xl font-bold backdrop-blur-sm">
                {loan.personName[0].toUpperCase()}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-widest opacity-70">{isGiven ? t('loan_gave') : t('loan_took')}</p>
                <p className="text-2xl font-bold tabular-nums tracking-tighter">{formatMoney(loan.totalAmount, loan.currency)}</p>
              </div>
            </div>
            <div className="bg-white/20 rounded-full h-3 overflow-hidden backdrop-blur-sm">
              <div className="bg-white h-full rounded-full transition-all duration-700" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex justify-between mt-2.5 text-[11px]">
              <span className="opacity-80">{t('loan_returned')}: {formatMoney(loan.totalAmount - loan.remainingAmount, loan.currency)}</span>
              <span className="font-bold">{t('loan_remaining')}: {formatMoney(loan.remainingAmount, loan.currency)}</span>
            </div>
            {loan.status === 'settled' && (
              <div className="mt-3 bg-white/20 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold backdrop-blur-sm">
                <CheckCircle size={12} /> {t('loan_completed')}
              </div>
            )}
            {loan.notes && <p className="mt-3 text-[11px] opacity-60 italic">"{loan.notes}"</p>}
          </div>
        </div>
      </div>

      {/* EMI */}
      {enrichedEmis.length > 0 && (
        <div className="px-5 pt-6">
          <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">EMI Schedule</h2>
          <div className="space-y-2">
            {enrichedEmis.map(e => (
              <div key={e.id}
                className={`card-premium !rounded-2xl p-4 flex items-center gap-3 ${
                  e.status === 'paid' ? '!border-emerald-100/60 !bg-emerald-50/30' :
                  e.isOverdue ? '!border-red-100/60 !bg-red-50/30' : ''
                }`}
              >
                {e.status === 'paid' ? <CheckCircle size={18} className="text-emerald-500 shrink-0" strokeWidth={1.8} />
                  : e.isOverdue ? <AlertCircle size={18} className="text-red-500 shrink-0" strokeWidth={1.8} />
                  : <Clock size={18} className="text-slate-300 shrink-0" strokeWidth={1.8} />}
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-slate-700 tracking-tight">Qist #{e.installmentNumber}</p>
                  <p className="text-[11px] text-slate-400">{format(new Date(e.dueDate), 'dd MMM yyyy')}</p>
                  {e.isOverdue && <p className="text-[10px] text-red-500 font-bold mt-0.5">Overdue!</p>}
                </div>
                <div className="text-right">
                  <p className={`text-[13px] font-bold tabular-nums ${e.status === 'paid' ? 'text-emerald-500' : e.isOverdue ? 'text-red-500' : 'text-slate-700'}`}>
                    {formatMoney(e.amount, loan.currency)}
                  </p>
                  {e.status !== 'paid' && (
                    <button onClick={() => handleMarkEmiPaid(e.id, e.amount)} className="text-[10px] text-indigo-600 font-bold mt-1 active:opacity-70 transition-opacity">
                      {t('loan_mark_paid')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-5 pt-6">
        <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('tx_history')}</h2>
        {loanTxns.length === 0 ? (
          <p className="text-[13px] text-slate-400 text-center py-8">{t('loan_no_tx')}</p>
        ) : (
          <div className="card-premium px-4 divide-y divide-slate-100/60">
            {loanTxns.map(txn => (
              ['expense', 'loan_given', 'loan_taken'].includes(txn.type) && !isGroupLinkedNote(txn.notes)
                ? (
                  <button key={txn.id} type="button" onClick={() => setSelectedTransaction(txn)} className="w-full text-left active:opacity-80 transition-opacity">
                    <TransactionItem transaction={txn} />
                  </button>
                )
                : <TransactionItem key={txn.id} transaction={txn} />
            ))}
          </div>
        )}
      </div>

      {/* FIX 8: Context-aware repayment — uses RepaymentModal instead of generic QuickEntry */}
      {loan.status === 'active' && (
        <RepaymentModal
          open={showRepayment}
          onClose={() => { setShowRepayment(false); loadLoans(); loadTransactions(); loadAccounts(); }}
          loan={loan}
        />
      )}
      <EditTransactionModal open={!!selectedTransaction} transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </div>
  );
}
