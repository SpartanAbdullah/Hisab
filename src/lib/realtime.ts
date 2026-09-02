import { supabase } from './supabase';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { markMirrorStale } from './mirrorCache';
import { reportError } from './errorReporter';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Single long-lived channel per session. Re-initialised when the user changes.
// RLS already limits what the server delivers, but we also filter by user_id /
// profile_id server-side to avoid getting events we'd have to ignore anyway.
let globalChannel: RealtimeChannel | null = null;
let globalUserId: string | null = null;
// ── Broadcast channel (audit 03-performance H5 / 04-supabase F-SC1) ─────────
// The three highest-churn tables move off postgres_changes onto Supabase
// Broadcast-from-database when VITE_REALTIME_BROADCAST === 'true'. See
// MONEY_BROADCAST_ENABLED below for the flag contract.
let broadcastChannel: RealtimeChannel | null = null;
// Timestamp of the last refreshLiveData() actually issued from a resume. See
// resumeGlobalRealtime for why. Reset on teardown so a new user starts clean.
let lastResumeAt = 0;

// Per-table debounce timers. Each table reload triggers a refetch — multiple
// rapid changes (e.g. a multi-step balance update from the local client itself)
// coalesce into a single reload after the trailing edge.
const RELOAD_DEBOUNCE_MS = 500;
const reloadTimers: Record<string, number | null> = {};

function scheduleReload(key: string, run: () => Promise<void>): void {
  if (reloadTimers[key]) window.clearTimeout(reloadTimers[key]!);
  reloadTimers[key] = window.setTimeout(() => {
    reloadTimers[key] = null;
    void run().catch((err) => {
      reportError(err, { feature: 'realtime.scheduleReload', extra: { channel: key } });
    });
  }, RELOAD_DEBOUNCE_MS);
}

function clearReloadTimers(): void {
  for (const key of Object.keys(reloadTimers)) {
    if (reloadTimers[key]) {
      window.clearTimeout(reloadTimers[key]!);
      reloadTimers[key] = null;
    }
  }
}

// ── Money-table change signalling ──────────────────────────────────────────
// The three money tables share one handler shape, whichever transport
// delivered the event. Extracted so the postgres_changes path and the
// Broadcast path are provably identical: markMirrorStale first (the event may
// come from another device or from a cross-user SECURITY DEFINER RPC — audit
// 04-supabase F-RT1), then the debounced store reload.
type MoneyTable = 'accounts' | 'transactions' | 'loans';
const MONEY_TABLES: readonly MoneyTable[] = ['accounts', 'transactions', 'loans'];

function reloadMoneyTable(table: MoneyTable): Promise<void> {
  switch (table) {
    case 'accounts':
      return useAccountStore.getState().loadAccounts();
    case 'transactions':
      return useTransactionStore.getState().loadTransactions();
    case 'loans':
      return useLoanStore.getState().loadLoans();
  }
}

function onMoneyTableChanged(table: MoneyTable): void {
  markMirrorStale(table);
  scheduleReload(table, () => reloadMoneyTable(table));
}

// ── Broadcast-from-database (audit H5 / F-SC1) ─────────────────────────────
// postgres_changes evaluates every WAL change against every subscription on a
// single-threaded service, with an RLS check per subscriber per change —
// Supabase's own docs point at Broadcast once that matters, and accounts /
// transactions / loans are exactly the tables a single expense entry writes.
//
// Broadcast-from-database inverts it: an AFTER trigger calls `realtime.send`
// with the target topic already computed, so the server does one insert per
// change instead of a fan-out scan. Each user has ONE private topic,
// `user:<uid>`, readable only by them (RLS policy on `realtime.messages` in
// supabase-migration-p2-realtime-broadcast.sql).
//
// Default OFF. The migration is unapplied until the operator runs it, and
// with no triggers installed a broadcast subscription would deliver nothing —
// the app would go silently stale on the money tables. So the postgres_changes
// bindings stay the default and the flag is the ONLY switch:
//
//   VITE_REALTIME_BROADCAST unset / anything but 'true'  → postgres_changes
//   VITE_REALTIME_BROADCAST === 'true'                   → Broadcast
//
// The two are mutually exclusive by construction (same handler, same debounce
// key), so flipping the flag can never double-reload.
const MONEY_BROADCAST_ENABLED = import.meta.env.VITE_REALTIME_BROADCAST === 'true';

/** The private per-user Broadcast topic. Must match `realtime.send`'s topic
 *  argument in the migration EXACTLY — a mismatch is a silent no-delivery. */
function moneyBroadcastTopic(userId: string): string {
  return `user:${userId}`;
}

function startMoneyBroadcast(userId: string): void {
  // A private channel is authorized per-subscriber against the RLS policy on
  // `realtime.messages`, so the socket needs the current access token before
  // the join. `setAuth()` with no argument reads it from the live session.
  const channel = supabase.channel(moneyBroadcastTopic(userId), {
    config: { private: true },
  });
  for (const table of MONEY_TABLES) {
    // Event name = table name, set by the trigger. Ledger-only users simply
    // never receive an `accounts` event (they own no accounts rows, so the
    // trigger never fires for them) — nothing here needs a mode check.
    channel.on('broadcast', { event: table }, () => onMoneyTableChanged(table));
  }
  broadcastChannel = channel;
  void supabase.realtime
    .setAuth()
    .catch((err) => {
      // Subscribe anyway: an expired token surfaces as a channel error we can
      // see, whereas silently not subscribing looks like "realtime is fine".
      reportError(err, { feature: 'realtime.startMoneyBroadcast.setAuth' });
    })
    .then(() => {
      // The user may have signed out (or resubscribed) while setAuth was in
      // flight; only join if this channel is still the current one.
      if (broadcastChannel === channel) channel.subscribe();
    });
}

export function startGlobalRealtime(userId: string) {
  if (globalUserId === userId && globalChannel) return;
  stopGlobalRealtime();
  globalUserId = userId;

  const channel = supabase
    .channel(`hisaab-user-${userId}`)
    // New/changed notifications addressed to this user.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      () => {
        void useNotificationStore.getState().loadNotifications();
      },
    )
    // Membership rows with this user as the profile — fires when someone adds
    // the user to a new group (or their status changes on an existing one).
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'group_members', filter: `profile_id=eq.${userId}` },
      () => {
        void useSplitStore.getState().loadGroups();
      },
    )
    // Contacts — picks up a reciprocal linked contact created server-side when
    // someone adds this user via their shared code, so the contact appears
    // (and becomes transactable) without a reload.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'persons', filter: `user_id=eq.${userId}` },
      () => {
        scheduleReload('persons', () => usePersonStore.getState().loadPersons());
      },
    )
    // Linked transaction requests — a shared loan proposed BY or TO this user.
    // Subscribing on both directions (RLS already scopes delivery to
    // participants) keeps the Inbox list + bell badge live: a new incoming
    // request, or an accept/reject of one this user sent, reloads the store.
    // Debounced under one key so an accept (which fires both an update here
    // and a notifications insert) coalesces into a single reload.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'linked_transaction_requests', filter: `to_user_id=eq.${userId}` },
      () => {
        scheduleReload('linkedRequests', () => useLinkedRequestStore.getState().loadRequests());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'linked_transaction_requests', filter: `from_user_id=eq.${userId}` },
      () => {
        scheduleReload('linkedRequests', () => useLinkedRequestStore.getState().loadRequests());
      },
    )
    // Linked settlement requests — a repayment proposed BY or TO this user.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'linked_settlement_requests', filter: `to_user_id=eq.${userId}` },
      () => {
        scheduleReload('linkedSettlements', () => useSettlementRequestStore.getState().loadRequests());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'linked_settlement_requests', filter: `from_user_id=eq.${userId}` },
      () => {
        scheduleReload('linkedSettlements', () => useSettlementRequestStore.getState().loadRequests());
      },
    )
    // Connection consent — "someone added you, add them back?" on the
    // receiving side, and the "waiting for them" status on the sending side.
    // Both directions so an accept flips the sender's copy live.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'contact_link_requests', filter: `to_user_id=eq.${userId}` },
      () => {
        scheduleReload('contactLinks', () => useContactLinkStore.getState().loadRequests());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'contact_link_requests', filter: `from_user_id=eq.${userId}` },
      () => {
        scheduleReload('contactLinks', () => useContactLinkStore.getState().loadRequests());
      },
    );

  // Money tables — sync across devices/tabs. Reloads are debounced because
  // every local write also triggers a self-echo event; we don't want N
  // transactions in 100ms to produce N reloads.
  //
  // These three are the ONLY bindings the Broadcast flag moves. Everything
  // above is cross-user (notifications, group membership, the three request
  // tables) and low-churn, so it stays on postgres_changes: those tables are
  // written by the OTHER user, and their per-change RLS check is the thing
  // that makes delivery correct.
  if (!MONEY_BROADCAST_ENABLED) {
    for (const table of MONEY_TABLES) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
        () => onMoneyTableChanged(table),
      );
    }
  }

  channel.subscribe();
  globalChannel = channel;

  if (MONEY_BROADCAST_ENABLED) startMoneyBroadcast(userId);
}

export function stopGlobalRealtime() {
  clearReloadTimers();
  lastResumeAt = 0;
  // Cleared BEFORE the awaited removal so a setAuth() still in flight sees a
  // different (null) current channel and does not join a dead session.
  const broadcast = broadcastChannel;
  broadcastChannel = null;
  if (broadcast) void supabase.removeChannel(broadcast);
  if (globalChannel) {
    void supabase.removeChannel(globalChannel);
    globalChannel = null;
    globalUserId = null;
  }
}

// ── Resume ────────────────────────────────────────────────────────────────
// Android suspends the WebView when the app backgrounds, and the realtime
// websocket dies with it — silently. Nothing used to notice, so a user who
// came back to the app saw stale data until something else happened to
// refetch, which is exactly the "close it and open it again before the
// notification shows up" symptom. On every resume we now (a) re-establish
// the socket if it isn't healthy, and (b) refetch the cross-user surfaces
// unconditionally, because a missed event leaves no trace to detect.

function channelIsHealthy(): boolean {
  if (!globalChannel) return false;
  // supabase-js exposes the phoenix channel state; 'joined' is the only
  // state that actually delivers rows.
  if (globalChannel.state !== 'joined') return false;
  // With Broadcast on, the money tables ride the second channel — a dead one
  // is exactly the "stale balances after a resume" failure this check exists
  // to catch, so it counts as unhealthy too. It is assigned synchronously in
  // startMoneyBroadcast (before the awaited setAuth), so a null here only
  // means "not started", which the `globalChannel` check above already covers.
  if (MONEY_BROADCAST_ENABLED && broadcastChannel && broadcastChannel.state !== 'joined') {
    return false;
  }
  return true;
}

/** Refetch everything a missed realtime event could have changed. Each
 *  failure is isolated — a single cold store must not block the rest. */
export async function refreshLiveData(): Promise<void> {
  // The money tables are the ones whose missed events are UNRECOVERABLE: the
  // inbox refreshed but balances didn't, so the user saw "accepted" beside
  // stale numbers (audit 04-supabase F-RT2). They were left out because a
  // refresh used to mean a full-table re-download; markMirrorStale now keeps
  // the incremental cursor, so each of these is a small diff.
  markMirrorStale('accounts');
  markMirrorStale('transactions');
  markMirrorStale('loans');
  // Each leg stays independently swallowed (one dead read must not blank the
  // other eight), but the failure is no longer invisible: a persistently
  // failing refresh is exactly how a user ends up acting on stale balances.
  const refresh = (source: string, work: Promise<unknown>): Promise<void> =>
    work.then(() => undefined).catch((err) => {
      reportError(err, { feature: 'realtime.refreshLiveData', extra: { source } });
    });
  await Promise.all([
    refresh('notifications', useNotificationStore.getState().loadNotifications()),
    refresh('linkedRequests', useLinkedRequestStore.getState().loadRequests()),
    refresh('settlementRequests', useSettlementRequestStore.getState().loadRequests()),
    refresh('contactLinks', useContactLinkStore.getState().loadRequests()),
    refresh('persons', usePersonStore.getState().loadPersons()),
    refresh('groups', useSplitStore.getState().loadGroups()),
    refresh('accounts', useAccountStore.getState().loadAccounts()),
    refresh('transactions', useTransactionStore.getState().loadTransactions()),
    refresh('loans', useLoanStore.getState().loadLoans()),
  ]);
}

// The core workflow is flicking between WhatsApp and Hisaab, and every switch
// used to fire refreshLiveData two or three times over (visibilitychange +
// focus on web, plus Capacitor's appStateChange on Android) with no throttle at
// all — ~14-21 queries per app switch (audit 03-performance H4). A cooldown on
// the last ACTUAL refresh keeps the rapid re-entries free while still refreshing
// promptly the first time the user comes back after a real absence.
const RESUME_COOLDOWN_MS = 20_000;

/** Call when the app returns to the foreground (or regains connectivity).
 *  Cheap when the socket survived — one state check plus a throttled refetch. */
export function resumeGlobalRealtime(): void {
  const userId = globalUserId;
  if (!userId) return;

  // Re-establish the socket whenever it isn't delivering. This is free in REST
  // terms (a websocket join, no queries), so it is NOT throttled.
  if (!channelIsHealthy()) {
    // removeChannel + resubscribe under the same name. startGlobalRealtime
    // early-returns when the ids match, so clear the marker first.
    // stopGlobalRealtime resets the cooldown because it also runs on signout;
    // a resubscribe of the SAME user is not a new session, so carry it across.
    // Without this, Android would never throttle: the WebView kills the socket
    // on every background, and the duplicate visibilitychange/focus/
    // appStateChange triggers all arrive while the new channel is still
    // 'joining' — i.e. still "unhealthy" — so each one would refetch.
    const preserved = lastResumeAt;
    stopGlobalRealtime();
    startGlobalRealtime(userId);
    lastResumeAt = preserved;
  }

  // The refetch is the expensive half, so the cooldown gates only that. A
  // background long enough to kill the socket is also long enough to clear a
  // 20 s window, so a real resume still reconciles immediately.
  const now = Date.now();
  if (now - lastResumeAt < RESUME_COOLDOWN_MS) return;
  lastResumeAt = now;
  void refreshLiveData();
}

// Per-group subscription for GroupDetailPage — picks up other members joining
// or leaving while the page is open. Returns an unsubscribe function.
export function subscribeToGroupMembers(groupId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`hisaab-group-${groupId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'group_members', filter: `group_id=eq.${groupId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
