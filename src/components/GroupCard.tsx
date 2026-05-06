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
  onClick: () => void;
}

// One row in the Groups list. Balance chip colour encodes direction so a
// user can skim the list and see "who I owe / who owes me" without reading.
// Skeleton shimmer when the balance hasn't loaded — prevents the misleading
// "All settled" flash users saw on first paint before the batched balance
// query resolved.
export function GroupCard({ group, balance, balanceLoaded, settledLabel, membersLabel, hasUnreadActivity, onClick }: Props) {
  const connected = group.members.filter(m => m.status === 'connected').length;

  return (
    <button
      onClick={onClick}
      className="w-full card-premium p-4 flex items-center gap-3.5 text-left active:scale-[0.98] transition-all"
    >
      <div className="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center text-xl shrink-0">
        {group.emoji}
        <span
          className={`absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white ${
            hasUnreadActivity ? 'bg-rose-500' : 'bg-emerald-500'
          }`}
          aria-label={hasUnreadActivity ? 'Unread group activity' : 'No unread group activity'}
        />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-bold text-slate-800 truncate tracking-tight">{group.name}</p>
        <p className="text-[11px] text-slate-400 mt-0.5">
          {connected} / {group.members.length} {membersLabel}
        </p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <div className="text-right">
          {!balanceLoaded ? (
            <div className="h-3.5 w-16 rounded-full bg-slate-100 animate-pulse" />
          ) : balance > 0.01 ? (
            <>
              <p className="text-[12px] font-bold text-emerald-600 tabular-nums">
                +{formatMoney(balance, group.currency)}
              </p>
              <p className="text-[9px] text-emerald-600/70 font-semibold tracking-wide">YOU'RE OWED</p>
            </>
          ) : balance < -0.01 ? (
            <>
              <p className="text-[12px] font-bold text-rose-500 tabular-nums">
                -{formatMoney(Math.abs(balance), group.currency)}
              </p>
              <p className="text-[9px] text-rose-500/70 font-semibold tracking-wide">YOU OWE</p>
            </>
          ) : (
            <p className="text-[11px] text-slate-400 font-medium">{settledLabel}</p>
          )}
        </div>
        <ChevronRight size={14} className="text-slate-300" />
      </div>
    </button>
  );
}
