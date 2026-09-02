import { describe, it, expect } from 'vitest';
import { summariseByActor } from './instantNotify';
import type { AppNotification } from '../db';

// Audit 08-notifications.md N-9:
//   "MAX_PER_BATCH = 3; when a reconnect delivers 4+ fresh unread rows the
//    function returns before scheduling anything. … four genuinely new events
//    (e.g. a group member posting four expenses of a trip) yield ZERO tray
//    signal. Leaders collapse instead of dropping."
// These tests pin the collapse, because the failure mode it replaces was
// invisible: nothing appeared, and nothing logged.

function n(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    userId: 'me',
    groupId: 'g1',
    eventId: null,
    type: 'group_update',
    title: 'Ali added an expense',
    body: 'Groceries in Flat 12.',
    template: 'expense_added',
    params: { actorName: 'Ali', groupName: 'Flat 12' },
    actorId: 'ali',
    collapseKey: null,
    channelId: null,
    href: null,
    readAt: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    ...over,
  };
}

describe('summariseByActor', () => {
  it('collapses one actor\'s burst into a single entry that names them', () => {
    const items = summariseByActor([
      n({ id: '1' }), n({ id: '2' }), n({ id: '3' }), n({ id: '4' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Ali');
    expect(items[0].body).toContain('4');
    // The burst is four expenses in one group — land the user in that group,
    // not at the top of /groups (audit N-8).
    expect(items[0].extra.href).toBe('/group/g1');
    expect(items[0].channelId).toBe('groups');
  });

  it('gives each actor their own summary, up to three actors', () => {
    const items = summariseByActor([
      n({ id: '1', actorId: 'ali',  params: { actorName: 'Ali', groupName: 'Flat 12' } }),
      n({ id: '2', actorId: 'ali',  params: { actorName: 'Ali', groupName: 'Flat 12' } }),
      n({ id: '3', actorId: 'sara', params: { actorName: 'Sara', groupName: 'Flat 12' } }),
      n({ id: '4', actorId: 'sara', params: { actorName: 'Sara', groupName: 'Flat 12' } }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).sort()).toEqual(['Ali', 'Sara']);
    // Two actors, two tray ids — a summary must never overwrite another's.
    expect(items[0].id).not.toBe(items[1].id);
  });

  it('renders a lone item from an actor as itself, not as a "1 update" summary', () => {
    const items = summariseByActor([
      // Ali acts once, in a different group, so the solo entry is findable by
      // its deep link.
      n({ id: '1', actorId: 'ali', groupId: 'g9',
          params: { actorName: 'Ali', groupName: 'Trip', description: 'Taxi' } }),
      n({ id: '2', actorId: 'sara', params: { actorName: 'Sara', groupName: 'Flat 12' } }),
      n({ id: '3', actorId: 'sara', params: { actorName: 'Sara', groupName: 'Flat 12' } }),
    ]);
    expect(items).toHaveLength(2);
    const solo = items.find((i) => i.extra.href === '/group/g9');
    expect(solo).toBeDefined();
    // Real content, not a tally: the row's own description survives.
    expect(solo!.body).toContain('Taxi');
  });

  it('falls back to one honest total beyond three actors', () => {
    const items = summariseByActor([
      n({ id: '1', actorId: 'a' }), n({ id: '2', actorId: 'b' }),
      n({ id: '3', actorId: 'c' }), n({ id: '4', actorId: 'd' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain('4');
    // No single entity to open: the Inbox is where a burst gets triaged.
    expect(items[0].extra.href).toBe('/inbox');
  });

  it('buckets actor-less server sweeps by template instead of merging them', () => {
    const items = summariseByActor([
      n({ id: '1', actorId: null, type: 'kameti', template: 'kameti_round_due',
          groupId: null, params: { committeeId: 'K1', committeeName: 'Office' } }),
      n({ id: '2', actorId: null, type: 'kameti', template: 'kameti_round_due',
          groupId: null, params: { committeeId: 'K1', committeeName: 'Office' } }),
      n({ id: '3', actorId: null, type: 'kameti', template: 'kameti_payout_due',
          groupId: null, params: { committeeId: 'K1', committeeName: 'Office' } }),
      n({ id: '4', actorId: 'ali' }),
    ]);
    expect(items).toHaveLength(3);
    // The two round_due rows collapsed; the payout and the group item did not.
    expect(items.filter((i) => i.channelId === 'kameti')).toHaveLength(2);
  });

  it('never emits a title of "undefined" when the actor name is missing', () => {
    const items = summariseByActor([
      n({ id: '1', actorId: 'x', params: {} }), n({ id: '2', actorId: 'x', params: {} }),
      n({ id: '3', actorId: 'x', params: {} }), n({ id: '4', actorId: 'x', params: {} }),
    ]);
    expect(items[0].title).toBe('Hisaab');
    expect(items[0].body).not.toContain('{who}');
    expect(items[0].body).not.toContain('undefined');
  });
});
