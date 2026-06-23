import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
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
import { runRecurringExpansion } from './lib/recurringRunner';
import { runPersonBackfillIfNeeded } from './lib/migrations/backfillPersons';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { startGlobalRealtime, stopGlobalRealtime } from './lib/realtime';
import { supabase } from './lib/supabase';
import { initNativeBridge } from './lib/nativeBridge';

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
const KametiWitnessPage = lazy(() => import('./pages/KametiWitnessPage').then(m => ({ default: m.KametiWitnessPage })));
const HisaabAIPage = lazy(() => import('./pages/HisaabAIPage').then(m => ({ default: m.HisaabAIPage })));
const InsightDetailPage = lazy(() => import('./pages/InsightDetailPage').then(m => ({ default: m.InsightDetailPage })));
const PublicInfoPage = lazy(() => import('./pages/PublicInfoPages').then(m => ({ default: m.PublicInfoPage })));

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
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  const resend = async () => {
    if (!email) return;
    setResending(true);
    setResendMessage('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      setResendMessage(error ? error.message : 'Verification email sent. Check your inbox.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-navy-bloom text-white px-8 text-center">
      <div className="w-20 h-20 rounded-3xl bg-receive-600/25 flex items-center justify-center mb-6 backdrop-blur-sm border border-receive-600/30">
        <span className="text-3xl">📩</span>
      </div>
      <h1 className="text-2xl font-bold tracking-tight mb-3">Check your email</h1>
      <p className="text-white/60 text-[13px] max-w-[300px] leading-relaxed">
        We sent a confirmation link to
      </p>
      <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{email || 'your email address'}</p>
      <p className="text-white/45 text-[12px] max-w-[290px] leading-relaxed mt-4">
        Open it to activate your account, then continue here.
      </p>
      <p className="text-white/35 text-[11px] max-w-[290px] leading-relaxed mt-2">
        Don't see it? Check spam or promotions.
      </p>

      <div className="w-full max-w-[300px] mt-8 space-y-3">
        <button
          onClick={() => window.location.reload()}
          className="w-full bg-white text-navy-900 rounded-2xl py-4 text-[14px] font-semibold active:scale-[0.98] transition-all shadow-lg shadow-white/10"
        >
          I've verified — continue
        </button>
        <button
          onClick={resend}
          disabled={resending || !email}
          className="w-full bg-white/10 border border-white/15 text-white rounded-2xl py-3.5 text-[13px] font-semibold active:scale-[0.98] transition-all disabled:opacity-50 backdrop-blur-sm"
        >
          {resending ? 'Sending…' : 'Resend confirmation email'}
        </button>
      </div>

      {resendMessage && (
        <p className="text-receive-50 text-[12px] mt-4 max-w-[290px] leading-relaxed">{resendMessage}</p>
      )}

      <button onClick={() => signOut()} className="text-white/45 text-[11px] underline mt-6 min-h-[44px]">
        Use a different account
      </button>
    </div>
  );
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
      // modals are click-outside-to-close already. So canGoBack just checks
      // router history depth.
      canGoBack: () => window.history.length > 1,
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
    // Boot-load notifications so the bell badge + Inbox "Info" tab reflect
    // unread informational pings (e.g. "someone added you via your code")
    // before the user ever opens the inbox. Realtime keeps it fresh after.
    void useNotificationStore.getState().loadNotifications().catch((err) => {
      console.error('loadNotifications failed (non-fatal)', err);
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

  if (authLoading || onboardingLoading) {
    return <AppLoadingScreen />;
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
