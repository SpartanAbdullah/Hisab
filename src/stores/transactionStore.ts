import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { transactionsDb } from '../lib/supabaseDb';
import type { Transaction, Currency } from '../db';
import { useAccountStore } from './accountStore';
import { useLoanStore } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';
import { parseInternalNote } from '../lib/internalNotes';

interface BaseTransactionInput {
  amount: number;
  category?: string;
  notes?: string;
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
  loanId?: string;
}

interface LoanTakenInput extends BaseTransactionInput {
  type: 'loan_taken';
  destinationAccountId: string;
  personName: string;
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

export type TransactionInput =
  | IncomeInput
  | ExpenseInput
  | TransferInput
  | LoanGivenInput
  | LoanTakenInput
  | RepaymentInput
  | GoalContributionInput;

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

export const useTransactionStore = create<TransactionState>((set, get) => ({
  ...INITIAL_TRANSACTION_STATE,

  reset: () => set(INITIAL_TRANSACTION_STATE),

  loadTransactions: async () => {
    set({ loading: true });
    const transactions = await transactionsDb.getAll();
    set({ transactions, loading: false });
  },

  processTransaction: async (input) => {
    await ensureSupportingStoresLoaded();

    const accountStore = useAccountStore.getState();
    const loanStore = useLoanStore.getState();
    const goalStore = useGoalStore.getState();
    const emiStore = useEmiStore.getState();
    const activityStore = useActivityStore.getState();

    let currency: Currency = 'AED';
    let sourceAccountId: string | null = null;
    let destinationAccountId: string | null = null;
    let relatedPerson: string | null = null;
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
        await accountStore.updateBalance(input.destinationAccountId, input.amount);
        description = `Income of ${currency} ${input.amount} → ${destAccount.name}`;
        break;
      }

      case 'expense': {
        const srcAccount = accountStore.getAccount(input.sourceAccountId);
        if (!srcAccount) throw new Error('Source account not found');
        checkBalance(srcAccount, input.amount);
        currency = srcAccount.currency;
        sourceAccountId = input.sourceAccountId;
        await accountStore.updateBalance(input.sourceAccountId, -input.amount);
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
        await accountStore.updateBalance(input.sourceAccountId, -input.amount);

        if (src.currency !== dest.currency) {
          if (!input.conversionRate) throw new Error('Conversion rate required for cross-currency move');
          conversionRate = input.conversionRate;
          const destAmount = Math.round(input.amount * input.conversionRate * 100) / 100;
          await accountStore.updateBalance(input.destinationAccountId, destAmount);
          description = `Moved ${src.currency} ${input.amount} → ${dest.currency} ${destAmount} (rate: ${input.conversionRate})`;
        } else {
          await accountStore.updateBalance(input.destinationAccountId, input.amount);
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
        await accountStore.updateBalance(input.sourceAccountId, -input.amount);

        if (!input.loanId) {
          const loan = await loanStore.createLoan({
            personName: input.personName,
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

        if (input.sourceAccountId) {
          const src = accountStore.getAccount(input.sourceAccountId);
          if (!src) throw new Error('Source account not found');
          if (src.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
          if (src.currency !== dest.currency) throw new Error('Cash advance source card must match the receiving account currency');
          checkBalance(src, input.amount);
          sourceAccountId = input.sourceAccountId;
          await accountStore.updateBalance(input.sourceAccountId, -input.amount);
          description = `Cash advance from ${src.name} into ${dest.name}: ${currency} ${input.amount}`;
        }

        await accountStore.updateBalance(input.destinationAccountId, input.amount);

        if (!input.loanId) {
          const loan = await loanStore.createLoan({
            personName: input.personName,
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
            await accountStore.updateBalance(input.destinationAccountId, destAmt);
            description = `Received ${loan.currency} ${input.amount} → ${dest.currency} ${destAmt} from ${loan.personName} (rate: ${input.conversionRate})`;
          } else {
            await accountStore.updateBalance(input.destinationAccountId, input.amount);
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
            await accountStore.updateBalance(input.sourceAccountId, -srcDeduct);
            description = `Repaid ${loan.currency} ${input.amount} (deducted ${src.currency} ${srcDeduct}) to ${loan.personName} (rate: ${input.conversionRate})`;
          } else {
            checkBalance(src, input.amount);
            sourceAccountId = input.sourceAccountId;
            await accountStore.updateBalance(input.sourceAccountId, -input.amount);
            description = `Repaid ${currency} ${input.amount} to ${loan.personName}`;
          }
        }

        await loanStore.applyRepayment(input.loanId, input.amount);
        if (input.emiId) {
          await emiStore.markPaid(input.emiId);
        } else if (shouldSettleRemainingEmis) {
          await emiStore.markAllPaidForLoan(input.loanId);
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
          await accountStore.updateBalance(input.sourceAccountId, -srcDeduct);
          await goalStore.addContribution(input.goalId, input.amount);

          if (goal.storedInAccountId && goal.storedInAccountId !== input.sourceAccountId) {
            const linkedAccount = accountStore.getAccount(goal.storedInAccountId);
            if (linkedAccount) {
              await accountStore.updateBalance(goal.storedInAccountId, input.amount);
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
          await accountStore.updateBalance(input.sourceAccountId, -input.amount);
          await goalStore.addContribution(input.goalId, input.amount);

          if (goal.storedInAccountId && goal.storedInAccountId !== input.sourceAccountId) {
            const linkedAccount = accountStore.getAccount(goal.storedInAccountId);
            if (linkedAccount) {
              await accountStore.updateBalance(goal.storedInAccountId, input.amount);
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
    }

    const transaction: Transaction = {
      id: uuid(),
      type: input.type,
      amount: input.amount,
      currency,
      sourceAccountId,
      destinationAccountId,
      relatedPerson,
      relatedLoanId,
      relatedGoalId,
      conversionRate,
      category: input.category ?? '',
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
    };

    await transactionsDb.add(transaction);
    set((s) => ({ transactions: [transaction, ...s.transactions] }));

    await activityStore.logActivity('transaction_created', description, transaction.id, 'transaction');

    return transaction;
  },

  updateTransaction: async (id, input, options = {}) => {
    await ensureSupportingStoresLoaded();

    const accountStore = useAccountStore.getState();
    const loanStore = useLoanStore.getState();
    const emiStore = useEmiStore.getState();
    const activityStore = useActivityStore.getState();

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

    let updated: Transaction = existing;
    let description = '';

    switch (existing.type) {
      case 'expense': {
        const expenseInput = input as ExpenseInput;
        const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
        const nextSource = accountStore.getAccount(expenseInput.sourceAccountId);
        if (!previousSource || !nextSource) throw new Error('Source account not found');

        await accountStore.updateBalance(previousSource.id, existing.amount);
        checkBalance(nextSource, expenseInput.amount);
        await accountStore.updateBalance(nextSource.id, -expenseInput.amount);

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

        await accountStore.updateBalance(previousSource.id, existing.amount);
        checkBalance(nextSource, loanGivenInput.amount);
        await accountStore.updateBalance(nextSource.id, -loanGivenInput.amount);

        await loanStore.updateLoan(relatedLoanId, {
          personName: loanGivenInput.personName,
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

        await accountStore.updateBalance(previousDestination.id, -existing.amount);

        if (existing.sourceAccountId) {
          const previousCashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
          if (!previousCashAdvanceCard) throw new Error('Cash advance card not found');
          await accountStore.updateBalance(previousCashAdvanceCard.id, existing.amount);
        }

        const nextDestination = accountStore.getAccount(loanTakenInput.destinationAccountId);
        if (!nextDestination) throw new Error('Destination account not found');

        let nextSourceAccountId: string | null = null;
        if (loanTakenInput.sourceAccountId) {
          const nextCashAdvanceCard = accountStore.getAccount(loanTakenInput.sourceAccountId);
          if (!nextCashAdvanceCard) throw new Error('Cash advance card not found');
          if (nextCashAdvanceCard.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
          if (nextCashAdvanceCard.currency !== nextDestination.currency) {
            throw new Error('Cash advance source card must match the receiving account currency');
          }
          checkBalance(nextCashAdvanceCard, loanTakenInput.amount);
          await accountStore.updateBalance(nextCashAdvanceCard.id, -loanTakenInput.amount);
          nextSourceAccountId = nextCashAdvanceCard.id;
        }

        await accountStore.updateBalance(nextDestination.id, loanTakenInput.amount);

        await loanStore.updateLoan(relatedLoanId, {
          personName: loanTakenInput.personName,
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
          conversionRate: null,
          notes: loanTakenInput.notes ?? '',
        };
        description = nextSourceAccountId
          ? `Updated cash advance from credit card for ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`
          : `Updated borrowed money from ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`;
        break;
      }
    }

    await transactionsDb.update(id, updated);
    set((state) => ({
      transactions: state.transactions.map((transaction) => (transaction.id === id ? updated : transaction)),
    }));

    await activityStore.logActivity('transaction_modified', description, updated.id, 'transaction');

    return updated;
  },

  deleteTransaction: async (id, options = {}) => {
    await ensureSupportingStoresLoaded();

    const accountStore = useAccountStore.getState();
    const loanStore = useLoanStore.getState();
    const emiStore = useEmiStore.getState();
    const activityStore = useActivityStore.getState();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) return;

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (existingNoteMeta.groupExpenseId && !options.allowLinkedGroupExpense) {
      throw new Error('This expense belongs to a group. Delete it from the group details screen.');
    }

    if (!isEditableTransactionType(existing.type)) {
      throw new Error('Only expenses and lend/borrow entries can be deleted right now.');
    }

    switch (existing.type) {
      case 'expense': {
        const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
        if (!source) throw new Error('Source account not found');
        await accountStore.updateBalance(source.id, existing.amount);
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

        await accountStore.updateBalance(source.id, existing.amount);
        await emiStore.deleteByLoan(relatedLoanId);
        await loanStore.deleteLoan(relatedLoanId);
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

        await accountStore.updateBalance(destination.id, -existing.amount);

        if (existing.sourceAccountId) {
          const cashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
          if (!cashAdvanceCard) throw new Error('Cash advance card not found');
          await accountStore.updateBalance(cashAdvanceCard.id, existing.amount);
        }

        await emiStore.deleteByLoan(relatedLoanId);
        await loanStore.deleteLoan(relatedLoanId);
        break;
      }
    }

    await transactionsDb.delete(id);
    set((state) => ({
      transactions: state.transactions.filter((transaction) => transaction.id !== id),
    }));

    await activityStore.logActivity(
      'transaction_deleted',
      `Deleted ${existing.type.replace(/_/g, ' ')} entry`,
      existing.id,
      'transaction'
    );
  },

  getTransaction: (id) => get().transactions.find((transaction) => transaction.id === id),

  getByAccount: (accountId) =>
    get().transactions.filter(
      (t) => t.sourceAccountId === accountId || t.destinationAccountId === accountId
    ),

  getByLoan: (loanId) => get().transactions.filter((t) => t.relatedLoanId === loanId),
}));
