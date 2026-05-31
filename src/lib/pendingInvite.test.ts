import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingInvite,
  getPendingInvite,
  getPendingInviteResumePath,
  savePendingInvite,
} from './pendingInvite';

describe('pending invite routing', () => {
  beforeEach(() => localStorage.clear());

  it('preserves a logged-out invite and resumes it once the user is ready', () => {
    savePendingInvite('shared-token');
    expect(getPendingInviteResumePath({ completed: true, currentPath: '/', hasUser: false })).toBeNull();
    expect(getPendingInviteResumePath({ completed: true, currentPath: '/', hasUser: true })).toBe('/join/shared-token');
    expect(getPendingInviteResumePath({ completed: true, currentPath: '/join/shared-token', hasUser: true })).toBeNull();
  });

  it('clears the pending invite when the user dismisses the same token', () => {
    savePendingInvite('shared-token');
    clearPendingInvite('shared-token');
    expect(getPendingInvite()).toBeNull();
    expect(getPendingInviteResumePath({ completed: true, currentPath: '/groups', hasUser: true })).toBeNull();
  });

  it('does not clear a newer deep link when an older screen finishes late', () => {
    savePendingInvite('newer-token');
    clearPendingInvite('older-token');
    expect(getPendingInvite()).toBe('newer-token');
  });
});
