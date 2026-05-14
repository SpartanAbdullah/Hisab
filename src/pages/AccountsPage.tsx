import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Wallet,
  Landmark,
  Smartphone,
  PiggyBank,
  CreditCard,
  ChevronRight,
} from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { AddAccountStepper } from './AddAccountStepper';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

const iconForType: Record<string, React.ElementType> = {
  cash: Wallet,
  bank: Landmark,
  digital_wallet: Smartphone,
  savings: PiggyBank,
  credit_card: CreditCard,
};

const labelForType: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  digital_wallet: 'Wallet',
  savings: 'Savings',
  credit_card: 'Credit',
};

// Sukoon screen 03 — Accounts list. Entered from the net-worth tap on Home.
// Primary currency totals lead; other currencies appear in a pocket section
// below. The "+ Add account" CTA always sits at the bottom of the list so
// adding a fifth or sixth account doesn't require scrolling to a header.
export function AccountsPage() {
  const { accounts, loadAccounts } = useAccountStore();
  const { loadTransactions } = useTransactionStore();
  const navigate = useNavigate();
  const t = useT();
  const primaryCurrency = localStorage.getItem('hisaab_primary_currency') ?? 'AED';
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadTransactions()]);
  }, [loadAccounts, loadTransactions]);
  const { status, error, retry } = useAsyncLoad(load);

  // Net worth — credit cards count as liabilities, mirroring HomePage's math.
  const totalsByCurrency = accounts.reduce(
    (acc, a) => {
      if (a.type === 'credit_card') {
        const limit = parseFloat(a.metadata.creditLimit || '0');
        const used = limit - a.balance;
        acc[a.currency] = (acc[a.currency] ?? 0) - used;
      } else {
        acc[a.currency] = (acc[a.currency] ?? 0) + a.balance;
      }
      return acc;
    },
    {} as Record<string, number>,
  );
  const primaryTotal = totalsByCurrency[primaryCurrency] ?? 0;
  const otherCurrencies = Object.entries(totalsByCurrency).filter(
    ([cur, amt]) => cur !== primaryCurrency && amt > 0,
  );

  const primaryAccounts = accounts.filter((a) => a.currency === primaryCurrency);
  const otherAccounts = accounts.filter((a) => a.currency !== primaryCurrency);

  const renderRow = (account: typeof accounts[number]) => {
    const Icon = iconForType[account.type] ?? Wallet;
    const meta = currencyMeta[account.currency];
    const typeLabel = labelForType[account.type] ?? account.type.replace(/_/g, ' ');
    const masked = account.metadata.lastFour ? ` · ⋯${account.metadata.lastFour}` : '';
    return (
      <button
        key={account.id}
        onClick={() => navigate(`/account/${account.id}`)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
      >
        <div className="w-9 h-9 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
          <Icon size={16} className="text-ink-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
            {account.name}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5">
            {typeLabel}
            {masked}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums tracking-tight">
            {formatMoney(account.balance, account.currency)}
          </p>
          <p className="text-[10px] text-ink-400 mt-0.5">
            {meta?.flag} {account.currency}
          </p>
        </div>
        <ChevronRight size={14} className="text-ink-300 shrink-0 -mr-1" />
      </button>
    );
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('home_accounts') ?? 'Accounts'}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAdd(true)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Add account"
              >
                <Plus size={15} strokeWidth={2.4} className="text-white" />
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            Total balance · {primaryCurrency}
          </p>
          {accounts.length === 0 ? (
            <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
              No accounts yet
            </p>
          ) : (
            <>
              <div className="mt-1.5">
                <MoneyDisplay
                  amount={primaryTotal}
                  currency={primaryCurrency}
                  size={36}
                  tone="on-navy"
                />
              </div>
              {otherCurrencies.length > 0 && (
                <p className="text-[12px] text-white/55 mt-2 tabular-nums">
                  {otherCurrencies
                    .map(([cur, amt]) => formatMoney(amt, cur))
                    .join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load accounts"
            message={error ?? 'Some data failed to load.'}
            onRetry={retry}
          />
        )}

        {accounts.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={t('home_no_accounts')}
            description={t('home_no_accounts_desc')}
            actionLabel={t('home_create_account')}
            onAction={() => setShowAdd(true)}
          />
        ) : (
          <>
            {primaryAccounts.length > 0 && (
              <div>
                <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
                  {primaryCurrency} accounts
                </h2>
                <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                  {primaryAccounts.map(renderRow)}
                </div>
              </div>
            )}

            {otherAccounts.length > 0 && (
              <div>
                <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
                  Other currencies
                </h2>
                <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                  {otherAccounts.map(renderRow)}
                </div>
              </div>
            )}

            <button
              onClick={() => setShowAdd(true)}
              className="w-full rounded-[14px] border-2 border-dashed border-cream-border bg-transparent text-ink-600 py-3 text-[13px] font-semibold active:bg-cream-soft transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={14} strokeWidth={2.4} /> {t('home_create_account')}
            </button>
          </>
        )}
      </div>

      <AddAccountStepper open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}
