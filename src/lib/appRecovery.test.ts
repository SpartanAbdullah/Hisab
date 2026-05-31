import { describe, expect, it, vi } from 'vitest';
import {
  getAppErrorPresentation,
  isStaleChunkLoadError,
  recoverFromStaleApp,
} from './appRecovery';

describe('stale app chunk recovery', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://www.usehisaab.com/assets/SplitsPage-deadbeef.js',
    'Importing a module script failed.',
    'Loading chunk 12 failed.',
    'ChunkLoadError: Loading chunk settings failed.',
    'GET https://www.usehisaab.com/assets/HomePage-oldhash.js',
  ])('recognises stale deploy failure: %s', (message) => {
    expect(isStaleChunkLoadError(new Error(message))).toBe(true);
  });

  it('maps a dynamic import failure to friendly update copy without leaking its URL', () => {
    const rawUrl = 'https://www.usehisaab.com/assets/SplitsPage-deadbeef.js';
    const presentation = getAppErrorPresentation(
      new Error(`Failed to fetch dynamically imported module: ${rawUrl}`),
    );

    expect(presentation.title).toBe('App update available');
    expect(presentation.actionLabel).toBe('Refresh app');
    expect(JSON.stringify(presentation)).not.toContain(rawUrl);
  });

  it('keeps ordinary failures generic', () => {
    expect(getAppErrorPresentation(new Error('database unavailable'))).toEqual({
      kind: 'generic',
      title: 'Something went wrong',
      message: 'Please try again. If the issue continues, contact support.',
      actionLabel: 'Try again',
    });
  });

  it('clears Hisaab app caches, updates the service worker, and reloads', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();

    await recoverFromStaleApp({
      cacheStorage: {
        keys: vi.fn().mockResolvedValue(['hisaab-v3', 'unrelated-cache']),
        delete: deleteCache,
      },
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update }),
      },
      reload,
    });

    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith('hisaab-v3');
    expect(update).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
