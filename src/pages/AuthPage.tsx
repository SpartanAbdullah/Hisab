import { useState } from 'react';
import { Wallet, Mail, Lock, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useT, useI18nStore } from '../lib/i18n';
import { Globe } from 'lucide-react';
import { validatePassword, PASSWORD_MIN_LENGTH } from '../lib/passwordPolicy';

export function AuthPage() {
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const { signIn, signUp, requestPasswordReset, error } = useSupabaseAuthStore();
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async () => {
    if (!email) return;
    if (mode !== 'reset' && !password) return;
    // Enforce password policy at signup only — login uses whatever password
    // the account already has (may predate the new policy).
    if (mode === 'signup') {
      const policy = validatePassword(password);
      if (!policy.valid) {
        setMessage(policy.code === 'too_short' ? t('password_too_short') : t('password_missing_complexity'));
        return;
      }
    }
    setLoading(true);
    setMessage('');

    if (mode === 'signup') {
      const result = await signUp(email, password);
      setMessage(result.message);
    } else if (mode === 'reset') {
      const result = await requestPasswordReset(email);
      setMessage(result.message);
    } else {
      const result = await signIn(email, password);
      if (!result.success) setMessage(result.message);
    }
    setLoading(false);
  };

  const inputClass = "w-full bg-white/8 border border-white/15 rounded-2xl px-4 py-4 pl-12 text-white placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/30 text-[15px] tracking-tight backdrop-blur-sm transition-all";

  return (
    <div className="min-h-dvh relative overflow-hidden bg-navy-bloom">
      {/* Navy + bloom backdrop matches Onboarding so the auth → onboard flow
          reads as one continuous Sukoon surface. */}

      {/* Language toggle */}
      <button
        onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
        className="absolute top-5 right-5 z-50 bg-white/10 text-white/80 rounded-xl px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all backdrop-blur-sm border border-white/10"
      >
        <Globe size={11} /> {lang === 'ur' ? 'EN' : 'UR'}
      </button>

      <div className="relative text-white flex flex-col min-h-dvh px-8">
        {/* Logo */}
        <div className="flex flex-col items-center pt-16 mb-8">
          <div className="w-16 h-16 rounded-3xl bg-white/10 flex items-center justify-center mb-4 backdrop-blur-sm border border-white/10">
            <Wallet size={28} strokeWidth={1.5} />
          </div>
          <h1 className="text-3xl font-bold tracking-tighter">Hisaab</h1>
          <p className="text-white/50 text-[13px] mt-1">{t('onboard_tagline')}</p>
        </div>

        {/* Toggle */}
        {mode !== 'reset' && (
          <div className="flex bg-white/8 rounded-2xl p-1 mb-6 border border-white/10">
            <button onClick={() => { setMode('login'); setMessage(''); }}
              className={`flex-1 py-2.5 rounded-xl text-[12px] font-bold transition-all ${mode === 'login' ? 'bg-white text-navy-900 shadow-md' : 'text-white/60'}`}>
              Login
            </button>
            <button onClick={() => { setMode('signup'); setMessage(''); }}
              className={`flex-1 py-2.5 rounded-xl text-[12px] font-bold transition-all ${mode === 'signup' ? 'bg-white text-navy-900 shadow-md' : 'text-white/60'}`}>
              Sign Up
            </button>
          </div>
        )}

        {mode === 'reset' && (
          <p className="text-white/70 text-[13px] mb-4 text-center leading-relaxed">
            Enter your email and we'll send you a link to reset your password.
          </p>
        )}

        {/* Form */}
        <div className="space-y-4">
          <div className="relative">
            <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t('settings_email')}
              className={inputClass} autoFocus />
          </div>

          {mode !== 'reset' && (
            <>
              <div className="relative">
                <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={t('settings_password')}
                  className={inputClass + ' pr-12'} onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
                <button onClick={() => setShowPassword(!showPassword)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {mode === 'signup' && (
                <p className="text-white/50 text-[11px] leading-relaxed">
                  {password.length === 0
                    ? t('password_hint_12')
                    : password.length < PASSWORD_MIN_LENGTH
                      ? t('password_too_short')
                      : validatePassword(password).valid
                        ? t('password_hint_12')
                        : t('password_missing_complexity')}
                </p>
              )}
            </>
          )}
        </div>

        {/* Forgot-password link (only on Login) */}
        {mode === 'login' && (
          <div className="text-right mt-2">
            <button onClick={() => { setMode('reset'); setMessage(''); }}
              className="text-white/50 text-[11px] font-medium underline">
              Forgot password?
            </button>
          </div>
        )}

        {/* Error / Message */}
        {(error || message) && (
          <p className={`text-[12px] mt-3 text-center font-medium ${error ? 'text-pay-50' : 'text-receive-50'}`}>
            {error || message}
          </p>
        )}

        {/* Submit */}
        <button onClick={handleSubmit} disabled={loading || !email || (mode !== 'reset' && !password)}
          className="w-full mt-6 bg-white text-navy-900 rounded-2xl py-4 text-[14px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-30 shadow-lg shadow-white/10">
          {loading ? (
            <div className="w-5 h-5 border-2 border-navy-700 border-t-navy-900 rounded-full animate-spin" />
          ) : (
            <>
              {mode === 'login' ? 'Login' : mode === 'signup' ? 'Create Account' : 'Send Reset Link'}
              <ArrowRight size={16} />
            </>
          )}
        </button>

        {/* Footer */}
        <p className="text-white/25 text-[11px] text-center mt-6">
          {mode === 'reset' ? (
            <>
              Remembered it?{' '}
              <button onClick={() => { setMode('login'); setMessage(''); }} className="text-white/60 font-semibold underline">Back to Login</button>
            </>
          ) : mode === 'login' ? (
            <>
              Don't have an account?{' '}
              <button onClick={() => { setMode('signup'); setMessage(''); }} className="text-white/60 font-semibold underline">Sign Up</button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button onClick={() => { setMode('login'); setMessage(''); }} className="text-white/60 font-semibold underline">Login</button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
