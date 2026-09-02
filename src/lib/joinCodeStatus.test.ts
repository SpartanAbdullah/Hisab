import { describe, expect, it } from 'vitest';
import {
  joinStatusFromThrown,
  joinStatusMessageKey,
  parseJoinByCodeResponse,
  parseAcceptInviteResponse,
  inviteStatusFromThrown,
  inviteStatusMessageKey,
  inviteStatusTitleKey,
  inviteStatusCanRetry,
} from './joinCodeStatus';

describe('parseJoinByCodeResponse — new jsonb contract', () => {
  it('reads a successful join', () => {
    expect(parseJoinByCodeResponse({
      status: 'ok',
      group_id: 'g1',
      member_id: 'm1',
      was_already_connected: true,
    })).toEqual({ status: 'ok', groupId: 'g1', memberId: 'm1', wasAlreadyConnected: true });
  });

  it('keeps every failure status distinct — RATE_LIMITED never collapses into "not found"', () => {
    for (const status of [
      'RATE_LIMITED',
      'INVALID_OR_EXPIRED_CODE',
      'CANNOT_JOIN_OWN_GROUP',
      'INVALID_CODE',
      'NOT_AUTHENTICATED',
    ] as const) {
      expect(parseJoinByCodeResponse({ status })).toEqual({ status });
    }
  });

  it('carries extra fields without confusing the narrowing', () => {
    expect(parseJoinByCodeResponse({ status: 'RATE_LIMITED', retry_after_seconds: 300 }))
      .toEqual({ status: 'RATE_LIMITED' });
  });

  it('treats an unrecognised status as UNKNOWN rather than a silent success', () => {
    expect(parseJoinByCodeResponse({ status: 'SOMETHING_NEW' })).toEqual({ status: 'UNKNOWN' });
  });

  it('does not accept status ok without a group id', () => {
    expect(parseJoinByCodeResponse({ status: 'ok' })).toEqual({ status: 'UNKNOWN' });
  });
});

describe('parseJoinByCodeResponse — legacy RETURNS TABLE shape', () => {
  it('maps a legacy row array to a success', () => {
    expect(parseJoinByCodeResponse([
      { group_id: 'g9', member_id: 'm9', was_already_connected: false },
    ])).toEqual({ status: 'ok', groupId: 'g9', memberId: 'm9', wasAlreadyConnected: false });
  });

  it('treats an empty legacy result as an invalid/expired code', () => {
    expect(parseJoinByCodeResponse([])).toEqual({ status: 'INVALID_OR_EXPIRED_CODE' });
    expect(parseJoinByCodeResponse(null)).toEqual({ status: 'INVALID_OR_EXPIRED_CODE' });
  });
});

describe('joinStatusFromThrown — old RAISE-based function', () => {
  it('recognises the raised codes', () => {
    expect(joinStatusFromThrown(new Error('RATE_LIMITED'))).toBe('RATE_LIMITED');
    expect(joinStatusFromThrown(new Error('INVALID_OR_EXPIRED_CODE'))).toBe('INVALID_OR_EXPIRED_CODE');
    expect(joinStatusFromThrown(new Error('CANNOT_JOIN_OWN_GROUP'))).toBe('CANNOT_JOIN_OWN_GROUP');
    expect(joinStatusFromThrown(new Error('INVALID_CODE'))).toBe('INVALID_CODE');
    expect(joinStatusFromThrown(new Error('Not authenticated'))).toBe('NOT_AUTHENTICATED');
  });

  it('recognises the pre-hardening message and transport failures', () => {
    expect(joinStatusFromThrown(new Error('Group code not found'))).toBe('INVALID_OR_EXPIRED_CODE');
    expect(joinStatusFromThrown(new Error('TypeError: Failed to fetch'))).toBe('NETWORK');
  });

  it('reads a bare PostgrestError-shaped object', () => {
    expect(joinStatusFromThrown({ message: 'RATE_LIMITED', code: 'P0001' })).toBe('RATE_LIMITED');
  });

  it('falls back to UNKNOWN for anything else', () => {
    expect(joinStatusFromThrown(new Error('boom'))).toBe('UNKNOWN');
    expect(joinStatusFromThrown(undefined)).toBe('UNKNOWN');
  });

  // CANNOT_JOIN_OWN_GROUP must be probed before INVALID_CODE, or the substring
  // "code" in another message could shadow it.
  it('prefers the most specific probe', () => {
    expect(joinStatusFromThrown(new Error('CANNOT_JOIN_OWN_GROUP: invalid_code'))).toBe('CANNOT_JOIN_OWN_GROUP');
  });
});

describe('joinStatusMessageKey', () => {
  it('gives rate limiting its own message', () => {
    expect(joinStatusMessageKey('RATE_LIMITED')).toBe('join_error_rate_limited');
    expect(joinStatusMessageKey('CANNOT_JOIN_OWN_GROUP')).toBe('join_error_own_group');
    expect(joinStatusMessageKey('INVALID_OR_EXPIRED_CODE')).toBe('join_error_not_found');
    expect(joinStatusMessageKey('UNKNOWN')).toBe('join_error_unknown');
  });
});

// ── Invite-link redemption (audit H3 / SEC-07) ─────────────────────────────

describe('parseAcceptInviteResponse', () => {
  it('reads the new jsonb success object', () => {
    expect(parseAcceptInviteResponse({
      status: 'ok',
      group_id: 'g1',
      member_id: 'm1',
      was_already_connected: true,
    })).toEqual({ status: 'ok', groupId: 'g1', memberId: 'm1', wasAlreadyConnected: true });
  });

  it('carries retry_after_seconds through for RATE_LIMITED', () => {
    expect(parseAcceptInviteResponse({ status: 'RATE_LIMITED', retry_after_seconds: 900 }))
      .toEqual({ status: 'RATE_LIMITED', retryAfterSeconds: 900 });
  });

  it('reads every failure status the RPC can return', () => {
    for (const status of ['INVITE_NOT_FOUND_OR_EXPIRED', 'INVALID_TOKEN', 'NOT_AUTHENTICATED'] as const) {
      expect(parseAcceptInviteResponse({ status })).toEqual({ status });
    }
  });

  it('still reads the legacy RETURNS TABLE row array', () => {
    expect(parseAcceptInviteResponse([{ group_id: 'g2', member_id: 'm2', was_already_connected: false }]))
      .toEqual({ status: 'ok', groupId: 'g2', memberId: 'm2', wasAlreadyConnected: false });
  });

  it('treats an empty payload as "no invite matched"', () => {
    expect(parseAcceptInviteResponse(null)).toEqual({ status: 'INVITE_NOT_FOUND_OR_EXPIRED' });
    expect(parseAcceptInviteResponse([])).toEqual({ status: 'INVITE_NOT_FOUND_OR_EXPIRED' });
  });

  it('does not report success without a group id', () => {
    expect(parseAcceptInviteResponse({ status: 'ok' })).toEqual({ status: 'UNKNOWN' });
  });
});

describe('inviteStatusFromThrown', () => {
  it('maps the old function\u2019s raises', () => {
    expect(inviteStatusFromThrown(new Error('Invite not found'))).toBe('INVITE_NOT_FOUND_OR_EXPIRED');
    expect(inviteStatusFromThrown(new Error('Invite expired'))).toBe('INVITE_EXPIRED');
    expect(inviteStatusFromThrown(new Error('Group not found'))).toBe('GROUP_NOT_FOUND');
    expect(inviteStatusFromThrown(new Error('Not authenticated'))).toBe('NOT_AUTHENTICATED');
  });

  it('maps a transport failure and an un-migrated database', () => {
    expect(inviteStatusFromThrown(new Error('Failed to fetch'))).toBe('NETWORK');
    expect(inviteStatusFromThrown(new Error('Could not find the function public.accept_group_invite(p_display_name, p_invite_token) in the schema cache')))
      .toBe('INVITE_NOT_FOUND_OR_EXPIRED');
  });

  it('falls back to UNKNOWN', () => {
    expect(inviteStatusFromThrown(new Error('boom'))).toBe('UNKNOWN');
    expect(inviteStatusFromThrown(undefined)).toBe('UNKNOWN');
  });
});

describe('invite status copy', () => {
  it('gives invite redemption its own rate-limit message (15 min, not 5)', () => {
    expect(inviteStatusMessageKey('RATE_LIMITED')).toBe('invite_error_rate_limited');
    expect(inviteStatusMessageKey('INVITE_NOT_FOUND_OR_EXPIRED')).toBe('invite_error_not_found');
    expect(inviteStatusMessageKey('UNKNOWN')).toBe('join_error_unknown');
  });

  it('only offers a retry for transient failures \u2014 a dead invite stays dead', () => {
    expect(inviteStatusCanRetry('NETWORK')).toBe(true);
    expect(inviteStatusCanRetry('UNKNOWN')).toBe(true);
    expect(inviteStatusCanRetry('INVITE_NOT_FOUND_OR_EXPIRED')).toBe(false);
    expect(inviteStatusCanRetry('RATE_LIMITED')).toBe(false);
  });

  it('has a title for every status', () => {
    for (const status of [
      'INVALID_TOKEN', 'INVITE_NOT_FOUND_OR_EXPIRED', 'INVITE_EXPIRED',
      'GROUP_NOT_FOUND', 'RATE_LIMITED', 'NOT_AUTHENTICATED', 'NETWORK', 'UNKNOWN',
    ] as const) {
      expect(inviteStatusTitleKey(status)).toBeTruthy();
    }
  });
});
