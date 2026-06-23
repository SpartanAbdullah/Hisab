import { useEffect, useRef, useState } from 'react';
import { Camera, Trash2, Loader2, FileImage } from 'lucide-react';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { uploadReceipt, getReceiptUrl, deleteReceipt, isImageFile } from '../lib/receiptStorage';

interface Props {
  transactionId: string;
  receiptPath: string | null | undefined;
  // Called after a successful upload (new path) or removal (null). The caller
  // persists it on the transaction (transactionStore.setReceiptPath).
  onChange: (path: string | null) => void;
}

// Attach / view / replace / remove a receipt photo for a transaction. Uses a
// plain file input with capture="environment" so Android opens the camera
// directly (and the Capacitor WebView handles it) without a native plugin.
export function ReceiptField({ transactionId, receiptPath, onChange }: Props) {
  const t = useT();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(false);

  // Refresh the signed URL whenever the path changes.
  useEffect(() => {
    let active = true;
    if (!receiptPath) { setUrl(null); return; }
    void getReceiptUrl(receiptPath).then((u) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [receiptPath]);

  const pick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the user re-pick the same file
    if (!file) return;
    if (!isImageFile(file)) { toast.show({ type: 'error', title: t('receipt_not_image') }); return; }
    setBusy(true);
    try {
      const path = await uploadReceipt(transactionId, file);
      onChange(path);
      toast.show({ type: 'success', title: t('receipt_added') });
    } catch {
      toast.show({ type: 'error', title: t('receipt_failed') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDestructive({ title: t('receipt_remove_title'), confirmLabel: t('cat_remove') });
    if (!ok) return;
    setBusy(true);
    try {
      if (receiptPath) await deleteReceipt(receiptPath);
      onChange(null);
      toast.show({ type: 'success', title: t('receipt_removed') });
    } catch {
      toast.show({ type: 'error', title: t('receipt_failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="form-label">{t('receipt_label')}</label>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />

      {receiptPath ? (
        <div className="flex items-center gap-3 rounded-2xl border border-cream-border bg-cream-card p-2.5">
          <button
            type="button"
            onClick={() => url && setViewing(true)}
            className="w-14 h-14 rounded-xl overflow-hidden bg-cream-soft shrink-0 flex items-center justify-center active:scale-95 transition-transform"
          >
            {url ? (
              <img src={url} alt={t('receipt_label')} className="w-full h-full object-cover" />
            ) : (
              <FileImage size={18} className="text-ink-400" />
            )}
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-ink-800">{t('receipt_attached')}</p>
            <button type="button" onClick={pick} disabled={busy} className="text-[11px] text-accent-600 font-semibold disabled:opacity-50">
              {t('receipt_replace')}
            </button>
          </div>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-pay-text active:bg-pay-50 transition-colors disabled:opacity-50"
            aria-label={t('receipt_remove_title')}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed border-cream-border bg-cream-card py-3 text-[12.5px] font-semibold text-ink-600 active:scale-[0.99] transition-transform disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}
          {busy ? t('receipt_uploading') : t('receipt_add')}
        </button>
      )}

      {viewing && url && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setViewing(false)}
        >
          <img src={url} alt={t('receipt_label')} className="max-w-full max-h-[85vh] rounded-xl" />
        </div>
      )}
    </div>
  );
}
