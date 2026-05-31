import { useEffect, useState } from 'react';
import { PageErrorState } from './PageErrorState';
import { recoverFromStaleApp, STALE_APP_CHUNK_EVENT } from '../lib/appRecovery';

export function GlobalChunkRecoveryOverlay() {
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    const show = () => setShowRecovery(true);
    window.addEventListener(STALE_APP_CHUNK_EVENT, show);
    return () => window.removeEventListener(STALE_APP_CHUNK_EVENT, show);
  }, []);

  if (!showRecovery) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <PageErrorState
        title="App update available"
        message="Hisaab was updated while you were away. Refresh the app to continue safely."
        secondaryText="Your saved data is safe."
        actionLabel="Refresh app"
        onRetry={() => void recoverFromStaleApp()}
      />
    </div>
  );
}
