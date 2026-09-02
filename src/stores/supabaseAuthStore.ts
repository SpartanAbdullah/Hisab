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
  requestPasswordReset: (email: string) => Promise<{ success: boolean; message: string }>;
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

// Belt-and-braces LOCAL session teardown.
//
// Audit 2026-09 (SEC-11 / H8): `supabase.auth.signOut()` posts to /logout and,
// on ANY non-401/403/404 error — an offline AuthRetryableFetchError included —
// returns BEFORE it calls `_removeSession()`. The `sb-<ref>-auth-token` key
// survives in localStorage, so the next launch silently restores the session a
// user believed they had ended. On the shared / handed-over phones this app is
// built for, that is account takeover.
//
// `signOut({ scope: 'local' })` is NOT sufficient on its own: auth-js still
// makes the same network call first and bails out at the same point. So the
// last step here removes GoTrue's storage keys by hand. They are the only
// source of session state — `__loadSession()` reads them from storage on every
// use, and there is no in-memory copy that could write them back — so once the
// keys are gone the device is genuinely logged out, network or no network.
//
// Every step swallows its own failure: this must never throw, because the
// caller runs it on the path that declares the user signed out.
async function clearLocalAuthSession(): Promise<void> {
  try {
    // Second attempt, local-only. Succeeds (and stops the refresh ticker
    // cleanly) whenever the first failure was server-side rather than offline.
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    console.error('[signOut] local session teardown failed (continuing)', err);
  }
  try {
    // Last resort. GoTrue parks everything under the `sb-` prefix:
    // `sb-<ref>-auth-token`, `-code-verifier`, `-user`, and chunked `.0`/`.1`
    // variants. Nothing else in Hisaab uses that prefix (our keys are
    // `hisaab_*`), so a prefix sweep is safe and covers all of them.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-')) localStorage.removeItem(key);
    }
  } catch (err) {
    console.error('[signOut] auth-key purge failed', err);
  }
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
  const userId = localStorage.getItem('hisaab_supabase_uid');
  try {
    await supabase.auth.signOut();
  } finally {
    // Same H8 hole as signOut(): a deleted account whose revocation call fails
    // must still lose its token on this device.
    await clearLocalAuthSession();
    try {
      await resetAllUserStores(userId ?? undefined);
    } catch (err) {
      console.error('[blockDeletedSession] store reset failed (continuing)', err);
    }
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
        const previousUserId = localStorage.getItem('hisaab_supabase_uid');
        if (previousUserId && previousUserId !== session.user.id) {
          await resetAllUserStores(previousUserId);
        }
        localStorage.setItem('hisaab_supabase_uid', session.user.id);
      } else {
        localStorage.removeItem('hisaab_supabase_uid');
      }
      set({ session, user: session?.user ?? null, loading: false });

      // Listen for auth changes
      supabase.auth.onAuthStateChange((_event, session) => {
        void (async () => {
          if (session?.user?.id) {
            const previousUserId = localStorage.getItem('hisaab_supabase_uid');
            if (previousUserId && previousUserId !== session.user.id) {
              await resetAllUserStores(previousUserId);
            }
            localStorage.setItem('hisaab_supabase_uid', session.user.id);
            void isDeletedProfile(session.user.id).then((isDeleted) => {
              if (isDeleted) void blockDeletedSession(set);
            });
          } else {
            const previousUserId = localStorage.getItem('hisaab_supabase_uid');
            await resetAllUserStores(previousUserId ?? undefined);
            localStorage.removeItem('hisaab_supabase_uid');
          }
          set({ session, user: session?.user ?? null });
        })();
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
      const previousUserId = localStorage.getItem('hisaab_supabase_uid');
      if (previousUserId && previousUserId !== data.user.id) {
        await resetAllUserStores(previousUserId);
      }
      localStorage.setItem('hisaab_supabase_uid', data.user.id);
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

    const previousUserId = localStorage.getItem('hisaab_supabase_uid');
    if (previousUserId && previousUserId !== data.user.id) {
      await resetAllUserStores(previousUserId);
    }
    localStorage.setItem('hisaab_supabase_uid', data.user.id);
    set({ user: data.user, session: data.session });
    return { success: true, message: 'Logged in!' };
  },

  signOut: async () => {
    // Clear local user-owned state unconditionally, even if the network
    // signOut fails. Intent is explicit; we must not leave the previous
    // user's accounts/loans/groups visible for a second user on this device.
    const userId = localStorage.getItem('hisaab_supabase_uid');
    try {
      // Best effort at REVOKING the refresh token server-side. This is the
      // half that needs the network; it is allowed to fail.
      const { error } = await supabase.auth.signOut();
      if (error) {
        // Not fatal, but worth recording: the refresh token is still live
        // server-side and only the local teardown below protects the device.
        console.error('[signOut] server revocation failed; forcing local sign-out', error);
      }
    } catch (err) {
      console.error('[signOut] server revocation threw; forcing local sign-out', err);
    } finally {
      // ...and this is the half that must ALWAYS happen. Runs first in the
      // finally block so nothing downstream can throw before the device's
      // token is gone. Ordering of the store/DB cleanup below is unchanged.
      await clearLocalAuthSession();
      try {
        await resetAllUserStores(userId ?? undefined);
      } catch (err) {
        // A failed Dexie/store wipe must not leave the user "still signed in".
        console.error('[signOut] store reset failed (continuing)', err);
      }
      localStorage.removeItem('hisaab_supabase_uid');
      set({ user: null, session: null, error: null });
    }
  },

  deleteAccount: async () => {
    await accountDeletionDb.deleteCurrentUser();
    await get().signOut();
  },

  requestPasswordReset: async (email) => {
    if (!email) return { success: false, message: 'Email required' };
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: buildAuthRedirectUrl('/?reset=1'),
    });
    if (error) return { success: false, message: error.message };
    // Always show the same message regardless of whether the email exists —
    // prevents user-enumeration via the password-reset endpoint.
    return { success: true, message: 'If an account exists for this email, a reset link has been sent.' };
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
