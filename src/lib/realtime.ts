import { supabase } from './supabase';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { usePersonStore } from '../stores/personStore';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Single long-lived channel per session. Re-initialised when the user changes.
// RLS already limits what the server delivers, but we also filter by user_id /
// profile_id server-side to avoid getting events we'd have to ignore anyway.
let globalChannel: RealtimeChannel | null = null;
let globalUserId: string | null = null;

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
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'accounts', filter: `user_id=eq.${userId}` },
      () => {
        scheduleReload('accounts', () => useAccountStore.getState().loadAccounts());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'transactions', filter: `user_id=eq.${userId}` },
      () => {
        scheduleReload('transactions', () => useTransactionStore.getState().loadTransactions());
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'loans', filter: `user_id=eq.${userId}` },
      () => {
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
    .subscribe();
}

export function stopGlobalRealtime() {
  clearReloadTimers();
  if (globalChannel) {
    void supabase.removeChannel(globalChannel);
    globalChannel = null;
    globalUserId = null;
  }
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
