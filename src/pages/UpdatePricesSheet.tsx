// Bulk manual price update — the after-market-close ritual: one input per
// open holding, single Save, untouched rows are skipped.

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { useInvestmentStore, holdingsFor } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { marketColorFor } from '../lib/marketColors';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Scope to one market, or null for all open holdings. */
  marketId: string | null;
}

export function UpdatePricesSheet({ open, onClose, marketId }: Props) {
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const updatePrice = useInvestmentStore((s) => s.updatePrice);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const holdings = useMemo(
    () => holdingsFor(marketId, trades, prices).filter((h) => h.position.quantity > 0),
    [marketId, trades, prices],
  );
  const marketById = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);

  const [texts, setTexts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const h of holdings) {
      initial[`${h.marketId}:${h.symbol}`] = h.lastPrice !== null ? String(h.lastPrice) : '';
    }
    setTexts(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirtyEntries = holdings.filter((h) => {
    const key = `${h.marketId}:${h.symbol}`;
    const text = texts[key] ?? '';
    const parsed = parseFloat(text);
    if (!Number.isFinite(parsed) || parsed <= 0) return false;
    return parsed !== h.lastPrice;
  });

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleSave = () => submitGuard.run(runSave);

  const runSave = async () => {
    if (dirtyEntries.length === 0 || saving) return;
    setSaving(true);
    try {
      for (const h of dirtyEntries) {
        const parsed = parseFloat(texts[`${h.marketId}:${h.symbol}`]);
        await updatePrice(h.marketId, h.symbol, parsed);
      }
      toast.show({ type: 'success', title: `${t('inv_update_prices')} ✓`, subtitle: `${dirtyEntries.length}` });
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
      title={t('inv_update_prices')}
      footer={
        <button
          onClick={handleSave}
          disabled={dirtyEntries.length === 0 || saving}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-30 hover:enabled:opacity-90 hover:enabled:shadow-md active:scale-[0.98] transition-all"
        >
          {saving ? t('quick_processing') : `${t('quick_save')}${dirtyEntries.length > 0 ? ` (${dirtyEntries.length})` : ''}`}
        </button>
      }
    >
      <div className="space-y-2.5">
        {holdings.map((h) => {
          const market = marketById.get(h.marketId);
          if (!market) return null;
          const key = `${h.marketId}:${h.symbol}`;
          return (
            <div key={key} className="rounded-2xl bg-cream-card border border-cream-border p-3.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink-900 truncate">
                  {h.symbol}{' '}
                  <span className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 ${marketColorFor(market.id).tint} ${marketColorFor(market.id).text}`}>
                    {market.name}
                  </span>
                </p>
                <p className="text-[10.5px] text-ink-500 mt-0.5 tabular-nums">
                  {h.position.quantity.toLocaleString()} @ {formatMoney(h.position.avgCost, market.currency)}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={texts[key] ?? ''}
                  onChange={(e) => setTexts((s) => ({ ...s, [key]: e.target.value }))}
                  placeholder="—"
                  className="w-24 border border-cream-border rounded-xl px-3 py-2 text-[14px] font-semibold tabular-nums text-right bg-cream-bg focus:outline-none focus:border-accent-500"
                />
                <span className="text-[10.5px] font-semibold text-ink-500">{market.currency}</span>
              </div>
            </div>
          );
        })}
        {holdings.length === 0 && (
          <p className="text-[12px] text-ink-500 text-center py-4">{t('inv_position_closed')}</p>
        )}
      </div>
    </Modal>
  );
}
