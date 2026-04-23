import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { PageHeader } from '../components/PageHeader';
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
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader title={t('ltr_inbox_title')} />

      <div className="px-5 pt-4">
        <div className="flex gap-2 mb-3">
          <TabButton active={tab === 'incoming'} onClick={() => setTab('incoming')}
            label={t('ltr_tab_incoming')} badge={incomingPendingCount} />
          <TabButton active={tab === 'outgoing'} onClick={() => setTab('outgoing')}
            label={t('ltr_tab_outgoing')} />
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed mb-3">
          {tab === 'incoming' ? t('ltr_incoming_hint') : t('ltr_outgoing_hint')}
        </p>

        {visible.length === 0 ? (
          <p className="text-[13px] text-slate-400 text-center py-10">
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
    </div>
  );
}

function TabButton({
  active, onClick, label, badge,
}: { active: boolean; onClick: () => void; label: string; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-2xl text-[12px] font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${
        active ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-100 text-slate-500'
      }`}
    >
      <span>{label}</span>
      {badge && badge > 0 ? (
        <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${active ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-600'}`}>
          {badge}
        </span>
      ) : null}
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
    pending:   'bg-amber-50 text-amber-600',
    accepted:  'bg-emerald-50 text-emerald-600',
    rejected:  'bg-slate-100 text-slate-500',
    cancelled: 'bg-slate-100 text-slate-500',
  }[request.status];

  return (
    <div className="card-premium !rounded-2xl p-4 border-l-4 border-l-indigo-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-slate-800 tracking-tight truncate">{title}</p>
          <p className="text-[17px] font-bold text-slate-800 tabular-nums mt-0.5">
            {formatMoney(request.amount, request.currency)}
          </p>
          <p className="text-[10px] text-slate-400 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
          </p>
          {request.note ? (
            <p className="text-[11px] text-slate-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-widest rounded-full px-2.5 py-1 ${statusClasses}`}>
          {t(statusKey)}
        </span>
      </div>

      {isPending ? (
        <>
          <p className="text-[11px] text-indigo-700 bg-indigo-50/70 rounded-xl p-2.5 mt-3 leading-relaxed">
            {t('stl_ledger_only_hint')}
          </p>
          <div className="flex gap-2 mt-2">
            {tab === 'incoming' ? (
              <>
                <button
                  onClick={onReject}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-500 text-[12px] font-bold active:bg-slate-200 transition-all disabled:opacity-50"
                >
                  {busy ? t('ltr_rejecting') : t('ltr_reject')}
                </button>
                <button
                  onClick={onAccept}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-2xl btn-gradient text-[12px] font-bold shadow-sm shadow-indigo-500/15 disabled:opacity-50"
                >
                  {busy ? t('ltr_accepting') : t('ltr_accept')}
                </button>
              </>
            ) : (
              <button
                onClick={onCancel}
                disabled={busy}
                className="flex-1 py-2.5 rounded-2xl bg-red-50 text-red-500 text-[12px] font-bold active:bg-red-100 transition-all disabled:opacity-50"
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
    pending:   'bg-amber-50 text-amber-600',
    accepted:  'bg-emerald-50 text-emerald-600',
    rejected:  'bg-slate-100 text-slate-500',
    cancelled: 'bg-slate-100 text-slate-500',
  }[request.status];

  return (
    <div className="card-premium !rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-slate-800 tracking-tight truncate">{title}</p>
          <p className="text-[17px] font-bold text-slate-800 tabular-nums mt-0.5">
            {formatMoney(request.amount, request.currency)}
          </p>
          <p className="text-[10px] text-slate-400 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
          </p>
          {request.note ? (
            <p className="text-[11px] text-slate-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
          {request.rejectionReason ? (
            <p className="text-[11px] text-slate-500 mt-1.5">{request.rejectionReason}</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-widest rounded-full px-2.5 py-1 ${statusClasses}`}>
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
                className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-500 text-[12px] font-bold active:bg-slate-200 transition-all disabled:opacity-50"
              >
                {busy ? t('ltr_rejecting') : t('ltr_reject')}
              </button>
              <button
                onClick={onAccept}
                disabled={busy}
                className="flex-1 py-2.5 rounded-2xl btn-gradient text-[12px] font-bold shadow-sm shadow-indigo-500/15 disabled:opacity-50"
              >
                {busy ? t('ltr_accepting') : t('ltr_accept')}
              </button>
            </>
          ) : (
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex-1 py-2.5 rounded-2xl bg-red-50 text-red-500 text-[12px] font-bold active:bg-red-100 transition-all disabled:opacity-50"
            >
              {busy ? t('ltr_cancelling') : t('ltr_cancel')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
