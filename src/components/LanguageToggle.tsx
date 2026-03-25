import { Globe } from 'lucide-react';
import { useI18nStore } from '../lib/i18n';

export function LanguageToggle() {
  const { lang, setLang } = useI18nStore();
  return (
    <button
      onClick={() => setLang(lang === 'ur' ? 'en' : 'ur')}
      className="bg-slate-100 text-slate-500 rounded-xl px-3 py-2 text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-all"
    >
      <Globe size={12} strokeWidth={2} />
      {lang === 'ur' ? 'EN' : 'UR'}
    </button>
  );
}
