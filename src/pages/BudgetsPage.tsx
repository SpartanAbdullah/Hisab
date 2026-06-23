import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Wallet2, Pencil, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Modal } from '../components/Modal';
import { useBudgetStore, computeBudgetUsages } from '../stores/budgetStore';
import { useTransactionStore } from '../stores/transactionStore';
import { EXPENSE_CATEGORIES, formatMoney } from '../lib/constants';
import { useCategoryOptions } from '../lib/mergedCategories';
import { SUPPORTED_CURRENCIES, type Currency, type Budget } from '../db';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useT } from '../lib/i18n';

export function BudgetsPage() {
  const t = useT();
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
  const overLimitCount = usages.filter((usage) => usage.overLimit).length;
  const overWarnCount = usages.filter((usage) => usage.overWarn && !usage.overLimit).length;

  // "Left to spend this month" up front — the envelope mental model. Budgets are
  // per-currency, so we total each currency separately (primary first) rather
  // than mixing them into one meaningless number.
  const primaryCurrency = (localStorage.getItem('hisaab_primary_currency') as Currency) ?? 'AED';
  const leftSummary = useMemo(() => {
    const byCurrency = new Map<Currency, { budget: number; spent: number }>();
    for (const u of usages) {
      const entry = byCurrency.get(u.budget.currency) ?? { budget: 0, spent: 0 };
      entry.budget += u.budget.monthlyAmount;
      entry.spent += u.spent;
      byCurrency.set(u.budget.currency, entry);
    }
    return [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, budget: v.budget, spent: v.spent, left: v.budget - v.spent }))
      .sort((a, b) => (a.currency === primaryCurrency ? -1 : b.currency === primaryCurrency ? 1 : b.budget - a.budget));
  }, [usages, primaryCurrency]);

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

        {loadStatus === 'ready' && usages.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {overLimitCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-pay-700 bg-pay-50 rounded-full px-2 py-1 tabular-nums">
                <AlertTriangle size={11} className="text-pay-700" />
                {t('budget_over').replace('{n}', String(overLimitCount))}
              </span>
            )}
            {overWarnCount > 0 && (
              <span className="inline-flex items-center text-[10px] font-semibold text-warn-700 bg-warn-50 rounded-full px-2 py-1 tabular-nums">
                {t('budget_near').replace('{n}', String(overWarnCount))}
              </span>
            )}
            {overLimitCount === 0 && overWarnCount === 0 && (
              <span className="inline-flex items-center text-[10px] font-semibold text-receive-text bg-receive-50 rounded-full px-2 py-1">
                {t('budget_on_track')}
              </span>
            )}
          </div>
        )}

        {loadStatus === 'ready' && leftSummary.length > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
            <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
              {t('budget_left_title')}
            </p>
            <div className="mt-2 space-y-2">
              {leftSummary.map((s) => (
                <div key={s.currency} className="flex items-baseline justify-between gap-2">
                  <span className={`text-[22px] font-bold tabular-nums tracking-tight ${s.left < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
                    {s.left < 0 ? '−' : ''}{formatMoney(Math.abs(s.left), s.currency)}
                  </span>
                  <span className="text-[11px] text-ink-500 tabular-nums">
                    {t('budget_spent_of')
                      .replace('{spent}', formatMoney(s.spent, s.currency))
                      .replace('{total}', formatMoney(s.budget, s.currency))}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
  const t = useT();
  const { budget, spent, remaining, percent, overLimit, overWarn } = usage;
  const cappedPercent = Math.min(percent, 100);
  // Where "on pace" spending would sit today — a vertical tick on the bar so
  // the user can see if they're ahead of or behind an even monthly burn.
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expectedPercent = Math.min(100, (dayOfMonth / daysInMonth) * 100);
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
          className={`text-[11px] font-semibold tabular-nums inline-flex items-center gap-1 ${
            overLimit ? 'text-pay-text' : 'text-receive-text'
          }`}
        >
          {overLimit ? (
            <>
              <AlertTriangle size={11} className="text-pay-text shrink-0" aria-hidden="true" />
              {t('budget_over_by_short').replace('{amount}', formatMoney(Math.abs(remaining), budget.currency))}
              <span className="sr-only">
                {t('budget_over_by').replace('{amount}', formatMoney(Math.abs(remaining), budget.currency))}
              </span>
            </>
          ) : (
            `${formatMoney(remaining, budget.currency)} left`
          )}
        </p>
      </div>
      <div className="relative mt-2.5 h-2 rounded-full bg-cream-soft overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${cappedPercent}%` }}
        />
        {/* Pace tick — where even spending would put us today. */}
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-ink-400/70"
          style={{ left: `${expectedPercent}%` }}
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
  // Merged built-in + custom expense categories, so a user can budget against
  // their own categories (e.g. "Pet Food").
  const categoryOptions = useCategoryOptions('expense');

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
            {categoryOptions.map((c) => (
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
  const t = useT();
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
    const ok = await confirmDestructive({
      title: `Delete the ${budget.category} budget?`,
      description: t('del_budget_body'),
      confirmLabel: 'Delete',
    });
    if (!ok) return;
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
