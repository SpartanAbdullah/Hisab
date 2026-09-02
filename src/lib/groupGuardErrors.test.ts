import { describe, expect, it } from 'vitest';
import {
  readGroupGuardFailure,
  isGroupDeleteBlocked,
  isMemberAlreadyExistsError,
} from './groupGuardErrors';

// Shape of what supabase-js hands back for a plpgsql RAISE with DETAIL/HINT.
function postgrestError(message: string, details = '', hint = '', code = 'P0001') {
  return { message, details, hint, code };
}

describe('readGroupGuardFailure', () => {
  it('recognises the members tier and keeps the server DETAIL', () => {
    const failure = readGroupGuardFailure(
      postgrestError(
        'GROUP_HAS_OTHER_MEMBERS',
        '1 other member(s) still in "Dubai Trip": Bilal',
        'Archive this group instead (public.archive_group)…',
      ),
    );
    expect(failure?.code).toBe('GROUP_HAS_OTHER_MEMBERS');
    expect(failure?.detail).toBe('1 other member(s) still in "Dubai Trip": Bilal');
  });

  it('recognises the balances tier', () => {
    const failure = readGroupGuardFailure(
      postgrestError('GROUP_HAS_OUTSTANDING_BALANCES', 'Unsettled in "Dubai Trip": Bilal owes AED 150.00'),
    );
    expect(failure?.code).toBe('GROUP_HAS_OUTSTANDING_BALANCES');
    expect(failure?.detail).toContain('Bilal owes AED 150.00');
  });

  it('does not let GROUP_ARCHIVED shadow GROUP_ARCHIVE_RPC_ONLY', () => {
    // "GROUP_ARCHIVE_RPC_ONLY" does NOT contain "GROUP_ARCHIVED" as a
    // substring, but the ordering guarantee matters if either message is ever
    // reworded, so pin both.
    expect(readGroupGuardFailure(postgrestError('GROUP_ARCHIVE_RPC_ONLY: use archive_group / unarchive_group'))?.code)
      .toBe('GROUP_ARCHIVE_RPC_ONLY');
    expect(readGroupGuardFailure(postgrestError('GROUP_ARCHIVED: this group is archived and cannot be changed'))?.code)
      .toBe('GROUP_ARCHIVED');
  });

  it('reads the marker out of a flattened Error message when there is no DETAIL', () => {
    const failure = readGroupGuardFailure(
      new Error('GROUP_HAS_OTHER_MEMBERS: 2 other member(s) still in "Trip".'),
    );
    expect(failure?.code).toBe('GROUP_HAS_OTHER_MEMBERS');
    expect(failure?.detail).toBe('2 other member(s) still in "Trip"');
  });

  it('ignores an unrelated failure so real diagnostics survive', () => {
    expect(readGroupGuardFailure(new Error('permission denied for table split_groups'))).toBeNull();
    expect(readGroupGuardFailure(null)).toBeNull();
    expect(readGroupGuardFailure(undefined)).toBeNull();
    expect(readGroupGuardFailure({})).toBeNull();
  });
});

describe('isGroupDeleteBlocked', () => {
  it('is true only for the two DELETE tiers — archive refusals are a different fix', () => {
    expect(isGroupDeleteBlocked(postgrestError('GROUP_HAS_OTHER_MEMBERS'))).toBe(true);
    expect(isGroupDeleteBlocked(postgrestError('GROUP_HAS_OUTSTANDING_BALANCES'))).toBe(true);
    expect(isGroupDeleteBlocked(postgrestError('GROUP_ARCHIVED: …'))).toBe(false);
    expect(isGroupDeleteBlocked(new Error('boom'))).toBe(false);
  });
});

describe('isMemberAlreadyExistsError', () => {
  it('matches the trigger marker', () => {
    expect(isMemberAlreadyExistsError(
      postgrestError(
        'MEMBER_ALREADY_EXISTS: this person already has a membership row in this group; re-invite them with the group join code',
        '', '', '23505',
      ),
    )).toBe(true);
  });

  it('matches the structural unique index on group_members', () => {
    expect(isMemberAlreadyExistsError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "group_members_group_profile_uniq"',
      details: '',
      hint: '',
    })).toBe(true);
  });

  it('does not swallow an unrelated 23505', () => {
    expect(isMemberAlreadyExistsError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "persons_user_profile_uniq"',
      details: '',
      hint: '',
    })).toBe(false);
  });
});
