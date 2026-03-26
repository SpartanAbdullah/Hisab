import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { GlobalFAB } from './components/GlobalFAB';
import { ToastContainer } from './components/Toast';
import { useOnboardingStore } from './stores/onboardingStore';
import { useAppModeStore } from './stores/appModeStore';
import { useSupabaseAuthStore } from './stores/supabaseAuthStore';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';

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
const SplitsPage = lazy(() => import('./pages/SplitsPage').then(m => ({ default: m.SplitsPage })));
const GroupDetailPage = lazy(() => import('./pages/GroupDetailPage').then(m => ({ default: m.GroupDetailPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));

// These are modals, not routes — keep eagerly loaded
import { QuickEntry } from './pages/QuickEntry';
import { AddGoalModal } from './pages/AddGoalModal';
import { AddUpcomingExpenseModal } from './pages/AddUpcomingExpenseModal';
import { AddLoanModal } from './pages/AddLoanModal';

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
  const { user, loading: authLoading, initialize } = useSupabaseAuthStore();
  const [showQuickEntry, setShowQuickEntry] = useState(false);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showAddLoan, setShowAddLoan] = useState(false);

  useEffect(() => {
    initialize();
    checkOnboarding();
  }, [initialize, checkOnboarding]);

  // Store user ID for supabaseDb helper
  useEffect(() => {
    if (user?.id) {
      localStorage.setItem('hisaab_supabase_uid', user.id);
    } else {
      localStorage.removeItem('hisaab_supabase_uid');
    }
  }, [user]);

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
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/groups" element={<SplitsPage />} />
          <Route path="/group/:id" element={<GroupDetailPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/account/:id" element={<AccountDetailPage />} />

          {/* Full tracker only routes */}
          {mode === 'full_tracker' ? (
            <>
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/loans" element={<LoansPage />} />
              <Route path="/loan/:id" element={<LoanDetailPage />} />
              <Route path="/goals" element={<GoalsPage />} />
            </>
          ) : (
            <>
              <Route path="/transactions" element={<Navigate to="/" replace />} />
              <Route path="/loans" element={<Navigate to="/" replace />} />
              <Route path="/goals" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Suspense>
      <BottomNav />
      <GlobalFAB
        onQuickEntry={() => setShowQuickEntry(true)}
        onAddGoal={() => setShowAddGoal(true)}
        onAddExpense={() => setShowAddExpense(true)}
        onAddLoan={() => setShowAddLoan(true)}
      />
      <QuickEntry open={showQuickEntry} onClose={() => setShowQuickEntry(false)} />
      <AddGoalModal open={showAddGoal} onClose={() => setShowAddGoal(false)} />
      <AddUpcomingExpenseModal open={showAddExpense} onClose={() => setShowAddExpense(false)} />
      <AddLoanModal open={showAddLoan} onClose={() => setShowAddLoan(false)} />
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
