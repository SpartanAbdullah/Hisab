import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { generatePublicCodeCandidate, normalizePublicCode } from '../lib/collaboration';
import { resetAllUserStores } from './resetAllStores';
import { accountDeletionDb } from '../lib/supabaseDb';

interface SupabaseAuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signIn: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  updateProfile: (data: { name?: string; primary_currency?: string; app_mode?: string; lang?: string }) => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  getProfile: () => Promise<Record<string, unknown> | null>;
}

function buildAuthRedirectUrl(path = '/'): string {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL as string | undefined;
  const fallbackUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const baseUrl = (configuredUrl?.trim() || fallbackUrl).replace(/\/+$/, '');
  const nextPath = path.startsWith('/') ? path : `/${path}`;
  return baseUrl ? `${baseUrl}${nextPath}` : nextPath;
}

async function isDeletedProfile(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('is_deleted')
    .eq('id', userId)
    .single();
  if (error) return false;
  return data?.is_deleted === true;
}

async function blockDeletedSession(set: (state: Partial<SupabaseAuthState>) => void) {
  try {
    await supabase.auth.signOut();
  } finally {
    resetAllUserStores();
    localStorage.removeItem('hisaab_supabase_uid');
    set({
      user: null,
      session: null,
      loading: false,
      error: 'This account has been deleted. Please create a new account to use Hisaab again.',
    });
  }
}

export const useSupabaseAuthStore = create<SupabaseAuthState>((set, get) => ({
  user: null,
  session: null,
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id && await isDeletedProfile(session.user.id)) {
        await blockDeletedSession(set);
        return;
      }
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
          void isDeletedProfile(session.user.id).then((isDeleted) => {
            if (isDeleted) void blockDeletedSession(set);
          });
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: buildAuthRedirectUrl('/'),
      },
    });

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

    if (data.user && await isDeletedProfile(data.user.id)) {
      await blockDeletedSession(set);
      return {
        success: false,
        message: 'This account has been deleted. Please create a new account to use Hisaab again.',
      };
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

  deleteAccount: async () => {
    await accountDeletionDb.softDeleteCurrentUser();
    await get().signOut();
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
