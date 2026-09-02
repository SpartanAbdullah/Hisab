import { useEffect, useState } from 'react';
import { BarChart3, Check, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import {
  hasTelemetryConsent,
  isTelemetryConfigured,
  setTelemetryConsent,
  subscribeTelemetryConsent,
} from '../lib/telemetry';

// Settings card for the opt-in usage-stats toggle (audit 2026-09 report 10
// §5.2 rule 4). Self-contained on purpose: drop
//   <TelemetryConsentToggle />
// into the "Data & backup" or "About & legal" group in SettingsPage and it
// needs nothing else.
//
// Consent is DEVICE-level (localStorage), DEFAULT OFF. Report 10 left
// default-on-vs-off to counsel; this ships OFF, which is the safe default for
// PK/UAE users and cannot become wrong after legal review — only more generous.
//
// The disclosure below is not marketing copy: it is the user-facing statement
// of the schema in src/lib/telemetryEvents.ts, where "no free text, no amounts"
// is structurally enforced. Keep the two in sync.

export function TelemetryConsentToggle() {
  const t = useT();
  const configured = isTelemetryConfigured();
  const [granted, setGranted] = useState(() => hasTelemetryConsent());

  // Another surface (a future onboarding disclosure step) can flip consent too.
  useEffect(() => subscribeTelemetryConsent(setGranted), []);

  const toggle = () => {
    const next = !granted;
    setTelemetryConsent(next, 'settings');
    setGranted(next);
  };

  return (
    <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
          <BarChart3 size={16} className="text-accent-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink-900">{t('tlm_consent_title')}</p>
          <p className="text-[11px] text-ink-500">{t('tlm_consent_sub')}</p>
        </div>
        <button
          onClick={toggle}
          disabled={!configured}
          aria-pressed={granted}
          aria-label={t('tlm_consent_title')}
          className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-40 ${granted ? 'bg-receive-600' : 'bg-cream-border'}`}
        >
          <span
            className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${granted ? 'left-6' : 'left-1'}`}
          />
        </button>
      </div>

      <div className="px-4 pb-4 space-y-3">
        <p className="text-[11.5px] text-ink-500 leading-relaxed">{t('tlm_consent_body')}</p>

        <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-3 space-y-2">
          <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
            {t('tlm_consent_collected_title')}
          </p>
          {[t('tlm_consent_collected_1'), t('tlm_consent_collected_2'), t('tlm_consent_collected_3')].map((line) => (
            <div key={line} className="flex items-start gap-2">
              <Check size={12} strokeWidth={3} className="text-receive-text shrink-0 mt-0.5" />
              <p className="text-[11px] text-ink-600 leading-snug">{line}</p>
            </div>
          ))}
        </div>

        <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-3 space-y-2">
          <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
            {t('tlm_consent_never_title')}
          </p>
          {[t('tlm_consent_never_1'), t('tlm_consent_never_2'), t('tlm_consent_never_3')].map((line) => (
            <div key={line} className="flex items-start gap-2">
              <X size={12} strokeWidth={3} className="text-pay-text shrink-0 mt-0.5" />
              <p className="text-[11px] text-ink-600 leading-snug">{line}</p>
            </div>
          ))}
        </div>

        <p className="text-[10.5px] text-ink-400 leading-relaxed">
          {configured ? t('tlm_consent_off_note') : t('tlm_consent_unavailable')}
        </p>
      </div>
    </div>
  );
}
