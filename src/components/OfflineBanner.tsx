import { CloudOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useT } from '../lib/i18n';

// Small pill that floats below the top safe-area when the device is
// offline. It reads `navigator.onLine` only and does not differentiate
// "captive portal" vs "true offline" vs "Supabase reachability." Hisaab is
// online-required for writes — there is no offline write queue (decision D5,
// 2026-09-04, docs/offline-story.md) — so this pill plus the `err_offline`
// copy on a failed save are the whole offline story: say so, block the save,
// let the user retry once reconnected.
export function OfflineBanner() {
  const t = useT();
  const { online } = useOnlineStatus();
  if (online) return null;
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50 pt-safe w-full max-w-[480px] flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-1 rounded-full bg-ink-900/95 text-white text-[11px] font-semibold px-3 py-1.5 flex items-center gap-1.5 shadow-lg">
        <CloudOff size={11} strokeWidth={2.4} />
        <span>{t('offline_banner')}</span>
      </div>
    </div>
  );
}
