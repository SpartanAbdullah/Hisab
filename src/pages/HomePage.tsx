import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  Wallet2,
  Plus,
  BarChart3,
  HandCoins,
  Users,
  Target,
  History,
  ChevronRight,
  Landmark,
  Contact,
  Repeat,
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
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { SettlementNudgeBanner } from "../components/SettlementNudgeBanner";
import { BudgetWarningBanner } from "../components/BudgetWarningBanner";
import { getOverdueSettlements } from "../lib/settlementNudges";
import { TransactionItem } from "../components/TransactionItem";
import { EmptyState } from "../components/EmptyState";
import { PageErrorState } from "../components/PageErrorState";
import { UserAvatar } from "../components/UserAvatar";
import { NavyHero } from "../components/NavyHero";
import { InboxAction } from "../components/InboxAction";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { GlobalSearch } from "../components/GlobalSearch";
import { NextStepHint } from "../components/NextStepHint";
import { AddAccountStepper } from "./AddAccountStepper";
import { formatMoney } from "../lib/constants";
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
  const [dismissedReminders, setDismissedReminders] = useState<string[]>([]);
  const [renderNowMs] = useState(() => Date.now());

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
  const receivableEntries = Object.entries(receivablesByCurrency).filter(
    ([, v]) => v > 0,
  );
  const payableEntries = Object.entries(payablesByCurrency).filter(
    ([, v]) => v > 0,
  );
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  if (mode === "splits_only") {
    const recvLoanCount = activeLoans.filter((l) => l.type === "given").length;
    const payLoanCount = activeLoans.filter((l) => l.type === "taken").length;
    const recvPrimary =
      receivablesByCurrency[primaryCurrency] ??
      Object.values(receivablesByCurrency)[0] ??
      0;
    const recvPrimaryCur = receivablesByCurrency[primaryCurrency] !== undefined
      ? primaryCurrency
      : Object.keys(receivablesByCurrency)[0] ?? primaryCurrency;
    const payPrimary =
      payablesByCurrency[primaryCurrency] ??
      Object.values(payablesByCurrency)[0] ??
      0;
    const payPrimaryCur = payablesByCurrency[primaryCurrency] !== undefined
      ? primaryCurrency
      : Object.keys(payablesByCurrency)[0] ?? primaryCurrency;

    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <button
              onClick={() => navigate("/settings")}
              className="flex items-center gap-3 min-w-0 active:opacity-70"
              aria-label="Open settings"
            >
              <UserAvatar name={userName} size={36} />
              <div className="text-left min-w-0">
                <p className="text-[11px] text-white/55 truncate">
                  Good to see you
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
                aria-label="Search"
              >
                <Search size={16} className="text-white" />
              </button>
              <InboxAction />
            </div>
          </div>

          <div className="px-5 pb-7">
            <p className="text-[10.5px] font-semibold text-white/50 tracking-[0.12em] uppercase">
              Splits only
            </p>
            <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
              Track people, not accounts.
            </p>
            <p className="text-[12px] text-white/55 mt-2 max-w-[280px] leading-relaxed">
              Loans and groups. No cash wallets, no bank balances.
            </p>
          </div>
        </NavyHero>

        <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
          {loadStatus === "error" ? (
            <PageErrorState
              message={loadError ?? "Some data failed to load."}
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
                    No IOUs yet
                  </p>
                  <p className="text-[12px] text-ink-500 mt-1">
                    Use the + button to record who owes whom.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => navigate("/loans?tab=receivables")}
                    className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-7 h-7 rounded-lg bg-receive-100 flex items-center justify-center">
                        <ArrowDownLeft size={14} className="text-receive-text" />
                      </div>
                      <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                        To receive
                      </p>
                    </div>
                    {recvLoanCount === 0 ? (
                      <>
                        <p className="text-[20px] font-semibold text-ink-300 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-400 mt-1">no one</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[20px] font-semibold text-receive-text tabular-nums tracking-tight">
                          {formatMoney(recvPrimary, recvPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-500 mt-1">
                          {recvLoanCount} {recvLoanCount === 1 ? "loan" : "loans"}
                        </p>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => navigate("/loans?tab=payables")}
                    className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-7 h-7 rounded-lg bg-pay-100 flex items-center justify-center">
                        <ArrowUpRight size={14} className="text-pay-text" />
                      </div>
                      <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">
                        To pay
                      </p>
                    </div>
                    {payLoanCount === 0 ? (
                      <>
                        <p className="text-[20px] font-semibold text-ink-300 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-400 mt-1">no one</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[20px] font-semibold text-pay-text tabular-nums tracking-tight">
                          {formatMoney(payPrimary, payPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-500 mt-1">
                          {payLoanCount} {payLoanCount === 1 ? "loan" : "loans"}
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
                  className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
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
                  className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
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
                    Group Splits
                  </h2>
                  <button
                    onClick={() => navigate("/groups")}
                    className="text-[11px] font-semibold text-accent-600 active:opacity-70"
                  >
                    View all
                  </button>
                </div>
                {groups.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    tone="accent"
                    size="compact"
                    title="No splits yet"
                    description="Create or join a group to split shared expenses."
                    subhint="Dinner, rent, trips — har kharcha barabar."
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
                              {group.members.length}{" "}
                              {group.members.length === 1 ? "member" : "members"}
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
                              ? "Settled"
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
                  To notify another person in Hisaab, they must also have the
                  app and share their code with you. Link them from Settings
                  &gt; Contacts.
                </p>
              </div>
            </>
          )}
        </div>
        <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} />
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
  const otherTotals = Object.entries(totals).filter(
    ([cur, amt]) => cur !== primaryCurrency && amt > 0,
  );
  const budgetAttentionCount = budgetUsages.filter((usage) => usage.overWarn).length;
  const homeHint =
    accountCount === 0
      ? null
      : transactions.length === 0
      ? {
          icon: Plus,
          tone: "accent" as const,
          status: "Accounts are ready, but there is no activity yet.",
          next: "Add your first income or expense so Hisaab can start showing spending flow, budgets, and recent activity.",
          actionLabel: "Add transaction",
          onAction: () => navigate("/transactions"),
        }
      : urgentExpenses.length > 0
      ? {
          icon: Repeat,
          tone: "warn" as const,
          status: `${urgentExpenses.length} upcoming payment ${urgentExpenses.length === 1 ? "needs" : "need"} attention.`,
          next: "Review the reminder strip below, then dismiss the ones you have already handled.",
        }
      : budgetAttentionCount > 0
      ? {
          icon: Wallet2,
          tone: "warn" as const,
          status: `${budgetAttentionCount} budget ${budgetAttentionCount === 1 ? "is" : "are"} near the warning line.`,
          next: "Open Budgets to adjust caps or check which categories are driving the month.",
          actionLabel: "Review budgets",
          onAction: () => navigate("/budgets"),
        }
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
            aria-label="Open settings"
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
              aria-label="Search"
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
            Your money
          </p>
          {isInitialLoading ? (
            <div className="mt-1.5 h-12 w-48 rounded-xl bg-white/10 animate-pulse" />
          ) : accountCount === 0 ? (
            <>
              <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
                No accounts yet
              </p>
              <p className="text-[12px] text-white/55 mt-1.5 max-w-[260px] leading-relaxed">
                Add an account to start tracking your balance and spending.
              </p>
            </>
          ) : (
            <>
              <div className="mt-1.5">
                <MoneyDisplay
                  amount={primaryTotal}
                  currency={primaryCurrency}
                  size={42}
                  tone="on-navy"
                />
              </div>
              <p className="text-[12px] text-white/55 mt-2">
                {accountCount} {accountCount === 1 ? "account" : "accounts"}
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
            title="Couldn't refresh your dashboard"
            message={loadError ?? "Some data failed to load."}
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

        {/* Add-account CTA when the user has zero accounts. */}
        {dataReady && accountCount === 0 && (
          <button
            onClick={() => setShowAddAccount(true)}
            className="w-full rounded-[18px] bg-cream-card border border-cream-border p-5 flex items-center gap-3 text-left active:scale-[0.99] transition-transform"
          >
            <div className="w-11 h-11 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
              <Wallet size={20} className="text-accent-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold text-ink-900 tracking-tight">
                {t("home_create_account")}
              </p>
              <p className="text-[12px] text-ink-500 mt-0.5">
                {t("home_no_accounts_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-400 shrink-0" />
          </button>
        )}

        {/* 2-up: To Receive | To Pay */}
        {accountCount > 0 && (hasReceivables || hasPayables) && (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => navigate("/loans?tab=receivables")}
              className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
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
                      ? `+ ${receivableEntries.length - 1} more ccy`
                      : `${receivableEntries[0][0]}`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[20px] font-semibold text-ink-300 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1">no one</p>
                </>
              )}
            </button>
            <button
              onClick={() => navigate("/loans?tab=payables")}
              className="rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.98] transition-transform"
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
                      ? `+ ${payableEntries.length - 1} more ccy`
                      : `${payableEntries[0][0]}`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[20px] font-semibold text-ink-300 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1">no one</p>
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
                onClick={() => navigate("/budgets")}
              />
              <QuickTile
                label="Subscriptions"
                icon={CreditCard}
                iconClass="text-info-600"
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
                onClick={() => navigate("/contacts")}
              />
            </div>
          </div>
        )}

        {/* Pending strip — urgent upcoming expenses. */}
        {dataReady && homeHint && (
          <NextStepHint
            icon={homeHint.icon}
            tone={homeHint.tone}
            status={homeHint.status}
            next={homeHint.next}
            actionLabel={homeHint.actionLabel}
            onAction={homeHint.onAction}
          />
        )}

        {urgentExpenses.length > 0 && (
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
                        ? "Overdue!"
                        : daysLeft === 1
                        ? "Kal dena hai!"
                        : `${daysLeft} ${t("upcoming_due_in")}`}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setDismissedReminders((d) => [...d, exp.id])
                    }
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors shrink-0"
                    aria-label="Dismiss"
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
                aria-label="Add account"
              >
                <Plus size={12} strokeWidth={2.5} /> Add
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
                            in
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
                {accounts.length - 3} more · tap to manage
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
            settlement nudges so the user sees the money decision first. */}
        <BudgetWarningBanner usages={budgetUsages} />

        {/* Settlement nudges — surface outgoing requests sitting >= 3 days.
            Renders nothing on empty so adjacent sections layout normally. */}
        <SettlementNudgeBanner nudges={overdueNudges} />

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
                <TransactionItem key={txn.id} transaction={txn} />
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
}

function QuickTile({ label, icon: Icon, iconClass, onClick }: QuickTileProps) {
  return (
    <button
      onClick={onClick}
      className="aspect-square rounded-2xl bg-cream-soft border border-cream-hairline flex flex-col items-center justify-center gap-2 px-1.5 active:scale-[0.97] active:bg-cream-bg transition-all"
    >
      <Icon size={26} className={iconClass} strokeWidth={1.7} />
      <span className="text-[10.5px] font-semibold text-ink-800 tracking-tight truncate max-w-full">
        {label}
      </span>
    </button>
  );
}
