// Create an investment market (name + fixed currency). Seed chips prefill
// the common Gulf/Pakistan exchanges; anything can be typed free-form.

import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency, type InvestmentMarket } from '../db';

const SUGGESTIONS: { name: string; currency: Currency }[] = [
  { name: 'DFM', currency: 'AED' },
  { name: 'ADX', currency: 'AED' },
  { name: 'PSX', currency: 'PKR' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (market: InvestmentMarket) => void;
}

export function CreateMarketModal({ open, onClose, onCreated }: Props) {
  const createMarket = useInvestmentStore((s) => s.createMarket);
  const toast = useToast();
  const t = useT();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(
    (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED',
  );
  const [saving, setSaving] = useState(false);

  const handleClose = () => {
    setName('');
    setSaving(false);
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const market = await createMarket({ name, currency });
      onCreated?.(market);
      handleClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('inv_new_market')}
      footer={
        <button
          onClick={handleCreate}
          disabled={!name.trim() || saving}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
        >
          {saving ? t('quick_processing') : t('inv_empty_cta')}
        </button>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
            {t('inv_market_suggest')}
          </label>
          <div className="flex gap-2 flex-wrap">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => { setName(s.name); setCurrency(s.currency); }}
                className={`min-h-[40px] px-3.5 py-2 rounded-xl text-[12px] font-semibold border transition-all active:scale-95 ${
                  name.trim().toUpperCase() === s.name
                    ? 'border-accent-500 bg-accent-50 text-accent-600'
                    : 'border-cream-border bg-cream-card text-ink-600'
                }`}
              >
                {currencyMeta[s.currency]?.flag} {s.name} · {s.currency}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
            {t('inv_market_name')}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('inv_market_name_ph')}
            className="w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
          />
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
            {t('inv_market_currency')}
          </label>
          <div className="grid grid-cols-4 gap-2">
            {SUPPORTED_CURRENCIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={c === currency ? 'selector-base selector-selected' : 'selector-base'}
              >
                <span className="text-[12px] font-semibold text-ink-800">{currencyMeta[c]?.flag} {c}</span>
              </button>
            ))}
          </div>
          <p className="text-[10.5px] text-ink-500 mt-1.5">{t('inv_market_currency_locked')}</p>
        </div>
      </div>
    </Modal>
  );
}
