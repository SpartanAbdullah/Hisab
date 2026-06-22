import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { isInboxInfoNotification } from '../lib/inboxInfo';

interface InboxActionProps {
  tone?: 'on-navy' | 'on-cream';
  className?: string;
}

export function InboxAction({ tone = 'on-navy', className = '' }: InboxActionProps) {
  const navigate = useNavigate();
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const linkedPending = useLinkedRequestStore(
    (s) =>
      s.requests.filter(
        (r) =>
          r.status === 'pending' &&
          (r.toUserId === userId || r.fromUserId === userId),
      ).length,
  );
  const settlementPending = useSettlementRequestStore(
    (s) =>
      s.requests.filter(
        (r) =>
          r.status === 'pending' &&
          (r.toUserId === userId || r.fromUserId === userId),
      ).length,
  );
  // Unread informational pings (e.g. "someone added you via your code") also
  // light up the bell so the user knows to open the Inbox.
  const unreadInfoNotifs = useNotificationStore(
    (s) => s.notifications.filter(isInboxInfoNotification).length,
  );
  const pendingApprovalCount = linkedPending + settlementPending + unreadInfoNotifs;

  const isOnNavy = tone === 'on-navy';
  const buttonClass = isOnNavy
    ? 'bg-white/10 active:bg-white/15'
    : 'bg-slate-100/80 active:bg-slate-200';
  const iconClass = isOnNavy ? 'text-white' : 'text-ink-600';
  const badgeRingClass = isOnNavy ? 'ring-navy-800' : 'ring-white';

  return (
    <button
      onClick={() => navigate('/inbox')}
      className={`relative w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors before:absolute before:-inset-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 ${buttonClass} ${className}`}
      aria-label={pendingApprovalCount > 0 ? `Inbox, ${pendingApprovalCount} pending` : 'Inbox'}
    >
      <Bell size={16} className={iconClass} />
      {pendingApprovalCount > 0 && (
        <span
          role="status"
          aria-live="polite"
          className={`absolute -top-1 -right-1 min-w-[14px] h-3.5 px-1 rounded-full bg-pay-600 text-white text-[9px] font-bold flex items-center justify-center ring-2 ${badgeRingClass} tabular-nums`}
        >
          {pendingApprovalCount > 9 ? '9+' : pendingApprovalCount}
        </span>
      )}
    </button>
  );
}
