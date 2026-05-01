import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { transactionsDb, emiSchedulesDb, loansDb } from '../lib/supabaseDb';
import type { Transaction, Currency, EmiSchedule, EmiStatus, Loan, ActivityType } from '../db';
import { useAccountStore } from './accountStore';
import { useLoanStore, type CreateLoanInput } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';
import { parseInternalNote } from '../lib/internalNotes';
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

export type TransactionInput =
  | IncomeInput
  | ExpenseInput
  | TransferInput
  | LoanGivenInput
  | LoanTakenInput
  | RepaymentInput
  | GoalContributionInput
  | OpeningBalanceInput;

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
  deleteTransaction: (id: string, options?: { allowLinkedGroupExpense?: boolean }) => Promise<void>;
  getTransaction: (id: string) => Transaction | undefined;
  getByAccount: (accountId: string) => Transaction[];
  getByLoan: (loanId: string) => Transaction[];
  reset: () => void;
}

const INITIAL_TRANSACTION_STATE = {
  transactions: [] as Transaction[],
  loading: false,
};

// Insufficient balance check helper
function checkBalance(account: { name: string; balance: number; type: string; metadata: Record<string, string> }, amount: number) {
  if (account.balance < amount) {
    throw new Error(`${account.name} mein sirf ${account.balance.toLocaleString()} hain. Itne pesay nahi hain.`);
  }
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
  await loansDb.add(loan);
  useLoanStore.setState(s => ({ loans: [...s.loans, loan] }));
  scope.register(async () => {
    await loansDb.delete(loan.id);
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
  await loansDb.update(loanId, { remainingAmount: newRemaining, status: newStatus });
  useLoanStore.setState(s => ({
    loans: s.loans.map(l => (l.id === loanId ? { ...l, remainingAmount: newRemaining, status: newStatus } : l)),
  }));
  scope.register(async () => {
    await loansDb.update(loanId, { remainingAmount: prevRemaining, status: prevStatus });
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
  await useGoalStore.getState().addContribution(goalId, amount);
  scope.register(() => useGoalStore.getState().addContribution(goalId, -amount));
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

async function trackedMarkAllEmisPaid(scope: MutationScope, loanId: string): Promise<void> {
  // Snapshot every schedule we're about to flip so we can restore per-id
  // statuses exactly. Also bypass store.markAllPaidForLoan for the same
  // reason as trackedMarkEmiPaid (embedded logActivity).
  const before = useEmiStore.getState().schedules
    .filter(e => e.loanId === loanId && e.status !== 'paid')
    .map(e => ({ id: e.id, status: e.status, installmentNumber: e.installmentNumber }));
  if (before.length === 0) return;
  await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: 'paid' as EmiStatus })));
  useEmiStore.setState(state => ({
    schedules: state.schedules.map(e =>
      e.loanId === loanId && e.status !== 'paid' ? { ...e, status: 'paid' as EmiStatus } : e,
    ),
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
        : `${before.length} EMIs marked paid after full repayment`,
      loanId,
      'loan',
    );
  } catch (err) {
    console.error('logActivity failed in trackedMarkAllEmisPaid (non-fatal)', err);
  }
}

async function trackedAddTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.add(tx);
  useTransactionStore.setState(s => ({ transactions: [tx, ...s.transactions] }));
  scope.register(async () => {
    await transactionsDb.delete(tx.id);
    useTransactionStore.setState(s => ({ transactions: s.transactions.filter(t => t.id !== tx.id) }));
  });
}

async function trackedUpdateTransaction(scope: MutationScope, id: string, updated: Transaction, snapshot: Transaction): Promise<void> {
  await transactionsDb.update(id, updated);
  useTransactionStore.setState(state => ({
    transactions: state.transactions.map(t => (t.id === id ? updated : t)),
  }));
  scope.register(async () => {
    await transactionsDb.update(id, snapshot);
    useTransactionStore.setState(state => ({
      transactions: state.transactions.map(t => (t.id === id ? snapshot : t)),
    }));
  });
}

async function trackedDeleteTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.delete(tx.id);
  useTransactionStore.setState(state => ({
    transactions: state.transactions.filter(t => t.id !== tx.id),
  }));
  scope.register(async () => {
    await transactionsDb.add(tx);
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
// remote. Force-refetch the two stores that carry money-critical data.
async function refetchMoneyStores(): Promise<void> {
  try {
    await useAccountStore.getState().loadAccounts();
    await useTransactionStore.getState().loadTransactions();
    await useLoanStore.getState().loadLoans();
    await useEmiStore.getState().loadSchedules();
    await useGoalStore.getState().loadGoals();
  } catch (err) {
    console.error('Post-rollback refetch failed — local state may be stale until next navigation', err);
  }
}


export const useTransactionStore = create<TransactionState>((set, get) => ({
  ...INITIAL_TRANSACTION_STATE,

  reset: () => set(INITIAL_TRANSACTION_STATE),

  loadTransactions: async () => {
    set({ loading: true });
    try {
      const transactions = await transactionsDb.getAll();
      set({ transactions });
    } finally {
      set({ loading: false });
    }
  },

  processTransaction: async (input) => {
    await ensureSupportingStoresLoaded();

    const { transaction, description } = await runSafeMutation<{ transaction: Transaction; description: string }>(
      async (scope) => {
        const accountStore = useAccountStore.getState();
        const loanStore = useLoanStore.getState();
        const goalStore = useGoalStore.getState();

        let currency: Currency = 'AED';
        let sourceAccountId: string | null = null;
        let destinationAccountId: string | null = null;
        let relatedPerson: string | null = null;
        let personId: string | null = null;
        let relatedLoanId: string | null = null;
        let relatedGoalId: string | null = null;
        let conversionRate: number | null = null;
        let description = '';

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
            checkBalance(srcAccount, input.amount);
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
            break;
          }

          case 'loan_given': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            checkBalance(src, input.amount);
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
              checkBalance(src, input.amount);
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
            const shouldSettleRemainingEmis = !input.emiId && loan.remainingAmount - input.amount <= 0.00001;

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

              if (src.currency !== loan.currency) {
                if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
                conversionRate = input.conversionRate;
                const srcDeduct = Math.round(input.amount / input.conversionRate * 100) / 100;
                checkBalance(src, srcDeduct);
                sourceAccountId = input.sourceAccountId;
                await trackedBalanceDelta(scope, input.sourceAccountId, -srcDeduct);
                description = `Repaid ${loan.currency} ${input.amount} (deducted ${src.currency} ${srcDeduct}) to ${loan.personName} (rate: ${input.conversionRate})`;
              } else {
                checkBalance(src, input.amount);
                sourceAccountId = input.sourceAccountId;
                await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
                description = `Repaid ${currency} ${input.amount} to ${loan.personName}`;
              }
            }

            await trackedApplyRepayment(scope, input.loanId, input.amount);
            if (input.emiId) {
              await trackedMarkEmiPaid(scope, input.emiId);
            } else if (shouldSettleRemainingEmis) {
              await trackedMarkAllEmisPaid(scope, input.loanId);
            }
            break;
          }

          case 'goal_contribution': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            const goal = goalStore.getGoal(input.goalId);
            if (!goal) throw new Error('Goal not found');

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
        }

        const transaction: Transaction = {
          id: uuid(),
          type: input.type,
          amount: input.amount,
          currency,
          sourceAccountId,
          destinationAccountId,
          relatedPerson,
          personId,
          relatedLoanId,
          relatedGoalId,
          conversionRate,
          category: input.category ?? '',
          notes: input.notes ?? '',
          createdAt: input.createdAt ?? new Date().toISOString(),
        };

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
    if (existingNoteMeta.groupExpenseId && !options.allowLinkedGroupExpense) {
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
              checkBalance(nextSource, expenseInput.amount);
            } else {
              // Same account — refund-then-charge nets (next - existing);
              // only that delta needs to be available.
              const netDebit = expenseInput.amount - existing.amount;
              if (netDebit > 0) checkBalance(nextSource, netDebit);
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
            if (emiStore.getByLoan(relatedLoanId).length > 0) {
              throw new Error('This loan already has an EMI schedule. Delete and recreate it after editing.');
            }

            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const nextSource = accountStore.getAccount(loanGivenInput.sourceAccountId);
            if (!previousSource || !nextSource) throw new Error('Source account not found');

            if (previousSource.id !== nextSource.id) {
              checkBalance(nextSource, loanGivenInput.amount);
            } else {
              const netDebit = loanGivenInput.amount - existing.amount;
              if (netDebit > 0) checkBalance(nextSource, netDebit);
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

            updated = {
              ...existing,
              amount: loanGivenInput.amount,
              currency: nextSource.currency,
              sourceAccountId: loanGivenInput.sourceAccountId,
              relatedPerson: loanGivenInput.personName,
              ...(loanGivenInput.personId !== undefined ? { personId: loanGivenInput.personId } : {}),
              notes: loanGivenInput.notes ?? '',
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
            if (emiStore.getByLoan(relatedLoanId).length > 0) {
              throw new Error('This loan already has an EMI schedule. Delete and recreate it after editing.');
            }

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
                if (netDebit > 0) checkBalance(nextCard, netDebit);
              } else {
                checkBalance(nextCard, loanTakenInput.amount);
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
            };
            description = nextSourceAccountId
              ? `Updated cash advance from credit card for ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`
              : `Updated borrowed money from ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`;
            break;
          }
        }

        await trackedUpdateTransaction(scope, id, updated, existing);

        return { updated, description };
      },
      refetchMoneyStores,
    );

    await logActivitySafe('transaction_modified', description, updated.id, 'transaction');

    return updated;
  },

  deleteTransaction: async (id, options = {}) => {
    await ensureSupportingStoresLoaded();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) return;

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (existingNoteMeta.groupExpenseId && !options.allowLinkedGroupExpense) {
      throw new Error('This expense belongs to a group. Delete it from the group details screen.');
    }

    if (!isEditableTransactionType(existing.type)) {
      throw new Error('Only expenses and lend/borrow entries can be deleted right now.');
    }

    await runSafeMutation(async (scope) => {
      const accountStore = useAccountStore.getState();

      switch (existing.type) {
        case 'expense': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          if (!source) throw new Error('Source account not found');
          await trackedBalanceDelta(scope, source.id, existing.amount);
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
          if (!source) throw new Error('Source account not found');

          await trackedBalanceDelta(scope, source.id, existing.amount);
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
          if (!destination) throw new Error('Destination account not found');

          await trackedBalanceDelta(scope, destination.id, -existing.amount);

          if (existing.sourceAccountId) {
            const cashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
            if (!cashAdvanceCard) throw new Error('Cash advance card not found');
            await trackedBalanceDelta(scope, cashAdvanceCard.id, existing.amount);
          }

          await trackedDeleteEmisByLoan(scope, relatedLoanId);
          await trackedDeleteLoan(scope, relatedLoanId);
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

  getTransaction: (id) => get().transactions.find((transaction) => transaction.id === id),

  getByAccount: (accountId) =>
    get().transactions.filter(
      (t) => t.sourceAccountId === accountId || t.destinationAccountId === accountId
    ),

  getByLoan: (loanId) => get().transactions.filter((t) => t.relatedLoanId === loanId),
}));
