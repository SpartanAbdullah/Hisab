import { create } from "zustand";
import { accountsDb, profilesDb } from "../lib/supabaseDb";
import type { AppMode, Currency } from "../db";
import { useAccountStore } from "./accountStore";
import { useTransactionStore } from "./transactionStore";
import { useLoanStore } from "./loanStore";
import { useGoalStore } from "./goalStore";
import { useAppModeStore } from "./appModeStore";
import { reportError } from "../lib/errorReporter";
import { getCachedProfile, invalidateProfileCache } from "../lib/profileCache";

interface OnboardingState {
  completed: boolean;
  loading: boolean;
  checkOnboarding: () => Promise<void>;
  completeOnboarding: (
    name: string,
    currency: Currency,
    mode: AppMode,
  ) => Promise<void>;
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
      // Audit 03-performance M2: the profile row is read through the shared
      // boot cache — supabaseAuthStore's deleted-account gate and App.tsx's
      // hydration effect want the same row within the same few hundred ms.
      // `getCachedProfile` never rejects; the catch is kept for shape.
      const userId = localStorage.getItem('hisaab_supabase_uid') ?? '';
      const [count, profile] = await Promise.all([
        accountsDb.count().catch((err) => {
          reportError(err, { feature: 'onboardingStore.checkOnboarding.accountCount' });
          return 0;
        }),
        getCachedProfile(userId).catch((err) => {
          reportError(err, { feature: 'onboardingStore.checkOnboarding.profileRead' });
          return null;
        }),
      ]);
      const profileDone = profile?.onboarding_completed === true;
      if (
        profile?.app_mode === "splits_only" ||
        profile?.app_mode === "full_tracker"
      ) {
        useAppModeStore.getState().setMode(profile.app_mode);
      }
      const localDone = localStorage.getItem("hisaab_onboarded") === "1";
      const completed = profileDone || count > 0 || localDone;
      if (completed) localStorage.setItem("hisaab_onboarded", "1");
      set({ completed, loading: false });
    } catch (err) {
      reportError(err, { feature: 'onboardingStore.checkOnboarding' });
      const localDone = localStorage.getItem("hisaab_onboarded") === "1";
      set({ completed: localDone, loading: false });
    }
  },

  completeOnboarding: async (name, currency, mode) => {
    localStorage.setItem("hisaab_user_name", name);
    localStorage.setItem("hisaab_primary_currency", currency);
    localStorage.setItem("hisaab_app_mode", mode);
    localStorage.setItem("hisaab_data_version", "3");

    // Full Money Tracker needs a starter wallet. Splits Only is deliberately
    // account-free, so it must not create a hidden Cash Wallet.
    const existingCount = await accountsDb.count().catch((err) => {
      reportError(err, { feature: 'onboardingStore.completeOnboarding.accountCount' });
      return 0;
    });
    if (mode === "full_tracker" && existingCount === 0) {
      await useAccountStore.getState().createAccount({
        name: currency === "AED" ? "Cash Wallet" : "Naqdee",
        type: "cash",
        currency,
        balance: 0,
      });
    }

    // Persist flag on the profile so it survives cleared localStorage on any device.
    await profilesDb
      .updateCurrent({
        name,
        primary_currency: currency,
        app_mode: mode,
        onboarding_completed: true,
      })
      .catch((err) => {
        // Swallowed on purpose (localStorage carries this device), but an
        // unpersisted profile means the user re-onboards on their next device.
        reportError(err, { feature: 'onboardingStore.completeOnboarding.profileWrite', extra: { mode } });
      });
    // The boot memo predates this write (name / currency / mode / completed).
    invalidateProfileCache();

    // Set localStorage flag after required mode setup finishes.
    localStorage.setItem("hisaab_onboarded", "1");
    set({ completed: true });
  },

  seedDemoData: async (name, currency) => {
    localStorage.setItem("hisaab_user_name", name);
    localStorage.setItem("hisaab_primary_currency", currency);
    localStorage.setItem("hisaab_data_version", "3");

    const accountStore = useAccountStore.getState();
    const txStore = useTransactionStore.getState();
    const loanStore = useLoanStore.getState();
    const goalStore = useGoalStore.getState();

    // Create demo accounts
    const cashAccount = await accountStore.createAccount({
      name: currency === "AED" ? "Cash Wallet" : "Naqdee",
      type: "cash",
      currency,
      balance: currency === "AED" ? 2500 : 85000,
    });

    const bankAccount = await accountStore.createAccount({
      name: currency === "AED" ? "Mashreq Salary" : "HBL Account",
      type: "bank",
      currency,
      balance: currency === "AED" ? 12000 : 350000,
      metadata: { bankName: currency === "AED" ? "Mashreq" : "HBL" },
    });

    const walletAccount = await accountStore.createAccount({
      name: "EasyPaisa",
      type: "digital_wallet",
      currency: "PKR",
      balance: 15000,
      metadata: { walletType: "easypaisa" },
    });

    // Demo transactions
    await txStore.processTransaction({
      type: "income",
      amount: currency === "AED" ? 8500 : 250000,
      destinationAccountId: bankAccount.id,
      category: "Salary",
      notes: "March salary",
    });

    await txStore.processTransaction({
      type: "expense",
      amount: currency === "AED" ? 350 : 12000,
      sourceAccountId: cashAccount.id,
      category: "Groceries",
      notes: "Weekly groceries",
    });

    await txStore.processTransaction({
      type: "expense",
      amount: currency === "AED" ? 120 : 4500,
      sourceAccountId: cashAccount.id,
      category: "Transport",
      notes: "Metro card recharge",
    });

    // Demo loan
    await txStore.processTransaction({
      type: "loan_given",
      amount: currency === "AED" ? 500 : 20000,
      sourceAccountId: cashAccount.id,
      personName: "Ahmed Bhai",
      notes: "Emergency help",
    });

    // Demo goals
    await goalStore.createGoal({
      title: "Emergency Fund",
      targetAmount: currency === "AED" ? 10000 : 300000,
      currency,
      storedInAccountId: bankAccount.id,
    });

    await goalStore.createGoal({
      title: "New Laptop",
      targetAmount: currency === "AED" ? 4000 : 150000,
      currency,
      storedInAccountId: bankAccount.id,
    });

    // suppress unused
    void walletAccount;
    void loanStore;

    // Reload all stores
    await accountStore.loadAccounts();
    await txStore.loadTransactions();

    await profilesDb
      .updateCurrent({
        name,
        primary_currency: currency,
        onboarding_completed: true,
      })
      .catch((err) => {
        reportError(err, { feature: 'onboardingStore.seedDemoData.profileWrite' });
      });
    invalidateProfileCache();

    localStorage.setItem("hisaab_onboarded", "1");
    set({ completed: true });
  },
}));
