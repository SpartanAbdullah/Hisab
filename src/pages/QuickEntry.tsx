import { useState, useRef, useEffect } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Delete,
} from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore, type TransactionInput } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { Modal } from '../components/Modal';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { SpendingWarningModal } from '../components/SpendingWarningModal';
import { useToast } from '../components/Toast';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import type { TransactionType } from '../db';
import { AddAccountStepper } from './AddAccountStepper';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickEntry({ open, onClose }: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { loans } = useLoanStore();
  const { goals } = useGoalStore();
  const { expenses: upcomingExpenses } = useUpcomingExpenseStore();
  const toast = useToast();
  const t = useT();

  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TransactionType>('expense');
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [personName, setPersonName] = useState('');
  const [loanId, setLoanId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmData, setConfirmData] = useState<{ title: string; description: string; changes: Array<{ accountName: string; currency: string; before: number; after: number }> }>({ title: '', description: '', changes: [] });
  const [showInlineAccount, setShowInlineAccount] = useState(false);
  const [showSpendingWarning, setShowSpendingWarning] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && step === 0) setTimeout(() => amountRef.current?.focus(), 300);
  }, [open, step]);

  // FIX 4: Rename Transfer to Move
  const TX_TYPES = [
    { value: 'expense' as TransactionType, label: t('tx_expense'), sub: t('tx_expense_sub'), icon: ArrowUpRight, gradient: 'from-red-500 to-rose-500', soft: 'bg-red-50 text-red-500 border-red-100' },
    { value: 'income' as TransactionType, label: t('tx_income'), sub: t('tx_income_sub'), icon: ArrowDownLeft, gradient: 'from-emerald-500 to-teal-500', soft: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    { value: 'transfer' as TransactionType, label: t('tx_transfer'), sub: t('tx_transfer_sub'), icon: ArrowLeftRight, gradient: 'from-blue-500 to-cyan-500', soft: 'bg-blue-50 text-blue-600 border-blue-100' },
    { value: 'loan_given' as TransactionType, label: t('tx_loan_given'), sub: t('tx_loan_given_sub'), icon: HandCoins, gradient: 'from-blue-500 to-indigo-500', soft: 'bg-blue-50 text-blue-600 border-blue-100' },
    { value: 'loan_taken' as TransactionType, label: t('tx_loan_taken'), sub: t('tx_loan_taken_sub'), icon: Handshake, gradient: 'from-amber-500 to-orange-500', soft: 'bg-amber-50 text-amber-600 border-amber-100' },
    { value: 'repayment' as TransactionType, label: t('tx_repayment'), sub: t('tx_repayment_sub'), icon: RotateCcw, gradient: 'from-teal-500 to-emerald-500', soft: 'bg-teal-50 text-teal-600 border-teal-100' },
    { value: 'goal_contribution' as TransactionType, label: t('tx_goal_contribution'), sub: t('tx_goal_contribution_sub'), icon: Target, gradient: 'from-purple-500 to-violet-500', soft: 'bg-purple-50 text-purple-600 border-purple-100' },
  ];

  const reset = () => {
    setStep(0); setAmount(''); setType('expense');
    setSourceId(''); setDestId(''); setCategory('');
    setNotes(''); setPersonName(''); setLoanId('');
    setGoalId(''); setConversionRate('');
  };
  const handleClose = () => { reset(); onClose(); };

  const numpadPress = (key: string) => {
    if (key === 'del') { setAmount(a => a.slice(0, -1)); }
    else if (key === '.') { if (!amount.includes('.')) setAmount(a => a + '.'); }
    else { const parts = amount.split('.'); if (parts[1]?.length >= 2) return; setAmount(a => a + key); }
  };

  const needsSource = ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type);
  const needsDest = ['income', 'transfer', 'loan_taken'].includes(type);
  const needsPerson = ['loan_given', 'loan_taken'].includes(type);
  const needsLoan = type === 'repayment';
  const needsGoal = type === 'goal_contribution';
  const showCategory = ['income', 'expense'].includes(type);
  const selectedLoan = loans.find(l => l.id === loanId);
  const hasAccounts = accounts.length > 0;

  // BATCH6: Universal cross-currency detection for ALL transaction types
  const srcAccount = accounts.find(a => a.id === sourceId);
  const dstAccount = accounts.find(a => a.id === destId);
  const selectedGoal = goals.find(g => g.id === goalId);

  // Determine if cross-currency conversion is needed
  const isCrossCurrency = (() => {
    if (type === 'transfer' && srcAccount && dstAccount) return srcAccount.currency !== dstAccount.currency;
    if (type === 'repayment' && selectedLoan) {
      if (selectedLoan.type === 'given' && dstAccount) return dstAccount.currency !== selectedLoan.currency;
      if (selectedLoan.type === 'taken' && srcAccount) return srcAccount.currency !== selectedLoan.currency;
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal) return srcAccount.currency !== selectedGoal.currency;
    return false;
  })();

  // Determine the two currencies for the conversion card
  const crossCurrencyFrom = (() => {
    if (type === 'transfer' && srcAccount) return srcAccount.currency;
    if (type === 'repayment' && selectedLoan) return selectedLoan.currency;
    if (type === 'goal_contribution' && srcAccount) return srcAccount.currency;
    return '';
  })();
  const crossCurrencyTo = (() => {
    if (type === 'transfer' && dstAccount) return dstAccount.currency;
    if (type === 'repayment') {
      if (selectedLoan?.type === 'given' && dstAccount) return dstAccount.currency;
      if (selectedLoan?.type === 'taken' && srcAccount) return srcAccount.currency;
    }
    if (type === 'goal_contribution' && selectedGoal) return selectedGoal.currency;
    return '';
  })();

  const canSubmit = () => {
    const amt = parseFloat(amount);
    if (!amt) return false;
    // BATCH6: Block ALL cross-currency submissions without rate
    if (isCrossCurrency && !parseFloat(conversionRate)) return false;
    switch (type) {
      case 'income': return !!destId;
      case 'expense': return !!sourceId;
      case 'transfer': return !!sourceId && !!destId;
      case 'loan_given': return !!sourceId && !!personName.trim();
      case 'loan_taken': return !!destId && !!personName.trim();
      case 'repayment':
        if (!loanId) return false;
        return selectedLoan?.type === 'given' ? !!destId : !!sourceId;
      case 'goal_contribution': return !!sourceId && !!goalId;
      default: return false;
    }
  };

  // Spending warning: check if source account has an upcoming expense within 30 days
  const upcomingForSource = sourceId
    ? upcomingExpenses.filter(e =>
        e.accountId === sourceId && e.status === 'upcoming' &&
        Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) <= 30
      ).sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
    : [];
  const nearestUpcoming = upcomingForSource[0] ?? null;

  const preSubmit = () => {
    // If deducting from account that has upcoming expense, show warning first
    if (nearestUpcoming && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)) {
      setShowSpendingWarning(true);
      return;
    }
    handleSubmit();
  };

  const handleSubmit = async () => {
    setShowSpendingWarning(false);
    const amt = parseFloat(amount);
    if (!amt) return;
    setSaving(true);
    try {
      let input: TransactionInput;
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];

      switch (type) {
        case 'income': { const d = accounts.find(a => a.id === destId)!; changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt }); input = { type: 'income', amount: amt, destinationAccountId: destId, category, notes }; break; }
        case 'expense': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'expense', amount: amt, sourceAccountId: sourceId, category, notes }; break; }
        case 'transfer': {
          const s = accounts.find(a => a.id === sourceId)!;
          const d = accounts.find(a => a.id === destId)!;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt });
          const rate = parseFloat(conversionRate) || 1;
          const dAmt = s.currency !== d.currency ? Math.round(amt * rate * 100) / 100 : amt;
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + dAmt });
          input = { type: 'transfer', amount: amt, sourceAccountId: sourceId, destinationAccountId: destId, conversionRate: s.currency !== d.currency ? rate : undefined, notes };
          break;
        }
        case 'loan_given': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'loan_given', amount: amt, sourceAccountId: sourceId, personName: personName.trim(), notes }; break; }
        case 'loan_taken': { const d = accounts.find(a => a.id === destId)!; changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt }); input = { type: 'loan_taken', amount: amt, destinationAccountId: destId, personName: personName.trim(), notes }; break; }
        case 'repayment': {
          if (!selectedLoan) throw new Error('Loan not found');
          const rate = parseFloat(conversionRate) || undefined;
          if (selectedLoan.type === 'given' && destId) {
            const d = accounts.find(a => a.id === destId)!;
            const addAmt = isCrossCurrency && rate ? Math.round(amt * rate * 100) / 100 : amt;
            changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + addAmt });
          } else if (selectedLoan.type === 'taken' && sourceId) {
            const s = accounts.find(a => a.id === sourceId)!;
            const deductAmt = isCrossCurrency && rate ? Math.round(amt / rate * 100) / 100 : amt;
            changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          }
          input = { type: 'repayment', amount: amt, loanId, sourceAccountId: selectedLoan.type === 'taken' ? sourceId : undefined, destinationAccountId: selectedLoan.type === 'given' ? destId : undefined, conversionRate: isCrossCurrency ? rate : undefined, notes };
          break;
        }
        case 'goal_contribution': {
          const s = accounts.find(a => a.id === sourceId)!;
          const gcRate = parseFloat(conversionRate) || undefined;
          const deductAmt = isCrossCurrency && gcRate ? Math.round(amt / gcRate * 100) / 100 : amt;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          input = { type: 'goal_contribution', amount: amt, sourceAccountId: sourceId, goalId, conversionRate: isCrossCurrency ? gcRate : undefined, notes };
          break;
        }
        default: throw new Error('Unknown type');
      }

      await processTransaction(input);
      const typeLabel = TX_TYPES.find(tx => tx.value === type)?.label ?? type;
      setConfirmData({ title: `${typeLabel} — Done!`, description: `${formatMoney(amt, changes[0]?.currency ?? 'AED')} processed`, changes });
      setShowConfirmation(true);
      reset();
    } catch (err) {
      toast.show({ type: 'error', title: 'Transaction Failed', subtitle: err instanceof Error ? err.message : 'Kuch galat ho gaya' });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <>
      <Modal open={open && !showInlineAccount} onClose={handleClose}
        title={step === 0 ? t('quick_how_much') : step === 1 ? t('quick_what_type') : t('quick_details')}
        footer={step === 0 ? (
          <button
            onClick={() => { if (!hasAccounts) setShowInlineAccount(true); else if (parseFloat(amount) > 0) setStep(1); }}
            disabled={!parseFloat(amount)}
            className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 transition-all"
          >{!hasAccounts ? `${t('quick_create_first')} \u2192` : `${t('quick_next')} \u2192`}</button>
        ) : step === 1 ? (
          <button onClick={() => setStep(0)} className="w-full text-center text-[12px] text-slate-400 py-2 font-medium">
            &#x2190; {t('quick_change_amount')}
          </button>
        ) : step === 2 ? (
          <div className="flex gap-2.5">
            <button onClick={() => setStep(1)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-slate-200/60 text-slate-500 active:bg-slate-50 transition-all">
              &#x2190;
            </button>
            <button onClick={preSubmit} disabled={saving || !canSubmit()}
              className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 transition-all"
            >{saving ? t('quick_processing') : `${t('quick_save')} \u2713`}</button>
          </div>
        ) : undefined}
      >

        {/* Step 0: Amount */}
        {step === 0 && (
          <div className="space-y-5">
            <div className="text-center py-4">
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); if ((v.match(/\./g) ?? []).length <= 1) setAmount(v); }}
                placeholder="0"
                className="text-5xl font-bold text-center w-full border-none outline-none bg-transparent tabular-nums tracking-tighter text-slate-800"
              />
              <p className="text-[12px] text-slate-400 mt-2">{t('quick_enter_amount')}</p>
            </div>

            {/* Quick amounts */}
            <div className="flex gap-2 justify-center flex-wrap">
              {[50, 100, 500, 1000, 5000].map(v => (
                <button key={v} onClick={() => setAmount(String(v))}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-50 text-slate-600 border border-slate-100/60 active:bg-slate-100 active:scale-95 transition-all tabular-nums"
                >{v.toLocaleString()}</button>
              ))}
            </div>

            {/* Numpad */}
            <div className="grid grid-cols-3 gap-2">
              {['1','2','3','4','5','6','7','8','9','.','0','del'].map(key => (
                <button key={key} onClick={() => numpadPress(key)}
                  className={`h-13 rounded-2xl text-lg font-semibold transition-all active:scale-95 flex items-center justify-center ${
                    key === 'del' ? 'bg-red-50 text-red-500 active:bg-red-100 border border-red-100/60' : 'bg-slate-50 text-slate-700 active:bg-slate-100 border border-slate-100/60'
                  }`}
                >{key === 'del' ? <Delete size={18} /> : key}</button>
              ))}
            </div>

          </div>
        )}

        {/* Step 1: Type */}
        {step === 1 && (
          <div className="space-y-5 animate-fade-in">
            <div className="text-center py-2">
              <p className="text-4xl font-bold tabular-nums tracking-tighter text-slate-800">{parseFloat(amount).toLocaleString()}</p>
              <p className="text-[12px] text-slate-400 mt-1">{t('quick_where_money')}</p>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {TX_TYPES.map(tx => {
                const Icon = tx.icon;
                const isActive = type === tx.value;
                return (
                  <button key={tx.value} onClick={() => { setType(tx.value); setStep(2); }}
                    className={`p-3.5 rounded-2xl border-2 flex items-center gap-3 text-left transition-all duration-200 active:scale-[0.96] ${
                      isActive ? `bg-gradient-to-br ${tx.gradient} text-white border-transparent shadow-md` : `bg-white ${tx.soft}`
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isActive ? 'bg-white/20' : ''}`}>
                      <Icon size={16} strokeWidth={isActive ? 2.5 : 1.8} />
                    </div>
                    <div>
                      <p className="text-[13px] font-bold tracking-tight">{tx.label}</p>
                      <p className={`text-[10px] ${isActive ? 'opacity-70' : 'text-slate-400'}`}>{tx.sub}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Details */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in">
            {/* Summary */}
            <div className="bg-slate-50/80 rounded-2xl p-3.5 flex items-center justify-between border border-slate-100/60">
              <div className="flex items-center gap-2.5">
                {(() => { const T = TX_TYPES.find(tx => tx.value === type); return T ? <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${T.soft}`}><T.icon size={14} /></div> : null; })()}
                <span className="text-[13px] font-semibold text-slate-700 tracking-tight">{TX_TYPES.find(tx => tx.value === type)?.label}</span>
              </div>
              <span className="font-bold text-[15px] tabular-nums text-slate-800">{parseFloat(amount).toLocaleString()}</span>
            </div>

            {/* Account selectors */}
            {needsSource && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_from')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        sourceId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
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
                  );})}
                </div>
              </div>
            )}

            {needsDest && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_to')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setDestId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        destId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
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
                  );})}
                </div>
              </div>
            )}

            {/* BATCH6: Universal cross-currency conversion screen */}
            {isCrossCurrency && crossCurrencyFrom && crossCurrencyTo && (
              <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border border-blue-100/60 space-y-3 animate-fade-in">
                <p className="text-[11px] font-bold text-blue-600 uppercase tracking-widest">{t('conv_title')}</p>
                <p className="text-[12px] text-slate-600">
                  {t('conv_moving')} <span className="font-bold">{formatMoney(parseFloat(amount), crossCurrencyFrom)}</span>
                </p>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 mb-1.5">
                    {t('conv_rate')} 1 {crossCurrencyFrom} = ___ {crossCurrencyTo}
                  </label>
                  <input type="number" step="0.0001" value={conversionRate} onChange={e => setConversionRate(e.target.value)}
                    placeholder="e.g. 78.50" className={inputClass} autoFocus />
                </div>
                {conversionRate && parseFloat(conversionRate) > 0 && (
                  <div className="bg-white rounded-xl p-3 text-center border border-blue-100/60 animate-fade-in">
                    <p className="text-[10px] text-slate-400">{t('conv_will_get')}</p>
                    <p className="text-lg font-bold text-emerald-600 tabular-nums">
                      {formatMoney(Math.round(parseFloat(amount) * parseFloat(conversionRate) * 100) / 100, crossCurrencyTo)}
                    </p>
                  </div>
                )}
              </div>
            )}

            {needsPerson && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_who')}</label>
                <input value={personName} onChange={e => setPersonName(e.target.value)} placeholder={t('quick_who_placeholder')} className={inputClass} />
              </div>
            )}

            {needsLoan && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_which_loan')}</label>
                <select value={loanId} onChange={e => setLoanId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select loan...</option>
                  {loans.filter(l => l.status === 'active').map(l => (
                    <option key={l.id} value={l.id}>{l.personName} — {l.type === 'given' ? 'Wapsi Aani Hai' : 'Dena Hai'} ({formatMoney(l.remainingAmount, l.currency)})</option>
                  ))}
                </select>
              </div>
            )}
            {needsLoan && selectedLoan?.type === 'given' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_money_where')}</label>
                <select value={destId} onChange={e => setDestId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select account...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </select>
              </div>
            )}
            {needsLoan && selectedLoan?.type === 'taken' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_pay_from')}</label>
                <select value={sourceId} onChange={e => setSourceId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select account...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </select>
              </div>
            )}

            {needsGoal && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_which_goal')}</label>
                <select value={goalId} onChange={e => setGoalId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select goal...</option>
                  {goals.map(g => <option key={g.id} value={g.id}>{g.title} ({formatMoney(g.savedAmount, g.currency)}/{formatMoney(g.targetAmount, g.currency)})</option>)}
                </select>
              </div>
            )}

            {showCategory && (
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('category')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {(type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => (
                    <button key={c} type="button" onClick={() => setCategory(c)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all active:scale-95 ${
                        category === c ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/20' : 'bg-white text-slate-500 border-slate-200/60'
                      }`}
                    >{c}</button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_note')}</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Koi detail likho..." className={inputClass} />
            </div>

          </div>
        )}
      </Modal>

      <AddAccountStepper open={showInlineAccount} onClose={() => setShowInlineAccount(false)} onComplete={() => setShowInlineAccount(false)} inline />
      <ConfirmationSheet open={showConfirmation} onClose={() => { setShowConfirmation(false); onClose(); }} title={confirmData.title} description={confirmData.description} balanceChanges={confirmData.changes} />
      <SpendingWarningModal
        open={showSpendingWarning}
        expense={nearestUpcoming}
        onContinue={() => handleSubmit()}
        onCancel={() => setShowSpendingWarning(false)}
      />
    </>
  );
}
