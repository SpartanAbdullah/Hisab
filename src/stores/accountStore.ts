import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { accountsDb, transactionsDb } from '../lib/supabaseDb';
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
  renameAccount: (id: string, newName: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  reset: () => void;
}

const INITIAL_ACCOUNT_STATE = {
  accounts: [] as Account[],
  loading: false,
};

export const useAccountStore = create<AccountState>((set, get) => ({
  ...INITIAL_ACCOUNT_STATE,

  reset: () => set(INITIAL_ACCOUNT_STATE),

  loadAccounts: async () => {
    set({ loading: true });
    try {
      const accounts = await accountsDb.getAll();
      set({ accounts });
    } finally {
      // Always clear loading — error still propagates so page-level
      // useAsyncLoad can render its retry UI.
      set({ loading: false });
    }
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
    await accountsDb.add(account);
    set((s) => ({ accounts: [...s.accounts, account] }));

    const activityStore = useActivityStore.getState();
    await activityStore.logActivity(
      'account_created',
      `Created ${input.type} account "${input.name}" with ${input.currency} ${input.balance}`,
      account.id,
      'account'
    );

    // Log opening balance as a transaction if balance > 0
    if (input.balance > 0) {
      const tx: Transaction = {
        id: uuid(),
        type: 'opening_balance',
        amount: input.balance,
        currency: input.currency,
        sourceAccountId: null,
        destinationAccountId: account.id,
        relatedPerson: null,
        personId: null,
        relatedLoanId: null,
        relatedGoalId: null,
        conversionRate: null,
        category: '',
        notes: 'Opening Balance',
        createdAt: account.createdAt,
      };
      await transactionsDb.add(tx);
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
    await accountsDb.update(id, { balance: newBalance });
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === id ? { ...a, balance: newBalance } : a)),
    }));
  },

  renameAccount: async (id, newName) => {
    await accountsDb.update(id, { name: newName });
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === id ? { ...a, name: newName } : a)),
    }));
  },

  deleteAccount: async (id) => {
    const account = get().accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Account ${id} not found`);
    if (account.balance !== 0) throw new Error('Account must have zero balance to delete');
    await accountsDb.delete(id);
    set((s) => ({
      accounts: s.accounts.filter((a) => a.id !== id),
    }));
    await useActivityStore.getState().logActivity(
      'account_deleted',
      `Deleted account "${account.name}"`,
      id,
      'account'
    );
  },
}));
