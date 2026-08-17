import { useEffect, useState } from 'react';
import { Lightbulb, Share2, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { quoteForDay } from '../lib/financeQuotes';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';

export const QUOTE_SHOWN_KEY = 'hisaab_quote_last_shown';
export const QUOTE_ENABLED_KEY = 'hisaab_daily_quote_enabled';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Once-a-day money-wisdom popup. Shows on the first app open of each calendar
// day (after a short delay so it doesn't fight the first paint), is easy to
// dismiss, shareable, and can be turned off entirely (here or in Settings).
export function DailyQuote() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [quote] = useState(() => quoteForDay());

  useEffect(() => {
    if (localStorage.getItem(QUOTE_ENABLED_KEY) === 'false') return;
    if (localStorage.getItem(QUOTE_SHOWN_KEY) === todayStr()) return;
    const timer = setTimeout(() => setOpen(true), 700);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(QUOTE_SHOWN_KEY, todayStr()); } catch { /* storage off — just close */ }
    setOpen(false);
  };

  const share = () => {
    const text = `"${quote.text}" — ${quote.author}`;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({ text }).catch(() => {});
    } else {
      window.open(buildWhatsAppUrl(null, text), '_blank');
    }
  };

  const turnOff = () => {
    try { localStorage.setItem(QUOTE_ENABLED_KEY, 'false'); } catch { /* ignore */ }
    dismiss();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="daily-wisdom-title"
    >
      <div className="absolute inset-0 bg-navy-900/60 backdrop-blur-sm animate-fade-in" onClick={dismiss} />

      {/* Rainbow frame. The drifting spectrum lives in this box and the cream
          card sits on top of it, so all that shows through is the 3px gutter
          between their two border radii — a moving colour outline, with no
          coloured pixel ever landing behind body text. */}
      <div
        className="relative w-full max-w-[380px] rounded-[30px] p-[3px] overflow-hidden animate-scale-in"
        style={{ boxShadow: '0 26px 70px -26px rgba(11,14,42,0.6)' }}
      >
        <div className="wisdom-spectrum" aria-hidden="true" />

        <div className="relative bg-cream-bg rounded-[27px] px-6 py-7 max-h-[85vh] overflow-y-auto">
          <div className="wisdom-wash pointer-events-none absolute inset-x-0 top-0 h-36" aria-hidden="true" />

          <button
            onClick={dismiss}
            className="absolute right-3.5 top-3.5 w-9 h-9 rounded-xl flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors"
            aria-label={t('cancel')}
          >
            <X size={16} />
          </button>

          <div className="relative text-center">
            {/* Same spectrum, second instance. The navy scrim over it keeps the
                white bulb legible across every band — white on the yellow
                stretch would otherwise all but vanish. */}
            <div className="relative w-14 h-14 rounded-2xl overflow-hidden mx-auto flex items-center justify-center">
              <div className="wisdom-spectrum" aria-hidden="true" />
              <div className="absolute inset-0 bg-navy-900/25" aria-hidden="true" />
              <Lightbulb size={26} strokeWidth={2} className="relative text-white" />
            </div>

            <p
              id="daily-wisdom-title"
              className="wisdom-text text-[10.5px] font-bold uppercase tracking-[0.16em] mt-4"
            >
              {t('quote_daily_title')}
            </p>
            <p className="text-[20px] font-semibold text-ink-900 leading-snug tracking-tight mt-2.5 text-balance">
              &ldquo;{quote.text}&rdquo;
            </p>
            <p className="text-[12.5px] text-ink-500 mt-3 font-medium">&mdash; {quote.author}</p>

            {/* Got it stays ink-900 on purpose: with this much colour around
                it, the one high-contrast block on screen is what reads as the
                action. A rainbow CTA would compete with its own frame. */}
            <div className="flex gap-2.5 mt-7">
              <button onClick={dismiss} className="flex-1 py-3.5 rounded-2xl bg-ink-900 text-white text-[13px] font-bold press">
                {t('quote_got_it')}
              </button>
              <button onClick={share} className="px-5 rounded-2xl bg-cream-card border border-cream-border text-ink-700 text-[13px] font-semibold flex items-center gap-2 active:bg-cream-soft transition-colors">
                <Share2 size={15} /> {t('quote_share')}
              </button>
            </div>
            <button onClick={turnOff} className="w-full text-center text-[11px] text-ink-400 mt-2 min-h-[44px]">{t('quote_turn_off')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
