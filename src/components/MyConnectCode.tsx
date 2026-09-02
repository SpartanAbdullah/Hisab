import { useEffect, useState } from 'react';
import { Copy, Share2, Link2, QrCode } from 'lucide-react';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { profilesDb } from '../lib/supabaseDb';
import { buildAppShareUrl, generatePublicCodeCandidate, normalizePublicCode } from '../lib/collaboration';
import { MyQrSheet } from './MyQrSheet';

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
}

// "Your connect code" card — surfaces the user's public code so others can add
// them, right where contacts are managed. Ensures a code exists (generating one
// on first view, same as Settings) and offers one-tap copy + share.
export function MyConnectCode() {
  const t = useT();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ensure = async () => {
      const profile = await profilesDb.getCurrent();
      if (!profile || cancelled) return;
      const existing = typeof profile.public_code === 'string' ? profile.public_code : '';
      if (existing) { setCode(existing); return; }
      const next = generatePublicCodeCandidate();
      await profilesDb.updateCurrent({ public_code: next, public_code_normalized: normalizePublicCode(next) });
      if (!cancelled) setCode(next);
    };
    void ensure().catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const copy = async () => {
    if (!code) return;
    try { await copyText(`@${code}`); toast.show({ type: 'success', title: t('connect_code_copied') }); }
    catch { toast.show({ type: 'error', title: t('connect_code_copy_failed') }); }
  };

  const share = async () => {
    if (!code) return;
    const url = buildAppShareUrl();
    const text = `${t('connect_share_text')} @${code}`;
    try {
      // Brand name — identical in both languages, not a copy string.
      // eslint-disable-next-line no-restricted-syntax
      if (navigator.share) { await navigator.share({ title: 'Hisaab', text, url }); return; }
      await copyText(`${text}\n${url}`);
      toast.show({ type: 'success', title: t('connect_code_copied') });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.show({ type: 'error', title: t('connect_code_copy_failed') });
    }
  };

  return (
    <div className="rounded-[18px] bg-gradient-to-br from-accent-50 to-cream-card border border-accent-100 p-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
          <Link2 size={18} className="text-accent-600" strokeWidth={1.9} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink-900 tracking-tight">{t('connect_my_code')}</p>
          <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">{t('connect_my_code_desc')}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={copy}
          disabled={!code}
          className="flex-1 min-w-0 flex items-center justify-center gap-2 rounded-xl bg-cream-card border border-cream-border py-2.5 disabled:opacity-50 press"
        >
          <span className="text-[9px] font-semibold text-ink-400 uppercase tracking-[0.12em]">{t('mcc_hsb_tag')}</span>
          <span className="text-[14px] font-bold text-ink-900 tabular-nums">{code ? `@${code}` : '…'}</span>
          {code && <Copy size={13} className="text-ink-400" />}
        </button>
        {/* Show-my-QR sits next to the code, not behind a menu: in person,
            holding up a QR is the fastest possible handoff and it should be
            one tap from where the code already lives. */}
        <button
          onClick={() => setShowQr(true)}
          disabled={!code}
          className="w-11 shrink-0 rounded-xl bg-cream-card border border-cream-border flex items-center justify-center disabled:opacity-50 press-sm"
          aria-label={t('qr_my_title')}
        >
          <QrCode size={17} className="text-accent-600" strokeWidth={2} />
        </button>
        <button
          onClick={share}
          disabled={!code}
          className="px-3.5 shrink-0 rounded-xl bg-ink-900 text-white text-[12.5px] font-semibold flex items-center gap-1.5 disabled:opacity-50 press-sm"
        >
          <Share2 size={14} /> {t('connect_share')}
        </button>
      </div>

      <MyQrSheet open={showQr} onClose={() => setShowQr(false)} code={code} />
    </div>
  );
}
