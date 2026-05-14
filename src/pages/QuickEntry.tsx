import { useState, useRef, useEffect } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Delete,
} from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore, type TransactionInput } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useEmiStore } from '../stores/emiStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { Modal } from '../components/Modal';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { SpendingWarningModal } from '../components/SpendingWarningModal';
import { useToast } from '../components/Toast';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, formatMoney, formatSignedMoney } from '../lib/constants';
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
  const { generateSchedule } = useEmiStore();
  const { expenses: upcomingExpenses } = useUpcomingExpenseStore();
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();

  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TransactionType>('expense');
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [loanId, setLoanId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [hasEmi, setHasEmi] = useState(false);
  const [emiInstallments, setEmiInstallments] = useState('');
  const [emiStartDate, setEmiStartDate] = useState('');
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
    setNotes(''); setContact({ id: null, name: '' }); setLoanId('');
    setGoalId(''); setConversionRate('');
    setHasEmi(false); setEmiInstallments(''); setEmiStartDate('');
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
  const availableCashAdvanceCards = accounts.filter(a =>
    a.type === 'credit_card' &&
    a.id !== destId &&
    (!dstAccount || a.currency === dstAccount.currency)
  );
  const selectedCashAdvanceCard = availableCashAdvanceCards.find(a => a.id === sourceId);

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
      case 'loan_given': return !!sourceId && !!contact.name.trim();
      case 'loan_taken': return !!destId && !!contact.name.trim();
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

  // Phase 2B: whether the current form state will branch into a linked
  // request on submit. Drives the inline helper + CTA label only.
  const contactInStore = needsPerson && contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const branchAccount = type === 'loan_given' ? srcAccount : type === 'loan_taken' ? dstAccount : null;
  const wouldBranchToLinked = !!(
    appMode !== 'splits_only' &&
    (type === 'loan_given' || type === 'loan_taken') &&
    contactInStore?.linkedProfileId &&
    branchAccount?.currency
  );

  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  const handleSubmit = async () => {
    setShowSpendingWarning(false);
    const amt = parseFloat(amount);
    if (!amt) return;
    setSaving(true);
    try {
      let input: TransactionInput;
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];

      // Resolve contact once if this entry type needs a person. `needsPerson`
      // is the source of truth for whether a contact row must exist.
      const resolvedPerson = needsPerson
        ? (contact.id
            ? await ensureResolvedPerson(contact.name.trim(), contact.id)
            : await usePersonStore.getState().findOrCreateByName(contact.name.trim()))
        : null;

      // Phase 2B: Full Money Tracker can branch linked-contact loan entries
      // into an approval request. Simple mode must record local wallet effects
      // immediately, so it uses the normal transaction path below.
      if (appMode !== 'splits_only' && (type === 'loan_given' || type === 'loan_taken')) {
        const accountForBranch = type === 'loan_given' ? srcAccount : dstAccount;
        const branch = decideLinkedBranch({
          type,
          person: resolvedPerson,
          requestCurrency: accountForBranch?.currency,
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
          reset();
          onClose();
          return;
        }
      }

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
        case 'loan_given': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'loan_given', amount: amt, sourceAccountId: sourceId, personName: resolvedPerson!.name, personId: resolvedPerson!.id, notes }; break; }
        case 'loan_taken': {
          const d = accounts.find(a => a.id === destId)!;
          if (selectedCashAdvanceCard) {
            changes.push({ accountName: selectedCashAdvanceCard.name, currency: selectedCashAdvanceCard.currency, before: selectedCashAdvanceCard.balance, after: selectedCashAdvanceCard.balance - amt });
          }
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt });
          input = { type: 'loan_taken', amount: amt, destinationAccountId: destId, sourceAccountId: selectedCashAdvanceCard?.id, personName: resolvedPerson!.name, personId: resolvedPerson!.id, notes };
          break;
        }
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

      const resultTx = await processTransaction(input);

      // EMI scheduling is a follow-up write, not part of the transaction
      // itself. If it fails we must NOT show "Transaction Failed" — the money
      // has already moved and a retry would duplicate the transaction. Surface
      // a distinct "partial success" toast instead and still confirm the txn.
      let emiFailed = false;
      if (hasEmi && resultTx.relatedLoanId && emiInstallments && emiStartDate) {
        try {
          await generateSchedule({
            loanId: resultTx.relatedLoanId,
            totalAmount: amt,
            installments: parseInt(emiInstallments),
            startDate: emiStartDate,
          });
        } catch (err) {
          emiFailed = true;
          console.error('generateSchedule failed after successful transaction', err);
          toast.show({
            type: 'error',
            title: 'EMI schedule not created',
            subtitle: 'Your transaction was saved, but setting up the installment plan failed. Open the loan to retry.',
            duration: 6000,
          });
        }
      }

      const typeLabel = TX_TYPES.find(tx => tx.value === type)?.label ?? type;
      const confirmationCurrency = changes[0]?.currency ?? localStorage.getItem('hisaab_primary_currency') ?? 'PKR';
      setConfirmData({
        title: emiFailed ? `${typeLabel} — Saved (EMI pending)` : `${typeLabel} — Done!`,
        description: `${formatMoney(amt, confirmationCurrency)} processed`,
        changes,
      });
      setShowConfirmation(true);
      reset();
    } catch (err) {
      toast.show({ type: 'error', title: 'Transaction Failed', subtitle: err instanceof Error ? err.message : 'Kuch galat ho gaya' });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all";

  return (
    <>
      <Modal open={open && !showInlineAccount} onClose={handleClose}
        title={step === 0 ? t('quick_how_much') : step === 1 ? t('quick_what_type') : t('quick_details')}
        footer={step === 0 ? (
          <button
            onClick={() => { if (!hasAccounts) setShowInlineAccount(true); else if (parseFloat(amount) > 0) setStep(1); }}
            disabled={!parseFloat(amount)}
            className="w-full bg-ink-900 text-white rounded-2xl py-4 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
          >{!hasAccounts ? `${t('quick_create_first')} \u2192` : `${t('quick_next')} \u2192`}</button>
        ) : step === 1 ? (
          <button onClick={() => setStep(0)} className="w-full text-center text-[12px] text-ink-500 py-2 font-medium">
            &#x2190; {t('quick_change_amount')}
          </button>
        ) : step === 2 ? (
          <div className="flex gap-2.5">
            <button onClick={() => setStep(1)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-cream-border text-ink-500 active:bg-cream-soft transition-colors bg-cream-card">
              &#x2190;
            </button>
            <button onClick={preSubmit} disabled={saving || !canSubmit()}
              className="flex-1 bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
            >{saving ? t('quick_processing') : wouldBranchToLinked ? t('ltr_branch_cta') : `${t('quick_save')} \u2713`}</button>
          </div>
        ) : undefined}
      >

        {/* Step 0: Amount — Sukoon's centred big number + white keypad */}
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
                className="text-[54px] font-semibold text-center w-full border-none outline-none bg-transparent tabular-nums text-ink-900"
                style={{ letterSpacing: '-0.025em' }}
              />
              <p className="text-[12px] text-ink-500 mt-2">{t('quick_enter_amount')}</p>
            </div>

            {/* Quick amounts */}
            <div className="flex gap-2 justify-center flex-wrap">
              {[50, 100, 500, 1000, 5000].map(v => (
                <button key={v} onClick={() => setAmount(String(v))}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-cream-card text-ink-600 border border-cream-border active:bg-cream-soft active:scale-95 transition-all tabular-nums"
                >{v.toLocaleString()}</button>
              ))}
            </div>

            {/* Numpad — Sukoon: white cells, 1px cream-border, radius 14 */}
            <div className="grid grid-cols-3 gap-2">
              {['1','2','3','4','5','6','7','8','9','.','0','del'].map(key => (
                <button key={key} onClick={() => numpadPress(key)}
                  className={`h-13 rounded-[14px] text-[19px] font-medium transition-all active:scale-95 flex items-center justify-center border ${
                    key === 'del' ? 'bg-pay-50 text-pay-text border-pay-100 active:bg-pay-100' : 'bg-cream-card text-ink-900 border-cream-border active:bg-cream-soft'
                  }`}
                >{key === 'del' ? <Delete size={18} /> : key}</button>
              ))}
            </div>

          </div>
        )}

        {/* Step 1: Type — Sukoon card rows on cream */}
        {step === 1 && (
          <div className="space-y-5 animate-fade-in">
            <div className="text-center py-2">
              <p className="text-4xl font-semibold tabular-nums text-ink-900" style={{ letterSpacing: '-0.025em' }}>
                {parseFloat(amount).toLocaleString()}
              </p>
              <p className="text-[12px] text-ink-500 mt-1">{t('quick_where_money')}</p>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {TX_TYPES.map(tx => {
                const Icon = tx.icon;
                const isActive = type === tx.value;
                // Tone-map by transaction semantics: receive (green) for inflows,
                // pay (coral) for outflows, accent (violet) for goals, neutral
                // (ink/cream) for transfer, warn for loan_taken.
                const tone =
                  tx.value === 'income' || tx.value === 'repayment'
                    ? 'receive'
                    : tx.value === 'expense' || tx.value === 'loan_given'
                    ? 'pay'
                    : tx.value === 'goal_contribution'
                    ? 'accent'
                    : tx.value === 'loan_taken'
                    ? 'warn'
                    : 'neutral';
                const inactiveBg = {
                  receive: 'bg-receive-50',
                  pay: 'bg-pay-50',
                  accent: 'bg-accent-50',
                  warn: 'bg-warn-50',
                  neutral: 'bg-cream-soft',
                }[tone];
                const inactiveText = {
                  receive: 'text-receive-text',
                  pay: 'text-pay-text',
                  accent: 'text-accent-600',
                  warn: 'text-warn-600',
                  neutral: 'text-ink-600',
                }[tone];
                return (
                  <button key={tx.value} onClick={() => { setType(tx.value); setStep(2); }}
                    className={`p-3.5 rounded-2xl border flex items-center gap-3 text-left transition-all duration-200 active:scale-[0.96] ${
                      isActive
                        ? 'bg-ink-900 text-white border-ink-900'
                        : `bg-cream-card border-cream-border`
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isActive ? 'bg-white/15 text-white' : `${inactiveBg} ${inactiveText}`}`}>
                      <Icon size={16} strokeWidth={1.8} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-[13px] font-semibold tracking-tight ${isActive ? 'text-white' : 'text-ink-900'}`}>
                        {tx.label}
                      </p>
                      <p className={`text-[10px] ${isActive ? 'text-white/65' : 'text-ink-500'}`}>{tx.sub}</p>
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
            <div className="bg-cream-card border border-cream-border rounded-2xl p-3.5 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {(() => {
                  const T = TX_TYPES.find(tx => tx.value === type);
                  if (!T) return null;
                  return (
                    <div className="w-8 h-8 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center">
                      <T.icon size={14} className="text-ink-600" />
                    </div>
                  );
                })()}
                <span className="text-[13px] font-semibold text-ink-900 tracking-tight">{TX_TYPES.find(tx => tx.value === type)?.label}</span>
              </div>
              <span className="font-semibold text-[15px] tabular-nums text-ink-900">{parseFloat(amount).toLocaleString()}</span>
            </div>

            {/* Account selectors */}
            {needsSource && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_from')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        sourceId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{meta?.flag}</span>
                        <div>
                          <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                          <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                        </div>
                      </div>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                    </button>
                  );})}
                </div>
              </div>
            )}

            {needsDest && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_to')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setDestId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        destId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{meta?.flag}</span>
                        <div>
                          <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                          <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                        </div>
                      </div>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                    </button>
                  );})}
                </div>
              </div>
            )}

            {/* Universal cross-currency conversion screen */}
            {isCrossCurrency && crossCurrencyFrom && crossCurrencyTo && (
              <div className="bg-info-50 rounded-2xl p-4 border border-cream-border space-y-3 animate-fade-in">
                <p className="text-[10.5px] font-semibold text-info-600 uppercase tracking-[0.12em]">{t('conv_title')}</p>
                <p className="text-[12px] text-ink-600">
                  {t('conv_moving')} <span className="font-semibold text-ink-900">{formatMoney(parseFloat(amount), crossCurrencyFrom)}</span>
                </p>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-500 mb-1.5">
                    {t('conv_rate')} 1 {crossCurrencyFrom} = ___ {crossCurrencyTo}
                  </label>
                  <input type="number" step="0.0001" value={conversionRate} onChange={e => setConversionRate(e.target.value)}
                    placeholder="e.g. 78.50" className={inputClass} autoFocus />
                </div>
                {conversionRate && parseFloat(conversionRate) > 0 && (
                  <div className="bg-cream-card rounded-xl p-3 text-center border border-cream-border animate-fade-in">
                    <p className="text-[10px] text-ink-500">{t('conv_will_get')}</p>
                    <p className="text-lg font-semibold text-receive-text tabular-nums">
                      {formatMoney(Math.round(parseFloat(amount) * parseFloat(conversionRate) * 100) / 100, crossCurrencyTo)}
                    </p>
                  </div>
                )}
              </div>
            )}

            {needsPerson && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_who')}</label>
                <ContactPicker value={contact} onChange={setContact} placeholder={t('quick_who_placeholder')} className={inputClass} />
                {wouldBranchToLinked ? (
                  <p className="text-[11px] text-accent-600 mt-1.5">{t('ltr_branch_helper')}</p>
                ) : (
                  <p className="text-[11px] text-ink-500 mt-1.5">{t('ltr_linked_only_helper')}</p>
                )}
              </div>
            )}

            {type === 'loan_taken' && availableCashAdvanceCards.length > 0 && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">Cash Advance Source</label>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSourceId('')}
                    className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                      !selectedCashAdvanceCard ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-border bg-cream-card text-ink-500'
                    }`}
                  >
                    No credit card
                  </button>
                  {availableCashAdvanceCards.map(a => (
                    <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        selectedCashAdvanceCard?.id === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div>
                        <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                        <p className="text-[10px] text-ink-500">Credit card</p>
                      </div>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* EMI Setup for Loans */}
            {needsPerson && (
              <div className="space-y-3">
                <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-cream-card border border-cream-border">
                  <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-cream-border text-accent-600 accent-accent-600" />
                  <span className="text-[13px] text-ink-800 font-medium">{t('loan_set_emi')}</span>
                </label>
                {hasEmi && (
                  <div className="grid grid-cols-2 gap-3 animate-fade-in">
                    <div>
                      <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('loan_installments')}</label>
                      <input type="number" value={emiInstallments} onChange={e => setEmiInstallments(e.target.value)} placeholder="12" className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">Start Date</label>
                      <input type="date" value={emiStartDate} onChange={e => setEmiStartDate(e.target.value)} className={inputClass} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {needsLoan && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_loan')}</label>
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
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_money_where')}</label>
                <select value={destId} onChange={e => setDestId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select account...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </select>
              </div>
            )}
            {needsLoan && selectedLoan?.type === 'taken' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_pay_from')}</label>
                <select value={sourceId} onChange={e => setSourceId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select account...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </select>
              </div>
            )}

            {needsGoal && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_goal')}</label>
                <select value={goalId} onChange={e => setGoalId(e.target.value)} className={`${inputClass} appearance-none`}>
                  <option value="">Select goal...</option>
                  {goals.map(g => <option key={g.id} value={g.id}>{g.title} ({formatMoney(g.savedAmount, g.currency)}/{formatMoney(g.targetAmount, g.currency)})</option>)}
                </select>
              </div>
            )}

            {showCategory && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('category')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {(type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => (
                    <button key={c} type="button" onClick={() => setCategory(c)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-colors active:scale-95 ${
                        category === c ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-600 border-cream-border'
                      }`}
                    >{c}</button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_note')}</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Koi detail likho..." className={inputClass} />
            </div>

            {(needsPerson || needsLoan) && (
              <p className="text-[12px] text-ink-600 bg-cream-card border border-cream-border rounded-2xl p-3 leading-relaxed">
                {t('money_not_moved_notice')}
              </p>
            )}

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
