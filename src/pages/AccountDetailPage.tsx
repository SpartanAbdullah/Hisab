import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { Wallet, Building2, Smartphone, PiggyBank, CreditCard, Plus, ArrowLeftRight, AlertTriangle, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { QuickEntry } from './QuickEntry';
import { useToast } from '../components/Toast';
import { startOfDay, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, subWeeks, subMonths, subYears, isWithinInterval, differenceInDays } from 'date-fns';
import type { Transaction } from '../db';
import { isGroupLinkedNote } from '../lib/internalNotes';

type TimeFilter = 'all' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'last_year';

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
  return txns.filter(tx => {
    const d = new Date(tx.createdAt);
    return isWithinInterval(d, { start, end });
  });
}

const iconMap: Record<string, React.ElementType> = {
  cash: Wallet, bank: Building2, digital_wallet: Smartphone, savings: PiggyBank, credit_card: CreditCard,
};
const gradientMap: Record<string, string> = {
  cash: 'from-[#1a6b3c] via-[#228B50] to-[#2d9b5a]',
  bank: 'from-[#1e3a5f] via-[#24517a] to-[#2d6a9f]',
  digital_wallet: 'from-[#5b2d8e] via-[#7438b5] to-[#8e44d4]',
  savings: 'from-[#b8860b] via-[#c99a1d] to-[#daa520]',
  credit_card: 'from-[#1a1a2e] via-[#16213e] to-[#1a1a2e]',
};
const typeLabelMap: Record<string, string> = {
  cash: 'CASH', bank: 'BANK', digital_wallet: 'DIGITAL WALLET', savings: 'SAVINGS', credit_card: 'CREDIT CARD',
};

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { accounts, loadAccounts, renameAccount, deleteAccount } = useAccountStore();
  const { transactions, loadTransactions, getByAccount } = useTransactionStore();
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

  useEffect(() => { loadAccounts(); loadTransactions(); loadExpenses(); }, [loadAccounts, loadTransactions, loadExpenses]);

  const account = accounts.find(a => a.id === id);
  if (!account) return <div className="p-4 text-center text-slate-400">Account nahi mila</div>;

  const accountTxns = getByAccount(account.id);
  const Icon = iconMap[account.type] ?? Wallet;
  const gradient = gradientMap[account.type] ?? gradientMap.cash;
  const meta = currencyMeta[account.currency];
  const isCreditCard = account.type === 'credit_card';
  const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
  const used = isCreditCard ? creditLimit - account.balance : 0;

  // Upcoming expenses for this account
  const accountUpcoming = expenses.filter(e => e.accountId === account.id && e.status === 'upcoming');
  const totalUpcoming = accountUpcoming.reduce((s, e) => s + e.amount, 0);
  const hasWarning = totalUpcoming > account.balance;

  void transactions;

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
    <div className="page-shell">
      <PageHeader title={account.name} back
        action={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={() => setShowAdd(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5">
              <Plus size={13} strokeWidth={2.5} /> Transaction
            </button>
            <div className="relative">
              <button onClick={() => setShowMenu(!showMenu)} className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors">
                <MoreVertical size={16} className="text-slate-500" />
              </button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <div className="absolute right-0 top-10 z-50 bg-white rounded-2xl shadow-xl shadow-slate-900/10 border border-slate-100/60 py-1.5 w-44 animate-fade-in">
                    <button onClick={() => { setShowMenu(false); setNewName(account.name); setShowRename(true); }}
                      className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-slate-700 active:bg-slate-50">
                      <Pencil size={14} className="text-slate-400" /> Rename
                    </button>
                    <button onClick={async () => {
                      setShowMenu(false);
                      if (account.balance !== 0) {
                        toast.show({ type: 'error', title: t('acct_delete_nonzero'), subtitle: t('acct_delete_nonzero_desc') });
                        return;
                      }
                      if (confirm(t('acct_delete_confirm'))) {
                        try {
                          await deleteAccount(account.id);
                          toast.show({ type: 'success', title: t('acct_deleted') });
                          navigate('/');
                        } catch (err) {
                          toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
                        }
                      }
                    }}
                      className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-red-500 active:bg-red-50">
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        }
      />

      {/* Rename Modal */}
      {showRename && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowRename(false)}>
          <div className="bg-white rounded-2xl p-5 w-[90%] max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] font-bold text-slate-800 mb-3">Rename Account</h3>
            <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
              className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all mb-3" />
            <div className="flex gap-2">
              <button onClick={() => setShowRename(false)} className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-500 text-[12px] font-bold">Cancel</button>
              <button onClick={async () => {
                if (newName.trim() && newName.trim() !== account.name) {
                  await renameAccount(account.id, newName.trim());
                  toast.show({ type: 'success', title: 'Account renamed!' });
                }
                setShowRename(false);
              }} className="flex-1 py-2.5 rounded-xl btn-gradient text-[12px] font-bold">Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="px-5 pt-5">
        <div className="relative overflow-hidden rounded-3xl p-6 text-white text-center animate-scale-in">
          <div className={`absolute inset-0 bg-gradient-to-br ${gradient}`} />
          <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(circle at 70% 30%, rgba(255,255,255,0.3), transparent 60%)' }} />
          <div className="relative">
            <div className="w-16 h-16 rounded-3xl bg-white/15 flex items-center justify-center mx-auto mb-4 backdrop-blur-sm">
              <Icon size={28} strokeWidth={1.5} />
            </div>
            <p className="text-[9px] font-bold text-white/50 uppercase tracking-[0.15em]">
              {typeLabelMap[account.type] ?? account.type.replace('_', ' ')}
            </p>
            <p className="text-[11px] uppercase tracking-widest opacity-70 flex items-center gap-1 justify-center mt-1">
              <span>{meta?.flag}</span> {account.currency}
            </p>

            {isCreditCard ? (
              <>
                <p className="text-3xl font-bold mt-2 tabular-nums tracking-tighter animate-count-up">{formatSignedMoney(account.balance, account.currency)}</p>
                <p className="text-[11px] opacity-60 mt-1">{t('cc_available')}</p>

                {/* Credit card usage bar */}
                <div className="mt-4 bg-white/20 rounded-full h-2.5 overflow-hidden">
                  <div className="bg-white h-full rounded-full transition-all duration-700" style={{ width: `${creditLimit > 0 ? (used / creditLimit) * 100 : 0}%` }} />
                </div>
                <div className="flex justify-between mt-2 text-[11px]">
                  <span className="opacity-70">{t('cc_used')}: {formatMoney(used, account.currency)}</span>
                  <span className="font-semibold">{t('cc_limit')}: {formatMoney(creditLimit, account.currency)}</span>
                </div>

                {account.metadata.dueDay && (
                  <div className="mt-3 bg-amber-400/20 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold backdrop-blur-sm">
                    {t('cc_next_due')}: {account.metadata.dueDay}{getOrdinal(parseInt(account.metadata.dueDay))} of month
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-3xl font-bold mt-2 tabular-nums tracking-tighter animate-count-up">{formatSignedMoney(account.balance, account.currency)}</p>
                {account.metadata.bankName && <p className="text-[11px] opacity-50 mt-2">{account.metadata.bankName}</p>}
                {account.metadata.walletType && <p className="text-[11px] opacity-50 mt-2 capitalize">{account.metadata.walletType}</p>}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Opening balance prompt for new accounts */}
      {showOpeningBalancePrompt && (
        <div className="px-5 pt-4 animate-fade-in">
          <div className="rounded-2xl p-5 bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-100/60 text-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto mb-3">
              <Wallet size={20} className="text-indigo-500" />
            </div>
            <p className="text-[13px] font-bold text-slate-700 mb-1">{t('acct_opening_bal_prompt')}</p>
            <button onClick={() => setShowOpeningBalance(true)}
              className="btn-gradient rounded-2xl px-6 py-3 text-[12px] font-bold shadow-md shadow-indigo-500/20">
              {t('acct_add_opening_bal')}
            </button>
          </div>
        </div>
      )}

      {/* Upcoming expense warning for this account */}
      {accountUpcoming.length > 0 && (
        <div className="px-5 pt-4">
          <div className={`rounded-2xl p-4 border ${hasWarning ? 'bg-red-50/50 border-red-100/60' : 'bg-amber-50/50 border-amber-100/60'}`}>
            <div className="flex items-center gap-2.5">
              <AlertTriangle size={16} className={hasWarning ? 'text-red-500' : 'text-amber-500'} />
              <div className="flex-1">
                <p className={`text-[11px] font-bold ${hasWarning ? 'text-red-600' : 'text-amber-600'}`}>
                  {accountUpcoming.length} {t('upcoming_title')}
                </p>
                <p className="text-[10px] text-slate-400">
                  Total: {formatMoney(totalUpcoming, account.currency)}
                  {hasWarning && ` — ${t('upcoming_low_balance')}!`}
                </p>
              </div>
            </div>
            <div className="mt-2.5 space-y-1.5">
              {accountUpcoming.slice(0, 3).map(e => {
                const daysLeft = differenceInDays(new Date(e.dueDate), new Date());
                return (
                  <div key={e.id} className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-600 font-medium">{e.title}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-700 font-bold tabular-nums">{formatMoney(e.amount, e.currency)}</span>
                      <span className={`text-[9px] font-bold ${daysLeft < 0 ? 'text-red-500' : daysLeft <= 3 ? 'text-amber-500' : 'text-slate-400'}`}>
                        {daysLeft < 0 ? t('upcoming_overdue') : daysLeft === 0 ? t('upcoming_due_today') : `${daysLeft} ${t('upcoming_due_in')}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Time filters */}
      <div className="px-5 pt-5 flex gap-2 overflow-x-auto no-scrollbar">
        {TIME_FILTERS.map(f => (
          <button key={f.value} onClick={() => setTimeFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold whitespace-nowrap border transition-all active:scale-95 ${
              timeFilter === f.value ? 'bg-slate-800 text-white border-slate-800 shadow-sm' : 'bg-slate-50 text-slate-400 border-slate-100/60'
            }`}
          >{f.label}</button>
        ))}
      </div>

      {timeFilter !== 'all' && (
        <div className="px-5 pt-1.5">
          <p className="text-[10px] text-slate-400 font-semibold">{filteredTxns.length} {t('time_results')}</p>
        </div>
      )}

      <div className="px-5 pt-3">
        <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('tx_history')}</h2>
        {filteredTxns.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title={t('no_tx')} description={t('no_tx_desc')} actionLabel={t('txpage_add')} onAction={() => setShowAdd(true)} />
        ) : (
          <div className="card-premium px-4 divide-y divide-slate-100/60">
            {filteredTxns.map((txn, i) => (
              <div key={txn.id} className="animate-fade-in" style={{ animationDelay: `${i * 40}ms` }}>
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
      <Modal open={showOpeningBalance} onClose={closeOpeningBalance} title={t('acct_opening_title')}
        footer={
          <button onClick={saveOpeningBalance} disabled={savingOpeningBalance || !parseFloat(openingAmount) || !openingDate}
            className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 transition-all">
            {savingOpeningBalance ? t('quick_processing') : t('acct_opening_save')}
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] text-slate-500 leading-relaxed">{t('acct_opening_help')}</p>
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('acct_opening_amount')}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingAmount}
              onChange={e => setOpeningAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              className="w-full border border-slate-200/60 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('acct_opening_date')}</label>
            <input
              type="date"
              value={openingDate}
              onChange={e => setOpeningDate(e.target.value)}
              className="w-full border border-slate-200/60 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('quick_note')}</label>
            <input
              value={openingNote}
              onChange={e => setOpeningNote(e.target.value)}
              placeholder={t('acct_opening_note_placeholder')}
              className="w-full border border-slate-200/60 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all"
            />
          </div>
        </div>
      </Modal>
      <EditTransactionModal open={!!selectedTransaction} transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </div>
  );
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
