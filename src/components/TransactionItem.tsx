import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Landmark,
} from 'lucide-react';
import type { Transaction } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { formatMoney } from '../lib/constants';
import { format } from 'date-fns';
import { useT } from '../lib/i18n';

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

// Default style by transaction type (fallback)
const defaultStyleMap: Record<string, { text: string; bg: string }> = {
  income:            { text: 'text-emerald-600', bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/50' },
  expense:           { text: 'text-red-500',     bg: 'bg-gradient-to-br from-red-50 to-red-100/50' },
  transfer:          { text: 'text-blue-500',    bg: 'bg-gradient-to-br from-blue-50 to-blue-100/50' },
  loan_given:        { text: 'text-blue-600',    bg: 'bg-gradient-to-br from-blue-50 to-blue-100/50' },
  loan_taken:        { text: 'text-amber-500',   bg: 'bg-gradient-to-br from-amber-50 to-amber-100/50' },
  repayment:         { text: 'text-teal-500',    bg: 'bg-gradient-to-br from-teal-50 to-teal-100/50' },
  goal_contribution: { text: 'text-purple-500',  bg: 'bg-gradient-to-br from-purple-50 to-purple-100/50' },
  opening_balance:   { text: 'text-indigo-500',  bg: 'bg-gradient-to-br from-indigo-50 to-indigo-100/50' },
};

// Account-type-aware icon colors — matches account card gradients
const accountTypeStyleMap: Record<string, { text: string; bg: string }> = {
  cash:           { text: 'text-emerald-700', bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/60' },
  bank:           { text: 'text-blue-700',    bg: 'bg-gradient-to-br from-blue-50 to-blue-100/60' },
  digital_wallet: { text: 'text-purple-700',  bg: 'bg-gradient-to-br from-purple-50 to-purple-100/60' },
  savings:        { text: 'text-amber-700',   bg: 'bg-gradient-to-br from-amber-50 to-amber-100/60' },
  credit_card:    { text: 'text-slate-700',   bg: 'bg-gradient-to-br from-slate-100 to-slate-200/60' },
};

interface Props {
  transaction: Transaction;
}

export function TransactionItem({ transaction: t }: Props) {
  const tr = useT();
  const accounts = useAccountStore(s => s.accounts);
  const Icon = iconMap[t.type] ?? ArrowLeftRight;

  // Determine the primary account for this transaction to get account-type-aware color
  const primaryAccountId = t.sourceAccountId || t.destinationAccountId;
  const primaryAccount = primaryAccountId ? accounts.find(a => a.id === primaryAccountId) : null;

  // Use account type color if we have an account, otherwise fallback to tx type color
  const style = primaryAccount && accountTypeStyleMap[primaryAccount.type]
    ? accountTypeStyleMap[primaryAccount.type]
    : defaultStyleMap[t.type] ?? { text: 'text-slate-500', bg: 'bg-slate-50' };

  const typeLabels: Record<string, string> = {
    income: tr('tx_income'),
    expense: tr('tx_expense'),
    transfer: tr('tx_transfer'),
    loan_given: tr('tx_loan_given'),
    loan_taken: tr('tx_loan_taken'),
    repayment: tr('tx_repayment'),
    goal_contribution: tr('tx_goal_contribution'),
    opening_balance: tr('tx_opening_balance'),
  };

  const isDebit = t.type === 'opening_balance'
    ? false
    : t.type === 'repayment'
      ? !!t.sourceAccountId
      : ['expense', 'loan_given', 'transfer', 'goal_contribution'].includes(t.type);

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${style.bg} ${style.text}`}>
        <Icon size={17} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-800 truncate tracking-tight">
          {t.category || typeLabels[t.type] || t.type.replace(/_/g, ' ')}
          {t.relatedPerson ? ` — ${t.relatedPerson}` : ''}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5 truncate">
          {format(new Date(t.createdAt), 'MMM d, h:mm a')}
          {t.notes ? ` · ${t.notes}` : ''}
        </p>
      </div>
      <p className={`text-[14px] font-bold tabular-nums tracking-tight ${isDebit ? 'text-red-500' : 'text-emerald-600'}`}>
        {isDebit ? '-' : '+'}{formatMoney(t.amount, t.currency)}
      </p>
    </div>
  );
}
