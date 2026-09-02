import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Audit 03-performance M2: the single `profiles` row was read 3-4× on every
// cold boot (deleted-account gate → twice, onboarding check, App hydration).
// These tests pin the collapse to ONE request, and the invalidation rules that
// keep the memo from ever masking a write.

const single = vi.fn();
const eq = vi.fn(() => ({ single }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock('./supabase', () => ({ supabase: { from: (...args: unknown[]) => from(...(args as [])) } }));

const { getCachedProfile, invalidateProfileCache } = await import('./profileCache');

const USER = 'user-1';

beforeEach(() => {
  from.mockClear();
  select.mockClear();
  eq.mockClear();
  single.mockReset();
  single.mockResolvedValue({ data: { id: USER, name: 'Ali', is_deleted: false }, error: null });
  invalidateProfileCache();
});

afterEach(() => {
  invalidateProfileCache();
});

describe('getCachedProfile', () => {
  it('issues ONE request for concurrent callers (the boot burst)', async () => {
    const [a, b, c] = await Promise.all([
      getCachedProfile(USER),
      getCachedProfile(USER),
      getCachedProfile(USER),
    ]);
    expect(from).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toMatchObject({ name: 'Ali' });
  });

  it('serves a sequential caller from the memo inside the freshness window', async () => {
    await getCachedProfile(USER);
    const again = await getCachedProfile(USER);
    expect(from).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ name: 'Ali' });
  });

  it('re-fetches after invalidation (a profile write must never be masked)', async () => {
    await getCachedProfile(USER);
    invalidateProfileCache();
    single.mockResolvedValue({ data: { id: USER, name: 'Ali Raza' }, error: null });
    const fresh = await getCachedProfile(USER);
    expect(from).toHaveBeenCalledTimes(2);
    expect(fresh).toMatchObject({ name: 'Ali Raza' });
  });

  it('re-fetches for a different user id — never serves the previous account', async () => {
    await getCachedProfile(USER);
    single.mockResolvedValue({ data: { id: 'user-2', name: 'Sara' }, error: null });
    const other = await getCachedProfile('user-2');
    expect(from).toHaveBeenCalledTimes(2);
    expect(other).toMatchObject({ name: 'Sara' });
  });

  it('force bypasses both the memo and any in-flight read', async () => {
    await getCachedProfile(USER);
    await getCachedProfile(USER, { force: true });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('resolves to null on a PostgREST error — the gates fail open as before', async () => {
    single.mockResolvedValue({ data: null, error: { message: 'no row' } });
    await expect(getCachedProfile(USER)).resolves.toBeNull();
  });

  it('resolves to null (never rejects) when the request throws', async () => {
    single.mockRejectedValue(new Error('offline'));
    await expect(getCachedProfile(USER)).resolves.toBeNull();
  });

  it('returns null without a request when there is no user id', async () => {
    await expect(getCachedProfile('')).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
