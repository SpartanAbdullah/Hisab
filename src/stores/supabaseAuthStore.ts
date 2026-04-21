import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { generatePublicCodeCandidate, normalizePublicCode } from '../lib/collaboration';
import { resetAllUserStores } from './resetAllStores';

interface SupabaseAuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signIn: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signOut: () => Promise<void>;
  updateProfile: (data: { name?: string; primary_currency?: string; app_mode?: string; lang?: string }) => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  getProfile: () => Promise<Record<string, unknown> | null>;
}

export const useSupabaseAuthStore = create<SupabaseAuthState>((set, get) => ({
  user: null,
  session: null,
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // Write uid synchronously BEFORE resolving so any DB call that depends on
      // localStorage.hisaab_supabase_uid sees the right value on the first paint.
      if (session?.user?.id) {
        localStorage.setItem('hisaab_supabase_uid', session.user.id);
      } else {
        localStorage.removeItem('hisaab_supabase_uid');
      }
      set({ session, user: session?.user ?? null, loading: false });

      // Listen for auth changes
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user?.id) {
          localStorage.setItem('hisaab_supabase_uid', session.user.id);
        } else {
          localStorage.removeItem('hisaab_supabase_uid');
        }
        set({ session, user: session?.user ?? null });
      });
    } catch {
      set({ loading: false });
    }
  },

  signUp: async (email, password) => {
    set({ error: null });
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    }

    if (data.user) {
      // Name is collected during onboarding, not signup. Seed the public_code
      // here so it's ready when the user wants to share group invites.
      const publicCode = generatePublicCodeCandidate();
      await supabase.from('profiles').update({
        onboarding_completed: false,
        public_code: publicCode,
        public_code_normalized: normalizePublicCode(publicCode),
      }).eq('id', data.user.id);
      set({ user: data.user, session: data.session });
    }

    return { success: true, message: 'Account created! Check your email to verify.' };
  },

  signIn: async (email, password) => {
    set({ error: null });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    }

    set({ user: data.user, session: data.session });
    return { success: true, message: 'Logged in!' };
  },

  signOut: async () => {
    // Clear local user-owned state unconditionally, even if the network
    // signOut fails. Intent is explicit; we must not leave the previous
    // user's accounts/loans/groups visible for a second user on this device.
    try {
      await supabase.auth.signOut();
    } finally {
      resetAllUserStores();
      set({ user: null, session: null, error: null });
    }
  },

  updateProfile: async (data) => {
    const user = get().user;
    if (!user) return;
    await supabase.from('profiles').update(data).eq('id', user.id);
  },

  changePassword: async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  },

  getProfile: async () => {
    const user = get().user;
    if (!user) return null;
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    return data;
  },
}));
