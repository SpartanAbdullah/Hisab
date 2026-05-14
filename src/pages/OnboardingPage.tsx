import { useState } from 'react';
import { Wallet, ArrowRight, Play, Shield, Globe, Users, BarChart3, CheckCircle } from 'lucide-react';
import { useOnboardingStore } from '../stores/onboardingStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useI18nStore, useT } from '../lib/i18n';
import { Button } from '../components/Button';
import { SUPPORTED_CURRENCIES, type Currency, type AppMode } from '../db';
import { currencyMeta } from '../lib/design-tokens';

export function OnboardingPage() {
  const { completeOnboarding } = useOnboardingStore();
  const { setMode } = useAppModeStore();
  const { lang, setLang } = useI18nStore();
  const t = useT();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('AED');
  const [selectedMode, setSelectedMode] = useState<AppMode>('full_tracker');
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setMode(selectedMode);
    await completeOnboarding(name.trim(), currency, selectedMode);
  };

  // Language toggle — shown on every step
  const LangBtn = () => (
    <button
      onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
      className="absolute top-5 right-5 z-50 bg-white/10 text-white/80 rounded-xl px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all backdrop-blur-sm border border-white/10"
    >
      <Globe size={11} /> {lang === 'ur' ? 'EN' : 'UR'}
    </button>
  );

  return (
    <div className="min-h-dvh relative overflow-y-auto overflow-x-hidden bg-navy-bloom">
      {/* Background — Sukoon navy + bloom. The .bg-navy-bloom class layers the
          two-radial gradient (violet from top-right, coral from bottom-left)
          over a navy-800 base. */}

      {/* Language toggle */}
      <LangBtn />

      {/* Content */}
      <div className="relative text-white flex flex-col min-h-dvh">

        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
            <div className="w-20 h-20 rounded-3xl bg-white/10 flex items-center justify-center mb-8 animate-bounce-in backdrop-blur-sm border border-white/10">
              <Wallet size={36} strokeWidth={1.5} />
            </div>
            <h1 className="text-4xl font-bold tracking-tighter">Hisaab</h1>
            <p className="text-white/80 text-[15px] leading-relaxed max-w-[260px] mt-4">
              {t('onboard_tagline')}
            </p>
            <div className="mt-8 space-y-3 text-left w-full max-w-[280px]">
              {[
                { icon: '\u{1F91D}', text: t('onboard_bullet_1') },
                { icon: '\u{1F4CB}', text: t('onboard_bullet_2') },
                { icon: '\u{1F514}', text: t('onboard_bullet_3') },
                { icon: '\u{1F4B3}', text: t('onboard_bullet_4') },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 bg-white/8 rounded-2xl px-4 py-3 border border-white/10 backdrop-blur-sm">
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-[13px] text-white/90 font-medium">{item.text}</span>
                </div>
              ))}
            </div>
            <div className="mt-10 w-full max-w-[280px]">
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
              <p className="text-white/50 text-[10px] font-bold uppercase tracking-[0.2em] mb-3">STEP 1 {t('onboard_step_of')} 4</p>
              <h2 className="text-2xl font-bold tracking-tight text-white">{t('onboard_your_name')}</h2>
              <p className="text-white/60 text-[13px] mt-2">{t('onboard_name_sub')}</p>
            </div>
            <div className="space-y-6">
              <div>
                <label className="block text-[11px] text-white/50 font-medium uppercase tracking-widest mb-2">{t('onboard_name_label')}</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ahmed, Faizan, Bilal"
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

        {/* Step 2: Safety Reassurance */}
        {step === 2 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
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
              <Button variant="secondary" size="lg" onClick={() => setStep(3)} icon={<ArrowRight size={16} />}>
                {t('onboard_safety_btn')}
              </Button>
              <p className="text-white/25 text-[10px] text-center mt-3">{t('onboard_safety_footer')}</p>
            </div>
          </div>
        )}

        {/* Step 3: Mode Selection */}
        {step === 3 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <div className="mb-6">
              <p className="text-white/50 text-[10px] font-bold uppercase tracking-[0.2em] mb-3">STEP 3 {t('onboard_step_of')} 4</p>
              <h2 className="text-2xl font-bold tracking-tight text-white">{t('mode_select_title')}</h2>
              <p className="text-white/60 text-[13px] mt-2">{t('mode_select_sub')}</p>
            </div>

            <div className="space-y-4 flex-1">
              {/* Splits Only */}
              <button onClick={() => setSelectedMode('splits_only')}
                className={`w-full border-2 rounded-3xl p-5 text-left transition-all duration-300 backdrop-blur-sm ${selectedMode === 'splits_only' ? 'border-accent-500/60 bg-accent-500/20 scale-[1.02] shadow-lg shadow-accent-500/15 ring-1 ring-accent-500/30' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${selectedMode === 'splits_only' ? 'bg-accent-500/30' : 'bg-accent-500/20'}`}>
                    <Users size={20} className={`transition-colors ${selectedMode === 'splits_only' ? 'text-accent-100' : 'text-accent-100'}`} strokeWidth={1.5} />
                  </div>
                  <div>
                    <p className={`font-bold text-[14px] tracking-tight transition-colors ${selectedMode === 'splits_only' ? 'text-white' : 'text-white/80'}`}>{t('mode_splits_title')}</p>
                    <p className={`text-[11px] transition-colors ${selectedMode === 'splits_only' ? 'text-accent-100/70' : 'text-white/40'}`}>{t('mode_splits_sub')}</p>
                  </div>
                </div>
                <div className="space-y-1.5 ml-14">
                  <p className={`text-[11px] transition-colors ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_1')}</p>
                  <p className={`text-[11px] transition-colors ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_2')}</p>
                  <p className={`text-[11px] transition-colors ${selectedMode === 'splits_only' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_splits_3')}</p>
                </div>
              </button>

              {/* Full Tracker */}
              <button onClick={() => setSelectedMode('full_tracker')}
                className={`w-full border-2 rounded-3xl p-5 text-left transition-all duration-300 backdrop-blur-sm ${selectedMode === 'full_tracker' ? 'border-warn-600/60 bg-warn-600/20 scale-[1.02] shadow-lg shadow-warn-600/15 ring-1 ring-warn-600/30' : 'border-white/10 bg-white/5 active:scale-[0.98]'}`}>
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${selectedMode === 'full_tracker' ? 'bg-warn-600/30' : 'bg-warn-600/20'}`}>
                    <BarChart3 size={20} className={`transition-colors ${selectedMode === 'full_tracker' ? 'text-warn-50' : 'text-warn-50'}`} strokeWidth={1.5} />
                  </div>
                  <div>
                    <p className={`font-bold text-[14px] tracking-tight transition-colors ${selectedMode === 'full_tracker' ? 'text-white' : 'text-white/80'}`}>{t('mode_full_title')}</p>
                    <p className={`text-[11px] transition-colors ${selectedMode === 'full_tracker' ? 'text-warn-50/85' : 'text-white/40'}`}>{t('mode_full_sub')}</p>
                  </div>
                </div>
                <div className="space-y-1.5 ml-14">
                  <p className={`text-[11px] transition-colors ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_1')}</p>
                  <p className={`text-[11px] transition-colors ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_2')}</p>
                  <p className={`text-[11px] transition-colors ${selectedMode === 'full_tracker' ? 'text-white/70' : 'text-white/40'}`}>• {t('mode_full_3')}</p>
                </div>
              </button>
            </div>

            <div className="pb-4">
              <Button variant="secondary" size="lg" onClick={() => setStep(4)} icon={<ArrowRight size={16} />}>
                {t('onboard_next')}
              </Button>
              <button onClick={() => setStep(2)} className="text-[11px] text-white/30 w-full text-center py-2 mt-2 font-medium">
                {t('onboard_back')}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Fresh Start */}
        {step === 4 && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-8">
              <p className="text-white/50 text-[10px] font-bold uppercase tracking-[0.2em] mb-3">STEP 4 {t('onboard_step_of')} 4</p>
              <h2 className="text-2xl font-bold tracking-tight text-white">{name.trim()}, {t('onboard_how_start')}</h2>
              <p className="text-white/60 text-[13px] mt-2">{t('onboard_how_sub')}</p>
              <p className="text-receive-50 text-[12px] font-semibold mt-3">{t('onboard_start_instruction')}</p>
            </div>
            <div className="space-y-4 flex-1">
              <button onClick={handleStart} disabled={loading}
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
              <button onClick={() => setStep(3)} className="text-[11px] text-white/30 w-full text-center py-2 font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
