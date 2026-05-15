import { ChevronRight } from 'lucide-react';
import type { SplitGroup } from '../db';
import { formatMoney } from '../lib/constants';

interface Props {
  group: SplitGroup;
  balance: number;
  balanceLoaded: boolean;
  settledLabel: string;
  membersLabel: string;
  hasUnreadActivity: boolean;
  // True when the current user paid for an expense in this group that
  // isn't reconciled yet. Surfaces as a small coral dot next to the state
  // label so the user can scan the list for "what needs my attention"
  // without opening every group.
  hasUnreconciled?: boolean;
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
  onClick,
}: Props) {
  const connected = group.members.filter((m) => m.status === 'connected').length;
  const owed = balance > 0.01;
  const owes = balance < -0.01;

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
      className="w-full rounded-[18px] bg-cream-card border border-cream-border p-4 text-left active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center gap-3">
        <div className="relative w-11 h-11 rounded-2xl bg-cream-soft border border-cream-hairline flex items-center justify-center text-lg shrink-0">
          {group.emoji}
          <span
            className={`absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white ${
              hasUnreadActivity ? 'bg-pay-600' : 'bg-receive-600'
            }`}
            aria-label={hasUnreadActivity ? 'Unread group activity' : 'No unread group activity'}
          />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
            {group.name}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5">
            {connected} / {group.members.length} {membersLabel}
          </p>
        </div>

        <ChevronRight size={14} className="text-ink-300 shrink-0" />
      </div>

      <div className="mt-3 pt-3 border-t border-cream-hairline flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] flex items-center gap-1.5">
          {balanceLoaded ? stateLabel : 'Loading…'}
          {hasUnreconciled && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-pay-600 shrink-0"
              aria-label="You have unreconciled expenses in this group"
              title="You have unreconciled expenses in this group"
            />
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
