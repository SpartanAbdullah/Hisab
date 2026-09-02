import { ChevronRight } from 'lucide-react';
import { VerifiedBadge } from './VerifiedBadge';
import type { SplitGroup } from '../db';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

interface Props {
  group: SplitGroup;
  balance: number;
  balanceLoaded: boolean;
  settledLabel: string;
  membersLabel: string;
  hasUnreadActivity: boolean;
  // True when the current user paid for an expense in this group that
  // isn't reconciled yet. Surfaces as a small hollow ring next to the state
  // label so the user can scan the list for "what needs my attention"
  // without opening every group. Kept visually distinct from the unread
  // activity dot (filled, top-right of the avatar) so the two never blur.
  hasUnreconciled?: boolean;
  // Number of outstanding balances the current user still has to settle in
  // this group (0 = square). Drives the settle-status pill: "Settled" when
  // zero, "{n} to settle" otherwise. Derived from per-group balances on the
  // Splits page so no extra fetch is needed.
  outstandingCount?: number;
  onClick: () => void;
}

// One row in the Groups list (Sukoon screen 07). Balance chip colour encodes
// direction so a user can skim "who I owe / who owes me" without reading.
// The skeleton shimmer prevents a misleading "All settled" flash before the
// batched balance query resolves.
export function GroupCard({
  group,
  balance,
  balanceLoaded,
  settledLabel,
  membersLabel,
  hasUnreadActivity,
  hasUnreconciled,
  outstandingCount,
  onClick,
}: Props) {
  const t = useT();
  const connected = group.members.filter((m) => m.status === 'connected').length;
  const owed = balance > 0.01;
  const owes = balance < -0.01;
  // Archived groups are still fully readable — they just accept nothing new.
  // The tag has to be on the row itself, not only in the section header, so a
  // search result (which is flat) is never ambiguous.
  const isArchived = Boolean(group.archivedAt);

  // Settle-status: prefer an explicit outstandingCount from the parent; fall
  // back to deriving it from this user's net balance (non-zero ⇒ one balance
  // left to settle). Pairs the colour with a dot + word so it isn't
  // colour-only.
  const toSettle = outstandingCount ?? (owed || owes ? 1 : 0);
  const isSquare = toSettle === 0;

  // State copy + colour token mapping. Sukoon's group cards label the state
  // explicitly ("You're owed" / "You owe" / "All settled") rather than
  // relying on the +/− sign alone.
  const stateLabel = owed ? "You're owed" : owes ? 'You owe' : settledLabel;
  const amountColor = owed
    ? 'text-receive-text'
    : owes
    ? 'text-pay-text'
    : 'text-ink-400';

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-[18px] bg-cream-card border border-cream-border p-4 text-left press-lg ${
        isArchived ? 'opacity-75' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="relative w-11 h-11 rounded-2xl bg-cream-soft border border-cream-hairline flex items-center justify-center text-lg shrink-0">
          {group.emoji}
          {/* Unread-activity dot — present ONLY when there's unread activity, so
              its mere presence (not its colour) carries the meaning. */}
          {hasUnreadActivity && (
            <span
              className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white bg-pay-600"
              aria-label="Unread group activity"
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight flex items-center gap-1.5">
            <span className="truncate">{group.name}</span>
            {isArchived && (
              <span className="shrink-0 rounded-full bg-cream-soft border border-cream-hairline px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-ink-500">
                {t('grp_archived_tag')}
              </span>
            )}
            {/* Verified seal: this user is square in the group. */}
            {balanceLoaded && isSquare && <VerifiedBadge size={14} title={t('status_settled')} />}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5">
            {connected} / {group.members.length} {membersLabel}
          </p>
        </div>

        <ChevronRight size={14} className="text-ink-300 shrink-0" />
      </div>

      <div className="mt-3 pt-3 border-t border-cream-hairline flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] flex items-center gap-1.5 min-w-0">
          <span className="truncate">{balanceLoaded ? stateLabel : 'Loading…'}</span>
          {/* Unreconciled marker — a hollow amber ring with a '!' glyph, kept
              visually distinct from the filled unread-activity dot on the
              avatar so the two signals never read as the same thing. */}
          {hasUnreconciled && (
            <span
              className="shrink-0 w-3.5 h-3.5 rounded-full border border-warn-600 text-warn-700 flex items-center justify-center text-[8px] font-bold leading-none"
              aria-label="You have unreconciled expenses in this group"
              title="You have unreconciled expenses in this group"
            >
              !
            </span>
          )}
          {/* Settle-status pill — colour + dot + word, never colour alone. */}
          {balanceLoaded && (
            <span
              className={`shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-[0.02em] ${
                isSquare ? 'bg-receive-50 text-receive-text' : 'bg-warn-50 text-warn-700'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isSquare ? 'bg-receive-600' : 'bg-warn-600'}`} />
              {isSquare ? t('status_settled') : t('group_to_settle').replace('{n}', String(toSettle))}
            </span>
          )}
        </span>
        {!balanceLoaded ? (
          <div className="h-3.5 w-16 rounded-full bg-cream-hairline animate-pulse" />
        ) : owed ? (
          <p className={`text-[14px] font-semibold tabular-nums ${amountColor}`}>
            +{formatMoney(balance, group.currency)}
          </p>
        ) : owes ? (
          <p className={`text-[14px] font-semibold tabular-nums ${amountColor}`}>
            −{formatMoney(Math.abs(balance), group.currency)}
          </p>
        ) : (
          <p className="text-[12px] text-ink-400 font-medium">—</p>
        )}
      </div>
    </button>
  );
}
