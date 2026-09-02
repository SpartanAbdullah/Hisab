import { describe, it, expect } from 'vitest';
import {
  parseLinkByCodeResponse,
  parseUnlinkResponse,
  linkStatusFromThrown,
  linkStatusMessageKey,
  isMissingFunctionError,
  isLinkRpcRequiredError,
  retryAfterMinutes,
  formatLinkError,
} from './contactLinkStatus';

describe('parseLinkByCodeResponse', () => {
  it('reads a pending success', () => {
    expect(
      parseLinkByCodeResponse({
        status: 'ok',
        profile_id: 'p-1',
        display_name: 'Ali',
        link_state: 'pending',
      }),
    ).toEqual({ status: 'ok', profileId: 'p-1', displayName: 'Ali', linkState: 'pending' });
  });

  it('reads a mutual success', () => {
    const result = parseLinkByCodeResponse({
      status: 'ok',
      profile_id: 'p-2',
      display_name: 'Sara',
      link_state: 'mutual',
    });
    expect(result).toEqual({ status: 'ok', profileId: 'p-2', displayName: 'Sara', linkState: 'mutual' });
  });

  it('fails closed to pending for an unknown link_state', () => {
    const result = parseLinkByCodeResponse({ status: 'ok', profile_id: 'p', display_name: 'X', link_state: 'ACCEPTED' });
    expect(result).toMatchObject({ linkState: 'pending' });
  });

  it('falls back to a neutral display name', () => {
    expect(parseLinkByCodeResponse({ status: 'ok', profile_id: 'p', display_name: '   ' })).toMatchObject({
      displayName: 'Hisaab user',
    });
  });

  it('unwraps an array-shaped payload', () => {
    expect(parseLinkByCodeResponse([{ status: 'NO_MATCH' }])).toEqual({ status: 'NO_MATCH' });
  });

  it.each([
    'NOT_AUTHENTICATED',
    'INVALID_CODE',
    'CONTACT_NOT_FOUND',
    'CONTACT_ARCHIVED',
    'CONTACT_ALREADY_LINKED',
    'NO_MATCH',
    'CANNOT_LINK_SELF',
    'DUPLICATE_LINKED_CONTACT',
  ])('passes through %s', (status) => {
    expect(parseLinkByCodeResponse({ status })).toEqual({ status });
  });

  it('carries retry_after_seconds on RATE_LIMITED', () => {
    expect(parseLinkByCodeResponse({ status: 'RATE_LIMITED', retry_after_seconds: 3600 })).toEqual({
      status: 'RATE_LIMITED',
      retryAfterSeconds: 3600,
    });
  });

  it('treats a success row with no profile_id as unknown', () => {
    expect(parseLinkByCodeResponse({ status: 'ok' })).toEqual({ status: 'UNKNOWN' });
  });

  it.each([null, undefined, 42, 'ok', {}, []])('handles garbage payload %p', (payload) => {
    expect(parseLinkByCodeResponse(payload)).toEqual({ status: 'UNKNOWN' });
  });

  it('maps an unrecognised status to UNKNOWN', () => {
    expect(parseLinkByCodeResponse({ status: 'SOMETHING_NEW' })).toEqual({ status: 'UNKNOWN' });
  });
});

describe('parseUnlinkResponse', () => {
  it('reads a real unlink', () => {
    expect(parseUnlinkResponse({ status: 'ok', was_linked: true, unlinked_profile_id: 'p-9' })).toEqual({
      status: 'ok',
      wasLinked: true,
      unlinkedProfileId: 'p-9',
    });
  });

  it('reads a no-op unlink', () => {
    expect(parseUnlinkResponse({ status: 'ok', was_linked: false, unlinked_profile_id: null })).toEqual({
      status: 'ok',
      wasLinked: false,
      unlinkedProfileId: null,
    });
  });

  it('passes failures through', () => {
    expect(parseUnlinkResponse({ status: 'CONTACT_NOT_FOUND' })).toEqual({ status: 'CONTACT_NOT_FOUND' });
  });
});

describe('isMissingFunctionError', () => {
  it('detects PostgREST schema-cache misses (migration not applied yet)', () => {
    expect(isMissingFunctionError({ code: 'PGRST202', message: 'Could not find the function public.link_contact_by_code' })).toBe(true);
    expect(isMissingFunctionError({ message: 'Could not find the function public.link_contact_by_code(p_code_normalized, p_person_id) in the schema cache' })).toBe(true);
  });

  it('does not fire on ordinary failures', () => {
    expect(isMissingFunctionError({ code: '42501', message: 'LINK_RPC_REQUIRED: ...' })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});

describe('isLinkRpcRequiredError', () => {
  it('detects the consent-guard trigger', () => {
    expect(isLinkRpcRequiredError({ code: '42501', message: 'LINK_RPC_REQUIRED: a contact link can only be created through link_contact_by_code' })).toBe(true);
  });

  it('detects it by message alone (code stripped by the transport)', () => {
    expect(isLinkRpcRequiredError({ message: 'LINK_RPC_REQUIRED: nope' })).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isLinkRpcRequiredError({ code: '23505' })).toBe(false);
    expect(isLinkRpcRequiredError(undefined)).toBe(false);
  });
});

describe('linkStatusFromThrown', () => {
  it('maps the trigger error', () => {
    expect(linkStatusFromThrown({ code: '42501', message: 'LINK_RPC_REQUIRED' })).toBe('LINK_RPC_REQUIRED');
  });

  it('maps the legacy unique violation', () => {
    expect(linkStatusFromThrown({ code: '23505', message: 'duplicate key value' })).toBe('DUPLICATE_LINKED_CONTACT');
  });

  it('maps transport failures', () => {
    expect(linkStatusFromThrown(new Error('Failed to fetch'))).toBe('NETWORK');
  });

  it('falls back to UNKNOWN', () => {
    expect(linkStatusFromThrown(new Error('boom'))).toBe('UNKNOWN');
    expect(linkStatusFromThrown(null)).toBe('UNKNOWN');
  });
});

// link_contact_by_discovery answers with the same keys and the same status
// vocabulary as link_contact_by_code, so the parser must not need to know which
// RPC it is reading. These pin that.
describe('parseLinkByCodeResponse (link_contact_by_discovery payloads)', () => {
  it('reads a discovery success', () => {
    expect(
      parseLinkByCodeResponse({
        status: 'ok',
        profile_id: 'b-uuid',
        display_name: 'Bilal',
        link_state: 'mutual',
      }),
    ).toEqual({ status: 'ok', profileId: 'b-uuid', displayName: 'Bilal', linkState: 'mutual' });
  });

  it.each([
    'NOT_AUTHENTICATED',
    'CONTACT_NOT_FOUND',
    'CONTACT_ARCHIVED',
    'CONTACT_ALREADY_LINKED',
    'CANNOT_LINK_SELF',
    'NO_MATCH',
    'DUPLICATE_LINKED_CONTACT',
  ])('passes through the discovery status %s', (status) => {
    expect(parseLinkByCodeResponse({ status })).toEqual({ status });
  });

  it('carries the phone-window retry hint', () => {
    expect(parseLinkByCodeResponse({ status: 'RATE_LIMITED', retry_after_seconds: 3600 })).toEqual({
      status: 'RATE_LIMITED',
      retryAfterSeconds: 3600,
    });
  });

  it('never invents INVALID_CODE for a code-less path', () => {
    // The discovery RPC has no code to reject; a null profile id comes back as
    // NO_MATCH, which is what the copy is written for.
    expect(parseLinkByCodeResponse({ status: 'NO_MATCH' })).toEqual({ status: 'NO_MATCH' });
  });
});

describe('linkStatusMessageKey', () => {
  const statuses = [
    'NOT_AUTHENTICATED',
    'INVALID_CODE',
    'CONTACT_NOT_FOUND',
    'CONTACT_ARCHIVED',
    'CONTACT_ALREADY_LINKED',
    'NO_MATCH',
    'CANNOT_LINK_SELF',
    'DUPLICATE_LINKED_CONTACT',
    'RATE_LIMITED',
    'LINK_RPC_REQUIRED',
    'NETWORK',
    'UNKNOWN',
  ] as const;

  it('has a key for every failure status', () => {
    for (const status of statuses) {
      expect(linkStatusMessageKey(status)).toBeTruthy();
    }
  });

  it('has a key for every failure status on the discovery path too', () => {
    for (const status of statuses) {
      expect(linkStatusMessageKey(status, 'discovery')).toBeTruthy();
    }
  });

  it('defaults to the code path', () => {
    expect(linkStatusMessageKey('NO_MATCH')).toBe('clink_err_no_match');
  });

  it('swaps the two statuses whose code copy would be a lie', () => {
    expect(linkStatusMessageKey('NO_MATCH', 'discovery')).toBe('clink_err_discovery_no_match');
    expect(linkStatusMessageKey('RATE_LIMITED', 'discovery')).toBe('clink_err_discovery_rate_limited');
  });

  it('leaves every other status alone on the discovery path', () => {
    for (const status of statuses) {
      if (status === 'NO_MATCH' || status === 'RATE_LIMITED') continue;
      expect(linkStatusMessageKey(status, 'discovery')).toBe(linkStatusMessageKey(status));
    }
  });
});

describe('formatLinkError', () => {
  const translate = (key: string) => `<${key}>`;

  it('uses the carried status', () => {
    expect(formatLinkError({ status: 'NO_MATCH' }, translate as never)).toBe('<clink_err_no_match>');
  });

  it('substitutes the retry window', () => {
    const t = (key: string) => (key === 'clink_err_rate_limited' ? 'Try again in {minutes} minutes.' : key);
    expect(formatLinkError({ status: 'RATE_LIMITED', retryAfterSeconds: 3600 }, t as never)).toBe(
      'Try again in 60 minutes.',
    );
  });

  it('falls back to probing a raw transport error', () => {
    expect(formatLinkError(new Error('Failed to fetch'), translate as never)).toBe('<clink_err_network>');
  });

  it('is never blank for an unrecognised failure', () => {
    expect(formatLinkError({ status: 'WAT' }, translate as never)).toBe('<clink_err_unknown>');
  });

  it('uses discovery copy when told which path failed', () => {
    expect(formatLinkError({ status: 'NO_MATCH' }, translate as never, 'discovery')).toBe(
      '<clink_err_discovery_no_match>',
    );
  });

  it('still substitutes the retry window on the discovery path', () => {
    const t = (key: string) =>
      key === 'clink_err_discovery_rate_limited' ? 'Try again in {minutes} minutes.' : key;
    expect(
      formatLinkError({ status: 'RATE_LIMITED', retryAfterSeconds: 1800 }, t as never, 'discovery'),
    ).toBe('Try again in 30 minutes.');
  });

  it('leaves shared statuses identical across paths', () => {
    expect(formatLinkError({ status: 'CONTACT_ARCHIVED' }, translate as never, 'discovery')).toBe(
      formatLinkError({ status: 'CONTACT_ARCHIVED' }, translate as never),
    );
  });
});

describe('retryAfterMinutes', () => {
  it('rounds up to whole minutes', () => {
    expect(retryAfterMinutes(3600)).toBe(60);
    expect(retryAfterMinutes(61)).toBe(2);
    expect(retryAfterMinutes(30)).toBe(1);
  });

  it('defaults to the server window when unspecified', () => {
    expect(retryAfterMinutes(undefined)).toBe(60);
    expect(retryAfterMinutes(0)).toBe(60);
  });
});
