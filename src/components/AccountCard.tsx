import { Wallet, Building2, Smartphone, PiggyBank, CreditCard, AlertTriangle } from 'lucide-react';
import type { Account, UpcomingExpense } from '../db';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';

const iconMap: Record<string, React.ElementType> = {
  cash: Wallet,
  bank: Building2,
  digital_wallet: Smartphone,
  savings: PiggyBank,
  credit_card: CreditCard,
};

// Full-gradient card design system per account type
const cardDesign: Record<string, {
  gradient: string;
  iconBg: string;
  accentText: string;
  typeLabel: string;
}> = {
  cash: {
    gradient: 'from-[#1a6b3c] via-[#228B50] to-[#2d9b5a]',
    iconBg: 'bg-white/15',
    accentText: 'text-emerald-200',
    typeLabel: 'CASH',
  },
  bank: {
    gradient: 'from-[#1e3a5f] via-[#24517a] to-[#2d6a9f]',
    iconBg: 'bg-white/15',
    accentText: 'text-blue-200',
    typeLabel: 'BANK',
  },
  digital_wallet: {
    gradient: 'from-[#5b2d8e] via-[#7438b5] to-[#8e44d4]',
    iconBg: 'bg-white/15',
    accentText: 'text-purple-200',
    typeLabel: 'DIGITAL WALLET',
  },
  savings: {
    gradient: 'from-[#b8860b] via-[#c99a1d] to-[#daa520]',
    iconBg: 'bg-white/15',
    accentText: 'text-yellow-200',
    typeLabel: 'SAVINGS',
  },
  credit_card: {
    gradient: 'from-[#1a1a2e] via-[#16213e] to-[#1a1a2e]',
    iconBg: 'bg-white/10',
    accentText: 'text-amber-400',
    typeLabel: 'CREDIT CARD',
  },
};

interface Props {
  account: Account;
  onClick?: () => void;
  nearestExpense?: UpcomingExpense | null;
  monthStats?: { income: number; expense: number } | null;
}

export function AccountCard({ account, onClick, nearestExpense, monthStats }: Props) {
  const t = useT();
  const Icon = iconMap[account.type] ?? Wallet;
  const design = cardDesign[account.type] ?? cardDesign.cash;
  const meta = currencyMeta[account.currency];
  const isCreditCard = account.type === 'credit_card';
  const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
  const used = isCreditCard ? creditLimit - account.balance : 0;
  const dueDay = isCreditCard ? account.metadata.dueDay : '';
  const last4 = isCreditCard ? account.metadata.last4 : '';

  // Credit Card — premium dark card with gold accents
  if (isCreditCard) {
    return (
      <button onClick={onClick}
        className="w-full relative overflow-hidden rounded-[20px] p-4 text-left transition-all active:scale-[0.98] shadow-lg shadow-slate-900/20"
      >
        <div className={`absolute inset-0 bg-gradient-to-br ${design.gradient}`} />
        <div className="absolute inset-0 opacity-10" style={{ background: 'radial-gradient(circle at 80% 20%, rgba(255,255,255,0.4), transparent 60%)' }} />
        <div className="relative flex items-center gap-3.5">
          <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${design.iconBg} text-white shrink-0 backdrop-blur-sm`}>
            <CreditCard size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.15em] mb-0.5">{design.typeLabel}</p>
            <p className="font-semibold text-[13px] text-white truncate tracking-tight">
              {account.metadata.issuer || account.name} {last4 ? `\u2022\u2022\u2022\u2022${last4}` : ''}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
              <span>{meta?.flag}</span>
              {t('cc_used')}: {formatMoney(used, account.currency)} / {formatMoney(creditLimit, account.currency)}
            </p>
            {dueDay && (
              <p className={`text-[10px] font-semibold mt-0.5 ${design.accentText}`}>
                {t('cc_next_due')}: {dueDay}{getOrdinal(parseInt(dueDay))} of month
              </p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className="font-bold text-[15px] text-emerald-400 tabular-nums tracking-tight">
              {formatMoney(account.balance, account.currency)}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">{t('cc_available')}</p>
          </div>
        </div>
        {nearestExpense && <UpcomingBadge expense={nearestExpense} />}
      </button>
    );
  }

  // All other account types — unique gradient card
  return (
    <button
      onClick={onClick}
      className="w-full relative overflow-hidden rounded-[20px] p-4 text-left transition-all active:scale-[0.98] shadow-lg shadow-slate-900/10"
    >
      <div className={`absolute inset-0 bg-gradient-to-br ${design.gradient}`} />
      <div className="absolute inset-0 opacity-15" style={{ background: 'radial-gradient(circle at 80% 20%, rgba(255,255,255,0.4), transparent 60%)' }} />
      <div className="relative flex items-center gap-3.5">
        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${design.iconBg} text-white shrink-0 backdrop-blur-sm`}>
          <Icon size={20} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[9px] font-bold text-white/50 uppercase tracking-[0.15em] mb-0.5">{design.typeLabel}</p>
          <p className="font-semibold text-[13px] text-white truncate tracking-tight">{account.name}</p>
          <p className={`text-[11px] mt-0.5 flex items-center gap-1 ${design.accentText}`}>
            <span>{meta?.flag}</span>
            {account.currency}
            {account.metadata.bankName && ` · ${account.metadata.bankName}`}
            {account.metadata.walletType && ` · ${account.metadata.walletType}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-bold text-[15px] text-white tabular-nums tracking-tight">
            {formatMoney(account.balance, account.currency)}
          </p>
          <p className="text-[10px] text-white/50 mt-0.5">Balance</p>
        </div>
      </div>
      {monthStats && (monthStats.income > 0 || monthStats.expense > 0) && (
        <div className="relative mt-2 flex items-center gap-2 text-[10px] font-medium text-white/60">
          <span>Is mahine:</span>
          {monthStats.income > 0 && <span className="text-emerald-300">+{formatMoney(monthStats.income, account.currency)}</span>}
          {monthStats.income > 0 && monthStats.expense > 0 && <span>/</span>}
          {monthStats.expense > 0 && <span className="text-red-300">-{formatMoney(monthStats.expense, account.currency)}</span>}
        </div>
      )}
      {nearestExpense && <UpcomingBadge expense={nearestExpense} />}
    </button>
  );
}

function UpcomingBadge({ expense }: { expense: UpcomingExpense }) {
  const daysLeft = Math.ceil((new Date(expense.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const urgent = daysLeft <= 7;
  return (
    <div className={`relative mt-2.5 rounded-xl px-3 py-2 flex items-center gap-2 ${urgent ? 'bg-red-500/20' : 'bg-amber-400/20'}`}>
      <AlertTriangle size={12} className={urgent ? 'text-red-300' : 'text-amber-300'} />
      <p className={`text-[10px] font-semibold truncate flex-1 ${urgent ? 'text-red-200' : 'text-amber-200'}`}>
        {expense.title} — {formatMoney(expense.amount, expense.currency)}
        {' — '}{daysLeft <= 0 ? 'Overdue!' : `${daysLeft} din baaqi`}
      </p>
    </div>
  );
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
