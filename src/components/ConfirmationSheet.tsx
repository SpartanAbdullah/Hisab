import { CheckCircle, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatSignedMoney } from '../lib/constants';
import { Button } from './Button';
import { CelebrationMark } from './CelebrationMark';
import { Icon3D } from './Icon3D';
import { CLAY_ICONS } from '../lib/clayIcons.generated';
import { clayIconSrc, clayIconSrcSet, normalizeClayIconRegistry, resolveClayIcon } from '../lib/clay';
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
  /**
   * This save CLOSED a debt — a repayment that cleared the loan, or a lump
   * that cleared at least one. The header swaps the wallet for the
   * CelebrationMark and its confetti: the founder-approved "settle-up burst"
   * (2026-09-05), reserved for exactly this moment so it stays a moment.
   */
  settled?: boolean;
}

// Auto-dismiss window. Long enough to read the before→after balance, and it
// pauses entirely while the user is touching/hovering the sheet.
const AUTO_DISMISS_MS = 6000;

// Normalised once at module scope, exactly as Icon3D does. The registry is a
// build-time constant, so whether the coin exists at all is decided once.
const REGISTRY = normalizeClayIconRegistry(CLAY_ICONS);
// The coin drop needs BOTH clay assets. Either one missing → the ordinary
// tick, never a coin falling into an empty box or a broken-image glyph
// (Icon3D already renders nothing for an unknown name; this check is what
// keeps the two halves of the animation together).
const COIN = resolveClayIcon('wallet', REGISTRY) ? resolveClayIcon('money', REGISTRY) : null;

export function ConfirmationSheet({ open, onClose, title, description, balanceChanges, viewRoute, settled = false }: Props) {
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
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" />
      <div
        className={`relative bg-cream-card w-full max-w-[480px] rounded-t-3xl overflow-hidden transition-transform duration-400 shadow-2xl ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        role="presentation"
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
            {/* The mark. Every open of this sheet IS a saved money entry, in
                both app modes (Quick Entry, record payment, record trade), so
                the coin drop is unconditional: a coin falls into the wallet
                and the wallet catches it — "money moved", which a tick cannot
                say (index.css MOTION SYSTEM: .animate-coin-drop and
                .animate-wallet-catch, 1.4s once per open). When the entry
                closed a debt, the wallet gives way to the CelebrationMark and
                its confetti burst instead.

                Headroom for the coin's 46px fall: the disc sits 32px (py-8)
                below the sheet's clipped top edge, the 36px stage 10px inside
                the disc, and the coin's rest position 12px (top-3) inside the
                stage — so the 0% frame starts 8px below the clip and the whole
                arc is seen. It sinks into the wallet's lower half at
                translateY(6px). The mark's ring and the top-most confetti do
                reach past the clip; they are fading by then. */}
            {settled ? (
              <div className="flex justify-center mb-4">
                <CelebrationMark size={56} />
              </div>
            ) : (
              <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4 animate-bounce-in">
                {COIN ? (
                  <span className="relative flex w-9 h-9 shrink-0" aria-hidden="true">
                    <Icon3D name="wallet" size="sm" className="animate-wallet-catch" />
                    <img
                      src={clayIconSrc(COIN)}
                      srcSet={clayIconSrcSet(COIN)}
                      width={20}
                      height={20}
                      alt=""
                      aria-hidden="true"
                      decoding="async"
                      className="animate-coin-drop absolute left-2 top-3 w-5 h-5 opacity-0"
                    />
                  </span>
                ) : (
                  <CheckCircle size={30} strokeWidth={1.5} />
                )}
              </div>
            )}
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
