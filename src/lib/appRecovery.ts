export const STALE_APP_CHUNK_EVENT = 'hisaab:stale-app-chunk-error';

export interface AppErrorPresentation {
  kind: 'stale-chunk' | 'generic';
  title: string;
  message: string;
  actionLabel: string;
  secondaryText?: string;
}

interface RecoveryDependencies {
  cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'>;
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistration'>;
  reload?: () => void;
}

const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk(?:\s+\d+)? failed/i,
  /chunkloaderror/i,
  /\/assets\/[^\s"'?]+\.js(?:[?\s"']|$)/i,
];

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === 'object') {
    const maybeError = error as { message?: unknown; reason?: unknown };
    if (typeof maybeError.message === 'string') return maybeError.message;
    if (maybeError.reason) return errorText(maybeError.reason);
  }
  return '';
}

export function isStaleChunkLoadError(error: unknown): boolean {
  const text = errorText(error);
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(text));
}

export function getAppErrorPresentation(error: unknown): AppErrorPresentation {
  if (isStaleChunkLoadError(error)) {
    return {
      kind: 'stale-chunk',
      title: 'App update available',
      message: 'Hisaab was updated while you were away. Refresh the app to continue safely.',
      actionLabel: 'Refresh app',
      secondaryText: 'Your saved data is safe.',
    };
  }

  return {
    kind: 'generic',
    title: 'Something went wrong',
    message: 'Please try again. If the issue continues, contact support.',
    actionLabel: 'Try again',
  };
}

export async function recoverFromStaleApp(dependencies: RecoveryDependencies = {}): Promise<void> {
  const cacheStorage = dependencies.cacheStorage ?? (typeof caches === 'undefined' ? undefined : caches);
  const serviceWorker = dependencies.serviceWorker ??
    (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker);
  const reload = dependencies.reload ??
    (() => {
      window.location.reload();
    });

  try {
    if (cacheStorage) {
      const cacheNames = await cacheStorage.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith('hisaab-'))
          .map((name) => cacheStorage.delete(name)),
      );
    }

    const registration = await serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    // A reload still gives the browser a chance to fetch the current shell.
  } finally {
    reload();
  }
}

export function notifyStaleChunkLoadError(error: unknown): void {
  if (typeof window === 'undefined' || !isStaleChunkLoadError(error)) return;
  window.dispatchEvent(new CustomEvent(STALE_APP_CHUNK_EVENT));
}
