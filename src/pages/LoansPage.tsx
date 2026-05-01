import { useEffect, useState } from 'react';
import { Plus, ChevronRight, Users, HandCoins, Handshake } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { ProgressRing } from '../components/ProgressRing';
import { Modal } from '../components/Modal';
import { TransactionItem } from '../components/TransactionItem';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { AddLoanModal } from './AddLoanModal';
import type { Currency, Loan } from '../db';

type LoanDirection = 'given' | 'taken';

type LoanAggregate = {
  remaining: number;
  total: number;
  count: number;
};

type LoanGroup = LoanAggregate & {
  key: string;
  name: string;
  currency: Currency;
  direction: LoanDirection;
  loans: Loan[];
};

export function LoansPage() {
  const { loans, loadLoans } = useLoanStore();
  const { loadSchedules } = useEmiStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loadAccounts } = useAccountStore();
  const navigate = useNavigate();
  const t = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<'active' | 'settled'>('active');
  const [selectedGroup, setSelectedGroup] = useState<LoanGroup | null>(null);

  useEffect(() => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  }, [loadAccounts, loadLoans, loadSchedules, loadTransactions]);

  const filtered = loans.filter((loan) => loan.status === tab);
  const receivables = filtered.filter((loan) => loan.type === 'given');
  const payables = filtered.filter((loan) => loan.type === 'taken');

  const aggregateByCurrency = (items: Loan[]): Record<string, LoanAggregate> =>
    items.reduce((acc, loan) => {
      const bucket = acc[loan.currency] ?? { remaining: 0, total: 0, count: 0 };
      bucket.remaining += loan.remainingAmount;
      bucket.total += loan.totalAmount;
      bucket.count += 1;
      acc[loan.currency] = bucket;
      return acc;
    }, {} as Record<string, LoanAggregate>);

  const aggregateByPerson = (items: Loan[], direction: LoanDirection): LoanGroup[] => {
    const buckets = new Map<string, LoanGroup>();
    for (const loan of items) {
      const personKey = loan.personId ?? loan.personName.trim().toLowerCase();
      const key = `${direction}:${loan.currency}:${personKey}`;
      const bucket = buckets.get(key) ?? {
        key,
        name: loan.personName,
        currency: loan.currency,
        direction,
        remaining: 0,
        total: 0,
        count: 0,
        loans: [],
      };
      bucket.remaining += loan.remainingAmount;
      bucket.total += loan.totalAmount;
      bucket.count += 1;
      bucket.loans.push(loan);
      buckets.set(key, bucket);
    }
    return Array.from(buckets.values())
      .filter((group) => (tab === 'active' ? group.remaining > 0 : group.count > 0))
      .sort((a, b) => (tab === 'active' ? b.remaining - a.remaining : b.total - a.total));
  };

  const receivableAgg = aggregateByCurrency(receivables);
  const payableAgg = aggregateByCurrency(payables);
  const receivableEntries = Object.entries(receivableAgg).filter(([, aggregate]) => aggregate.remaining > 0);
  const payableEntries = Object.entries(payableAgg).filter(([, aggregate]) => aggregate.remaining > 0);
  const receivableGroups = aggregateByPerson(receivables, 'given');
  const payableGroups = aggregateByPerson(payables, 'taken');
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  const selectedLoanIds = new Set(selectedGroup?.loans.map((loan) => loan.id) ?? []);
  const selectedTransactions = transactions
    .filter((transaction) => transaction.relatedLoanId && selectedLoanIds.has(transaction.relatedLoanId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const renderSummaryCard = (direction: LoanDirection, currency: string, aggregate: LoanAggregate) => {
    const isGiven = direction === 'given';
    const progress = aggregate.total > 0 ? (aggregate.total - aggregate.remaining) / aggregate.total : 0;
    const pct = Math.round(progress * 100);
    return (
      <div key={`${direction}-${currency}`} className="card-premium p-4 flex items-center gap-4 animate-scale-in">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isGiven ? 'bg-emerald-50' : 'bg-rose-50'}`}>
          {isGiven ? (
            <HandCoins size={16} className="text-emerald-600" strokeWidth={2} />
          ) : (
            <Handshake size={16} className="text-rose-500" strokeWidth={2} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-[10px] font-bold uppercase tracking-widest ${isGiven ? 'text-emerald-600' : 'text-rose-500'}`}>
            {isGiven ? t('loan_receivable') : t('loan_payable')} - {currency}
          </p>
          <p className="text-[22px] font-extrabold text-slate-800 tabular-nums tracking-tight mt-0.5 leading-tight">
            {formatMoney(aggregate.remaining, currency)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {formatMoney(aggregate.total - aggregate.remaining, currency)} of {formatMoney(aggregate.total, currency)} {isGiven ? 'received' : 'paid'}
            <span className="mx-1.5">-</span>{aggregate.count} {aggregate.count === 1 ? 'loan' : 'loans'}
          </p>
        </div>
        <ProgressRing size={52} strokeWidth={5} progress={progress} color={isGiven ? '#10b981' : '#f43f5e'} trackColor={isGiven ? '#ecfdf5' : '#fff1f2'}>
          <span className={`text-[10px] font-extrabold tabular-nums ${isGiven ? 'text-emerald-600' : 'text-rose-500'}`}>{pct}%</span>
        </ProgressRing>
      </div>
    );
  };

  const renderGroupCard = (group: LoanGroup, index: number) => {
    const isGiven = group.direction === 'given';
    const settledAmount = group.total - group.remaining;
    const progress = group.total > 0 ? settledAmount / group.total : 0;
    const primaryAmount = tab === 'active' ? group.remaining : group.total;
    return (
      <button
        key={group.key}
        onClick={() => setSelectedGroup(group)}
        className="w-full card-premium p-4 flex items-center gap-3.5 text-left animate-fade-in active:scale-[0.99]"
        style={{ animationDelay: `${index * 40}ms` }}
      >
        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-bold shrink-0 ${
          isGiven ? 'bg-gradient-to-br from-emerald-50 to-emerald-100/50 text-emerald-600' : 'bg-gradient-to-br from-red-50 to-red-100/50 text-red-500'
        }`}>
          {group.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-[13px] text-slate-800 tracking-tight truncate">{group.name}</p>
              <p className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${isGiven ? 'text-emerald-600' : 'text-red-500'}`}>
                {isGiven ? t('loan_receivable') : t('loan_payable')} - {group.currency}
              </p>
            </div>
            <p className={`text-[13px] font-extrabold tabular-nums shrink-0 ${isGiven ? 'text-emerald-600' : 'text-red-500'}`}>
              {formatMoney(primaryAmount, group.currency)}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isGiven ? 'bg-emerald-100' : 'bg-red-100'}`}>
              <div className={`h-full rounded-full transition-all duration-700 ${isGiven ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="text-[10px] text-slate-400 font-medium tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {formatMoney(settledAmount, group.currency)} {isGiven ? 'received' : 'paid'}
            <span className="mx-1.5">-</span>{group.count} {group.count === 1 ? 'loan' : 'loans'}
          </p>
        </div>
        <ChevronRight size={16} className="text-slate-300 shrink-0" />
      </button>
    );
  };

  return (
    <div className="page-shell">
      <PageHeader
        title={t('loans_title')}
        action={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button onClick={() => setShowAdd(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5">
              <Plus size={13} strokeWidth={2.5} /> {t('naya')}
            </button>
          </div>
        }
      />

      {tab === 'active' && (hasReceivables || hasPayables) ? (
        <div className="px-5 pt-5 space-y-2.5">
          {receivableEntries.map(([currency, aggregate]) => renderSummaryCard('given', currency, aggregate))}
          {payableEntries.map(([currency, aggregate]) => renderSummaryCard('taken', currency, aggregate))}
        </div>
      ) : null}

      <div className="px-5 pt-4 flex gap-2">
        {(['active', 'settled'] as const).map((nextTab) => (
          <button
            key={nextTab}
            onClick={() => {
              setTab(nextTab);
              setSelectedGroup(null);
            }}
            className={`px-5 py-2 rounded-xl text-[11px] font-bold border-2 capitalize transition-all active:scale-95 ${
              tab === nextTab ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/20' : 'bg-white text-slate-500 border-slate-200/60'
            }`}
          >
            {nextTab === 'active' ? t('loan_tab_active') : t('loan_tab_settled')}
          </button>
        ))}
      </div>

      {receivableGroups.length > 0 ? (
        <div className="px-5 pt-4">
          <h2 className="text-[11px] font-bold text-emerald-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <HandCoins size={11} /> {tab === 'active' ? 'Receivable by person' : 'Settled receivables'}
          </h2>
          <div className="space-y-2.5">{receivableGroups.map(renderGroupCard)}</div>
        </div>
      ) : null}

      {payableGroups.length > 0 ? (
        <div className="px-5 pt-4">
          <h2 className="text-[11px] font-bold text-red-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Handshake size={11} /> {tab === 'active' ? 'Payable by person' : 'Settled payables'}
          </h2>
          <div className="space-y-2.5">{payableGroups.map(renderGroupCard)}</div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={tab === 'active' ? t('empty_loans_title') : t('loan_none_settled')}
          description={tab === 'active' ? t('empty_loans_desc') : t('loan_desc_settled')}
          actionLabel={tab === 'active' ? t('empty_loans_cta') : undefined}
          onAction={tab === 'active' ? () => setShowAdd(true) : undefined}
        />
      ) : null}

      <Modal open={!!selectedGroup} onClose={() => setSelectedGroup(null)} title={selectedGroup?.name ?? ''}>
        {selectedGroup ? (
          <div className="space-y-5">
            <LoanGroupSummary group={selectedGroup} tab={tab} />

            <div>
              <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">Individual loans</h3>
              <div className="space-y-2">
                {selectedGroup.loans
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((loan) => (
                    <LoanDrilldownRow key={loan.id} loan={loan} onClick={() => navigate(`/loan/${loan.id}`)} />
                  ))}
              </div>
            </div>

            <div>
              <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">Activity</h3>
              {selectedTransactions.length === 0 ? (
                <p className="text-[12px] text-slate-400 text-center py-5">No transaction activity yet.</p>
              ) : (
                <div className="rounded-2xl border border-slate-100/70 bg-white px-3 divide-y divide-slate-100/70">
                  {selectedTransactions.map((transaction) => (
                    <TransactionItem key={transaction.id} transaction={transaction} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      <AddLoanModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}

function LoanGroupSummary({ group, tab }: { group: LoanGroup; tab: 'active' | 'settled' }) {
  const t = useT();
  const isGiven = group.direction === 'given';
  const settledAmount = group.total - group.remaining;
  const progress = group.total > 0 ? settledAmount / group.total : 0;
  const primaryAmount = tab === 'active' ? group.remaining : group.total;
  return (
    <div className={`rounded-2xl p-4 border ${isGiven ? 'bg-emerald-50/60 border-emerald-100/70' : 'bg-red-50/60 border-red-100/70'}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest ${isGiven ? 'text-emerald-600' : 'text-red-500'}`}>
        {isGiven ? t('loan_receivable') : t('loan_payable')} - {group.currency}
      </p>
      <p className="text-2xl font-extrabold text-slate-800 tabular-nums tracking-tight mt-1">
        {formatMoney(primaryAmount, group.currency)}
      </p>
      <p className="text-[11px] text-slate-500 mt-1">
        {formatMoney(settledAmount, group.currency)} {isGiven ? 'received' : 'paid'} of {formatMoney(group.total, group.currency)}
      </p>
      <div className={`mt-3 h-2 rounded-full overflow-hidden ${isGiven ? 'bg-emerald-100' : 'bg-red-100'}`}>
        <div className={`h-full rounded-full ${isGiven ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}

function LoanDrilldownRow({ loan, onClick }: { loan: Loan; onClick: () => void }) {
  const t = useT();
  const progress = loan.totalAmount > 0 ? (loan.totalAmount - loan.remainingAmount) / loan.totalAmount : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-slate-100/70 bg-white p-3.5 flex items-center gap-3 text-left active:bg-slate-50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-semibold text-slate-700 tabular-nums">
            {formatMoney(loan.totalAmount, loan.currency)}
          </p>
          <span className={`text-[10px] font-bold uppercase rounded-full px-2 py-1 ${loan.status === 'settled' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {loan.status}
          </span>
        </div>
        <p className="text-[10px] text-slate-400 mt-1">
          {t('loan_remaining')}: {formatMoney(loan.remainingAmount, loan.currency)}
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {loan.notes ? <p className="text-[10px] text-slate-400 italic mt-1 truncate">"{loan.notes}"</p> : null}
      </div>
      <ChevronRight size={15} className="text-slate-300 shrink-0" />
    </button>
  );
}
