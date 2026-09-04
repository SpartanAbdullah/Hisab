import { useMemo } from 'react';
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { countBellItems } from '../lib/notificationCounts';
import { useT } from '../lib/i18n';

interface InboxActionProps {
  tone?: 'on-navy' | 'on-cream';
  className?: string;
}

export function InboxAction({ tone = 'on-navy', className = '' }: InboxActionProps) {
  const navigate = useNavigate();
  const t = useT();
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  // Every input the badge has, assembled by ONE pure function
  // (notificationCounts.countBellItems) so the rule lives in a tested place
  // instead of being re-derived inline here. Selecting the arrays rather than
  // a number keeps the subscriptions reference-stable between loads.
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const contactLinkRequests = useContactLinkStore((s) => s.requests);
  const notifications = useNotificationStore((s) => s.notifications);
  const mutes = useNotificationStore((s) => s.mutes);
  const { actionable, waiting } = useMemo(
    () => countBellItems({
      notifications,
      linkedRequests,
      settlementRequests,
      contactLinkRequests,
      userId,
      mutes,
    }),
    [notifications, linkedRequests, settlementRequests, contactLinkRequests, userId, mutes],
  );
  const pendingApprovalCount = actionable;
  const hasUnread = actionable > 0;
  // Nothing needs the user, but they ARE waiting on someone else (their own
  // outgoing requests). A red animated number would be the exact anxiety audit
  // N-7 removed; silence was what took the founder's bell dark. So: a small
  // neutral dot, no number, no animation — "there's something in there",
  // nothing more. The number always wins when both exist.
  const showWaitingDot = !hasUnread && waiting > 0;

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
      aria-label={
        hasUnread
          ? t('a11y_inbox_pending').replace('{n}', String(pendingApprovalCount))
          : showWaitingDot
            ? t('a11y_inbox_waiting').replace('{n}', String(waiting))
            : t('a11y_inbox')
      }
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
      {/* Waiting-on-others: a dot, deliberately not the pay-600 red of the
          attention badge and deliberately not animated. Same corner, so it
          reads as "the bell has something" without claiming urgency. */}
      {showWaitingDot && (
        <span
          aria-hidden
          className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${
            isOnNavy ? 'bg-white/60' : 'bg-ink-400'
          } ring-2 ${badgeRingClass}`}
        />
      )}
    </button>
  );
}
