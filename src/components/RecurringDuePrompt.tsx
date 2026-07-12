import { useEffect, useState } from 'react';
import { Repeat, CheckCircle, Pause, SkipForward } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useRecurringStore } from '../stores/recurringStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from './Toast';
import { formatMoney } from '../lib/constants';
import { brandIconFor } from '../lib/brandIcon';
import type { RecurringTransaction } from '../db';
import type { RecurringDueDetail } from '../lib/recurringRunner';

// Listens for the `hisaab:recurring-due` event fired by recurringRunner.
// Walks due templates one at a time, prompting the user to confirm, skip,
// or pause. Confirmation materialises a real Transaction via the existing
// transactionStore.processTransaction pipeline so balance math + activity
// log stay consistent — recurring entries are not a parallel ledger.
export function RecurringDuePrompt() {
  const [queue, setQueue] = useState<RecurringTransaction[]>([]);
  const advanceTemplate = useRecurringStore((s) => s.advanceTemplate);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const accounts = useAccountStore((s) => s.accounts);
  const toast = useToast();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RecurringDueDetail>).detail;
      if (!detail || !Array.isArray(detail.templates)) return;
      setQueue((prev) => {
        // Dedupe — runner can fire twice in a session if the user reloads.
        const seen = new Set(prev.map((t) => t.id));
        const merged = [...prev];
        for (const t of detail.templates) if (!seen.has(t.id)) merged.push(t);
        return merged;
      });
    };
    window.addEventListener('hisaab:recurring-due', handler);
    return () => window.removeEventListener('hisaab:recurring-due', handler);
  }, []);

  const current = queue[0];
  if (!current) return null;

  const accountName = (id: string | null) =>
    accounts.find((a) => a.id === id)?.name ?? 'Unknown';

  const pop = () => setQueue((prev) => prev.slice(1));

  const handleConfirm = async () => {
    setWorking(true);
    try {
      if (current.type === 'income' && current.destinationAccountId) {
        await processTransaction({
          type: 'income',
          destinationAccountId: current.destinationAccountId,
          amount: current.amount,
          category: current.category,
          notes: current.notes,
        });
      } else if (current.type === 'expense' && current.sourceAccountId) {
        await processTransaction({
          type: 'expense',
          sourceAccountId: current.sourceAccountId,
          amount: current.amount,
          category: current.category,
          notes: current.notes,
        });
      } else if (
        current.type === 'transfer' &&
        current.sourceAccountId &&
        current.destinationAccountId
      ) {
        await processTransaction({
          type: 'transfer',
          sourceAccountId: current.sourceAccountId,
          destinationAccountId: current.destinationAccountId,
          amount: current.amount,
          category: current.category,
          notes: current.notes,
        });
      } else {
        throw new Error('Template is missing the account references needed to post.');
      }
      await advanceTemplate(current.id);
      toast.show({ type: 'success', title: `${current.label || current.category} posted` });
      pop();
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not post',
        subtitle: err instanceof Error ? err.message : 'Try again later.',
      });
    } finally {
      setWorking(false);
    }
  };

  const handleSkip = async () => {
    setWorking(true);
    try {
      // Advance the due date so we don't keep nagging this session.
      await advanceTemplate(current.id);
      pop();
    } catch {
      pop();
    } finally {
      setWorking(false);
    }
  };

  const handlePause = async () => {
    setWorking(true);
    try {
      await updateTemplate(current.id, { active: false });
      toast.show({ type: 'success', title: 'Paused. Resume anytime from Recurring.' });
      // Drop everything from the queue belonging to this template.
      setQueue((prev) => prev.filter((t) => t.id !== current.id));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal open={!!current} onClose={pop} title="Recurring entry due">
      <div className="space-y-4">
        <div className="rounded-2xl bg-cream-soft border border-cream-border p-4 flex items-start gap-3">
          {/* Brand/category glyph when we can infer one ("Netflix" → 🎬,
              "Salary" → 💰); generic Repeat icon otherwise. */}
          <div className="w-11 h-11 rounded-2xl bg-accent-100 text-accent-600 flex items-center justify-center shrink-0 text-lg">
            {(() => {
              const icon = brandIconFor(current.label, current.category);
              return icon.matched === 'none' ? <Repeat size={18} strokeWidth={1.8} /> : icon.emoji;
            })()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
              {current.label || current.category}
            </p>
            <p
              className={`text-[13px] font-semibold tabular-nums mt-0.5 ${
                current.type === 'income' ? 'text-receive-text' : 'text-pay-text'
              }`}
            >
              {current.type === 'income' ? '+ ' : '− '}
              {formatMoney(current.amount, current.currency)}
            </p>
            <p className="text-[11px] text-ink-500 mt-1">
              Due {current.nextDueDate} ·{' '}
              {current.type === 'income'
                ? `to ${accountName(current.destinationAccountId)}`
                : `from ${accountName(current.sourceAccountId)}`}
            </p>
          </div>
        </div>

        <button onClick={handleConfirm} disabled={working} className="cta-primary flex items-center justify-center gap-2">
          <CheckCircle size={14} /> {working ? 'Posting…' : 'Confirm & post'}
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleSkip}
            disabled={working}
            className="cta-secondary flex-1 flex items-center justify-center gap-1"
          >
            <SkipForward size={12} /> Skip this one
          </button>
          <button
            onClick={handlePause}
            disabled={working}
            className="cta-secondary flex-1 flex items-center justify-center gap-1"
          >
            <Pause size={12} /> Pause
          </button>
        </div>
        {queue.length > 1 && (
          <p className="text-[11px] text-ink-500 text-center">
            {queue.length - 1} more after this one
          </p>
        )}
      </div>
    </Modal>
  );
}
