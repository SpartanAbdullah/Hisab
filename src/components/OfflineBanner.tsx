import { CloudOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

// Small pill that floats below the top safe-area when the device is
// offline. Phase 3 scaffold — the banner does not yet differentiate
// "captive portal" vs "true offline" vs "Supabase reachability." It
// reads `navigator.onLine` only. The outboxRunner will later signal
// real reachability via a separate hook.
export function OfflineBanner() {
  const { online } = useOnlineStatus();
  if (online) return null;
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50 pt-safe w-full max-w-[480px] flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-1 rounded-full bg-ink-900/95 text-white text-[11px] font-semibold px-3 py-1.5 flex items-center gap-1.5 shadow-lg">
        <CloudOff size={11} strokeWidth={2.4} />
        <span>Offline · reconnect to save changes</span>
      </div>
    </div>
  );
}
