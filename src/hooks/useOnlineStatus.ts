import { useEffect, useState } from 'react';

// Reads navigator.onLine and listens for online/offline events. Returns the
// current connectivity state plus a "since" timestamp so the UI can show
// "Offline for 12 min" if it wants to.
//
// Caveats baked in for years of dealing with this API:
//   - navigator.onLine reports network *layer* state, not real reachability.
//     A device on captive-portal Wi-Fi reports onLine=true while every
//     Supabase request fails. Pair this hook with the outboxRunner's actual
//     fetch failures to decide what to show the user.
//   - Some Android WebViews fire `online` before DNS is fully ready; the
//     runner handles that by retrying with backoff rather than firing on
//     the raw event.

export interface OnlineStatus {
  online: boolean;
  // ISO timestamp of the last connectivity transition. Useful for
  // "offline for X minutes" copy.
  since: string;
}

function readInitial(): OnlineStatus {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  return { online, since: new Date().toISOString() };
}

export function useOnlineStatus(): OnlineStatus {
  const [status, setStatus] = useState<OnlineStatus>(readInitial);

  useEffect(() => {
    const handleOnline = () => setStatus({ online: true, since: new Date().toISOString() });
    const handleOffline = () => setStatus({ online: false, since: new Date().toISOString() });
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return status;
}
