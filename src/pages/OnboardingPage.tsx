import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { profilesDb } from '../lib/supabaseDb';
import { track } from '../lib/telemetry';
import type { Language } from '../lib/i18n';
import { ArrowRight, Play, Shield, Globe, Users, BarChart3, CheckCircle, Sparkles } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { MODE_QUIZ, recommendMode } from '../lib/modeQuiz';
import { useOnboardingStore } from '../stores/onboardingStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useAccountStore } from '../stores/accountStore';
import { useI18nStore, useT } from '../lib/i18n';
import { Button } from '../components/Button';
import { SUPPORTED_CURRENCIES, type Currency, type AppMode, type AccountType } from '../db';
import { currencyMeta } from '../lib/design-tokens';

// Hoisted out of OnboardingPage — components defined inside a parent render
// body lose state on every re-render (react-hooks/static-components).
function LangBtn({ lang, setLang }: { lang: Language; setLang: (l: Language) => void }) {
  return (
    <button
      onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
      className="absolute top-5 right-5 z-50 bg-white/10 text-white/80 rounded-xl px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all backdrop-blur-sm border border-white/10 min-h-[44px]"
    >
      <Globe size={11} /> {lang === 'ur' ? 'EN' : 'UR'}
    </button>
  );
}

// Continuous 5-dot progress for the post-welcome steps (1–5). The active step
// fills brighter; completed steps stay lit so the journey reads as honest and
// continuous rather than five disconnected "STEP n of 5" counters. Welcome
// (step 0) is uncounted and never renders this row.
function StepDots({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <div className="flex items-center gap-1.5 mb-3" role="presentation" aria-label={`Step ${current} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            n === current ? 'w-6 bg-white' : n < current ? 'w-1.5 bg-white/60' : 'w-1.5 bg-white/20'
          }`}
        />
      ))}
    </div>
  );
}

// The intent answer routes the user's FIRST DAY: which tab they land on and
// which differentiator they meet first. Someone who came for udhaar should be
// logging a loan in minute one, not staring at an expense tracker.
type OnboardIntent = 'spending' | 'loans' | 'kameti' | 'splits' | 'budgets';

const INTENT_OPTIONS: Array<{ value: OnboardIntent; emoji: string; labelKey: string; leansTo: AppMode }> = [
  { value: 'spending', emoji: '\u{1F4B8}', labelKey: 'onboard_intent_spending', leansTo: 'full_tracker' },
  { value: 'loans', emoji: '\u{1F91D}', labelKey: 'onboard_intent_loans', leansTo: 'full_tracker' },
  { value: 'kameti', emoji: '\u{1F465}', labelKey: 'onboard_intent_kameti', leansTo: 'full_tracker' },
  { value: 'splits', emoji: '\u{1F9FE}', labelKey: 'onboard_intent_splits', leansTo: 'splits_only' },
  { value: 'budgets', emoji: '\u{1F3AF}', labelKey: 'onboard_intent_budgets', leansTo: 'full_tracker' },
];

const INTENT_LANDING: Record<OnboardIntent, string> = {
  spending: '/',
  loans: '/loans',
  kameti: '/kameti',
  splits: '/groups',
  budgets: '/budgets',
};

export function OnboardingPage() {
  const { completeOnboarding } = useOnboardingStore();
  const { setMode } = useAppModeStore();
  const { lang, setLang } = useI18nStore();
  const t = useT();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('AED');
  const [selectedMode, setSelectedMode] = useState<AppMode>('full_tracker');
  const [intent, setIntent] = useState<OnboardIntent | null>(null);
  const [loading, setLoading] = useState(false);

  // Mode quiz state. Each answer leans toward a mode; on completion we suggest
  // one (the user can still pick either). Skip jumps straight to the cards.
  const [quizAnswers, setQuizAnswers] = useState<AppMode[]>([]);
  const [quizSkipped, setQuizSkipped] = useState(false);
  const quizComplete = quizAnswers.length === MODE_QUIZ.length;
  const quizDone = quizComplete || quizSkipped;
  const recommended = recommendMode(quizAnswers);
  const answerQuiz = (leansTo: AppMode) => {
    const next = [...quizAnswers, leansTo];
    setQuizAnswers(next);
    if (next.length === MODE_QUIZ.length) setSelectedMode(recommendMode(next));
  };

  // Catalog #5. Fired once, when the user leaves the mode screen with a choice
  // committed — the direct measure of "did the quiz put people in the right
  // mode" (report 10 funnel 2). `was_default_kept` is false whenever they
  // overrode the recommendation, which is the quiz-mislead signal.
  const confirmModeSelection = () => {
    track('onboarding_mode_selected', {
      mode: selectedMode,
      quiz_intent: intent ?? 'none',
      was_default_kept: !quizSkipped && selectedMode === recommended,
      quiz_skipped: quizSkipped,
    });
  };

  // Activation funnel, catalog #4: one event per step entered. The biggest
  // drop between consecutive `step` values IS the onboarding problem — today
  // that is unknowable (audit 2026-09 report 10, F1).
  useEffect(() => {
    track('onboarding_step_viewed', { step });
  }, [step]);

  // First-account fields — only used (and only shown) for full_tracker.
  const [acctType, setAcctType] = useState<AccountType>('cash');
  const [acctName, setAcctName] = useState('');
  const [acctBalance, setAcctBalance] = useState('');
  // Opening balance may be blank (= 0) but never negative or non-numeric.
  const acctBalanceValid =
    acctBalance.trim() === '' ||
    (Number.isFinite(parseFloat(acctBalance)) && parseFloat(acctBalance) >= 0);

  // Finish onboarding. For full_tracker, optionally create the first account so
  // the user lands ready; account creation is best-effort and never blocks.
  const handleFinish = async (withAccount: boolean) => {
    if (!name.trim()) return;
    setLoading(true);
    setMode(selectedMode);
    let accountCreated = false;
    if (withAccount && selectedMode === 'full_tracker' && acctName.trim()) {
      try {
        await useAccountStore.getState().createAccount({
          name: acctName.trim(), type: acctType, currency, balance: Math.max(0, parseFloat(acctBalance) || 0),
        });
        accountCreated = true;
        // Catalog #7 for the onboarding source. The accounts-page source is
        // owned by AddAccountStepper (see the telemetry follow-up list).
        track('account_created', { account_type: acctType, is_first: true, source: 'onboarding' });
      } catch (err) {
        console.error('onboarding account create failed (non-fatal)', err);
      }
    }
    await completeOnboarding(name.trim(), currency, selectedMode);
    // Catalog #6 — the activation funnel's second milestone. `mode` here is the
    // fork the whole app branches on, so every downstream cohort splits by it.
    track('onboarding_completed', {
      mode: selectedMode,
      language: lang,
      currency,
      created_first_account: accountCreated,
    });
    // Land the user where their stated intent lives — locally instant,
    // durably mirrored to the profile (best-effort; column may not exist
    // until the migration is applied).
    if (intent) {
      localStorage.setItem('hisaab_onboarding_intent', intent);
      profilesDb.updateCurrent({ onboarding_intent: intent }).catch(() => {});
      const dest = INTENT_LANDING[intent];
      if (dest !== '/') navigate(dest, { replace: true });
    }
  };

  return (
    <div className="min-h-dvh relative overflow-y-auto overflow-x-hidden bg-navy-bloom">
      {/* Background — Sukoon navy + bloom. The .bg-navy-bloom class layers the
          two-radial gradient (violet from top-right, coral from bottom-left)
          over a navy-800 base. */}

      {/* Language toggle */}
      <LangBtn lang={lang} setLang={setLang} />

      {/* Content */}
      <div className="relative text-white flex flex-col min-h-dvh">

        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
            <div className="w-20 h-20 rounded-[21px] mb-8 animate-bounce-in shadow-lg shadow-black/30">
              <BrandMark size={80} />
            </div>
            <h1 className="text-4xl font-bold tracking-tighter">{t('auth_brand_name')}</h1>
            <p className="text-white/85 text-[15px] leading-relaxed max-w-[280px] mt-4 font-medium">
              {t('onboard_tagline')}
            </p>
            <p className="text-white/55 text-[12px] leading-relaxed max-w-[260px] mt-2">
              {t('onboard_tagline_sub')}
            </p>
            <div className="mt-8 space-y-3 text-left w-full max-w-[280px]">
              {[
                // Trust leads: our permanent constraint IS the promise — no
                // bank sync means nothing to break and nothing to leak.
                { icon: '\u{1F512}', text: t('onboard_bullet_0') },
                { icon: '\u{1F91D}', text: t('onboard_bullet_1') },
                { icon: '\u{1F4CB}', text: t('onboard_bullet_2') },
                { icon: '\u{1F514}', text: t('onboard_bullet_3') },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 bg-white/8 rounded-2xl px-4 py-3 border border-white/10 backdrop-blur-sm">
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-[13px] text-white/90 font-medium">{item.text}</span>
                </div>
              ))}
            </div>
            {/* Language confirmation — default is Roman Urdu (DEFAULT_LANGUAGE in
                src/lib/i18n.ts); the user can switch to English right at the
                start (also toggleable any time via the corner button and in
                Settings). */}
            <div className="mt-8 w-full max-w-[280px]">
              <p className="text-white/50 text-[11px] font-medium uppercase tracking-widest mb-2 text-left">{t('onboard_language_label')}</p>
              <div className="grid grid-cols-2 gap-2">
                {(['en', 'ur'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    className={`p-3 rounded-2xl border-2 text-center transition-all duration-200 backdrop-blur-sm ${
                      lang === l
                        ? 'border-white/40 bg-white/15 scale-[1.02] shadow-lg shadow-white/5'
                        : 'border-white/10 bg-white/5 active:scale-[0.98]'
                    }`}
                  >
                    <p className="font-bold text-[13px] tracking-tight text-white">{l === 'en' ? t('lang_en') : t('lang_ur')}</p>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-6 w-full max-w-[280px]">
              <Button variant="secondary" size="lg" onClick={() => setStep(1)} icon={<ArrowRight size={16} />}>
                {t('onboard_start')}
              </Button>
            </div>
            <p className="text-white/40 text-[11px] mt-5 tracking-wide">{t('onboard_footer')}</p>
          </div>
        )}

        {/* Step 1: Name + Currency */}
        {step === 1 && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-8">
              <StepDots current={1} />
              <h2 className="text-2xl font-bold tracking-tight text-white">{t('onboard_your_name')}</h2>
              <p className="text-white/60 text-[13px] mt-2">{t('onboard_name_sub')}</p>
            </div>
            <div className="space-y-6">
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_name_label')}</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder={t('onboard_name_placeholder')}
                  className="w-full bg-white/8 border border-white/15 rounded-2xl px-4 py-4 text-white placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/30 text-[15px] tracking-tight backdrop-blur-sm transition-all" autoFocus />
              </div>
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_currency_label')}</label>
                <p className="text-[11px] text-white/45 leading-relaxed mb-3">{t('onboard_currency_help')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {SUPPORTED_CURRENCIES.map(c => {
                    const meta = currencyMeta[c];
                    return (
                    <button key={c} type="button" onClick={() => setCurrency(c)}
                      className={`p-3 rounded-2xl border-2 text-left transition-all duration-200 backdrop-blur-sm ${currency === c ? 'border-white/40 bg-white/15 scale-[1.02] shadow-lg shadow-white/5' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                      <span className="text-xl">{meta.flag}</span>
                      <p className="font-bold text-[13px] mt-1.5 tracking-tight text-white">{c}</p>
                      <p className="text-[11px] text-white/50">{meta.name}</p>
                    </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-auto pb-8">
              <Button variant="secondary" size="lg" onClick={() => setStep(2)} disabled={!name.trim()} icon={<ArrowRight size={16} />}>
                {t('onboard_next')}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Intent — "what brings you here" routes the first day */}
        {step === 2 && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-6">
              <StepDots current={2} />
              <h2 className="text-2xl font-bold tracking-tight text-white">{t('onboard_intent_title')}</h2>
              <p className="text-white/60 text-[13px] mt-2 leading-relaxed">{t('onboard_intent_sub')}</p>
            </div>
            <div className="space-y-3 flex-1">
              {INTENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setIntent(opt.value);
                    setSelectedMode(opt.leansTo);
                    setStep(3);
                  }}
                  className="w-full flex items-center gap-3.5 rounded-2xl border-2 border-white/10 bg-white/5 px-4 py-4 text-left active:scale-[0.98] transition-all backdrop-blur-sm"
                >
                  <span className="text-2xl shrink-0">{opt.emoji}</span>
                  <span className="text-[13.5px] text-white/90 font-medium leading-snug">{t(opt.labelKey as Parameters<typeof t>[0])}</span>
                </button>
              ))}
            </div>
            <div className="pb-6">
              <button onClick={() => setStep(3)} className="text-[12px] text-white/45 w-full text-center min-h-[44px] font-medium">{t('onboard_intent_skip')}</button>
              <button onClick={() => setStep(1)} className="text-[11px] text-white/30 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}

        {/* Step 3: Safety Reassurance */}
        {step === 3 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <div className="flex justify-center mb-3">
              <StepDots current={3} />
            </div>
            <div className="flex items-center justify-center mb-6">
              <div className="w-16 h-16 rounded-3xl bg-receive-600/25 flex items-center justify-center backdrop-blur-sm border border-receive-600/30">
                <Shield size={32} className="text-receive-50" strokeWidth={1.5} />
              </div>
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-center mb-2 text-white">{t('onboard_safety_title')}</h2>
            <p className="text-white/50 text-[12px] text-center mb-6">{t('onboard_safety_sub')}</p>
            <div className="space-y-3">
              {[
                { text: t('onboard_safety_1'), sub: t('onboard_safety_1_sub') },
                { text: t('onboard_safety_2'), sub: t('onboard_safety_2_sub') },
                { text: t('onboard_safety_3'), sub: t('onboard_safety_3_sub') },
                { text: t('onboard_safety_4'), sub: t('onboard_safety_4_sub') },
                { text: t('onboard_safety_5'), sub: t('onboard_safety_5_sub') },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3 bg-white/8 rounded-2xl px-4 py-3 border border-white/10 backdrop-blur-sm">
                  <span className="text-receive-50 mt-0.5 text-sm shrink-0">✓</span>
                  <div>
                    <p className="text-[13px] text-white/90 font-medium leading-snug">{item.text}</p>
                    <p className="text-[10px] text-white/35 mt-0.5">{item.sub}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-auto pb-4">
              <Button variant="secondary" size="lg" onClick={() => setStep(4)} icon={<ArrowRight size={16} />}>
                {t('onboard_safety_btn')}
              </Button>
              <p className="text-white/25 text-[10px] text-center mt-3">{t('onboard_safety_footer')}</p>
            </div>
          </div>
        )}

        {/* Step 4: Mode quiz → recommendation */}
        {step === 4 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <StepDots current={4} />

            {!quizDone ? (
              /* ── Quiz: one fun question at a time ── */
              <>
                <div className="mb-5">
                  <h2 className="text-2xl font-bold tracking-tight text-white">{t('quiz_title')}</h2>
                  <p className="text-white/60 text-[13px] mt-2 leading-relaxed">{t('quiz_sub')}</p>
                </div>
                <p className="text-white/40 text-[11px] font-semibold uppercase tracking-widest mb-4">
                  {t('quiz_progress').replace('{n}', String(quizAnswers.length + 1)).replace('{total}', String(MODE_QUIZ.length))}
                </p>
                <div className="flex-1">
                  <p className="text-white text-[17px] font-bold mb-5 leading-snug">{t(MODE_QUIZ[quizAnswers.length].promptKey as Parameters<typeof t>[0])}</p>
                  <div className="space-y-3">
                    {MODE_QUIZ[quizAnswers.length].options.map((opt) => (
                      <button
                        key={opt.labelKey}
                        onClick={() => answerQuiz(opt.leansTo)}
                        className="w-full flex items-center gap-3.5 rounded-2xl border-2 border-white/10 bg-white/5 px-4 py-4 text-left active:scale-[0.98] transition-all backdrop-blur-sm"
                      >
                        <span className="text-2xl shrink-0">{opt.emoji}</span>
                        <span className="text-[13.5px] text-white/90 font-medium leading-snug">{t(opt.labelKey as Parameters<typeof t>[0])}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pb-6">
                  <button onClick={() => setQuizSkipped(true)} className="text-[12px] text-white/45 w-full text-center min-h-[44px] font-medium">{t('quiz_skip')}</button>
                  <button onClick={() => setStep(3)} className="text-[11px] text-white/30 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
                </div>
              </>
            ) : (
              /* ── Result: recommendation + both mode cards (still selectable) ── */
              <>
                <div className="mb-4">
                  <h2 className="text-2xl font-bold tracking-tight text-white">{t('mode_select_title')}</h2>
                </div>

                {!quizSkipped && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-2xl bg-accent-500/20 border border-accent-500/30 px-4 py-3 backdrop-blur-sm animate-fade-in">
                    <Sparkles size={15} className="text-accent-100 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-white/90 font-medium leading-snug">
                      {t('quiz_reco')}{' '}
                      <span className="font-bold text-white">{recommended === 'full_tracker' ? t('mode_full_title') : t('mode_splits_title')}</span>
                    </p>
                  </div>
                )}

                <div className="space-y-4 flex-1">
                  {/* Full Tracker */}
                  <button onClick={() => setSelectedMode('full_tracker')}
                    className={`w-full border-2 rounded-3xl p-5 text-left transition-all duration-300 backdrop-blur-sm ${selectedMode === 'full_tracker' ? 'border-warn-600/60 bg-warn-600/20 scale-[1.02] shadow-lg shadow-warn-600/15 ring-1 ring-warn-600/30' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${selectedMode === 'full_tracker' ? 'bg-warn-600/30' : 'bg-warn-600/20'}`}>
                        <BarChart3 size={20} className="text-warn-50" strokeWidth={1.5} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`font-bold text-[14px] tracking-tight ${selectedMode === 'full_tracker' ? 'text-white' : 'text-white/80'}`}>{t('mode_full_title')}</p>
                          {!quizSkipped && recommended === 'full_tracker' && (
                            <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-600">{t('quiz_for_you')}</span>
                          )}
                        </div>
                        <p className={`text-[11px] ${selectedMode === 'full_tracker' ? 'text-warn-50/85' : 'text-white/40'}`}>{t('mode_full_sub')}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5 ml-14">
                      <p className={`text-[11px] ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_1')}</p>
                      <p className={`text-[11px] ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_2')}</p>
                      <p className={`text-[11px] ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_3')}</p>
                    </div>
                  </button>

                  {/* Splits Only */}
                  <button onClick={() => setSelectedMode('splits_only')}
                    className={`w-full border-2 rounded-3xl p-5 text-left transition-all duration-300 backdrop-blur-sm ${selectedMode === 'splits_only' ? 'border-accent-500/60 bg-accent-500/20 scale-[1.02] shadow-lg shadow-accent-500/15 ring-1 ring-accent-500/30' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${selectedMode === 'splits_only' ? 'bg-accent-500/30' : 'bg-accent-500/20'}`}>
                        <Users size={20} className="text-accent-100" strokeWidth={1.5} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`font-bold text-[14px] tracking-tight ${selectedMode === 'splits_only' ? 'text-white' : 'text-white/80'}`}>{t('mode_splits_title')}</p>
                          {!quizSkipped && recommended === 'splits_only' && (
                            <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-600">{t('quiz_for_you')}</span>
                          )}
                        </div>
                        <p className={`text-[11px] ${selectedMode === 'splits_only' ? 'text-accent-100/70' : 'text-white/40'}`}>{t('mode_splits_sub')}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5 ml-14">
                      <p className={`text-[11px] ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_1')}</p>
                      <p className={`text-[11px] ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_2')}</p>
                      <p className={`text-[11px] ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_3')}</p>
                    </div>
                  </button>

                  <p className="text-white/45 text-[11px] text-center px-2">{t('onboard_switch_anytime')}</p>
                </div>

                <div className="pb-4">
                  <Button variant="secondary" size="lg" onClick={() => { confirmModeSelection(); setStep(5); }} icon={<ArrowRight size={16} />}>
                    {t('onboard_next')}
                  </Button>
                  <button onClick={() => { setQuizAnswers([]); setQuizSkipped(false); }} className="text-[11px] text-white/40 w-full text-center min-h-[44px] mt-2 font-medium">
                    {t('quiz_retake')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 5 (full_tracker): create the first account so the user lands ready */}
        {step === 5 && selectedMode === 'full_tracker' && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <div className="mb-6">
              <StepDots current={5} />
              <h2 className="text-2xl font-bold tracking-tight text-white">{name.trim()}, {t('onboard_acct_title')}</h2>
              <p className="text-white/60 text-[13px] mt-2 leading-relaxed">{t('onboard_acct_sub')}</p>
            </div>
            <div className="space-y-5 flex-1">
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_acct_type')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {([['cash', '\u{1F4B5}', 'acct_type_cash'], ['bank', '\u{1F3E6}', 'acct_type_bank'], ['digital_wallet', '\u{1F4F1}', 'acct_type_wallet']] as const).map(([ty, emoji, key]) => (
                    <button key={ty} type="button" onClick={() => setAcctType(ty)}
                      className={`p-3 rounded-2xl border-2 text-center transition-all backdrop-blur-sm ${acctType === ty ? 'border-white/40 bg-white/15 scale-[1.02]' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                      <span className="text-xl">{emoji}</span>
                      <p className="font-bold text-[12px] mt-1 text-white">{t(key)}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_acct_name')}</label>
                <input value={acctName} onChange={e => setAcctName(e.target.value)} placeholder={t('onboard_acct_name_ph')}
                  className="w-full bg-white/8 border border-white/15 rounded-2xl px-4 py-4 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/30 text-[15px] backdrop-blur-sm" autoFocus />
              </div>
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_acct_balance')}</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 text-[13px] font-semibold">{currency}</span>
                  <input type="number" inputMode="decimal" value={acctBalance} onChange={e => setAcctBalance(e.target.value)} placeholder="0.00"
                    className="w-full bg-white/8 border border-white/15 rounded-2xl pl-16 pr-4 py-4 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/30 text-[15px] tabular-nums backdrop-blur-sm" />
                </div>
                {!acctBalanceValid && <p className="text-[11px] text-[#F2967C] mt-1.5 font-medium">{t('val_balance_invalid')}</p>}
              </div>
            </div>
            {loading && (
              <div className="text-center py-4">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto" />
                <p className="text-[12px] text-white/50 mt-3">{t('onboard_loading')}</p>
              </div>
            )}
            <div className="pb-6 space-y-1">
              <Button variant="secondary" size="lg" onClick={() => handleFinish(true)} disabled={loading || !acctName.trim() || !acctBalanceValid} icon={<ArrowRight size={16} />}>
                {t('onboard_acct_create')}
              </Button>
              <button onClick={() => handleFinish(false)} disabled={loading} className="text-[12px] text-white/45 w-full text-center min-h-[44px] font-medium">{t('onboard_acct_skip')}</button>
              <button onClick={() => setStep(4)} className="text-[11px] text-white/30 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}

        {/* Step 5 (splits_only): fresh start — no account needed */}
        {step === 5 && selectedMode === 'splits_only' && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-8">
              <StepDots current={5} />
              <h2 className="text-2xl font-bold tracking-tight text-white">{name.trim()}, {t('onboard_how_start')}</h2>
              <p className="text-white/60 text-[13px] mt-2">{t('onboard_how_sub')}</p>
              <p className="text-receive-50 text-[12px] font-semibold mt-3">{t('onboard_start_instruction')}</p>
            </div>
            <div className="space-y-4 flex-1">
              <button onClick={() => handleFinish(false)} disabled={loading}
                className="w-full bg-white/8 border-2 border-receive-600/50 rounded-3xl p-6 text-left transition-all active:scale-[0.98] backdrop-blur-sm hover:bg-white/12 shadow-lg shadow-receive-600/15">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-11 h-11 rounded-2xl bg-receive-600/25 flex items-center justify-center backdrop-blur-sm">
                    <Play size={20} className="text-receive-50" strokeWidth={1.5} />
                  </div>
                  <div>
                    <p className="font-bold text-[14px] tracking-tight text-white">{t('onboard_fresh_title')}</p>
                    <p className="text-[11px] text-white/50">{t('onboard_fresh_sub')}</p>
                  </div>
                </div>
                <p className="text-[12px] text-white/40 leading-relaxed">
                  {selectedMode === 'splits_only' ? t('onboard_fresh_desc_splits') : t('onboard_fresh_desc')}
                </p>
                <div className="mt-5 space-y-2.5">
                  {(selectedMode === 'splits_only'
                    ? [
                        t('onboard_fresh_tip_iou'),
                        t('onboard_fresh_tip_groups'),
                        t('onboard_fresh_tip_contacts'),
                        t('onboard_fresh_tip_reminders'),
                      ]
                    : [
                        t('onboard_fresh_tip_cash'),
                        t('onboard_fresh_tip_bank'),
                        t('onboard_fresh_tip_savings'),
                        t('onboard_fresh_tip_loans'),
                        t('onboard_fresh_tip_transactions'),
                      ]).map((tip) => (
                    <div key={tip} className="flex items-start gap-2.5">
                      <CheckCircle size={14} className="text-receive-50 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-white/65 leading-snug">{tip}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-5 rounded-2xl bg-receive-600/25 border border-receive-600/30 py-3 text-center">
                  <span className="text-[13px] font-bold text-white">{t('onboard_fresh_cta')}</span>
                </div>
              </button>
              <div className="bg-white/8 border border-white/10 rounded-2xl p-4">
                <p className="text-[12px] text-white/75 leading-relaxed">{t('onboard_linked_contacts_help')}</p>
              </div>
            </div>
            {loading && (
              <div className="text-center py-6">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto" />
                <p className="text-[12px] text-white/50 mt-3">{t('onboard_loading')}</p>
              </div>
            )}
            <div className="pb-8">
              <button onClick={() => setStep(4)} className="text-[11px] text-white/30 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
