// Manual "last price" update for one holding — the only way prices move in
// v1 (offline-first, no market feeds). Stamps priceAsOf = now on save.

import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  marketId: string;
  symbol: string;
  currency: string;
  currentPrice: number | null;
}

export function UpdatePriceModal({ open, onClose, marketId, symbol, currency, currentPrice }: Props) {
  const updatePrice = useInvestmentStore((s) => s.updatePrice);
  const toast = useToast();
  const t = useT();

  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setText(currentPrice !== null ? String(currentPrice) : '');
  }, [open, currentPrice]);

  const parsed = parseFloat(text);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await updatePrice(marketId, symbol, parsed);
      onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('inv_update_price')} — ${symbol}`}
      footer={
        <button
          onClick={handleSave}
          disabled={!valid || saving}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-30 hover:enabled:opacity-90 hover:enabled:shadow-md active:scale-[0.98] transition-all"
        >
          {saving ? t('quick_processing') : t('quick_save')}
        </button>
      }
    >
      <div className="space-y-3">
        <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
          {t('inv_price_label')} ({currency})
        </label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={currentPrice !== null ? String(currentPrice) : 'e.g. 2.36'}
          autoFocus
          className="w-full border border-cream-border rounded-2xl px-4 py-3 text-[17px] font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
        />
        {currentPrice !== null && (
          <p className="text-[11px] text-ink-500">
            {t('inv_price_label')}: {formatMoney(currentPrice, currency)}
          </p>
        )}
      </div>
    </Modal>
  );
}
