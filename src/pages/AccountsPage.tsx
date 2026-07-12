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
import { ListSkeleton } from '../components/ListSkeleton';
import { AddAccountStepper } from './AddAccountStepper';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { groupAccountsByType } from '../lib/accountGroups';
import { currencyMeta } from '../lib/design-tokens';
import { daysUntilDayOfMonth } from '../lib/inboxInfo';
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

  // Currencies the user holds, primary first, then by net (largest first).
  const orderedCurrencies = [...new Set(accounts.map((a) => a.currency))].sort((a, b) => {
    if (a === primaryCurrency) return -1;
    if (b === primaryCurrency) return 1;
    return (totalsByCurrency[b] ?? 0) - (totalsByCurrency[a] ?? 0);
  });
  const otherCurrencies = orderedCurrencies.filter((c) => c !== primaryCurrency);

  // Per-currency breakdown: cash/bank assets, credit-card owed, and the net
  // (== totalsByCurrency). Owed only counts cards with a known limit, so an
  // unset-limit card never silently distorts the figure.
  const breakdownFor = (cur: string) => {
    const accs = accounts.filter((a) => a.currency === cur);
    const assets = accs
      .filter((a) => a.type !== 'credit_card')
      .reduce((sum, a) => sum + a.balance, 0);
    const owed = accs
      .filter((a) => a.type === 'credit_card')
      .reduce((sum, a) => {
        const limit = parseFloat(a.metadata.creditLimit || '0');
        return limit > 0 ? sum + Math.max(0, limit - a.balance) : sum;
      }, 0);
    return {
      accounts: accs,
      assets,
      owed,
      net: totalsByCurrency[cur] ?? 0,
      hasCard: accs.some((a) => a.type === 'credit_card'),
    };
  };

  // Assets vs. owed split for the primary-currency hero chips.
  const hasCreditCard = accounts.some((a) => a.type === 'credit_card');
  const primaryBreakdown = breakdownFor(primaryCurrency);
  const primaryAssets = primaryBreakdown.assets;
  const primaryOwed = primaryBreakdown.owed;

  // Until the first load resolves, treat the screen as "we don't know yet" —
  // don't render the empty state or the hero's "No accounts yet" headline,
  // since both would flash for ~1s before the real data lands.
  const hasAccounts = accounts.length > 0;
  const isInitialLoading = status === 'loading' && !hasAccounts;
  const showEmptyState = status === 'ready' && !hasAccounts;

  const renderRow = (account: typeof accounts[number]) => {
    const Icon = iconForType[account.type] ?? Wallet;
    const meta = currencyMeta[account.currency];
    const typeLabel = labelForType[account.type] ?? account.type.replace(/_/g, ' ');
    const masked = account.metadata.lastFour ? ` · ⋯${account.metadata.lastFour}` : '';
    // Credit cards read as "available balance" + how much is owed, so the
    // liability is visible without decoding a negative net-worth figure.
    const isCreditCard = account.type === 'credit_card';
    const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
    const used = isCreditCard ? creditLimit - account.balance : 0;
    if (isCreditCard) {
      const utilPct = creditLimit > 0 ? Math.max(0, Math.min(100, (used / creditLimit) * 100)) : 0;
      // Utilisation colour: calm green under 50%, amber 50–80%, coral above —
      // the at-a-glance "how maxed is this card" read.
      const utilColor = utilPct >= 80 ? 'bg-pay-600' : utilPct >= 50 ? 'bg-warn-600' : 'bg-receive-600';
      const dueDay = parseInt(account.metadata.dueDay || '', 10);
      const dueIn = daysUntilDayOfMonth(dueDay, new Date());
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
            {creditLimit > 0 ? (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex-1 max-w-[110px] h-1 rounded-full bg-cream-soft overflow-hidden">
                  <div className={`h-full rounded-full ${utilColor}`} style={{ width: `${utilPct}%` }} />
                </div>
                <span className="text-[9.5px] text-ink-400 tabular-nums shrink-0">{Math.round(utilPct)}%</span>
                {dueIn !== null && dueIn <= 7 && (
                  <span className={`text-[9.5px] font-semibold shrink-0 ${dueIn <= 2 ? 'text-pay-text' : 'text-warn-700'}`}>
                    {dueIn === 0 ? t('cc_due_today') : t('cc_due_in').replace('{n}', String(dueIn))}
                  </span>
                )}
              </div>
            ) : (
              <span className="inline-flex items-center mt-1 text-[10px] font-semibold text-warn-700 bg-warn-50 rounded-md px-1.5 py-0.5">
                {t('acct_set_limit')}
              </span>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className={`text-[13.5px] font-semibold tabular-nums tracking-tight ${account.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
              {formatMoney(account.balance, account.currency)}
            </p>
            <p className="text-[10px] text-ink-400 mt-0.5">
              {t('acct_available')}
            </p>
            {creditLimit > 0 && (
              <p className="text-[10px] text-pay-text mt-0.5 tabular-nums">
                {t('acct_owe').replace('{amount}', formatMoney(used, account.currency))}
              </p>
            )}
          </div>
          <ChevronRight size={14} className="text-ink-300 shrink-0 -mr-1" />
        </button>
      );
    }
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
          <p className={`text-[13.5px] font-semibold tabular-nums tracking-tight ${account.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
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
          {isInitialLoading ? (
            <div className="mt-1.5 h-10 w-44 rounded-xl bg-white/10 animate-pulse" />
          ) : showEmptyState ? (
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
              {hasCreditCard && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="inline-flex items-center text-[10px] font-semibold text-receive-100 bg-receive-600/25 rounded-md px-1.5 py-0.5 tabular-nums">
                    {t('acct_assets').replace('{amount}', formatMoney(primaryAssets, primaryCurrency))}
                  </span>
                  <span className="inline-flex items-center text-[10px] font-semibold text-pay-100 bg-pay-600/25 rounded-md px-1.5 py-0.5 tabular-nums">
                    {t('acct_owe_total').replace('{amount}', formatMoney(primaryOwed, primaryCurrency))}
                  </span>
                </div>
              )}
              {otherCurrencies.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {otherCurrencies.map((cur) => {
                    const net = totalsByCurrency[cur] ?? 0;
                    return (
                      <span
                        key={cur}
                        className={`inline-flex items-center gap-1 text-[10.5px] font-semibold rounded-md px-1.5 py-0.5 tabular-nums ${
                          net < 0 ? 'bg-pay-600/25 text-pay-100' : 'bg-white/10 text-white/85'
                        }`}
                      >
                        <span>{currencyMeta[cur]?.flag}</span> {formatSignedMoney(net, cur)}
                      </span>
                    );
                  })}
                </div>
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

        {isInitialLoading ? (
          <ListSkeleton rows={3} />
        ) : showEmptyState ? (
          <EmptyState
            icon={Wallet}
            tone="accent"
            title={t('home_no_accounts')}
            description={t('home_no_accounts_desc')}
            subhint={t('home_no_accounts_subhint')}
            actionLabel={t('home_create_account')}
            onAction={() => setShowAdd(true)}
          />
        ) : (
          <>
            {/* One section per currency (primary first). Each header carries
                that currency's net worth — and an assets·owed sub-line when a
                credit card is in play — so a multi-currency user sees exactly
                what they hold where, with no misleading cross-currency sum. */}
            {orderedCurrencies.map((cur) => {
              const b = breakdownFor(cur);
              return (
                <div key={cur}>
                  <div className="flex items-baseline justify-between mb-2.5 px-1 gap-3">
                    <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] flex items-center gap-1.5 shrink-0">
                      <span className="text-[12px]">{currencyMeta[cur]?.flag}</span> {cur}
                    </h2>
                    <div className="text-right min-w-0">
                      <span
                        className={`text-[12px] font-semibold tabular-nums ${
                          b.net < 0 ? 'text-pay-text' : 'text-ink-700'
                        }`}
                      >
                        {formatSignedMoney(b.net, cur)}
                      </span>
                      {b.hasCard && (b.assets > 0 || b.owed > 0) && (
                        <p className="text-[9.5px] text-ink-400 tabular-nums mt-0.5 truncate">
                          {t('acct_cash_owed')
                            .replace('{cash}', formatMoney(b.assets, cur))
                            .replace('{owed}', formatMoney(b.owed, cur))}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Within a currency, accounts are organized by kind —
                      Wallets & Cash, Banks, Credit Cards — instead of one
                      undifferentiated dump. Labels appear only when the
                      currency actually spans more than one kind. */}
                  {(() => {
                    const typeGroups = groupAccountsByType(b.accounts);
                    const showGroupLabels = typeGroups.length > 1;
                    return (
                      <div className="space-y-2.5">
                        {typeGroups.map((g) => (
                          <div key={g.id}>
                            {showGroupLabels && (
                              <p className="text-[9.5px] font-semibold text-ink-400 uppercase tracking-[0.14em] mb-1 px-1">
                                {t(g.labelKey)}
                              </p>
                            )}
                            <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                              {g.accounts.map(renderRow)}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            <button
              onClick={() => setShowAdd(true)}
              className="w-full rounded-[14px] border-2 border-dashed border-cream-border bg-transparent text-ink-600 py-3 text-[13px] font-semibold active:bg-cream-soft transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
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
