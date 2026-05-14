import { Globe } from 'lucide-react';
import { useI18nStore } from '../lib/i18n';

interface Props {
  // `on-navy` is the canonical Sukoon placement — inside a NavyHero TopBar
  // action slot. `on-cream` is for the legacy pages still using PageHeader
  // (Goals, Analytics, Activity) and any cream-body inline placements.
  tone?: 'on-navy' | 'on-cream';
}

export function LanguageToggle({ tone = 'on-navy' }: Props) {
  const { lang, setLang } = useI18nStore();
  const isOnNavy = tone === 'on-navy';
  const className = isOnNavy
    ? 'bg-white/10 active:bg-white/15 text-white rounded-xl h-9 px-3 text-[11.5px] font-semibold flex items-center gap-1.5 transition-colors'
    : 'bg-cream-card border border-cream-border active:bg-cream-soft text-ink-600 rounded-xl px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 transition-colors';
  return (
    <button onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')} className={className}>
      <Globe size={12} strokeWidth={2} />
      {lang === 'ur' ? 'EN' : 'UR'}
    </button>
  );
}
