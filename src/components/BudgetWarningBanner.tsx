import { useState } from 'react';
import { Wallet2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { BudgetUsage } from '../stores/budgetStore';
import { formatMoney } from '../lib/constants';

interface Props {
  usages: BudgetUsage[];
}

const DISMISS_KEY = 'hisaab_budget_warning_dismissed_v1';

// Renders only when at least one budget has crossed its warn threshold.
// The dismiss state is per-session-only — keeps the banner from being
// annoying mid-session but it will return tomorrow if the user is still
// over-budget. (That's the point.)
export function BudgetWarningBanner({ usages }: Props) {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(() => {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      return raw === '1';
    } catch {
      return false;
    }
  });

  const flagged = usages.filter((u) => u.overWarn);
  if (hidden || flagged.length === 0) return null;

  // Lead with the most-overspent budget so the headline is immediately
  // actionable even when multiple are flagged.
  const headline = [...flagged].sort((a, b) => b.percent - a.percent)[0];

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* sessionStorage unavailable — UI still hides via state */
    }
    setHidden(true);
  };

  return (
    <div
      className={`rounded-2xl border ${
        headline.overLimit ? 'bg-pay-50 border-pay-100' : 'bg-warn-50 border-warn-50'
      } px-4 py-3 flex items-start gap-3`}
    >
      <div
        className={`w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 ${
          headline.overLimit ? 'bg-pay-100 text-pay-600' : 'bg-warn-50 text-warn-600'
        }`}
      >
        <Wallet2 size={16} strokeWidth={2.2} />
      </div>
      <button
        onClick={() => navigate('/budgets')}
        className="flex-1 min-w-0 text-left"
      >
        <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
          {headline.overLimit ? 'Over budget' : 'Approaching cap'} ·{' '}
          {headline.budget.category}
        </p>
        <p className="text-[11px] text-ink-600 mt-0.5 leading-snug">
          {formatMoney(headline.spent, headline.budget.currency)} of{' '}
          {formatMoney(headline.budget.monthlyAmount, headline.budget.currency)} this month
          {flagged.length > 1 && ` · +${flagged.length - 1} more`}
        </p>
      </button>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className='relative w-7 h-7 rounded-lg flex items-center justify-center text-ink-500 active:bg-warn-50/60 transition-colors shrink-0 before:absolute before:-inset-2 before:content-[""]'
      >
        <X size={14} />
      </button>
    </div>
  );
}
