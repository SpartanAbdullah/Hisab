import { create } from 'zustand';
import { accountsDb, profilesDb } from '../lib/supabaseDb';
import type { Currency } from '../db';
import { useAccountStore } from './accountStore';
import { useTransactionStore } from './transactionStore';
import { useLoanStore } from './loanStore';
import { useGoalStore } from './goalStore';

interface OnboardingState {
  completed: boolean;
  loading: boolean;
  checkOnboarding: () => Promise<void>;
  completeOnboarding: (name: string, currency: Currency) => Promise<void>;
  seedDemoData: (name: string, currency: Currency) => Promise<void>;
  reset: () => void;
}

// Reset uses loading: false (not true) so logout routes instantly to AuthPage
// instead of flashing the global "Loading..." screen. checkOnboarding itself
// flips loading back to true when it runs for a new signed-in user.
const RESET_ONBOARDING_STATE = {
  completed: false,
  loading: false,
};

export const useOnboardingStore = create<OnboardingState>((set) => ({
  completed: false,
  loading: true,

  reset: () => set(RESET_ONBOARDING_STATE),

  checkOnboarding: async () => {
    set({ loading: true });
    // DB is the source of truth. A returning user on a fresh device has no
    // localStorage flag but will have accounts / a flagged profile in Supabase.
    try {
      const [count, profile] = await Promise.all([
        accountsDb.count().catch(() => 0),
        profilesDb.getCurrent().catch(() => null),
      ]);
      const profileDone = profile?.onboarding_completed === true;
      const localDone = localStorage.getItem('hisaab_onboarded') === '1';
      const completed = profileDone || count > 0 || localDone;
      if (completed) localStorage.setItem('hisaab_onboarded', '1');
      set({ completed, loading: false });
    } catch {
      const localDone = localStorage.getItem('hisaab_onboarded') === '1';
      set({ completed: localDone, loading: false });
    }
  },

  completeOnboarding: async (name, currency) => {
    localStorage.setItem('hisaab_user_name', name);
    localStorage.setItem('hisaab_primary_currency', currency);
    localStorage.setItem('hisaab_data_version', '3');

    // Idempotent: only seed the default wallet if the user has zero accounts.
    // Protects against duplicate Cash Wallets if onboarding is re-entered.
    const existingCount = await accountsDb.count().catch(() => 0);
    if (existingCount === 0) {
      await useAccountStore.getState().createAccount({
        name: currency === 'AED' ? 'Cash Wallet' : 'Naqdee',
        type: 'cash',
        currency,
        balance: 0,
      });
    }

    // Persist flag on the profile so it survives cleared localStorage on any device.
    await profilesDb.updateCurrent({
      name,
      primary_currency: currency,
      onboarding_completed: true,
    }).catch(() => {});

    // Set localStorage flag AFTER the account exists so a mid-flow failure
    // doesn't leave the user flagged-onboarded with zero accounts.
    localStorage.setItem('hisaab_onboarded', '1');
    set({ completed: true });
  },

  seedDemoData: async (name, currency) => {
    localStorage.setItem('hisaab_user_name', name);
    localStorage.setItem('hisaab_primary_currency', currency);
    localStorage.setItem('hisaab_data_version', '3');

    const accountStore = useAccountStore.getState();
    const txStore = useTransactionStore.getState();
    const loanStore = useLoanStore.getState();
    const goalStore = useGoalStore.getState();

    // Create demo accounts
    const cashAccount = await accountStore.createAccount({
      name: currency === 'AED' ? 'Cash Wallet' : 'Naqdee',
      type: 'cash',
      currency,
      balance: currency === 'AED' ? 2500 : 85000,
    });

    const bankAccount = await accountStore.createAccount({
      name: currency === 'AED' ? 'Mashreq Salary' : 'HBL Account',
      type: 'bank',
      currency,
      balance: currency === 'AED' ? 12000 : 350000,
      metadata: { bankName: currency === 'AED' ? 'Mashreq' : 'HBL' },
    });

    const walletAccount = await accountStore.createAccount({
      name: 'EasyPaisa',
      type: 'digital_wallet',
      currency: 'PKR',
      balance: 15000,
      metadata: { walletType: 'easypaisa' },
    });

    // Demo transactions
    await txStore.processTransaction({
      type: 'income',
      amount: currency === 'AED' ? 8500 : 250000,
      destinationAccountId: bankAccount.id,
      category: 'Salary',
      notes: 'March salary',
    });

    await txStore.processTransaction({
      type: 'expense',
      amount: currency === 'AED' ? 350 : 12000,
      sourceAccountId: cashAccount.id,
      category: 'Groceries',
      notes: 'Weekly groceries',
    });

    await txStore.processTransaction({
      type: 'expense',
      amount: currency === 'AED' ? 120 : 4500,
      sourceAccountId: cashAccount.id,
      category: 'Transport',
      notes: 'Metro card recharge',
    });

    // Demo loan
    await txStore.processTransaction({
      type: 'loan_given',
      amount: currency === 'AED' ? 500 : 20000,
      sourceAccountId: cashAccount.id,
      personName: 'Ahmed Bhai',
      notes: 'Emergency help',
    });

    // Demo goals
    await goalStore.createGoal({
      title: 'Emergency Fund',
      targetAmount: currency === 'AED' ? 10000 : 300000,
      currency,
      storedInAccountId: bankAccount.id,
    });

    await goalStore.createGoal({
      title: 'New Laptop',
      targetAmount: currency === 'AED' ? 4000 : 150000,
      currency,
      storedInAccountId: bankAccount.id,
    });

    // suppress unused
    void walletAccount;
    void loanStore;

    // Reload all stores
    await accountStore.loadAccounts();
    await txStore.loadTransactions();

    await profilesDb.updateCurrent({
      name,
      primary_currency: currency,
      onboarding_completed: true,
    }).catch(() => {});

    localStorage.setItem('hisaab_onboarded', '1');
    set({ completed: true });
  },
}));
