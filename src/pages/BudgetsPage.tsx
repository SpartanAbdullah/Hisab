import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Wallet2, Pencil, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Modal } from '../components/Modal';
import { useBudgetStore, computeBudgetUsages } from '../stores/budgetStore';
import { useTransactionStore } from '../stores/transactionStore';
import { EXPENSE_CATEGORIES, formatMoney } from '../lib/constants';
import { SUPPORTED_CURRENCIES, type Currency, type Budget } from '../db';
import { useToast } from '../components/Toast';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

export function BudgetsPage() {
  const budgets = useBudgetStore((s) => s.budgets);
  const loadBudgets = useBudgetStore((s) => s.loadBudgets);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);

  const load = useCallback(async () => {
    const tasks: Promise<unknown>[] = [loadBudgets()];
    if (transactions.length === 0) tasks.push(loadTransactions());
    await Promise.all(tasks);
  }, [loadBudgets, loadTransactions, transactions.length]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  // Recompute every time budgets or transactions change. Cheap; pure pass.
  const usages = useMemo(
    () => computeBudgetUsages(budgets, transactions),
    [budgets, transactions],
  );

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title="Budgets"
        back
        action={
          <button
            onClick={() => setShowAdd(true)}
            aria-label="Add budget"
            className="nav-icon-button"
          >
            <Plus size={16} className="text-ink-600" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-3">
        <p className="text-[12px] text-ink-500 leading-relaxed">
          Set a monthly cap per category. We&rsquo;ll quietly nudge you when you
          cross 80% — no shouting, no judgment.
        </p>

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load budgets"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'loading' && usages.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : usages.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={Wallet2}
              tone="accent"
              title="No budgets yet"
              description="Pick a category and a monthly cap. We'll track the rest."
              subhint="Start with Groceries or Eating Out — easiest wins."
              actionLabel="Add a budget"
              onAction={() => setShowAdd(true)}
            />
          ) : null
        ) : (
          <div className="space-y-2.5">
            {usages.map((usage) => (
              <BudgetCard
                key={usage.budget.id}
                usage={usage}
                onEdit={() => setEditing(usage.budget)}
              />
            ))}
          </div>
        )}
      </div>

      <AddBudgetModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        existing={budgets}
      />

      <EditBudgetModal
        budget={editing}
        onClose={() => setEditing(null)}
      />
    </main>
  );
}

interface BudgetCardProps {
  usage: ReturnType<typeof computeBudgetUsages>[number];
  onEdit: () => void;
}

function BudgetCard({ usage, onEdit }: BudgetCardProps) {
  const { budget, spent, remaining, percent, overLimit, overWarn } = usage;
  const cappedPercent = Math.min(percent, 100);
  // Bar color shifts as the user gets closer to the cap. Green → amber → coral
  // so the meaning is obvious without reading the number.
  const barColor = overLimit
    ? 'bg-pay-600'
    : overWarn
      ? 'bg-warn-600'
      : 'bg-receive-600';
  return (
    <button
      onClick={onEdit}
      className="w-full text-left rounded-2xl bg-cream-card border border-cream-border p-4 active:scale-[0.99] transition-transform"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
          {budget.category}
        </p>
        <p className="text-[10.5px] text-ink-500 tabular-nums">
          {percent.toFixed(0)}%
        </p>
      </div>
      <div className="flex items-baseline justify-between gap-2 mt-1">
        <p className="text-[12px] text-ink-600 tabular-nums">
          <span className="font-semibold text-ink-900">{formatMoney(spent, budget.currency)}</span>
          {' '}/ {formatMoney(budget.monthlyAmount, budget.currency)}
        </p>
        <p
          className={`text-[11px] font-semibold tabular-nums ${
            overLimit ? 'text-pay-text' : 'text-receive-text'
          }`}
        >
          {overLimit
            ? `${formatMoney(Math.abs(remaining), budget.currency)} over`
            : `${formatMoney(remaining, budget.currency)} left`}
        </p>
      </div>
      <div className="mt-2.5 h-2 rounded-full bg-cream-soft overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${cappedPercent}%` }}
        />
      </div>
    </button>
  );
}

interface AddBudgetModalProps {
  open: boolean;
  onClose: () => void;
  existing: Budget[];
}

function AddBudgetModal({ open, onClose, existing }: AddBudgetModalProps) {
  const createBudget = useBudgetStore((s) => s.createBudget);
  const toast = useToast();
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>(
    (localStorage.getItem('hisaab_primary_currency') as Currency) ?? 'AED',
  );
  const [warnAt, setWarnAt] = useState(80);
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setCategory(EXPENSE_CATEGORIES[0]);
    setAmount('');
    setWarnAt(80);
  }, []);

  const handleSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: 'Enter a valid monthly amount' });
      return;
    }
    // Check for duplicate (same category + currency) up-front so the
    // unique-index violation surfaces as a friendly toast, not a stack trace.
    const dup = existing.find(
      (b) => b.category.toLowerCase() === category.toLowerCase() && b.currency === currency,
    );
    if (dup) {
      toast.show({
        type: 'error',
        title: 'Budget already exists',
        subtitle: `You already have a ${currency} budget for ${category}.`,
      });
      return;
    }
    setSaving(true);
    try {
      await createBudget({ category, monthlyAmount: numeric, currency, warnAtPercent: warnAt });
      toast.show({ type: 'success', title: 'Budget set' });
      reset();
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not save budget',
        subtitle: err instanceof Error ? err.message : 'Try again in a moment.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New budget">
      <div className="space-y-4">
        <div>
          <label className="form-label">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input-field"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="form-label">Monthly cap</label>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="input-field tabular-nums"
            />
          </div>
          <div>
            <label className="form-label">Currency</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              className="input-field"
            >
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="form-label">Warn at</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={warnAt}
              onChange={(e) => setWarnAt(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-[12.5px] font-semibold text-ink-900 tabular-nums w-12 text-right">
              {warnAt}%
            </span>
          </div>
          <p className="text-[11px] text-ink-500 mt-1.5">
            We&rsquo;ll show a soft warning on Home when this category crosses
            this percent.
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !amount}
          className="cta-primary"
        >
          {saving ? 'Saving…' : 'Save budget'}
        </button>
      </div>
    </Modal>
  );
}

interface EditBudgetModalProps {
  budget: Budget | null;
  onClose: () => void;
}

function EditBudgetModal({ budget, onClose }: EditBudgetModalProps) {
  const updateBudget = useBudgetStore((s) => s.updateBudget);
  const deleteBudget = useBudgetStore((s) => s.deleteBudget);
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [warnAt, setWarnAt] = useState(80);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (budget) {
      setAmount(String(budget.monthlyAmount));
      setWarnAt(budget.warnAtPercent);
    }
  }, [budget]);

  if (!budget) return null;

  const handleSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: 'Enter a valid monthly amount' });
      return;
    }
    setSaving(true);
    try {
      await updateBudget(budget.id, { monthlyAmount: numeric, warnAtPercent: warnAt });
      toast.show({ type: 'success', title: 'Budget updated' });
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not save budget',
        subtitle: err instanceof Error ? err.message : 'Try again in a moment.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete the ${budget.category} budget?`)) return;
    setSaving(true);
    try {
      await deleteBudget(budget.id);
      toast.show({ type: 'success', title: 'Budget deleted' });
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not delete budget',
        subtitle: err instanceof Error ? err.message : 'Try again in a moment.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!budget} onClose={onClose} title={`Edit ${budget.category}`}>
      <div className="space-y-4">
        <div>
          <label className="form-label">Monthly cap ({budget.currency})</label>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input-field tabular-nums"
          />
        </div>

        <div>
          <label className="form-label">Warn at</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={warnAt}
              onChange={(e) => setWarnAt(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-[12.5px] font-semibold text-ink-900 tabular-nums w-12 text-right">
              {warnAt}%
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleDelete}
            disabled={saving}
            className="cta-destructive flex-1 flex items-center justify-center gap-2"
          >
            <Trash2 size={14} /> Delete
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="cta-primary flex-1 flex items-center justify-center gap-2"
          >
            <Pencil size={14} /> Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
