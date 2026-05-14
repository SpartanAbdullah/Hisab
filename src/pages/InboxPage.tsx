import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { usePersonStore } from '../stores/personStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { LinkedRequest, SettlementRequest } from '../db';

type Tab = 'incoming' | 'outgoing';

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
  const toast = useToast();
  const t = useT();

  const [tab, setTab] = useState<Tab>('incoming');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void loadRequests();
    void loadSettlements();
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

  const handleAccept = async (id: string) => {
    setBusyId(id);
    try {
      await accept(id);
    } catch {
      toast.show({ type: 'error', title: t('ltr_accept_error') });
    } finally {
      setBusyId(null);
    }
  };
  const handleReject = async (id: string) => {
    setBusyId(id);
    try {
      await reject(id);
    } catch {
      toast.show({ type: 'error', title: t('ltr_reject_error') });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancel = async (id: string) => {
    setBusyId(id);
    try {
      await cancel(id);
    } catch {
      toast.show({ type: 'error', title: t('ltr_cancel_error') });
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptSettlement = async (id: string) => {
    setBusyId(id);
    try {
      await acceptSettlement(id);
    } catch {
      toast.show({ type: 'error', title: t('stl_accept_error') });
    } finally {
      setBusyId(null);
    }
  };
  const handleRejectSettlement = async (id: string) => {
    setBusyId(id);
    try {
      await rejectSettlement(id);
    } catch {
      toast.show({ type: 'error', title: t('stl_reject_error') });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancelSettlement = async (id: string) => {
    setBusyId(id);
    try {
      await cancelSettlement(id);
    } catch {
      toast.show({ type: 'error', title: t('stl_cancel_error') });
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
          action={
            <div className="flex items-center gap-2">
              <PillToggle
                tab={tab}
                setTab={setTab}
                incomingCount={incomingPendingCount}
                outgoingCount={outgoingPendingCount}
                incomingLabel={t('ltr_tab_incoming')}
                outgoingLabel={t('ltr_tab_outgoing')}
              />
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-white text-[16px] font-medium leading-snug max-w-[300px]">
            {tab === 'incoming' ? t('ltr_incoming_hint') : t('ltr_outgoing_hint')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {visible.length === 0 ? (
          <p className="text-[13px] text-ink-400 text-center py-10">
            {tab === 'incoming' ? t('ltr_empty_incoming') : t('ltr_empty_outgoing')}
          </p>
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

function PillToggle({
  tab,
  setTab,
  incomingCount,
  outgoingCount,
  incomingLabel,
  outgoingLabel,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  incomingCount: number;
  outgoingCount: number;
  incomingLabel: string;
  outgoingLabel: string;
}) {
  const Pill = ({ value, label, count }: { value: Tab; label: string; count: number }) => {
    const isActive = tab === value;
    return (
      <button
        onClick={() => setTab(value)}
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
  };
  return (
    <div className="bg-white/10 rounded-full p-0.5 flex items-center">
      <Pill value="incoming" label={incomingLabel} count={incomingCount} />
      <Pill value="outgoing" label={outgoingLabel} count={outgoingCount} />
    </div>
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
                  className="flex-1 py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
                >
                  {busy ? t('ltr_rejecting') : t('ltr_reject')}
                </button>
                <button
                  onClick={onAccept}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold active:scale-[0.98] transition-transform disabled:opacity-50"
                >
                  {busy ? t('ltr_accepting') : t('ltr_accept')}
                </button>
              </>
            ) : (
              <button
                onClick={onCancel}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
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
                className="flex-1 py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
              >
                {busy ? t('ltr_rejecting') : t('ltr_reject')}
              </button>
              <button
                onClick={onAccept}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold active:scale-[0.98] transition-transform disabled:opacity-50"
              >
                {busy ? t('ltr_accepting') : t('ltr_accept')}
              </button>
            </>
          ) : (
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
            >
              {busy ? t('ltr_cancelling') : t('ltr_cancel')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
