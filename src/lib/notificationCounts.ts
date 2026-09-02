// What the bell is allowed to count.
//
// THE BUG THIS FILE EXISTS FOR — audit 08-notifications.md N-7:
//
//   "`InboxAction` counts pending requests where the user is sender OR
//    receiver (`InboxAction.tsx:18-33`: `r.toUserId === userId ||
//    r.fromUserId === userId`), then pulses a halo and rings the bell icon
//    whenever the count is nonzero. A user who sends one loan request to a
//    slow-to-respond cousin sees a red animated badge for days with nothing
//    to act on — the exact 'counter stays at 1' anxiety the codebase fought
//    elsewhere."
//
// The same class of mistake lived one layer down in `notificationStore`,
// which counted `!readAt` over every loaded row — so a row the user caused
// themselves, or one from a group they have since muted, still lit the badge.
//
// The rule, in one sentence: a badge is a PROMISE THAT SOMETHING NEEDS YOU.
// It may only count things that are (a) inbound — someone else's action,
// aimed at this user, (b) unread, and (c) not silenced by that user's own
// notification preferences. Outgoing pending requests are real and belong in
// the Outgoing tab's own count (InboxPage.tsx already computes that
// separately); they are not attention.
//
// Everything here is pure so it can be unit-tested without a store, a DOM, or
// a database — the repo's testing philosophy (vitest.config.ts header).

import type { AppNotification } from '../db';

/** The subset of the user's notification preferences that affects counting.
 *  Mirrors `notification_prefs` rows
 *  (supabase-migration-p2-notification-maturity.sql §2): one global entry
 *  plus zero or more per-group ones. */
export interface NotificationMuteState {
  /** True when the user muted EVERYTHING (the global row with muted = true). */
  allMuted?: boolean;
  /** Group ids the user has muted individually. */
  mutedGroupIds?: ReadonlySet<string> | readonly string[];
}

function isMuted(n: AppNotification, mutes?: NotificationMuteState): boolean {
  if (!mutes) return false;
  if (mutes.allMuted) return true;
  if (!n.groupId) return false;
  const ids = mutes.mutedGroupIds;
  if (!ids) return false;
  if (Array.isArray(ids)) return ids.includes(n.groupId);
  return (ids as ReadonlySet<string>).has(n.groupId);
}

/** Is this row something the reader has to be told about?
 *
 *  A notification row is always addressed to its `userId` — the server never
 *  writes one to the actor (fan_out_group_notification skips
 *  `gm.profile_id IS DISTINCT FROM p_actor`). But the linked-request triggers
 *  DO notify the SENDER of an outcome ("Ali confirmed the shared loan"), and
 *  the group fan-out's rate limit or a future writer could regress the
 *  actor-skip. `actorId === self` is therefore checked here as a floor: if
 *  you caused it, it is not news to you.
 *
 *  Exported so the store, the Activity tab and any future surface all agree
 *  on one definition of "counts". */
export function isAttentionNotification(
  n: AppNotification,
  selfUserId?: string | null,
  mutes?: NotificationMuteState,
): boolean {
  if (n.readAt) return false;
  if (selfUserId && n.actorId && n.actorId === selfUserId) return false;
  if (isMuted(n, mutes)) return false;
  return true;
}

/** How many unread notifications deserve the badge.
 *
 *  Replaces `notifications.filter(n => !n.readAt).length`, which counted
 *  self-caused rows and rows from muted groups. */
export function countAttentionNotifications(
  notifications: readonly AppNotification[],
  selfUserId?: string | null,
  mutes?: NotificationMuteState,
): number {
  let count = 0;
  for (const n of notifications) {
    if (isAttentionNotification(n, selfUserId, mutes)) count += 1;
  }
  return count;
}

/** The shape both `linkedRequestStore` and `settlementRequestStore` rows
 *  share, reduced to what a badge needs. */
export interface BadgeRequest {
  status: string;
  toUserId?: string | null;
  fromUserId?: string | null;
}

/** Pending requests that need THIS user to decide. The N-7 fix: `fromUserId`
 *  matches are dropped, so a request you SENT never rings your own bell.
 *
 *  Use `countOutgoingPending` for the Outgoing tab — outgoing items are worth
 *  showing, just not worth alarming about. */
export function countIncomingPending(
  requests: readonly BadgeRequest[],
  userId: string,
): number {
  if (!userId) return 0;
  let count = 0;
  for (const r of requests) {
    if (r.status === 'pending' && r.toUserId === userId) count += 1;
  }
  return count;
}

/** Pending requests this user is waiting on someone else for. Belongs in the
 *  Outgoing tab count, never in the attention badge. */
export function countOutgoingPending(
  requests: readonly BadgeRequest[],
  userId: string,
): number {
  if (!userId) return 0;
  let count = 0;
  for (const r of requests) {
    if (r.status === 'pending' && r.fromUserId === userId && r.toUserId !== userId) count += 1;
  }
  return count;
}
