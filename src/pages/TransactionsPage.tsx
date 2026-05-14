import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowLeftRight, Search, X } from 'lucide-react';
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
  isSameDay,
  format,
} from 'date-fns';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { QuickEntry } from './QuickEntry';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { isGroupLinkedNote, parseInternalNote } from '../lib/internalNotes';
import type { TransactionType, Transaction } from '../db';

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
    case 'today':
      start = startOfDay(now);
      end = now;
      break;
    case 'yesterday': {
      const yesterday = subDays(now, 1);
      start = startOfDay(yesterday);
      end = startOfDay(now);
      break;
    }
    case 'this_week':
      start = startOfWeek(now, { weekStartsOn: 1 });
      end = endOfWeek(now, { weekStartsOn: 1 });
      break;
    case 'last_week': {
      const lastWeek = subWeeks(now, 1);
      start = startOfWeek(lastWeek, { weekStartsOn: 1 });
      end = endOfWeek(lastWeek, { weekStartsOn: 1 });
      break;
    }
    case 'this_month':
      start = startOfMonth(now);
      end = endOfMonth(now);
      break;
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      start = startOfMonth(lastMonth);
      end = endOfMonth(lastMonth);
      break;
    }
    case 'this_year':
      start = startOfYear(now);
      end = endOfYear(now);
      break;
    case 'last_year': {
      const lastYear = subYears(now, 1);
      start = startOfYear(lastYear);
      end = endOfYear(lastYear);
      break;
    }
    default:
      return txns;
  }

  return txns.filter((txn) => isWithinInterval(new Date(txn.createdAt), { start, end }));
}

// Sign convention for the month flow hero:
//   income, loan_taken, opening_balance → positive (money in)
//   expense, loan_given, goal_contribution, repayment-from-account → negative
// Mirrors HomePage's net-worth ring math so the two screens agree.
function classifyForFlow(tx: Transaction): 'in' | 'out' | 'neutral' {
  if (tx.type === 'income' || tx.type === 'loan_taken' || tx.type === 'opening_balance') return 'in';
  if (
    tx.type === 'expense' ||
    tx.type === 'loan_given' ||
    tx.type === 'goal_contribution' ||
    (tx.type === 'repayment' && Boolean(tx.sourceAccountId))
  ) {
    return 'out';
  }
  return 'neutral';
}

export function TransactionsPage() {
  const { transactions, loadTransactions } = useTransactionStore();
  const { loadAccounts } = useAccountStore();
  const { loadLoans } = useLoanStore();
  const { loadGoals } = useGoalStore();
  const t = useT();

  const primaryCurrency = localStorage.getItem('hisaab_primary_currency') ?? 'AED';

  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<TransactionType | 'all'>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => {
    loadTransactions();
    loadAccounts();
    loadLoans();
    loadGoals();
  }, [loadTransactions, loadAccounts, loadLoans, loadGoals]);

  const typeFilters: { label: string; value: TransactionType | 'all' }[] = [
    { label: t('txpage_all'), value: 'all' },
    { label: t('tx_income'), value: 'income' },
    { label: t('tx_expense'), value: 'expense' },
    { label: t('tx_transfer'), value: 'transfer' },
    { label: t('nav_loans'), value: 'loan_given' },
  ];

  const timeFilterOptions: { label: string; value: TimeFilter }[] = [
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

  // This-month totals for the navy hero. Always in primary currency so the
  // headline number is unambiguous; transactions in other currencies still
  // show in the list below.
  const monthFlow = useMemo(() => {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);
    const monthTxns = transactions.filter(
      (tx) =>
        tx.currency === primaryCurrency &&
        isWithinInterval(new Date(tx.createdAt), { start: monthStart, end: monthEnd }),
    );
    let inflow = 0;
    let outflow = 0;
    for (const tx of monthTxns) {
      const kind = classifyForFlow(tx);
      if (kind === 'in') inflow += tx.amount;
      else if (kind === 'out') outflow += tx.amount;
    }
    return { inflow, outflow, net: inflow - outflow };
  }, [transactions, primaryCurrency]);

  const filtered = useMemo(() => {
    let result =
      filter === 'all'
        ? transactions
        : filter === 'loan_given'
        ? transactions.filter(
            (txn) => txn.type === 'loan_given' || txn.type === 'loan_taken' || txn.type === 'repayment',
          )
        : transactions.filter((txn) => txn.type === filter);

    result = filterByTime(result, timeFilter);

    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(
        (txn) =>
          parseInternalNote(txn.notes).visibleNote.toLowerCase().includes(query) ||
          txn.category?.toLowerCase().includes(query) ||
          (txn.relatedPerson ?? '').toLowerCase().includes(query) ||
          txn.amount?.toString().includes(query),
      );
    }

    return result;
  }, [transactions, filter, timeFilter, search]);

  // Day-group the filtered list — Sukoon's per-day section pattern. Each
  // group carries its own signed total so the user can scan a day at a
  // glance without doing the math.
  const dayGroups = useMemo(() => {
    const groups = new Map<string, { date: Date; items: Transaction[]; signedSum: number }>();
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const tx of sorted) {
      const day = startOfDay(new Date(tx.createdAt));
      const key = day.toISOString();
      let entry = groups.get(key);
      if (!entry) {
        entry = { date: day, items: [], signedSum: 0 };
        groups.set(key, entry);
      }
      entry.items.push(tx);
      if (tx.currency === primaryCurrency) {
        const kind = classifyForFlow(tx);
        if (kind === 'in') entry.signedSum += tx.amount;
        else if (kind === 'out') entry.signedSum -= tx.amount;
      }
    }
    return [...groups.values()];
  }, [filtered, primaryCurrency]);

  const today = new Date();
  const yesterday = subDays(today, 1);
  const formatDayLabel = (d: Date) => {
    if (isSameDay(d, today)) return `Today · ${format(d, 'EEE d MMM')}`;
    if (isSameDay(d, yesterday)) return `Yesterday · ${format(d, 'EEE d MMM')}`;
    return format(d, 'EEE d MMM');
  };

  const filtersActive = filter !== 'all' || timeFilter !== 'all' || search.trim().length > 0;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('txpage_title')}
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Search"
              >
                <Search size={15} className="text-white" />
              </button>
              <button
                onClick={() => setShowAdd(true)}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[12px] font-semibold text-white transition-colors"
                aria-label="Add"
              >
                <Plus size={13} strokeWidth={2.4} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            This month · {primaryCurrency}
          </p>
          <div className="mt-1.5 flex items-end justify-between gap-3">
            <MoneyDisplay
              amount={monthFlow.net}
              currency={primaryCurrency}
              size={36}
              tone="on-navy"
            />
            {monthFlow.inflow > 0 && (
              <span
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full tabular-nums shrink-0"
                style={{
                  background: 'rgba(15,157,123,0.18)',
                  color: '#7CE3B6',
                }}
              >
                +{formatMoney(monthFlow.inflow, primaryCurrency)} in
              </span>
            )}
          </div>
          <p className="text-[11px] text-white/50 mt-2 tabular-nums">
            {monthFlow.outflow > 0
              ? `−${formatMoney(monthFlow.outflow, primaryCurrency)} out`
              : 'No outflow yet'}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {showSearch && (
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('search_placeholder')}
              className="w-full bg-cream-card border border-cream-border rounded-2xl pl-10 pr-10 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              autoFocus
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-400 active:scale-90"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Type filter pills — Sukoon's segmented look */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
          {typeFilters.map((item) => {
            const isActive = filter === item.value;
            return (
              <button
                key={item.value}
                onClick={() => setFilter(item.value)}
                className={`shrink-0 px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-ink-900 text-white'
                    : 'bg-cream-card text-ink-500 border border-cream-border'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Time filter sub-pills */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
          {timeFilterOptions.map((item) => {
            const isActive = timeFilter === item.value;
            return (
              <button
                key={item.value}
                onClick={() => setTimeFilter(item.value)}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-[10.5px] font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-ink-800 text-white'
                    : 'bg-cream-soft text-ink-500 border border-cream-hairline'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {filtersActive && (
          <p className="text-[10.5px] text-ink-500 font-semibold">
            {filtered.length} {t('time_results')}
          </p>
        )}

        {/* Day-grouped list */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title={t('empty_tx_title')}
            description={t('empty_tx_desc')}
            actionLabel={t('empty_tx_cta')}
            onAction={() => setShowAdd(true)}
          />
        ) : (
          <div className="space-y-4">
            {dayGroups.map((group) => (
              <div key={group.date.toISOString()}>
                <div className="flex items-baseline justify-between px-1 mb-1.5">
                  <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    {formatDayLabel(group.date)}
                  </p>
                  {group.signedSum !== 0 && (
                    <p
                      className={`text-[11.5px] font-semibold tabular-nums ${
                        group.signedSum > 0 ? 'text-receive-text' : 'text-pay-text'
                      }`}
                    >
                      {group.signedSum > 0 ? '+' : '−'}
                      {formatMoney(Math.abs(group.signedSum), primaryCurrency)}
                    </p>
                  )}
                </div>
                <div className="rounded-[18px] bg-cream-card border border-cream-border px-4 divide-y divide-cream-hairline">
                  {group.items.map((txn) =>
                    ['expense', 'loan_given', 'loan_taken'].includes(txn.type) &&
                    !isGroupLinkedNote(txn.notes) ? (
                      <TransactionItem
                        key={txn.id}
                        transaction={txn}
                        onClick={() => setSelectedTransaction(txn)}
                      />
                    ) : (
                      <TransactionItem key={txn.id} transaction={txn} />
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

      <QuickEntry open={showAdd} onClose={() => setShowAdd(false)} />
      <EditTransactionModal
        open={!!selectedTransaction}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
    </main>
  );
}
