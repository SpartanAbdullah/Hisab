import { useEffect, useRef, useState } from 'react';
import { Mail, Lock, ArrowRight, Eye, EyeOff, Check, MailCheck, Sparkles } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { supabase } from '../lib/supabase';
import { useT, useI18nStore } from '../lib/i18n';
import type { I18nKey } from '../lib/i18n';
import { Globe } from 'lucide-react';
import { validatePassword, passwordChecks } from '../lib/passwordPolicy';
import { isValidEmail, suggestEmailFix } from '../lib/validateEmail';
import { mapAuthError, type Detour } from '../lib/authErrorMap';

// ── Rotating feature word ──────────────────────────────────────────────
// One colored word per real app feature. Colors are the app's own semantic
// palette (violet=brand, coral=out, gold=kameti, blue=shared, green=in) but
// BRIGHTENED to clear WCAG AA on the navy hero (#11142F): every hex below is
// ≥6:1 as white-adjacent text on navy. Hardcoded inline because the hero is
// navy in both light and dark themes, so no token/dark variant is needed.
const HEADLINE_WORDS: { key: I18nKey; color: string }[] = [
  { key: 'auth_word_loans', color: '#9E86FF' },      // 6.27:1
  { key: 'auth_word_expenses', color: '#F2967C' },   // 8.09:1
  { key: 'auth_word_committees', color: '#E8C063' }, // 10.43:1
  { key: 'auth_word_splits', color: '#6B92F5' },     // 6.06:1
  { key: 'auth_word_savings', color: '#3FD7A6' },    // 9.86:1
];

function RotatingHeadline() {
  const t = useT();
  const [i, setI] = useState(0);

  useEffect(() => {
    // Reduced-motion: never start the cycle — freeze on the first (flagship) word.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      // Pause while the tab/app is backgrounded (battery on the Capacitor wrapper).
      if (!document.hidden) setI(v => (v + 1) % HEADLINE_WORDS.length);
    }, 2600);
    return () => window.clearInterval(id);
  }, []);

  const w = HEADLINE_WORDS[i];
  return (
    <div className="mt-3 text-center">
      {/* One stable sentence for assistive tech, instead of a flicker of words. */}
      <span className="sr-only">{t('auth_headline_sr')}</span>
      <p aria-hidden className="text-white/55 text-[13px] tracking-wide">{t('auth_headline_prefix')}</p>
      {/* Fixed height so the swap never shifts the layout; overflow clips the rise. */}
      <div aria-hidden className="h-8 flex items-center justify-center overflow-hidden">
        <span key={i} className="animate-word-morph text-[22px] font-bold tracking-tight leading-none"
          style={{ color: w.color }}>
          {t(w.key)}
        </span>
      </div>
    </div>
  );
}

export function AuthPage() {
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const { signIn, signUp, requestPasswordReset, error } = useSupabaseAuthStore();
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // A raw Supabase error is never rendered directly — it's mapped to a Detour.
  const [detour, setDetour] = useState<Detour | null>(null);
  // Reset flow uses an enumeration-safe "if an account exists…" message that is
  // deliberately kept OUT of the error map and shown as a calm confirmation.
  const [resetMsg, setResetMsg] = useState('');
  // After a successful signup we swap the form for a prominent "check your
  // email" screen instead of a faint message line.
  const [signupSent, setSignupSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resentMsg, setResentMsg] = useState('');
  // Set by the verification screen when the user taps "I've verified — log in":
  // greet them with a success banner instead of a bare login form.
  const [justVerified, setJustVerified] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const checks = passwordChecks(password);
  const pwStrong = mode === 'signup' && checks.length && checks.letter && checks.number;
  const emailErr = detour?.field === 'email';
  const passwordErr = detour?.field === 'password';
  // "Did you mean gmail.com?" — only when the typed address looks like a known
  // domain typo, so a mistyped email doesn't strand the user in verify limbo.
  const emailSuggestion = suggestEmailFix(email);

  useEffect(() => {
    if (sessionStorage.getItem('hisaab_just_verified')) {
      sessionStorage.removeItem('hisaab_just_verified');
      setJustVerified(true);
      setMode('login');
    }
  }, []);

  // Surface externally-set store errors (e.g. a deleted-account session blocked
  // at app boot) through the same detour mapper. Local call failures set the
  // detour directly in handleSubmit, so this is only a safety net.
  useEffect(() => {
    if (error) setDetour(mapAuthError(error));
  }, [error]);

  const resendVerification = async () => {
    if (!sentEmail) return;
    setResending(true);
    setResentMsg('');
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: sentEmail });
      setResentMsg(resendError ? resendError.message : t('verify_resent'));
    } finally {
      setResending(false);
    }
  };

  // Resend triggered from an "email not confirmed" detour — lands the user in
  // the familiar "check your email" screen on success.
  const resendFromError = async () => {
    if (!email || resending) return;
    setResending(true);
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email });
      if (resendError) {
        setDetour(mapAuthError(resendError.message));
      } else {
        setSentEmail(email);
        setSignupSent(true);
        setDetour(null);
      }
    } finally {
      setResending(false);
    }
  };

  const backToLogin = () => {
    setSignupSent(false);
    setMode('login');
    setPassword('');
    setDetour(null);
    setResetMsg('');
    setResentMsg('');
  };

  const switchMode = (next: 'login' | 'signup' | 'reset') => {
    setMode(next);
    setDetour(null);
    setResetMsg('');
  };

  const handleSubmit = async () => {
    if (!email) return;
    if (mode !== 'reset' && !password) return;
    // Enforce password policy at signup only — login uses whatever password
    // the account already has (may predate the new policy).
    if (mode === 'signup') {
      const policy = validatePassword(password);
      if (!policy.valid) {
        setDetour({
          msgKey: policy.code === 'too_short' ? 'err_password_short' : 'err_password_weak',
          actionKey: 'err_password_action',
          action: 'fixPassword',
          field: 'password',
        });
        return;
      }
    }
    setLoading(true);
    setDetour(null);
    setResetMsg('');

    if (mode === 'signup') {
      const result = await signUp(email, password);
      if (result.success) {
        setSentEmail(email);
        setSignupSent(true);
      } else {
        setDetour(mapAuthError(result.message));
      }
    } else if (mode === 'reset') {
      const result = await requestPasswordReset(email);
      if (result.success) setResetMsg(result.message);
      else setDetour(mapAuthError(result.message));
    } else {
      const result = await signIn(email, password);
      if (!result.success) setDetour(mapAuthError(result.message));
    }
    setLoading(false);
  };

  // An error's inline action re-routes the user instead of leaving them stuck.
  const runDetour = () => {
    if (!detour) return;
    switch (detour.action) {
      case 'reset':
        switchMode('reset'); // keep the typed email prefilled
        break;
      case 'login':
        setMode('login');
        setPassword('');
        setDetour(null);
        setResetMsg('');
        setTimeout(() => passwordRef.current?.focus(), 0);
        break;
      case 'resend':
        void resendFromError();
        break;
      case 'fixPassword':
        setDetour(null);
        passwordRef.current?.focus();
        break;
      case 'editEmail':
        setDetour(null);
        emailRef.current?.focus();
        emailRef.current?.select();
        break;
      case 'newAccount':
        setMode('signup');
        setEmail('');
        setPassword('');
        setDetour(null);
        setResetMsg('');
        break;
      case 'retry':
        setDetour(null);
        void handleSubmit();
        break;
      case 'dismiss':
      default:
        setDetour(null);
        break;
    }
  };

  const inputBase = 'auth-input peer w-full bg-white/10 border rounded-2xl px-4 pl-12 pt-6 pb-2 text-white text-[15px] tracking-tight backdrop-blur-sm transition-all focus:outline-none focus:ring-2';
  const inputOk = 'border-white/20 focus:ring-accent-500/40 focus:border-accent-500/50';
  const inputBad = 'border-pay-600/70 focus:ring-pay-600/40 focus:border-pay-600/70';

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

      {/* Prominent "check your email" screen after a successful signup. */}
      {signupSent && (
        <div className="relative text-white flex flex-col items-center justify-center min-h-dvh px-8 text-center animate-fade-in">
          <div className="w-20 h-20 rounded-3xl bg-receive-600/25 flex items-center justify-center mb-6 backdrop-blur-sm border border-receive-600/30 animate-bounce-in">
            <MailCheck size={36} className="text-receive-50" strokeWidth={1.5} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-3">{t('verify_title')}</h1>
          <p className="text-white/60 text-[13px] leading-relaxed max-w-[300px]">{t('verify_body')}</p>
          <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{sentEmail}</p>
          <p className="text-white/45 text-[12px] leading-relaxed max-w-[290px] mt-4">{t('verify_instruction')}</p>
          <p className="text-white/35 text-[11px] leading-relaxed max-w-[290px] mt-2">{t('verify_spam')}</p>

          <div className="w-full max-w-[300px] mt-8 space-y-3">
            <button onClick={backToLogin}
              className="w-full bg-white text-navy-900 rounded-2xl py-4 text-[14px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-lg shadow-white/10">
              {t('verify_back_login')} <ArrowRight size={16} />
            </button>
            <button onClick={resendVerification} disabled={resending}
              className="w-full bg-white/10 border border-white/15 text-white rounded-2xl py-3.5 text-[13px] font-semibold active:scale-[0.98] transition-all disabled:opacity-50 backdrop-blur-sm">
              {resending ? t('verify_resending') : t('verify_resend')}
            </button>
          </div>
          {resentMsg && <p className="text-receive-50 text-[12px] mt-4 max-w-[290px] leading-relaxed">{resentMsg}</p>}
          <button onClick={() => { setSignupSent(false); setMode('signup'); setResentMsg(''); }}
            className="text-white/45 text-[11px] underline mt-6 min-h-[44px]">{t('verify_diff_email')}</button>
        </div>
      )}

      {!signupSent && (
      <div className="relative text-white flex flex-col min-h-dvh px-8">
        {/* Logo + living headline */}
        <div className="flex flex-col items-center pt-16 mb-8">
          <div className="w-16 h-16 rounded-[17px] mb-4 shadow-lg shadow-black/30">
            <BrandMark size={64} />
          </div>
          <h1 className="text-3xl font-bold tracking-tighter">Hisaab</h1>
          {/* Rotating colored feature word — teaches "what does this app do?" in
              the first few seconds, and pre-cues the violet action color. */}
          <RotatingHeadline />
          {/* Trust line — the no-ads / privacy promise belongs on the very
              first screen, not hidden until after onboarding. */}
          <p className="text-white/40 text-[10.5px] mt-3 tracking-wide">{t('auth_trust')}</p>
        </div>

        {/* Email-confirmed banner — shown after the verification screen hands
            the user back to log in, so the login form isn't a bare dead-end. */}
        {justVerified && mode === 'login' && (
          <div role="status" className="mb-5 flex items-center justify-center gap-2 rounded-2xl bg-receive-600/15 border border-receive-600/25 px-4 py-3 text-receive-50 text-[12.5px] font-medium animate-fade-in">
            <MailCheck size={14} className="shrink-0" />
            <span className="leading-relaxed">{t('verify_confirmed_login')}</span>
          </div>
        )}

        {/* Toggle */}
        {mode !== 'reset' && (
          <div className="flex bg-white/8 rounded-2xl p-1 mb-6 border border-white/10">
            <button onClick={() => switchMode('login')}
              className={`flex-1 py-2.5 rounded-xl text-[12px] font-bold transition-all ${mode === 'login' ? 'bg-white text-navy-900 shadow-md' : 'text-white/60'}`}>
              Login
            </button>
            <button onClick={() => switchMode('signup')}
              className={`flex-1 py-2.5 rounded-xl text-[12px] font-bold transition-all ${mode === 'signup' ? 'bg-white text-navy-900 shadow-md' : 'text-white/60'}`}>
              Sign Up
            </button>
          </div>
        )}

        {/* First-action teach — the blank login screen nudges a newcomer toward
            creating an account instead of assuming they already have one. Kept
            neutral (not violet) so it never competes with the one violet CTA. */}
        {mode === 'login' && (
          <button onClick={() => switchMode('signup')}
            className="w-full -mt-2 mb-5 flex items-center justify-center gap-2 rounded-2xl bg-white/[0.06] border border-white/10 py-3 px-4 text-[12px] text-white/70 active:scale-[0.98] transition-all backdrop-blur-sm">
            <Sparkles size={13} className="text-accent-100 shrink-0" />
            <span>{t('auth_first_action_hint')}</span>
          </button>
        )}

        {mode === 'reset' && (
          <p className="text-white/70 text-[13px] mb-4 text-center leading-relaxed">
            {t('auth_reset_intro')}
          </p>
        )}

        {/* Form */}
        <div className="space-y-4">
          <div className={`relative ${emailErr ? 'animate-shake' : ''}`}>
            <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
            <input id="auth-email" ref={emailRef} type="email" inputMode="email" autoComplete="email"
              value={email} onChange={e => { setEmail(e.target.value); if (detour) setDetour(null); }}
              placeholder=" " aria-invalid={emailErr || undefined}
              aria-describedby={detour ? 'auth-error' : undefined}
              className={`${inputBase} pr-11 ${emailErr ? inputBad : inputOk}`} autoFocus />
            <label htmlFor="auth-email" className="auth-float-label">{t('auth_label_email')}</label>
            {/* Green tick the moment the email format looks valid — confirm, don't just flag. */}
            {isValidEmail(email) && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-[#12B48C] flex items-center justify-center animate-scale-in">
                <Check size={12} strokeWidth={3.2} className="text-white" />
              </span>
            )}
          </div>

          {/* "Did you mean gmail.com?" — a valid-format email can still be a
              typo'd domain; one tap fixes it before verify limbo. */}
          {emailSuggestion && (
            <button type="button" onClick={() => { setEmail(emailSuggestion); if (detour) setDetour(null); }}
              className="-mt-2 ml-1 text-left text-white/70 text-[11.5px] underline underline-offset-2 press-sm">
              {t('auth_did_you_mean')} <span className="font-semibold text-receive-50">{emailSuggestion}</span>
            </button>
          )}

          {mode !== 'reset' && (
            <>
              <div className={`relative ${passwordErr ? 'animate-shake' : ''}`}>
                {/* Leading icon crossfades to a green check once the password is strong. */}
                {pwStrong ? (
                  <Check size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#12B48C] animate-scale-in" strokeWidth={3} />
                ) : (
                  <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                )}
                <input id="auth-password" ref={passwordRef} type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password} onChange={e => { setPassword(e.target.value); if (detour) setDetour(null); }}
                  placeholder=" " aria-invalid={passwordErr || undefined}
                  aria-describedby={detour ? 'auth-error' : undefined}
                  className={`${inputBase} pr-12 ${passwordErr ? inputBad : inputOk}`}
                  onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
                <label htmlFor="auth-password" className="auth-float-label">{t('auth_label_password')}</label>
                <button type="button" tabIndex={-1} onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {mode === 'signup' && (
                pwStrong ? (
                  // All three rules met — collapse the checklist into one calm win.
                  <div className="flex items-center gap-2 pt-0.5 animate-fade-in">
                    <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 bg-[#12B48C] text-white">
                      <Check size={10} strokeWidth={3.2} />
                    </span>
                    <span className="text-[11.5px] font-medium text-receive-50">{t('pw_check_done')}</span>
                  </div>
                ) : (
                  <div className="space-y-1.5 pt-0.5">
                    {([
                      { ok: checks.length, label: t('pw_check_length') },
                      { ok: checks.letter, label: t('pw_check_letter') },
                      { ok: checks.number, label: t('pw_check_number') },
                    ]).map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${c.ok ? 'bg-receive-600 text-white' : 'bg-white/10 text-transparent border border-white/15'}`}>
                          <Check size={10} strokeWidth={3.2} />
                        </span>
                        <span className={`text-[11.5px] transition-colors ${c.ok ? 'text-receive-50 font-medium' : 'text-white/45'}`}>{c.label}</span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </>
          )}
        </div>

        {/* Forgot-password link (only on Login) */}
        {mode === 'login' && (
          <div className="text-right mt-2">
            <button onClick={() => switchMode('reset')}
              className="text-white/50 text-[11px] font-medium underline">
              {t('auth_forgot')}
            </button>
          </div>
        )}

        {/* Detour error — warm copy + a one-tap way forward, never a dead end. */}
        {detour && (
          <div id="auth-error" role="alert" className="mt-3 text-center animate-fade-in">
            <p className="text-pay-50 text-[12.5px] font-medium leading-relaxed">{t(detour.msgKey)}</p>
            <button onClick={runDetour} disabled={resending}
              className="text-white text-[12.5px] font-semibold underline underline-offset-2 mt-1.5 min-h-[36px] disabled:opacity-50">
              {t(detour.actionKey)}
            </button>
          </div>
        )}

        {/* Reset-request confirmation — a done action, not a maybe (enumeration-safe copy). */}
        {resetMsg && (
          <div role="status" className="mt-3 flex items-center justify-center gap-2 text-receive-50 text-[12.5px] font-medium animate-fade-in">
            <MailCheck size={14} className="shrink-0" />
            <span className="leading-relaxed">{resetMsg}</span>
          </div>
        )}

        {/* Primary CTA — the single accent-violet action on the navy hero. */}
        <button onClick={handleSubmit} disabled={loading || !email || (mode !== 'reset' && !password)}
          className="auth-cta w-full mt-6 rounded-2xl py-4 text-[15px] font-semibold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98] active:brightness-95 disabled:opacity-40 disabled:shadow-none bg-gradient-to-b from-accent-500 to-accent-600 shadow-lg shadow-accent-600/30">
          {loading ? (
            <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              {t(mode === 'login' ? 'auth_cta_login' : mode === 'signup' ? 'auth_cta_signup' : 'auth_cta_reset')}
              <ArrowRight size={16} />
            </>
          )}
        </button>

        {/* Footer */}
        <p className="text-white/25 text-[11px] text-center mt-6">
          {mode === 'reset' ? (
            <>
              {t('auth_remembered')}{' '}
              <button onClick={() => switchMode('login')} className="text-white/60 font-semibold underline">{t('auth_back_to_login')}</button>
            </>
          ) : mode === 'login' ? (
            <>
              {t('auth_no_account')}{' '}
              <button onClick={() => switchMode('signup')} className="text-white/60 font-semibold underline">Sign Up</button>
            </>
          ) : (
            <>
              {t('auth_have_account')}{' '}
              <button onClick={() => switchMode('login')} className="text-white/60 font-semibold underline">Login</button>
            </>
          )}
        </p>
      </div>
      )}
    </div>
  );
}
