import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { PageHeader } from '../components/PageHeader';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { usePersonStore } from '../stores/personStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { LinkedRequest } from '../db';

type Tab = 'incoming' | 'outgoing';

export function InboxPage() {
  const user = useSupabaseAuthStore((s) => s.user);
  const { requests, loadRequests, accept, reject, cancel } = useLinkedRequestStore();
  const persons = usePersonStore((s) => s.persons);
  const toast = useToast();
  const t = useT();

  const [tab, setTab] = useState<Tab>('incoming');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void loadRequests();
    const onFocus = () => { void loadRequests(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRequests]);

  const myId = user?.id ?? '';

  const visible = useMemo(() => {
    return requests
      .filter((r) => (tab === 'incoming' ? r.toUserId === myId : r.fromUserId === myId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [requests, tab, myId]);

  const incomingPendingCount = useMemo(
    () => requests.filter((r) => r.status === 'pending' && r.toUserId === myId).length,
    [requests, myId],
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
            {visible.map((r) => (
              <RequestCard
                key={r.id}
                request={r}
                tab={tab}
                busy={busyId === r.id}
                contactName={contactNameFor(r)}
                onAccept={() => handleAccept(r.id)}
                onReject={() => handleReject(r.id)}
                onCancel={() => handleCancel(r.id)}
              />
            ))}
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
