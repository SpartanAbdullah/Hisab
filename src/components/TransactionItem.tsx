import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Landmark, Check, Paperclip, TrendingUp,
} from 'lucide-react';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { format } from 'date-fns';
import type { Transaction } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useToast } from './Toast';
import { useLoanStore } from '../stores/loanStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { parseInternalNote } from '../lib/internalNotes';
import { resolvePersonName } from '../lib/resolvePersonName';
import { getActionLabel } from '../lib/transactionLabel';

const iconMap: Record<string, React.ElementType> = {
  income: ArrowDownLeft,
  expense: ArrowUpRight,
  transfer: ArrowLeftRight,
  loan_given: HandCoins,
  loan_taken: Handshake,
  repayment: RotateCcw,
  goal_contribution: Target,
  opening_balance: Landmark,
  investment_buy: TrendingUp,
  investment_sell: TrendingUp,
  investment_dividend: TrendingUp,
};

// Type-mapped icon chrome. Sukoon collapses the old per-type rainbow into
// the four semantic buckets that actually carry meaning: money-in (receive
// green), money-out (pay coral), neutral movement (cream/ink), and "watch"
// (loan_taken / opening_balance use accent + warn).
const defaultStyleMap: Record<string, { text: string; bg: string }> = {
  income:            { text: 'text-receive-text', bg: 'bg-receive-50' },
  repayment:         { text: 'text-receive-text', bg: 'bg-receive-50' },
  expense:           { text: 'text-pay-text', bg: 'bg-pay-50' },
  loan_given:        { text: 'text-pay-text', bg: 'bg-pay-50' },
  goal_contribution: { text: 'text-accent-600', bg: 'bg-accent-100' },
  transfer:          { text: 'text-ink-600', bg: 'bg-cream-soft' },
  loan_taken:        { text: 'text-warn-600', bg: 'bg-warn-50' },
  opening_balance:   { text: 'text-info-600', bg: 'bg-info-50' },
  // Investments: buy = money leaving (pay), sell/dividend = money arriving.
  investment_buy:      { text: 'text-pay-text', bg: 'bg-pay-50' },
  investment_sell:     { text: 'text-receive-text', bg: 'bg-receive-50' },
  investment_dividend: { text: 'text-receive-text', bg: 'bg-receive-50' },
};

// When viewing an account-scoped list (AccountDetailPage), colour the row
// by where the money actually went rather than its abstract type. Cream/ink
// neutral tones — the account-page hero already conveys identity in colour.
const accountTypeStyleMap: Record<string, { text: string; bg: string }> = {
  cash:           { text: 'text-ink-600', bg: 'bg-cream-soft' },
  bank:           { text: 'text-ink-600', bg: 'bg-cream-soft' },
  digital_wallet: { text: 'text-accent-600', bg: 'bg-accent-100' },
  savings:        { text: 'text-warn-600', bg: 'bg-warn-50' },
  credit_card:    { text: 'text-pay-text', bg: 'bg-pay-50' },
};

interface Props {
  transaction: Transaction;
  accountContextId?: string;
  onClick?: () => void;
}

export function TransactionItem({ transaction, accountContextId, onClick }: Props) {
  const t = useT();
  const toast = useToast();
  const [savingReconciliation, setSavingReconciliation] = useState(false);
  const accounts = useAccountStore((state) => state.accounts);
  const loans = useLoanStore((state) => state.loans);
  const setReconciled = useTransactionStore((state) => state.setReconciled);
  const Icon = iconMap[transaction.type] ?? ArrowLeftRight;
  const { visibleNote, meta } = parseInternalNote(transaction.notes);
  const isReconciled = transaction.isReconciled ?? false;

  const primaryAccountId = accountContextId || transaction.sourceAccountId || transaction.destinationAccountId;
  const primaryAccount = primaryAccountId ? accounts.find((account) => account.id === primaryAccountId) : null;
  const sourceAccount = transaction.sourceAccountId ? accounts.find((account) => account.id === transaction.sourceAccountId) : null;
  const destinationAccount = transaction.destinationAccountId ? accounts.find((account) => account.id === transaction.destinationAccountId) : null;

  const style = primaryAccount && accountTypeStyleMap[primaryAccount.type]
    ? accountTypeStyleMap[primaryAccount.type]
    : defaultStyleMap[transaction.type] ?? { text: 'text-ink-500', bg: 'bg-cream-soft' };

  const personName = resolvePersonName({ personId: transaction.personId, fallback: transaction.relatedPerson });
  const linkedLoan = transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null;
  const actionLabel = getActionLabel(transaction, t, { personName, loan: linkedLoan });
  // Whether the friendly label already names the person — if so, drop the
  // " · {name}" suffix below to avoid "You gave to Ali · Ali".
  const labelHasPerson = ['loan_given', 'loan_taken', 'repayment'].includes(transaction.type) && !!personName;

  const contextIsDestination = Boolean(accountContextId && transaction.destinationAccountId === accountContextId);
  const contextIsSource = Boolean(accountContextId && transaction.sourceAccountId === accountContextId);
  const isDebit = accountContextId
    ? contextIsSource && !contextIsDestination
    : transaction.type === 'opening_balance'
      ? false
      : transaction.type === 'repayment'
        ? !!transaction.sourceAccountId
        : ['expense', 'loan_given', 'transfer', 'goal_contribution', 'investment_buy'].includes(transaction.type);

  const displayMoney = (() => {
    if (!accountContextId) return { amount: transaction.amount, currency: transaction.currency };
    if (contextIsDestination && destinationAccount) {
      const amount = transaction.conversionRate && destinationAccount.currency !== transaction.currency
        ? Math.round(transaction.amount * transaction.conversionRate * 100) / 100
        : transaction.amount;
      return { amount, currency: destinationAccount.currency };
    }
    if (contextIsSource && sourceAccount) {
      // Types whose stored amount is in a FOREIGN currency (loan/goal/market)
      // while the source account was debited amount ÷ rate.
      const usesLoanOrGoalCurrency = ['repayment', 'goal_contribution', 'investment_buy'].includes(transaction.type);
      const amount = transaction.conversionRate && usesLoanOrGoalCurrency && sourceAccount.currency !== transaction.currency
        ? Math.round((transaction.amount / transaction.conversionRate) * 100) / 100
        : transaction.amount;
      return { amount, currency: sourceAccount.currency };
    }
    return { amount: transaction.amount, currency: transaction.currency };
  })();

  // User-set category wins for expense/income (deliberate metadata).
  // Otherwise fall back to the direction-aware action label.
  const categoryWins = ['expense', 'income'].includes(transaction.type) && !!transaction.category;
  const title = meta.groupExpenseId
    ? meta.expenseDescription || (categoryWins ? transaction.category : actionLabel)
    : (categoryWins ? transaction.category : actionLabel);

  const detailParts = [format(new Date(transaction.createdAt), 'MMM d, h:mm a')];
  if (meta.groupName) detailParts.push(meta.groupName);
  if (visibleNote) detailParts.push(visibleNote);

  const handleReconcileClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (savingReconciliation) return;
    setSavingReconciliation(true);
    try {
      await setReconciled(transaction.id, !isReconciled);
    } catch (err) {
      console.error('Failed to update reconciliation', err);
      // The checkmark optimistically flips back; tell the user it didn't stick
      // instead of silently desyncing.
      toast.show({ type: 'error', title: t('reconcile_failed') });
    } finally {
      setSavingReconciliation(false);
    }
  };

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      className={`flex items-center gap-2.5 py-2.5 ${onClick ? 'cursor-pointer active:opacity-80 transition-opacity' : ''}`}
    >
      <button
        type="button"
        onClick={handleReconcileClick}
        disabled={savingReconciliation}
        aria-pressed={isReconciled}
        aria-label={isReconciled ? t('reconcile_tip_done') : t('reconcile_tip_todo')}
        title={isReconciled ? t('reconcile_tip_done') : t('reconcile_tip_todo')}
        className={`relative w-6 h-6 rounded-full border flex items-center justify-center shrink-0 transition-all active:scale-95 disabled:opacity-60 before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 ${
          isReconciled
            ? 'bg-receive-600 border-receive-600 text-white'
            : 'bg-cream-card border-cream-border text-transparent hover:border-receive-600'
        }`}
      >
        <Check size={12} strokeWidth={3} />
      </button>
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${style.bg} ${style.text}`}>
        <Icon size={15} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ink-900 tracking-tight flex items-center gap-1">
          <span className="truncate">
            {title}
            {!labelHasPerson && personName ? ` · ${personName}` : ''}
          </span>
          {transaction.receiptPath ? (
            <Paperclip size={11} className="text-ink-400 shrink-0" aria-label={t('receipt_attached')} />
          ) : null}
        </p>
        <p className="text-[10.5px] text-ink-500 mt-0.5 truncate">
          {detailParts.join(' · ')}
        </p>
      </div>
      <p className={`text-[14px] font-semibold tabular-nums tracking-tight ${isDebit ? 'text-pay-text' : 'text-receive-text'}`}>
        {isDebit ? '−' : '+'}{formatMoney(displayMoney.amount, displayMoney.currency)}
      </p>
    </div>
  );
}
