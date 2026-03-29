import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Landmark,
} from 'lucide-react';
import { format } from 'date-fns';
import type { Transaction } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { parseInternalNote } from '../lib/internalNotes';

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

const defaultStyleMap: Record<string, { text: string; bg: string }> = {
  income:            { text: 'text-emerald-600', bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/50' },
  expense:           { text: 'text-red-500', bg: 'bg-gradient-to-br from-red-50 to-red-100/50' },
  transfer:          { text: 'text-blue-500', bg: 'bg-gradient-to-br from-blue-50 to-blue-100/50' },
  loan_given:        { text: 'text-blue-600', bg: 'bg-gradient-to-br from-blue-50 to-blue-100/50' },
  loan_taken:        { text: 'text-amber-500', bg: 'bg-gradient-to-br from-amber-50 to-amber-100/50' },
  repayment:         { text: 'text-teal-500', bg: 'bg-gradient-to-br from-teal-50 to-teal-100/50' },
  goal_contribution: { text: 'text-purple-500', bg: 'bg-gradient-to-br from-purple-50 to-purple-100/50' },
  opening_balance:   { text: 'text-indigo-500', bg: 'bg-gradient-to-br from-indigo-50 to-indigo-100/50' },
};

const accountTypeStyleMap: Record<string, { text: string; bg: string }> = {
  cash:           { text: 'text-emerald-700', bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/60' },
  bank:           { text: 'text-blue-700', bg: 'bg-gradient-to-br from-blue-50 to-blue-100/60' },
  digital_wallet: { text: 'text-purple-700', bg: 'bg-gradient-to-br from-purple-50 to-purple-100/60' },
  savings:        { text: 'text-amber-700', bg: 'bg-gradient-to-br from-amber-50 to-amber-100/60' },
  credit_card:    { text: 'text-slate-700', bg: 'bg-gradient-to-br from-slate-100 to-slate-200/60' },
};

interface Props {
  transaction: Transaction;
}

export function TransactionItem({ transaction }: Props) {
  const t = useT();
  const accounts = useAccountStore((state) => state.accounts);
  const Icon = iconMap[transaction.type] ?? ArrowLeftRight;
  const { visibleNote, meta } = parseInternalNote(transaction.notes);

  const primaryAccountId = transaction.sourceAccountId || transaction.destinationAccountId;
  const primaryAccount = primaryAccountId ? accounts.find((account) => account.id === primaryAccountId) : null;

  const style = primaryAccount && accountTypeStyleMap[primaryAccount.type]
    ? accountTypeStyleMap[primaryAccount.type]
    : defaultStyleMap[transaction.type] ?? { text: 'text-slate-500', bg: 'bg-slate-50' };

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

  const isDebit = transaction.type === 'opening_balance'
    ? false
    : transaction.type === 'repayment'
      ? !!transaction.sourceAccountId
      : ['expense', 'loan_given', 'transfer', 'goal_contribution'].includes(transaction.type);

  const title = meta.groupExpenseId
    ? meta.expenseDescription || transaction.category || typeLabels[transaction.type] || transaction.type.replace(/_/g, ' ')
    : transaction.category || typeLabels[transaction.type] || transaction.type.replace(/_/g, ' ');

  const detailParts = [format(new Date(transaction.createdAt), 'MMM d, h:mm a')];
  if (meta.groupName) detailParts.push(meta.groupName);
  if (visibleNote) detailParts.push(visibleNote);

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${style.bg} ${style.text}`}>
        <Icon size={17} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-800 truncate tracking-tight">
          {title}
          {transaction.relatedPerson ? ` - ${transaction.relatedPerson}` : ''}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5 truncate">
          {detailParts.join(' | ')}
        </p>
      </div>
      <p className={`text-[14px] font-bold tabular-nums tracking-tight ${isDebit ? 'text-red-500' : 'text-emerald-600'}`}>
        {isDebit ? '-' : '+'}{formatMoney(transaction.amount, transaction.currency)}
      </p>
    </div>
  );
}
