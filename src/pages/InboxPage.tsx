import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Inbox, Send, AlertTriangle, Repeat, CreditCard, CalendarClock, ChevronRight, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NavyHero, TopBar } from '../components/NavyHero';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { usePersonStore } from '../stores/personStore';
import { useBudgetStore } from '../stores/budgetStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useNotificationStore } from '../stores/notificationStore';
import { buildInboxInfoItems, isInboxInfoNotification, type InfoItem, type InfoIcon as InfoIconKind } from '../lib/inboxInfo';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { formatMoney } from '../lib/constants';
import { approxOther, plausibilityCheck } from '../lib/currencyValidation';
import { useT } from '../lib/i18n';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { EmptyState } from '../components/EmptyState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import type { LinkedRequest, SettlementRequest } from '../db';

type Tab = 'incoming' | 'outgoing' | 'info';

type InboxItem =
  | { kind: 'linked'; item: LinkedRequest }
  | { kind: 'settlement'; item: SettlementRequest };

export function InboxPage() {
  const user = useSupabaseAuthStore((s) => s.user);
  const { requests, loadRequests, accept, reject, cancel } = useLinkedRequestStore();
  const settlements = useSettlementRequestStore((s) => s.requests);
  const loadSettlements = useSettlementRequestStore((s) => s.loadRequests);
  const acceptSettlement = useSettlementRequestStore((s) => s.accept);
  const rejectSettlement = useSettlementRequestStore((s) => s.reject);
  const cancelSettlement = useSettlementRequestStore((s) => s.cancel);
  const persons = usePersonStore((s) => s.persons);
  const budgets = useBudgetStore((s) => s.budgets);
  const loadBudgets = useBudgetStore((s) => s.loadBudgets);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const upcoming = useUpcomingExpenseStore((s) => s.expenses);
  const loadExpenses = useUpcomingExpenseStore((s) => s.loadExpenses);
  const notifications = useNotificationStore((s) => s.notifications);
  const loadNotifications = useNotificationStore((s) => s.loadNotifications);
  const markNotificationRead = useNotificationStore((s) => s.markRead);
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();

  const [tab, setTab] = useState<Tab>('incoming');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.all([
      loadRequests(), loadSettlements(),
      // Info-tab sources (cheap; most are already warm from app boot).
      loadBudgets(), loadTransactions(), loadTemplates(), loadAccounts(), loadExpenses(), loadNotifications(),
    ]);
  }, [loadRequests, loadSettlements, loadBudgets, loadTransactions, loadTemplates, loadAccounts, loadExpenses, loadNotifications]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  useEffect(() => {
    const onFocus = () => { void loadRequests(); void loadSettlements(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRequests, loadSettlements]);

  const myId = user?.id ?? '';

  const visible: InboxItem[] = useMemo(() => {
    const linkedItems: InboxItem[] = requests
      .filter((r) => (tab === 'incoming' ? r.toUserId === myId : r.fromUserId === myId))
      .map((r) => ({ kind: 'linked' as const, item: r }));
    const settlementItems: InboxItem[] = settlements
      .filter((r) => (tab === 'incoming' ? r.toUserId === myId : r.fromUserId === myId))
      .map((r) => ({ kind: 'settlement' as const, item: r }));
    return [...linkedItems, ...settlementItems].sort((a, b) =>
      b.item.createdAt.localeCompare(a.item.createdAt),
    );
  }, [requests, settlements, tab, myId]);

  const incomingPendingCount = useMemo(
    () =>
      requests.filter((r) => r.status === 'pending' && r.toUserId === myId).length +
      settlements.filter((r) => r.status === 'pending' && r.toUserId === myId).length,
    [requests, settlements, myId],
  );
  const outgoingPendingCount = useMemo(
    () =>
      requests.filter((r) => r.status === 'pending' && r.fromUserId === myId).length +
      settlements.filter((r) => r.status === 'pending' && r.fromUserId === myId).length,
    [requests, settlements, myId],
  );

  const infoItems = useMemo(
    () => buildInboxInfoItems({ budgets, transactions, templates, accounts, upcoming, today: new Date() }),
    [budgets, transactions, templates, accounts, upcoming],
  );
  // Unread informational notifications (e.g. "someone added you via your code")
  // sit at the top of the Info tab, newest first.
  const infoNotifs = useMemo(
    () => notifications.filter(isInboxInfoNotification).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [notifications],
  );
  // The Info badge counts only clearable unread notifications. The live
  // derived signals below (budget / credit-card / subscription) are
  // informational content — they must NOT drive a red count the user can
  // never clear (that was the "stays at 1 after reading" bug).
  const infoCount = infoNotifs.length;

  // Smart landing: once data is loaded, jump to whichever tab has the most
  // active items. Tie-break order Incoming > Info > Outgoing (action items
  // first). Runs once via a ref so a later store refresh — or the user's own
  // tab tap — is never overridden.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || loadStatus !== 'ready') return;
    didAutoSelect.current = true;
    const counts: Record<Tab, number> = {
      incoming: incomingPendingCount,
      info: infoCount,
      outgoing: outgoingPendingCount,
    };
    let best: Tab = 'incoming';
    for (const candidate of ['incoming', 'info', 'outgoing'] as Tab[]) {
      if (counts[candidate] > counts[best]) best = candidate;
    }
    if (counts[best] > 0) setTab(best);
  }, [loadStatus, incomingPendingCount, infoCount, outgoingPendingCount]);

  // Phase H4: surface the actual error in each catch instead of swallowing
  // it. Previously every failure showed the same generic toast title, which
  // made it impossible to tell whether the issue was missing RPCs, RLS,
  // stale state, network, or auth. Now the catch logs to console.error AND
  // includes the message as the toast subtitle, so users can read it and
  // we can see it in DevTools / Sentry.
  const errorSubtitle = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  };

  const handleAccept = async (id: string) => {
    // Tier-2: cross-user, irreversible, currency-locks on accept → deliberate confirm.
    const req = requests.find((r) => r.id === id);
    if (req) {
      // Defense-in-depth: refuse an implausible amount before it mirrors onto
      // your ledger, even if it slipped past the sender's guard.
      const plaus = plausibilityCheck(req.amount, req.currency);
      if (!plaus.passed && plaus.severity === 'block') {
        toast.show({ type: 'error', title: 'This amount looks off', subtitle: `${plaus.reason ?? ''} Ask them to resend it.` });
        return;
      }
      const approx = approxOther(req.amount, req.currency);
      const warnNote = !plaus.passed && plaus.reason ? ` ${plaus.reason}` : '';
      const ok = await confirmDestructive({
        title: t('confirm_accept_title').replace('{amount}', formatMoney(req.amount, req.currency)),
        description:
          t('confirm_accept_body').replace('{approx}', approx ? `${approx}. ` : '') + warnNote,
        confirmLabel: t('ltr_accept'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return;
    }
    setBusyId(id);
    try {
      await accept(id);
      toast.show({
        type: 'success',
        title: 'Accepted ✓',
        subtitle: req ? `${formatMoney(req.amount, req.currency)} is now on your ledger.` : undefined,
      });
    } catch (err) {
      console.error('[inbox] accept failed', err);
      toast.show({ type: 'error', title: t('ltr_accept_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleReject = async (id: string) => {
    setBusyId(id);
    try {
      await reject(id);
    } catch (err) {
      console.error('[inbox] reject failed', err);
      toast.show({ type: 'error', title: t('ltr_reject_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancel = async (id: string) => {
    setBusyId(id);
    try {
      await cancel(id);
    } catch (err) {
      console.error('[inbox] cancel failed', err);
      toast.show({ type: 'error', title: t('ltr_cancel_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptSettlement = async (id: string) => {
    const req = settlements.find((r) => r.id === id);
    if (req) {
      const ok = await confirmDestructive({
        title: t('confirm_settle_title').replace('{amount}', formatMoney(req.amount, req.currency)),
        description: t('confirm_settle_body'),
        confirmLabel: t('confirm_settle_cta'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return;
    }
    setBusyId(id);
    try {
      await acceptSettlement(id);
      toast.show({
        type: 'success',
        title: 'Settled up 🎉',
        subtitle: req ? `${formatMoney(req.amount, req.currency)} cleared.` : undefined,
      });
    } catch (err) {
      console.error('[inbox] accept settlement failed', err);
      toast.show({ type: 'error', title: t('stl_accept_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleRejectSettlement = async (id: string) => {
    setBusyId(id);
    try {
      await rejectSettlement(id);
    } catch (err) {
      console.error('[inbox] reject settlement failed', err);
      toast.show({ type: 'error', title: t('stl_reject_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancelSettlement = async (id: string) => {
    setBusyId(id);
    try {
      await cancelSettlement(id);
    } catch (err) {
      console.error('[inbox] cancel settlement failed', err);
      toast.show({ type: 'error', title: t('stl_cancel_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };

  function contactNameForSettlement(r: SettlementRequest): string {
    if (r.fromUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.toUserId);
      if (p) return p.name;
    }
    if (r.toUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.fromUserId);
      if (p) return p.name;
    }
    return t('ltr_unknown_person');
  }

  function contactNameFor(r: LinkedRequest): string {
    // Outgoing: the sender knows the contact by their local persons.name.
    // Incoming: the receiver may not have a contact row for the sender yet
    // (the accept RPC auto-creates one on confirm). Fall back to "Hisaab user".
    if (r.fromUserId === myId && r.personId) {
      const p = persons.find((x) => x.id === r.personId);
      if (p) return p.name;
    }
    if (r.toUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.fromUserId);
      if (p) return p.name;
    }
    return t('ltr_unknown_person');
  }

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('ltr_inbox_title')}
          back
          // Hide the inbox bell from the top-right — we're already on the
          // inbox page, the icon would be redundant + confusing.
          showInbox={false}
          action={
            <PillToggle
              tab={tab}
              setTab={setTab}
              incomingCount={incomingPendingCount}
              outgoingCount={outgoingPendingCount}
              infoCount={infoCount}
              incomingLabel={t('ltr_tab_incoming')}
              outgoingLabel={t('ltr_tab_outgoing')}
              infoLabel={t('ltr_tab_info')}
            />
          }
        />
        <div className="px-5 pb-7">
          <p className="text-white text-[16px] font-medium leading-snug max-w-[300px]">
            {tab === 'incoming' ? t('ltr_incoming_hint') : tab === 'outgoing' ? t('ltr_outgoing_hint') : t('ltr_info_hint')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load inbox"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {tab === 'info' ? (
          loadStatus === 'loading' && infoItems.length === 0 && infoNotifs.length === 0 ? (
            <ListSkeleton rows={3} withAvatar={false} />
          ) : infoItems.length === 0 && infoNotifs.length === 0 ? (
            loadStatus === 'ready' ? (
              <EmptyState
                icon={Inbox}
                tone="receive"
                title={t('inbox_empty_info_title')}
                description={t('inbox_empty_info_desc')}
              />
            ) : null
          ) : (
            <div className="space-y-2.5">
              {infoNotifs.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void markNotificationRead(n.id)}
                  className="w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 active:scale-[0.99] transition-transform"
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-accent-50">
                    <UserPlus size={17} className="text-accent-600" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">{n.title || 'New connection'}</p>
                    <p className="text-[11.5px] text-ink-500 mt-0.5 line-clamp-2">{n.body}</p>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-accent-500 shrink-0" aria-hidden />
                </button>
              ))}
              {infoItems.map((it) => (
                <InfoCard key={it.id} item={it} onOpen={() => it.href && navigate(it.href)} />
              ))}
            </div>
          )
        ) : loadStatus === 'loading' && visible.length === 0 ? (
          <ListSkeleton rows={3} withAvatar={false} />
        ) : visible.length === 0 ? (
          loadStatus === 'ready' ? (
            tab === 'incoming' ? (
              <EmptyState
                icon={Inbox}
                tone="accent"
                title={t('inbox_empty_incoming_title')}
                description={t('inbox_empty_incoming_desc')}
                // One-line explainer so an empty incoming tab reads as
                // "nothing to do" rather than "is this broken?".
                subhint={t('inbox_incoming_explainer')}
              />
            ) : (
              <EmptyState
                icon={Send}
                tone="receive"
                title={t('inbox_empty_outgoing_title')}
                description={t('inbox_empty_outgoing_desc')}
                // Outgoing-empty nudges toward the place linked requests are
                // created: a linked contact's detail sheet.
                actionLabel={t('inbox_send_request')}
                onAction={() => navigate('/contacts')}
              />
            )
          ) : null
        ) : (
          <div className="space-y-2.5">
            {visible.map((entry) =>
              entry.kind === 'linked' ? (
                <RequestCard
                  key={`ltr-${entry.item.id}`}
                  request={entry.item}
                  tab={tab}
                  busy={busyId === entry.item.id}
                  contactName={contactNameFor(entry.item)}
                  onAccept={() => handleAccept(entry.item.id)}
                  onReject={() => handleReject(entry.item.id)}
                  onCancel={() => handleCancel(entry.item.id)}
                />
              ) : (
                <SettlementCard
                  key={`lsr-${entry.item.id}`}
                  request={entry.item}
                  tab={tab}
                  busy={busyId === entry.item.id}
                  contactName={contactNameForSettlement(entry.item)}
                  onAccept={() => handleAcceptSettlement(entry.item.id)}
                  onReject={() => handleRejectSettlement(entry.item.id)}
                  onCancel={() => handleCancelSettlement(entry.item.id)}
                />
              ),
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// Hoisted out of PillToggle — components defined inside a parent's render
// body lose state on every parent re-render (react-hooks/static-components).
function Pill({
  value,
  label,
  count,
  activeTab,
  onSelect,
}: {
  value: Tab;
  label: string;
  count: number;
  activeTab: Tab;
  onSelect: (t: Tab) => void;
}) {
  const isActive = activeTab === value;
  return (
    <button
      onClick={() => onSelect(value)}
      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors flex items-center gap-1 ${
        isActive ? 'bg-white text-ink-900' : 'text-white/70'
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`min-w-[14px] h-3.5 px-1 rounded-full text-[9px] font-bold flex items-center justify-center tabular-nums ${
            isActive ? 'bg-pay-600 text-white' : 'bg-white/15 text-white'
          }`}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

function PillToggle({
  tab,
  setTab,
  incomingCount,
  outgoingCount,
  infoCount,
  incomingLabel,
  outgoingLabel,
  infoLabel,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  incomingCount: number;
  outgoingCount: number;
  infoCount: number;
  incomingLabel: string;
  outgoingLabel: string;
  infoLabel: string;
}) {
  return (
    <div className="bg-white/10 rounded-full p-0.5 flex items-center">
      <Pill value="incoming" label={incomingLabel} count={incomingCount} activeTab={tab} onSelect={setTab} />
      <Pill value="info" label={infoLabel} count={infoCount} activeTab={tab} onSelect={setTab} />
      <Pill value="outgoing" label={outgoingLabel} count={outgoingCount} activeTab={tab} onSelect={setTab} />
    </div>
  );
}

const INFO_ICON: Record<InfoIconKind, typeof AlertTriangle> = {
  budget: AlertTriangle,
  renewal: Repeat,
  card: CreditCard,
  bill: CalendarClock,
};

const INFO_TONE: Record<InfoItem['tone'], { wrap: string; icon: string }> = {
  pay: { wrap: 'bg-pay-50', icon: 'text-pay-text' },
  warn: { wrap: 'bg-warn-50', icon: 'text-warn-600' },
  info: { wrap: 'bg-info-50', icon: 'text-info-600' },
  accent: { wrap: 'bg-accent-50', icon: 'text-accent-600' },
};

function InfoCard({ item, onOpen }: { item: InfoItem; onOpen: () => void }) {
  const Icon = INFO_ICON[item.icon];
  const tone = INFO_TONE[item.tone];
  const tappable = !!item.href;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!tappable}
      className={`w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 ${tappable ? 'active:scale-[0.99] transition-transform' : ''}`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tone.wrap}`}>
        <Icon size={17} className={tone.icon} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">{item.title}</p>
        <p className="text-[11.5px] text-ink-500 mt-0.5 truncate">{item.body}</p>
      </div>
      {tappable && <ChevronRight size={15} className="text-ink-300 shrink-0" />}
    </button>
  );
}

function SettlementCard({
  request, tab, busy, contactName, onAccept, onReject, onCancel,
}: {
  request: SettlementRequest;
  tab: Tab;
  busy: boolean;
  contactName: string;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isPending = request.status === 'pending';
  const title = (tab === 'outgoing' ? t('stl_card_outgoing') : t('stl_card_incoming')).replace(
    '{name}', contactName,
  );

  const statusKey = (`stl_status_${request.status}`) as
    | 'stl_status_pending' | 'stl_status_accepted' | 'stl_status_rejected' | 'stl_status_cancelled';
  const statusClasses = {
    pending:   'bg-warn-50 text-warn-600',
    accepted:  'bg-receive-50 text-receive-text',
    rejected:  'bg-cream-soft text-ink-500',
    cancelled: 'bg-cream-soft text-ink-500',
  }[request.status];

  return (
    <div className={`rounded-[18px] bg-cream-card p-4 ${isPending ? 'border-2 border-accent-100' : 'border border-cream-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900 tracking-tight">{title}</p>
          <p className="text-[18px] font-semibold text-ink-900 tabular-nums mt-1 tracking-tight">
            {formatMoney(request.amount, request.currency)}
          </p>
          <p className="text-[10.5px] text-ink-500 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
          </p>
          {request.note ? (
            <p className="text-[11px] text-ink-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] rounded-full px-2.5 py-1 ${statusClasses}`}>
          {t(statusKey)}
        </span>
      </div>

      {isPending ? (
        <>
          <p className="text-[11px] text-accent-600 bg-accent-50 rounded-xl p-2.5 mt-3 leading-relaxed">
            {t('stl_ledger_only_hint')}
          </p>
          <div className="flex gap-2 mt-2">
            {tab === 'incoming' ? (
              <>
                <button
                  onClick={onReject}
                  disabled={busy}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
                >
                  {busy ? t('ltr_rejecting') : t('ltr_reject')}
                </button>
                <button
                  onClick={onAccept}
                  disabled={busy}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold active:scale-[0.98] transition-transform disabled:opacity-50"
                >
                  {busy ? t('ltr_accepting') : t('ltr_accept')}
                </button>
              </>
            ) : (
              <button
                onClick={onCancel}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
              >
                {busy ? t('ltr_cancelling') : t('ltr_cancel')}
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RequestCard({
  request, tab, busy, contactName, onAccept, onReject, onCancel,
}: {
  request: LinkedRequest;
  tab: Tab;
  busy: boolean;
  contactName: string;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isPending = request.status === 'pending';
  const amountText = formatMoney(request.amount, request.currency);
  const isIncoming = tab === 'incoming';

  let title: string;
  if (tab === 'outgoing') {
    title = request.kind === 'lent'
      ? t('ltr_card_lent').replace('{name}', contactName)
      : t('ltr_card_borrowed').replace('{name}', contactName);
  } else {
    title = request.kind === 'lent'
      ? t('ltr_card_incoming_lent').replace('{name}', contactName)
      : t('ltr_card_incoming_borrowed').replace('{name}', contactName);
  }

  // Incoming: fold the amount and the resulting stance into one sentence so
  // the user reads "what this means for me" without doing the mental math.
  // lent → they lent you → you'd owe them (pay-text). borrowed → they borrowed
  // from you → they'd owe you (receive-text).
  const stanceClause = isIncoming
    ? request.kind === 'lent'
      ? t('inbox_card_incoming_lent_full').replace('{name}', contactName)
      : t('inbox_card_incoming_borrowed_full').replace('{name}', contactName)
    : null;
  const stanceColor = request.kind === 'lent' ? 'text-pay-text' : 'text-receive-text';

  const statusKey = (`ltr_status_${request.status}`) as
    | 'ltr_status_pending' | 'ltr_status_accepted' | 'ltr_status_rejected' | 'ltr_status_cancelled';
  const statusClasses = {
    pending:   'bg-warn-50 text-warn-600',
    accepted:  'bg-receive-50 text-receive-text',
    rejected:  'bg-cream-soft text-ink-500',
    cancelled: 'bg-cream-soft text-ink-500',
  }[request.status];

  return (
    <div className={`rounded-[18px] bg-cream-card p-4 ${isPending ? 'border-2 border-warn-50' : 'border border-cream-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[13px] font-medium text-ink-900 tracking-tight">
              {isIncoming ? (
                <>
                  {title} <span className="font-semibold tabular-nums">{amountText}</span>
                  {stanceClause && (
                    <>
                      {' '}
                      <span className="text-ink-400">— </span>
                      <span className={`font-semibold ${stanceColor}`}>{stanceClause}</span>
                    </>
                  )}
                </>
              ) : (
                title
              )}
            </p>
            {/* Phase 2D: marks a "sync past record" request so the recipient
                sees this is historical, not a fresh-loan announcement. Same
                accept/decline flow underneath. */}
            {request.preExistingLoanId && (
              <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] rounded-full bg-accent-100 text-accent-600 px-1.5 py-0.5 shrink-0">
                past record
              </span>
            )}
          </div>
          {!isIncoming && (
            <p className="text-[18px] font-semibold text-ink-900 tabular-nums mt-1 tracking-tight">
              {amountText}
            </p>
          )}
          <p className="text-[10.5px] text-ink-500 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
          </p>
          {request.note ? (
            <p className="text-[11px] text-ink-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
          {request.rejectionReason ? (
            <p className="text-[11px] text-ink-500 mt-1.5">{request.rejectionReason}</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] rounded-full px-2.5 py-1 ${statusClasses}`}>
          {t(statusKey)}
        </span>
      </div>

      {isPending ? (
        <div className="flex gap-2 mt-3">
          {tab === 'incoming' ? (
            <>
              <button
                onClick={onReject}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
              >
                {busy ? t('ltr_rejecting') : t('ltr_reject')}
              </button>
              <button
                onClick={onAccept}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold active:scale-[0.98] transition-transform disabled:opacity-50"
              >
                {busy ? t('ltr_accepting') : t('ltr_accept')}
              </button>
            </>
          ) : (
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
            >
              {busy ? t('ltr_cancelling') : t('ltr_cancel')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
