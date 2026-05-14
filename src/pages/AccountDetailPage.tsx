import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import {
  Wallet,
  Landmark,
  Smartphone,
  PiggyBank,
  CreditCard,
  Plus,
  ArrowLeftRight,
  AlertTriangle,
  MoreVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import { QuickEntry } from './QuickEntry';
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
import { isGroupLinkedNote } from '../lib/internalNotes';

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
  const { accounts, loadAccounts, renameAccount, deleteAccount } = useAccountStore();
  const { loadTransactions, getByAccount } = useTransactionStore();
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [showOpeningBalance, setShowOpeningBalance] = useState(false);
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openingNote, setOpeningNote] = useState('');
  const [savingOpeningBalance, setSavingOpeningBalance] = useState(false);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [showMenu, setShowMenu] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => {
    loadAccounts();
    loadTransactions();
    loadExpenses();
  }, [loadAccounts, loadTransactions, loadExpenses]);

  const account = accounts.find((a) => a.id === id);
  if (!account) {
    return (
      <main className="min-h-dvh bg-cream-bg flex items-center justify-center">
        <p className="text-ink-500 text-[13px]">Account nahi mila</p>
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
                onClick={() => setShowAdd(true)}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[11.5px] font-semibold text-white transition-colors"
                aria-label="Add transaction"
              >
                <Plus size={12} strokeWidth={2.4} /> Tx
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
                          if (confirm(t('acct_delete_confirm'))) {
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

          {isCreditCard && creditLimit > 0 && (
            <>
              <div className="mt-4 h-1.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-white transition-all duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, (used / creditLimit) * 100))}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-[11px]">
                <span className="text-white/65">
                  {t('cc_used')}: {formatMoney(used, account.currency)}
                </span>
                <span className="text-white/85 font-medium">
                  {t('cc_limit')}: {formatMoney(creditLimit, account.currency)}
                </span>
              </div>
              {account.metadata.dueDay && (
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warn-600/25 px-3 py-1 text-[11px] font-semibold text-white">
                  {t('cc_next_due')}: {account.metadata.dueDay}
                  {getOrdinal(parseInt(account.metadata.dueDay))} of month
                </div>
              )}
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
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
                  onClick={async () => {
                    if (newName.trim() && newName.trim() !== account.name) {
                      await renameAccount(account.id, newName.trim());
                      toast.show({ type: 'success', title: 'Account renamed' });
                    }
                    setShowRename(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
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
              title={t('no_tx')}
              description={t('no_tx_desc')}
              actionLabel={t('txpage_add')}
              onAction={() => setShowAdd(true)}
            />
          ) : (
            <div className="rounded-[18px] bg-cream-card border border-cream-border px-4 divide-y divide-cream-hairline">
              {filteredTxns.map((txn) =>
                ['expense', 'loan_given', 'loan_taken'].includes(txn.type) &&
                !isGroupLinkedNote(txn.notes) ? (
                  <TransactionItem
                    key={txn.id}
                    transaction={txn}
                    accountContextId={account.id}
                    onClick={() => setSelectedTransaction(txn)}
                  />
                ) : (
                  <TransactionItem
                    key={txn.id}
                    transaction={txn}
                    accountContextId={account.id}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      <QuickEntry open={showAdd} onClose={() => setShowAdd(false)} />
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
