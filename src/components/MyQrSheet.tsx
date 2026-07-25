import { Copy, QrCode, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { QRCode } from './QRCode';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { buildConnectUrl } from '../lib/connectQr';
import { buildAppShareUrl } from '../lib/collaboration';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The user's own public code, e.g. "HSB-ABC234". */
  code: string;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
}

// "Show my code" — the half of face-to-face linking the OTHER person scans.
// Deliberately shows the six-character code underneath the symbol: phones
// die, cameras refuse to focus, and someone will always end up typing it.
export function MyQrSheet({ open, onClose, code }: Props) {
  const t = useT();
  const toast = useToast();
  const payload = code ? buildConnectUrl(code) : '';

  const copy = async () => {
    if (!code) return;
    try {
      await copyText(`@${code}`);
      toast.show({ type: 'success', title: t('connect_code_copied') });
    } catch {
      toast.show({ type: 'error', title: t('connect_code_copy_failed') });
    }
  };

  const share = async () => {
    if (!code) return;
    const text = `${t('connect_share_text')} @${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Hisaab', text, url: payload || buildAppShareUrl() });
        return;
      }
      await copyText(`${text}\n${payload}`);
      toast.show({ type: 'success', title: t('connect_code_copied') });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.show({ type: 'error', title: t('connect_code_copy_failed') });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('qr_my_title')}>
      <div className="space-y-4">
        <p className="text-[12px] text-ink-500 leading-relaxed">{t('qr_my_desc')}</p>

        <div className="flex justify-center">
          <div className="rounded-3xl bg-white border border-cream-border p-4 shadow-sm">
            <QRCode value={payload} size={224} title={t('qr_my_title')} />
          </div>
        </div>

        <button
          type="button"
          onClick={copy}
          className="w-full rounded-2xl bg-cream-soft border border-cream-border py-3 flex items-center justify-center gap-2.5 active:scale-[0.98] transition-transform"
        >
          <span className="text-[9px] font-semibold text-ink-400 uppercase tracking-[0.14em]">HSB</span>
          <span className="text-[17px] font-bold text-ink-900 tabular-nums tracking-wide">
            {code ? `@${code}` : '…'}
          </span>
          <Copy size={14} className="text-ink-400" />
        </button>

        <button
          type="button"
          onClick={share}
          disabled={!code}
          className="w-full rounded-2xl bg-ink-900 text-white py-3 text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-40"
        >
          <Share2 size={15} /> {t('connect_share')}
        </button>

        <div className="rounded-2xl bg-accent-50 border border-accent-100 p-3.5 flex items-start gap-2.5">
          <QrCode size={15} className="text-accent-600 shrink-0 mt-0.5" />
          <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('qr_my_hint')}</p>
        </div>
      </div>
    </Modal>
  );
}
