import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { accountsDb, transactionsDb } from '../lib/supabaseDb';
import { loadCacheFirst, mirrorDelete, mirrorPut, markMirrorStale } from '../lib/mirrorCache';
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
  // Merge-patch the metadata map (creditLimit, dueDay, …). An empty-string
  // value removes that key.
  updateMetadata: (id: string, patch: Record<string, string>) => Promise<void>;
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
      const { rows: accounts } = await loadCacheFirst({
        key: 'accounts',
        table: db.accounts,
        fetchRemote: accountsDb.getAll,
        fetchUpdatedSince: accountsDb.getUpdatedSince,
        fetchDeletedSince: accountsDb.getDeletedSince,
        getUpdatedAt: (account) => account.updatedAt ?? account.createdAt,
        sort: (a, b) => a.createdAt.localeCompare(b.createdAt),
      });
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
    account.updatedAt = account.createdAt;
    await accountsDb.add(account);
    await mirrorPut(db.accounts, account);
    markMirrorStale('accounts');
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
      await mirrorPut(db.transactions, tx);
      markMirrorStale('transactions');
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
    // Optimistic-locked balance update with retry-on-conflict. The server
    // performs `balance + delta` atomically and fails with BALANCE_CONFLICT
    // if our locally-known balance is stale (e.g. another tab moved money).
    // On conflict we refetch the row and retry once with the fresh expected
    // balance. Two consecutive conflicts surface to the caller so the upstream
    // MutationScope can roll back / refetch.
    const account = get().accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Account ${id} not found`);
    const roundedDelta = Math.round(delta * 100) / 100;

    const apply = async (expected: number): Promise<number> =>
      accountsDb.applyBalanceDelta(id, expected, roundedDelta);

    let newBalance: number;
    try {
      newBalance = await apply(account.balance);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') throw err;
      // Refetch the row to learn the true balance, then retry once.
      const fresh = await accountsDb.getAll();
      const updated = fresh.find((a) => a.id === id);
      if (!updated) throw new Error(`Account ${id} not found after refresh`);
      set({ accounts: fresh });
      newBalance = await apply(updated.balance);
    }

    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.id === id ? { ...a, balance: newBalance, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    const updated = get().accounts.find((a) => a.id === id);
    if (updated) await mirrorPut(db.accounts, updated);
    markMirrorStale('accounts');
  },

  updateMetadata: async (id, patch) => {
    const current = get().accounts.find((a) => a.id === id);
    if (!current) throw new Error('Account not found');
    const metadata: Record<string, string> = { ...current.metadata };
    for (const [key, value] of Object.entries(patch)) {
      if (value === '') delete metadata[key];
      else metadata[key] = value;
    }
    await accountsDb.update(id, { metadata });
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.id === id ? { ...a, metadata, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    const updated = get().accounts.find((a) => a.id === id);
    if (updated) await mirrorPut(db.accounts, updated);
    markMirrorStale('accounts');
  },

  renameAccount: async (id, newName) => {
    await accountsDb.update(id, { name: newName });
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.id === id ? { ...a, name: newName, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    const updated = get().accounts.find((a) => a.id === id);
    if (updated) await mirrorPut(db.accounts, updated);
    markMirrorStale('accounts');
  },

  deleteAccount: async (id) => {
    const account = get().accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Account ${id} not found`);
    if (account.balance !== 0) throw new Error('Account must have zero balance to delete');
    // A savings goal may claim its money lives here — deleting the account
    // would silently orphan that link (goals.stored_in_account_id has no FK).
    // Dynamic import: goalStore is otherwise unrelated to this store.
    const { useGoalStore } = await import('./goalStore');
    const goalStore = useGoalStore.getState();
    if (goalStore.goals.length === 0) await goalStore.loadGoals();
    const linkedGoal = useGoalStore.getState().goals.find((g) => g.storedInAccountId === id);
    if (linkedGoal) {
      throw new Error(
        `The savings goal "${linkedGoal.title}" stores its money in this account. Edit that goal (or correct its saved amount) first.`,
      );
    }
    try {
      await accountsDb.delete(id);
    } catch (err) {
      // Postgres FK violation (transactions/recurring still reference this
      // account) surfaces as code 23503. Translate to a user-friendly message.
      const pgErr = err as { code?: string; message?: string };
      if (pgErr?.code === '23503' || /foreign key/i.test(pgErr?.message ?? '')) {
        throw new Error('This account has linked transactions. Delete them first, or archive the account instead.');
      }
      throw err;
    }
    set((s) => ({
      accounts: s.accounts.filter((a) => a.id !== id),
    }));
    await mirrorDelete(db.accounts, id);
    markMirrorStale('accounts');
    await useActivityStore.getState().logActivity(
      'account_deleted',
      `Deleted account "${account.name}"`,
      id,
      'account'
    );
  },
}));
