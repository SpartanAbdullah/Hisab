// Centralized logout cleanup. Called from supabaseAuthStore.signOut().
//
// Clears every Zustand store that holds user-owned or session-tied state so
// the next person who signs in on this device cannot see a millisecond of the
// previous user's accounts, loans, groups, activity, etc. Also wipes the
// user-scoped localStorage keys that back those stores.
//
// Not called anywhere else. Do not import this file from stores themselves —
// it imports all of them and would create cycles.

import { useAccountStore } from './accountStore';
import { useTransactionStore } from './transactionStore';
import { useLoanStore } from './loanStore';
import { useEmiStore } from './emiStore';
import { useGoalStore } from './goalStore';
import { useSplitStore } from './splitStore';
import { useActivityStore } from './activityStore';
import { useUpcomingExpenseStore } from './upcomingExpenseStore';
import { useNotificationStore } from './notificationStore';
import { useOnboardingStore } from './onboardingStore';
import { useAppModeStore } from './appModeStore';
import { useAuthStore } from './authStore';
import { useUIStore } from './uiStore';
import { usePersonStore } from './personStore';
import { useLinkedRequestStore } from './linkedRequestStore';
import { useSettlementRequestStore } from './settlementRequestStore';

// hisaab_supabase_uid is NOT listed here — it's owned by supabaseAuthStore's
// onAuthStateChange handler, which clears it when the Supabase session ends.
const USER_SCOPED_LOCALSTORAGE_KEYS = [
  'hisaab_user_name',
  'hisaab_primary_currency',
  'hisaab_onboarded',
  'hisaab_data_version',
  'hisaab_pending_invite',
  'hisaab_app_mode',
  'hisaab_pin_hash',
  'hisaab_identifier',
  'hisaab_backfill_persons_v1',
  'hisaab_backfill_persons_v1:lock',
];

export function resetAllUserStores(): void {
  useAccountStore.getState().reset();
  useTransactionStore.getState().reset();
  useLoanStore.getState().reset();
  useEmiStore.getState().reset();
  useGoalStore.getState().reset();
  useSplitStore.getState().reset();
  useActivityStore.getState().reset();
  useUpcomingExpenseStore.getState().reset();
  useNotificationStore.getState().reset();
  useOnboardingStore.getState().reset();
  useAppModeStore.getState().reset();
  useAuthStore.getState().reset();
  useUIStore.getState().reset();
  usePersonStore.getState().reset();
  useLinkedRequestStore.getState().reset();
  useSettlementRequestStore.getState().reset();

  for (const key of USER_SCOPED_LOCALSTORAGE_KEYS) {
    localStorage.removeItem(key);
  }
}
