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
    <div className="fixed inset-0 z-[70] flex items-end justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy-900/50 backdrop-blur-sm animate-fade-in" onClick={dismiss} />
      <div
        className="relative w-full max-w-[480px] bg-cream-bg rounded-t-[26px] p-6 pb-[max(28px,env(safe-area-inset-bottom))] animate-slide-up"
        style={{ boxShadow: '0 -20px 60px -20px rgba(11,14,42,0.4)' }}
      >
        <button onClick={dismiss} className="absolute right-4 top-4 w-8 h-8 rounded-xl flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors" aria-label={t('cancel')}>
          <X size={16} />
        </button>
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent-100 to-accent-50 text-accent-600 flex items-center justify-center mb-4">
          <Lightbulb size={22} strokeWidth={1.9} />
        </div>
        <p className="text-[10.5px] font-semibold text-accent-600 uppercase tracking-[0.14em]">{t('quote_daily_title')}</p>
        <p className="text-[19px] font-semibold text-ink-900 leading-snug tracking-tight mt-2">&ldquo;{quote.text}&rdquo;</p>
        <p className="text-[12.5px] text-ink-500 mt-3 font-medium">&mdash; {quote.author}</p>

        <div className="flex gap-2.5 mt-6">
          <button onClick={dismiss} className="flex-1 py-3.5 rounded-2xl bg-ink-900 text-white text-[13px] font-bold press">
            {t('quote_got_it')}
          </button>
          <button onClick={share} className="px-5 rounded-2xl bg-cream-card border border-cream-border text-ink-700 text-[13px] font-semibold flex items-center gap-2 active:bg-cream-soft transition-colors">
            <Share2 size={15} /> {t('quote_share')}
          </button>
        </div>
        <button onClick={turnOff} className="w-full text-center text-[11px] text-ink-400 mt-3 min-h-[44px]">{t('quote_turn_off')}</button>
      </div>
    </div>
  );
}
