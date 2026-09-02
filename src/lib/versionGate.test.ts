import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isSupported,
  updateMessageFor,
  type AppVersionConfig,
  type AppVersionIdentity,
} from './versionGate';

// Every ambiguous case in this gate must resolve to "allowed". A false lockout
// hits 100% of users at once and can only be undone from Supabase Studio, so
// the tests below assert fail-open at least as hard as they assert blocking.

function config(over: Partial<AppVersionConfig> = {}): AppVersionConfig {
  return {
    minSupportedVersion: '1.0.0',
    minSupportedVersionCode: 1,
    messageEn: null,
    messageUr: null,
    ...over,
  };
}

const web = (current: string): AppVersionIdentity => ({ current, currentCode: null });
const native = (current: string, currentCode: number | null): AppVersionIdentity => ({
  current,
  currentCode,
});

describe('compareSemver', () => {
  it('reports equality', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('compares segments numerically, not lexically (1.10 > 1.9)', () => {
    // The classic bug: '1.10.0' < '1.9.0' as strings, which would lock out the
    // NEWEST build the moment the minor version reaches double digits.
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('10.0.0', '9.99.99')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.1')).toBeLessThan(0);
  });

  it('ignores segments beyond patch', () => {
    expect(compareSemver('1.2.3.4', '1.2.3')).toBe(0);
  });

  it('tolerates a leading v', () => {
    expect(compareSemver('v1.4.0', '1.4.0')).toBe(0);
    expect(compareSemver('V2.0.0', 'v1.0.0')).toBeGreaterThan(0);
  });

  it('drops pre-release and build metadata rather than ordering it', () => {
    // Deliberate: dropping fails open (a beta counts as its release), whereas
    // ordering pre-releases below releases would block internal test builds.
    expect(compareSemver('1.4.0-beta.1', '1.4.0')).toBe(0);
    expect(compareSemver('1.4.0+abc123', '1.4.0')).toBe(0);
    expect(compareSemver('1.5.0-rc1', '1.4.0')).toBeGreaterThan(0);
  });

  it('reads junk segments as zero instead of NaN', () => {
    expect(compareSemver('abc', '0.0.0')).toBe(0);
    expect(compareSemver('1.x.3', '1.0.3')).toBe(0);
    expect(compareSemver('', '0.0.0')).toBe(0);
  });

  it('handles zero-padded segments', () => {
    expect(compareSemver('1.02.0', '1.2.0')).toBe(0);
  });
});

describe('isSupported — missing/unusable config fails open', () => {
  it('allows when there is no config at all (fetch failed, offline)', () => {
    expect(isSupported(web('1.0.0'), null)).toBe(true);
    expect(isSupported(web('1.0.0'), undefined)).toBe(true);
  });

  it('allows when the row exists but the floors are null (migration not seeded)', () => {
    const c = config({ minSupportedVersion: null, minSupportedVersionCode: null });
    expect(isSupported(web('0.1.0'), c)).toBe(true);
    expect(isSupported(native('0.1.0', 1), c)).toBe(true);
  });

  it('allows when the floor string is not a comparable version', () => {
    expect(isSupported(web('1.0.0'), config({ minSupportedVersion: 'latest' }))).toBe(true);
    expect(isSupported(web('1.0.0'), config({ minSupportedVersion: '' }))).toBe(true);
  });

  it('allows when the running version itself is unreadable', () => {
    expect(isSupported(web('unknown'), config({ minSupportedVersion: '9.9.9' }))).toBe(true);
  });

  it('allows when the version-code floor is NaN', () => {
    const c = config({ minSupportedVersionCode: Number.NaN, minSupportedVersion: null });
    expect(isSupported(native('1.0.0', 1), c)).toBe(true);
  });
});

describe('isSupported — web compares semver', () => {
  it('allows an exact match on the floor', () => {
    expect(isSupported(web('1.4.0'), config({ minSupportedVersion: '1.4.0' }))).toBe(true);
  });

  it('allows anything above the floor', () => {
    expect(isSupported(web('1.4.1'), config({ minSupportedVersion: '1.4.0' }))).toBe(true);
    expect(isSupported(web('2.0.0'), config({ minSupportedVersion: '1.4.0' }))).toBe(true);
  });

  it('blocks anything below the floor', () => {
    expect(isSupported(web('1.3.9'), config({ minSupportedVersion: '1.4.0' }))).toBe(false);
    expect(isSupported(web('1.0.0'), config({ minSupportedVersion: '1.4.0' }))).toBe(false);
  });

  it('ignores the version-code floor entirely on web', () => {
    // A web client has no build number; a raised Android floor must never
    // block the PWA, which is always the freshest surface.
    const c = config({ minSupportedVersion: '1.0.0', minSupportedVersionCode: 999 });
    expect(isSupported(web('1.0.0'), c)).toBe(true);
  });

  it('is not fooled by a double-digit minor floor', () => {
    expect(isSupported(web('1.10.0'), config({ minSupportedVersion: '1.9.0' }))).toBe(true);
  });
});

describe('isSupported — native compares versionCode', () => {
  it('allows an exact match on the code floor', () => {
    expect(isSupported(native('1.0.0', 12), config({ minSupportedVersionCode: 12 }))).toBe(true);
  });

  it('allows a higher code', () => {
    expect(isSupported(native('1.0.0', 13), config({ minSupportedVersionCode: 12 }))).toBe(true);
  });

  it('blocks a lower code', () => {
    expect(isSupported(native('1.0.0', 11), config({ minSupportedVersionCode: 12 }))).toBe(false);
  });

  it('prefers versionCode over semver when both are available', () => {
    // The real Android case: a hotfix ships versionCode 13 with the SAME
    // versionName 1.4.0. The code says supported; the semver would too, but
    // the reverse case is what matters —
    const passes = config({ minSupportedVersion: '9.9.9', minSupportedVersionCode: 12 });
    expect(isSupported(native('1.4.0', 12), passes)).toBe(true);
    // — a stale binary whose versionName was never bumped is caught by the code.
    const blocks = config({ minSupportedVersion: '0.0.1', minSupportedVersionCode: 12 });
    expect(isSupported(native('1.4.0', 11), blocks)).toBe(false);
  });

  it('falls back to semver when getInfo() could not supply a build number', () => {
    const c = config({ minSupportedVersion: '1.4.0', minSupportedVersionCode: 12 });
    expect(isSupported(native('1.4.0', null), c)).toBe(true);
    expect(isSupported(native('1.3.0', null), c)).toBe(false);
  });

  it('treats code 0 as a real value, not a missing one', () => {
    expect(isSupported(native('1.0.0', 0), config({ minSupportedVersionCode: 1 }))).toBe(false);
    expect(isSupported(native('1.0.0', 0), config({ minSupportedVersionCode: 0 }))).toBe(true);
  });
});

describe('isSupported — the seeded day-one config blocks nobody', () => {
  // supabase-migration-p1-app-config.sql seeds 1.0.0 / code 1, matching
  // package.json and android/app/build.gradle at the time of writing.
  const seeded = config({ minSupportedVersion: '1.0.0', minSupportedVersionCode: 1 });

  it('allows the shipped web build', () => {
    expect(isSupported(web('1.0.0'), seeded)).toBe(true);
  });

  it('allows the shipped Android build', () => {
    expect(isSupported(native('1.0.0', 1), seeded)).toBe(true);
  });
});

describe('updateMessageFor', () => {
  it('returns null with no config, so the client uses its own i18n copy', () => {
    expect(updateMessageFor(null, 'ur')).toBeNull();
  });

  it('returns null when both messages are blank', () => {
    expect(updateMessageFor(config({ messageEn: '', messageUr: '   ' }), 'en')).toBeNull();
  });

  it('picks the message for the active language', () => {
    const c = config({ messageEn: 'Please update', messageUr: 'Update karein' });
    expect(updateMessageFor(c, 'ur')).toBe('Update karein');
    expect(updateMessageFor(c, 'en')).toBe('Please update');
  });

  it('falls back to the other language rather than showing nothing', () => {
    const onlyEn = config({ messageEn: 'Please update', messageUr: null });
    expect(updateMessageFor(onlyEn, 'ur')).toBe('Please update');
    const onlyUr = config({ messageEn: null, messageUr: 'Update karein' });
    expect(updateMessageFor(onlyUr, 'en')).toBe('Update karein');
  });

  it('trims surrounding whitespace from a hand-typed Studio value', () => {
    expect(updateMessageFor(config({ messageEn: '  Update now  ' }), 'en')).toBe('Update now');
  });
});
