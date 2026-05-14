import { useEffect, useState } from 'react';
import { Plus, ChevronRight, Users, Bell, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { UserAvatar } from '../components/UserAvatar';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { TransactionItem } from '../components/TransactionItem';
import { PaymentReminderModal } from '../components/PaymentReminderModal';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import {
  getOldestIsoDate,
  getReminderAge,
  type PaymentReminderDirection,
} from '../lib/paymentReminders';
import { AddLoanModal } from './AddLoanModal';
import { format } from 'date-fns';
import type { Currency, Loan } from '../db';

type LoanDirection = 'given' | 'taken';
type Tab = 'receivables' | 'payables' | 'settled';

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
  status: 'active' | 'settled';
};

type ReminderTarget = {
  personName: string;
  amount: number;
  currency: Currency;
  direction: PaymentReminderDirection;
  startedAt: string | null;
};

export function LoansPage() {
  const { loans, loadLoans } = useLoanStore();
  const { schedules, loadSchedules } = useEmiStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loadAccounts } = useAccountStore();
  const navigate = useNavigate();
  const t = useT();
  const primaryCurrency = localStorage.getItem('hisaab_primary_currency') ?? 'AED';

  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<Tab>('receivables');
  const [selectedGroup, setSelectedGroup] = useState<LoanGroup | null>(null);
  const [reminderTarget, setReminderTarget] = useState<ReminderTarget | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  }, [loadAccounts, loadLoans, loadSchedules, loadTransactions]);

  const activeLoans = loans.filter((l) => l.status === 'active');
  const settledLoans = loans.filter((l) => l.status === 'settled');

  const sumRemaining = (items: Loan[]) =>
    items.reduce(
      (acc, l) => {
        acc[l.currency] = (acc[l.currency] ?? 0) + l.remainingAmount;
        return acc;
      },
      {} as Record<string, number>,
    );

  const activeReceivablesByCurrency = sumRemaining(
    activeLoans.filter((l) => l.type === 'given'),
  );
  const activePayablesByCurrency = sumRemaining(
    activeLoans.filter((l) => l.type === 'taken'),
  );

  // Hero net stance — primary currency only. Other currencies surface as a
  // separate "pocket" section below the main list so the headline number
  // stays unambiguous.
  const recvPrimary = activeReceivablesByCurrency[primaryCurrency] ?? 0;
  const payPrimary = activePayablesByCurrency[primaryCurrency] ?? 0;
  const netStance = recvPrimary - payPrimary;
  const totalActivity = recvPrimary + payPrimary;
  // Segmented bar widths — leave a 4% gap when both sides have value, per
  // Sukoon's spec. When only one side has activity, drop the gap.
  const hasBothSides = recvPrimary > 0 && payPrimary > 0;
  const gapPct = hasBothSides ? 4 : 0;
  const recvPct = totalActivity > 0 ? (recvPrimary / totalActivity) * (100 - gapPct) : 0;
  const payPct = totalActivity > 0 ? (payPrimary / totalActivity) * (100 - gapPct) : 0;

  // People counts in the primary currency (for the hero split label)
  const distinctPeople = (items: Loan[], currency: string) =>
    new Set(
      items
        .filter((l) => l.currency === currency)
        .map((l) => l.personId ?? l.personName.trim().toLowerCase()),
    ).size;
  const recvPeopleCount = distinctPeople(
    activeLoans.filter((l) => l.type === 'given'),
    primaryCurrency,
  );
  const payPeopleCount = distinctPeople(
    activeLoans.filter((l) => l.type === 'taken'),
    primaryCurrency,
  );

  // Group loans by (direction × currency × person). Used by both the main
  // list and the "other currencies" pocket section.
  const groupBy = (items: Loan[], direction: LoanDirection, status: 'active' | 'settled'): LoanGroup[] => {
    const buckets = new Map<string, LoanGroup>();
    for (const loan of items) {
      const personKey = loan.personId ?? loan.personName.trim().toLowerCase();
      const key = `${direction}:${loan.currency}:${personKey}`;
      const bucket = buckets.get(key) ?? {
        key,
        name: loan.personName,
        currency: loan.currency,
        direction,
        status,
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
    return [...buckets.values()].sort((a, b) => b.remaining - a.remaining || b.total - a.total);
  };

  const tabCounts = {
    receivables: distinctPeople(activeLoans.filter((l) => l.type === 'given'), primaryCurrency),
    payables: distinctPeople(activeLoans.filter((l) => l.type === 'taken'), primaryCurrency),
    settled: settledLoans.length,
  };

  // Build the visible list for the current tab. Primary-currency groups first;
  // everything else lands in `otherGroups` as a pocket section below.
  let primaryGroups: LoanGroup[] = [];
  let otherGroups: LoanGroup[] = [];
  if (tab === 'receivables') {
    const givens = activeLoans.filter((l) => l.type === 'given');
    const all = groupBy(givens, 'given', 'active');
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  } else if (tab === 'payables') {
    const takens = activeLoans.filter((l) => l.type === 'taken');
    const all = groupBy(takens, 'taken', 'active');
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  } else {
    // Settled tab: both directions, sorted by total amount (most-impactful first).
    const givensSettled = groupBy(
      settledLoans.filter((l) => l.type === 'given'),
      'given',
      'settled',
    );
    const takensSettled = groupBy(
      settledLoans.filter((l) => l.type === 'taken'),
      'taken',
      'settled',
    );
    const all = [...givensSettled, ...takensSettled].sort((a, b) => b.total - a.total);
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  }

  // Free-text name filter — applied uniformly across both pockets so a
  // search like "ali" surfaces matches regardless of which currency the
  // person's loan is in.
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    primaryGroups = primaryGroups.filter((g) => g.name.toLowerCase().includes(q));
    otherGroups = otherGroups.filter((g) => g.name.toLowerCase().includes(q));
  }

  const selectedLoanIds = new Set(selectedGroup?.loans.map((l) => l.id) ?? []);
  const selectedTransactions = transactions
    .filter((tx) => tx.relatedLoanId && selectedLoanIds.has(tx.relatedLoanId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const getGroupReminderDate = (group: LoanGroup) => {
    const loanIds = new Set(group.loans.map((l) => l.id));
    const overdueScheduleDate = getOldestIsoDate(
      schedules
        .filter((s) => loanIds.has(s.loanId) && s.status !== 'paid')
        .map((s) => s.dueDate),
    );
    return overdueScheduleDate ?? getOldestIsoDate(group.loans.map((l) => l.createdAt));
  };

  // Find the next unpaid EMI instalment for a person's loans, for the
  // "Next: 12 Aug · 300 AED" hint in the row.
  const getNextInstalment = (group: LoanGroup) => {
    const loanIds = new Set(group.loans.map((l) => l.id));
    const upcoming = schedules
      .filter((s) => loanIds.has(s.loanId) && s.status !== 'paid')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return upcoming ?? null;
  };

  const formatReminderMeta = (startedAt: string | null) => {
    const age = getReminderAge(startedAt);
    if (age.days === null) return t('reminder_no_due_date');
    if (age.isOverdue) return t('reminder_overdue_days').replace('{count}', String(age.days));
    return t('reminder_open_days').replace('{count}', String(age.days));
  };

  const openReminder = (group: LoanGroup) => {
    setSelectedGroup(null);
    setReminderTarget({
      personName: group.name,
      amount: group.remaining,
      currency: group.currency,
      direction: group.direction === 'given' ? 'receivable' : 'payable',
      startedAt: getGroupReminderDate(group),
    });
  };

  const renderPersonRow = (group: LoanGroup) => {
    const isGiven = group.direction === 'given';
    const isSettled = group.status === 'settled';
    const amount = isSettled ? group.total : group.remaining;
    const sign = isGiven ? '+' : '−';
    const amountColor = isSettled
      ? 'text-ink-500'
      : isGiven
      ? 'text-receive-text'
      : 'text-pay-text';

    const totalLoans = group.count;
    const nextInst = getNextInstalment(group);
    const remainingInstalments = nextInst
      ? schedules.filter(
          (s) =>
            group.loans.some((l) => l.id === s.loanId) && s.status !== 'paid',
        ).length
      : 0;

    return (
      <button
        key={group.key}
        type="button"
        onClick={() => setSelectedGroup(group)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
      >
        <UserAvatar name={group.name} size={44} />
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
            {group.name}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5">
            {totalLoans} {totalLoans === 1 ? 'loan' : 'loans'}
            {remainingInstalments > 0 && (
              <> · {remainingInstalments} instalments left</>
            )}
          </p>
          {nextInst && !isSettled && (
            <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
              Next: {format(new Date(nextInst.dueDate), 'd MMM')} ·{' '}
              {formatMoney(nextInst.amount, group.currency)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[14px] font-semibold tabular-nums tracking-tight ${amountColor}`}>
            {sign}
            {formatMoney(amount, group.currency)}
          </p>
          <p className="text-[10px] text-ink-400 mt-0.5">{group.currency}</p>
        </div>
      </button>
    );
  };

  const tabPills: { value: Tab; label: string; count: number }[] = [
    { value: 'receivables', label: 'Receivables', count: tabCounts.receivables },
    { value: 'payables', label: 'Payables', count: tabCounts.payables },
    { value: 'settled', label: 'Settled', count: tabCounts.settled },
  ];

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('loans_title')}
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
                aria-label="Add loan"
              >
                <Plus size={13} strokeWidth={2.4} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            Your stance · {primaryCurrency}
          </p>
          <div className="mt-1.5">
            <MoneyDisplay
              amount={netStance}
              currency={primaryCurrency}
              size={36}
              tone="on-navy"
              signed
            />
          </div>
          <p className="text-[12px] text-white/55 mt-2">
            {netStance > 0
              ? "You'll receive more than you owe"
              : netStance < 0
              ? "You owe more than you'll receive"
              : 'Balanced'}
          </p>

          {/* Segmented bar visualisation */}
          {totalActivity > 0 && (
            <>
              <div className="mt-4 h-2 rounded-full bg-white/8 overflow-hidden flex gap-[var(--gap-w)]" style={{ ['--gap-w' as string]: hasBothSides ? `${gapPct}%` : '0%' }}>
                {recvPct > 0 && (
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${recvPct}%`, background: 'var(--color-receive-600)' }}
                  />
                )}
                {payPct > 0 && (
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${payPct}%`, background: 'var(--color-pay-600)' }}
                  />
                )}
              </div>
              <div className="flex items-center justify-between mt-2 text-[10.5px]">
                <span className="text-receive-text/90 tabular-nums" style={{ color: '#7CE3B6' }}>
                  +{formatMoney(recvPrimary, primaryCurrency)} to receive ·{' '}
                  {recvPeopleCount} {recvPeopleCount === 1 ? 'pp' : 'ppl'}
                </span>
                <span className="tabular-nums" style={{ color: '#F0A496' }}>
                  −{formatMoney(payPrimary, primaryCurrency)} to pay ·{' '}
                  {payPeopleCount} {payPeopleCount === 1 ? 'pp' : 'ppl'}
                </span>
              </div>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {showSearch && (
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name"
              className="w-full bg-cream-card border border-cream-border rounded-2xl pl-10 pr-10 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-400 active:scale-90"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Tab pills: Receivables / Payables / Settled */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
          {tabPills.map((p) => {
            const isActive = tab === p.value;
            return (
              <button
                key={p.value}
                onClick={() => {
                  setTab(p.value);
                  setSelectedGroup(null);
                }}
                className={`shrink-0 px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-ink-900 text-white'
                    : 'bg-cream-card text-ink-500 border border-cream-border'
                }`}
              >
                {p.label}
                {p.count > 0 && (
                  <span className={`ml-1.5 ${isActive ? 'text-white/70' : 'text-ink-400'}`}>
                    · {p.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Primary-currency people list */}
        {primaryGroups.length > 0 ? (
          <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
            {primaryGroups.map(renderPersonRow)}
          </div>
        ) : null}

        {/* Other-currency pocket section */}
        {otherGroups.length > 0 && (
          <div>
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
              Other currencies
            </h2>
            <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
              {otherGroups.map(renderPersonRow)}
            </div>
          </div>
        )}

        {/* Empty state */}
        {primaryGroups.length === 0 && otherGroups.length === 0 && (
          <EmptyState
            icon={Users}
            title={
              tab === 'settled'
                ? t('loan_none_settled')
                : t('empty_loans_title')
            }
            description={
              tab === 'settled'
                ? t('loan_desc_settled')
                : t('empty_loans_desc')
            }
            actionLabel={tab !== 'settled' ? t('empty_loans_cta') : undefined}
            onAction={tab !== 'settled' ? () => setShowAdd(true) : undefined}
          />
        )}

      </div>

      {/* Drill-down modal: per-person loan summary + individual loans + activity */}
      <Modal
        open={!!selectedGroup}
        onClose={() => setSelectedGroup(null)}
        title={selectedGroup?.name ?? ''}
      >
        {selectedGroup ? (
          <div className="space-y-5">
            <LoanGroupSummary
              group={selectedGroup}
              onRemind={
                selectedGroup.status === 'active' && selectedGroup.remaining > 0
                  ? () => openReminder(selectedGroup)
                  : undefined
              }
              reminderMeta={formatReminderMeta(getGroupReminderDate(selectedGroup))}
            />

            <div>
              <h3 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5">
                Individual loans
              </h3>
              <div className="space-y-2">
                {selectedGroup.loans
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((loan) => (
                    <LoanDrilldownRow
                      key={loan.id}
                      loan={loan}
                      onClick={() => navigate(`/loan/${loan.id}`)}
                    />
                  ))}
              </div>
            </div>

            <div>
              <h3 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5">
                Activity
              </h3>
              {selectedTransactions.length === 0 ? (
                <p className="text-[12px] text-ink-400 text-center py-5">
                  No transaction activity yet.
                </p>
              ) : (
                <div className="rounded-[18px] bg-cream-card border border-cream-border px-3 divide-y divide-cream-hairline">
                  {selectedTransactions.map((tx) => (
                    <TransactionItem key={tx.id} transaction={tx} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {reminderTarget ? (
        <PaymentReminderModal
          open={!!reminderTarget}
          onClose={() => setReminderTarget(null)}
          personName={reminderTarget.personName}
          amount={reminderTarget.amount}
          currency={reminderTarget.currency}
          direction={reminderTarget.direction}
          startedAt={reminderTarget.startedAt}
        />
      ) : null}

      <AddLoanModal open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}

function LoanGroupSummary({
  group,
  onRemind,
  reminderMeta,
}: {
  group: LoanGroup;
  onRemind?: () => void;
  reminderMeta?: string;
}) {
  const t = useT();
  const isGiven = group.direction === 'given';
  const settledAmount = group.total - group.remaining;
  const progress = group.total > 0 ? settledAmount / group.total : 0;
  const primaryAmount = group.status === 'active' ? group.remaining : group.total;
  const tone = isGiven ? 'receive' : 'pay';

  return (
    <div
      className="rounded-[18px] p-4 border border-cream-border"
      style={{
        background:
          tone === 'receive' ? 'var(--color-receive-50)' : 'var(--color-pay-50)',
      }}
    >
      <p
        className="text-[10.5px] font-semibold uppercase tracking-[0.12em]"
        style={{
          color:
            tone === 'receive'
              ? 'var(--color-receive-text)'
              : 'var(--color-pay-text)',
        }}
      >
        {isGiven ? t('loan_receivable') : t('loan_payable')} · {group.currency}
      </p>
      <p className="text-[22px] font-semibold text-ink-900 tabular-nums tracking-tight mt-1 leading-tight">
        {formatMoney(primaryAmount, group.currency)}
      </p>
      <p className="text-[11px] text-ink-500 mt-1">
        {formatMoney(settledAmount, group.currency)} {isGiven ? 'received' : 'paid'} of{' '}
        {formatMoney(group.total, group.currency)}
      </p>
      <div className="mt-3 h-1.5 rounded-full overflow-hidden bg-white/60">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.round(progress * 100)}%`,
            background:
              tone === 'receive' ? 'var(--color-receive-600)' : 'var(--color-pay-600)',
          }}
        />
      </div>
      {onRemind ? (
        <div className="mt-3 flex items-center gap-2">
          {reminderMeta && (
            <p className="flex-1 text-[11px] text-ink-500">{reminderMeta}</p>
          )}
          <button
            type="button"
            onClick={onRemind}
            className="rounded-xl px-3 py-1.5 text-[11px] font-semibold bg-white text-ink-900 active:scale-95 transition-all flex items-center gap-1.5 border border-cream-border"
          >
            <Bell size={11} /> {t('reminder_cta')}
          </button>
        </div>
      ) : null}
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
      className="w-full rounded-[14px] border border-cream-border bg-cream-card p-3.5 flex items-center gap-3 text-left active:bg-cream-soft transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-semibold text-ink-900 tabular-nums">
            {formatMoney(loan.totalAmount, loan.currency)}
          </p>
          <span
            className={`text-[10px] font-semibold uppercase rounded-full px-2 py-0.5 ${
              loan.status === 'settled'
                ? 'bg-receive-50 text-receive-text'
                : 'bg-warn-50 text-warn-600'
            }`}
          >
            {loan.status}
          </span>
        </div>
        <p className="text-[10.5px] text-ink-500 mt-1">
          {t('loan_remaining')}: {formatMoney(loan.remainingAmount, loan.currency)}
        </p>
        <div className="mt-2 h-1 rounded-full bg-cream-hairline overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-600"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        {loan.notes ? (
          <p className="text-[10.5px] text-ink-400 italic mt-1 truncate">"{loan.notes}"</p>
        ) : null}
      </div>
      <ChevronRight size={15} className="text-ink-300 shrink-0" />
    </button>
  );
}
