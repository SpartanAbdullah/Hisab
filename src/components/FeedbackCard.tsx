import { useEffect, useState } from 'react';
import { MessageCircle, Mail, MessageSquare } from 'lucide-react';
import { useT } from '../lib/i18n';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { track } from '../lib/telemetry';

// Settings card that gives a confused-but-not-crashed user a way to speak
// (audit 2026-09 report 10, F3 — today the only channel is a support address
// buried on a public page, or the crash screen's mailto).
//
// Self-contained: drop <FeedbackCard /> into SettingsPage's "About & legal"
// group. Nothing else to wire.
//
// TODO(founder-contact): set VITE_FEEDBACK_WHATSAPP to the founder's number in
// international digits (e.g. 923001234567) in Vercel + the local .env before
// launch. Deliberately NOT hardcoded here — a personal number does not belong
// in the repo. With it unset, the WhatsApp button still works: wa.me opens the
// contact picker instead of a direct chat (see buildWhatsAppUrl).
const FEEDBACK_WHATSAPP = ((import.meta.env.VITE_FEEDBACK_WHATSAPP as string | undefined) ?? '').trim();
const FEEDBACK_EMAIL = ((import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined) ?? '').trim()
  || 'support@usehisaab.com';

// The typed note is a scratchpad ONLY. There is no backend for in-app feedback
// yet, so it is persisted to this device and never transmitted — the copy says
// so plainly rather than pretending a message was delivered.
const DRAFT_KEY = 'hisaab_feedback_draft';

export function FeedbackCard() {
  const t = useT();
  // Lazy initialiser, not an effect: the draft is known before first paint, so
  // there is no reason to render empty and then re-render with the text.
  const [note, setNote] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      // Storage blocked — the field simply starts empty.
      return '';
    }
  });
  const [savedAt, setSavedAt] = useState(0);

  // Debounced local save so a half-written thought survives a navigation.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        if (note.trim()) {
          localStorage.setItem(DRAFT_KEY, note);
          setSavedAt(Date.now());
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch {
        // ignore
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, [note]);

  // The draft rides along as the prefilled body so nothing has to be retyped.
  const body = note.trim() ? `${t('fbk_prefill')}\n\n${note.trim()}` : t('fbk_prefill');

  const openWhatsApp = () => {
    track('feedback_opened', { channel: 'whatsapp' });
    window.open(buildWhatsAppUrl(FEEDBACK_WHATSAPP || null, body), '_blank', 'noopener,noreferrer');
  };

  const openEmail = () => {
    track('feedback_opened', { channel: 'email' });
    const subject = encodeURIComponent(t('fbk_email_subject'));
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
          <MessageSquare size={16} className="text-accent-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink-900">{t('fbk_title')}</p>
          <p className="text-[11px] text-ink-500">{t('fbk_sub')}</p>
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={openWhatsApp}
            className="flex-1 min-h-[44px] rounded-2xl bg-receive-50 border border-receive-100 text-receive-text text-[12.5px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <MessageCircle size={15} />
            {t('fbk_whatsapp')}
          </button>
          <button
            onClick={openEmail}
            className="flex-1 min-h-[44px] rounded-2xl bg-cream-soft border border-cream-border text-ink-700 text-[12.5px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <Mail size={15} />
            {t('fbk_email')}
          </button>
        </div>

        <div>
          <label htmlFor="feedback-note" className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
            {t('fbk_note_label')}
          </label>
          <textarea
            id="feedback-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={t('fbk_note_ph')}
            className="w-full mt-1.5 border border-cream-border rounded-2xl px-4 py-3 text-sm bg-cream-card focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all resize-none"
          />
          <p className="text-[10.5px] text-ink-400 mt-1.5 leading-relaxed">
            {savedAt > 0 ? `${t('fbk_note_saved')} · ` : ''}
            {t('fbk_note_local_only')}
          </p>
        </div>
      </div>
    </div>
  );
}
