import { useEffect, useState } from 'react';
import { Plus, ChevronRight, Users, HandCoins, Handshake } from 'lucide-react';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { ProgressRing } from '../components/ProgressRing';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { AddLoanModal } from './AddLoanModal';
import { useNavigate } from 'react-router-dom';
import type { Currency } from '../db';

export function LoansPage() {
  const { loans, loadLoans } = useLoanStore();
  const { loadSchedules } = useEmiStore();
  const { loadTransactions } = useTransactionStore();
  const { loadAccounts } = useAccountStore();
  const navigate = useNavigate();
  const t = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<'active' | 'settled'>('active');

  useEffect(() => { loadLoans(); loadSchedules(); loadTransactions(); loadAccounts(); }, [loadLoans, loadSchedules, loadTransactions, loadAccounts]);

  const filtered = loans.filter(l => l.status === tab);
  const receivables = filtered.filter(l => l.type === 'given');
  const payables = filtered.filter(l => l.type === 'taken');

  // Aggregate per currency so AED and PKR totals never merge. For each
  // currency we track both `remaining` (what's still open) and `total` (the
  // original amount) — the ring visualises collection progress:
  // collected = (total − remaining) / total.
  type Aggregate = { remaining: number; total: number; count: number };
  const aggregateByCurrency = (items: typeof loans): Record<string, Aggregate> =>
    items.reduce((acc, l) => {
      const bucket = acc[l.currency] ?? { remaining: 0, total: 0, count: 0 };
      bucket.remaining += l.remainingAmount;
      bucket.total += l.totalAmount;
      bucket.count += 1;
      acc[l.currency] = bucket;
      return acc;
    }, {} as Record<string, Aggregate>);

  const receivableAgg = aggregateByCurrency(receivables);
  const payableAgg = aggregateByCurrency(payables);
  const receivableEntries = Object.entries(receivableAgg).filter(([, a]) => a.remaining > 0);
  const payableEntries = Object.entries(payableAgg).filter(([, a]) => a.remaining > 0);
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  const renderLoanCard = (l: typeof loans[0], i: number) => {
    const isGiven = l.type === 'given';
    const progress = ((l.totalAmount - l.remainingAmount) / l.totalAmount) * 100;
    return (
      <button key={l.id} onClick={() => navigate(`/loan/${l.id}`)}
        className="w-full card-premium p-4 flex items-center gap-3.5 text-left animate-fade-in"
        style={{ animationDelay: `${i * 60}ms` }}
      >
        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-bold shrink-0 ${
          isGiven ? 'bg-gradient-to-br from-emerald-50 to-emerald-100/50 text-emerald-600' : 'bg-gradient-to-br from-red-50 to-red-100/50 text-red-500'
        }`}>
          {l.personName[0].toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[13px] text-slate-800 tracking-tight">{l.personName}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isGiven ? 'bg-emerald-100' : 'bg-red-100'}`}>
              <div className={`h-full rounded-full transition-all duration-700 ${isGiven ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${progress}%` }} />
            </div>
            <span className="text-[10px] text-slate-400 font-medium tabular-nums">{Math.round(progress)}%</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">{t('loan_remaining')}: {formatMoney(l.remainingAmount, l.currency)}</p>
        </div>
        <ChevronRight size={16} className="text-slate-300 shrink-0" />
      </button>
    );
  };

  return (
    <div className="page-shell">
      <PageHeader title={t('loans_title')}
        action={<div className="flex items-center gap-2"><LanguageToggle /><button onClick={() => setShowAdd(true)} className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5"><Plus size={13} strokeWidth={2.5} /> {t('naya')}</button></div>}
      />

      {/* Summary — one clean card per currency per side. Ring shows collection
          progress (for receivables) or repayment progress (for payables). */}
      {tab === 'active' && (hasReceivables || hasPayables) && (
        <div className="px-5 pt-5 space-y-2.5">
          {receivableEntries.map(([cur, agg]) => {
            const progress = agg.total > 0 ? (agg.total - agg.remaining) / agg.total : 0;
            const pct = Math.round(progress * 100);
            return (
              <div key={`recv-${cur}`} className="card-premium p-4 flex items-center gap-4 animate-scale-in">
                <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                  <HandCoins size={16} className="text-emerald-600" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">
                    {t('loan_receivable')} · {cur}
                  </p>
                  <p className="text-[22px] font-extrabold text-slate-800 tabular-nums tracking-tight mt-0.5 leading-tight">
                    {formatMoney(agg.remaining, cur as Currency)}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {formatMoney(agg.total - agg.remaining, cur as Currency)} of {formatMoney(agg.total, cur as Currency)} received
                    <span className="mx-1.5">·</span>{agg.count} {agg.count === 1 ? 'loan' : 'loans'}
                  </p>
                </div>
                <ProgressRing size={52} strokeWidth={5} progress={progress} color="#10b981" trackColor="#ecfdf5">
                  <span className="text-[10px] font-extrabold tabular-nums text-emerald-600">{pct}%</span>
                </ProgressRing>
              </div>
            );
          })}
          {payableEntries.map(([cur, agg]) => {
            const progress = agg.total > 0 ? (agg.total - agg.remaining) / agg.total : 0;
            const pct = Math.round(progress * 100);
            return (
              <div key={`pay-${cur}`} className="card-premium p-4 flex items-center gap-4 animate-scale-in">
                <div className="w-9 h-9 rounded-xl bg-rose-50 flex items-center justify-center shrink-0">
                  <Handshake size={16} className="text-rose-500" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">
                    {t('loan_payable')} · {cur}
                  </p>
                  <p className="text-[22px] font-extrabold text-slate-800 tabular-nums tracking-tight mt-0.5 leading-tight">
                    {formatMoney(agg.remaining, cur as Currency)}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {formatMoney(agg.total - agg.remaining, cur as Currency)} of {formatMoney(agg.total, cur as Currency)} paid
                    <span className="mx-1.5">·</span>{agg.count} {agg.count === 1 ? 'loan' : 'loans'}
                  </p>
                </div>
                <ProgressRing size={52} strokeWidth={5} progress={progress} color="#f43f5e" trackColor="#fff1f2">
                  <span className="text-[10px] font-extrabold tabular-nums text-rose-500">{pct}%</span>
                </ProgressRing>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabs */}
      <div className="px-5 pt-4 flex gap-2">
        {(['active', 'settled'] as const).map(tb => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`px-5 py-2 rounded-xl text-[11px] font-bold border-2 capitalize transition-all active:scale-95 ${
              tab === tb ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/20' : 'bg-white text-slate-500 border-slate-200/60'
            }`}
          >{tb === 'active' ? t('loan_tab_active') : t('loan_tab_settled')}</button>
        ))}
      </div>

      {receivables.length > 0 && (
        <div className="px-5 pt-5">
          <h2 className="text-[11px] font-bold text-emerald-600 uppercase tracking-widest mb-3 flex items-center gap-1.5"><HandCoins size={11} /> {t('loan_people_owe')}</h2>
          <div className="space-y-2.5">{receivables.map(renderLoanCard)}</div>
        </div>
      )}
      {payables.length > 0 && (
        <div className="px-5 pt-5">
          <h2 className="text-[11px] font-bold text-red-500 uppercase tracking-widest mb-3 flex items-center gap-1.5"><Handshake size={11} /> {t('loan_you_owe')}</h2>
          <div className="space-y-2.5">{payables.map(renderLoanCard)}</div>
        </div>
      )}
      {filtered.length === 0 && (
        <EmptyState icon={Users} title={tab === 'active' ? t('empty_loans_title') : t('loan_none_settled')} description={tab === 'active' ? t('empty_loans_desc') : t('loan_desc_settled')} actionLabel={tab === 'active' ? t('empty_loans_cta') : undefined} onAction={tab === 'active' ? () => setShowAdd(true) : undefined} />
      )}

      <AddLoanModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}
