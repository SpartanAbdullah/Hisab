import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Landmark, Check,
} from 'lucide-react';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { format } from 'date-fns';
import type { Transaction } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { parseInternalNote } from '../lib/internalNotes';
import { resolvePersonName } from '../lib/resolvePersonName';

const iconMap: Record<string, React.ElementType> = {
  income: ArrowDownLeft,
  expense: ArrowUpRight,
  transfer: ArrowLeftRight,
  loan_given: HandCoins,
  loan_taken: Handshake,
  repayment: RotateCcw,
  goal_contribution: Target,
  opening_balance: Landmark,
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
  const [savingReconciliation, setSavingReconciliation] = useState(false);
  const accounts = useAccountStore((state) => state.accounts);
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

  const typeLabels: Record<string, string> = {
    income: t('tx_income'),
    expense: t('tx_expense'),
    transfer: t('tx_transfer'),
    loan_given: t('tx_loan_given'),
    loan_taken: t('tx_loan_taken'),
    repayment: t('tx_repayment'),
    goal_contribution: t('tx_goal_contribution'),
    opening_balance: t('tx_opening_balance'),
  };

  const contextIsDestination = Boolean(accountContextId && transaction.destinationAccountId === accountContextId);
  const contextIsSource = Boolean(accountContextId && transaction.sourceAccountId === accountContextId);
  const isDebit = accountContextId
    ? contextIsSource && !contextIsDestination
    : transaction.type === 'opening_balance'
      ? false
      : transaction.type === 'repayment'
        ? !!transaction.sourceAccountId
        : ['expense', 'loan_given', 'transfer', 'goal_contribution'].includes(transaction.type);

  const displayMoney = (() => {
    if (!accountContextId) return { amount: transaction.amount, currency: transaction.currency };
    if (contextIsDestination && destinationAccount) {
      const amount = transaction.conversionRate && destinationAccount.currency !== transaction.currency
        ? Math.round(transaction.amount * transaction.conversionRate * 100) / 100
        : transaction.amount;
      return { amount, currency: destinationAccount.currency };
    }
    if (contextIsSource && sourceAccount) {
      const usesLoanOrGoalCurrency = ['repayment', 'goal_contribution'].includes(transaction.type);
      const amount = transaction.conversionRate && usesLoanOrGoalCurrency && sourceAccount.currency !== transaction.currency
        ? Math.round((transaction.amount / transaction.conversionRate) * 100) / 100
        : transaction.amount;
      return { amount, currency: sourceAccount.currency };
    }
    return { amount: transaction.amount, currency: transaction.currency };
  })();

  const title = meta.groupExpenseId
    ? meta.expenseDescription || transaction.category || typeLabels[transaction.type] || transaction.type.replace(/_/g, ' ')
    : transaction.category || typeLabels[transaction.type] || transaction.type.replace(/_/g, ' ');

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
        aria-label={isReconciled ? 'Mark transaction unreconciled' : 'Mark transaction reconciled'}
        title={isReconciled ? 'Reconciled' : 'Mark reconciled'}
        className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 transition-all active:scale-95 disabled:opacity-60 ${
          isReconciled
            ? 'bg-receive-600 border-receive-600 text-white'
            : 'bg-white border-cream-border text-transparent hover:border-receive-600'
        }`}
      >
        <Check size={12} strokeWidth={3} />
      </button>
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${style.bg} ${style.text}`}>
        <Icon size={15} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">
          {title}
          {(() => {
            const name = resolvePersonName({ personId: transaction.personId, fallback: transaction.relatedPerson });
            return name ? ` · ${name}` : '';
          })()}
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
