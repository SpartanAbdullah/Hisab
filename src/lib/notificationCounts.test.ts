import { describe, it, expect } from 'vitest';
import {
  countAttentionNotifications,
  countIncomingPending,
  countOutgoingPending,
  isAttentionNotification,
} from './notificationCounts';
import type { AppNotification } from '../db';

const ME = 'user-me';
const THEM = 'user-them';

function notif(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    userId: ME,
    groupId: null,
    eventId: null,
    type: 'group_update',
    title: 't',
    body: 'b',
    template: null,
    params: {},
    actorId: THEM,
    collapseKey: null,
    channelId: null,
    href: null,
    readAt: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    ...over,
  };
}

describe('isAttentionNotification', () => {
  it('counts an unread row caused by someone else', () => {
    expect(isAttentionNotification(notif(), ME)).toBe(true);
  });

  it('does not count a read row', () => {
    expect(isAttentionNotification(notif({ readAt: '2026-09-02T11:00:00.000Z' }), ME)).toBe(false);
  });

  // Audit 08-notifications.md N-7, one layer down from InboxAction: the badge
  // is a promise that something needs YOU. Your own action is not news.
  it('does not count a row this user caused themselves', () => {
    expect(isAttentionNotification(notif({ actorId: ME }), ME)).toBe(false);
  });

  it('still counts a row with no actor (a server sweep, e.g. a kameti round)', () => {
    expect(isAttentionNotification(notif({ actorId: null, type: 'kameti' }), ME)).toBe(true);
  });

  it('does not count a row from a muted group', () => {
    const n = notif({ groupId: 'g1' });
    expect(isAttentionNotification(n, ME, { mutedGroupIds: new Set(['g1']) })).toBe(false);
    expect(isAttentionNotification(n, ME, { mutedGroupIds: new Set(['g2']) })).toBe(true);
  });

  it('accepts a plain array of muted group ids as well as a Set', () => {
    const n = notif({ groupId: 'g1' });
    expect(isAttentionNotification(n, ME, { mutedGroupIds: ['g1'] })).toBe(false);
  });

  it('mutes everything when the global row is muted, group row or not', () => {
    expect(isAttentionNotification(notif({ groupId: 'g1' }), ME, { allMuted: true })).toBe(false);
    expect(isAttentionNotification(notif({ groupId: null }), ME, { allMuted: true })).toBe(false);
  });

  it('leaves non-group notifications alone when only a group is muted', () => {
    // A per-group mute must never silence a loan request.
    const loan = notif({ type: 'linked_request', groupId: null });
    expect(isAttentionNotification(loan, ME, { mutedGroupIds: new Set(['g1']) })).toBe(true);
  });

  it('counts everything unread when the caller knows no user id and no prefs', () => {
    // Degraded but honest: this is the pre-M5 behaviour, which is what a
    // client running against an un-migrated database should still get.
    expect(isAttentionNotification(notif({ actorId: ME }), null)).toBe(true);
  });
});

describe('countAttentionNotifications', () => {
  it('counts only the inbound, unread, non-muted rows', () => {
    const rows: AppNotification[] = [
      notif({ id: '1' }),                                            // ✓
      notif({ id: '2', readAt: '2026-09-02T11:00:00.000Z' }),        // read
      notif({ id: '3', actorId: ME }),                               // self-caused
      notif({ id: '4', groupId: 'g1' }),                             // muted group
      notif({ id: '5', groupId: 'g2' }),                             // ✓
      notif({ id: '6', type: 'linked_request', actorId: THEM }),     // ✓
    ];
    expect(countAttentionNotifications(rows, ME, { mutedGroupIds: new Set(['g1']) })).toBe(3);
  });

  it('is zero for an empty list', () => {
    expect(countAttentionNotifications([], ME)).toBe(0);
  });
});

// ── The N-7 fix proper: outgoing requests are not attention ────────────────
// "A user who sends one loan request to a slow-to-respond cousin sees a red
//  animated badge for days with nothing to act on."
describe('countIncomingPending / countOutgoingPending', () => {
  const requests = [
    { status: 'pending',  toUserId: ME,   fromUserId: THEM },  // they asked me
    { status: 'pending',  toUserId: THEM, fromUserId: ME },    // I asked them
    { status: 'pending',  toUserId: THEM, fromUserId: THEM },  // neither
    { status: 'accepted', toUserId: ME,   fromUserId: THEM },  // resolved
    { status: 'rejected', toUserId: THEM, fromUserId: ME },    // resolved
  ];

  it('counts only requests waiting on ME', () => {
    expect(countIncomingPending(requests, ME)).toBe(1);
  });

  it('counts requests I am waiting on someone else for, separately', () => {
    expect(countOutgoingPending(requests, ME)).toBe(1);
  });

  it('never double-counts a self-addressed request in the outgoing tally', () => {
    const selfLoop = [{ status: 'pending', toUserId: ME, fromUserId: ME }];
    expect(countIncomingPending(selfLoop, ME)).toBe(1);
    expect(countOutgoingPending(selfLoop, ME)).toBe(0);
  });

  it('is zero while the user id is unknown (signed out / still booting)', () => {
    expect(countIncomingPending(requests, '')).toBe(0);
    expect(countOutgoingPending(requests, '')).toBe(0);
  });
});
