import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowDownLeft,
  Wallet2,
  Coins,
  TrendingUp,
  Plus,
  BarChart3,
  HandCoins,
  Users,
  Target,
  History,
  ChevronRight,
  ChevronDown,
  Landmark,
  Contact,
  CreditCard,
  Search,
  CheckCircle2,
} from "lucide-react";
import { useAccountStore } from "../stores/accountStore";
import { useTransactionStore } from "../stores/transactionStore";
import { useLoanStore } from "../stores/loanStore";
import { useGoalStore } from "../stores/goalStore";
import { useUpcomingExpenseStore } from "../stores/upcomingExpenseStore";
import { useAppModeStore } from "../stores/appModeStore";
import { useSplitStore } from "../stores/splitStore";
import { useSettlementRequestStore } from "../stores/settlementRequestStore";
import { usePersonStore } from "../stores/personStore";
import { useBudgetStore, computeBudgetUsages } from "../stores/budgetStore";
import { useRecurringStore } from "../stores/recurringStore";
import { useEmiStore } from "../stores/emiStore";
import { useCommitteeStore } from "../stores/committeeStore";
import { useInvestmentStore, portfolioTotals } from "../stores/investmentStore";
import { buildThisWeek, thisWeekTotals } from "../lib/thisWeek";
import {
  computeMeraHisaab,
  monthKeyOf,
  NET_SNAPSHOTS_KEY,
  previousMonthNet,
  upsertSnapshot,
  type NetSnapshot,
} from "../lib/meraHisaab";
import { CHECK_STAMP_KEY, daysSince, type CheckStamp } from "../lib/hisaabCheck";
import { buildInboxActionItems } from "../lib/inboxInfo";
import { HisaabCheckModal } from "../components/HisaabCheckModal";
import { CalendarClock, ClipboardCheck, Scale } from "lucide-react";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { SettlementNudgeBanner } from "../components/SettlementNudgeBanner";
import { BudgetWarningBanner } from "../components/BudgetWarningBanner";
import { getOverdueSettlements } from "../lib/settlementNudges";
import { TransactionItem } from "../components/TransactionItem";
import { EditTransactionModal } from "../components/EditTransactionModal";
import type { Transaction } from "../db";
import { EmptyState } from "../components/EmptyState";
import { PageErrorState } from "../components/PageErrorState";
import { UserAvatar } from "../components/UserAvatar";
import { NavyHero } from "../components/NavyHero";
import { InboxAction } from "../components/InboxAction";
import { AnimatedMoney } from "../components/AnimatedMoney";
import { GlobalSearch } from "../components/GlobalSearch";
import { NextStepHint } from "../components/NextStepHint";
import { GettingStartedCard } from "../components/GettingStartedCard";
import { CoachCards } from "../components/CoachCards";
import { buildCoachCards } from "../lib/coachInsights";
import { AddAccountStepper } from "./AddAccountStepper";
import { QuickEntry } from "./QuickEntry";
import { formatMoney, formatSignedMoney } from "../lib/constants";
import { marketColorFor } from "../lib/marketColors";
import { currencyMeta } from "../lib/design-tokens";
import { useT } from "../lib/i18n";
import { useAsyncLoad } from "../hooks/useAsyncLoad";

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      resolve();
      return;
    }
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

export function HomePage() {
  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loans, loadLoans } = useLoanStore();
  const { loadGoals } = useGoalStore();
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  // Raw slices only — filtering happens inside useMemo (React #185).
  const emiSchedules = useEmiStore((s) => s.schedules);
  const committees = useCommitteeStore((s) => s.committees);
  const committeePayments = useCommitteeStore((s) => s.payments);
  const invMarkets = useInvestmentStore((s) => s.markets);
  const invTrades = useInvestmentStore((s) => s.trades);
  const invPrices = useInvestmentStore((s) => s.prices);
  const mode = useAppModeStore((s) => s.mode);
  const {
    groups,
    balances: groupBalances,
    loadGroups,
    loadBalances,
  } = useSplitStore();
  const navigate = useNavigate();
  const t = useT();
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // Tapping a recent transaction opens it for editing (previously inert).
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null);
  // splits_only "Record an IOU" entry — opens QuickEntry locally so the
  // empty-state CTA actually does something instead of pointing at the FAB.
  const [showQuickEntry, setShowQuickEntry] = useState(false);
  const [dismissedReminders, setDismissedReminders] = useState<string[]>([]);
  const [renderNowMs] = useState(() => Date.now());
  // Weekly "Hisaab check" ritual — the stamp drives the "last done Nd ago"
  // line; finishing the walk updates it via onStamped.
  const [showCheck, setShowCheck] = useState(false);
  const [checkStampIso, setCheckStampIso] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(CHECK_STAMP_KEY);
      return raw ? ((JSON.parse(raw) as CheckStamp).dateIso ?? null) : null;
    } catch {
      return null;
    }
  });

  const userName = localStorage.getItem("hisaab_user_name") ?? "User";
  const primaryCurrency = localStorage.getItem("hisaab_primary_currency") ?? "AED";
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? "");

  // Load account balances first so the mobile dashboard can paint its core
  // money view before supporting widgets compete for network/CPU.
  const loadEverything = useCallback(async () => {
    if (mode === "splits_only") {
      await Promise.all([loadLoans(), loadGroups().then(loadBalances)]);
      return;
    }
    await loadAccounts();
    await waitForNextPaint();
    await Promise.all([
      loadTransactions(),
      loadLoans(),
      loadGoals(),
      loadExpenses(),
      // "This week" sources: instalment schedules + kameti dates. Both are
      // cheap reads and usually warm (kameti boot-loads in App.tsx).
      useEmiStore.getState().loadSchedules(),
      useCommitteeStore.getState().loadAll(),
      // Portfolio card: three cheap selects (empty tables for non-investors).
      // NON-FATAL — an optional widget must never brick the dashboard (e.g.
      // if the investments migration isn't applied); the card just stays
      // hidden when this fails.
      useInvestmentStore.getState().loadInvestments().catch((err) => {
        console.error("loadInvestments failed (non-fatal)", err);
      }),
    ]);
  }, [
    loadAccounts,
    loadTransactions,
    loadLoans,
    loadGoals,
    loadExpenses,
    loadGroups,
    loadBalances,
    mode,
  ]);

  const {
    status: loadStatus,
    error: loadError,
    retry: retryLoad,
  } = useAsyncLoad(loadEverything);

  // Until the first load resolves, anything keyed off "is the user-owned
  // collection empty?" is unreliable — every store starts with [] before
  // its Supabase fetch completes. We render placeholder UI (or simply
  // nothing) for those slots until status === 'ready'.
  const isInitialLoading = loadStatus === 'loading';
  const dataReady = loadStatus === 'ready';

  // FIX 2: Credit cards are liabilities, not assets
  // Net worth = regular account balances + (credit card balance - limit) for each card
  const totals = accounts.reduce((acc, a) => {
    if (a.type === "credit_card") {
      const limit = parseFloat(a.metadata.creditLimit || "0");
      const used = limit - a.balance; // amount owed
      acc[a.currency] = (acc[a.currency] ?? 0) - used; // subtract liability
    } else {
      acc[a.currency] = (acc[a.currency] ?? 0) + a.balance;
    }
    return acc;
  }, {} as Record<string, number>);

  const recentTxns = transactions.slice(0, 5);

  // Surface outgoing pending settlements that have been waiting >= 3 days.
  // Snoozable for 24h. Real overdue requests will re-surface — that's
  // intentional: forgetting a settlement is the problem we're solving.
  //
  // IMPORTANT: subscribe to the raw `requests` slice and filter inside
  // a useMemo. Zustand's snapshot getter is invoked twice per render by
  // useSyncExternalStore; if it returns a fresh array each call (which a
  // .filter() inside the selector would), React detects an unstable
  // snapshot and throws #185 "Maximum update depth exceeded."
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const overdueNudges = useMemo(() => {
    if (!userId) return [];
    const outgoing = settlementRequests.filter(
      (r) => r.status === 'pending' && r.fromUserId === userId,
    );
    return getOverdueSettlements(outgoing, persons, 3);
  }, [settlementRequests, persons, userId]);

  // Budget usage banner — surfaces categories that crossed their warn
  // threshold. Cheap to compute; runs every time transactions/budgets
  // change. Banner self-hides for the session when dismissed.
  const budgets = useBudgetStore((s) => s.budgets);
  const budgetUsages = useMemo(() => computeBudgetUsages(budgets, transactions), [budgets, transactions]);

  // Quick-tile pending counts. Recurring templates are preloaded at app boot
  // (App.tsx), so reading them here is cheap and already-warm. A subscription
  // is "due soon" when its next charge lands within the next 7 days.
  const recurringTemplates = useRecurringStore((s) => s.templates);
  const subscriptionsDueSoon = useMemo(() => {
    const horizon = renderNowMs + 7 * 24 * 60 * 60 * 1000;
    return recurringTemplates.filter((tpl) => {
      if (!tpl.active) return false;
      const due = new Date(tpl.nextDueDate).getTime();
      return Number.isFinite(due) && due <= horizon;
    }).length;
  }, [recurringTemplates, renderNowMs]);

  // Cash-advance loans, keyed to their funding card — the Loan row carries
  // no card link, only the origin transaction does. thisWeek uses this to
  // keep the same debt (card owed + its EMIs) from double-counting.
  const cardFundedLoanIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const txn of transactions) {
      if (txn.type === "loan_taken" && txn.relatedLoanId && txn.sourceAccountId) {
        map.set(txn.relatedLoanId, txn.sourceAccountId);
      }
    }
    return map;
  }, [transactions]);

  // "This week" rows: the pure lib merges EMIs, kameti rounds, recurring
  // charges, one-off bills and card due days into one 7-day forward view.
  const thisWeekRows = useMemo(
    () =>
      buildThisWeek({
        loans,
        schedules: emiSchedules,
        committees,
        templates: recurringTemplates,
        upcoming: expenses,
        accounts,
        cardFundedLoanIds,
        // Lets a cleared card bill show as praise instead of vanishing.
        transactions,
        today: new Date(renderNowMs),
      }),
    [loans, emiSchedules, committees, recurringTemplates, expenses, accounts, cardFundedLoanIds, transactions, renderNowMs],
  );
  // Header total: the largest outgoing currency bucket (usually the only one).
  const thisWeekOut = useMemo(() => {
    const totals = thisWeekTotals(thisWeekRows).filter((entry) => entry.out > 0);
    return totals[0] ?? null;
  }, [thisWeekRows]);

  // Needs-action queue count (overdue EMIs, missed recurring, kameti rounds,
  // uncategorised expenses) — same pure builder the Inbox "To-do" tab uses,
  // so the number on Home always matches what tapping through reveals.
  const needsActionCount = useMemo(
    () =>
      buildInboxActionItems({
        loans,
        schedules: emiSchedules,
        transactions,
        templates: recurringTemplates,
        committees,
        committeePayments,
        accounts,
        cardFundedLoanIds,
        today: new Date(renderNowMs),
      }).length,
    [loans, emiSchedules, transactions, recurringTemplates, committees, committeePayments, accounts, cardFundedLoanIds, renderNowMs],
  );
  const checkDays = daysSince(checkStampIso, new Date(renderNowMs));

  // Portfolio totals per currency — shown as its OWN card, not folded into
  // "Where I Stand": holdings are volatile and price-dependent, liquid money
  // is settled fact. Blurring them would make both numbers less trustworthy.
  const invMarketRows = useMemo(() => {
    // One row PER MARKET (not per currency) so each part of the card can
    // deep-link into its own market on the Investment Tracker page.
    const rows = invMarkets
      .map((market) => ({ market, bucket: portfolioTotals([market], invTrades, invPrices)[0] }))
      .filter((r) => r.bucket && (r.bucket.currentValue > 0.005 || r.bucket.invested > 0.005));
    return rows.sort((a, b) => {
      const aPrimary = a.market.currency === primaryCurrency;
      const bPrimary = b.market.currency === primaryCurrency;
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
      return b.bucket.currentValue - a.bucket.currentValue;
    });
  }, [invMarkets, invTrades, invPrices, primaryCurrency]);

  // "Mera Hisaab" — the net position INCLUDING people: accounts (cards as
  // −owed) + receivables − payables, with cash advances never counted twice.
  const meraTotals = useMemo(
    () => computeMeraHisaab({ accounts, loans, cardFundedLoanIds }),
    [accounts, loans, cardFundedLoanIds],
  );
  const meraPrimary = useMemo(
    () => meraTotals.find((entry) => entry.currency === primaryCurrency) ?? meraTotals[0] ?? null,
    [meraTotals, primaryCurrency],
  );
  // Monthly snapshot for the vs-last-month delta. Captured once per load
  // when data is ready; localStorage keeps a rolling 13 months.
  const [meraPrevNet, setMeraPrevNet] = useState<number | null>(null);
  useEffect(() => {
    if (!dataReady || !meraPrimary) return;
    try {
      const raw = localStorage.getItem(NET_SNAPSHOTS_KEY);
      const snapshots: NetSnapshot[] = raw ? JSON.parse(raw) : [];
      const monthKey = monthKeyOf(new Date(renderNowMs));
      setMeraPrevNet(previousMonthNet(snapshots, monthKey, meraPrimary.currency));
      localStorage.setItem(NET_SNAPSHOTS_KEY, JSON.stringify(upsertSnapshot(snapshots, monthKey, meraTotals)));
    } catch (err) {
      console.error("net snapshot failed (non-fatal)", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, meraPrimary?.currency]);
  const getMonthStats = (accountId: string) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTxns = transactions.filter(
      (t) => new Date(t.createdAt) >= startOfMonth,
    );
    const income = monthTxns
      .filter(
        (t) => t.type === "income" && t.destinationAccountId === accountId,
      )
      .reduce((s, t) => s + t.amount, 0);
    const expense = monthTxns
      .filter((t) => t.type === "expense" && t.sourceAccountId === accountId)
      .reduce((s, t) => s + t.amount, 0);
    return income > 0 || expense > 0 ? { income, expense } : null;
  };
  const activeLoans = loans.filter((l) => l.status === "active");

  // Proactive coach cards — deterministic insights from data we already have.
  const coachCards = useMemo(() => {
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expectedPct = (dayOfMonth / daysInMonth) * 100;
    const dayMs = 86400000;

    const budgetOver = budgetUsages
      .filter((u) => u.overLimit)
      .map((u) => ({ category: u.budget.category, amount: Math.abs(u.remaining), currency: u.budget.currency }));
    const budgetPace = budgetUsages
      .filter((u) => !u.overLimit && u.percent >= 50 && u.percent > expectedPct + 15)
      .map((u) => ({ category: u.budget.category, pct: Math.round(u.percent), daysLeft: daysInMonth - dayOfMonth }));

    // Top expense category this month (primary currency).
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const catMap = new Map<string, { count: number; amount: number }>();
    for (const tx of transactions) {
      if (tx.type !== "expense" || tx.currency !== primaryCurrency || new Date(tx.createdAt) < monthStart) continue;
      const key = tx.category || "Other";
      const e = catMap.get(key) ?? { count: 0, amount: 0 };
      e.count += 1; e.amount += tx.amount; catMap.set(key, e);
    }
    const topEntry = [...catMap.entries()].sort((a, b) => b[1].amount - a[1].amount)[0];
    const topCategory = topEntry ? { category: topEntry[0], count: topEntry[1].count, amount: topEntry[1].amount, currency: primaryCurrency } : null;

    // Recurring renewals within 5 days.
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const soon = recurringTemplates.filter((r) => {
      if (!r.active) return false;
      const due = new Date(r.nextDueDate).getTime();
      return due >= todayStart && due - todayStart <= 5 * dayMs;
    });
    const renewalsSoon = soon.length > 0
      ? { count: soon.length, amount: soon.filter((r) => r.currency === primaryCurrency).reduce((s, r) => s + r.amount, 0), currency: primaryCurrency }
      : null;

    // Overdue receivables: distinct people with active given loans older than 14 days.
    const cutoff = now.getTime() - 14 * dayMs;
    const overduePeople = new Set(
      loans
        .filter((l) => l.status === "active" && l.type === "given" && l.remainingAmount > 0 && new Date(l.createdAt).getTime() < cutoff)
        .map((l) => l.personId ?? l.personName.trim().toLowerCase()),
    );

    const lastTs = transactions.reduce((max, tx) => Math.max(max, new Date(tx.createdAt).getTime()), 0);
    const daysSinceLastEntry = lastTs > 0 ? Math.floor((now.getTime() - lastTs) / dayMs) : null;

    return buildCoachCards({
      budgetOver, budgetPace, renewalsSoon, topCategory,
      overdueReceivableCount: overduePeople.size, goalsBehind: [], daysSinceLastEntry,
    });
  }, [budgetUsages, transactions, primaryCurrency, recurringTemplates, loans]);

  // Distinct people who still have an open balance — drives the Contacts
  // quick-tile badge (an "unsettled" count). Keyed by personId when present,
  // else by normalised name so name-only loans still de-dupe.
  const unsettledContactCount = new Set(
    activeLoans.map((l) => l.personId ?? l.personName.trim().toLowerCase()),
  ).size;
  // Keep receivables/payables grouped by currency so AED and PKR don't merge.
  const sumLoansByCurrency = (items: typeof loans) =>
    items.reduce((acc, l) => {
      acc[l.currency] = (acc[l.currency] ?? 0) + l.remainingAmount;
      return acc;
    }, {} as Record<string, number>);
  const receivablesByCurrency = sumLoansByCurrency(
    activeLoans.filter((l) => l.type === "given"),
  );
  const payablesByCurrency = sumLoansByCurrency(
    activeLoans.filter((l) => l.type === "taken"),
  );
  // Order each currency list so the BIG number is the primary currency when
  // present, otherwise the largest balance. The runner-up (if any) is then
  // shown as a concrete amount line — no vague "+1 more ccy" jargon.
  const orderByPrimary = (entries: [string, number][]) =>
    [...entries].sort((a, b) => {
      if (a[0] === primaryCurrency) return -1;
      if (b[0] === primaryCurrency) return 1;
      return b[1] - a[1];
    });
  const receivableEntries = orderByPrimary(
    Object.entries(receivablesByCurrency).filter(([, v]) => v > 0),
  );
  const payableEntries = orderByPrimary(
    Object.entries(payablesByCurrency).filter(([, v]) => v > 0),
  );
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  if (mode === "splits_only") {
    const recvLoanCount = activeLoans.filter((l) => l.type === "given").length;
    const payLoanCount = activeLoans.filter((l) => l.type === "taken").length;
    // Pin the big number to the primary currency (fallback: largest), and
    // capture the runner-up currency as a concrete second amount.
    const orderByPrimaryCcy = (map: Record<string, number>) =>
      Object.entries(map)
        .filter(([, v]) => v > 0)
        .sort((a, b) => {
          if (a[0] === primaryCurrency) return -1;
          if (b[0] === primaryCurrency) return 1;
          return b[1] - a[1];
        });
    const recvOrdered = orderByPrimaryCcy(receivablesByCurrency);
    const payOrdered = orderByPrimaryCcy(payablesByCurrency);
    const recvPrimary = recvOrdered[0]?.[1] ?? 0;
    const recvPrimaryCur = recvOrdered[0]?.[0] ?? primaryCurrency;
    const recvSecond = recvOrdered[1] ?? null;
    const payPrimary = payOrdered[0]?.[1] ?? 0;
    const payPrimaryCur = payOrdered[0]?.[0] ?? primaryCurrency;
    const paySecond = payOrdered[1] ?? null;

    // Live people/group summary for the splits hero subtitle: how many
    // people still owe / are owed plus how many groups carry a balance.
    const splitsPeopleCount = activeLoans.length;
    const activeGroupCount = groups.filter(
      (g) => Math.abs(groupBalances[g.id] ?? 0) > 0,
    ).length;

    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <button
              onClick={() => navigate("/settings")}
              className="flex items-center gap-3 min-w-0 active:opacity-70"
              aria-label={t('a11y_open_settings')}
            >
              <UserAvatar name={userName} size={36} />
              <div className="text-left min-w-0">
                <p className="text-[11px] text-white/55 truncate">
                  {t('home_greeting_pre')}
                </p>
                <p className="text-[15px] font-semibold text-white tracking-tight truncate">
                  {userName}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowGlobalSearch(true)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label={t('a11y_search')}
              >
                <Search size={16} className="text-white" />
              </button>
              <InboxAction />
            </div>
          </div>

          <button
            onClick={() =>
              navigate(
                splitsPeopleCount > 0 ? "/loans" : activeGroupCount > 0 ? "/groups" : "/loans",
              )
            }
            className="block w-full text-left px-5 pb-7 active:opacity-80 transition-opacity"
          >
            <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
              {t('home_splits_badge')}
            </p>
            <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
              {t('home_splits_tagline')}
            </p>
            {/* Live summary from active loans + groups carrying a balance.
                Falls back to the static blurb when nothing is outstanding. */}
            {splitsPeopleCount > 0 || activeGroupCount > 0 ? (
              <p className="text-[12px] text-white/70 mt-2 max-w-[280px] leading-relaxed">
                {splitsPeopleCount > 0 &&
                  t('home_people_to_settle').replace('{n}', String(splitsPeopleCount))}
                {splitsPeopleCount > 0 && activeGroupCount > 0 && " · "}
                {activeGroupCount > 0 &&
                  t('home_groups_active').replace('{n}', String(activeGroupCount))}
              </p>
            ) : (
              <p className="text-[12px] text-white/55 mt-2 max-w-[280px] leading-relaxed">
                {t('home_splits_blurb')}
              </p>
            )}
          </button>
        </NavyHero>

        <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
          {loadStatus === "error" ? (
            <PageErrorState
              message={loadError ?? t('err_some_data_failed')}
              onRetry={retryLoad}
            />
          ) : isInitialLoading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[18px] bg-cream-card border border-cream-border h-24 animate-pulse" />
                <div className="rounded-[18px] bg-cream-card border border-cream-border h-24 animate-pulse" />
              </div>
              <div className="rounded-[18px] bg-cream-card border border-cream-border h-32 animate-pulse" />
            </div>
          ) : (
            <>
              {receivableEntries.length === 0 && payableEntries.length === 0 ? (
                <div className="rounded-[18px] bg-cream-card border border-cream-border p-5 text-center">
                  <HandCoins size={26} className="text-accent-600 mx-auto" />
                  <p className="font-semibold text-ink-900 mt-2">
                    {t('home_no_ious')}
                  </p>
                  <p className="text-[12px] text-ink-500 mt-1">
                    {t('home_record_iou_hint')}
                  </p>
                  <button
                    onClick={() => setShowQuickEntry(true)}
                    className="mt-3 inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-2xl bg-accent-600 text-white text-[13px] font-semibold press"
                  >
                    <Plus size={15} strokeWidth={2.4} />
                    {t('home_record_iou_cta')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => navigate("/loans?tab=receivables")}
                    className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-7 h-7 rounded-lg bg-receive-100 flex items-center justify-center">
                        <ArrowDownLeft size={14} className="text-receive-text" />
                      </div>
                      <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                        {t('check_receivable')}
                      </p>
                    </div>
                    {recvLoanCount === 0 ? (
                      <>
                        <p className="text-[20px] font-semibold text-ink-300 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-400 mt-1">{t('home_no_one')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[20px] font-semibold text-receive-text tabular-nums tracking-tight">
                          {formatMoney(recvPrimary, recvPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-500 mt-1">
                          {recvSecond
                            ? `+ ${formatMoney(recvSecond[1], recvSecond[0])}`
                            : recvLoanCount === 1
                            ? t('common_loan_one')
                            : t('common_loan_many').replace('{n}', String(recvLoanCount))}
                        </p>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => navigate("/loans?tab=payables")}
                    className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-7 h-7 rounded-lg bg-pay-100 flex items-center justify-center">
                        <ArrowUpRight size={14} className="text-pay-text" />
                      </div>
                      <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                        {t('check_payable')}
                      </p>
                    </div>
                    {payLoanCount === 0 ? (
                      <>
                        <p className="text-[20px] font-semibold text-ink-300 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-400 mt-1">{t('home_no_one')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[20px] font-semibold text-pay-text tabular-nums tracking-tight">
                          {formatMoney(payPrimary, payPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-500 mt-1">
                          {paySecond
                            ? `+ ${formatMoney(paySecond[1], paySecond[0])}`
                            : payLoanCount === 1
                            ? t('common_loan_one')
                            : t('common_loan_many').replace('{n}', String(payLoanCount))}
                        </p>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Splits-only quick-action shortcuts. Since this mode has no
                  accounts/transactions surfaces, surface the remaining
                  browse destinations (Contacts, Activity) directly on home
                  so they're not buried in Settings. */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => navigate("/contacts")}
                  className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
                >
                  <div className="w-9 h-9 rounded-xl bg-accent-50 flex items-center justify-center mb-2.5">
                    <Contact size={16} className="text-accent-600" />
                  </div>
                  <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                    {t('splits_home_contacts')}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    {t('splits_home_contacts_sub')}
                  </p>
                </button>
                <button
                  onClick={() => navigate("/activity")}
                  className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
                >
                  <div className="w-9 h-9 rounded-xl bg-info-50 flex items-center justify-center mb-2.5">
                    <History size={16} className="text-info-600" />
                  </div>
                  <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                    {t('splits_home_activity')}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    {t('splits_home_activity_sub')}
                  </p>
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2.5 px-1">
                  <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    {t('home_group_splits')}
                  </h2>
                  <button
                    onClick={() => navigate("/groups")}
                    className="text-[11px] font-semibold text-accent-600 active:opacity-70"
                  >
                    {t('common_view_all')}
                  </button>
                </div>
                {groups.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    tone="accent"
                    size="compact"
                    title={t('home_no_splits_title')}
                    description={t('home_no_splits_desc')}
                    subhint={t('home_no_splits_subhint')}
                  />
                ) : (
                  <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                    {groups.slice(0, 3).map((group) => {
                      const balance = groupBalances[group.id] ?? 0;
                      return (
                        <button
                          key={group.id}
                          onClick={() => navigate(`/group/${group.id}`)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
                        >
                          <div className="w-9 h-9 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0 text-base">
                            {group.emoji}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
                              {group.name}
                            </p>
                            <p className="text-[11px] text-ink-500 mt-0.5">
                              {group.members.length === 1
                                ? t('common_member_one')
                                : t('common_member_many').replace('{n}', String(group.members.length))}
                            </p>
                          </div>
                          <p
                            className={`text-[13px] font-semibold tabular-nums ${
                              balance > 0
                                ? "text-receive-text"
                                : balance < 0
                                ? "text-pay-text"
                                : "text-ink-400"
                            }`}
                          >
                            {balance === 0
                              ? t('settled')
                              : `${balance > 0 ? "+" : "−"}${formatMoney(
                                  Math.abs(balance),
                                  group.currency,
                                )}`}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-[18px] bg-info-50 border border-cream-border p-4">
                <p className="text-[12px] text-info-600 leading-relaxed">
                  {t('home_notify_needs_app')}
                </p>
              </div>
            </>
          )}
        </div>
        <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} />
        <QuickEntry open={showQuickEntry} onClose={() => setShowQuickEntry(false)} />
      </main>
    );
  }

  const hour = new Date().getHours();
  // Greeting follows the selected language: neutral English ("Good Morning")
  // vs Roman Urdu ("Subah Bakhair"). Keys live in i18n.ts.
  const greeting = t(
    hour < 5
      ? "greet_night"
      : hour < 12
      ? "greet_morning"
      : hour < 17
      ? "greet_afternoon"
      : hour < 21
      ? "greet_evening"
      : "greet_night",
  );
  const greetingEmoji =
    hour < 5
      ? "\u{1F319}"
      : hour < 12
      ? "\u{1F305}"
      : hour < 17
      ? "\u{2600}\u{FE0F}"
      : hour < 21
      ? "\u{1F306}"
      : "\u{1F319}";

  // Upcoming expense reminders — within their reminder window
  const urgentExpenses = expenses
    .filter(
      (e) => e.status === "upcoming" && !dismissedReminders.includes(e.id),
    )
    .filter((e) => {
      const daysLeft = Math.ceil(
        (new Date(e.dueDate).getTime() - renderNowMs) / (1000 * 60 * 60 * 24),
      );
      const reminderWindow = e.reminderDaysBefore ?? 7;
      return daysLeft <= reminderWindow;
    })
    .sort(
      (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
    );

  const primaryTotal = totals[primaryCurrency] ?? 0;
  const accountCount = accounts.length;
  // Show ALL non-primary currency lines — including negatives. Hiding the
  // negatives understated the user's liabilities (e.g. a PKR credit card
  // owed) and made the net-worth line read more positive than reality.
  const otherTotals = Object.entries(totals).filter(
    ([cur, amt]) => cur !== primaryCurrency && amt !== 0,
  );
  const budgetAttentionCount = budgetUsages.filter((usage) => usage.overWarn).length;

  // Does the concrete BudgetWarningBanner actually render? It self-hides for
  // the session via this sessionStorage flag. We mirror the check here so the
  // NextStepHint never duplicates a banner that's already on screen, and so
  // the attention-banner cap counts only what's truly visible.
  const budgetBannerDismissed = (() => {
    try {
      return sessionStorage.getItem("hisaab_budget_warning_dismissed_v1") === "1";
    } catch {
      return false;
    }
  })();
  const budgetBannerVisible = budgetAttentionCount > 0 && !budgetBannerDismissed;

  // De-dup: the urgent-expense strip and BudgetWarningBanner are concrete UI
  // that already speak for those signals. When either is on screen we suppress
  // the matching NextStepHint branch so each alert appears exactly once. The
  // hint is then reserved for onboarding ("no activity yet") and the calm
  // "all up to date" state — and that calm state is hidden whenever any real
  // attention banner is showing.
  const hasUrgentStrip = urgentExpenses.length > 0;
  const hasAttentionBanner =
    hasUrgentStrip || budgetBannerVisible || overdueNudges.length > 0;

  // Cap simultaneous attention banners at 2 (priority: time-sensitive bills →
  // budget → settlement nudges). Anything beyond the first two collapses into
  // a single "N more reminders" chip so the home feed never stacks a wall of
  // amber cards. The chip routes to the most relevant overflow destination.
  const ATTENTION_CAP = 2;
  const activeBanners: { key: "urgent" | "budget" | "settlement"; href: string }[] = [];
  if (hasUrgentStrip) activeBanners.push({ key: "urgent", href: "/subscriptions" });
  if (budgetBannerVisible) activeBanners.push({ key: "budget", href: "/budgets" });
  if (overdueNudges.length > 0) activeBanners.push({ key: "settlement", href: "/inbox" });
  const shownBannerKeys = new Set(activeBanners.slice(0, ATTENTION_CAP).map((b) => b.key));
  const collapsedBanners = activeBanners.slice(ATTENTION_CAP);
  const collapsedReminderHref = collapsedBanners[0]?.href ?? "/";

  const homeHint =
    // The Getting Started card covers the no-account and no-transaction cases.
    accountCount === 0 || transactions.length === 0
      ? null
      : hasAttentionBanner
      ? // A concrete strip/banner is already covering the active signal(s) —
        // don't echo it as a hint. (Kept null rather than removed so the
        // "all up to date" branch below can't fire alongside an alert.)
        null
      : {
          icon: CheckCircle2,
          tone: "receive" as const,
          status: "Your dashboard is up to date.",
          next: "Keep adding transactions as they happen, or use Search to quickly find an older account, person, or expense.",
        };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        {/* Greeting row: avatar (-> Settings) + bell (-> Inbox) */}
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
          <button
            onClick={() => navigate("/settings")}
            className="flex items-center gap-3 min-w-0 active:opacity-70"
            aria-label={t('a11y_open_settings')}
          >
            <UserAvatar name={userName} size={36} />
            <div className="text-left min-w-0">
              <p className="text-[11px] text-white/55 truncate">
                {greeting} {greetingEmoji}
              </p>
              <p className="text-[15px] font-semibold text-white tracking-tight truncate">
                {userName}
              </p>
            </div>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowGlobalSearch(true)}
              className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
              aria-label={t('a11y_search')}
            >
              <Search size={16} className="text-white" />
            </button>
            <InboxAction />
          </div>
        </div>

        {/* Net worth display. Tap (when accounts exist) -> /accounts. */}
        <button
          onClick={() => accountCount > 0 && navigate('/accounts')}
          disabled={accountCount === 0}
          className="block w-full text-left px-5 pb-7 disabled:cursor-default active:opacity-80 transition-opacity"
        >
          <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
            {t('home_your_money')}
          </p>
          {isInitialLoading ? (
            <div className="mt-1.5 h-12 w-48 rounded-xl bg-white/10 animate-pulse" />
          ) : accountCount === 0 ? (
            <>
              <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
                {t('home_no_accounts_title')}
              </p>
              <p className="text-[12px] text-white/55 mt-1.5 max-w-[260px] leading-relaxed">
                {t('home_no_accounts_hero_desc')}
              </p>
            </>
          ) : (
            <>
              <div className="mt-1.5 flex items-center gap-1.5">
                {/* The one number the whole app is about. It counts up on
                    reveal and travels on change, so a balance that moved
                    SHOWS that it moved instead of silently being different.
                    AnimatedMoney is a leaf on purpose — see its header;
                    putting the rAF loop here would re-render this page ~50
                    times per run. */}
                <AnimatedMoney
                  amount={primaryTotal}
                  currency={primaryCurrency}
                  size={42}
                  tone="on-navy"
                  animate={!isInitialLoading}
                />
                {/* Non-colour liability cue: down-caret + word so a negative
                    net worth never relies on the minus sign alone. */}
                {primaryTotal < 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-white/12 px-1.5 py-0.5 text-[10px] font-semibold text-white/80">
                    <ChevronDown size={11} strokeWidth={2.6} />
                    {t('home_owed')}
                  </span>
                )}
              </div>
              {primaryTotal < 0 && (
                <p className="text-[10px] text-white/55 mt-1">
                  {t('home_net_liab')}
                </p>
              )}
              <p className="text-[12px] text-white/55 mt-2">
                {accountCount === 1
                  ? t('common_account_one')
                  : t('common_account_many').replace('{n}', String(accountCount))}
                {otherTotals.length > 0 && (
                  <>
                    {" · "}
                    {otherTotals
                      .map(([cur, amt]) => `${formatMoney(amt, cur)}`)
                      .join(" · ")}
                  </>
                )}
              </p>
            </>
          )}
        </button>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Load-failure banner. Stays visible until retry succeeds. */}
        {loadStatus === "error" && (
          <PageErrorState
            variant="inline"
            title={t('home_err_dashboard')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* First-load skeleton — never flash "Add an account" / quick tiles
            empty state before the accounts query finishes. */}
        {isInitialLoading && (
          <div className="space-y-4" aria-hidden="true">
            <div className="rounded-[18px] bg-cream-card border border-cream-border h-20 animate-pulse" />
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[18px] bg-cream-card border border-cream-border h-24 animate-pulse" />
              <div className="rounded-[18px] bg-cream-card border border-cream-border h-24 animate-pulse" />
            </div>
            <div className="rounded-[20px] bg-cream-card border border-cream-border h-32 animate-pulse" />
          </div>
        )}

        {/* Guided first-win: add an account, then log the first entry. Shows
            progress and disappears once both are done. */}
        {dataReady && (accountCount === 0 || transactions.length === 0) && (
          <GettingStartedCard
            accountCount={accountCount}
            transactionCount={transactions.length}
            onAddAccount={() => setShowAddAccount(true)}
            onLogEntry={() => navigate("/transactions")}
          />
        )}

        {/* Proactive coach — surfaces what needs attention (over budget,
            overdue money, renewals…) for users who are past setup. */}
        {dataReady && accountCount > 0 && transactions.length > 0 && (
          <CoachCards cards={coachCards} />
        )}

        {/* 2-up: To Receive | To Pay */}
        {accountCount > 0 && (hasReceivables || hasPayables) && (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => navigate("/loans?tab=receivables")}
              className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <div className="w-7 h-7 rounded-lg bg-receive-100 flex items-center justify-center">
                  <ArrowDownLeft size={14} className="text-receive-text" />
                </div>
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                  {t("loan_receivable")}
                </p>
              </div>
              {hasReceivables ? (
                <>
                  <p className="text-[20px] font-semibold text-receive-text tabular-nums tracking-tight">
                    {formatMoney(
                      receivableEntries[0][1],
                      receivableEntries[0][0],
                    )}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-1">
                    {receivableEntries.length > 1
                      ? `+ ${formatMoney(
                          receivableEntries[1][1],
                          receivableEntries[1][0],
                        )}`
                      : receivableEntries[0][0]}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[20px] font-semibold text-ink-300 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1">{t('home_no_one')}</p>
                </>
              )}
            </button>
            <button
              onClick={() => navigate("/loans?tab=payables")}
              className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <div className="w-7 h-7 rounded-lg bg-pay-100 flex items-center justify-center">
                  <ArrowUpRight size={14} className="text-pay-text" />
                </div>
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                  {t("loan_payable")}
                </p>
              </div>
              {hasPayables ? (
                <>
                  <p className="text-[20px] font-semibold text-pay-text tabular-nums tracking-tight">
                    {formatMoney(payableEntries[0][1], payableEntries[0][0])}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-1">
                    {payableEntries.length > 1
                      ? `+ ${formatMoney(
                          payableEntries[1][1],
                          payableEntries[1][0],
                        )}`
                      : payableEntries[0][0]}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[20px] font-semibold text-ink-300 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1">{t('home_no_one')}</p>
                </>
              )}
            </button>
          </div>
        )}

        {/* Quick-access tile grid — Careem-inspired layout.
            Each tile is its OWN filled card (cream-soft bg) with a big
            colored icon at the top and the label pinned at the bottom.
            Hierarchy: outer cream-card wrapper → inner cream-soft tile
            cards, mirroring Careem's "white card with grey tiles nested"
            pattern. Colors stay in the Sukoon palette — only the icon
            glyph carries the tone; the tile chrome stays neutral. */}
        {accountCount > 0 && (
          <div className="rounded-[20px] bg-cream-card border border-cream-border p-2.5">
            <div className="grid grid-cols-4 gap-2">
              <QuickTile
                label={t("nav_goals")}
                icon={Target}
                iconClass="text-accent-600"
                onClick={() => navigate("/goals")}
              />
              <QuickTile
                label="Budget"
                icon={Wallet2}
                iconClass="text-receive-text"
                badge={budgetAttentionCount}
                badgeBgClass="bg-receive-50"
                onClick={() => navigate("/budgets")}
              />
              <QuickTile
                label="Subscriptions"
                icon={CreditCard}
                iconClass="text-info-600"
                badge={subscriptionsDueSoon}
                badgeBgClass="bg-info-50"
                onClick={() => navigate("/subscriptions")}
              />
              <QuickTile
                label={t("analytics_title")}
                icon={BarChart3}
                iconClass="text-pay-text"
                onClick={() => navigate("/analytics")}
              />
              <QuickTile
                label="Activity"
                icon={History}
                iconClass="text-ink-700"
                onClick={() => navigate("/activity")}
              />
              <QuickTile
                label="Contacts"
                icon={Contact}
                iconClass="text-warn-600"
                badge={unsettledContactCount}
                badgeBgClass="bg-warn-50"
                badgeTextClass="text-warn-700"
                onClick={() => navigate("/contacts")}
              />
              <QuickTile
                label={t("kameti_title")}
                icon={Coins}
                iconClass="text-accent-600"
                onClick={() => navigate("/kameti")}
              />
              <QuickTile
                label={t("inv_title")}
                icon={TrendingUp}
                iconClass="text-receive-text"
                onClick={() => navigate("/investments")}
              />
            </div>
          </div>
        )}

        {/* "Mera Hisaab" — one net-position number that includes PEOPLE:
            accounts (cards as −owed) + what people owe you − what you owe.
            Loans as balance-sheet items is THE differentiator, visible
            daily; settling a loan visibly moves this number. */}
        {dataReady && meraPrimary && (loans.length > 0 || accounts.length > 0) && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-4">
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] flex items-center gap-1.5">
                <Scale size={11} /> {t("home_mera_hisaab")}
              </h2>
              {meraPrevNet !== null && Math.abs(meraPrimary.net - meraPrevNet) > 0.005 && (
                <span className={`text-[10.5px] font-semibold tabular-nums ${meraPrimary.net >= meraPrevNet ? "text-receive-text" : "text-pay-text"}`}>
                  {meraPrimary.net >= meraPrevNet ? "▲" : "▼"} {formatMoney(Math.abs(meraPrimary.net - meraPrevNet), meraPrimary.currency)} · {t("mh_vs_last")}
                </span>
              )}
            </div>
            <p className={`text-[24px] font-semibold tabular-nums tracking-tight ${meraPrimary.net < 0 ? "text-pay-text" : "text-ink-900"}`}>
              {formatSignedMoney(meraPrimary.net, meraPrimary.currency)}
            </p>
            {(meraPrimary.receivable > 0.005 || meraPrimary.payable > 0.005) && (
              <p className="text-[11px] text-ink-500 mt-1 tabular-nums">
                {meraPrimary.receivable > 0.005 && (
                  <span className="text-receive-text font-medium">
                    {t("mh_receivable")} +{formatMoney(meraPrimary.receivable, meraPrimary.currency)}
                  </span>
                )}
                {meraPrimary.receivable > 0.005 && meraPrimary.payable > 0.005 && <span> · </span>}
                {meraPrimary.payable > 0.005 && (
                  <span className="text-pay-text font-medium">
                    {t("mh_payable")} −{formatMoney(meraPrimary.payable, meraPrimary.currency)}
                  </span>
                )}
              </p>
            )}
            {meraTotals.length > 1 && (
              <p className="text-[10.5px] text-ink-400 mt-1 tabular-nums">
                {meraTotals
                  .filter((entry) => entry.currency !== meraPrimary.currency)
                  .map((entry) => formatSignedMoney(entry.net, entry.currency))
                  .join(" · ")}
              </p>
            )}
          </div>
        )}

        {/* Investment Tracker — the record-keeping investments, surfaced
            instead of invisible. One tappable row PER MARKET, each landing
            scoped on its own market; the header opens the full book. Only
            renders when something is actually held. */}
        {dataReady && invMarketRows.length > 0 && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden">
            <button
              onClick={() => navigate("/investments")}
              className="w-full flex items-center justify-between px-4 pt-3.5 pb-2 text-left active:bg-cream-soft transition-colors"
            >
              {/* span, not h2 — heading content inside a <button> is invalid
                  and vanishes from the screen-reader outline anyway. */}
              <span className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] flex items-center gap-1.5">
                <TrendingUp size={11} /> {t("inv_title")}
              </span>
              <ChevronRight size={14} className="text-ink-300" />
            </button>
            <div className="divide-y divide-cream-hairline">
              {invMarketRows.map(({ market, bucket: b }) => {
                const color = marketColorFor(market.id);
                // Unpriced holdings sit at COST inside currentValue — disclose
                // it (like the Investment Tracker page does) and never dress an
                // entirely-unpriced bucket in a P&L line it doesn't have.
                const allUnpriced = b.unpricedCount > 0 && Math.abs(b.unrealized) < 0.005;
                const pct = b.invested > 0 ? (b.unrealized / b.invested) * 100 : 0;
                // Sign from the ROUNDED value: -0.004% must read 0.0, not -0.0.
                const pctStr = Math.abs(pct) < 0.05 ? "0.0" : pct.toFixed(1);
                const up = b.unrealized >= 0;
                return (
                  <button
                    key={market.id}
                    onClick={() => navigate(`/investments?market=${market.id}`)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-2 h-2 rounded-full ${color.dot} shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-ink-900 truncate tracking-tight">{market.name}</p>
                        <p className="text-[10.5px] text-ink-400">{market.currency}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[15px] font-semibold tabular-nums tracking-tight text-ink-900">
                        {formatMoney(b.currentValue, market.currency)}
                      </p>
                      {allUnpriced ? (
                        <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
                          {t("inv_unpriced_chip").replace("{n}", String(b.unpricedCount))}
                        </p>
                      ) : (
                        <p className={`text-[10.5px] font-medium mt-0.5 tabular-nums ${up ? "text-receive-text" : "text-pay-text"}`}>
                          {up ? "▲" : "▼"} {formatMoney(Math.abs(b.unrealized), market.currency)} · {pctStr.startsWith("-") ? "" : "+"}{pctStr}%
                          {b.unpricedCount > 0 && (
                            <span className="text-ink-400 font-normal"> · {t("inv_unpriced_chip").replace("{n}", String(b.unpricedCount))}</span>
                          )}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Weekly ritual + needs-action queue — the review-ceremony entry.
            Top row opens the 5-minute Hisaab check (with its days-since
            memory); the count row appears only when something actually
            needs a hand (overdue EMIs, missed recurring, kameti rounds,
            unfiled expenses) and lands on the Inbox "To-do" tab. */}
        {dataReady && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
            <button
              onClick={() => setShowCheck(true)}
              className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left active:bg-cream-soft transition-colors"
            >
              {/* Done-today wears a live green tick + praise; otherwise the
                  neutral clipboard nudge. A ritual should feel rewarding the
                  day you keep it, not like a dead status line. */}
              <div className={`w-8 h-8 rounded-lg border border-cream-hairline flex items-center justify-center shrink-0 ${checkDays === 0 ? "bg-receive-50" : "bg-accent-50"}`}>
                {checkDays === 0
                  ? <CheckCircle2 size={16} className="text-receive-text" strokeWidth={2.4} />
                  : <ClipboardCheck size={15} className="text-accent-600" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-ink-900 tracking-tight">{t("check_entry_title")}</p>
                <p className={`text-[10.5px] leading-tight ${checkDays === 0 ? "text-receive-text font-semibold" : "text-ink-500"}`}>
                  {checkDays === null
                    ? t("check_entry_never")
                    : checkDays === 0
                      ? t("check_entry_today")
                      : checkDays === 1
                        ? t("check_entry_days_one")
                        : t("check_entry_days").replace("{d}", String(checkDays))}
                </p>
              </div>
              <ChevronRight size={15} className="text-ink-300 shrink-0" />
            </button>
            {needsActionCount > 0 && (
              <button
                onClick={() => navigate("/inbox", { state: { tab: "action" } })}
                className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left active:bg-cream-soft transition-colors"
              >
                <span className="w-8 h-8 rounded-lg bg-warn-50 border border-cream-hairline flex items-center justify-center shrink-0 text-warn-700 text-[12px] font-bold tabular-nums">
                  {needsActionCount > 9 ? "9+" : needsActionCount}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                    {needsActionCount === 1
                      ? t("home_action_one")
                      : t("home_action_many").replace("{n}", String(needsActionCount))}
                  </p>
                  <p className="text-[10.5px] text-ink-500 leading-tight">{t("home_action_sub")}</p>
                </div>
                <ChevronRight size={15} className="text-ink-300 shrink-0" />
              </button>
            )}
          </div>
        )}

        {/* "This week" — every KNOWN obligation in the next 7 days, merged:
            EMIs, kameti rounds, recurring charges, bills, card due days.
            The forward view no bank-sync app can match, from data Hisaab
            uniquely holds. Hidden when the week is clear (no noise). */}
        {dataReady && thisWeekRows.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_this_week")}
              </h2>
              {thisWeekOut && (
                <span className="text-[10.5px] font-semibold text-pay-text tabular-nums">
                  {t("home_week_out").replace("{amount}", formatMoney(thisWeekOut.out, thisWeekOut.currency))}
                </span>
              )}
            </div>
            <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
              {thisWeekRows.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(row.href)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-cream-soft transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
                    {row.sub.kind === "cleared" ? (
                      <CheckCircle2 size={14} className="text-receive-text" />
                    ) : (
                      <CalendarClock size={14} className={row.daysUntil <= 1 ? "text-warn-600" : "text-ink-500"} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">{row.label}</p>
                    <p className={`text-[10.5px] leading-tight ${row.sub.kind === "cleared" ? "text-receive-text font-medium" : "text-ink-500"}`}>
                      {(() => {
                        // Structured sub → translated line (the lib stays
                        // i18n-free). 'none' rows show only the due phrase.
                        if (row.sub.kind === "cleared") {
                          return row.sub.daysEarly === 0
                            ? t("tw_cleared_today")
                            : t("tw_cleared").replace("{n}", String(row.sub.daysEarly));
                        }
                        const sub =
                          row.sub.kind === "emi" ? `EMI #${row.sub.n}`
                          : row.sub.kind === "round" ? (
                              row.sub.count > 1
                                ? t("tw_rounds_count").replace("{c}", String(row.sub.count))
                                : t("kameti_round_of").replace("{r}", String(row.sub.r)).replace("{n}", String(row.sub.total))
                            )
                          : row.sub.kind === "cadence" ? t(`tw_cad_${row.sub.cadence}` as Parameters<typeof t>[0])
                          : row.sub.kind === "category" ? row.sub.text
                          : null;
                        const due = row.daysUntil === 0 ? t("cc_due_today") : t("cc_due_in").replace("{n}", String(row.daysUntil));
                        return sub ? `${sub} · ${due}` : due;
                      })()}
                    </p>
                  </div>
                  {row.amount !== null && (
                    <p className={`text-[13px] font-semibold tabular-nums tracking-tight ${row.direction === "receive" ? "text-receive-text" : "text-ink-900"}`}>
                      {row.direction === "receive" ? "+" : ""}{formatMoney(row.amount, row.currency)}
                    </p>
                  )}
                </button>
              ))}
            </div>
            {thisWeekRows.length > 5 && (
              <p className="text-[10.5px] text-ink-400 mt-1.5 px-1">
                {t("home_week_more").replace("{n}", String(thisWeekRows.length - 5))}
              </p>
            )}
          </div>
        )}

        {/* Pending strip — urgent upcoming expenses. */}
        {dataReady && homeHint && (
          <NextStepHint
            icon={homeHint.icon}
            tone={homeHint.tone}
            status={homeHint.status}
            next={homeHint.next}
          />
        )}

        {shownBannerKeys.has("urgent") && (
          <div className="space-y-2">
            {urgentExpenses.slice(0, 2).map((exp) => {
              const daysLeft = Math.ceil(
                (new Date(exp.dueDate).getTime() - renderNowMs) /
                  (1000 * 60 * 60 * 24),
              );
              return (
                <div
                  key={exp.id}
                  className="rounded-[18px] bg-warn-50 border border-cream-border p-4 flex items-center gap-3"
                >
                  <div className="w-9 h-9 rounded-xl bg-warn-50 border border-warn-50 flex items-center justify-center shrink-0">
                    <span className="text-base">&#x23f0;</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-ink-900 truncate">
                      {exp.title} — {formatMoney(exp.amount, exp.currency)}
                    </p>
                    <p className="text-[11px] text-warn-600 mt-0.5">
                      {daysLeft <= 0
                        ? t('home_overdue_bang')
                        : daysLeft === 1
                        ? t('home_due_tomorrow')
                        : `${daysLeft} ${t("upcoming_due_in")}`}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setDismissedReminders((d) => [...d, exp.id])
                    }
                    className='relative w-7 h-7 rounded-lg flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors shrink-0 before:absolute before:-inset-2 before:content-[""]'
                    aria-label={t('a11y_dismiss')}
                  >
                    &#x2715;
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Accounts preview — max 3 rows. "See all" wires to /accounts in
            the next slice; for now the inline Add button is the entry. */}
        {accountCount > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_accounts")} · {accountCount}
              </h2>
              <button
                onClick={() => setShowAddAccount(true)}
                className="text-[11px] text-accent-600 font-semibold active:opacity-70 flex items-center gap-1"
                aria-label={t('a11y_add_account')}
              >
                <Plus size={12} strokeWidth={2.5} /> {t('common_add')}
              </button>
            </div>
            <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
              {accounts.slice(0, 3).map((a) => {
                const meta = currencyMeta[a.currency];
                const monthStats = getMonthStats(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => navigate(`/account/${a.id}`)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-cream-soft transition-colors"
                  >
                    <div className="w-8 h-8 rounded-lg bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
                      <Landmark size={14} className="text-ink-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">
                        {a.name}
                      </p>
                      <p className="text-[10.5px] text-ink-500 leading-tight">
                        {a.type.replace(/_/g, " ")}
                        {monthStats && (
                          <span className="text-receive-text font-medium">
                            {" · "}+{formatMoney(monthStats.income, a.currency)}{" "}
                            {t('home_month_in_suffix')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-[13px] font-semibold tabular-nums tracking-tight leading-tight ${a.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
                        {formatMoney(a.balance, a.currency)}
                      </p>
                      <p className="text-[9.5px] text-ink-400 leading-tight mt-0.5">
                        {meta?.flag} {a.currency}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
            {accounts.length > 3 && (
              <button
                onClick={() => navigate('/accounts')}
                className="w-full mt-2 text-center text-[11px] font-semibold text-accent-600 py-2 active:opacity-70"
              >
                {t('home_more_tap_manage').replace('{n}', String(accounts.length - 3))}
              </button>
            )}
          </div>
        )}

        {/* Empty-dashboard nudge — accounts exist but no transactions yet.
            Gated on dataReady so we don't flash this between the accounts
            load completing and the transactions load completing. */}
        {dataReady && accountCount > 0 && transactions.length === 0 && (
          <div className="rounded-[18px] bg-accent-50 border border-cream-border p-5 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-2xl bg-accent-100 flex items-center justify-center mb-3">
              <span className="text-2xl">&#x1f4b8;</span>
            </div>
            <p className="text-[14px] font-semibold text-ink-900 tracking-tight">
              {t("empty_dash_title")}
            </p>
            <p className="text-[12px] text-ink-500 mt-1 max-w-[240px] leading-relaxed">
              {t("empty_dash_desc")}
            </p>
            <div className="mt-4 flex items-center gap-1.5 text-accent-600">
              <span className="text-[11px] font-semibold">
                {t("empty_dash_tap")}
              </span>
              <span className="text-base">&#x2192;</span>
            </div>
          </div>
        )}

        {/* Budget warning — most-overspent category surfaces above the
            settlement nudges so the user sees the money decision first.
            Gated by the attention-banner cap (see shownBannerKeys). */}
        {shownBannerKeys.has("budget") && (
          <BudgetWarningBanner usages={budgetUsages} />
        )}

        {/* Settlement nudges — surface outgoing requests sitting >= 3 days.
            Renders nothing on empty so adjacent sections layout normally. */}
        {shownBannerKeys.has("settlement") && (
          <SettlementNudgeBanner nudges={overdueNudges} />
        )}

        {/* Overflow: when more than two attention signals are live, the rest
            collapse into one calm chip instead of stacking more cards. */}
        {collapsedBanners.length > 0 && (
          <button
            onClick={() => navigate(collapsedReminderHref)}
            className="w-full min-h-[44px] rounded-2xl bg-cream-card border border-cream-border px-4 flex items-center gap-2.5 text-left active:bg-cream-soft transition-colors"
          >
            <span className="w-7 h-7 rounded-full bg-warn-50 flex items-center justify-center shrink-0 text-warn-700 text-[11px] font-bold tabular-nums">
              {collapsedBanners.length}
            </span>
            <span className="text-[12px] font-semibold text-ink-700">
              {collapsedBanners.length === 1
                ? t('home_more_reminder_one')
                : t('home_more_reminders').replace('{n}', String(collapsedBanners.length))}
            </span>
            <ChevronRight size={15} className="text-ink-400 ml-auto shrink-0" />
          </button>
        )}

        {/* Recent Transactions */}
        {recentTxns.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_recent")}
              </h2>
              <button
                onClick={() => navigate("/transactions")}
                className="text-[11px] text-accent-600 font-semibold active:opacity-70"
              >
                {t("home_see_all")} &#x2192;
              </button>
            </div>
            <div className="rounded-[18px] bg-cream-card border border-cream-border px-4 divide-y divide-cream-hairline">
              {recentTxns.map((txn) => (
                <TransactionItem key={txn.id} transaction={txn} onClick={() => setSelectedTxn(txn)} />
              ))}
            </div>
          </div>
        )}
      </div>

      <AddAccountStepper
        open={showAddAccount}
        onClose={() => setShowAddAccount(false)}
      />
      <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} />
      <EditTransactionModal
        open={!!selectedTxn}
        transaction={selectedTxn}
        onClose={() => setSelectedTxn(null)}
      />
      <HisaabCheckModal
        open={showCheck}
        onClose={() => setShowCheck(false)}
        currency={meraPrimary?.currency ?? primaryCurrency}
        receivable={meraPrimary?.receivable ?? 0}
        payable={meraPrimary?.payable ?? 0}
        thisWeekRows={thisWeekRows}
        onStamped={(iso) => setCheckStampIso(iso)}
      />
    </main>
  );
}

// Careem-style quick-access tile. Each tile is its own filled card
// (cream-soft background, soft inset border) with the icon enlarged and
// the label sitting at the bottom of the card. The icon glyph carries
// the tile's color identity; the card chrome stays neutral so seven
// distinct tiles read as a single calm panel rather than a candy bar.
interface QuickTileProps {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  // Tailwind text-color class for the icon glyph. Tile background stays
  // neutral cream-soft across all tiles — only the icon carries the tone.
  iconClass: string;
  onClick: () => void;
  // Optional pending-state count. >0 renders a corner badge tinted to match
  // the icon (badgeBgClass) so the cue is never colour-only — it sits right
  // beside the same-hue glyph and carries the number itself. badgeTextClass
  // defaults to the icon tint but can override it for AA contrast on light
  // tints (e.g. warn-700 instead of warn-600 on warn-50).
  badge?: number;
  badgeBgClass?: string;
  badgeTextClass?: string;
}

function QuickTile({ label, icon: Icon, iconClass, onClick, badge = 0, badgeBgClass, badgeTextClass }: QuickTileProps) {
  return (
    <button
      onClick={onClick}
      className="relative aspect-square rounded-2xl bg-cream-soft border border-cream-hairline flex flex-col items-center justify-center gap-2 px-1.5 hover:bg-cream-card hover:border-cream-border hover:shadow-sm active:scale-[0.97] active:bg-cream-bg transition-all"
    >
      {badge > 0 && (
        <span
          className={`absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full ${badgeBgClass ?? "bg-warn-50"} ${badgeTextClass ?? iconClass} text-[10px] font-bold flex items-center justify-center tabular-nums ring-1 ring-white`}
        >
          {badge > 9 ? "9+" : badge}
        </span>
      )}
      <Icon size={26} className={iconClass} strokeWidth={1.7} />
      <span className="text-[10.5px] font-semibold text-ink-800 tracking-tight truncate max-w-full">
        {label}
      </span>
    </button>
  );
}
