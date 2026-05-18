import { useEffect, useState } from 'react';
import { Plus, Repeat, Pause, Play, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { useRecurringStore } from '../stores/recurringStore';
import { useAccountStore } from '../stores/accountStore';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, formatMoney } from '../lib/constants';
import { useToast } from '../components/Toast';
import type { RecurringCadence, RecurringTransaction } from '../db';

export function RecurringTransactionsPage() {
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const deleteTemplate = useRecurringStore((s) => s.deleteTemplate);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const toast = useToast();
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    void loadTemplates();
    if (accounts.length === 0) void loadAccounts();
  }, [loadTemplates, loadAccounts, accounts.length]);

  const accountName = (id: string | null) =>
    accounts.find((a) => a.id === id)?.name ?? 'Unknown';

  const togglePause = async (t: RecurringTransaction) => {
    try {
      await updateTemplate(t.id, { active: !t.active });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not update template',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    }
  };

  const handleDelete = async (t: RecurringTransaction) => {
    if (!window.confirm(`Delete the "${t.label || t.category}" recurring entry?`)) return;
    try {
      await deleteTemplate(t.id);
      toast.show({ type: 'success', title: 'Deleted' });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not delete',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title="Recurring"
        back
        action={
          <button
            onClick={() => setShowAdd(true)}
            aria-label="Add recurring entry"
            className="nav-icon-button"
          >
            <Plus size={16} className="text-ink-600" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-3">
        <p className="text-[12px] text-ink-500 leading-relaxed">
          Salary, rent, EMIs — anything that repeats. On its due date we&rsquo;ll
          ask, you confirm, we post. Pause anytime.
        </p>

        {templates.length === 0 ? (
          <EmptyState
            icon={Repeat}
            tone="accent"
            title="No recurring entries"
            description="Set up salary, rent, EMIs once. They'll show up on their date for a one-tap confirm."
            subhint="Pehle salary add karo — har mahine ek tap kaafi."
            actionLabel="Add a recurring entry"
            onAction={() => setShowAdd(true)}
          />
        ) : (
          <div className="space-y-2.5">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`rounded-2xl bg-cream-card border border-cream-border p-4 ${
                  !t.active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
                    {t.label || t.category}
                  </p>
                  <p
                    className={`text-[11px] font-semibold tabular-nums ${
                      t.type === 'income' ? 'text-receive-text' : 'text-pay-text'
                    }`}
                  >
                    {t.type === 'income' ? '+ ' : '− '}
                    {formatMoney(t.amount, t.currency)}
                  </p>
                </div>
                <p className="text-[11px] text-ink-500 mt-1">
                  {cadenceLabel(t.cadence)} · next {t.nextDueDate} ·{' '}
                  {t.type === 'income'
                    ? `to ${accountName(t.destinationAccountId)}`
                    : `from ${accountName(t.sourceAccountId)}`}
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => togglePause(t)}
                    className="text-[11px] font-semibold text-ink-700 bg-cream-soft rounded-lg px-2.5 py-1 flex items-center gap-1 active:scale-95 transition-transform"
                  >
                    {t.active ? <Pause size={11} /> : <Play size={11} />}
                    {t.active ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    onClick={() => handleDelete(t)}
                    className="text-[11px] font-semibold text-pay-text bg-pay-50 rounded-lg px-2.5 py-1 flex items-center gap-1 active:scale-95 transition-transform"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AddRecurringModal open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}

function cadenceLabel(c: RecurringCadence): string {
  switch (c) {
    case 'daily':
      return 'Every day';
    case 'weekly':
      return 'Every week';
    case 'monthly':
      return 'Every month';
    case 'yearly':
      return 'Every year';
  }
}

interface AddRecurringModalProps {
  open: boolean;
  onClose: () => void;
}

function AddRecurringModal({ open, onClose }: AddRecurringModalProps) {
  const createTemplate = useRecurringStore((s) => s.createTemplate);
  const accounts = useAccountStore((s) => s.accounts);
  const toast = useToast();
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [cadence, setCadence] = useState<RecurringCadence>('monthly');
  const [nextDueDate, setNextDueDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: 'Enter a valid amount' });
      return;
    }
    if (!accountId) {
      toast.show({ type: 'error', title: 'Pick an account' });
      return;
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      toast.show({ type: 'error', title: 'Account not found' });
      return;
    }
    setSaving(true);
    try {
      await createTemplate({
        type,
        amount: numeric,
        currency: account.currency,
        sourceAccountId: type === 'expense' ? accountId : null,
        destinationAccountId: type === 'income' ? accountId : null,
        category,
        notes: '',
        cadence,
        nextDueDate,
        label: label.trim(),
      });
      toast.show({ type: 'success', title: 'Recurring entry saved' });
      onClose();
      setLabel('');
      setAmount('');
      setAccountId('');
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not save',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  const categoryList = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  return (
    <Modal open={open} onClose={onClose} title="New recurring entry">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setType('expense');
              setCategory(EXPENSE_CATEGORIES[0]);
            }}
            className={`selector-base justify-center text-[12.5px] font-semibold ${
              type === 'expense' ? 'selector-selected' : ''
            }`}
          >
            Expense
          </button>
          <button
            onClick={() => {
              setType('income');
              setCategory(INCOME_CATEGORIES[0]);
            }}
            className={`selector-base justify-center text-[12.5px] font-semibold ${
              type === 'income' ? 'selector-selected' : ''
            }`}
          >
            Income
          </button>
        </div>

        <div>
          <label className="form-label">Label (optional)</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Rent · Netflix · Salary"
            className="input-field"
          />
        </div>

        <div>
          <label className="form-label">Amount</label>
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
          <label className="form-label">{type === 'expense' ? 'From account' : 'To account'}</label>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="input-field"
          >
            <option value="">Pick an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="form-label">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input-field"
          >
            {categoryList.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">Repeats</label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as RecurringCadence)}
              className="input-field"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label className="form-label">Next due</label>
            <input
              type="date"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
              className="input-field"
            />
          </div>
        </div>

        <button onClick={handleSave} disabled={saving} className="cta-primary">
          {saving ? 'Saving…' : 'Save recurring entry'}
        </button>
      </div>
    </Modal>
  );
}
