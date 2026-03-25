import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useT } from '../lib/i18n';

export function PinLockScreen() {
  const t = useT();
  const { verifyPin, failedAttempts, lockedUntil } = useAuthStore();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);

  const isTimeLocked = lockedUntil !== null && Date.now() < lockedUntil;

  const handleDigit = (d: string) => {
    if (isTimeLocked) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) {
      setTimeout(async () => {
        const ok = await verifyPin(next);
        if (!ok) {
          setPin('');
          setError(t('pin_wrong'));
          setShake(true);
          setTimeout(() => setShake(false), 500);
        }
      }, 100);
    }
  };

  const handleDelete = () => { setPin(pin.slice(0, -1)); setError(''); };

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

      {/* Error */}
      {error && <p className="text-red-300 text-sm font-medium mb-4 animate-fade-in">{error}</p>}
      {isTimeLocked && <p className="text-amber-300 text-sm font-medium mb-4">{t('pin_locked')}</p>}

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[260px]">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map(key => (
          <button key={key} disabled={!key || isTimeLocked}
            onClick={() => key === '⌫' ? handleDelete() : handleDigit(key)}
            className={`h-14 rounded-2xl text-xl font-bold transition-all ${
              !key ? 'invisible' : 'bg-white/10 text-white active:bg-white/20 active:scale-95'
            }`}>
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
