import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { transactionsDb, emiSchedulesDb, loansDb, goalsDb, groupExpensesDb } from '../lib/supabaseDb';
import { loadCacheFirst, markMirrorStale, mirrorDelete, mirrorPut } from '../lib/mirrorCache';
import { addMonths, format } from 'date-fns';
import type { Transaction, Currency, EmiSchedule, EmiStatus, Loan, ActivityType, InvestmentTrade } from '../db';
import { useAccountStore } from './accountStore';
import { useLoanStore, type CreateLoanInput } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';
import { useAppModeStore } from './appModeStore';
import { useInvestmentStore } from './investmentStore';
import { buildInternalNote, parseInternalNote } from '../lib/internalNotes';
import { tStatic } from '../lib/i18n';
import { statusSyncToPaid, uncoveredToPaidIds } from '../lib/emiCoverage';
import { clampCardCredit } from '../lib/cardCredit';
import { assertLinkedLoanDeleteAllowed } from '../lib/linkedLoanGuards';
import { simulateTimeline, validateTradeInput } from '../lib/investmentMath';
import { rateIsSane } from '../lib/conversionMath';
import { MutationScope, runSafeMutation } from '../lib/mutationSafety';

interface BaseTransactionInput {
  amount: number;
  category?: string;
  notes?: string;
  createdAt?: string;
}

interface IncomeInput extends BaseTransactionInput {
  type: 'income';
  destinationAccountId: string;
}

interface ExpenseInput extends BaseTransactionInput {
  type: 'expense';
  sourceAccountId: string;
}

interface TransferInput extends BaseTransactionInput {
  type: 'transfer';
  sourceAccountId: string;
  destinationAccountId: string;
  conversionRate?: number;
}

interface LoanGivenInput extends BaseTransactionInput {
  type: 'loan_given';
  sourceAccountId: string;
  personName: string;
  personId?: string | null;
  loanId?: string;
}

interface LoanTakenInput extends BaseTransactionInput {
  type: 'loan_taken';
  destinationAccountId: string;
  personName: string;
  personId?: string | null;
  loanId?: string;
  sourceAccountId?: string;
}

interface RepaymentInput extends BaseTransactionInput {
  type: 'repayment';
  loanId: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
  emiId?: string;
  conversionRate?: number;
}

interface GoalContributionInput extends BaseTransactionInput {
  type: 'goal_contribution';
  sourceAccountId: string;
  goalId: string;
  conversionRate?: number;
}

interface OpeningBalanceInput extends BaseTransactionInput {
  type: 'opening_balance';
  destinationAccountId: string;
}

// Set an account's balance to a known-true figure via a visible, reversible
// correction entry. The recovery hatch for drifted balances (e.g. a credit
// card mangled by historical double-credits) — no fake income/expense needed.
// `amount` on BaseTransactionInput is ignored; the engine derives the delta.
interface AdjustmentInput extends BaseTransactionInput {
  type: 'adjustment';
  accountId: string;
  targetBalance: number;
}

// Investment trades funded from (or credited to) a real account. The trade
// row itself is created INSIDE the mutation scope (trackedAddInvestmentTrade)
// so a failed money leg never leaves an orphan trade — loan_given precedent.
// `amount` on BaseTransactionInput is ignored for these; the engine computes
// the true cash amount from qty × price ± fees.
interface InvestmentTradeFields {
  marketId: string;
  symbol: string;
  companyName?: string;
  quantity: number;
  pricePerUnit: number;
  fees: number;
  tradedAt?: string;
}

interface InvestmentBuyInput extends BaseTransactionInput, InvestmentTradeFields {
  type: 'investment_buy';
  sourceAccountId: string;
  conversionRate?: number;
}

interface InvestmentSellInput extends BaseTransactionInput, InvestmentTradeFields {
  type: 'investment_sell';
  destinationAccountId: string;
  conversionRate?: number;
}

interface InvestmentDividendInput extends BaseTransactionInput {
  type: 'investment_dividend';
  destinationAccountId: string;
  marketId: string;
  symbol: string;
  grossAmount: number;
  fees: number;
  tradedAt?: string;
  conversionRate?: number;
}

export type TransactionInput =
  | IncomeInput
  | ExpenseInput
  | TransferInput
  | LoanGivenInput
  | LoanTakenInput
  | RepaymentInput
  | GoalContributionInput
  | OpeningBalanceInput
  | AdjustmentInput
  | InvestmentBuyInput
  | InvestmentSellInput
  | InvestmentDividendInput;

interface TransactionState {
  transactions: Transaction[];
  loading: boolean;
  loadTransactions: () => Promise<void>;
  processTransaction: (input: TransactionInput) => Promise<Transaction>;
  updateTransaction: (
    id: string,
    input: ExpenseInput | LoanGivenInput | LoanTakenInput,
    options?: { allowLinkedGroupExpense?: boolean }
  ) => Promise<Transaction>;
  setReconciled: (id: string, isReconciled: boolean) => Promise<void>;
  // Attach/detach a receipt photo (storage path or null). Lightweight — patches
  // only receipt_path, never re-runs balance logic (unlike updateTransaction).
  setReceiptPath: (id: string, receiptPath: string | null) => Promise<void>;
  deleteTransaction: (id: string, options?: { allowLinkedGroupExpense?: boolean; allowInvestment?: boolean; allowNegative?: boolean }) => Promise<void>;
  // Remove a loan AND everything attached to it (repayments, origin entry,
  // EMI schedule), reversing every balance effect. The escape hatch for a
  // mis-entered loan that guards used to lock forever.
  deleteLoanCascade: (loanId: string, options?: { allowNegative?: boolean }) => Promise<void>;
  // Used by rollback paths that need to re-insert a transaction with its
  // original id and re-apply the matching balance delta. Not for general use.
  restoreTransaction: (snapshot: Transaction) => Promise<void>;
  getTransaction: (id: string) => Transaction | undefined;
  getByAccount: (accountId: string) => Transaction[];
  getByLoan: (loanId: string) => Transaction[];
  reset: () => void;
}

const INITIAL_TRANSACTION_STATE = {
  transactions: [] as Transaction[],
  loading: false,
};

type BalanceCheckedTransactionType = Extract<TransactionInput['type'], 'expense' | 'loan_given' | 'loan_taken' | 'repayment'>;
type BalanceCheckedAccount = { name: string; balance: number; type: string; metadata: Record<string, string> };

// Insufficient balance check helper (creation-time: spending money you don't
// have). Bilingual via tStatic — the old hardcoded Roman Urdu leaked to
// English users on every money surface.
function checkBalance(account: BalanceCheckedAccount, amount: number) {
  if (account.balance < amount) {
    throw new Error(
      tStatic('err_insufficient')
        .replace('{account}', account.name)
        .replace('{available}', account.balance.toLocaleString())
        .replace('{amount}', amount.toLocaleString()),
    );
  }
}

// Reversal-time balance guard. Unlike creation, a blocked reversal has a real
// escape: the user may confirm the account going negative (the credited money
// was since spent — reality already diverged, and a visible negative beats a
// permanently stuck row). The error carries a code + fields so the UI can
// offer exactly that retry with { allowNegative: true }.
export interface ReversalBlocked extends Error {
  code: 'REVERSAL_NEEDS_NEGATIVE';
  accountName: string;
  balanceAfter: number;
  accountCurrency: string;
}

function checkReversalBalance(
  account: BalanceCheckedAccount & { currency?: string },
  amount: number,
  allowNegative: boolean | undefined,
) {
  if (allowNegative) return;
  if (account.balance < amount) {
    const err = new Error(
      tStatic('err_reversal_spent')
        .replace(/\{account\}/g, account.name)
        .replace('{available}', account.balance.toLocaleString()),
    ) as ReversalBlocked;
    err.code = 'REVERSAL_NEEDS_NEGATIVE';
    err.accountName = account.name;
    err.balanceAfter = Math.round((account.balance - amount) * 100) / 100;
    err.accountCurrency = account.currency ?? '';
    throw err;
  }
}

function isSimpleModeBalanceBypassAllowed(transactionType: BalanceCheckedTransactionType): boolean {
  return useAppModeStore.getState().mode === 'splits_only'
    && (
      transactionType === 'expense'
      || transactionType === 'loan_given'
      || transactionType === 'loan_taken'
      || transactionType === 'repayment'
    );
}

function checkBalanceForTransaction(
  account: BalanceCheckedAccount,
  amount: number,
  transactionType: BalanceCheckedTransactionType,
) {
  // Simple mode is for recording reality, so these entries may intentionally
  // make an account negative. Full Money Tracker still uses strict validation.
  if (isSimpleModeBalanceBypassAllowed(transactionType)) return;
  checkBalance(account, amount);
}

async function ensureSupportingStoresLoaded() {
  const accountStore = useAccountStore.getState();
  const loanStore = useLoanStore.getState();
  const goalStore = useGoalStore.getState();
  const emiStore = useEmiStore.getState();

  if (accountStore.accounts.length === 0) {
    await accountStore.loadAccounts();
  }
  if (loanStore.loans.length === 0) {
    await loanStore.loadLoans();
  }
  if (goalStore.goals.length === 0) {
    await goalStore.loadGoals();
  }
  if (emiStore.schedules.length === 0) {
    await emiStore.loadSchedules();
  }
}

function isEditableTransactionType(type: Transaction['type']): type is 'expense' | 'loan_given' | 'loan_taken' {
  return type === 'expense' || type === 'loan_given' || type === 'loan_taken';
}

// Tracked mutation helpers. Each performs the forward write and registers its
// inverse on the scope. Inverses run LIFO on rollback. Every helper here is
// delta-based or snapshot-based so concurrent mutations commute.

// A mirror transaction is locked to its group expense ("edit it from the
// group screen") — but only while that group expense still EXISTS. Group
// deletion cascades the shared rows away server-side, and the old
// unconditional guard then locked every member's mirror forever. Only a
// CONFIRMED 0-row probe releases the mirror; probeExists throws on
// transport/auth failures, so a flaky connection keeps the guard (fail
// safe) instead of letting a live group's mirror slip out from under it.
async function groupExpenseStillExists(groupExpenseId: string): Promise<boolean> {
  try {
    return await groupExpensesDb.probeExists(groupExpenseId);
  } catch {
    return true;
  }
}

async function trackedBalanceDelta(scope: MutationScope, accountId: string, delta: number): Promise<void> {
  const accounts = useAccountStore.getState();
  await accounts.updateBalance(accountId, delta);
  scope.register(() => useAccountStore.getState().updateBalance(accountId, -delta));
}

// NOTE: these helpers deliberately bypass the store-level create/update
// methods and talk to the DB directly. The store methods embed
// await logActivity(...) after the real write, so any activity-log failure
// would throw AFTER the record was persisted, defeating compensation
// registration and leaving ghost records. Activity logging is treated here
// as best-effort (same policy as logActivitySafe).
async function trackedCreateLoan(scope: MutationScope, input: CreateLoanInput): Promise<Loan> {
  const loan: Loan = {
    id: uuid(),
    personName: input.personName,
    personId: input.personId ?? null,
    type: input.type,
    totalAmount: input.totalAmount,
    remainingAmount: input.totalAmount,
    currency: input.currency,
    status: 'active',
    notes: input.notes ?? '',
    createdAt: new Date().toISOString(),
  };
  loan.updatedAt = loan.createdAt;
  await loansDb.add(loan);
  await mirrorPut(db.loans, loan);
  markMirrorStale('loans');
  useLoanStore.setState(s => ({ loans: [...s.loans, loan] }));
  scope.register(async () => {
    await loansDb.delete(loan.id);
    await mirrorDelete(db.loans, loan.id);
    markMirrorStale('loans');
    useLoanStore.setState(s => ({ loans: s.loans.filter(l => l.id !== loan.id) }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'loan_created',
      `Loan ${input.type === 'given' ? 'given to' : 'taken from'} ${input.personName}: ${input.currency} ${input.totalAmount}`,
      loan.id,
      'loan',
    );
  } catch (err) {
    console.error('logActivity failed in trackedCreateLoan (non-fatal)', err);
  }
  return loan;
}

async function trackedApplyRepayment(scope: MutationScope, loanId: string, amount: number): Promise<void> {
  // Snapshot before so compensation restores exact prior state. The store's
  // applyRepayment clamps remainingAmount at 0, so forward/reverse via a
  // negated delta are asymmetric when amount > remainingAmount (overpayment).
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) throw new Error(`Loan ${loanId} not found`);
  const prevRemaining = before.remainingAmount;
  const prevStatus = before.status;
  const newRemaining = Math.max(0, Math.round((before.remainingAmount - amount) * 100) / 100);
  const newStatus: Loan['status'] = newRemaining === 0 ? 'settled' : 'active';
  const updatedAt = new Date().toISOString();
  await loansDb.update(loanId, { remainingAmount: newRemaining, status: newStatus });
  await mirrorPut(db.loans, { ...before, remainingAmount: newRemaining, status: newStatus, updatedAt });
  markMirrorStale('loans');
  useLoanStore.setState(s => ({
    loans: s.loans.map(l => (l.id === loanId ? { ...l, remainingAmount: newRemaining, status: newStatus, updatedAt } : l)),
  }));
  scope.register(async () => {
    await loansDb.update(loanId, { remainingAmount: prevRemaining, status: prevStatus });
    await mirrorPut(db.loans, { ...before, remainingAmount: prevRemaining, status: prevStatus, updatedAt: new Date().toISOString() });
    markMirrorStale('loans');
    useLoanStore.setState(s => ({
      loans: s.loans.map(l => (l.id === loanId ? { ...l, remainingAmount: prevRemaining, status: prevStatus } : l)),
    }));
  });
  if (newStatus === 'settled' && prevStatus !== 'settled') {
    try {
      await useActivityStore.getState().logActivity(
        'loan_settled',
        `Loan with ${before.personName} fully settled`,
        loanId,
        'loan',
      );
    } catch (err) {
      console.error('logActivity failed in trackedApplyRepayment (non-fatal)', err);
    }
  }
}

async function trackedUpdateLoan(
  scope: MutationScope,
  loanId: string,
  changes: Partial<Loan>,
): Promise<void> {
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) throw new Error(`Loan ${loanId} not found`);
  // Snapshot only the fields being changed so compensation restores exactly
  // those, not the entire row (safer against interleaved realtime updates).
  const snapshot: Partial<Loan> = {};
  for (const key of Object.keys(changes) as (keyof Loan)[]) {
    (snapshot as Record<string, unknown>)[key] = before[key];
  }
  await useLoanStore.getState().updateLoan(loanId, changes);
  scope.register(() => useLoanStore.getState().updateLoan(loanId, snapshot));
}

async function trackedAddContribution(scope: MutationScope, goalId: string, amount: number): Promise<void> {
  // Snapshot-based inverse: addContribution clamps savedAmount at 0, so a
  // negated delta is asymmetric whenever the forward step hit the clamp —
  // rollback must restore the exact prior figure, not undo a delta.
  const prevSaved = useGoalStore.getState().getGoal(goalId)?.savedAmount;
  await useGoalStore.getState().addContribution(goalId, amount);
  scope.register(async () => {
    if (prevSaved === undefined) return;
    await goalsDb.update(goalId, { savedAmount: prevSaved });
    useGoalStore.setState((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount: prevSaved } : g)),
    }));
  });
}

// Investment trade rows ride inside the money-mutation scope so a failed
// balance leg can never leave an orphan trade (and vice versa). The store
// primitives touch only the row + local state — balances stay owned here.
async function trackedAddInvestmentTrade(scope: MutationScope, trade: InvestmentTrade): Promise<void> {
  await useInvestmentStore.getState().insertTradeRow(trade);
  scope.register(() => useInvestmentStore.getState().removeTradeRow(trade.id));
}

async function trackedDeleteInvestmentTrade(scope: MutationScope, trade: InvestmentTrade): Promise<void> {
  await useInvestmentStore.getState().removeTradeRow(trade.id);
  scope.register(() => useInvestmentStore.getState().restoreTradeRow(trade));
}

async function trackedMarkEmiPaid(scope: MutationScope, emiId: string): Promise<void> {
  // Bypass store.markPaid because it awaits logActivity AFTER the DB write —
  // a log failure would throw without letting us register compensation.
  const before = useEmiStore.getState().schedules.find(e => e.id === emiId);
  if (!before) throw new Error(`EMI ${emiId} not found`);
  const prevStatus: EmiStatus = before.status;
  if (prevStatus === 'paid') return;
  await emiSchedulesDb.update(emiId, { status: 'paid' as EmiStatus });
  useEmiStore.setState(s => ({
    schedules: s.schedules.map(e => (e.id === emiId ? { ...e, status: 'paid' as EmiStatus } : e)),
  }));
  scope.register(async () => {
    await emiSchedulesDb.update(emiId, { status: prevStatus });
    useEmiStore.setState(s => ({
      schedules: s.schedules.map(e => (e.id === emiId ? { ...e, status: prevStatus } : e)),
    }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'emi_paid',
      `EMI #${before.installmentNumber} paid`,
      before.loanId,
      'loan',
    );
  } catch (err) {
    console.error('logActivity failed in trackedMarkEmiPaid (non-fatal)', err);
  }
}

async function trackedMarkCoveredEmisPaid(scope: MutationScope, loanId: string): Promise<void> {
  // Reconcile the loan's binary EMI schedule to its paid-down balance. After a
  // repayment that carried no specific emiId, mark the oldest instalments now
  // fully covered by (totalAmount - remainingAmount) as paid. This must run
  // AFTER trackedApplyRepayment so remainingAmount is already current.
  //
  // Subsumes the old "full settlement marks everything" branch — a full payoff
  // covers every instalment. Snapshots exact prior status (incl. 'late') so
  // rollback restores it. Bypasses store.markPaid for the same reason as
  // trackedMarkEmiPaid (embedded logActivity would throw before compensation).
  const loan = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!loan) return;
  const schedules = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (schedules.length === 0) return;
  const paid = Math.round((loan.totalAmount - loan.remainingAmount) * 100) / 100;
  const ids = uncoveredToPaidIds(schedules, paid);
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const before = schedules
    .filter(e => idSet.has(e.id))
    .map(e => ({ id: e.id, status: e.status, installmentNumber: e.installmentNumber }));
  await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: 'paid' as EmiStatus })));
  useEmiStore.setState(state => ({
    schedules: state.schedules.map(e => (idSet.has(e.id) ? { ...e, status: 'paid' as EmiStatus } : e)),
  }));
  scope.register(async () => {
    await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: s.status })));
    useEmiStore.setState(state => ({
      schedules: state.schedules.map(e => {
        const prev = before.find(b => b.id === e.id);
        return prev ? { ...e, status: prev.status } : e;
      }),
    }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'emi_paid',
      before.length === 1
        ? `EMI #${before[0].installmentNumber} paid`
        : `${before.length} EMIs marked paid after repayment`,
      loanId,
      'loan',
    );
  } catch (err) {
    console.error('logActivity failed in trackedMarkCoveredEmisPaid (non-fatal)', err);
  }
}

async function trackedAddTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.add(tx);
  await mirrorPut(db.transactions, tx);
  markMirrorStale('transactions');
  useTransactionStore.setState(s => ({ transactions: [tx, ...s.transactions] }));
  scope.register(async () => {
    await transactionsDb.delete(tx.id);
    await mirrorDelete(db.transactions, tx.id);
    markMirrorStale('transactions');
    useTransactionStore.setState(s => ({ transactions: s.transactions.filter(t => t.id !== tx.id) }));
  });
}

async function trackedUpdateTransaction(scope: MutationScope, id: string, updated: Transaction, snapshot: Transaction): Promise<void> {
  await transactionsDb.update(id, updated);
  await mirrorPut(db.transactions, updated);
  markMirrorStale('transactions');
  useTransactionStore.setState(state => ({
    transactions: state.transactions.map(t => (t.id === id ? updated : t)),
  }));
  scope.register(async () => {
    await transactionsDb.update(id, snapshot);
    await mirrorPut(db.transactions, snapshot);
    markMirrorStale('transactions');
    useTransactionStore.setState(state => ({
      transactions: state.transactions.map(t => (t.id === id ? snapshot : t)),
    }));
  });
}

async function trackedDeleteTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.delete(tx.id);
  await mirrorDelete(db.transactions, tx.id);
  markMirrorStale('transactions');
  useTransactionStore.setState(state => ({
    transactions: state.transactions.filter(t => t.id !== tx.id),
  }));
  scope.register(async () => {
    await transactionsDb.add(tx);
    await mirrorPut(db.transactions, tx);
    markMirrorStale('transactions');
    useTransactionStore.setState(s => ({ transactions: [tx, ...s.transactions] }));
  });
}

async function trackedDeleteLoan(scope: MutationScope, loanId: string): Promise<void> {
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) {
    // Nothing to delete; nothing to compensate.
    return;
  }
  await useLoanStore.getState().deleteLoan(loanId);
  scope.register(async () => {
    await loansDb.add(before);
    await mirrorPut(db.loans, before);
    markMirrorStale('loans');
    useLoanStore.setState(s => ({ loans: [...s.loans, before] }));
  });
}

async function trackedDeleteEmisByLoan(scope: MutationScope, loanId: string): Promise<void> {
  const snapshot: EmiSchedule[] = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (snapshot.length === 0) return;
  await useEmiStore.getState().deleteByLoan(loanId);
  scope.register(async () => {
    await emiSchedulesDb.bulkAdd(snapshot);
    useEmiStore.setState(s => ({ schedules: [...s.schedules, ...snapshot] }));
  });
}

// Rebuild a schedule over a new total: same instalment count and start date,
// fresh 'upcoming' rows (only reachable when the loan has zero repayments).
// Inverse is a whole-loan wipe — safe because it always runs BEFORE the
// paired trackedDeleteEmisByLoan inverse re-adds the old rows (LIFO).
async function trackedRegenerateEmis(
  scope: MutationScope,
  loanId: string,
  totalAmount: number,
  installments: number,
  startDueDate: string,
): Promise<void> {
  const emiAmount = Math.round((totalAmount / installments) * 100) / 100;
  const start = new Date(startDueDate);
  const entries: EmiSchedule[] = [];
  for (let i = 0; i < installments; i++) {
    entries.push({
      id: uuid(),
      loanId,
      installmentNumber: i + 1,
      dueDate: format(addMonths(start, i), 'yyyy-MM-dd'),
      amount: i === installments - 1
        ? Math.round((totalAmount - emiAmount * (installments - 1)) * 100) / 100
        : emiAmount,
      status: 'upcoming' as EmiStatus,
    });
  }
  await emiSchedulesDb.bulkAdd(entries);
  useEmiStore.setState(s => ({ schedules: [...s.schedules, ...entries] }));
  scope.register(async () => {
    await emiSchedulesDb.deleteByLoan(loanId);
    const ids = new Set(entries.map(e => e.id));
    useEmiStore.setState(s => ({ schedules: s.schedules.filter(e => !ids.has(e.id)) }));
  });
}

// After a mutation commits, we log to activity. Failures here must NOT surface
// to the user — the money already moved and rolling it back now would be
// worse. Swallow and console.error.
async function logActivitySafe(type: ActivityType, description: string, entityId: string, entityType: string): Promise<void> {
  try {
    await useActivityStore.getState().logActivity(type, description, entityId, entityType);
  } catch (err) {
    console.error('logActivity failed (non-fatal, mutation already committed)', err);
  }
}

// If rollback itself partially failed, local state may have drifted from
// remote. Force-refetch the stores that carry money-critical data. Runs
// the five fetches in parallel — these are independent reads and the
// post-rollback path is exactly where every saved millisecond matters
// (the user is staring at an error toast).
async function refetchMoneyStores(): Promise<void> {
  try {
    await Promise.all([
      useAccountStore.getState().loadAccounts(),
      useTransactionStore.getState().loadTransactions(),
      useLoanStore.getState().loadLoans(),
      useEmiStore.getState().loadSchedules(),
      useGoalStore.getState().loadGoals(),
    ]);
  } catch (err) {
    console.error('Post-rollback refetch failed — local state may be stale until next navigation', err);
  }
}

async function findCashAdvanceCardForLoan(loanId: string): Promise<string | null> {
  let transactions = useTransactionStore.getState().transactions;
  if (transactions.length === 0) {
    transactions = await transactionsDb.getAll();
    useTransactionStore.setState({ transactions });
  }

  const cashAdvance = transactions.find(
    (transaction) =>
      transaction.type === 'loan_taken' &&
      transaction.relatedLoanId === loanId &&
      Boolean(transaction.sourceAccountId),
  );

  return cashAdvance?.sourceAccountId ?? null;
}

// Reverse lookup of findCashAdvanceCardForLoan: the still-open taken loans a
// given credit card funded, oldest first. Used by the pay-card-bill path so a
// bill payment settles the debt's loan record instead of leaving it to be
// paid a second time.
async function findActiveCashAdvanceLoansForCard(cardId: string): Promise<Loan[]> {
  let transactions = useTransactionStore.getState().transactions;
  if (transactions.length === 0) {
    transactions = await transactionsDb.getAll();
    useTransactionStore.setState({ transactions });
  }
  const loanIds = new Set(
    transactions
      .filter((t) => t.type === 'loan_taken' && t.sourceAccountId === cardId && t.relatedLoanId)
      .map((t) => t.relatedLoanId as string),
  );
  return useLoanStore.getState().loans
    .filter((l) => loanIds.has(l.id) && l.type === 'taken' && l.status === 'active' && l.remainingAmount > 0.005)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Two-way EMI reconcile: sync the schedule's binary statuses to the loan's
// CURRENT paid-down amount — marking newly covered instalments paid AND
// un-marking paid instalments the money no longer backs (repayment deleted).
// Must run AFTER the loan row inside the scope reflects its final remaining.
async function trackedSyncEmisToLoan(scope: MutationScope, loanId: string): Promise<void> {
  const loan = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!loan) return;
  const schedules = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (schedules.length === 0) return;
  const paid = Math.round((loan.totalAmount - loan.remainingAmount) * 100) / 100;
  const { toPaid, toUpcoming } = statusSyncToPaid(schedules, paid);
  if (toPaid.length === 0 && toUpcoming.length === 0) return;
  const targets = new Map<string, EmiStatus>();
  for (const id of toPaid) targets.set(id, 'paid');
  for (const id of toUpcoming) targets.set(id, 'upcoming');
  const before = schedules
    .filter(e => targets.has(e.id))
    .map(e => ({ id: e.id, status: e.status }));
  await Promise.all([...targets.entries()].map(([id, status]) => emiSchedulesDb.update(id, { status })));
  useEmiStore.setState(state => ({
    schedules: state.schedules.map(e => (targets.has(e.id) ? { ...e, status: targets.get(e.id)! } : e)),
  }));
  scope.register(async () => {
    await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: s.status })));
    useEmiStore.setState(state => ({
      schedules: state.schedules.map(e => {
        const prev = before.find(b => b.id === e.id);
        return prev ? { ...e, status: prev.status } : e;
      }),
    }));
  });
}

// The card credit a repayment row actually applied — the clamped figure from
// its internal note when present, else the full row amount. Reversals must
// debit exactly this.
function cardCreditedAmountOf(transaction: Transaction): number {
  const meta = parseInternalNote(transaction.notes).meta;
  const stamped = meta.cardCreditedAmount ? parseFloat(meta.cardCreditedAmount) : NaN;
  return Number.isFinite(stamped) ? stamped : transaction.amount;
}


export const useTransactionStore = create<TransactionState>((set, get) => ({
  ...INITIAL_TRANSACTION_STATE,

  reset: () => set(INITIAL_TRANSACTION_STATE),

  loadTransactions: async () => {
    set({ loading: true });
    try {
      const { rows: transactions } = await loadCacheFirst({
        key: 'transactions',
        table: db.transactions,
        fetchRemote: transactionsDb.getAll,
        fetchUpdatedSince: transactionsDb.getUpdatedSince,
        fetchDeletedSince: transactionsDb.getDeletedSince,
        getUpdatedAt: (transaction) => transaction.updatedAt ?? transaction.createdAt,
        sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
      });
      set({ transactions });
    } finally {
      set({ loading: false });
    }
  },

  processTransaction: async (input) => {
    await ensureSupportingStoresLoaded();
    // Investment branches need markets/trades; loaded lazily so non-investment
    // users never pay a fetch for permanently-empty tables.
    if (input.type === 'investment_buy' || input.type === 'investment_sell' || input.type === 'investment_dividend') {
      const inv = useInvestmentStore.getState();
      if (inv.markets.length === 0) await inv.loadInvestments();
    }

    const { transaction, description } = await runSafeMutation<{ transaction: Transaction; description: string }>(
      async (scope) => {
        const accountStore = useAccountStore.getState();
        const loanStore = useLoanStore.getState();
        const goalStore = useGoalStore.getState();

        // Generated before the switch so investment branches can stamp the
        // trade row's transactionId at insert time — no post-hoc patch write.
        const transactionId = uuid();
        // Investment branches compute the true cash amount (qty × price ± fees)
        // themselves; every other branch leaves this as the caller's amount.
        let amount = input.amount;
        let currency: Currency = 'AED';
        let sourceAccountId: string | null = null;
        let destinationAccountId: string | null = null;
        let relatedPerson: string | null = null;
        let personId: string | null = null;
        let relatedLoanId: string | null = null;
        let relatedGoalId: string | null = null;
        let relatedInvestmentId: string | null = null;
        let conversionRate: number | null = null;
        let description = '';
        // Set when a branch needs to stamp internal meta into the row's notes
        // (e.g. a clamped card credit); wins over input.notes at build time.
        let notesOverride: string | null = null;

        switch (input.type) {
          case 'income': {
            const destAccount = accountStore.getAccount(input.destinationAccountId);
            if (!destAccount) throw new Error('Destination account not found');
            currency = destAccount.currency;
            destinationAccountId = input.destinationAccountId;
            await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
            description = `Income of ${currency} ${input.amount} → ${destAccount.name}`;
            break;
          }

          case 'expense': {
            const srcAccount = accountStore.getAccount(input.sourceAccountId);
            if (!srcAccount) throw new Error('Source account not found');
            checkBalanceForTransaction(srcAccount, input.amount, input.type);
            currency = srcAccount.currency;
            sourceAccountId = input.sourceAccountId;
            await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
            description = `Expense of ${currency} ${input.amount} from ${srcAccount.name}`;
            break;
          }

          case 'transfer': {
            const src = accountStore.getAccount(input.sourceAccountId);
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!src || !dest) throw new Error('Account not found');
            if (src.id === dest.id) throw new Error('Choose a different destination account');
            checkBalance(src, input.amount);
            currency = src.currency;
            sourceAccountId = input.sourceAccountId;
            destinationAccountId = input.destinationAccountId;

            // Cross-currency check runs BEFORE any balance movement so we
            // don't debit the source and then realise we can't credit the
            // destination.
            if (src.currency !== dest.currency && !input.conversionRate) {
              throw new Error('Conversion rate required for cross-currency move');
            }

            await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);

            if (src.currency !== dest.currency) {
              conversionRate = input.conversionRate!;
              const destAmount = Math.round(input.amount * conversionRate * 100) / 100;
              await trackedBalanceDelta(scope, input.destinationAccountId, destAmount);
              description = `Moved ${src.currency} ${input.amount} → ${dest.currency} ${destAmount} (rate: ${conversionRate})`;
            } else {
              await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
              description = `Moved ${currency} ${input.amount}: ${src.name} → ${dest.name}`;
            }

            // Paying a card bill IS paying back its cash advances — the same
            // debt lives in two records (card balance + loan). Apply the
            // credited amount to still-open cash-advance loans this card funded
            // (oldest first) as ledger-only repayments: the money already moved
            // via the transfer legs above, so these rows carry no account legs.
            // Without this, a paid-off bill left the loan open and forced the
            // user to "pay" it a second time (the double-credit disaster).
            if (dest.type === 'credit_card') {
              let pool = src.currency !== dest.currency
                ? Math.round(input.amount * (conversionRate ?? 0) * 100) / 100
                : input.amount;
              const fundedLoans = await findActiveCashAdvanceLoansForCard(dest.id);
              let settledCount = 0;
              for (const fundedLoan of fundedLoans) {
                if (pool <= 0.005) break;
                if (fundedLoan.currency !== dest.currency) continue;
                const applied = Math.round(Math.min(fundedLoan.remainingAmount, pool) * 100) / 100;
                if (applied <= 0.005) continue;
                await trackedApplyRepayment(scope, fundedLoan.id, applied);
                await trackedMarkCoveredEmisPaid(scope, fundedLoan.id);
                const record: Transaction = {
                  id: uuid(),
                  type: 'repayment',
                  amount: applied,
                  currency: fundedLoan.currency,
                  sourceAccountId: null,
                  destinationAccountId: null,
                  relatedPerson: fundedLoan.personName,
                  personId: fundedLoan.personId ?? null,
                  relatedLoanId: fundedLoan.id,
                  relatedGoalId: null,
                  relatedInvestmentId: null,
                  conversionRate: null,
                  category: '',
                  notes: buildInternalNote('Covered by card bill payment', { linkedTransactionId: transactionId }),
                  createdAt: input.createdAt ?? new Date().toISOString(),
                  isReconciled: false,
                  reconciledAt: null,
                  reconciledBy: null,
                };
                record.updatedAt = record.createdAt;
                await trackedAddTransaction(scope, record);
                pool = Math.round((pool - applied) * 100) / 100;
                settledCount += 1;
              }
              if (settledCount > 0) {
                description += ` · settled ${settledCount} cash-advance record${settledCount > 1 ? 's' : ''}`;
              }
            }
            break;
          }

          case 'loan_given': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            checkBalanceForTransaction(src, input.amount, input.type);
            currency = src.currency;
            sourceAccountId = input.sourceAccountId;
            relatedPerson = input.personName;
            personId = input.personId ?? null;
            await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);

            if (!input.loanId) {
              const loan = await trackedCreateLoan(scope, {
                personName: input.personName,
                personId: input.personId ?? null,
                type: 'given',
                totalAmount: input.amount,
                currency,
                notes: input.notes,
              });
              relatedLoanId = loan.id;
            } else {
              relatedLoanId = input.loanId;
            }
            description = `Loan given to ${input.personName}: ${currency} ${input.amount}`;
            break;
          }

          case 'loan_taken': {
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!dest) throw new Error('Destination account not found');
            currency = dest.currency;
            destinationAccountId = input.destinationAccountId;
            relatedPerson = input.personName;
            personId = input.personId ?? null;

            if (input.sourceAccountId) {
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              if (src.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
              if (src.currency !== dest.currency) throw new Error('Cash advance source card must match the receiving account currency');
              checkBalanceForTransaction(src, input.amount, input.type);
              sourceAccountId = input.sourceAccountId;
              await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
              description = `Cash advance from ${src.name} into ${dest.name}: ${currency} ${input.amount}`;
            }

            await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);

            if (!input.loanId) {
              const loan = await trackedCreateLoan(scope, {
                personName: input.personName,
                personId: input.personId ?? null,
                type: 'taken',
                totalAmount: input.amount,
                currency,
                notes: input.notes,
              });
              relatedLoanId = loan.id;
            } else {
              relatedLoanId = input.loanId;
            }
            if (!description) {
              description = `Loan taken from ${input.personName}: ${currency} ${input.amount}`;
            }
            break;
          }

          case 'repayment': {
            const loan = loanStore.getLoan(input.loanId);
            if (!loan) throw new Error('Loan not found');
            relatedLoanId = input.loanId;
            relatedPerson = loan.personName;
            personId = loan.personId ?? null;
            currency = loan.currency;

            if (loan.type === 'given') {
              if (!input.destinationAccountId) throw new Error('Destination account required');
              const dest = accountStore.getAccount(input.destinationAccountId);
              if (!dest) throw new Error('Destination account not found');
              destinationAccountId = input.destinationAccountId;

              if (dest.currency !== loan.currency) {
                if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
                conversionRate = input.conversionRate;
                const destAmt = Math.round(input.amount * input.conversionRate * 100) / 100;
                await trackedBalanceDelta(scope, input.destinationAccountId, destAmt);
                description = `Received ${loan.currency} ${input.amount} → ${dest.currency} ${destAmt} from ${loan.personName} (rate: ${input.conversionRate})`;
              } else {
                await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
                description = `Received ${currency} ${input.amount} from ${loan.personName}`;
              }
            } else {
              if (!input.sourceAccountId) throw new Error('Source account required');
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              const cashAdvanceCardId = await findCashAdvanceCardForLoan(input.loanId);
              const cashAdvanceCard = cashAdvanceCardId ? accountStore.getAccount(cashAdvanceCardId) : null;
              if (cashAdvanceCard && cashAdvanceCard.currency !== loan.currency) {
                throw new Error('Cash advance card currency must match the loan currency');
              }

              // Card credit is CLAMPED to the card's remaining headroom. If the
              // bill was already paid another way (a transfer), headroom is 0 and
              // the credit leg is skipped entirely — the same debt must never be
              // credited back twice (the Available-above-Limit bug). When the
              // clamp bites partially, the actual credited figure is stamped into
              // the row's internal note so deletion reverses exactly that.
              const cardCredit = cashAdvanceCard
                ? clampCardCredit(cashAdvanceCard, input.amount)
                : { credited: 0, skipped: 0 };

              if (src.currency !== loan.currency) {
                if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
                conversionRate = input.conversionRate;
                const srcDeduct = Math.round(input.amount / input.conversionRate * 100) / 100;
                checkBalanceForTransaction(src, srcDeduct, input.type);
                sourceAccountId = input.sourceAccountId;
                await trackedBalanceDelta(scope, input.sourceAccountId, -srcDeduct);
                if (cashAdvanceCard && cardCredit.credited > 0) {
                  destinationAccountId = cashAdvanceCard.id;
                  await trackedBalanceDelta(scope, cashAdvanceCard.id, cardCredit.credited);
                  description = `Repaid ${loan.currency} ${cardCredit.credited} to ${cashAdvanceCard.name} from ${src.name} (deducted ${src.currency} ${srcDeduct}, rate: ${input.conversionRate})`;
                } else if (cashAdvanceCard) {
                  description = `Repaid ${loan.currency} ${input.amount} on the ${cashAdvanceCard.name} cash advance from ${src.name} — card bill already covered (rate: ${input.conversionRate})`;
                } else {
                  description = `Repaid ${loan.currency} ${input.amount} (deducted ${src.currency} ${srcDeduct}) to ${loan.personName} (rate: ${input.conversionRate})`;
                }
              } else {
                checkBalanceForTransaction(src, input.amount, input.type);
                sourceAccountId = input.sourceAccountId;
                await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
                if (cashAdvanceCard && cardCredit.credited > 0) {
                  destinationAccountId = cashAdvanceCard.id;
                  await trackedBalanceDelta(scope, cashAdvanceCard.id, cardCredit.credited);
                  description = `Repaid ${currency} ${cardCredit.credited} to ${cashAdvanceCard.name} from ${src.name}`;
                } else if (cashAdvanceCard) {
                  description = `Repaid ${currency} ${input.amount} on the ${cashAdvanceCard.name} cash advance from ${src.name} — card bill already covered`;
                } else {
                  description = `Repaid ${currency} ${input.amount} to ${loan.personName}`;
                }
              }

              if (cashAdvanceCard && cardCredit.credited > 0 && cardCredit.skipped > 0) {
                notesOverride = buildInternalNote(input.notes ?? '', {
                  cardCreditedAmount: String(cardCredit.credited),
                });
              }
            }

            await trackedApplyRepayment(scope, input.loanId, input.amount);
            if (input.emiId) {
              await trackedMarkEmiPaid(scope, input.emiId);
              // Overpaying against one instalment must also cover the later
              // instalments the extra money reaches — the amount is editable
              // now, so a targeted payment is no longer capped at one EMI.
              await trackedMarkCoveredEmisPaid(scope, input.loanId);
            } else {
              // No specific instalment was targeted (generic / partial repayment,
              // multi-loan allocation, full payoff). Reconcile the schedule to the
              // new paid-down balance so instalments don't orphan.
              await trackedMarkCoveredEmisPaid(scope, input.loanId);
            }
            break;
          }

          case 'goal_contribution': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            const goal = goalStore.getGoal(input.goalId);
            if (!goal) throw new Error('Goal not found');

            // Contributing FROM the account the goal is stored in: the money
            // physically stays where it is — debiting the source (with no
            // credit back) would push its balance below reality. Record-only:
            // savedAmount moves, no balance legs, flagged in the internal note
            // so the delete path skips the refund symmetrically.
            if (goal.storedInAccountId && goal.storedInAccountId === input.sourceAccountId) {
              currency = goal.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              await trackedAddContribution(scope, input.goalId, input.amount);
              notesOverride = buildInternalNote(input.notes ?? '', { goalSelfStored: '1' });
              description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}" (kept in ${src.name})`;
              break;
            }

            if (src.currency !== goal.currency) {
              if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
              conversionRate = input.conversionRate;
              const srcDeduct = Math.round(input.amount / input.conversionRate * 100) / 100;
              checkBalance(src, srcDeduct);
              currency = goal.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              await trackedBalanceDelta(scope, input.sourceAccountId, -srcDeduct);
              await trackedAddContribution(scope, input.goalId, input.amount);

              if (goal.storedInAccountId && goal.storedInAccountId !== input.sourceAccountId) {
                const linkedAccount = accountStore.getAccount(goal.storedInAccountId);
                if (linkedAccount) {
                  await trackedBalanceDelta(scope, goal.storedInAccountId, input.amount);
                  destinationAccountId = goal.storedInAccountId;
                  description = `Goal "${goal.title}": ${src.currency} ${srcDeduct} → ${goal.currency} ${input.amount} (rate: ${input.conversionRate})`;
                } else {
                  description = `Goal contribution: ${src.currency} ${srcDeduct} → ${goal.currency} ${input.amount} → "${goal.title}" (rate: ${input.conversionRate})`;
                }
              } else {
                description = `Goal contribution: ${src.currency} ${srcDeduct} → ${goal.currency} ${input.amount} → "${goal.title}" (rate: ${input.conversionRate})`;
              }
            } else {
              checkBalance(src, input.amount);
              currency = src.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
              await trackedAddContribution(scope, input.goalId, input.amount);

              if (goal.storedInAccountId && goal.storedInAccountId !== input.sourceAccountId) {
                const linkedAccount = accountStore.getAccount(goal.storedInAccountId);
                if (linkedAccount) {
                  await trackedBalanceDelta(scope, goal.storedInAccountId, input.amount);
                  destinationAccountId = goal.storedInAccountId;
                  description = `Goal "${goal.title}": ${currency} ${input.amount} from ${src.name} → ${linkedAccount.name}`;
                } else {
                  description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}" (tracked internally)`;
                }
              } else {
                description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}"`;
              }
            }
            break;
          }

          case 'opening_balance': {
            const destAccount = accountStore.getAccount(input.destinationAccountId);
            if (!destAccount) throw new Error('Destination account not found');
            currency = destAccount.currency;
            destinationAccountId = input.destinationAccountId;
            await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
            description = `Opening Balance — ${currency} ${input.amount} in ${destAccount.name}`;
            break;
          }

          case 'adjustment': {
            const account = accountStore.getAccount(input.accountId);
            if (!account) throw new Error('Account not found');
            const delta = Math.round((input.targetBalance - account.balance) * 100) / 100;
            if (Math.abs(delta) < 0.005) throw new Error('Balance is already exactly that — nothing to correct');
            currency = account.currency;
            amount = Math.abs(delta);
            // Direction is carried by which leg the account sits on, so the
            // stored amount stays positive like every other row.
            if (delta > 0) destinationAccountId = input.accountId;
            else sourceAccountId = input.accountId;
            await trackedBalanceDelta(scope, input.accountId, delta);
            description = `Balance corrected — ${account.name} set to ${currency} ${input.targetBalance}`;
            break;
          }

          case 'investment_buy':
          case 'investment_sell': {
            const inv = useInvestmentStore.getState();
            const market = inv.getMarket(input.marketId);
            if (!market) throw new Error('Market not found');
            const symbol = input.symbol.trim().toUpperCase();
            if (!symbol) throw new Error('Symbol is required');
            const kind = input.type === 'investment_buy' ? ('buy' as const) : ('sell' as const);
            const validationError = validateTradeInput({
              kind, quantity: input.quantity, pricePerUnit: input.pricePerUnit, amount: 0, fees: input.fees,
            });
            if (validationError) throw new Error(validationError);

            // The transaction row's amount is the CASH that moved, in market
            // currency: buy = total cost incl. fees; sell = net proceeds.
            const gross = Math.round(input.quantity * input.pricePerUnit * 100) / 100;
            amount = kind === 'buy'
              ? Math.round((gross + input.fees) * 100) / 100
              : Math.round((gross - input.fees) * 100) / 100;
            currency = market.currency;

            const now = new Date().toISOString();
            const trade: InvestmentTrade = {
              id: uuid(),
              marketId: market.id,
              symbol,
              name: input.companyName?.trim() ?? '',
              kind,
              quantity: input.quantity,
              pricePerUnit: input.pricePerUnit,
              amount: 0,
              fees: input.fees,
              accountId: input.type === 'investment_buy' ? input.sourceAccountId : input.destinationAccountId,
              transactionId,
              tradedAt: input.tradedAt ?? now,
              notes: input.notes ?? '',
              createdAt: now,
            };

            // Oversell guard runs BEFORE any money moves — the full timeline
            // replay also catches backdated sells.
            if (kind === 'sell') {
              const check = simulateTimeline(inv.tradesForSymbol(market.id, symbol), { add: trade });
              if (!check.ok) {
                throw new Error(
                  `You only hold ${check.violation.heldQty} ${symbol} — cannot sell ${check.violation.attemptedQty}`,
                );
              }
            }

            if (input.type === 'investment_buy') {
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              sourceAccountId = src.id;
              // Zero-cash entries (bonus shares at price 0) move no money —
              // no rate needed, both deltas are 0 via the same-currency path.
              if (src.currency !== market.currency && amount > 0) {
                if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                  throw new Error('Conversion rate required — different currencies');
                }
                conversionRate = input.conversionRate;
                // rate = market-per-account (divide) — goal_contribution shape.
                const srcDeduct = Math.round((amount / conversionRate) * 100) / 100;
                checkBalance(src, srcDeduct);
                await trackedBalanceDelta(scope, src.id, -srcDeduct);
                description = `Bought ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount}, paid ${src.currency} ${srcDeduct} from ${src.name} (rate: ${conversionRate})`;
              } else {
                checkBalance(src, amount);
                await trackedBalanceDelta(scope, src.id, -amount);
                description = `Bought ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount} from ${src.name}`;
              }
            } else {
              const dest = accountStore.getAccount(input.destinationAccountId);
              if (!dest) throw new Error('Destination account not found');
              destinationAccountId = dest.id;
              if (dest.currency !== market.currency && amount > 0) {
                if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                  throw new Error('Conversion rate required — different currencies');
                }
                conversionRate = input.conversionRate;
                // rate = account-per-market (multiply) — repayment-given shape.
                const credited = Math.round(amount * conversionRate * 100) / 100;
                await trackedBalanceDelta(scope, dest.id, credited);
                description = `Sold ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount}, received ${dest.currency} ${credited} into ${dest.name} (rate: ${conversionRate})`;
              } else {
                await trackedBalanceDelta(scope, dest.id, amount);
                description = `Sold ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount} → ${dest.name}`;
              }
            }

            await trackedAddInvestmentTrade(scope, trade);
            relatedInvestmentId = trade.id;
            break;
          }

          case 'investment_dividend': {
            const inv = useInvestmentStore.getState();
            const market = inv.getMarket(input.marketId);
            if (!market) throw new Error('Market not found');
            const symbol = input.symbol.trim().toUpperCase();
            if (!symbol) throw new Error('Symbol is required');
            const validationError = validateTradeInput({
              kind: 'dividend', quantity: 0, pricePerUnit: 0, amount: input.grossAmount, fees: input.fees,
            });
            if (validationError) throw new Error(validationError);

            amount = Math.round((input.grossAmount - input.fees) * 100) / 100;
            currency = market.currency;
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!dest) throw new Error('Destination account not found');
            destinationAccountId = dest.id;

            const now = new Date().toISOString();
            const trade: InvestmentTrade = {
              id: uuid(),
              marketId: market.id,
              symbol,
              name: '',
              kind: 'dividend',
              quantity: 0,
              pricePerUnit: 0,
              amount: input.grossAmount,
              fees: input.fees,
              accountId: input.destinationAccountId,
              transactionId,
              tradedAt: input.tradedAt ?? now,
              notes: input.notes ?? '',
              createdAt: now,
            };

            if (dest.currency !== market.currency) {
              if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                throw new Error('Conversion rate required — different currencies');
              }
              conversionRate = input.conversionRate;
              const credited = Math.round(amount * conversionRate * 100) / 100;
              await trackedBalanceDelta(scope, dest.id, credited);
              description = `Dividend ${symbol} (${market.name}) — ${currency} ${amount}, received ${dest.currency} ${credited} into ${dest.name} (rate: ${conversionRate})`;
            } else {
              await trackedBalanceDelta(scope, dest.id, amount);
              description = `Dividend ${symbol} (${market.name}) — ${currency} ${amount} → ${dest.name}`;
            }

            await trackedAddInvestmentTrade(scope, trade);
            relatedInvestmentId = trade.id;
            break;
          }
        }

        const transaction: Transaction = {
          id: transactionId,
          type: input.type,
          amount,
          currency,
          sourceAccountId,
          destinationAccountId,
          relatedPerson,
          personId,
          relatedLoanId,
          relatedGoalId,
          relatedInvestmentId,
          conversionRate,
          category: input.category ?? (relatedInvestmentId ? 'Investments' : ''),
          notes: notesOverride ?? input.notes ?? '',
          createdAt: input.createdAt ?? new Date().toISOString(),
          isReconciled: false,
          reconciledAt: null,
          reconciledBy: null,
        };
        transaction.updatedAt = transaction.createdAt;

        await trackedAddTransaction(scope, transaction);

        return { transaction, description };
      },
      refetchMoneyStores,
    );

    // Post-commit: activity log is a secondary audit trail. Its failure must
    // NOT roll back real money (which has already moved successfully).
    await logActivitySafe(
      transaction.type === 'opening_balance' ? 'opening_balance' : 'transaction_created',
      description,
      transaction.id,
      'transaction',
    );

    return transaction;
  },

  updateTransaction: async (id, input, options = {}) => {
    await ensureSupportingStoresLoaded();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (
      existingNoteMeta.groupExpenseId &&
      !options.allowLinkedGroupExpense &&
      await groupExpenseStillExists(existingNoteMeta.groupExpenseId)
    ) {
      throw new Error('This expense belongs to a group. Edit it from the group details screen.');
    }

    if (!isEditableTransactionType(existing.type)) {
      throw new Error('Only expenses and lend/borrow entries can be edited right now.');
    }

    if (existing.type !== input.type) {
      throw new Error('Changing the transaction type is not supported yet.');
    }

    const { updated, description } = await runSafeMutation<{ updated: Transaction; description: string }>(
      async (scope) => {
        const accountStore = useAccountStore.getState();
        const emiStore = useEmiStore.getState();

        let updated: Transaction = existing;
        let description = '';

        switch (existing.type) {
          case 'expense': {
            const expenseInput = input as ExpenseInput;
            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const nextSource = accountStore.getAccount(expenseInput.sourceAccountId);
            if (!previousSource || !nextSource) throw new Error('Source account not found');

            // Pre-flight: will the new source have enough? If not, don't
            // refund the old account at all — we used to refund first, then
            // discover the shortfall, leaving the user silently richer.
            if (previousSource.id !== nextSource.id) {
              checkBalanceForTransaction(nextSource, expenseInput.amount, expenseInput.type);
            } else {
              // Same account — refund-then-charge nets (next - existing);
              // only that delta needs to be available.
              const netDebit = expenseInput.amount - existing.amount;
              if (netDebit > 0) checkBalanceForTransaction(nextSource, netDebit, expenseInput.type);
            }

            await trackedBalanceDelta(scope, previousSource.id, existing.amount);
            await trackedBalanceDelta(scope, nextSource.id, -expenseInput.amount);

            updated = {
              ...existing,
              amount: expenseInput.amount,
              currency: nextSource.currency,
              sourceAccountId: expenseInput.sourceAccountId,
              category: expenseInput.category ?? '',
              notes: expenseInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated expense: ${nextSource.currency} ${expenseInput.amount} from ${nextSource.name}`;
            break;
          }

          case 'loan_given': {
            const loanGivenInput = input as LoanGivenInput;
            const relatedLoanId = existing.relatedLoanId;
            if (!relatedLoanId) throw new Error('Loan record not found for this entry');
            const hasRepayments = get().transactions.some(
              (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
            );
            if (hasRepayments) {
              throw new Error('This loan already has repayments. Remove those repayments first.');
            }
            // A schedule no longer blocks the edit — it is regenerated over the
            // new amount below (same instalment count and start date).
            const priorSchedule = emiStore.getByLoan(relatedLoanId);

            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const nextSource = accountStore.getAccount(loanGivenInput.sourceAccountId);
            if (!previousSource || !nextSource) throw new Error('Source account not found');

            if (previousSource.id !== nextSource.id) {
              checkBalanceForTransaction(nextSource, loanGivenInput.amount, loanGivenInput.type);
            } else {
              const netDebit = loanGivenInput.amount - existing.amount;
              if (netDebit > 0) checkBalanceForTransaction(nextSource, netDebit, loanGivenInput.type);
            }

            await trackedBalanceDelta(scope, previousSource.id, existing.amount);
            await trackedBalanceDelta(scope, nextSource.id, -loanGivenInput.amount);

            await trackedUpdateLoan(scope, relatedLoanId, {
              personName: loanGivenInput.personName,
              ...(loanGivenInput.personId !== undefined ? { personId: loanGivenInput.personId } : {}),
              totalAmount: loanGivenInput.amount,
              remainingAmount: loanGivenInput.amount,
              currency: nextSource.currency,
              status: 'active',
              notes: loanGivenInput.notes ?? '',
            });

            if (priorSchedule.length > 0) {
              await trackedDeleteEmisByLoan(scope, relatedLoanId);
              await trackedRegenerateEmis(
                scope,
                relatedLoanId,
                loanGivenInput.amount,
                priorSchedule.length,
                priorSchedule[0].dueDate,
              );
            }

            updated = {
              ...existing,
              amount: loanGivenInput.amount,
              currency: nextSource.currency,
              sourceAccountId: loanGivenInput.sourceAccountId,
              relatedPerson: loanGivenInput.personName,
              ...(loanGivenInput.personId !== undefined ? { personId: loanGivenInput.personId } : {}),
              notes: loanGivenInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated money lent to ${loanGivenInput.personName}: ${nextSource.currency} ${loanGivenInput.amount}`;
            break;
          }

          case 'loan_taken': {
            const loanTakenInput = input as LoanTakenInput;
            const relatedLoanId = existing.relatedLoanId;
            if (!relatedLoanId) throw new Error('Loan record not found for this entry');
            const hasRepayments = get().transactions.some(
              (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
            );
            if (hasRepayments) {
              throw new Error('This loan already has repayments. Remove those repayments first.');
            }
            // A schedule no longer blocks the edit — it is regenerated over the
            // new amount below (same instalment count and start date).
            const priorSchedule = emiStore.getByLoan(relatedLoanId);

            const previousDestination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            if (!previousDestination) throw new Error('Destination account not found');

            const nextDestination = accountStore.getAccount(loanTakenInput.destinationAccountId);
            if (!nextDestination) throw new Error('Destination account not found');

            // Pre-flight the next cash advance card BEFORE any mutation so we
            // don't partially reverse prior state and then bail out.
            if (loanTakenInput.sourceAccountId) {
              const nextCard = accountStore.getAccount(loanTakenInput.sourceAccountId);
              if (!nextCard) throw new Error('Cash advance card not found');
              if (nextCard.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
              if (nextCard.currency !== nextDestination.currency) {
                throw new Error('Cash advance source card must match the receiving account currency');
              }
              // If the card is the same as the previous card, we refund
              // existing.amount before debiting loanTakenInput.amount — only
              // the net debit needs to be available.
              if (existing.sourceAccountId === nextCard.id) {
                const netDebit = loanTakenInput.amount - existing.amount;
                if (netDebit > 0) checkBalanceForTransaction(nextCard, netDebit, loanTakenInput.type);
              } else {
                checkBalanceForTransaction(nextCard, loanTakenInput.amount, loanTakenInput.type);
              }
            }

            await trackedBalanceDelta(scope, previousDestination.id, -existing.amount);

            if (existing.sourceAccountId) {
              const previousCashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
              if (!previousCashAdvanceCard) throw new Error('Cash advance card not found');
              await trackedBalanceDelta(scope, previousCashAdvanceCard.id, existing.amount);
            }

            let nextSourceAccountId: string | null = null;
            if (loanTakenInput.sourceAccountId) {
              await trackedBalanceDelta(scope, loanTakenInput.sourceAccountId, -loanTakenInput.amount);
              nextSourceAccountId = loanTakenInput.sourceAccountId;
            }

            await trackedBalanceDelta(scope, nextDestination.id, loanTakenInput.amount);

            await trackedUpdateLoan(scope, relatedLoanId, {
              personName: loanTakenInput.personName,
              ...(loanTakenInput.personId !== undefined ? { personId: loanTakenInput.personId } : {}),
              totalAmount: loanTakenInput.amount,
              remainingAmount: loanTakenInput.amount,
              currency: nextDestination.currency,
              status: 'active',
              notes: loanTakenInput.notes ?? '',
            });

            if (priorSchedule.length > 0) {
              await trackedDeleteEmisByLoan(scope, relatedLoanId);
              await trackedRegenerateEmis(
                scope,
                relatedLoanId,
                loanTakenInput.amount,
                priorSchedule.length,
                priorSchedule[0].dueDate,
              );
            }

            updated = {
              ...existing,
              amount: loanTakenInput.amount,
              currency: nextDestination.currency,
              sourceAccountId: nextSourceAccountId,
              destinationAccountId: loanTakenInput.destinationAccountId,
              relatedPerson: loanTakenInput.personName,
              ...(loanTakenInput.personId !== undefined ? { personId: loanTakenInput.personId } : {}),
              conversionRate: null,
              notes: loanTakenInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = nextSourceAccountId
              ? `Updated cash advance from credit card for ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`
              : `Updated borrowed money from ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`;
            break;
          }
        }

        updated = { ...updated, updatedAt: new Date().toISOString() };
        await trackedUpdateTransaction(scope, id, updated, existing);

        return { updated, description };
      },
      refetchMoneyStores,
    );

    await logActivitySafe('transaction_modified', description, updated.id, 'transaction');

    return updated;
  },

  setReconciled: async (id, isReconciled) => {
    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');

    const reconciledBy = localStorage.getItem('hisaab_supabase_uid');
    const changes: Partial<Transaction> = {
      isReconciled,
      reconciledAt: isReconciled ? new Date().toISOString() : null,
      reconciledBy: isReconciled ? reconciledBy : null,
      updatedAt: new Date().toISOString(),
    };

    await transactionsDb.update(id, changes);
    const updated = { ...existing, ...changes };
    await mirrorPut(db.transactions, updated);
    markMirrorStale('transactions');
    set(state => ({
      transactions: state.transactions.map(transaction =>
        transaction.id === id ? updated : transaction
      ),
    }));
  },

  setReceiptPath: async (id, receiptPath) => {
    const existing = get().transactions.find((t) => t.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');
    const changes: Partial<Transaction> = { receiptPath, updatedAt: new Date().toISOString() };
    await transactionsDb.update(id, changes);
    const updated = { ...existing, ...changes };
    await mirrorPut(db.transactions, updated);
    markMirrorStale('transactions');
    set(state => ({
      transactions: state.transactions.map(t => (t.id === id ? updated : t)),
    }));
  },

  deleteTransaction: async (id, options = {}) => {
    await ensureSupportingStoresLoaded();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) return;

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (
      existingNoteMeta.groupExpenseId &&
      !options.allowLinkedGroupExpense &&
      await groupExpenseStillExists(existingNoteMeta.groupExpenseId)
    ) {
      throw new Error('This expense belongs to a group. Delete it from the group details screen.');
    }

    const isInvestmentTxn =
      existing.type === 'investment_buy' || existing.type === 'investment_sell' || existing.type === 'investment_dividend';
    if (isInvestmentTxn && !options.allowInvestment) {
      // The Investments screen runs the position-integrity replay guard
      // before delegating here — a raw History delete would skip it.
      throw new Error('This entry belongs to an investment. Delete it from the Investments screen.');
    }
    if (isInvestmentTxn) {
      const inv = useInvestmentStore.getState();
      if (inv.markets.length === 0 && inv.trades.length === 0) await inv.loadInvestments();
    }

    await runSafeMutation(async (scope) => {
      const accountStore = useAccountStore.getState();
      // Accounts are soft-deleted; a missing account on a REVERSAL leg means
      // the user retired it — there is no live balance left to maintain, so
      // the leg is skipped instead of stranding the row behind 'not found'.

      switch (existing.type) {
        case 'expense': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);
          break;
        }

        case 'income':
        case 'opening_balance': {
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          if (destination) {
            checkReversalBalance(destination, existing.amount, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -existing.amount);
          }
          break;
        }

        case 'transfer': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          const destinationAmount = existing.conversionRate
            ? Math.round(existing.amount * existing.conversionRate * 100) / 100
            : existing.amount;
          if (destination) {
            checkReversalBalance(destination, destinationAmount, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -destinationAmount);
          }
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);

          // A bill payment into a credit card auto-settled that card's
          // cash-advance loans via ledger rows stamped with this transfer's
          // id. Deleting the transfer must re-open those loans and remove the
          // rows — otherwise the card debt returns while the loans stay
          // settled (the mirror image of the original double-credit bug).
          const settledRows = get().transactions.filter(
            (t) =>
              t.type === 'repayment' &&
              !t.sourceAccountId &&
              !t.destinationAccountId &&
              t.relatedLoanId &&
              parseInternalNote(t.notes).meta.linkedTransactionId === existing.id,
          );
          for (const row of settledRows) {
            const rowLoan = useLoanStore.getState().getLoan(row.relatedLoanId!);
            if (rowLoan) {
              await trackedUpdateLoan(scope, rowLoan.id, {
                remainingAmount: Math.min(
                  rowLoan.totalAmount,
                  Math.round((rowLoan.remainingAmount + row.amount) * 100) / 100,
                ),
                status: 'active',
              });
              await trackedSyncEmisToLoan(scope, rowLoan.id);
            }
            await trackedDeleteTransaction(scope, row);
          }
          break;
        }

        case 'loan_given': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this entry');
          const hasRepayments = get().transactions.some(
            (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
          );
          if (hasRepayments) {
            throw new Error('This loan already has repayments. Remove those repayments first.');
          }

          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);
          await trackedDeleteEmisByLoan(scope, relatedLoanId);
          await trackedDeleteLoan(scope, relatedLoanId);
          break;
        }

        case 'loan_taken': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this entry');
          const hasRepayments = get().transactions.some(
            (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
          );
          if (hasRepayments) {
            throw new Error('This loan already has repayments. Remove those repayments first.');
          }

          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          if (destination) await trackedBalanceDelta(scope, destination.id, -existing.amount);

          if (existing.sourceAccountId) {
            const cashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
            if (cashAdvanceCard) await trackedBalanceDelta(scope, cashAdvanceCard.id, existing.amount);
          }

          await trackedDeleteEmisByLoan(scope, relatedLoanId);
          await trackedDeleteLoan(scope, relatedLoanId);
          break;
        }

        case 'repayment': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this repayment');
          const loan = useLoanStore.getState().getLoan(relatedLoanId);
          if (!loan) throw new Error('Loan not found');
          // A repayment on an ACTIVE linked (cross-user) loan exists on both
          // users' books — deleting it one-sided would silently diverge them.
          if (loan.loanPairId && loan.status === 'active') {
            throw new Error(tStatic('err_linked_repayment_delete').replace('{person}', loan.personName));
          }
          // Ledger-only records (written by loanStore.applyRepayment) carry no
          // account legs — there is no balance to reverse, only the loan.
          const isLedgerRecord = !existing.sourceAccountId && !existing.destinationAccountId;
          if (isLedgerRecord) {
            // no balance legs to reverse
          } else if (loan.type === 'given') {
            const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            const creditedAmount = existing.conversionRate
              ? Math.round(existing.amount * existing.conversionRate * 100) / 100
              : existing.amount;
            if (destination) {
              checkReversalBalance(destination, creditedAmount, options.allowNegative);
              await trackedBalanceDelta(scope, destination.id, -creditedAmount);
            }
          } else {
            const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const deductedAmount = existing.conversionRate
              ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
              : existing.amount;
            if (source) await trackedBalanceDelta(scope, source.id, deductedAmount);
            if (existing.destinationAccountId) {
              const cashAdvanceCard = accountStore.getAccount(existing.destinationAccountId);
              if (cashAdvanceCard) {
                // Reverse exactly what was credited — clamped repayments stamp
                // the true figure into their internal note.
                const creditedBack = cardCreditedAmountOf(existing);
                checkReversalBalance(cashAdvanceCard, creditedBack, options.allowNegative);
                await trackedBalanceDelta(scope, cashAdvanceCard.id, -creditedBack);
              }
            }
          }
          await trackedUpdateLoan(scope, relatedLoanId, {
            remainingAmount: Math.min(loan.totalAmount, Math.round((loan.remainingAmount + existing.amount) * 100) / 100),
            status: 'active',
          });
          // The schedule must follow the money: un-mark instalments this
          // repayment had covered (and re-mark any still covered). This is the
          // reverse flow the old blanket guard ("linked to an EMI schedule")
          // claimed existed elsewhere but never did — repayments on EMI loans
          // are now deletable, which also un-deadlocks loan edit/delete.
          await trackedSyncEmisToLoan(scope, relatedLoanId);
          break;
        }

        case 'adjustment': {
          const adjustedId = existing.destinationAccountId ?? existing.sourceAccountId;
          const adjusted = adjustedId ? accountStore.getAccount(adjustedId) : undefined;
          if (adjusted) {
            // destination leg = balance was raised → reverse lowers it (and may
            // need the money to still be there); source leg = the opposite.
            const delta = existing.destinationAccountId ? -existing.amount : existing.amount;
            if (delta < 0) checkReversalBalance(adjusted, existing.amount, options.allowNegative);
            await trackedBalanceDelta(scope, adjusted.id, delta);
          }
          break;
        }

        case 'goal_contribution': {
          if (!existing.relatedGoalId) throw new Error('Savings contribution details not found');
          // Self-stored contributions moved no balances (goalSelfStored flag)
          // — only the goal's saved total reverses.
          const selfStored = existingNoteMeta.goalSelfStored === '1';
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          const restoredAmount = existing.conversionRate
            ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
            : existing.amount;
          if (!selfStored && existing.destinationAccountId) {
            const destination = accountStore.getAccount(existing.destinationAccountId);
            if (destination) {
              checkReversalBalance(destination, existing.amount, options.allowNegative);
              await trackedBalanceDelta(scope, destination.id, -existing.amount);
            }
          }
          if (!selfStored && source) await trackedBalanceDelta(scope, source.id, restoredAmount);
          await trackedAddContribution(scope, existing.relatedGoalId, -existing.amount);
          break;
        }

        case 'investment_buy': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          // Refund exactly what was deducted (same conversion arithmetic as apply).
          const deducted = existing.conversionRate
            ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
            : existing.amount;
          if (source) await trackedBalanceDelta(scope, source.id, deducted);
          // Two-way lookup: relatedInvestmentId is primary, transactionId is
          // the fallback for rows restored from backups that predate the link
          // column — otherwise the trade row would survive as phantom shares.
          const invTrades = useInvestmentStore.getState().trades;
          const trade = (existing.relatedInvestmentId
            ? invTrades.find((t) => t.id === existing.relatedInvestmentId)
            : undefined) ?? invTrades.find((t) => t.transactionId === existing.id);
          if (trade) await trackedDeleteInvestmentTrade(scope, trade);
          break;
        }

        case 'investment_sell':
        case 'investment_dividend': {
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          const credited = existing.conversionRate
            ? Math.round(existing.amount * existing.conversionRate * 100) / 100
            : existing.amount;
          if (destination) {
            // The credited money may have been spent since — income-delete precedent.
            checkReversalBalance(destination, credited, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -credited);
          }
          const invTrades = useInvestmentStore.getState().trades;
          const trade = (existing.relatedInvestmentId
            ? invTrades.find((t) => t.id === existing.relatedInvestmentId)
            : undefined) ?? invTrades.find((t) => t.transactionId === existing.id);
          if (trade) await trackedDeleteInvestmentTrade(scope, trade);
          break;
        }
      }

      await trackedDeleteTransaction(scope, existing);
    }, refetchMoneyStores);

    await logActivitySafe(
      'transaction_deleted',
      `Deleted ${existing.type.replace(/_/g, ' ')} entry`,
      existing.id,
      'transaction',
    );
  },

  deleteLoanCascade: async (loanId, options = {}) => {
    await ensureSupportingStoresLoaded();
    if (get().transactions.length === 0) {
      const transactions = await transactionsDb.getAll();
      set({ transactions });
    }

    const loan = useLoanStore.getState().getLoan(loanId);
    if (!loan) throw new Error('Loan not found');
    // Linked (cross-user) active loans must not vanish from one side only.
    assertLinkedLoanDeleteAllowed(loan);

    const related = get().transactions.filter((t) => t.relatedLoanId === loanId);
    const repayments = related.filter((t) => t.type === 'repayment');
    const origins = related.filter((t) => t.type === 'loan_given' || t.type === 'loan_taken');

    await runSafeMutation(async (scope) => {
      const accountStore = useAccountStore.getState();

      // 1) Reverse every repayment's balance legs and remove the rows. The
      //    per-row loan restore is skipped — the loan itself dies at the end.
      //    Missing (soft-deleted) accounts simply skip their leg.
      for (const r of repayments) {
        const isLedgerRecord = !r.sourceAccountId && !r.destinationAccountId;
        if (!isLedgerRecord && loan.type === 'given') {
          const destination = r.destinationAccountId ? accountStore.getAccount(r.destinationAccountId) : undefined;
          const credited = r.conversionRate
            ? Math.round(r.amount * r.conversionRate * 100) / 100
            : r.amount;
          if (destination) {
            checkReversalBalance(destination, credited, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -credited);
          }
        } else if (!isLedgerRecord) {
          const source = r.sourceAccountId ? accountStore.getAccount(r.sourceAccountId) : undefined;
          const deducted = r.conversionRate
            ? Math.round((r.amount / r.conversionRate) * 100) / 100
            : r.amount;
          if (source) await trackedBalanceDelta(scope, source.id, deducted);
          if (r.destinationAccountId) {
            const cashAdvanceCard = accountStore.getAccount(r.destinationAccountId);
            if (cashAdvanceCard) {
              const creditedBack = cardCreditedAmountOf(r);
              checkReversalBalance(cashAdvanceCard, creditedBack, options.allowNegative);
              await trackedBalanceDelta(scope, cashAdvanceCard.id, -creditedBack);
            }
          }
        }
        await trackedDeleteTransaction(scope, r);
      }

      // 2) Reverse the principal legs of the origin entry (if any — ledger-only
      //    loans have none) and remove it. Mirrors the single-delete branches.
      for (const o of origins) {
        if (o.type === 'loan_given') {
          const source = o.sourceAccountId ? accountStore.getAccount(o.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, o.amount);
        } else {
          const destination = o.destinationAccountId ? accountStore.getAccount(o.destinationAccountId) : undefined;
          if (destination) await trackedBalanceDelta(scope, destination.id, -o.amount);
          if (o.sourceAccountId) {
            const cashAdvanceCard = accountStore.getAccount(o.sourceAccountId);
            if (cashAdvanceCard) await trackedBalanceDelta(scope, cashAdvanceCard.id, o.amount);
          }
        }
        await trackedDeleteTransaction(scope, o);
      }

      // 3) Schedule and loan row last, so LIFO rollback restores them first.
      await trackedDeleteEmisByLoan(scope, loanId);
      await trackedDeleteLoan(scope, loanId);
    }, refetchMoneyStores);

    await logActivitySafe(
      'transaction_deleted',
      `Deleted loan with ${loan.personName} (${loan.currency} ${loan.totalAmount}) — ${repayments.length + origins.length} record(s) removed, balances restored`,
      loanId,
      'loan',
    );
  },

  getTransaction: (id) => get().transactions.find((transaction) => transaction.id === id),

  getByAccount: (accountId) =>
    get().transactions.filter(
      (t) => t.sourceAccountId === accountId || t.destinationAccountId === accountId
    ),

  getByLoan: (loanId) => get().transactions.filter((t) => t.relatedLoanId === loanId),

  // Re-insert a previously-deleted transaction with its original id and
  // re-apply the balance delta that the delete had reversed. Used only by
  // splitStore.updateGroupExpense rollback. Best-effort: failure of the
  // balance step does NOT abort the row re-insert — we accept a small drift
  // over leaving the ledger row missing entirely. The mutationScope upstream
  // will surface drift via refetch.
  restoreTransaction: async (snapshot) => {
    // Only expense/income balance effects can be faithfully re-applied here.
    // Anything else (loans, EMIs, goals, cards, trades) would resurrect the
    // row WITHOUT its money — and a later re-delete would reverse balances a
    // second time, minting money. Callers (Undo toasts) must not offer this
    // for other types; this guard makes that a hard rule, not a convention.
    if (snapshot.type !== 'expense' && snapshot.type !== 'income') {
      throw new Error('Undo is only supported for expense and income entries');
    }
    const accountStore = useAccountStore.getState();
    await transactionsDb.add(snapshot);
    await mirrorPut(db.transactions, snapshot);
    markMirrorStale('transactions');
    set((s) => ({ transactions: [snapshot, ...s.transactions] }));

    // Re-apply balance deltas matching the snapshot's type. Only the small
    // subset of types that linked group-expenses can produce is handled —
    // everything else is left to manual reconciliation.
    try {
      if (snapshot.type === 'expense' && snapshot.sourceAccountId) {
        await accountStore.updateBalance(snapshot.sourceAccountId, -snapshot.amount);
      } else if (snapshot.type === 'income' && snapshot.destinationAccountId) {
        await accountStore.updateBalance(snapshot.destinationAccountId, snapshot.amount);
      }
    } catch (err) {
      console.error('[restoreTransaction] balance re-apply failed; row restored but balance may need refetch', err);
    }
  },
}));
