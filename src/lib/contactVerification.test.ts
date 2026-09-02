import { describe, expect, it } from 'vitest';
import { isConsentVerifiedLink, type ConsentLinkRow } from './contactVerification';

const ME = 'me-uuid';
const THEM = 'them-uuid';
const OTHER = 'other-uuid';

const row = (over: Partial<ConsentLinkRow>): ConsentLinkRow => ({
  fromUserId: ME,
  toUserId: THEM,
  status: 'pending',
  ...over,
});

describe('isConsentVerifiedLink', () => {
  it('accepts an outgoing link they accepted', () => {
    expect(isConsentVerifiedLink([row({ status: 'accepted' })], ME, THEM)).toBe(true);
  });

  it('accepts an incoming link I accepted', () => {
    const links = [row({ fromUserId: THEM, toUserId: ME, status: 'accepted' })];
    expect(isConsentVerifiedLink(links, ME, THEM)).toBe(true);
  });

  it('rejects a pending ask — a one-sided link is not verification', () => {
    expect(isConsentVerifiedLink([row({ status: 'pending' })], ME, THEM)).toBe(false);
  });

  it('rejects a declined ask', () => {
    expect(isConsentVerifiedLink([row({ status: 'declined' })], ME, THEM)).toBe(false);
  });

  it('fails closed when no requests are loaded', () => {
    expect(isConsentVerifiedLink([], ME, THEM)).toBe(false);
    expect(isConsentVerifiedLink(null, ME, THEM)).toBe(false);
    expect(isConsentVerifiedLink(undefined, ME, THEM)).toBe(false);
  });

  it('fails closed on a missing profile id (unlinked contact)', () => {
    expect(isConsentVerifiedLink([row({ status: 'accepted' })], ME, null)).toBe(false);
    expect(isConsentVerifiedLink([row({ status: 'accepted' })], '', THEM)).toBe(false);
  });

  it('does not borrow an accepted link with a third party', () => {
    const links = [
      row({ fromUserId: ME, toUserId: OTHER, status: 'accepted' }),
      row({ fromUserId: OTHER, toUserId: THEM, status: 'accepted' }),
    ];
    expect(isConsentVerifiedLink(links, ME, THEM)).toBe(false);
  });

  it('never verifies a self-link', () => {
    const links = [row({ fromUserId: ME, toUserId: ME, status: 'accepted' })];
    expect(isConsentVerifiedLink(links, ME, ME)).toBe(false);
  });

  it('picks the accepted row out of a mixed history', () => {
    const links = [
      row({ status: 'declined' }),
      row({ fromUserId: ME, toUserId: OTHER, status: 'pending' }),
      row({ fromUserId: THEM, toUserId: ME, status: 'accepted' }),
    ];
    expect(isConsentVerifiedLink(links, ME, THEM)).toBe(true);
  });
});
