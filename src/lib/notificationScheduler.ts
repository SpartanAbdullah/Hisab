// Capacitor bridge for the reminder engine. The contract that keeps stale
// reminders impossible: every run CANCELS the whole pending schedule first,
// then re-derives it from live store state via the pure planner — so a bill
// paid five minutes ago can never ring, by construction. No-op on web.
import { isNativeRuntime } from './runtime';
import { planNotifications } from './notificationPlanner';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useCommitteeStore } from '../stores/committeeStore';
import { useTransactionStore } from '../stores/transactionStore';

export const REMINDERS_KEY = 'hisaab_payment_reminders_enabled';

// OPT-IN, not opt-out: notifications fire only after the user explicitly
// enables them in Settings (which also runs the Android 13 permission
// prompt). A default-on toggle with no granted permission would show ON
// while nothing ever fires — a lying switch.
export function remindersEnabled(): boolean {
  try {
    return localStorage.getItem(REMINDERS_KEY) === 'true';
  } catch {
    return false;
  }
}

// Loads any cold slices the planner needs. Cheap when warm (each store
// no-ops into its cache-first path); failures are non-fatal — the planner
// simply sees fewer sources this round.
async function ensureLoaded(): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (useAccountStore.getState().accounts.length === 0) jobs.push(useAccountStore.getState().loadAccounts());
  if (useLoanStore.getState().loans.length === 0) jobs.push(useLoanStore.getState().loadLoans());
  if (useEmiStore.getState().schedules.length === 0) jobs.push(useEmiStore.getState().loadSchedules());
  if (useRecurringStore.getState().templates.length === 0) jobs.push(useRecurringStore.getState().loadTemplates());
  if (useUpcomingExpenseStore.getState().expenses.length === 0) jobs.push(useUpcomingExpenseStore.getState().loadExpenses());
  if (useCommitteeStore.getState().committees.length === 0) jobs.push(useCommitteeStore.getState().loadAll());
  if (useTransactionStore.getState().transactions.length === 0) jobs.push(useTransactionStore.getState().loadTransactions());
  await Promise.all(jobs.map((j) => j.catch(() => {})));
}

// Drops every pending local notification. Shared by the reschedule path
// (which must start from a clean slate) and by the sign-out path.
async function cancelPending(): Promise<void> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: pending.notifications.map((n) => ({ id: n.id })),
    });
  }
}

async function runReschedule(): Promise<void> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    // Always clear first — stale reminders must die even when the feature
    // was just disabled or permission was revoked.
    await cancelPending();

    if (!remindersEnabled()) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return;

    await ensureLoaded();

    // Cash-advance loans keyed to their funding card (loan_taken origin) —
    // same derivation as HomePage/InboxPage.
    const cardFundedLoanIds = new Map<string, string>();
    for (const txn of useTransactionStore.getState().transactions) {
      if (txn.type === 'loan_taken' && txn.relatedLoanId && txn.sourceAccountId) {
        cardFundedLoanIds.set(txn.relatedLoanId, txn.sourceAccountId);
      }
    }

    const plan = planNotifications({
      accounts: useAccountStore.getState().accounts,
      loans: useLoanStore.getState().loans,
      schedules: useEmiStore.getState().schedules,
      templates: useRecurringStore.getState().templates,
      upcoming: useUpcomingExpenseStore.getState().expenses,
      committees: useCommitteeStore.getState().committees,
      committeePayments: useCommitteeStore.getState().payments,
      cardFundedLoanIds,
      now: new Date(),
    });
    if (plan.length === 0) return;

    await LocalNotifications.schedule({
      notifications: plan.map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        schedule: { at: new Date(p.atMs) },
        extra: { href: p.href },
        smallIcon: 'ic_stat_hisaab',
      })),
    });
  } catch (err) {
    console.error('[notifications] reschedule failed (non-fatal)', err);
  }
}

let lastRun = 0;
// Serialize runs: cancel→derive→schedule spans several bridge round-trips,
// and overlapping forced runs (e.g. the consolidated-repayment loop firing
// one per posted transaction) could interleave so a stale plan wins. Chain
// with latest-wins coalescing: at most one QUEUED run at a time — it will
// derive from final store state, which is all that matters.
let chain: Promise<void> = Promise.resolve();
let queued = false;

/** Cancel-and-rebuild the local notification schedule from live state.
 *  Debounced (30s) for burst callers (boot/resume); pass force whenever the
 *  user just resolved something — a debounced skip could let a 10:00
 *  reminder ring for a bill settled at 09:55. */
export function rescheduleNotifications(opts?: { force?: boolean }): Promise<void> {
  if (!isNativeRuntime()) return Promise.resolve();
  const now = Date.now();
  if (!opts?.force && now - lastRun < 30_000) return chain;
  lastRun = now;
  if (queued) return chain; // a queued run will already see the final state
  queued = true;
  chain = chain
    .then(() => {
      queued = false;
      return runReschedule();
    })
    .catch(() => {
      queued = false;
    });
  return chain;
}

/** Sign-out teardown: drop every pending reminder for the account that is
 *  leaving this device.
 *
 *  Audit 2026-09 L5: reminders are scheduled with the OS, not with us — they
 *  survive sign-out, app kill and reboot, and their bodies name real people
 *  and real amounts ("Ali ko 500 AED dena hai"). On a shared/handed-over
 *  phone that is the previous user's ledger leaking into the next holder's
 *  notification tray, indefinitely.
 *
 *  Goes through the same serialization chain as rescheduleNotifications() so
 *  an in-flight or queued reschedule cannot re-populate the schedule in the
 *  window between our getPending() and our cancel(). `lastRun` is stamped so
 *  the debounce also swallows any non-forced run for the next 30s; after
 *  that, remindersEnabled() is false (sign-out clears the opt-in key) and
 *  runReschedule() cancels-and-returns anyway.
 *
 *  No-op on web. Never throws — it runs on the path that declares the user
 *  signed out. */
export function cancelAllScheduledNotifications(): Promise<void> {
  if (!isNativeRuntime()) return Promise.resolve();
  lastRun = Date.now();
  chain = chain
    .then(() => cancelPending())
    .catch((err) => {
      console.error('[notifications] sign-out cancel failed (non-fatal)', err);
    });
  return chain;
}

/** Settings-toggle flow: request permission (Android 13+ runtime prompt),
 *  persist the opt-in, then schedule immediately so the user sees the
 *  effect. OWNS the REMINDERS_KEY write — the flag must be true BEFORE the
 *  internal reschedule runs, or that run cancels everything and schedules
 *  nothing (a lying green toggle). Returns whether reminders ended up on. */
export async function enableRemindersFlow(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') {
      try { localStorage.setItem(REMINDERS_KEY, 'false'); } catch { /* storage off */ }
      return false;
    }
    try { localStorage.setItem(REMINDERS_KEY, 'true'); } catch { /* storage off */ }
    await rescheduleNotifications({ force: true });
    return true;
  } catch (err) {
    console.error('[notifications] enable flow failed', err);
    return false;
  }
}
