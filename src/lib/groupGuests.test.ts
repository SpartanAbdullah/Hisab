import { describe, expect, it } from 'vitest';
import {
  MAX_GUEST_NAME_LENGTH,
  buildGuestInviteText,
  getGuestMembers,
  guestRpcFailureMessage,
  hasGuestMembers,
  isGuestMember,
  settlementIsOnBehalf,
  validateGuestName,
} from './groupGuests';
import type { SplitGroup } from '../db';

const group: SplitGroup = {
  id: 'group-1',
  name: 'Flat 12',
  emoji: '🏠',
  currency: 'AED',
  settled: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  members: [
    { id: 'owner', name: 'Ayesha', isOwner: true, profileId: 'u-1', status: 'connected' },
    { id: 'real', name: 'Bilal', isOwner: false, profileId: 'u-2', status: 'connected' },
    // The guest: named, live, no account.
    { id: 'guest', name: 'Kamran', isOwner: false, profileId: null, status: 'connected' },
    // A member who was invited but never accepted — an account exists.
    { id: 'invited', name: 'Sara', isOwner: false, profileId: 'u-3', status: 'invited' },
    // A member who DELETED their Hisaab account: profile_id nulled AND
    // status='left' by audit-p0-account-deletion, precisely so the seat is not
    // claimable. This must never read as a guest.
    { id: 'ghost', name: 'Laiba', isOwner: false, profileId: null, status: 'left' },
    // A LEGACY placeholder from before this feature (old status='guest' default).
    { id: 'legacy', name: 'Rehan', isOwner: false, profileId: null, status: 'guest' },
  ],
};

describe('isGuestMember — the SQL is_guest predicate, client-side', () => {
  it('is true only for an account-less seat that has not left', () => {
    expect(isGuestMember({ profileId: null, status: 'connected' })).toBe(true);
    expect(isGuestMember({ profileId: null, status: 'guest' })).toBe(true);
    expect(isGuestMember({ profileId: undefined, status: 'connected' })).toBe(true);
  });

  it('is false for anyone with a Hisaab account behind the seat', () => {
    expect(isGuestMember({ profileId: 'u-2', status: 'connected' })).toBe(false);
    expect(isGuestMember({ profileId: 'u-3', status: 'invited' })).toBe(false);
    expect(isGuestMember({ profileId: 'u-4', status: 'left' })).toBe(false);
  });

  it('is FALSE for a deleted account’s anonymized seat (profile null + left)', () => {
    // The distinction the whole `status <> left` clause exists for: reading
    // this as a guest would both mislabel it and invite a phone-hash claim.
    expect(isGuestMember({ profileId: null, status: 'left' })).toBe(false);
  });

  it('collects guests and legacy placeholders, and nothing else', () => {
    expect(getGuestMembers(group).map((m) => m.id)).toEqual(['guest', 'legacy']);
    expect(hasGuestMembers(group)).toBe(true);
    expect(hasGuestMembers({ members: [group.members[0]] })).toBe(false);
  });
});

describe('settlementIsOnBehalf', () => {
  it('is true when either side of the edge is a guest', () => {
    expect(settlementIsOnBehalf(group, 'guest', 'owner')).toBe(true);
    expect(settlementIsOnBehalf(group, 'owner', 'guest')).toBe(true);
  });

  it('is false between two real members', () => {
    expect(settlementIsOnBehalf(group, 'owner', 'real')).toBe(false);
  });

  it('is false for the deleted-account seat — nobody records on a ghost’s behalf', () => {
    expect(settlementIsOnBehalf(group, 'owner', 'ghost')).toBe(false);
  });
});

describe('validateGuestName', () => {
  it('rejects an empty or whitespace-only name', () => {
    expect(validateGuestName('', group.members)).toBe('empty');
    expect(validateGuestName('   ', group.members)).toBe('empty');
  });

  it('rejects a name past the server bound', () => {
    expect(validateGuestName('a'.repeat(MAX_GUEST_NAME_LENGTH), group.members)).toBeNull();
    expect(validateGuestName('a'.repeat(MAX_GUEST_NAME_LENGTH + 1), group.members)).toBe('too_long');
  });

  it('rejects a duplicate of ANY live member, case- and space-insensitively', () => {
    expect(validateGuestName('  bilal ', group.members)).toBe('duplicate');
    expect(validateGuestName('KAMRAN', group.members)).toBe('duplicate');
    expect(validateGuestName('sara', group.members)).toBe('duplicate');
  });

  it('allows reusing the name of a member who has left', () => {
    // Same rule as the SQL: the duplicate scan is scoped to live seats.
    expect(validateGuestName('Laiba', group.members)).toBeNull();
  });

  it('also refuses a collision with a name only staged in the form', () => {
    expect(validateGuestName('Nadia', group.members, ['nadia'])).toBe('duplicate');
    expect(validateGuestName('Nadia', group.members, ['Omar'])).toBeNull();
  });
});

describe('guestRpcFailureMessage', () => {
  it('maps every documented status code to non-empty copy', () => {
    for (const status of [
      'INVALID_NAME', 'DUPLICATE_NAME', 'TOO_MANY_GUESTS', 'TOO_MANY_MEMBERS',
      'NOT_ACTIVE_MEMBER', 'NOT_AUTHENTICATED', 'GROUP_ARCHIVED',
      'GUEST_HAS_LEDGER', 'NOT_A_GUEST', 'NOT_ALLOWED',
    ]) {
      expect(guestRpcFailureMessage(status).length).toBeGreaterThan(0);
    }
  });

  it('falls back rather than surfacing a raw code', () => {
    const fallback = guestRpcFailureMessage('SOMETHING_NEW');
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).not.toContain('SOMETHING_NEW');
    expect(guestRpcFailureMessage(undefined)).toBe(fallback);
  });

  it('gives DUPLICATE_NAME and INVALID_NAME different copy', () => {
    expect(guestRpcFailureMessage('DUPLICATE_NAME'))
      .not.toBe(guestRpcFailureMessage('INVALID_NAME'));
  });
});

describe('buildGuestInviteText', () => {
  it('substitutes all three placeholders and never leaks a phone number', () => {
    const text = buildGuestInviteText('Kamran', 'Flat 12', 'https://usehisaab.com');
    expect(text).toContain('Kamran');
    expect(text).toContain('Flat 12');
    expect(text).toContain('https://usehisaab.com');
    expect(text).not.toContain('{name}');
    expect(text).not.toContain('{group}');
    expect(text).not.toContain('{url}');
  });
});
