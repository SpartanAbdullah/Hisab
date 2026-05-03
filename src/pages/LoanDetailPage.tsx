import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { format, isPast } from 'date-fns';
import { AlertCircle, Bell, CheckCircle, Clock, RotateCcw } from 'lucide-react';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { PageHeader } from '../components/PageHeader';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { PaymentReminderModal } from '../components/PaymentReminderModal';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { RepaymentModal } from './RepaymentModal';
import { SettleLinkedLoanModal } from './SettleLinkedLoanModal';
import { isGroupLinkedNote } from '../lib/internalNotes';
import { resolvePersonName } from '../lib/resolvePersonName';
import { getOldestIsoDate } from '../lib/paymentReminders';
import type { EmiSchedule, Transaction, SettlementRequest } from '../db';

export function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { loans, loadLoans } = useLoanStore();
  const { schedules, loadSchedules } = useEmiStore();
  const { loadTransactions, getByLoan } = useTransactionStore();
  const { loadAccounts, accounts } = useAccountStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const currentUserId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const t = useT();
  const [showRepayment, setShowRepayment] = useState(false);
  const [showSettleLinked, setShowSettleLinked] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [selectedEmi, setSelectedEmi] = useState<(EmiSchedule & { isOverdue: boolean }) | null>(null);

  useEffect(() => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  }, [loadAccounts, loadLoans, loadSchedules, loadTransactions]);

  const loan = loans.find((entry) => entry.id === id);
  if (!loan) return <div className="p-4 text-center text-slate-400">{t('loan_not_found')}</div>;

  const displayName = resolvePersonName({ personId: loan.personId, fallback: loan.personName });
  const loanTransactions = getByLoan(loan.id);

  // Phase 2C-A: detect whether this loan is the local side of a linked pair.
  // Only linked loans route through the settlement request flow.
  const linkedPair = linkedRequests.find(
    (r) => r.status === 'accepted' && (r.requesterLoanId === loan.id || r.responderLoanId === loan.id),
  ) ?? null;
  const isLinkedLoan = (() => {
    if (!loan.personId) return false;
    const p = persons.find((x) => x.id === loan.personId);
    return !!(p?.linkedProfileId) && !!linkedPair;
  })();
  // 2C-A direction rule: only the debtor (type='taken') can initiate.
  const canSettleLinked = isLinkedLoan && loan.status === 'active' && loan.type === 'taken';
  const loanPairId = linkedPair?.id ?? null;
  const settlementHistory = loanPairId
    ? settlementRequests.filter((r) => r.loanPairId === loanPairId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const emiItems = schedules
    .filter((schedule) => schedule.loanId === loan.id)
    .sort((left, right) => left.installmentNumber - right.installmentNumber);
  const progress = ((loan.totalAmount - loan.remainingAmount) / loan.totalAmount) * 100;
  const isGiven = loan.type === 'given';
  const enrichedEmis = emiItems.map((schedule) => ({
    ...schedule,
    isOverdue: schedule.status === 'upcoming' && isPast(new Date(schedule.dueDate)),
  }));
  const reminderStartedAt = getOldestIsoDate(
    enrichedEmis
      .filter((schedule) => schedule.status !== 'paid' && isPast(new Date(schedule.dueDate)))
      .map((schedule) => schedule.dueDate),
  ) ?? loan.createdAt;

  const refreshLoanDetail = () => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  };

  return (
    <div className="page-shell">
      <PageHeader
        title={displayName || loan.personName}
        back
        action={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            {loan.status === 'active' ? (
              <>
                {loan.remainingAmount > 0 ? (
                  <button
                    onClick={() => setShowReminder(true)}
                    className="bg-amber-50 text-amber-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-amber-500/5"
                  >
                    <Bell size={13} strokeWidth={2.5} /> {t('reminder_cta')}
                  </button>
                ) : null}
                {canSettleLinked ? (
                  <button
                    onClick={() => setShowSettleLinked(true)}
                    className="bg-indigo-50 text-indigo-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-indigo-500/5"
                  >
                    <RotateCcw size={13} strokeWidth={2.5} /> {t('stl_settle_cta')}
                  </button>
                ) : isLinkedLoan ? null : (
                  <button
                    onClick={() => setShowRepayment(true)}
                    className="bg-emerald-50 text-emerald-600 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-all shadow-sm shadow-emerald-500/5"
                  >
                    <RotateCcw size={13} strokeWidth={2.5} /> {t('loan_repay')}
                  </button>
                )}
              </>
            ) : null}
          </div>
        }
      />

      <div className="px-5 pt-5">
        <div className="relative overflow-hidden rounded-3xl p-6 text-white animate-scale-in">
          <div className={`absolute inset-0 bg-gradient-to-br ${isGiven ? 'from-emerald-500 via-emerald-600 to-teal-600' : 'from-red-500 via-red-600 to-rose-600'}`} />
          <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(circle at 70% 30%, rgba(255,255,255,0.3), transparent 60%)' }} />
          <div className="relative">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center text-xl font-bold backdrop-blur-sm">
                {(displayName || loan.personName || '?')[0].toUpperCase()}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-widest opacity-70">{isGiven ? t('loan_gave') : t('loan_took')}</p>
                <p className="text-2xl font-bold tabular-nums tracking-tighter">{formatMoney(loan.totalAmount, loan.currency)}</p>
              </div>
            </div>
            <div className="bg-white/20 rounded-full h-3 overflow-hidden backdrop-blur-sm">
              <div className="bg-white h-full rounded-full transition-all duration-700" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex justify-between mt-2.5 text-[11px]">
              <span className="opacity-80">{t('loan_returned')}: {formatMoney(loan.totalAmount - loan.remainingAmount, loan.currency)}</span>
              <span className="font-bold">{t('loan_remaining')}: {formatMoney(loan.remainingAmount, loan.currency)}</span>
            </div>
            {loan.status === 'settled' ? (
              <div className="mt-3 bg-white/20 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold backdrop-blur-sm">
                <CheckCircle size={12} /> {t('loan_completed')}
              </div>
            ) : null}
            {loan.notes ? <p className="mt-3 text-[11px] opacity-60 italic">"{loan.notes}"</p> : null}
          </div>
        </div>
      </div>

      {enrichedEmis.length > 0 ? (
        <div className="px-5 pt-6">
          <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">EMI Schedule</h2>
          <div className="space-y-2">
            {enrichedEmis.map((schedule) => (
              <div
                key={schedule.id}
                className={`card-premium !rounded-2xl p-4 flex items-center gap-3 ${
                  schedule.status === 'paid'
                    ? '!border-emerald-100/60 !bg-emerald-50/30'
                    : schedule.isOverdue
                      ? '!border-red-100/60 !bg-red-50/30'
                      : ''
                }`}
              >
                {schedule.status === 'paid' ? (
                  <CheckCircle size={18} className="text-emerald-500 shrink-0" strokeWidth={1.8} />
                ) : schedule.isOverdue ? (
                  <AlertCircle size={18} className="text-red-500 shrink-0" strokeWidth={1.8} />
                ) : (
                  <Clock size={18} className="text-slate-300 shrink-0" strokeWidth={1.8} />
                )}
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-slate-700 tracking-tight">Qist #{schedule.installmentNumber}</p>
                  <p className="text-[11px] text-slate-400">{format(new Date(schedule.dueDate), 'dd MMM yyyy')}</p>
                  {schedule.isOverdue ? <p className="text-[10px] text-red-500 font-bold mt-0.5">Overdue!</p> : null}
                </div>
                <div className="text-right">
                  <p className={`text-[13px] font-bold tabular-nums ${schedule.status === 'paid' ? 'text-emerald-500' : schedule.isOverdue ? 'text-red-500' : 'text-slate-700'}`}>
                    {formatMoney(schedule.amount, loan.currency)}
                  </p>
                  {schedule.status !== 'paid' ? (
                    <button
                      onClick={() => setSelectedEmi(schedule)}
                      className="text-[10px] text-indigo-600 font-bold mt-1 active:opacity-70 transition-opacity"
                    >
                      {t('loan_mark_paid')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {isLinkedLoan ? (
        <div className="px-5 pt-6">
          <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('stl_history_title')}</h2>
          {settlementHistory.length === 0 ? (
            <p className="text-[12px] text-slate-400">{t('stl_history_empty')}</p>
          ) : (
            <div className="space-y-2">
              {settlementHistory.map((s) => {
                // Sender-side only: if the settlement carried an opted-in
                // account AND the viewer is the sender, show a small meta
                // line referencing their account name.
                const appliedFromName =
                  s.requesterAccountId && s.fromUserId === currentUserId
                    ? accounts.find((a) => a.id === s.requesterAccountId)?.name ?? null
                    : null;
                return (
                  <SettlementHistoryRow
                    key={s.id}
                    request={s}
                    currency={loan.currency}
                    appliedFromAccountName={appliedFromName}
                  />
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      <div className="px-5 pt-6">
        <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t('tx_history')}</h2>
        {loanTransactions.length === 0 ? (
          <p className="text-[13px] text-slate-400 text-center py-8">{t('loan_no_tx')}</p>
        ) : (
          <div className="card-premium px-4 divide-y divide-slate-100/60">
            {loanTransactions.map((transaction) =>
              ['expense', 'loan_given', 'loan_taken'].includes(transaction.type) && !isGroupLinkedNote(transaction.notes) ? (
                <button
                  key={transaction.id}
                  type="button"
                  onClick={() => setSelectedTransaction(transaction)}
                  className="w-full text-left active:opacity-80 transition-opacity"
                >
                  <TransactionItem transaction={transaction} />
                </button>
              ) : (
                <TransactionItem key={transaction.id} transaction={transaction} />
              )
            )}
          </div>
        )}
      </div>

      {loan.status === 'active' ? (
        <RepaymentModal
          open={showRepayment}
          onClose={() => {
            setShowRepayment(false);
            refreshLoanDetail();
          }}
          loan={loan}
        />
      ) : null}
      {loan.status === 'active' && selectedEmi ? (
        <RepaymentModal
          open={!!selectedEmi}
          onClose={() => {
            setSelectedEmi(null);
            refreshLoanDetail();
          }}
          loan={loan}
          emiId={selectedEmi.id}
          presetAmount={Math.min(selectedEmi.amount, loan.remainingAmount)}
          lockAmount
          installmentNumber={selectedEmi.installmentNumber}
        />
      ) : null}
      <EditTransactionModal open={!!selectedTransaction} transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
      <PaymentReminderModal
        open={showReminder}
        onClose={() => setShowReminder(false)}
        personName={displayName || loan.personName}
        amount={loan.remainingAmount}
        currency={loan.currency}
        direction={loan.type === 'given' ? 'receivable' : 'payable'}
        startedAt={reminderStartedAt}
      />
      {isLinkedLoan ? (
        <SettleLinkedLoanModal
          open={showSettleLinked}
          onClose={() => {
            setShowSettleLinked(false);
            refreshLoanDetail();
          }}
          loan={loan}
        />
      ) : null}
    </div>
  );
}

function SettlementHistoryRow({
  request,
  currency,
  appliedFromAccountName,
}: {
  request: SettlementRequest;
  currency: string;
  appliedFromAccountName?: string | null;
}) {
  const t = useT();
  const statusKey = (`stl_status_${request.status}`) as
    | 'stl_status_pending' | 'stl_status_accepted' | 'stl_status_rejected' | 'stl_status_cancelled';
  const statusClasses = {
    pending:   'bg-amber-50 text-amber-600',
    accepted:  'bg-emerald-50 text-emerald-600',
    rejected:  'bg-slate-100 text-slate-500',
    cancelled: 'bg-slate-100 text-slate-500',
  }[request.status];
  return (
    <div className="card-premium !rounded-2xl p-3.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-700 tabular-nums">
          {formatMoney(request.amount, currency)}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5">
          {format(new Date(request.createdAt), 'MMM d, h:mm a')}
        </p>
        {appliedFromAccountName ? (
          <p className="text-[10px] text-indigo-600 mt-0.5">
            {t('stl_applied_from').replace('{account}', appliedFromAccountName)}
          </p>
        ) : null}
        {request.note ? (
          <p className="text-[11px] text-slate-500 italic mt-1 truncate">&ldquo;{request.note}&rdquo;</p>
        ) : null}
      </div>
      <span className={`text-[10px] font-bold uppercase tracking-widest rounded-full px-2.5 py-1 ${statusClasses}`}>
        {t(statusKey)}
      </span>
      {request.status === 'pending' ? (
        <Link to="/inbox" className="text-[10px] text-indigo-600 font-bold active:opacity-70 transition-opacity">
          {t('stl_history_view_in_inbox')}
        </Link>
      ) : null}
    </div>
  );
}
