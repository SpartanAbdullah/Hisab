import { useState } from 'react';
import { Clock, BellRing, X, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { SettlementNudge } from '../lib/settlementNudges';
import { snoozeNudge } from '../lib/settlementNudges';
import { formatMoney } from '../lib/constants';

interface Props {
  nudges: SettlementNudge[];
}

// Surfaces only on HomePage. Renders nothing when the list is empty so the
// hosting page doesn't need a conditional wrapper. Tapping "Open in Inbox"
// navigates to /inbox where the user can act on the request properly;
// "Send WhatsApp" opens wa.me only if the contact has a phone on file.
// "Dismiss" snoozes the nudge for 24h.
export function SettlementNudgeBanner({ nudges }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const visible = nudges.filter((n) => !dismissed.has(n.request.id));
  if (visible.length === 0) return null;

  const handleDismiss = (id: string) => {
    snoozeNudge(id);
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="rounded-2xl bg-warn-50 border border-warn-50 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-warn-50/80">
        <BellRing size={14} className="text-warn-600" strokeWidth={2.4} />
        <p className="text-[12px] font-semibold text-warn-600 tracking-tight">
          {visible.length === 1
            ? 'Pending settlement waiting'
            : `${visible.length} settlements waiting`}
        </p>
      </div>
      <div className="divide-y divide-warn-50/60">
        {visible.map((nudge) => (
          <div key={nudge.request.id} className="px-4 py-3 flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-warn-50/70 border border-warn-50 flex items-center justify-center shrink-0">
              <Clock size={14} className="text-warn-600" strokeWidth={2.2} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
                {nudge.recipientLabel}
              </p>
              <p className="text-[11px] text-ink-600 mt-0.5">
                {formatMoney(nudge.request.amount, nudge.request.currency)} ·{' '}
                {nudge.daysOpen}d ago
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button
                  onClick={() => navigate('/inbox')}
                  className="text-[11px] font-semibold text-white bg-ink-900 rounded-lg px-2.5 py-1 active:scale-95 transition-transform"
                >
                  Open in Inbox
                </button>
                {nudge.whatsappUrl && (
                  <a
                    href={nudge.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-semibold text-receive-text bg-receive-50 rounded-lg px-2.5 py-1 active:scale-95 transition-transform flex items-center gap-1"
                  >
                    <MessageCircle size={11} strokeWidth={2.4} />
                    WhatsApp
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => handleDismiss(nudge.request.id)}
              aria-label="Snooze for 24 hours"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-500 active:bg-warn-50/60 transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
