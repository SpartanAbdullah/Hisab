import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { isInboxInfoNotification } from '../lib/inboxInfo';
import { countIncomingPending } from '../lib/notificationCounts';

interface InboxActionProps {
  tone?: 'on-navy' | 'on-cream';
  className?: string;
}

export function InboxAction({ tone = 'on-navy', className = '' }: InboxActionProps) {
  const navigate = useNavigate();
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  // N-7: only requests waiting on THIS user to decide light the bell — a
  // request the user themselves sent is Outgoing-tab material, not attention.
  const linkedPending = useLinkedRequestStore((s) => countIncomingPending(s.requests, userId));
  const settlementPending = useSettlementRequestStore((s) => countIncomingPending(s.requests, userId));
  // Unread informational pings (e.g. "someone added you via your code") also
  // light up the bell so the user knows to open the Inbox.
  const unreadInfoNotifs = useNotificationStore(
    (s) => s.notifications.filter(isInboxInfoNotification).length,
  );
  // "X added you — add them back?" asks. These need a decision, so they
  // belong in the same count as the request approvals.
  const contactAsks = useContactLinkStore(
    (s) => s.requests.filter((r) => r.toUserId === userId && r.status === 'pending').length,
  );
  const pendingApprovalCount = linkedPending + settlementPending + unreadInfoNotifs + contactAsks;
  const hasUnread = pendingApprovalCount > 0;

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
      aria-label={hasUnread ? `Inbox, ${pendingApprovalCount} pending` : 'Inbox'}
    >
      {/* Halo pulses out from under the button. Purely decorative and
          pointer-transparent so it can never eat the tap. */}
      {hasUnread && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-xl bg-pay-600/40 animate-bell-halo pointer-events-none"
        />
      )}
      <Bell
        size={16}
        className={`${iconClass} relative ${hasUnread ? 'animate-bell-ring' : ''}`}
      />
      {hasUnread && (
        <span
          role="status"
          aria-live="polite"
          className={`absolute -top-1 -right-1 min-w-[14px] h-3.5 px-1 rounded-full bg-pay-600 text-white text-[9px] font-bold flex items-center justify-center ring-2 ${badgeRingClass} tabular-nums animate-bell-badge`}
        >
          {pendingApprovalCount > 9 ? '9+' : pendingApprovalCount}
        </span>
      )}
    </button>
  );
}
