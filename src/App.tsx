import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { ToastContainer } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useOnboardingStore } from './stores/onboardingStore';
import { useAppModeStore } from './stores/appModeStore';
import { useSupabaseAuthStore } from './stores/supabaseAuthStore';
import { usePersonStore } from './stores/personStore';
import { useLinkedRequestStore } from './stores/linkedRequestStore';
import { useSplitStore } from './stores/splitStore';
import { useSettlementRequestStore } from './stores/settlementRequestStore';
import { runPersonBackfillIfNeeded } from './lib/migrations/backfillPersons';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { startGlobalRealtime, stopGlobalRealtime } from './lib/realtime';

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
import type { SplitGroup } from './db';

function PageLoader() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-mesh">
      <div className="text-center animate-pulse">
        <p className="text-lg font-bold text-indigo-600">Hisaab</p>
        <p className="text-[10px] text-slate-400 mt-1">Loading...</p>
      </div>
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
      localStorage.setItem('hisaab_pending_invite', location.pathname.replace('/join/', ''));
    }
  }, [location.pathname, user]);

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
    // Preload groups on app boot so the QuickEntry "Group expense" picker
    // is ready the moment the user opens it from any page. Previously
    // groups only loaded on /groups visit, which made the picker show
    // "no groups yet" for users who'd never opened the Groups tab.
    void useSplitStore.getState().loadGroups().catch((err) => {
      console.error('loadGroups failed (non-fatal)', err);
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
    const pendingInvite = localStorage.getItem('hisaab_pending_invite');
    if (!pendingInvite) return;
    if (location.pathname !== `/join/${pendingInvite}`) {
      navigate(`/join/${pendingInvite}`, { replace: true });
    }
  }, [completed, location.pathname, navigate, user]);

  if (authLoading || onboardingLoading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-indigo-600">
        <div className="text-center text-white animate-pulse-once">
          <p className="text-2xl font-bold">Hisaab</p>
          <p className="text-xs opacity-60 mt-1">Loading...</p>
        </div>
      </div>
    );
  }

  // Auth gate — must be logged in
  if (!user) {
    return (
      <Suspense fallback={<PageLoader />}>
        <AuthPage />
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
    <div className="min-h-dvh bg-slate-50">
      <PWAInstallPrompt />
      <Suspense fallback={<PageLoader />}>
        <ErrorBoundary>
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
        </ErrorBoundary>
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
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
