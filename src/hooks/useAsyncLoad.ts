import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncLoadResult {
  status: AsyncStatus;
  error: string | null;
  retry: () => void;
}

// Async-data hook with a friendly error message and a retry function.
//
// Pass a memoised loader (useCallback) or a stable module-level function —
// the effect re-runs whenever `load` changes identity. If the loader throws,
// `status` flips to 'error' and `error` holds a display-ready message.
//
// Cancels in-flight results on unmount so a late-returning request can't
// overwrite state on an unmounted or re-mounted component.
export function useAsyncLoad(load: () => Promise<void>): AsyncLoadResult {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const run = useCallback(() => {
    const token = ++generation.current;
    setStatus('loading');
    setError(null);
    void load()
      .then(() => {
        if (token !== generation.current) return;
        setStatus('ready');
      })
      .catch((err) => {
        if (token !== generation.current) return;
        console.error('[useAsyncLoad]', err);
        setError(friendlyMessage(err));
        setStatus('error');
      });
  }, [load]);

  useEffect(() => {
    run();
    return () => {
      generation.current += 1;
    };
  }, [run]);

  return { status, error, retry: run };
}

function friendlyMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    const raw = err.message;
    if (/network|failed to fetch|load failed/i.test(raw)) {
      return 'Network issue. Check your connection and try again.';
    }
    return raw;
  }
  return 'Something went wrong while loading. Try again in a moment.';
}
