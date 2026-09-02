import { describe, it, expect } from 'vitest';
import {
  groupPreviewMessageKey,
  parseGroupPreviewResponse,
  previewIsSoftFailure,
  previewStatusFromThrown,
} from './groupPreview';

const okPayload = {
  status: 'ok',
  name: 'Dubai Trip',
  emoji: '🏝️',
  member_count: 4,
  currency: 'AED',
  owner_display_name: 'Ahmed',
  is_archived: false,
};

describe('parseGroupPreviewResponse', () => {
  it('maps a successful preview into camelCase', () => {
    const result = parseGroupPreviewResponse(okPayload);
    expect(result).toEqual({
      status: 'ok',
      preview: {
        name: 'Dubai Trip',
        emoji: '🏝️',
        memberCount: 4,
        currency: 'AED',
        ownerDisplayName: 'Ahmed',
        isArchived: false,
      },
    });
  });

  it('accepts a single-row array payload', () => {
    expect(parseGroupPreviewResponse([okPayload])).toMatchObject({ status: 'ok' });
  });

  it('keeps the preview on an archived group so the user knows WHICH group', () => {
    const result = parseGroupPreviewResponse({
      ...okPayload,
      status: 'GROUP_ARCHIVED',
      is_archived: true,
    });
    expect(result.status).toBe('GROUP_ARCHIVED');
    expect(result).toHaveProperty('preview');
    if (!('preview' in result)) return;
    expect(result.preview.isArchived).toBe(true);
    expect(result.preview.name).toBe('Dubai Trip');
  });

  it('degrades an archived payload with no name to a plain failure', () => {
    const result = parseGroupPreviewResponse({ status: 'GROUP_ARCHIVED' });
    expect(result).toEqual({ status: 'GROUP_ARCHIVED' });
  });

  it.each([
    'INVALID_CODE',
    'INVALID_OR_EXPIRED_CODE',
    'RATE_LIMITED',
    'CANNOT_JOIN_OWN_GROUP',
    'NOT_AUTHENTICATED',
  ])('passes %s through unchanged', (status) => {
    expect(parseGroupPreviewResponse({ status })).toEqual({ status });
  });

  it('never claims success without a name — a blind confirm is the bug', () => {
    expect(parseGroupPreviewResponse({ status: 'ok' })).toEqual({ status: 'UNKNOWN' });
    expect(parseGroupPreviewResponse({ status: 'ok', name: '   ' })).toEqual({ status: 'UNKNOWN' });
  });

  it('coerces a hostile / sloppy member_count instead of rendering NaN', () => {
    const cases: Array<[unknown, number]> = [
      ['7', 7], [-3, 0], [null, 0], [undefined, 0], [{}, 0], [2.9, 2],
    ];
    for (const [raw, expected] of cases) {
      const result = parseGroupPreviewResponse({ ...okPayload, member_count: raw });
      expect(result).toHaveProperty('preview');
      if (!('preview' in result)) continue;
      expect(result.preview.memberCount).toBe(expected);
    }
  });

  it('falls back to a generic owner label rather than showing nothing', () => {
    const result = parseGroupPreviewResponse({ ...okPayload, owner_display_name: '  ' });
    expect(result).toHaveProperty('preview');
    if (!('preview' in result)) return;
    expect(result.preview.ownerDisplayName).toBe('Hisaab user');
  });

  it.each([
    [null, 'INVALID_OR_EXPIRED_CODE'],
    [undefined, 'INVALID_OR_EXPIRED_CODE'],
    [[], 'INVALID_OR_EXPIRED_CODE'],
    ['a string', 'UNKNOWN'],
    [42, 'UNKNOWN'],
    [{}, 'UNKNOWN'],
    [{ status: 'WAT' }, 'UNKNOWN'],
  ])('maps garbage %p to %s', (payload, expected) => {
    expect(parseGroupPreviewResponse(payload).status).toBe(expected);
  });
});

describe('previewStatusFromThrown', () => {
  it('detects an un-migrated database from PostgREST', () => {
    expect(previewStatusFromThrown({ code: 'PGRST202', message: 'Could not find the function' }))
      .toBe('UNAVAILABLE');
    expect(previewStatusFromThrown(new Error('function public.preview_group_by_code(text) does not exist')))
      .toBe('UNAVAILABLE');
  });

  it('maps transport failures to NETWORK', () => {
    expect(previewStatusFromThrown(new Error('Failed to fetch'))).toBe('NETWORK');
  });

  it('maps rate limiting and auth', () => {
    expect(previewStatusFromThrown(new Error('RATE_LIMITED'))).toBe('RATE_LIMITED');
    expect(previewStatusFromThrown(new Error('JWT expired'))).toBe('NOT_AUTHENTICATED');
  });

  it('falls back to UNKNOWN for an unreadable error', () => {
    expect(previewStatusFromThrown(null)).toBe('UNKNOWN');
    expect(previewStatusFromThrown({})).toBe('UNKNOWN');
  });
});

describe('previewIsSoftFailure', () => {
  it('never blocks a join for a missing migration or a flaky network', () => {
    expect(previewIsSoftFailure('UNAVAILABLE')).toBe(true);
    expect(previewIsSoftFailure('NETWORK')).toBe(true);
    expect(previewIsSoftFailure('UNKNOWN')).toBe(true);
  });

  it('DOES block for a real answer about the code', () => {
    expect(previewIsSoftFailure('INVALID_OR_EXPIRED_CODE')).toBe(false);
    expect(previewIsSoftFailure('RATE_LIMITED')).toBe(false);
    expect(previewIsSoftFailure('CANNOT_JOIN_OWN_GROUP')).toBe(false);
    expect(previewIsSoftFailure('GROUP_ARCHIVED')).toBe(false);
    expect(previewIsSoftFailure('NOT_AUTHENTICATED')).toBe(false);
  });
});

describe('groupPreviewMessageKey', () => {
  it('reuses the join vocabulary and adds only the archived key', () => {
    expect(groupPreviewMessageKey('GROUP_ARCHIVED')).toBe('join_error_archived');
    expect(groupPreviewMessageKey('INVALID_OR_EXPIRED_CODE')).toBe('join_error_not_found');
    expect(groupPreviewMessageKey('RATE_LIMITED')).toBe('join_error_rate_limited');
    expect(groupPreviewMessageKey('CANNOT_JOIN_OWN_GROUP')).toBe('join_error_own_group');
  });
});
