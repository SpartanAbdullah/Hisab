import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  Plus,
  BarChart3,
  HandCoins,
  Users,
  Bell,
  Target,
  History,
  ChevronRight,
  Landmark,
  Contact,
} from "lucide-react";
import { useAccountStore } from "../stores/accountStore";
import { useTransactionStore } from "../stores/transactionStore";
import { useLoanStore } from "../stores/loanStore";
import { useGoalStore } from "../stores/goalStore";
import { useUpcomingExpenseStore } from "../stores/upcomingExpenseStore";
import { useAppModeStore } from "../stores/appModeStore";
import { useSplitStore } from "../stores/splitStore";
import { useLinkedRequestStore } from "../stores/linkedRequestStore";
import { useSettlementRequestStore } from "../stores/settlementRequestStore";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { TransactionItem } from "../components/TransactionItem";
import { EmptyState } from "../components/EmptyState";
import { PageErrorState } from "../components/PageErrorState";
import { UserAvatar } from "../components/UserAvatar";
import { NavyHero } from "../components/NavyHero";
import { MoneyDisplay } from "../components/MoneyDisplay";
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
  const [dismissedReminders, setDismissedReminders] = useState<string[]>([]);
  const [renderNowMs] = useState(() => Date.now());

  const userName = localStorage.getItem("hisaab_user_name") ?? "User";
  const primaryCurrency = localStorage.getItem("hisaab_primary_currency") ?? "AED";

  // Inbox badge — pending linked + settlement requests touching this user.
  // Mirrors the count BottomNav shows so the hero bell agrees with the nav.
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? "");
  const linkedPending = useLinkedRequestStore(
    (s) =>
      s.requests.filter(
        (r) =>
          r.status === "pending" &&
          (r.toUserId === userId || r.fromUserId === userId),
      ).length,
  );
  const settlementPending = useSettlementRequestStore(
    (s) =>
      s.requests.filter(
        (r) =>
          r.status === "pending" &&
          (r.toUserId === userId || r.fromUserId === userId),
      ).length,
  );
  const pendingApprovalCount = linkedPending + settlementPending;

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
            <button
              onClick={() => navigate("/inbox")}
              className="relative w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center shrink-0 transition-colors"
              aria-label="Inbox"
            >
              <Bell size={16} className="text-white" />
              {pendingApprovalCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-1 rounded-full bg-pay-600 text-white text-[9px] font-bold flex items-center justify-center ring-2 ring-navy-800">
                  {pendingApprovalCount > 9 ? "9+" : pendingApprovalCount}
                </span>
              )}
            </button>
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
                    onClick={() => navigate("/loans")}
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
                    onClick={() => navigate("/loans")}
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

              <div>
                <div className="flex items-center justify-between mb-2.5 px-1">
                  <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    Groups
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
                    title="No groups yet"
                    description="Create or join a group to split shared expenses."
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
      </main>
    );
  }

  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? "Good Night"
      : hour < 12
      ? "Subah Bakhair"
      : hour < 17
      ? "Assalam o Alaikum"
      : hour < 21
      ? "Shaam Bakhair"
      : "Good Night";
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
          <button
            onClick={() => navigate("/inbox")}
            className="relative w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center shrink-0 transition-colors"
            aria-label="Inbox"
          >
            <Bell size={16} className="text-white" />
            {pendingApprovalCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-1 rounded-full bg-pay-600 text-white text-[9px] font-bold flex items-center justify-center ring-2 ring-navy-800 tabular-nums">
                {pendingApprovalCount > 9 ? "9+" : pendingApprovalCount}
              </span>
            )}
          </button>
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
          {accountCount === 0 ? (
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

        {/* Add-account CTA when the user has zero accounts. */}
        {accountCount === 0 && (
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
              onClick={() => navigate("/loans")}
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
              onClick={() => navigate("/loans")}
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

        {/* Quick-action 4-up tile grid. Maps Sukoon's Log/Send/Request/Split
            slots to the extras that no longer have a bottom-nav home:
            Goals · Analytics · Activity · Groups. */}
        {accountCount > 0 && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-3">
            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={() => navigate("/goals")}
                className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl active:bg-cream-soft transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-accent-100 flex items-center justify-center">
                  <Target size={18} className="text-accent-600" />
                </div>
                <span className="text-[10.5px] font-medium text-ink-800">
                  {t("nav_goals")}
                </span>
              </button>
              <button
                onClick={() => navigate("/analytics")}
                className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl active:bg-cream-soft transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-info-50 flex items-center justify-center">
                  <BarChart3 size={18} className="text-info-600" />
                </div>
                <span className="text-[10.5px] font-medium text-ink-800">
                  {t("analytics_title")}
                </span>
              </button>
              <button
                onClick={() => navigate("/activity")}
                className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl active:bg-cream-soft transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center">
                  <History size={18} className="text-ink-600" />
                </div>
                <span className="text-[10.5px] font-medium text-ink-800">
                  Activity
                </span>
              </button>
              <button
                onClick={() => navigate("/contacts")}
                className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl active:bg-cream-soft transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-warn-50 flex items-center justify-center">
                  <Contact size={18} className="text-warn-600" />
                </div>
                <span className="text-[10.5px] font-medium text-ink-800">
                  Contacts
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Pending strip — urgent upcoming expenses. */}
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
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
                  >
                    <div className="w-9 h-9 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
                      <Landmark size={16} className="text-ink-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
                        {a.name}
                      </p>
                      <p className="text-[11px] text-ink-500 mt-0.5">
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
                      <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums tracking-tight">
                        {formatMoney(a.balance, a.currency)}
                      </p>
                      <p className="text-[10px] text-ink-400 mt-0.5">
                        {meta?.flag} {a.currency}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
            {accounts.length > 3 && (
              <button
                onClick={() => setShowAddAccount(true)}
                className="w-full mt-2 text-center text-[11px] font-semibold text-ink-500 py-2 active:opacity-70"
              >
                {accounts.length - 3} more · tap + to manage
              </button>
            )}
          </div>
        )}

        {/* Empty-dashboard nudge — accounts exist but no transactions yet. */}
        {accountCount > 0 && transactions.length === 0 && (
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
    </main>
  );
}
