import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { GlobalFAB } from './components/GlobalFAB';
import { ToastContainer } from './components/Toast';
import { useOnboardingStore } from './stores/onboardingStore';
import { useAppModeStore } from './stores/appModeStore';
import { useSupabaseAuthStore } from './stores/supabaseAuthStore';
import { AuthPage } from './pages/AuthPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { HomePage } from './pages/HomePage';
import { TransactionsPage } from './pages/TransactionsPage';
import { LoansPage } from './pages/LoansPage';
import { LoanDetailPage } from './pages/LoanDetailPage';
import { GoalsPage } from './pages/GoalsPage';
import { ActivityPage } from './pages/ActivityPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { SplitsPage } from './pages/SplitsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { QuickEntry } from './pages/QuickEntry';
import { AddGoalModal } from './pages/AddGoalModal';
import { AddUpcomingExpenseModal } from './pages/AddUpcomingExpenseModal';
import { AddLoanModal } from './pages/AddLoanModal';

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
    return <AuthPage />;
  }

  // Onboarding gate
  if (!completed) {
    return <OnboardingPage />;
  }

  return (
    <div className="min-h-dvh bg-slate-50">
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
