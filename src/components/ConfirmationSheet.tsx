import { CheckCircle, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatSignedMoney } from '../lib/constants';
import { Button } from './Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

interface BalanceChange {
  accountName: string;
  currency: string;
  before: number;
  after: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  balanceChanges: BalanceChange[];
  // Optional deep-link to the record this confirmation is about (e.g.
  // `/loan/123` or `/transactions/abc`). When present, a secondary "View"
  // button appears next to Done; when omitted the button is gracefully hidden.
  viewRoute?: string;
}

// Auto-dismiss window. Long enough to read the before→after balance, and it
// pauses entirely while the user is touching/hovering the sheet.
const AUTO_DISMISS_MS = 6000;

export function ConfirmationSheet({ open, onClose, title, description, balanceChanges, viewRoute }: Props) {
  const [show, setShow] = useState(false);
  const t = useT();
  const navigate = useNavigate();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // (Re)start the auto-dismiss countdown from the full duration. Called on
  // open and whenever the pointer leaves the sheet after a pause.
  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(onClose, AUTO_DISMISS_MS);
  }, [clearTimer, onClose]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => setShow(true));
      startTimer();
      return clearTimer;
    } else {
      // Animation flag sync — legitimate setState-in-effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(false);
    }
  }, [open, startTimer, clearTimer]);

  if (!open) return null;

  const handleView = () => {
    if (!viewRoute) return;
    clearTimer();
    onClose();
    navigate(viewRoute);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" />
      <div
        className={`relative bg-white w-full max-w-[480px] rounded-t-3xl overflow-hidden transition-transform duration-400 shadow-2xl ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        onClick={(e) => e.stopPropagation()}
        // Pause the auto-dismiss while the user is reading / interacting, so
        // the before→after balance stays on screen as long as they want.
        onMouseEnter={clearTimer}
        onMouseLeave={startTimer}
        onTouchStart={clearTimer}
        onTouchEnd={startTimer}
      >
        {/* Success header */}
        <div className="relative overflow-hidden px-6 py-8 text-center text-white">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-600" />
          <div className="absolute inset-0 opacity-30" style={{ background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.2), transparent 50%)' }} />
          <div className="relative">
            <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4 animate-bounce-in">
              <CheckCircle size={30} strokeWidth={1.5} />
            </div>
            <p className="font-bold text-lg tracking-tight">{title}</p>
            <p className="text-sm opacity-80 mt-1">{description}</p>
          </div>
        </div>

        {/* Balance changes */}
        {balanceChanges.length > 0 && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('balance_changes')}</p>
            {balanceChanges.map((change, i) => (
              <div key={i} className="flex items-center gap-3 bg-cream-soft/80 rounded-2xl p-4 border border-cream-hairline">
                <div className="flex-1 text-center">
                  <p className="text-[10px] text-ink-500 font-medium">{change.accountName}</p>
                  <p className="text-sm font-bold text-ink-500 line-through mt-1">
                    {formatSignedMoney(change.before, change.currency)}
                  </p>
                </div>
                <div className="w-8 h-8 rounded-full bg-accent-100 flex items-center justify-center shrink-0">
                  <ArrowRight size={14} className="text-accent-600" />
                </div>
                <div className="flex-1 text-center">
                  <p className="text-[10px] text-ink-500 font-medium">{t('updated')}</p>
                  <p className={`text-sm font-bold mt-1 ${change.after >= change.before ? 'text-receive-text' : 'text-pay-text'}`}>
                    {formatSignedMoney(change.after, change.currency)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="px-6 pb-8 pt-2 space-y-2">
          <Button variant="gradient" size="lg" onClick={onClose}>
            {t('done_btn')}
          </Button>
          {viewRoute && (
            <button
              onClick={handleView}
              className="w-full min-h-[44px] text-center text-[13px] font-semibold text-accent-600 active:text-accent-700 transition-colors"
            >
              {t('action_view')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
