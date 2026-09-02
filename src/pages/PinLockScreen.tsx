import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useT } from '../lib/i18n';
import { PIN_FREE_ATTEMPTS } from '../lib/pinCrypto';

// After this many wrong attempts the store imposes an escalating, PERSISTED
// lockout (30s, then doubling to a 15-minute cap — see lib/pinCrypto). We
// surface "{n} tries left" once the user has slipped at least once, counting
// down to this ceiling.
const MAX_ATTEMPTS = PIN_FREE_ATTEMPTS;

export function PinLockScreen() {
  const t = useT();
  const { verifyPin, lockedUntil, failedAttempts, removePin } = useAuthStore();
  const { signOut } = useSupabaseAuthStore();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [recovering, setRecovering] = useState(false);
  // PBKDF2 at 150k rounds takes ~100-300ms on a mid-range phone. Without this
  // guard a fast tapper can queue several verifications, each burning an
  // attempt against the (now persisted) lockout counter.
  const [checking, setChecking] = useState(false);
  // Tick `now` every second so the lock screen auto-releases when the
  // lockout window passes. Reading Date.now() in render directly would
  // violate React's purity rule and never refresh anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lockedUntil === null || lockedUntil <= now) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [lockedUntil, now]);

  const isTimeLocked = lockedUntil !== null && now < lockedUntil;
  const secondsLeft = isTimeLocked ? Math.ceil(((lockedUntil as number) - now) / 1000) : 0;
  // The escalating schedule reaches 15 minutes, and "Try again in 900s" reads
  // like a bug. Switch to m+s past a minute.
  const lockoutLabel = secondsLeft >= 60
    ? t('pin_try_again_long')
        .replace('{m}', String(Math.floor(secondsLeft / 60)))
        .replace('{s}', String(secondsLeft % 60))
    : t('pin_try_again').replace('{s}', String(secondsLeft));
  // Show "{n} tries left" only after the first wrong attempt and before the
  // hard lockout kicks in.
  const triesLeft = MAX_ATTEMPTS - failedAttempts;
  const showTriesLeft = !isTimeLocked && failedAttempts > 0 && triesLeft > 0;

  // Recovery: there's no PIN reset by design (the PIN guards a re-auth gate).
  // Signing out drops the local PIN guard and returns to the auth screen, where
  // the user re-authenticates; we also clear the local PIN so the next session
  // starts clean.
  const handleForgotPin = async () => {
    setRecovering(true);
    try {
      removePin();
      await signOut();
      window.location.reload();
    } catch {
      setRecovering(false);
    }
  };

  const handleDigit = (d: string) => {
    if (isTimeLocked || checking) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) {
      setChecking(true);
      setTimeout(() => {
        void (async () => {
          try {
            const ok = await verifyPin(next);
            // On success the app shell swaps this screen out; nothing to do.
            if (!ok) {
              setPin('');
              setError(t('pin_wrong'));
              setShake(true);
              setTimeout(() => setShake(false), 500);
            }
          } finally {
            setChecking(false);
          }
        })();
      }, 100);
    }
  };

  const handleDelete = () => {
    if (checking) return;
    setPin(pin.slice(0, -1));
    setError('');
  };

  const dots = Array.from({ length: 4 }, (_, i) => i < pin.length);

  return (
    <div className="min-h-dvh bg-gradient-to-b from-indigo-600 via-indigo-700 to-indigo-900 flex flex-col items-center justify-center px-8">
      <div className="w-16 h-16 rounded-3xl bg-white/10 flex items-center justify-center mb-6">
        <Lock size={28} className="text-white/80" />
      </div>

      <h1 className="text-xl font-bold text-white mb-1">{t('pin_title')}</h1>
      <p className="text-sm text-white/60 mb-8">{t('pin_subtitle')}</p>

      {/* PIN dots */}
      <div className={`flex gap-4 mb-8 ${shake ? 'animate-shake' : ''}`}>
        {dots.map((filled, i) => (
          <div key={i} className={`w-4 h-4 rounded-full transition-all duration-200 ${filled ? 'bg-white scale-110' : 'bg-white/20'}`} />
        ))}
      </div>

      {/* Status — wrong PIN, live lockout countdown, or remaining tries. None
          is colour-only: each pairs the tint with explicit words. */}
      <div className="min-h-[40px] flex flex-col items-center justify-center mb-2">
        {error && !isTimeLocked && (
          <p className="text-red-200 text-sm font-medium animate-fade-in">{error}</p>
        )}
        {isTimeLocked && (
          <>
            <p className="text-amber-200 text-sm font-semibold tabular-nums" aria-live="polite">
              {lockoutLabel}
            </p>
            <p className="text-white/45 text-[11px] font-medium mt-1">{t('pin_locked_note')}</p>
          </>
        )}
        {showTriesLeft && (
          <p className="text-amber-200 text-[12px] font-medium mt-1">
            {triesLeft === 1
              ? t('pin_tries_left_one')
              : t('pin_tries_left').replace('{n}', String(triesLeft))}
          </p>
        )}
      </div>

      {/* Numpad — keys are 56px tall (>=44px touch target). */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[260px]">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map(key => (
          <button key={key} disabled={!key || isTimeLocked || checking}
            onClick={() => key === '⌫' ? handleDelete() : handleDigit(key)}
            className={`h-14 min-h-[44px] rounded-2xl text-xl font-bold transition-all ${
              !key ? 'invisible' : 'bg-white/10 text-white active:bg-white/20 active:scale-95 disabled:opacity-40'
            }`}>
            {key}
          </button>
        ))}
      </div>

      {/* Forgot PIN — recovery is sign-out + re-auth, then the PIN is cleared. */}
      <button
        onClick={() => setShowForgot((v) => !v)}
        className="text-white/55 text-[12px] font-medium mt-6 min-h-[44px] px-4 active:text-white/80 transition-colors"
      >
        {t('pin_forgot')}
      </button>
      {showForgot && (
        <div className="w-full max-w-[300px] mt-1 rounded-2xl bg-white/10 border border-white/15 p-4 text-center animate-fade-in">
          <p className="text-white/75 text-[12px] leading-relaxed">
            {t('pin_recovery')}
          </p>
          <button
            onClick={handleForgotPin}
            disabled={recovering}
            className="mt-3 w-full min-h-[44px] rounded-xl bg-white text-indigo-700 text-[13px] font-bold disabled:opacity-50 press"
          >
            {recovering ? t('pin_signing_out') : t('pin_signout_reset')}
          </button>
        </div>
      )}
    </div>
  );
}
