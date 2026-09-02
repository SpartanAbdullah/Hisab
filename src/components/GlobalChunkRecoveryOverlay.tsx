import { useEffect, useState } from 'react';
import { PageErrorState } from './PageErrorState';
import { recoverFromStaleApp, STALE_APP_CHUNK_EVENT } from '../lib/appRecovery';
import { useT } from '../lib/i18n';

export function GlobalChunkRecoveryOverlay() {
  const t = useT();
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
        title={t('gcr_update_available')}
        message={t('gcr_update_body')}
        secondaryText={t('gcr_data_safe')}
        actionLabel={t('gcr_refresh_cta')}
        onRetry={() => void recoverFromStaleApp()}
      />
    </div>
  );
}
