import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface SupabaseAuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<{ success: boolean; message: string }>;
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
      set({ session, user: session?.user ?? null, loading: false });

      // Listen for auth changes
      supabase.auth.onAuthStateChange((_event, session) => {
        set({ session, user: session?.user ?? null });
      });
    } catch {
      set({ loading: false });
    }
  },

  signUp: async (email, password, name) => {
    set({ error: null });
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    }

    if (data.user) {
      // Update profile with name
      await supabase.from('profiles').update({ name, onboarding_completed: false }).eq('id', data.user.id);
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
    await supabase.auth.signOut();
    set({ user: null, session: null });
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
