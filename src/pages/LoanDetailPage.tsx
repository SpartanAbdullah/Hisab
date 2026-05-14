import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { format, isPast, differenceInDays } from 'date-fns';
import { AlertCircle, Bell, CheckCircle, Clock, RotateCcw, ChevronRight, Handshake } from 'lucide-react';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { UserAvatar } from '../components/UserAvatar';
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
  if (!loan) {
    return (
      <main className="min-h-dvh bg-cream-bg flex items-center justify-center">
        <p className="text-ink-500 text-[13px]">{t('loan_not_found')}</p>
      </main>
    );
  }

  const displayName = resolvePersonName({ personId: loan.personId, fallback: loan.personName });
  const loanTransactions = getByLoan(loan.id);

  const linkedPair = linkedRequests.find(
    (r) => r.status === 'accepted' && (r.requesterLoanId === loan.id || r.responderLoanId === loan.id),
  ) ?? null;
  const isLinkedLoan = (() => {
    if (!loan.personId) return false;
    const p = persons.find((x) => x.id === loan.personId);
    return !!(p?.linkedProfileId) && !!linkedPair;
  })();
  const canSettleLinked = isLinkedLoan && loan.status === 'active' && loan.remainingAmount > 0;
  const loanPairId = linkedPair?.id ?? null;
  const settlementHistory = loanPairId
    ? settlementRequests.filter((r) => r.loanPairId === loanPairId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];

  const emiItems = schedules
    .filter((schedule) => schedule.loanId === loan.id)
    .sort((left, right) => left.installmentNumber - right.installmentNumber);
  const enrichedEmis = emiItems.map((schedule) => ({
    ...schedule,
    isOverdue: schedule.status === 'upcoming' && isPast(new Date(schedule.dueDate)),
  }));
  const reminderStartedAt = getOldestIsoDate(
    enrichedEmis
      .filter((schedule) => schedule.status !== 'paid' && isPast(new Date(schedule.dueDate)))
      .map((schedule) => schedule.dueDate),
  ) ?? loan.createdAt;

  const paidCount = enrichedEmis.filter((s) => s.status === 'paid').length;
  const totalCount = enrichedEmis.length;
  const nextInstalment = enrichedEmis.find((s) => s.status !== 'paid') ?? null;
  const daysToNext = nextInstalment ? differenceInDays(new Date(nextInstalment.dueDate), new Date()) : null;
  const progressPct = (loan.totalAmount - loan.remainingAmount) / loan.totalAmount;

  const isGiven = loan.type === 'given';
  // Hero label flips based on direction: "X owes you" (receivable) vs
  // "You owe X" (payable). Plain copy beats abbreviations on a hero.
  const heroLabel = isGiven
    ? `${displayName || loan.personName} owes you`
    : `You owe ${displayName || loan.personName}`;

  const refreshLoanDetail = () => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          back
          action={
            <div className="flex items-center gap-2">
              {loan.status === 'active' && loan.remainingAmount > 0 && (
                <button
                  onClick={() => setShowReminder(true)}
                  className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[11.5px] font-semibold text-white transition-colors"
                  aria-label={t('reminder_cta')}
                >
                  <Bell size={12} strokeWidth={2.4} /> {t('reminder_cta')}
                </button>
              )}
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          {/* Person identity */}
          <div className="flex items-center gap-3 mb-5">
            <UserAvatar name={displayName || loan.personName} size={56} />
            <div className="min-w-0">
              <p className="text-white text-[17px] font-semibold tracking-tight truncate">
                {displayName || loan.personName}
              </p>
              <p className="text-[11px] text-white/55 mt-0.5">
                since {format(new Date(loan.createdAt), 'd MMM yyyy')}
                {isLinkedLoan && <span className="ml-1.5 inline-flex items-center text-[9.5px] font-semibold uppercase tracking-[0.1em] text-accent-500/90 bg-accent-500/15 rounded-full px-1.5 py-0.5">linked</span>}
              </p>
            </div>
          </div>

          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            {heroLabel}
          </p>
          <div className="mt-1.5">
            <MoneyDisplay
              amount={loan.remainingAmount}
              currency={loan.currency}
              size={40}
              tone="on-navy"
            />
          </div>
          <p className="text-[12px] text-white/55 mt-2">
            of {formatMoney(loan.totalAmount, loan.currency)}
            {totalCount > 0 && (
              <> · {paidCount} of {totalCount} instalments cleared</>
            )}
          </p>

          {/* Segmented progress — N segments when EMI plan exists, else a
              single smooth bar. White on white-18% track per Sukoon. */}
          {totalCount > 0 ? (
            <div className="flex gap-1 mt-4">
              {enrichedEmis.map((s) => (
                <div
                  key={s.id}
                  className="flex-1 h-1.5 rounded-full"
                  style={{
                    background:
                      s.status === 'paid'
                        ? '#FFFFFF'
                        : s.isOverdue
                        ? 'rgba(217,97,74,0.55)'
                        : 'rgba(255,255,255,0.18)',
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${Math.max(0, Math.min(100, progressPct * 100))}%` }}
              />
            </div>
          )}

          {loan.status === 'settled' && (
            <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-receive-600/25 px-3 py-1 text-[11px] font-semibold text-white">
              <CheckCircle size={12} /> {t('loan_completed')}
            </div>
          )}
          {loan.notes && (
            <p className="mt-3 text-[11px] text-white/55 italic">"{loan.notes}"</p>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Next instalment card — shown only when EMI plan exists and
            there's an unpaid instalment. Without an EMI plan, the same
            actions surface as full-width buttons in the next section. */}
        {nextInstalment && loan.status === 'active' && (
          <div className="rounded-[20px] bg-cream-card border border-cream-border p-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-14 rounded-xl flex flex-col items-center justify-center shrink-0 ${
                  nextInstalment.isOverdue ? 'bg-pay-50' : 'bg-accent-100'
                }`}
              >
                <p
                  className={`text-[9px] font-semibold uppercase tracking-[0.1em] ${
                    nextInstalment.isOverdue ? 'text-pay-text' : 'text-accent-600'
                  }`}
                >
                  {format(new Date(nextInstalment.dueDate), 'MMM').toUpperCase()}
                </p>
                <p
                  className={`text-[18px] font-semibold tabular-nums leading-none ${
                    nextInstalment.isOverdue ? 'text-pay-text' : 'text-accent-600'
                  }`}
                >
                  {format(new Date(nextInstalment.dueDate), 'd')}
                </p>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                  Next instalment ·{' '}
                  {nextInstalment.isOverdue
                    ? `${Math.abs(daysToNext ?? 0)} days overdue`
                    : daysToNext === 0
                    ? 'today'
                    : `in ${daysToNext} days`}
                </p>
                <p className="text-[18px] font-semibold text-ink-900 tabular-nums tracking-tight mt-0.5">
                  {formatMoney(nextInstalment.amount, loan.currency)}
                </p>
                {isLinkedLoan && (
                  <p className="text-[10.5px] text-ink-500 mt-0.5">
                    Linked to a Hisaab account
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              {canSettleLinked ? (
                <button
                  onClick={() => setShowSettleLinked(true)}
                  className="flex-1 bg-ink-900 text-white rounded-xl py-2.5 text-[12px] font-semibold active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
                >
                  <Handshake size={12} /> {t('stl_settle_cta')}
                </button>
              ) : isLinkedLoan ? (
                <p className="flex-1 text-[11px] text-ink-500 self-center text-center">
                  Use the linked-loan settle flow above.
                </p>
              ) : (
                <button
                  onClick={() => setSelectedEmi(nextInstalment)}
                  className="flex-1 bg-ink-900 text-white rounded-xl py-2.5 text-[12px] font-semibold active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
                >
                  <RotateCcw size={12} /> {t('loan_mark_paid')}
                </button>
              )}
              <button
                onClick={() => setShowRepayment(true)}
                className="flex-1 bg-cream-soft border border-cream-border text-ink-800 rounded-xl py-2.5 text-[12px] font-semibold active:bg-cream-hairline transition-colors"
              >
                {t('loan_repay')}
              </button>
            </div>
          </div>
        )}

        {/* No EMI plan but loan still active → surface the repay/settle CTAs
            as a quiet card so the user always has a way to record payment. */}
        {!nextInstalment && loan.status === 'active' && loan.remainingAmount > 0 && (
          <div className="flex gap-2">
            {canSettleLinked ? (
              <button
                onClick={() => setShowSettleLinked(true)}
                className="flex-1 bg-ink-900 text-white rounded-xl py-3 text-[13px] font-semibold active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
              >
                <Handshake size={13} /> {t('stl_settle_cta')}
              </button>
            ) : (
              <button
                onClick={() => setShowRepayment(true)}
                className="flex-1 bg-ink-900 text-white rounded-xl py-3 text-[13px] font-semibold active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
              >
                <RotateCcw size={13} /> {t('loan_repay')}
              </button>
            )}
          </div>
        )}

        {/* EMI schedule rows */}
        {enrichedEmis.length > 0 && (
          <div>
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
              Schedule · {paidCount}/{totalCount}
            </h2>
            <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
              {enrichedEmis.map((schedule) => {
                const isPaid = schedule.status === 'paid';
                const isNext = !isPaid && schedule === nextInstalment;
                return (
                  <div
                    key={schedule.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    {/* State tile: paid (receive check) / next (accent number) /
                        future (dashed cream) / overdue (pay alert) */}
                    {isPaid ? (
                      <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center shrink-0">
                        <CheckCircle size={16} className="text-receive-text" strokeWidth={2} />
                      </div>
                    ) : schedule.isOverdue ? (
                      <div className="w-9 h-9 rounded-xl bg-pay-50 flex items-center justify-center shrink-0">
                        <AlertCircle size={16} className="text-pay-text" strokeWidth={2} />
                      </div>
                    ) : isNext ? (
                      <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center shrink-0 text-[12px] font-semibold text-accent-600 tabular-nums">
                        {schedule.installmentNumber}
                      </div>
                    ) : (
                      <div className="w-9 h-9 rounded-xl border border-dashed border-cream-border bg-cream-soft flex items-center justify-center shrink-0">
                        <Clock size={14} className="text-ink-300" strokeWidth={1.8} />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink-900 tracking-tight">
                        Instalment {schedule.installmentNumber}
                      </p>
                      <p className="text-[10.5px] text-ink-500 mt-0.5">
                        {format(new Date(schedule.dueDate), 'd MMM yyyy')}
                        {isPaid && ' · paid'}
                        {schedule.isOverdue && (
                          <span className="text-pay-text font-semibold"> · overdue</span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={`text-[13px] font-semibold tabular-nums ${
                          isPaid ? 'text-receive-text' : schedule.isOverdue ? 'text-pay-text' : 'text-ink-900'
                        }`}
                      >
                        {formatMoney(schedule.amount, loan.currency)}
                      </p>
                      {!isPaid && loan.status === 'active' && (
                        <button
                          onClick={() => setSelectedEmi(schedule)}
                          className="text-[10px] text-accent-600 font-semibold mt-0.5 active:opacity-70"
                        >
                          {t('loan_mark_paid')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Settlement history (linked loans only) */}
        {isLinkedLoan && (
          <div>
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
              {t('stl_history_title')}
            </h2>
            {settlementHistory.length === 0 ? (
              <p className="text-[12px] text-ink-400 text-center py-5">
                {t('stl_history_empty')}
              </p>
            ) : (
              <div className="space-y-2">
                {settlementHistory.map((s) => {
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
        )}

        {/* Transaction history */}
        <div>
          <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
            {t('tx_history')}
          </h2>
          {loanTransactions.length === 0 ? (
            <p className="text-[12px] text-ink-400 text-center py-5">
              {t('loan_no_tx')}
            </p>
          ) : (
            <div className="rounded-[18px] bg-cream-card border border-cream-border px-4 divide-y divide-cream-hairline">
              {loanTransactions.map((transaction) =>
                ['expense', 'loan_given', 'loan_taken'].includes(transaction.type) &&
                !isGroupLinkedNote(transaction.notes) ? (
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
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {loan.status === 'active' && (
        <RepaymentModal
          open={showRepayment}
          onClose={() => {
            setShowRepayment(false);
            refreshLoanDetail();
          }}
          loan={loan}
        />
      )}
      {loan.status === 'active' && selectedEmi && (
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
      )}
      <EditTransactionModal
        open={!!selectedTransaction}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
      <PaymentReminderModal
        open={showReminder}
        onClose={() => setShowReminder(false)}
        personName={displayName || loan.personName}
        amount={loan.remainingAmount}
        currency={loan.currency}
        direction={loan.type === 'given' ? 'receivable' : 'payable'}
        startedAt={reminderStartedAt}
      />
      {isLinkedLoan && (
        <SettleLinkedLoanModal
          open={showSettleLinked}
          onClose={() => {
            setShowSettleLinked(false);
            refreshLoanDetail();
          }}
          loan={loan}
        />
      )}
    </main>
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
    pending:   'bg-warn-50 text-warn-600',
    accepted:  'bg-receive-50 text-receive-text',
    rejected:  'bg-cream-soft text-ink-500',
    cancelled: 'bg-cream-soft text-ink-500',
  }[request.status];
  return (
    <div className="rounded-[18px] bg-cream-card border border-cream-border p-3.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-ink-900 tabular-nums">
          {formatMoney(request.amount, currency)}
        </p>
        <p className="text-[10.5px] text-ink-500 mt-0.5">
          {format(new Date(request.createdAt), 'MMM d, h:mm a')}
        </p>
        {appliedFromAccountName && (
          <p className="text-[10.5px] text-accent-600 mt-0.5">
            {t('stl_applied_account').replace('{account}', appliedFromAccountName)}
          </p>
        )}
        {request.note && (
          <p className="text-[11px] text-ink-500 italic mt-1 truncate">&ldquo;{request.note}&rdquo;</p>
        )}
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] rounded-full px-2.5 py-1 ${statusClasses}`}>
        {t(statusKey)}
      </span>
      {request.status === 'pending' && (
        <Link
          to="/inbox"
          className="text-[10px] text-accent-600 font-semibold active:opacity-70 transition-opacity flex items-center gap-0.5"
        >
          {t('stl_history_view_in_inbox')} <ChevronRight size={10} />
        </Link>
      )}
    </div>
  );
}
