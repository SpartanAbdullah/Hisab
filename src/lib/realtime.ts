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
import type { RealtimeChannel } from '@supabase/supabase-js';

// Single long-lived channel per session. Re-initialised when the user changes.
// RLS already limits what the server delivers, but we also filter by user_id /
// profile_id server-side to avoid getting events we'd have to ignore anyway.
let globalChannel: RealtimeChannel | null = null;
let globalUserId: string | null = null;
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
      console.error(`[realtime] ${key} reload failed`, err);
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

export function startGlobalRealtime(userId: string) {
  if (globalUserId === userId && globalChannel) return;
  stopGlobalRealtime();
  globalUserId = userId;

  globalChannel = supabase
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
    // Money tables — sync across devices/tabs. Reloads are debounced because
    // every local write also triggers a self-echo postgres_changes event; we
    // don't want N transactions in 100ms to produce N reloads.
    //
    // markMirrorStale first: the event may come from ANOTHER device, or from a
    // cross-user SECURITY DEFINER RPC moving this user's balance from the other
    // side. Without the flag the reload hits the mirror's 2-minute freshness
    // window and renders pre-change numbers (audit 04-supabase F-RT1). The flag
    // now preserves the sync cursor, so this costs an incremental diff, not a
    // full-table pull.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'accounts', filter: `user_id=eq.${userId}` },
      () => {
        markMirrorStale('accounts');
        scheduleReload('accounts', () => useAccountStore.getState().loadAccounts());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'transactions', filter: `user_id=eq.${userId}` },
      () => {
        markMirrorStale('transactions');
        scheduleReload('transactions', () => useTransactionStore.getState().loadTransactions());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'loans', filter: `user_id=eq.${userId}` },
      () => {
        markMirrorStale('loans');
        scheduleReload('loans', () => useLoanStore.getState().loadLoans());
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
    )
    .subscribe();
}

export function stopGlobalRealtime() {
  clearReloadTimers();
  lastResumeAt = 0;
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
  return globalChannel.state === 'joined';
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
  await Promise.all([
    useNotificationStore.getState().loadNotifications().catch(() => {}),
    useLinkedRequestStore.getState().loadRequests().catch(() => {}),
    useSettlementRequestStore.getState().loadRequests().catch(() => {}),
    useContactLinkStore.getState().loadRequests().catch(() => {}),
    usePersonStore.getState().loadPersons().catch(() => {}),
    useSplitStore.getState().loadGroups().catch(() => {}),
    useAccountStore.getState().loadAccounts().catch(() => {}),
    useTransactionStore.getState().loadTransactions().catch(() => {}),
    useLoanStore.getState().loadLoans().catch(() => {}),
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
