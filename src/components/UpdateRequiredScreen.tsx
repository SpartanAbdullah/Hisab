import { Globe, ArrowUpCircle } from 'lucide-react';
import { useT, useI18nStore } from '../lib/i18n';
import { isNativeRuntime } from '../lib/runtime';
import { recoverFromStaleApp } from '../lib/appRecovery';
import { PLAY_STORE_URL, updateMessageFor, type AppVersionConfig } from '../lib/versionGate';

// Terminal screen for the minimum-supported-version gate (audit H9 / MF-12).
//
// Rendered by src/App.tsx when app_config's floor is above this build. It is a
// dead end BY DESIGN — no dismiss, no "later", no navigation — because the
// premise for showing it is that this binary can no longer be trusted to talk
// to the schema without corrupting money records. The only recoveries are
// getting a newer build, or an operator lowering the floor in Supabase Studio
// (which this screen picks up on the next launch/resume).
//
// Mode-agnostic: nothing here reads appModeStore. The skew it defends against
// is binary-vs-schema, which is identical for full_tracker and splits_only.
//
// Statically imported into App.tsx on purpose (like PinLockScreen): a lazy
// chunk that fails to load — offline, or against the very stale deploy that
// triggered this gate — must never be the reason the gate silently doesn't render.
export function UpdateRequiredScreen({
  config,
  version,
}: {
  config: AppVersionConfig | null;
  version: string;
}) {
  const t = useT();
  const { lang, setLang } = useI18nStore();

  // Server copy wins when an operator wrote one for this incident; otherwise
  // the bundled translation. Derived on every render so the language toggle
  // below re-picks message_ur / message_en immediately.
  const serverMessage = updateMessageFor(config, lang);
  const native = isNativeRuntime();

  const onUpdate = () => {
    if (native) {
      // Capacitor opens non-app http(s) URLs externally; the Play Store app
      // has an intent filter for this URL, so it deep-links into the listing.
      window.location.href = PLAY_STORE_URL;
      return;
    }
    // Web/PWA: the newest bundle is already deployed — the running tab is just
    // holding a stale one. Clear the hisaab-* caches + SW and reload.
    void recoverFromStaleApp();
  };

  return (
    <div className="min-h-dvh relative flex flex-col items-center justify-center bg-navy-bloom text-white px-8 text-center">
      <button
        onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
        className="absolute top-[max(20px,env(safe-area-inset-top))] right-5 z-50 bg-white/10 text-white/80 rounded-xl px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all backdrop-blur-sm border border-white/10 min-h-[44px]"
      >
        <Globe size={11} /> {lang === 'ur' ? 'EN' : 'UR'}
      </button>

      <div className="w-20 h-20 rounded-3xl bg-white/10 flex items-center justify-center mb-6 backdrop-blur-sm border border-white/15">
        <ArrowUpCircle size={34} className="text-white" />
      </div>

      <h1 className="text-2xl font-bold tracking-tight mb-3">{t('upd_required_title')}</h1>
      <p className="text-white/60 text-[13px] max-w-[300px] leading-relaxed">
        {serverMessage ?? t('upd_required_body')}
      </p>
      <p className="text-white/45 text-[12px] max-w-[290px] leading-relaxed mt-4">
        {t('upd_required_safe')}
      </p>

      <div className="w-full max-w-[300px] mt-8">
        <button
          onClick={onUpdate}
          className="w-full bg-white text-navy-900 rounded-2xl py-4 text-[14px] font-semibold active:scale-[0.98] transition-all shadow-lg shadow-white/10 min-h-[44px]"
        >
          {native ? t('upd_required_store') : t('upd_required_reload')}
        </button>
        {!native && (
          <p className="text-white/35 text-[11px] leading-relaxed mt-3">
            {t('upd_required_reload_hint')}
          </p>
        )}
      </div>

      {/* Version string so a support conversation can start with a fact rather
          than "the app says update". */}
      <p className="text-white/30 text-[11px] mt-8">
        {t('upd_required_version').replace('{version}', version)}
      </p>
    </div>
  );
}
