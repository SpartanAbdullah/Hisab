import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { Account, AccountType, Currency, Transaction } from '../db';
import { useActivityStore } from './activityStore';

interface CreateAccountInput {
  name: string;
  type: AccountType;
  currency: Currency;
  balance: number;
  metadata?: Record<string, string>;
}

interface AccountState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: () => Promise<void>;
  createAccount: (input: CreateAccountInput) => Promise<Account>;
  getAccount: (id: string) => Account | undefined;
  updateBalance: (id: string, delta: number) => Promise<void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  loading: false,

  loadAccounts: async () => {
    set({ loading: true });
    const accounts = await db.accounts.toArray();
    set({ accounts, loading: false });
  },

  createAccount: async (input) => {
    const account: Account = {
      id: uuid(),
      name: input.name,
      type: input.type,
      currency: input.currency,
      balance: input.balance,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    await db.accounts.add(account);
    set((s) => ({ accounts: [...s.accounts, account] }));

    const activityStore = useActivityStore.getState();
    await activityStore.logActivity(
      'account_created',
      `Created ${input.type} account "${input.name}" with ${input.currency} ${input.balance}`,
      account.id,
      'account'
    );

    // FIX 7: Log opening balance as a transaction if balance > 0
    if (input.balance > 0) {
      const txId = uuid();
      const tx: Transaction = {
        id: txId,
        type: 'opening_balance',
        amount: input.balance,
        currency: input.currency,
        sourceAccountId: null,
        destinationAccountId: account.id,
        relatedPerson: null,
        relatedLoanId: null,
        relatedGoalId: null,
        conversionRate: null,
        category: '',
        notes: 'Opening Balance',
        createdAt: account.createdAt,
      };
      await db.transactions.add(tx);
      await activityStore.logActivity(
        'opening_balance',
        `Opening Balance — ${input.currency} ${input.balance} in "${input.name}"`,
        account.id,
        'account'
      );
    }

    return account;
  },

  getAccount: (id) => get().accounts.find((a) => a.id === id),

  updateBalance: async (id, delta) => {
    const account = get().accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Account ${id} not found`);
    const newBalance = Math.round((account.balance + delta) * 100) / 100;
    await db.accounts.update(id, { balance: newBalance });
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === id ? { ...a, balance: newBalance } : a)),
    }));
  },
}));
