import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowLeftRight, Search, X } from 'lucide-react';
import { startOfDay, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, subWeeks, subMonths, subYears, isWithinInterval } from 'date-fns';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { QuickEntry } from './QuickEntry';
import { useT } from '../lib/i18n';
import { isGroupLinkedNote, parseInternalNote } from '../lib/internalNotes';
import type { TransactionType, Transaction } from '../db';

type TimeFilter = 'all' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'last_year';

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

  return txns.filter(txn => isWithinInterval(new Date(txn.createdAt), { start, end }));
}

export function TransactionsPage() {
  const { transactions, loadTransactions } = useTransactionStore();
  const { loadAccounts } = useAccountStore();
  const { loadLoans } = useLoanStore();
  const { loadGoals } = useGoalStore();
  const t = useT();

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

  const timeFilters: { label: string; value: TimeFilter }[] = [
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

  const filtered = useMemo(() => {
    let result = filter === 'all'
      ? transactions
      : filter === 'loan_given'
        ? transactions.filter(txn => txn.type === 'loan_given' || txn.type === 'loan_taken' || txn.type === 'repayment')
        : transactions.filter(txn => txn.type === filter);

    result = filterByTime(result, timeFilter);

    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(txn => (
        parseInternalNote(txn.notes).visibleNote.toLowerCase().includes(query) ||
        (txn.category?.toLowerCase().includes(query)) ||
        ((txn.relatedPerson ?? '').toLowerCase().includes(query)) ||
        (txn.amount?.toString().includes(query))
      ));
    }

    return result;
  }, [transactions, filter, timeFilter, search]);

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader
        title={t('txpage_title')}
        action={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={() => setShowSearch(!showSearch)} className="bg-slate-100 text-slate-500 rounded-xl p-2 text-xs font-semibold flex items-center active:scale-95 transition-all">
              <Search size={14} strokeWidth={2.5} />
            </button>
            <button onClick={() => setShowAdd(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5">
              <Plus size={13} strokeWidth={2.5} /> {t('naya')}
            </button>
          </div>
        }
      />

      {showSearch && (
        <div className="px-5 pt-4 animate-fade-in">
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('search_placeholder')}
              className="w-full bg-white border border-slate-200/60 rounded-2xl pl-10 pr-10 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
              autoFocus
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-300 active:scale-90">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="px-5 pt-4 flex gap-2 overflow-x-auto no-scrollbar">
        {typeFilters.map(item => (
          <button key={item.value} onClick={() => setFilter(item.value)}
            className={`px-4 py-2 rounded-xl text-[11px] font-bold whitespace-nowrap border-2 transition-all active:scale-95 ${
              filter === item.value ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/20' : 'bg-white text-slate-500 border-slate-200/60'
            }`}
          >{item.label}</button>
        ))}
      </div>

      <div className="px-5 pt-2.5 flex gap-2 overflow-x-auto no-scrollbar">
        {timeFilters.map(item => (
          <button key={item.value} onClick={() => setTimeFilter(item.value)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold whitespace-nowrap border transition-all active:scale-95 ${
              timeFilter === item.value ? 'bg-slate-800 text-white border-slate-800 shadow-sm' : 'bg-slate-50 text-slate-400 border-slate-100/60'
            }`}
          >{item.label}</button>
        ))}
      </div>

      {(filter !== 'all' || timeFilter !== 'all' || search.trim()) && (
        <div className="px-5 pt-2">
          <p className="text-[10px] text-slate-400 font-semibold">{filtered.length} {t('time_results')}</p>
        </div>
      )}

      <div className="px-5 pt-3">
        {filtered.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title={t('empty_tx_title')} description={t('empty_tx_desc')} actionLabel={t('empty_tx_cta')} onAction={() => setShowAdd(true)} />
        ) : (
          <div className="card-premium px-4 divide-y divide-slate-100/60">
            {filtered.map((txn, index) => (
              <div key={txn.id} className="animate-fade-in" style={{ animationDelay: `${index * 25}ms` }}>
                {['expense', 'loan_given', 'loan_taken'].includes(txn.type) && !isGroupLinkedNote(txn.notes) ? (
                  <button type="button" onClick={() => setSelectedTransaction(txn)} className="w-full text-left active:opacity-80 transition-opacity">
                    <TransactionItem transaction={txn} />
                  </button>
                ) : (
                  <TransactionItem transaction={txn} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <QuickEntry open={showAdd} onClose={() => setShowAdd(false)} />
      <EditTransactionModal open={!!selectedTransaction} transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </div>
  );
}
