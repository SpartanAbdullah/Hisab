import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, CalendarClock, Ghost, Pause, Play, Trash2, Plus } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useRecurringStore } from '../stores/recurringStore';
import { formatMoney } from '../lib/constants';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import {
  isSubscription,
  subscriptionTotals,
  upcomingRenewals,
  detectGhosts,
  describeGhost,
  daysUntil,
} from '../lib/subscriptionMetrics';
import type { RecurringTransaction } from '../db';

export function SubscriptionsPage() {
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const deleteTemplate = useRecurringStore((s) => s.deleteTemplate);
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(() => loadTemplates(), [loadTemplates]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const todayIso = new Date().toISOString().slice(0, 10);
  const subs = templates.filter(isSubscription);
  const totals = subscriptionTotals(templates);
  const renewals = upcomingRenewals(templates, todayIso);
  const ghosts = detectGhosts(templates, todayIso);
  const ghostIds = new Set(ghosts.map((g) => g.template.id));

  // Active first, then paused; within each group soonest-due first.
  const ordered = [...subs].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.nextDueDate.localeCompare(b.nextDueDate);
  });

  const togglePause = async (t: RecurringTransaction) => {
    try {
      await updateTemplate(t.id, { active: !t.active });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not update subscription',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    }
  };

  const handleDelete = async (t: RecurringTransaction) => {
    const ok = await confirmDestructive({
      title: `Remove "${t.label || 'this subscription'}"?`,
      description: 'This stops tracking it. Charges already recorded stay.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await deleteTemplate(t.id);
      toast.show({ type: 'success', title: 'Removed' });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not remove',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title="Subscriptions"
        back
        action={
          <button
            onClick={() => navigate('/recurring')}
            aria-label="Add subscription"
            className="nav-icon-button"
          >
            <Plus size={16} className="text-ink-600" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-4">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load subscriptions"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'loading' && subs.length === 0 ? (
          <ListSkeleton rows={3} withAvatar={false} />
        ) : subs.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={CreditCard}
              tone="accent"
              title="No subscriptions tracked yet"
              description={`Add a recurring expense and tag it "Subscriptions" — Netflix, Spotify, your gym. We'll total the monthly cost and nudge you before each renewal.`}
              subhint="Bhooli hui subscriptions yahin pakdenge."
              actionLabel="Add a subscription"
              onAction={() => navigate('/recurring')}
            />
          ) : null
        ) : (
          <>
            {/* Burn totals — one pair of cards per currency (no cross-currency
                summing; mixed currencies are shown separately). */}
            {totals.byCurrency.map((c) => (
              <div key={c.currency} className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                  <p className="text-[11px] text-ink-500">
                    Per month{totals.mixed ? ` · ${c.currency}` : ''}
                  </p>
                  <p className="text-[20px] font-bold text-ink-900 tabular-nums mt-1">
                    {formatMoney(c.monthly, c.currency)}
                  </p>
                </div>
                <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
                  <p className="text-[11px] text-ink-500">
                    Per year{totals.mixed ? ` · ${c.currency}` : ''}
                  </p>
                  <p className="text-[20px] font-bold text-ink-900 tabular-nums mt-1">
                    {formatMoney(c.yearly, c.currency)}
                  </p>
                </div>
              </div>
            ))}

            {/* Renews soon */}
            {renewals.slice(0, 2).map((r) => (
              <div
                key={`renewal-${r.template.id}`}
                className="flex items-center gap-2.5 rounded-xl bg-info-50 px-3 py-2.5"
              >
                <CalendarClock size={16} className="text-info-600 shrink-0" />
                <p className="text-[12px] text-info-600">
                  <span className="font-semibold">{r.template.label || 'A subscription'}</span>{' '}
                  renews {r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`} ·{' '}
                  {formatMoney(r.template.amount, r.template.currency)}
                </p>
              </div>
            ))}

            {/* Ghost / forgotten alert */}
            {ghosts.length > 0 && (
              <div className="rounded-2xl bg-pay-50 border border-pay-100 p-4">
                <div className="flex items-center gap-2">
                  <Ghost size={15} className="text-pay-text" />
                  <p className="text-[12.5px] font-semibold text-pay-text">
                    {ghosts.length} subscription{ghosts.length > 1 ? 's' : ''} worth a look
                  </p>
                </div>
                <div className="mt-2.5 space-y-1.5">
                  {ghosts.map((g) => (
                    <div key={`ghost-${g.template.id}`} className="flex items-baseline justify-between gap-2">
                      <p className="text-[12px] text-ink-700 truncate">
                        {g.template.label || g.template.category}
                      </p>
                      <p className="text-[11px] text-pay-text shrink-0">{describeGhost(g, todayIso)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Full list */}
            <div className="space-y-2.5">
              {ordered.map((t) => (
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
                    <p className="text-[12px] font-semibold text-pay-text tabular-nums shrink-0">
                      {formatMoney(t.amount, t.currency)}
                    </p>
                  </div>
                  <p className="text-[11px] text-ink-500 mt-1">
                    {cadenceLabel(t)} ·{' '}
                    {statusText(t, ghostIds.has(t.id), todayIso)}
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
                      <Trash2 size={11} /> Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function cadenceLabel(t: RecurringTransaction): string {
  switch (t.cadence) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'yearly':
      return 'Yearly';
  }
}

function statusText(t: RecurringTransaction, isGhost: boolean, todayIso: string): string {
  if (!t.active) return 'paused';
  const d = daysUntil(todayIso, t.nextDueDate);
  if (isGhost && d < 0) return `overdue ${Math.abs(d)}d`;
  if (d < 0) return `due ${Math.abs(d)}d ago`;
  if (d === 0) return 'renews today';
  return `next in ${d}d`;
}
