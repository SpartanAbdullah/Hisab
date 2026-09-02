import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { ToastContainer } from './components/Toast';
import { ConfirmDestructiveSheet } from './components/ConfirmDestructiveSheet';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useOnboardingStore } from './stores/onboardingStore';
import { useAppModeStore } from './stores/appModeStore';
import { useSupabaseAuthStore } from './stores/supabaseAuthStore';
import { usePersonStore } from './stores/personStore';
import { useLinkedRequestStore } from './stores/linkedRequestStore';
import { useNotificationStore } from './stores/notificationStore';
import { useSplitStore } from './stores/splitStore';
import { useSettlementRequestStore } from './stores/settlementRequestStore';
import { useBudgetStore } from './stores/budgetStore';
import { useCustomCategoryStore } from './stores/customCategoryStore';
import { useCommitteeStore } from './stores/committeeStore';
import { useRecurringStore } from './stores/recurringStore';
import { useAccountStore } from './stores/accountStore';
import { runRecurringExpansion } from './lib/recurringRunner';
import { runPersonBackfillIfNeeded } from './lib/migrations/backfillPersons';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { useContactLinkStore } from './stores/contactLinkStore';
import { startGlobalRealtime, stopGlobalRealtime, resumeGlobalRealtime } from './lib/realtime';
import { startPushRegistration, stopPushRegistration } from './lib/pushRegistration';
import { supabase } from './lib/supabase';
import { initNativeBridge } from './lib/nativeBridge';
import { isNativeRuntime } from './lib/runtime';
import { useAuthStore } from './stores/authStore';
import { PIN_RELOCK_AFTER_MS } from './lib/pinCrypto';
// Statically imported on purpose: a lazy chunk that fails to load (offline, or
// a stale deploy) must never be the reason the PIN gate silently doesn't render.
import { PinLockScreen } from './pages/PinLockScreen';
// Same reasoning as PinLockScreen: the version gate exists precisely for stale
// builds, so its screen must not depend on fetching a chunk from a deploy the
// running bundle may no longer match.
import { UpdateRequiredScreen } from './components/UpdateRequiredScreen';
import { appConfigDb } from './lib/supabaseDb';
import {
  getCurrentAppVersion,
  isSupported,
  resolveVersionIdentity,
  type AppVersionConfig,
  type AppVersionIdentity,
} from './lib/versionGate';
import { useT, useI18nStore } from './lib/i18n';
import { Globe } from 'lucide-react';

// Lazy-loaded pages for code splitting
const AuthPage = lazy(() => import('./pages/AuthPage').then(m => ({ default: m.AuthPage })));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage').then(m => ({ default: m.OnboardingPage })));
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage').then(m => ({ default: m.TransactionsPage })));
const LoansPage = lazy(() => import('./pages/LoansPage').then(m => ({ default: m.LoansPage })));
const LoanDetailPage = lazy(() => import('./pages/LoanDetailPage').then(m => ({ default: m.LoanDetailPage })));
const GoalsPage = lazy(() => import('./pages/GoalsPage').then(m => ({ default: m.GoalsPage })));
const ActivityPage = lazy(() => import('./pages/ActivityPage').then(m => ({ default: m.ActivityPage })));
const AccountDetailPage = lazy(() => import('./pages/AccountDetailPage').then(m => ({ default: m.AccountDetailPage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage').then(m => ({ default: m.AccountsPage })));
const ContactsPage = lazy(() => import('./pages/ContactsPage').then(m => ({ default: m.ContactsPage })));
const SplitsPage = lazy(() => import('./pages/SplitsPage').then(m => ({ default: m.SplitsPage })));
const GroupDetailPage = lazy(() => import('./pages/GroupDetailPage').then(m => ({ default: m.GroupDetailPage })));
const JoinGroupPage = lazy(() => import('./pages/JoinGroupPage').then(m => ({ default: m.JoinGroupPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const InboxPage = lazy(() => import('./pages/InboxPage').then(m => ({ default: m.InboxPage })));
const BudgetsPage = lazy(() => import('./pages/BudgetsPage').then(m => ({ default: m.BudgetsPage })));
const SubscriptionsPage = lazy(() => import('./pages/SubscriptionsPage').then(m => ({ default: m.SubscriptionsPage })));
const KametiPage = lazy(() => import('./pages/KametiPage').then(m => ({ default: m.KametiPage })));
const KametiDetailPage = lazy(() => import('./pages/KametiDetailPage').then(m => ({ default: m.KametiDetailPage })));
const InvestmentsPage = lazy(() => import('./pages/InvestmentsPage').then(m => ({ default: m.InvestmentsPage })));
const HoldingDetailPage = lazy(() => import('./pages/HoldingDetailPage').then(m => ({ default: m.HoldingDetailPage })));
const KametiWitnessPage = lazy(() => import('./pages/KametiWitnessPage').then(m => ({ default: m.KametiWitnessPage })));
const HisaabAIPage = lazy(() => import('./pages/HisaabAIPage').then(m => ({ default: m.HisaabAIPage })));
const InsightDetailPage = lazy(() => import('./pages/InsightDetailPage').then(m => ({ default: m.InsightDetailPage })));
const PublicInfoPage = lazy(() => import('./pages/PublicInfoPages').then(m => ({ default: m.PublicInfoPage })));
const ConnectByCodePage = lazy(() => import('./pages/ConnectByCodePage').then(m => ({ default: m.ConnectByCodePage })));

// Quick Entry is the only modal launched globally (from the BottomNav FAB).
// The Add Goal / Add Loan / Add Upcoming Expense modals are owned by their
// respective pages and triggered by inline "+" buttons there.
//
// AddGroupExpenseModal + CreateGroupModal ALSO live here at app level —
// the FAB-driven "Group expense" path in QuickEntry hands off to them so
// the user can pick (or create) a group without losing the amount they
// already typed. GroupDetailPage still uses its own local instance of
// AddGroupExpenseModal for the inline "+ Add expense" button.
import { QuickEntry } from './pages/QuickEntry';
import { AddGroupExpenseModal } from './pages/AddGroupExpenseModal';
import { CreateGroupModal } from './pages/CreateGroupModal';
import { RecurringDuePrompt } from './components/RecurringDuePrompt';
import { MonthlyWrapModal } from './components/MonthlyWrapModal';
import { DailyQuote } from './components/DailyQuote';
import { OfflineBanner } from './components/OfflineBanner';
import { AppLoadingScreen } from './components/AppLoadingScreen';
import { GlobalChunkRecoveryOverlay } from './components/GlobalChunkRecoveryOverlay';
import { startOutboxRunner, stopOutboxRunner } from './lib/outboxRunner';
import { getPendingInviteResumePath, savePendingInvite } from './lib/pendingInvite';
import type { SplitGroup } from './db';

function PageLoader() {
  return <AppLoadingScreen />;
}

function UnverifiedEmailScreen({ email }: { email: string }) {
  const { signOut } = useSupabaseAuthStore();
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  const resend = async () => {
    if (!email) return;
    setResending(true);
    setResendMessage('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      setResendMessage(error ? error.message : t('verify_resent'));
    } finally {
      setResending(false);
    }
  };

  // Signup with email confirmation leaves no session, so the only way forward
  // is the login form. Flag it so AuthPage greets them with a success banner
  // instead of a bare form, then drop to login via signOut (which clears the
  // transient unconfirmed user). Previously this reloaded and dumped the user
  // on a plain Login screen with no explanation.
  const goLogin = () => {
    sessionStorage.setItem('hisaab_just_verified', '1');
    void signOut();
  };

  return (
    <div className="min-h-dvh relative flex flex-col items-center justify-center bg-navy-bloom text-white px-8 text-center">
      <button
        onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
        className="absolute top-5 right-5 z-50 bg-white/10 text-white/80 rounded-xl px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all backdrop-blur-sm border border-white/10"
      >
        <Globe size={11} /> {lang === 'ur' ? 'EN' : 'UR'}
      </button>
      <div className="w-20 h-20 rounded-3xl bg-receive-600/25 flex items-center justify-center mb-6 backdrop-blur-sm border border-receive-600/30">
        <span className="text-3xl">📩</span>
      </div>
      <h1 className="text-2xl font-bold tracking-tight mb-3">{t('verify_title')}</h1>
      <p className="text-white/60 text-[13px] max-w-[300px] leading-relaxed">{t('verify_body')}</p>
      <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{email || '—'}</p>
      <p className="text-white/45 text-[12px] max-w-[290px] leading-relaxed mt-4">{t('verify_instruction')}</p>
      <p className="text-white/35 text-[11px] max-w-[290px] leading-relaxed mt-2">{t('verify_spam')}</p>

      <div className="w-full max-w-[300px] mt-8 space-y-3">
        <button
          onClick={goLogin}
          className="w-full bg-white text-navy-900 rounded-2xl py-4 text-[14px] font-semibold active:scale-[0.98] transition-all shadow-lg shadow-white/10"
        >
          {t('verify_done_login')}
        </button>
        <button
          onClick={resend}
          disabled={resending || !email}
          className="w-full bg-white/10 border border-white/15 text-white rounded-2xl py-3.5 text-[13px] font-semibold active:scale-[0.98] transition-all disabled:opacity-50 backdrop-blur-sm"
        >
          {resending ? t('verify_resending') : t('verify_resend')}
        </button>
      </div>

      {resendMessage && (
        <p className="text-receive-50 text-[12px] mt-4 max-w-[290px] leading-relaxed">{resendMessage}</p>
      )}

      <button onClick={() => signOut()} className="text-white/45 text-[11px] underline mt-6 min-h-[44px]">
        {t('verify_diff_account')}
      </button>
    </div>
  );
}

// ── Minimum-supported-version gate (audit H9 / MF-12) ───────────────────────
// Hisaab's three release tracks (Vercel-on-push web, hand-built Play AAB,
// hand-applied SQL) are unsynchronised by construction, so an installed binary
// can be weeks behind the schema it is calling. This hook fetches the
// `app_config` singleton once at boot and hands AppContent a hard block when
// this build is below the floor. See src/lib/versionGate.ts for the release
// policy and supabase-migration-p1-app-config.sql for the row.
//
// FAILS OPEN, always: no config row, an unapplied migration, a thrown fetch, a
// dead network — every one of those resolves to "allowed". Locking a working
// client out because a request timed out on 3G would be a far worse bug than
// the skew this defends against, and is only undoable from Supabase Studio.
//
// Mode-agnostic: nothing here reads appModeStore.
const VERSION_RECHECK_MS = 10 * 60 * 1000;

function useVersionGate(): {
  blocked: boolean;
  config: AppVersionConfig | null;
  version: string;
} {
  const [config, setConfig] = useState<AppVersionConfig | null>(null);
  const [identity, setIdentity] = useState<AppVersionIdentity | null>(null);
  const lastCheckedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      // Throttle: boot always checks (lastCheckedAt = 0); resumes re-check at
      // most every 10 minutes, so an operator lowering a mistaken floor is
      // picked up without a reinstall, and a raised floor reaches a
      // long-running session without a cold start.
      const now = Date.now();
      if (now - lastCheckedAt.current < VERSION_RECHECK_MS) return;
      lastCheckedAt.current = now;
      try {
        const [resolved, row] = await Promise.all([
          resolveVersionIdentity(),
          appConfigDb.get(),
        ]);
        if (cancelled) return;
        setIdentity(resolved);
        setConfig(row);
      } catch (err) {
        // Deliberately does NOT clear a previously fetched config: a failed
        // re-check must not un-block a client we already know is too old.
        // Allow a retry sooner than the full interval.
        lastCheckedAt.current = 0;
        console.error('appConfig check failed (non-fatal, failing open)', err);
      }
    };

    void check();

    // Resume re-check. Covers web/PWA tab returns and — because the Capacitor
    // WebView fires visibilitychange on foreground too — the native app.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);

  return {
    // `identity === null` means we have not completed a check yet → allowed.
    blocked: identity !== null && !isSupported(identity, config),
    config,
    version: identity?.current ?? getCurrentAppVersion(),
  };
}

function AppContent() {
  const { completed, loading: onboardingLoading, checkOnboarding } = useOnboardingStore();
  const mode = useAppModeStore(s => s.mode);
  const setMode = useAppModeStore(s => s.setMode);
  const { user, loading: authLoading, initialize } = useSupabaseAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showQuickEntry, setShowQuickEntry] = useState(false);
  // QuickEntry → Group expense bridge: when the user picks a group inside
  // QuickEntry, we close it and open AddGroupExpenseModal with the
  // already-typed amount. When they pick "Create new group" instead,
  // we open CreateGroupModal first and chain into AddGroupExpenseModal
  // once the new group is created.
  const [groupExpenseTarget, setGroupExpenseTarget] =
    useState<{ group: SplitGroup; amount: string } | null>(null);
  const [createGroupForExpense, setCreateGroupForExpense] =
    useState<{ amount: string } | null>(null);

  // Version compatibility. Runs unconditionally (hook rules); the block it
  // produces is rendered down with the other gates. Fails open — see
  // useVersionGate above.
  const versionGate = useVersionGate();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Onboarding is gated on a known user — the DB check requires the uid
  // written by `initialize()`. Running it on mount caused a race where the
  // check would fall back to an unset localStorage flag and briefly show
  // OnboardingPage to a returning user.
  useEffect(() => {
    if (!authLoading) checkOnboarding();
  }, [authLoading, user?.id, checkOnboarding]);

  useEffect(() => {
    if (!user && location.pathname.startsWith('/join/')) {
      savePendingInvite(location.pathname.replace('/join/', ''));
    }
  }, [location.pathname, user]);

  // Capacitor native bridge — initialised once after the router is available.
  // No-op on web. Wires status bar, splash, hardware back button, deep links.
  useEffect(() => {
    void initNativeBridge({
      navigate: (to, opts) => navigate(to, opts),
      // We never want to "exit" while a modal/sheet is open — but Capacitor's
      // back-button only fires when the system gesture wasn't handled, and
      // modals are click-outside-to-close already.
      //
      // Audit MF-07: `history.length` counts every session entry and never
      // decreases on back-navigation, so after the first in-app navigation
      // it's permanently > 1 — back on the home screen called
      // `window.history.back()` (a no-op at the start of history) instead of
      // `CapApp.exitApp()`, which read as a hang. React Router 7 stamps
      // `{ idx }` into `history.state` for every entry it creates (0 at the
      // initial entry), so `idx > 0` is the correct "is there somewhere to
      // go back to" check.
      canGoBack: () => ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0,
    });
  }, [navigate]);

  // Realtime: subscribe when we know who the user is, tear down on signout.
  // Fires loadGroups / loadNotifications on relevant row changes so the user
  // doesn't need to refresh to see a new group they were added to or new
  // in-app notifications.
  useEffect(() => {
    if (!user?.id) {
      stopGlobalRealtime();
      return;
    }
    startGlobalRealtime(user.id);
    return () => stopGlobalRealtime();
  }, [user?.id]);

  // Resume: a backgrounded tab/app loses its realtime socket without any
  // error surfacing, so coming back has to re-establish it AND refetch —
  // a missed event leaves nothing behind to detect. Capacitor's own
  // appStateChange hook does the same on native (see nativeBridge.ts);
  // these listeners cover web, PWA, and the WebView's own visibility
  // transitions.
  useEffect(() => {
    if (!user?.id) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') resumeGlobalRealtime();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', resumeGlobalRealtime);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', resumeGlobalRealtime);
      window.removeEventListener('focus', onVisible);
    };
  }, [user?.id]);

  // ── Device PIN gate (audit H7 / QA F-1) ────────────────────────────────
  // PinLockScreen used to have zero importers: Settings could set a PIN and the
  // Play listing sold it, but the app opened straight to Home. The gate now
  // covers (a) cold start — authStore boots isLocked=true whenever a PIN record
  // exists — and (b) resume, once the app has been backgrounded for at least
  // PIN_RELOCK_AFTER_MS. It renders BELOW the auth / email-verification /
  // onboarding gates and below the public routes, so none of those are covered.
  // App-mode independent: full_tracker and splits_only share this shell.
  const hasPin = useAuthStore((s) => s.hasPin);
  const isPinLocked = useAuthStore((s) => s.isLocked);
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    const onHidden = () => {
      // First hidden event wins: don't restart the clock on a repeat.
      if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
    };
    const onShown = () => {
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since !== null && Date.now() - since >= PIN_RELOCK_AFTER_MS) {
        // lock() re-derives hasPin from storage, so this is a no-op when the
        // user has no PIN set.
        useAuthStore.getState().lock();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onHidden();
      else onShown();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Safari/iOS PWA can fire pagehide without a visibilitychange.
    window.addEventListener('pagehide', onHidden);

    // Native: the WebView is suspended wholesale, and Capacitor's lifecycle
    // event is the dependable signal there (see lib/nativeBridge.ts for the
    // same dynamic-import pattern). Its own appStateChange listener stays as
    // it is — Capacitor allows multiple listeners per event.
    let cancelled = false;
    let removeNative: (() => void) | undefined;
    if (isNativeRuntime()) {
      void import('@capacitor/app')
        .then(({ App: CapApp }) =>
          CapApp.addListener('appStateChange', ({ isActive }) => {
            if (isActive) onShown();
            else onHidden();
          }),
        )
        .then((handle) => {
          if (cancelled) void handle.remove();
          else removeNative = () => { void handle.remove(); };
        })
        .catch(() => {
          // Plugin unavailable — visibilitychange still covers most resumes.
        });
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onHidden);
      removeNative?.();
    };
  }, [user?.id]);

  // FCM registration. No-op on web and on a native build without Firebase
  // config — see docs/push-notifications-setup.md.
  useEffect(() => {
    if (!user?.id) {
      void stopPushRegistration();
      return;
    }
    void startPushRegistration((to) => navigate(to));
  }, [user?.id, navigate]);

  // Phase 3 offline scaffold: start the outbox runner once the user is
  // signed in. The runner is currently inert (dispatch handlers throw —
  // see src/lib/outboxRunner.ts) but the loop, backoff, and lifecycle
  // are all live so per-store rewires only need to fill in handlers.
  useEffect(() => {
    if (!user?.id) {
      stopOutboxRunner();
      return;
    }
    startOutboxRunner();
    return () => stopOutboxRunner();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    void usePersonStore.getState().loadPersons().catch((err) => {
      console.error('loadPersons failed (non-fatal)', err);
    });
    void useLinkedRequestStore.getState().loadRequests().catch((err) => {
      console.error('loadRequests failed (non-fatal)', err);
    });
    void useSettlementRequestStore.getState().loadRequests().catch((err) => {
      console.error('loadSettlements failed (non-fatal)', err);
    });
    // Connection asks ("X added you — add them back?"). Boot-loaded so the
    // bell badge counts them before the user opens the Inbox.
    void useContactLinkStore.getState().loadRequests().catch((err) => {
      console.error('loadContactLinks failed (non-fatal)', err);
    });
    // Boot-load notifications so the bell badge + Inbox "Info" tab reflect
    // unread informational pings (e.g. "someone added you via your code")
    // before the user ever opens the inbox. Realtime keeps it fresh after.
    void useNotificationStore.getState().loadNotifications().catch((err) => {
      console.error('loadNotifications failed (non-fatal)', err);
    });
    // Accounts feed the globally-mounted QuickEntry (and its "you need an
    // account first" gate). They used to load only when a page that needed
    // them mounted — on an unmatched URL the FAB opened over an empty store
    // and told a 13-account user to create their first account.
    void useAccountStore.getState().loadAccounts().catch((err) => {
      console.error('loadAccounts failed (non-fatal)', err);
    });
    // Preload groups on app boot so the QuickEntry "Group expense" picker
    // is ready the moment the user opens it from any page. Previously
    // groups only loaded on /groups visit, which made the picker show
    // "no groups yet" for users who'd never opened the Groups tab.
    void useSplitStore.getState().loadGroups().catch((err) => {
      console.error('loadGroups failed (non-fatal)', err);
    });
    // Phase 3: load budgets and recurring templates.
    // Budgets feed the home banner; recurring needs to be loaded BEFORE
    // the expansion runner can decide which entries are due.
    void useBudgetStore.getState().loadBudgets().catch((err) => {
      console.error('loadBudgets failed (non-fatal)', err);
    });
    // Custom categories feed every category picker; load early so the merged
    // (built-in + custom) lists are ready before the user opens an entry form.
    void useCustomCategoryStore.getState().loadCategories().catch((err) => {
      console.error('loadCategories failed (non-fatal)', err);
    });
    void useCommitteeStore.getState().loadAll().catch((err) => {
      console.error('loadCommittees failed (non-fatal)', err);
    });
    void useRecurringStore.getState().loadTemplates().then(() => {
      // Defer expansion to next tick so the first paint isn't blocked by
      // potentially many confirmation prompts. The runner only prompts;
      // the user still confirms each expansion.
      void runRecurringExpansion().catch((err) => {
        console.error('runRecurringExpansion failed (non-fatal)', err);
      });
      // Native only (no-op on web): rebuild the local reminder schedule
      // from the freshly loaded state.
      void import('./lib/notificationScheduler')
        .then((m) => m.rescheduleNotifications())
        .catch(() => {});
    }).catch((err) => {
      console.error('loadRecurring failed (non-fatal)', err);
    });
  }, [user?.id]);

  // Phase 1B-A: historical backfill of person_id on legacy loans/transactions.
  // Deferred ~800ms so other boot work (profile fetch, realtime subscribe,
  // first page render) finishes first. The job itself short-circuits via a
  // localStorage flag after success, so steady-state boots pay almost nothing.
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    const timer = setTimeout(() => {
      void runPersonBackfillIfNeeded(uid);
    }, 800);
    return () => clearTimeout(timer);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    void useSupabaseAuthStore.getState().getProfile().then((profile) => {
      if (cancelled || !profile) return;
      const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : localStorage.getItem('hisaab_user_name');
      const currency = typeof profile.primary_currency === 'string' ? profile.primary_currency : localStorage.getItem('hisaab_primary_currency');
      const profileMode = profile.app_mode === 'splits_only' || profile.app_mode === 'full_tracker' ? profile.app_mode : null;
      if (name) localStorage.setItem('hisaab_user_name', name);
      if (currency) localStorage.setItem('hisaab_primary_currency', currency);
      if (profileMode) setMode(profileMode);
    });
    return () => {
      cancelled = true;
    };
  }, [setMode, user?.id]);

  useEffect(() => {
    if (!user || !completed) return;
    const resumePath = getPendingInviteResumePath({
      completed,
      currentPath: location.pathname,
      hasUser: Boolean(user),
    });
    if (resumePath) navigate(resumePath, { replace: true });
  }, [completed, location.pathname, navigate, user]);

  // Scroll restoration (audit MF-18). The browser's own automatic
  // restoration races the logic below and can flash the wrong position
  // before we correct it, so take manual control once up front.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Continuously record the current entry's scroll offset, keyed by
  // `location.key` (a unique id React Router assigns per history entry), so
  // a POP navigation back to it can restore where the user left off. Before
  // this, EVERY route change — including back — reset to the top, which
  // turned the core review loop (open TransactionsPage/LoansPage/
  // GroupDetailPage, open a detail route, come back) into O(n^2) scrolling.
  const scrollPositions = useRef(new Map<string, number>()).current;
  useEffect(() => {
    const key = location.key;
    const onScroll = () => {
      scrollPositions.set(key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [location.key, scrollPositions]);

  // POP (back/forward, including the hardware-back path above and
  // GlobalSearch/QuickEntry navigations) restores the recorded offset for
  // that entry; PUSH/REPLACE (opening a new screen) scrolls to top like any
  // freshly-opened page. Always instant (no `behavior: 'smooth'`) — this is
  // scroll RESTORATION, not a scroll animation, so there is no smooth-scroll
  // code path to gate behind `prefers-reduced-motion` in the first place.
  const navigationType = useNavigationType();
  useEffect(() => {
    const target = navigationType === 'POP' ? (scrollPositions.get(location.key) ?? 0) : 0;
    window.scrollTo(0, target);
  }, [location.pathname, location.key, navigationType, scrollPositions]);

  // On logout, reset the URL to Home so the next login lands on Home — not the
  // page the user was on when they signed out (e.g. Settings).
  const wasAuthed = useRef(false);
  useEffect(() => {
    if (wasAuthed.current && !user) navigate('/', { replace: true });
    wasAuthed.current = !!user;
  }, [user, navigate]);

  // Public witness route — a read-only committee record reachable WITHOUT an
  // account (for non-app members/relatives). Checked before every other gate
  // so the share link opens directly in any browser.
  if (location.pathname.startsWith('/kameti/witness/')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <KametiWitnessPage />
      </Suspense>
    );
  }

  // Dev-only: ?loading-preview pins the loading screen so it can be styled
  // and reviewed (it normally flashes by too fast). Dead code in prod builds.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('loading-preview')) {
    return <AppLoadingScreen />;
  }

  if (authLoading || onboardingLoading) {
    return <AppLoadingScreen />;
  }

  // ── Gate block ────────────────────────────────────────────────────────────
  // Version → auth → email verification → onboarding → PIN. Every one of these
  // renders BELOW the public routes: /privacy, /terms, /contact, /support and
  // /delete-account never reach AppContent (PublicRouteSwitch returns first),
  // and /kameti/witness/* returns above this block — so a shared witness link
  // still opens in any browser even while the app is version-blocked.

  // Version gate (audit H9 / MF-12). FIRST, and deliberately above the auth
  // gate: a binary too old to talk to the current schema must be stopped before
  // it signs in and starts issuing writes against contracts that moved. Fails
  // open on any fetch error, so this can only block when the server actively
  // said so. Mode-agnostic — full_tracker and splits_only are blocked alike.
  if (versionGate.blocked) {
    return <UpdateRequiredScreen config={versionGate.config} version={versionGate.version} />;
  }

  // Auth gate — must be logged in
  if (!user) {
    return (
      <Suspense fallback={<PageLoader />}>
        <AuthPage />
      </Suspense>
    );
  }

  // Email-verification gate. Supabase returns a session for unconfirmed users
  // when "Confirm email" is disabled in the dashboard; even when enabled, a
  // user who reuses a token can land here without a real verified email. We
  // hard-block app access until `email_confirmed_at` is set. The user can
  // resend the verification email or sign out.
  if (!user.email_confirmed_at) {
    return (
      <Suspense fallback={<PageLoader />}>
        <UnverifiedEmailScreen email={user.email ?? ''} />
      </Suspense>
    );
  }

  // Onboarding gate
  if (!completed) {
    return (
      <Suspense fallback={<PageLoader />}>
        <OnboardingPage />
      </Suspense>
    );
  }

  // Device PIN gate. Last gate before the app shell: signed in, verified,
  // onboarded — and now the phone's owner has to prove it's them. "Forgot PIN"
  // inside the screen signs out, which is also what clears the PIN.
  if (hasPin && isPinLocked) {
    return <PinLockScreen />;
  }

  return (
    <div className="min-h-dvh bg-cream-soft">
      <PWAInstallPrompt />
      {/* Connectivity pill — surfaces when navigator.onLine flips. */}
      <OfflineBanner />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/groups" element={<SplitsPage />} />
          <Route path="/group/:id" element={<GroupDetailPage />} />
          <Route path="/join/:token" element={<JoinGroupPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          {/* Scanned-QR landing (https://usehisaab.com/u/HSB-XXXXXX). Also
              reachable from the phone's own camera app via App Links. */}
          <Route path="/u/:code" element={<ConnectByCodePage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/accounts" element={mode === 'full_tracker' ? <AccountsPage /> : <Navigate to="/" replace />} />
          <Route path="/account/:id" element={mode === 'full_tracker' ? <AccountDetailPage /> : <Navigate to="/" replace />} />
          <Route path="/transactions" element={mode === 'full_tracker' ? <TransactionsPage /> : <Navigate to="/" replace />} />
          <Route path="/loans" element={<LoansPage />} />
          <Route path="/loan/:id" element={<LoanDetailPage />} />
          {/* Phase 3 features. Budgets + Recurring stay full_tracker-only
              because they presuppose accounts. */}
          <Route path="/budgets" element={mode === 'full_tracker' ? <BudgetsPage /> : <Navigate to="/" replace />} />
          {/* Recurring + Subscriptions consolidated into the one Subscription
              Tracker. Old /recurring links redirect there. */}
          <Route path="/subscriptions" element={mode === 'full_tracker' ? <SubscriptionsPage /> : <Navigate to="/" replace />} />
          <Route path="/investments" element={mode === 'full_tracker' ? <InvestmentsPage /> : <Navigate to="/" replace />} />
          <Route path="/investment/:marketId/:symbol" element={mode === 'full_tracker' ? <HoldingDetailPage /> : <Navigate to="/" replace />} />
          <Route path="/recurring" element={<Navigate to="/subscriptions" replace />} />
          {/* Kameti / committee — a no-custody tracker; needs no accounts, so
              available in both modes. */}
          <Route path="/kameti" element={<KametiPage />} />
          <Route path="/kameti/:id" element={<KametiDetailPage />} />
          <Route path="/hisaab-ai" element={<HisaabAIPage />} />
          <Route path="/hisaab-ai/insight/:category" element={mode === 'full_tracker' ? <InsightDetailPage /> : <Navigate to="/hisaab-ai" replace />} />
          {/* Remittances feature retired (confused users into thinking Hisaab
              is a remittance app). Data layer kept dormant; old links redirect. */}
          <Route path="/remittances" element={<Navigate to="/" replace />} />

          {/* Savings goals stay full-tracker only. Transactions and loans are
              available in both modes so simple users can still record expense
              notes and manage payables/receivables. */}
          {mode === 'full_tracker' ? (
            <>
              <Route path="/goals" element={<GoalsPage />} />
            </>
          ) : (
            <>
              <Route path="/goals" element={<Navigate to="/" replace />} />
            </>
          )}

          {/* Catch-all: an unmatched URL used to render an empty page with a
              live BottomNav + FAB floating over nothing. Send it home. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <BottomNav onQuickEntry={() => setShowQuickEntry(true)} />
      <QuickEntry
        open={showQuickEntry}
        onClose={() => setShowQuickEntry(false)}
        onPickGroupExpense={(group, amount) => {
          setShowQuickEntry(false);
          setGroupExpenseTarget({ group, amount });
        }}
        onCreateGroupForExpense={(amount) => {
          setShowQuickEntry(false);
          setCreateGroupForExpense({ amount });
        }}
      />
      {/* Phase 3: recurring entries due today appear as a single-prompt
          queue. Mounted at app level so the prompt persists across navigation. */}
      <RecurringDuePrompt />
      {/* Phase 3: end-of-month "Hisaab Wrap" — Spotify Wrapped for the
          user's money. Self-triggers on the first session of a new month. */}
      <MonthlyWrapModal />
      {/* Once-a-day money-wisdom popup. Self-triggers on the first app open of
          each day; can be turned off in Settings. */}
      <DailyQuote />
      {/* Create-then-expense chain: when CreateGroupModal returns the new
          group, we immediately open AddGroupExpenseModal with the amount
          the user originally typed in QuickEntry. */}
      <CreateGroupModal
        open={!!createGroupForExpense}
        onClose={() => setCreateGroupForExpense(null)}
        onCreated={(group) => {
          const amount = createGroupForExpense?.amount ?? '';
          setCreateGroupForExpense(null);
          setGroupExpenseTarget({ group, amount });
        }}
      />
      {/* AddGroupExpenseModal for the QuickEntry path. GroupDetailPage
          still mounts its own local instance for the inline button —
          they don't conflict because both paths set/clear independent
          state slots and the user can't be on both screens at once. */}
      {groupExpenseTarget && (
        <AddGroupExpenseModal
          open
          group={groupExpenseTarget.group}
          prefillAmount={groupExpenseTarget.amount}
          onClose={() => setGroupExpenseTarget(null)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ToastContainer />
      <ConfirmDestructiveSheet />
      <GlobalChunkRecoveryOverlay />
      <ErrorBoundary>
        <PublicRouteSwitch />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

function PublicRouteSwitch() {
  const location = useLocation();

  if (location.pathname === '/privacy') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="privacy" /></Suspense>;
  }
  if (location.pathname === '/terms') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="terms" /></Suspense>;
  }
  if (location.pathname === '/contact' || location.pathname === '/support') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="contact" /></Suspense>;
  }
  if (location.pathname === '/delete-account') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="delete-account" /></Suspense>;
  }

  return <AppContent />;
}

export default App;
