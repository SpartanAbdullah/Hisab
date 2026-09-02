import { describe, it, expect } from 'vitest';
import {
  BLOCK_REASON_MAX,
  REPORT_DETAILS_MAX,
  blockOutcomeFromError,
  hideBlockedSenders,
  isBlockedByMe,
  normalizeFreeText,
  pgErrorCode,
  reportOutcomeFromError,
  witnessInitials,
  witnessLinkState,
} from './blockStatus';

describe('normalizeFreeText', () => {
  it('trims, empties to null, and caps at the server limit', () => {
    expect(normalizeFreeText('  hello  ', 50)).toBe('hello');
    expect(normalizeFreeText('   ', 50)).toBeNull();
    expect(normalizeFreeText(null, 50)).toBeNull();
    expect(normalizeFreeText(undefined, 50)).toBeNull();
    expect(normalizeFreeText('x'.repeat(600), BLOCK_REASON_MAX)).toHaveLength(500);
    expect(normalizeFreeText('y'.repeat(3000), REPORT_DETAILS_MAX)).toHaveLength(2000);
  });
});

describe('pgErrorCode', () => {
  it('reads the PostgREST error code when present', () => {
    expect(pgErrorCode({ code: '53400' })).toBe('53400');
    expect(pgErrorCode(new Error('boom'))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode({ code: 42 })).toBeNull();
  });
});

describe('blockOutcomeFromError', () => {
  it('treats a repeat block as success, not failure', () => {
    // The PK is (blocker_id, blocked_id) — blocking twice is idempotent and the
    // user must never see an error for it.
    expect(blockOutcomeFromError({ code: '23505' })).toBe('ALREADY_BLOCKED');
    expect(blockOutcomeFromError({ message: 'duplicate key value violates…' })).toBe('ALREADY_BLOCKED');
  });
  it('maps the self-block CHECK', () => {
    expect(blockOutcomeFromError({ code: '23514' })).toBe('SELF');
    expect(blockOutcomeFromError({ message: 'violates check constraint "blocks_not_self"' })).toBe('SELF');
  });
  it('is ok on no error and FAILED otherwise', () => {
    expect(blockOutcomeFromError(null)).toBe('ok');
    expect(blockOutcomeFromError(undefined)).toBe('ok');
    expect(blockOutcomeFromError({ code: '08006' })).toBe('FAILED');
  });
});

describe('reportOutcomeFromError', () => {
  it('maps the 20/day cap to a calm outcome', () => {
    expect(reportOutcomeFromError({ code: '53400' })).toBe('RATE_LIMITED');
    expect(reportOutcomeFromError({ message: 'reports: REPORT_RATE_LIMITED' })).toBe('RATE_LIMITED');
  });
  it('maps self-report and reporter spoofing', () => {
    expect(reportOutcomeFromError({ code: '22023' })).toBe('SELF');
    expect(reportOutcomeFromError({ code: '42501' })).toBe('NOT_ALLOWED');
  });
  it('is ok on no error', () => {
    expect(reportOutcomeFromError(null)).toBe('ok');
    expect(reportOutcomeFromError({ code: 'PGRST301' })).toBe('FAILED');
  });
});

describe('isBlockedByMe', () => {
  it('accepts a Set or an array and never answers for a missing id', () => {
    expect(isBlockedByMe(new Set(['a']), 'a')).toBe(true);
    expect(isBlockedByMe(['a', 'b'], 'b')).toBe(true);
    expect(isBlockedByMe(['a'], 'z')).toBe(false);
    expect(isBlockedByMe(['a'], null)).toBe(false);
    expect(isBlockedByMe(['a'], undefined)).toBe(false);
    expect(isBlockedByMe([], 'a')).toBe(false);
  });
});

describe('hideBlockedSenders', () => {
  const rows = [
    { id: '1', from: 'harasser' },
    { id: '2', from: 'friend' },
    { id: '3', from: null as string | null },
  ];

  it('drops only items sent by someone I blocked', () => {
    const kept = hideBlockedSenders(rows, ['harasser'], (r) => r.from);
    expect(kept.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('returns a copy untouched when nothing is blocked', () => {
    const kept = hideBlockedSenders(rows, [], (r) => r.from);
    expect(kept).toEqual(rows);
    expect(kept).not.toBe(rows);
  });

  it('is fully reversible — unblocking restores the rows (RULE 3)', () => {
    const blocked = new Set(['harasser']);
    expect(hideBlockedSenders(rows, blocked, (r) => r.from)).toHaveLength(2);
    blocked.delete('harasser');
    expect(hideBlockedSenders(rows, blocked, (r) => r.from)).toHaveLength(3);
  });
});

describe('witnessInitials', () => {
  it('matches public.witness_initials', () => {
    expect(witnessInitials('Ali Raza')).toBe('A.R.');
    expect(witnessInitials('Ali')).toBe('A.');
    expect(witnessInitials('  ali   raza  khan ')).toBe('A.R.');
    expect(witnessInitials('')).toBe('—');
    expect(witnessInitials(null)).toBe('—');
    expect(witnessInitials(undefined)).toBe('—');
  });
});

describe('witnessLinkState', () => {
  const now = new Date('2026-09-02T00:00:00.000Z');

  it('reports none when a token was never minted', () => {
    expect(witnessLinkState({}, now)).toBe('none');
    expect(witnessLinkState({ expiresAt: null, revokedAt: null }, now)).toBe('none');
  });

  it('reports active inside the 90-day window', () => {
    expect(witnessLinkState({ expiresAt: '2026-12-01T00:00:00.000Z' }, now)).toBe('active');
  });

  it('reports expired past the window', () => {
    expect(witnessLinkState({ expiresAt: '2026-08-01T00:00:00.000Z' }, now)).toBe('expired');
  });

  it('revocation wins over an unexpired clock', () => {
    expect(
      witnessLinkState({ expiresAt: '2026-12-01T00:00:00.000Z', revokedAt: '2026-09-01T00:00:00.000Z' }, now),
    ).toBe('revoked');
  });

  it('treats an unparseable timestamp as no link rather than an active one', () => {
    expect(witnessLinkState({ expiresAt: 'not-a-date' }, now)).toBe('none');
  });
});
