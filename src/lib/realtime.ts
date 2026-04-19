import { supabase } from './supabase';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Single long-lived channel per session. Re-initialised when the user changes.
// RLS already limits what the server delivers, but we also filter by user_id /
// profile_id server-side to avoid getting events we'd have to ignore anyway.
let globalChannel: RealtimeChannel | null = null;
let globalUserId: string | null = null;

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
    .subscribe();
}

export function stopGlobalRealtime() {
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
