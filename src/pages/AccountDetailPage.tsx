import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { PageErrorState } from '../components/PageErrorState';
import { useTransactionStore } from '../stores/transactionStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { daysUntilDayOfMonth } from '../lib/inboxInfo';
import { useT } from '../lib/i18n';
import {
  Wallet,
  Landmark,
  Smartphone,
  PiggyBank,
  CreditCard,
  Plus,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  HandCoins,
  Users,
  AlertTriangle,
  MoreVertical,
  Pencil,
  Trash2,
  Calculator,
  Info,
  CalendarClock,
  Banknote,
  SlidersHorizontal,
} from 'lucide-react';
import type { Account } from '../db';
import { QuickEntry, type QuickEntryPreset } from './QuickEntry';
import { useToast } from '../components/Toast';
import {
  startOfDay,
  subDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  subWeeks,
  subMonths,
  subYears,
  isWithinInterval,
  differenceInDays,
} from 'date-fns';
import type { Transaction } from '../db';

type TimeFilter =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year';

function filterByTime(txns: Transaction[], timeFilter: TimeFilter): Transaction[] {
  if (timeFilter === 'all') return txns;
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (timeFilter) {
    case 'today': start = startOfDay(now); end = now; break;
    case 'yesterday': { const yd = subDays(now, 1); start = startOfDay(yd); end = startOfDay(now); break; }
    case 'this_week': start = startOfWeek(now, { weekStartsOn: 1 }); end = endOfWeek(now, { weekStartsOn: 1 }); break;
    case 'last_week': { const lw = subWeeks(now, 1); start = startOfWeek(lw, { weekStartsOn: 1 }); end = endOfWeek(lw, { weekStartsOn: 1 }); break; }
    case 'this_month': start = startOfMonth(now); end = endOfMonth(now); break;
    case 'last_month': { const lm = subMonths(now, 1); start = startOfMonth(lm); end = endOfMonth(lm); break; }
    case 'this_year': start = startOfYear(now); end = endOfYear(now); break;
    case 'last_year': { const ly = subYears(now, 1); start = startOfYear(ly); end = endOfYear(ly); break; }
    default: return txns;
  }
  return txns.filter((tx) => isWithinInterval(new Date(tx.createdAt), { start, end }));
}

const iconMap: Record<string, React.ElementType> = {
  cash: Wallet,
  bank: Landmark,
  digital_wallet: Smartphone,
  savings: PiggyBank,
  credit_card: CreditCard,
};
const typeLabelMap: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  digital_wallet: 'Digital wallet',
  savings: 'Savings',
  credit_card: 'Credit card',
};

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { accounts, loadAccounts, renameAccount, deleteAccount, updateMetadata } = useAccountStore();
  const { loadTransactions, getByAccount } = useTransactionStore();
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [quickPreset, setQuickPreset] = useState<QuickEntryPreset | null>(null);
  const [showOpeningBalance, setShowOpeningBalance] = useState(false);
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openingNote, setOpeningNote] = useState('');
  const [savingOpeningBalance, setSavingOpeningBalance] = useState(false);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [showMenu, setShowMenu] = useState(false);
  const [showCardSettings, setShowCardSettings] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [dueDayInput, setDueDayInput] = useState('');
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCorrect, setShowCorrect] = useState(false);
  const [correctInput, setCorrectInput] = useState('');
  const [savingCorrect, setSavingCorrect] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadTransactions(), loadExpenses()]);
  }, [loadAccounts, loadTransactions, loadExpenses]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const account = accounts.find((a) => a.id === id);

  // Don't render "account not found" until the accounts list has actually
  // finished loading — otherwise a deep-link to /account/:id flashes the
  // not-found screen for ~1s while Supabase responds.
  if (!account) {
    if (loadStatus === 'error') {
      return (
        <PageErrorState
          title="Couldn't load this account"
          message={loadError ?? 'Account data failed to load.'}
          onRetry={retryLoad}
        />
      );
    }
    if (loadStatus === 'loading') {
      return (
        <main className="min-h-dvh bg-cream-bg flex items-center justify-center">
          <div className="flex items-center gap-2 text-ink-500 text-[13px]">
            <div className="w-3 h-3 rounded-full bg-cream-hairline animate-pulse" />
            Loading…
          </div>
        </main>
      );
    }
    return (
      <main className="min-h-dvh bg-cream-bg flex items-center justify-center">
        <p className="text-ink-500 text-[13px]">{t('account_not_found')}</p>
      </main>
    );
  }

  const accountTxns = getByAccount(account.id);
  const Icon = iconMap[account.type] ?? Wallet;
  const meta = currencyMeta[account.currency];
  const isCreditCard = account.type === 'credit_card';
  const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
  const used = isCreditCard ? creditLimit - account.balance : 0;

  const accountUpcoming = expenses.filter(
    (e) => e.accountId === account.id && e.status === 'upcoming',
  );
  const totalUpcoming = accountUpcoming.reduce((s, e) => s + e.amount, 0);
  const hasWarning = totalUpcoming > account.balance;

  const hasNoTransactions = accountTxns.length === 0;
  const isZeroBalance = account.balance === 0;
  const showOpeningBalancePrompt = hasNoTransactions && isZeroBalance;

  // Only show the "How this affects Your Money" breakdown when there's
  // actual math to explain. With zero credit cards in the user's
  // portfolio, every account contributes its balance one-for-one — the
  // card would just say "Balance = +Balance" which is noise. The moment
  // any credit card exists somewhere (this account or elsewhere), the
  // breakdown earns its space by making the +/− contribution visible
  // per account.
  const showMoneyMath = accounts.some((a) => a.type === 'credit_card');

  const TIME_FILTERS: { label: string; value: TimeFilter }[] = [
    { label: t('time_all'), value: 'all' },
    { label: t('time_today'), value: 'today' },
    { label: t('time_yesterday'), value: 'yesterday' },
    { label: t('time_this_week'), value: 'this_week' },
    { label: t('time_last_week'), value: 'last_week' },
    { label: t('time_this_month'), value: 'this_month' },
    { label: t('time_last_month'), value: 'last_month' },
    { label: t('time_this_year'), value: 'this_year' },
    { label: t('time_last_year'), value: 'last_year' },
  ];

  const filteredTxns = filterByTime(accountTxns, timeFilter);

  const closeOpeningBalance = () => {
    setShowOpeningBalance(false);
    setOpeningAmount('');
    setOpeningDate(new Date().toISOString().slice(0, 10));
    setOpeningNote('');
  };

  const saveOpeningBalance = async () => {
    const amount = parseFloat(openingAmount);
    if (!amount || amount <= 0) return;
    setSavingOpeningBalance(true);
    try {
      await useTransactionStore.getState().processTransaction({
        type: 'opening_balance',
        amount,
        destinationAccountId: account.id,
        notes: openingNote.trim() || 'Opening Balance',
        createdAt: openingDate ? new Date(`${openingDate}T12:00:00`).toISOString() : undefined,
      });
      await Promise.all([loadAccounts(), loadTransactions()]);
      toast.show({ type: 'success', title: t('acct_opening_saved') });
      closeOpeningBalance();
    } catch (err) {
      toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSavingOpeningBalance(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={account.name}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setQuickPreset({ accountId: account.id, lockAccount: true });
                  setShowAdd(true);
                }}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[11.5px] font-semibold text-white transition-colors"
                aria-label="Add entry"
              >
                <Plus size={12} strokeWidth={2.4} /> {t('add_entry')}
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                  aria-label="More"
                >
                  <MoreVertical size={15} className="text-white" />
                </button>
                {showMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowMenu(false)}
                    />
                    <div className="absolute right-0 top-11 z-50 bg-cream-card rounded-2xl shadow-xl shadow-navy-900/15 border border-cream-border py-1.5 w-44 animate-fade-in">
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          setNewName(account.name);
                          setShowRename(true);
                        }}
                        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-ink-800 active:bg-cream-soft"
                      >
                        <Pencil size={14} className="text-ink-500" /> Rename
                      </button>
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          setCorrectInput(String(account.balance));
                          setShowCorrect(true);
                        }}
                        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-ink-800 active:bg-cream-soft"
                      >
                        <SlidersHorizontal size={14} className="text-ink-500" /> {t('acct_correct_balance')}
                      </button>
                      <button
                        onClick={async () => {
                          setShowMenu(false);
                          if (account.balance !== 0) {
                            toast.show({
                              type: 'error',
                              title: t('acct_delete_nonzero'),
                              subtitle: t('acct_delete_nonzero_desc'),
                            });
                            return;
                          }
                          const ok = await confirmDestructive({
                            title: t('acct_delete_confirm'),
                            description: t('del_account_body'),
                            confirmLabel: 'Delete account',
                          });
                          if (ok) {
                            try {
                              await deleteAccount(account.id);
                              toast.show({ type: 'success', title: t('acct_deleted') });
                              navigate('/accounts');
                            } catch (err) {
                              toast.show({
                                type: 'error',
                                title: err instanceof Error ? err.message : 'Failed',
                              });
                            }
                          }
                        }}
                        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-pay-text active:bg-pay-50"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-11 h-11 rounded-2xl bg-white/10 flex items-center justify-center shrink-0">
              <Icon size={20} className="text-white" strokeWidth={1.7} />
            </div>
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
                {typeLabelMap[account.type] ?? account.type.replace('_', ' ')}
              </p>
              <p className="text-[11px] text-white/70 flex items-center gap-1 mt-0.5">
                <span>{meta?.flag}</span> {account.currency}
                {account.metadata.bankName && (
                  <span className="text-white/45"> · {account.metadata.bankName}</span>
                )}
              </p>
            </div>
          </div>

          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            {isCreditCard ? t('cc_available') : 'Balance'}
          </p>
          <div className="mt-1.5">
            <MoneyDisplay
              amount={account.balance}
              currency={account.currency}
              size={38}
              tone="on-navy"
            />
          </div>

          {isCreditCard && creditLimit > 0 && (() => {
            const utilPct = Math.max(0, Math.min(100, (used / creditLimit) * 100));
            // Coral when nearly maxed, amber mid-range, white when healthy.
            const barColor = utilPct >= 80 ? 'bg-pay-600' : utilPct >= 50 ? 'bg-warn-600' : 'bg-white';
            const dueDay = account.metadata.dueDay ? parseInt(account.metadata.dueDay, 10) : NaN;
            const dueIn = daysUntilDayOfMonth(dueDay, new Date());
            const dueUrgent = dueIn !== null && dueIn <= 3;
            return (
              <>
                <div className="mt-4 h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${barColor} transition-all duration-500`}
                    style={{ width: `${utilPct}%` }}
                  />
                </div>
                <div className="flex justify-between mt-2 text-[11px]">
                  <span className="text-white/65 tabular-nums">
                    {used < -0.005
                      ? t('acct_overpaid').replace('{amount}', formatMoney(Math.abs(used), account.currency))
                      : <>{t('cc_used')}: {formatMoney(used, account.currency)} · {Math.round(utilPct)}%</>}
                  </span>
                  <span className="text-white/85 font-medium tabular-nums">
                    {t('cc_limit')}: {formatMoney(creditLimit, account.currency)}
                  </span>
                </div>
                {/* Available above the limit is almost always a double-recorded
                    payment, never a healthy state — say so instead of the old
                    silent "0%" and point at the repair tool. */}
                {used < -0.005 && (
                  <button
                    type="button"
                    onClick={() => { setCorrectInput(String(creditLimit)); setShowCorrect(true); }}
                    className="mt-3 w-full text-left rounded-2xl bg-warn-600/25 p-3 active:bg-warn-600/35 transition-colors"
                  >
                    <p className="text-[11px] text-white/90 leading-relaxed font-medium">
                      {t('acct_over_limit_hint')}
                    </p>
                  </button>
                )}
                {account.metadata.dueDay && (
                  <div className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold text-white ${dueUrgent ? 'bg-pay-600/30' : 'bg-warn-600/25'}`}>
                    <CalendarClock size={11} />
                    {t('cc_next_due')}: {account.metadata.dueDay}
                    {getOrdinal(parseInt(account.metadata.dueDay))}
                    {dueIn !== null && (
                      <span className="text-white/85">
                        {' · '}
                        {dueIn === 0 ? t('cc_due_today') : t('cc_due_in').replace('{n}', String(dueIn))}
                      </span>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Account-scoped quick-action tiles, PERSONALIZED per account type.
            A credit card is not a wallet: you can't "receive" into it, and
            moving/splitting from it makes no sense — its real verbs are
            spend, pay the bill, take a cash advance, and adjust the limit.
            Other account types keep the full Spend/Receive/Move + person +
            group set. Locked account context flows through the preset. */}
        {isCreditCard ? (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'expense', accountId: account.id, lockAccount: true });
                setShowAdd(true);
              }}
              className="rounded-2xl bg-cream-card border border-cream-border px-2 py-3 text-[12px] font-semibold text-ink-800 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <ArrowUpRight size={15} className="text-accent-600" />
              {t('acct_action_card_spend')}
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'transfer', destinationAccountId: account.id });
                setShowAdd(true);
              }}
              className="rounded-2xl bg-accent-50 border border-accent-100 px-2 py-3 text-[12px] font-semibold text-accent-600 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <CreditCard size={15} className="text-accent-600" />
              {t('acct_action_pay_card')}
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'loan_taken', cashAdvanceCardId: account.id });
                setShowAdd(true);
              }}
              className="rounded-2xl bg-warn-50 border border-warn-100 px-2 py-3 text-[12px] font-semibold text-warn-600 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <Banknote size={15} className="text-warn-600" />
              {t('acct_action_cash_advance')}
            </button>
            <button
              type="button"
              onClick={() => {
                setLimitInput(account.metadata.creditLimit ?? '');
                setDueDayInput(account.metadata.dueDay ?? '');
                setShowCardSettings(true);
              }}
              className="rounded-2xl bg-cream-card border border-cream-border px-2 py-3 text-[12px] font-semibold text-ink-800 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <SlidersHorizontal size={15} className="text-accent-600" />
              {t('acct_action_card_settings')}
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {[
                { type: 'expense' as const, label: t('intent_spend'), icon: ArrowUpRight },
                { type: 'income' as const, label: t('intent_receive'), icon: ArrowDownLeft },
                { type: 'transfer' as const, label: t('intent_move'), icon: ArrowLeftRight },
              ].map((action) => (
                <button
                  key={action.type}
                  type="button"
                  onClick={() => {
                    setQuickPreset({ type: action.type, accountId: account.id, lockAccount: true });
                    setShowAdd(true);
                  }}
                  className="rounded-2xl bg-cream-card border border-cream-border px-2 py-3 text-[12px] font-semibold text-ink-800 flex flex-col items-center gap-1.5 active:scale-[0.98] transition-transform"
                >
                  <action.icon size={15} className="text-accent-600" />
                  {action.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setQuickPreset({ intent: 'person_money', accountId: account.id, lockAccount: true });
                  setShowAdd(true);
                }}
                className="rounded-2xl bg-cream-card border border-cream-border px-2 py-3 text-[12px] font-semibold text-ink-800 flex flex-col items-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <HandCoins size={15} className="text-accent-600" />
                {t('acct_action_person')}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Group expense uses splits across multiple accounts; the
                  // account context isn't locked here.
                  setQuickPreset({ intent: 'group_expense' });
                  setShowAdd(true);
                }}
                className="rounded-2xl bg-cream-card border border-cream-border px-2 py-3 text-[12px] font-semibold text-ink-800 flex flex-col items-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <Users size={15} className="text-accent-600" />
                {t('acct_action_group')}
              </button>
            </div>
          </>
        )}
        {/* Rename modal (lightweight — kept inline since the Modal helper is
            optimised for the bottom-sheet pattern, not centred dialogs) */}
        {showRename && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setShowRename(false)}
          >
            <div
              className="bg-cream-card rounded-2xl p-5 w-[90%] max-w-sm shadow-xl border border-cream-border"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-[15px] font-semibold text-ink-900 mb-3">Rename account</h3>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all mb-3 bg-cream-bg"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRename(false)}
                  className="flex-1 py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold"
                >
                  Cancel
                </button>
                <button
                  disabled={!newName.trim() || newName.trim() === account.name}
                  onClick={async () => {
                    if (newName.trim() && newName.trim() !== account.name) {
                      await renameAccount(account.id, newName.trim());
                      toast.show({ type: 'success', title: 'Account renamed' });
                    }
                    setShowRename(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30 transition-opacity"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Card settings dialog — the card's limit changes in real life
            (bank raises/lowers it) and the app must keep up. Same inline
            centred-dialog pattern as Rename. */}
        {showCardSettings && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setShowCardSettings(false)}
          >
            <div
              className="bg-cream-card rounded-2xl p-5 w-[90%] max-w-sm shadow-xl border border-cream-border"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-[15px] font-semibold text-ink-900 mb-3">{t('cc_settings_title')}</h3>
              <label className="block text-[11px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-1.5">
                {t('cc_settings_limit')} ({account.currency})
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                autoFocus
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all mb-3 bg-cream-bg"
              />
              <label className="block text-[11px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-1.5">
                {t('cc_settings_due')}
              </label>
              <input
                type="number"
                min="1"
                max="31"
                step="1"
                value={dueDayInput}
                onChange={(e) => setDueDayInput(e.target.value)}
                placeholder="—"
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all mb-3 bg-cream-bg"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCardSettings(false)}
                  className="flex-1 py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold"
                >
                  {t('cancel')}
                </button>
                <button
                  disabled={(() => {
                    const lim = parseFloat(limitInput);
                    if (!Number.isFinite(lim) || lim <= 0) return true;
                    if (dueDayInput.trim() !== '') {
                      const d = parseInt(dueDayInput, 10);
                      if (!Number.isInteger(d) || d < 1 || d > 31) return true;
                    }
                    return false;
                  })()}
                  onClick={async () => {
                    try {
                      await updateMetadata(account.id, {
                        creditLimit: String(parseFloat(limitInput)),
                        dueDay: dueDayInput.trim() === '' ? '' : String(parseInt(dueDayInput, 10)),
                      });
                      toast.show({ type: 'success', title: t('cc_settings_saved') });
                      setShowCardSettings(false);
                    } catch (err) {
                      toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30 transition-opacity"
                >
                  {t('save')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Balance correction: set the balance to the true figure via a
            visible, reversible adjustment entry — the sanctioned repair for
            drifted accounts (no more fake income/expense entries). */}
        {showCorrect && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setShowCorrect(false)}
          >
            <div
              className="bg-cream-card rounded-2xl p-5 w-[90%] max-w-sm shadow-xl border border-cream-border"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-[15px] font-semibold text-ink-900 mb-1.5">{t('acct_correct_title')}</h3>
              <p className="text-[11.5px] text-ink-500 leading-relaxed mb-3">{t('acct_correct_hint')}</p>
              <label className="block text-[11px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-1.5">
                {isCreditCard ? t('cc_available') : 'Balance'} ({account.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={correctInput}
                onChange={(e) => setCorrectInput(e.target.value)}
                autoFocus
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all mb-3 bg-cream-bg"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCorrect(false)}
                  className="flex-1 py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold"
                >
                  {t('cancel')}
                </button>
                <button
                  disabled={savingCorrect || !Number.isFinite(parseFloat(correctInput)) || Math.abs(parseFloat(correctInput) - account.balance) < 0.005}
                  onClick={async () => {
                    setSavingCorrect(true);
                    try {
                      await useTransactionStore.getState().processTransaction({
                        type: 'adjustment',
                        amount: 0,
                        accountId: account.id,
                        targetBalance: parseFloat(correctInput),
                        notes: t('acct_correct_note'),
                      });
                      await Promise.all([loadAccounts(), loadTransactions()]);
                      toast.show({ type: 'success', title: t('acct_correct_saved') });
                      setShowCorrect(false);
                    } catch (err) {
                      toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
                    } finally {
                      setSavingCorrect(false);
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30 transition-opacity"
                >
                  {t('acct_correct_cta')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* "How this affects Your Money" breakdown. Only renders when the
            user actually has at least one credit card in their portfolio
            — otherwise the math is trivially Balance = Balance and the
            card is pure noise. Two variants below: credit cards do
            limit/used/owed math; regular accounts show a single-line
            "added to your money" so the user can trace the contribution
            into the dashboard total. */}
        {showMoneyMath && (
          <MoneyMathCard
            account={account}
            isCreditCard={isCreditCard}
            creditLimit={creditLimit}
            used={used}
          />
        )}

        {/* Opening balance prompt — only when no txns + zero balance */}
        {showOpeningBalancePrompt && (
          <div className="rounded-[18px] bg-accent-50 border border-cream-border p-5 text-center">
            <div className="w-12 h-12 rounded-2xl bg-accent-100 flex items-center justify-center mx-auto mb-3">
              <Wallet size={20} className="text-accent-600" />
            </div>
            <p className="text-[13px] font-semibold text-ink-900 mb-3">
              {t('acct_opening_bal_prompt')}
            </p>
            <button
              onClick={() => setShowOpeningBalance(true)}
              className="bg-ink-900 text-white rounded-xl px-5 py-2.5 text-[12px] font-semibold active:scale-[0.98] transition-transform"
            >
              {t('acct_add_opening_bal')}
            </button>
          </div>
        )}

        {/* Upcoming expense warning */}
        {accountUpcoming.length > 0 && (
          <div
            className={`rounded-[18px] p-4 border border-cream-border ${
              hasWarning ? 'bg-pay-50' : 'bg-warn-50'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <AlertTriangle
                size={16}
                className={hasWarning ? 'text-pay-text' : 'text-warn-600'}
              />
              <div className="flex-1">
                <p
                  className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${
                    hasWarning ? 'text-pay-text' : 'text-warn-600'
                  }`}
                >
                  {accountUpcoming.length} {t('upcoming_title')}
                </p>
                <p className="text-[11px] text-ink-500">
                  Total: {formatMoney(totalUpcoming, account.currency)}
                  {hasWarning && ` — ${t('upcoming_low_balance')}!`}
                </p>
              </div>
            </div>
            <div className="mt-2.5 space-y-1.5">
              {accountUpcoming.slice(0, 3).map((e) => {
                const daysLeft = differenceInDays(new Date(e.dueDate), new Date());
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between text-[11px]"
                  >
                    <span className="text-ink-800 font-medium">{e.title}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-900 font-semibold tabular-nums">
                        {formatMoney(e.amount, e.currency)}
                      </span>
                      <span
                        className={`text-[9.5px] font-semibold ${
                          daysLeft < 0
                            ? 'text-pay-text'
                            : daysLeft <= 3
                            ? 'text-warn-600'
                            : 'text-ink-500'
                        }`}
                      >
                        {daysLeft < 0
                          ? t('upcoming_overdue')
                          : daysLeft === 0
                          ? t('upcoming_due_today')
                          : `${daysLeft} ${t('upcoming_due_in')}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Time filter pills */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
          {TIME_FILTERS.map((f) => {
            const isActive = timeFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setTimeFilter(f.value)}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-[10.5px] font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-ink-800 text-white'
                    : 'bg-cream-soft text-ink-500 border border-cream-hairline'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {timeFilter !== 'all' && (
          <p className="text-[10.5px] text-ink-500 font-semibold">
            {filteredTxns.length} {t('time_results')}
          </p>
        )}

        {/* Transaction history */}
        <div>
          <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
            {t('tx_history')}
          </h2>
          {filteredTxns.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              tone="accent"
              size="compact"
              title={t('no_tx')}
              description={`No entries in ${account.name} yet. Add your first spend or receive entry.`}
              actionLabel={t('txpage_add')}
              onAction={() => setShowAdd(true)}
            />
          ) : (
            <div className="rounded-[18px] bg-cream-card border border-cream-border px-4 divide-y divide-cream-hairline">
              {filteredTxns.map((txn) => (
                <TransactionItem
                  key={txn.id}
                  transaction={txn}
                  accountContextId={account.id}
                  onClick={() => setSelectedTransaction(txn)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <QuickEntry
        open={showAdd}
        preset={quickPreset}
        onClose={() => {
          setShowAdd(false);
          setQuickPreset(null);
        }}
      />
      <Modal
        open={showOpeningBalance}
        onClose={closeOpeningBalance}
        title={t('acct_opening_title')}
        footer={
          <button
            onClick={saveOpeningBalance}
            disabled={savingOpeningBalance || !parseFloat(openingAmount) || !openingDate}
            className="w-full bg-ink-900 text-white rounded-2xl py-4 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
          >
            {savingOpeningBalance ? t('quick_processing') : t('acct_opening_save')}
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] text-ink-500 leading-relaxed">{t('acct_opening_help')}</p>
          <div>
            <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
              {t('acct_opening_amount')}
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              className="w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
              {t('acct_opening_date')}
            </label>
            <input
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              className="w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
              {t('quick_note')}
            </label>
            <input
              value={openingNote}
              onChange={(e) => setOpeningNote(e.target.value)}
              placeholder={t('acct_opening_note_placeholder')}
              className="w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
            />
          </div>
        </div>
      </Modal>
      <EditTransactionModal
        open={!!selectedTransaction}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
    </main>
  );
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// Inline explainer for what this account contributes to "Your Money" on
// the home dashboard. Keeps the math out of code-comment territory so
// users can verify the number themselves. Two variants:
//   • Regular accounts (cash/bank/wallet/savings) — single +Balance line.
//   • Credit cards — three-line breakdown (Limit / Used / Available) plus
//     a clear "subtracted from your money" total. If no limit is set we
//     show a warning so the user knows the math is incomplete.
function MoneyMathCard({
  account,
  isCreditCard,
  creditLimit,
  used,
}: {
  account: Account;
  isCreditCard: boolean;
  creditLimit: number;
  used: number;
}) {
  const currency = account.currency;

  if (!isCreditCard) {
    return (
      <div className="rounded-[18px] bg-cream-card border border-cream-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-lg bg-accent-100 flex items-center justify-center shrink-0">
            <Calculator size={13} className="text-accent-600" />
          </div>
          <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
            How this affects Your Money
          </p>
        </div>
        <div className="flex items-baseline justify-between px-1">
          <span className="text-[12.5px] text-ink-600">Balance</span>
          <span className="text-[13px] font-semibold text-ink-900 tabular-nums">
            {formatMoney(account.balance, currency)}
          </span>
        </div>
        <div className="mt-3 pt-3 border-t border-cream-hairline flex items-baseline justify-between px-1">
          <span className="text-[11px] font-semibold text-receive-text uppercase tracking-[0.08em]">
            Added to Your Money
          </span>
          <span className="text-[14px] font-semibold text-receive-text tabular-nums">
            +{formatMoney(account.balance, currency)}
          </span>
        </div>
      </div>
    );
  }

  // Credit-card variant. `used` is computed in the parent as
  // (creditLimit − balance). When creditLimit is 0 (unset), used is
  // negative — surface a clear "set a limit" CTA instead of showing
  // misleading math, since the dashboard will under-report what you owe.
  const limitMissing = creditLimit <= 0;
  const available = account.balance;

  return (
    <div className="rounded-[18px] bg-cream-card border border-cream-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg bg-pay-50 flex items-center justify-center shrink-0">
          <Calculator size={13} className="text-pay-text" />
        </div>
        <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
          How this affects Your Money
        </p>
      </div>

      {limitMissing ? (
        <div className="rounded-xl bg-warn-50 border border-cream-border px-3 py-2.5 flex items-start gap-2">
          <Info size={12} className="text-warn-600 mt-0.5 shrink-0" />
          <p className="text-[11px] text-ink-700 leading-relaxed">
            No credit limit set — Hisaab can't tell how much of this card you've
            used. Open the card details to set the limit so your net worth
            reflects what you actually owe.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1.5 px-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] text-ink-600">Credit limit</span>
              <span className="text-[13px] font-medium text-ink-900 tabular-nums">
                {formatMoney(creditLimit, currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] text-ink-600">
                Available (balance)
              </span>
              <span className="text-[13px] font-medium text-ink-900 tabular-nums">
                − {formatMoney(available, currency)}
              </span>
            </div>
          </div>
          {/* used < 0 = credited past the limit; formatMoney's abs() would
              flip that into fake debt ("You owe 11,150" on an overpaid card),
              so the row switches to an explicit overpaid reading. */}
          <div className="mt-2 pt-2 border-t border-cream-hairline flex items-baseline justify-between px-1">
            <span className="text-[12.5px] text-ink-700">
              {used < -0.005 ? 'Overpaid (above limit)' : 'You owe (used)'}
            </span>
            <span className={`text-[13.5px] font-semibold tabular-nums ${used < -0.005 ? 'text-warn-700' : 'text-pay-text'}`}>
              {formatMoney(Math.abs(used), currency)}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-cream-hairline flex items-baseline justify-between px-1">
            <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${used < -0.005 ? 'text-receive-text' : 'text-pay-text'}`}>
              {used < -0.005 ? 'Added to Your Money' : 'Subtracted from Your Money'}
            </span>
            <span className={`text-[14px] font-semibold tabular-nums ${used < -0.005 ? 'text-receive-text' : 'text-pay-text'}`}>
              {used < -0.005 ? '+' : '−'}{formatMoney(Math.abs(used), currency)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
