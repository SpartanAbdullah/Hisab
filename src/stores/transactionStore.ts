import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { Transaction, Currency } from '../db';
import { useAccountStore } from './accountStore';
import { useLoanStore } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';

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
  getByAccount: (accountId: string) => Transaction[];
  getByLoan: (loanId: string) => Transaction[];
}

// FIX 9: Insufficient balance check helper
function checkBalance(account: { name: string; balance: number; type: string; metadata: Record<string, string> }, amount: number) {
  // Credit cards use available credit (balance field already represents available)
  if (account.balance < amount) {
    throw new Error(`${account.name} mein sirf ${account.balance.toLocaleString()} hain. Itne pesay nahi hain.`);
  }
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: [],
  loading: false,

  loadTransactions: async () => {
    set({ loading: true });
    const transactions = await db.transactions.orderBy('createdAt').reverse().toArray();
    set({ transactions, loading: false });
  },

  processTransaction: async (input) => {
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
        // FIX 9: Balance check
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
        // FIX 9: Balance check
        checkBalance(src, input.amount);
        currency = src.currency;
        sourceAccountId = input.sourceAccountId;
        destinationAccountId = input.destinationAccountId;
        await accountStore.updateBalance(input.sourceAccountId, -input.amount);

        if (src.currency !== dest.currency) {
          // FIX 5: Cross-currency conversion required
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
        // FIX 9: Balance check
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
        description = `Loan taken from ${input.personName}: ${currency} ${input.amount}`;
        break;
      }

      // FIX 8: Loan repayment accounting + BATCH6: CurrencyGuard
      case 'repayment': {
        const loan = loanStore.getLoan(input.loanId);
        if (!loan) throw new Error('Loan not found');
        relatedLoanId = input.loanId;
        relatedPerson = loan.personName;
        currency = loan.currency;

        if (loan.type === 'given') {
          // Someone is paying us back → money comes INTO our account
          if (!input.destinationAccountId) throw new Error('Destination account required');
          const dest = accountStore.getAccount(input.destinationAccountId);
          if (!dest) throw new Error('Destination account not found');
          destinationAccountId = input.destinationAccountId;

          // CurrencyGuard: if account currency ≠ loan currency, conversion required
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
          // We're paying someone back → money LEAVES our account
          if (!input.sourceAccountId) throw new Error('Source account required');
          const src = accountStore.getAccount(input.sourceAccountId);
          if (!src) throw new Error('Source account not found');

          // CurrencyGuard: if account currency ≠ loan currency, conversion required
          if (src.currency !== loan.currency) {
            if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
            conversionRate = input.conversionRate;
            // User enters amount in loan currency. We deduct converted amount from source.
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
        }
        break;
      }

      // FIX 3: Goal contribution with linked account + BATCH6: CurrencyGuard
      case 'goal_contribution': {
        const src = accountStore.getAccount(input.sourceAccountId);
        if (!src) throw new Error('Source account not found');
        const goal = goalStore.getGoal(input.goalId);
        if (!goal) throw new Error('Goal not found');

        // CurrencyGuard: source account currency ≠ goal currency → need conversion
        if (src.currency !== goal.currency) {
          if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
          conversionRate = input.conversionRate;
          // input.amount is in goal's currency. Deduct converted amount from source.
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
              // Linked account should match goal currency, add directly
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

    await db.transactions.add(transaction);
    set((s) => ({ transactions: [transaction, ...s.transactions] }));

    await activityStore.logActivity('transaction_created', description, transaction.id, 'transaction');

    return transaction;
  },

  getByAccount: (accountId) =>
    get().transactions.filter(
      (t) => t.sourceAccountId === accountId || t.destinationAccountId === accountId
    ),

  getByLoan: (loanId) => get().transactions.filter((t) => t.relatedLoanId === loanId),
}));
