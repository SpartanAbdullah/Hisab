// Rename / delete investment markets. Deleting is blocked while the market
// has trades (money history); currency is shown but never editable here —
// it locks at the first trade.

import { useState } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { Modal } from '../components/Modal';
import { CreateMarketModal } from './CreateMarketModal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ManageMarketsSheet({ open, onClose }: Props) {
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const renameMarket = useInvestmentStore((s) => s.renameMarket);
  const deleteMarket = useInvestmentStore((s) => s.deleteMarket);
  const toast = useToast();
  const t = useT();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const tradeCount = (marketId: string) => trades.filter((tr) => tr.marketId === marketId).length;
  // Holdings = distinct symbols, not trade rows (five buys of EMAAR ≠ 5 holdings).
  const holdingCount = (marketId: string) =>
    new Set(trades.filter((tr) => tr.marketId === marketId).map((tr) => tr.symbol)).size;

  const handleRename = async (id: string) => {
    try {
      await renameMarket(id, editName);
      setEditingId(null);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (tradeCount(id) > 0) {
      toast.show({ type: 'error', title: name, subtitle: t('inv_market_delete_blocked') });
      return;
    }
    const ok = await confirmDestructive({
      title: t('inv_delete_market_confirm').replace('{name}', name),
      description: '',
      confirmLabel: t('inv_delete_market'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteMarket(id);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    }
  };

  return (
    <>
      <Modal open={open && !showCreate} onClose={onClose} title={t('inv_manage_markets')}>
        <div className="space-y-2.5">
          {markets.map((m) => (
            <div key={m.id} className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
              {editingId === m.id ? (
                <div className="flex items-center gap-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                    className="flex-1 border border-cream-border rounded-xl px-3 py-2 text-sm bg-cream-bg focus:outline-none focus:border-accent-500"
                  />
                  <button
                    onClick={() => handleRename(m.id)}
                    disabled={!editName.trim()}
                    className="min-h-[38px] px-3.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30"
                  >
                    {t('quick_save')}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink-900 truncate">
                      {currencyMeta[m.currency]?.flag} {m.name} · {m.currency}
                    </p>
                    <p className="text-[10.5px] text-ink-500 mt-0.5">
                      {t('inv_market_has_holdings').replace('{n}', String(holdingCount(m.id)))} · {t('inv_market_currency_locked')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setEditingId(m.id); setEditName(m.name); }}
                    aria-label={t('inv_rename_market')}
                    className="w-9 h-9 rounded-xl border border-cream-border text-ink-500 flex items-center justify-center active:bg-cream-soft"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(m.id, m.name)}
                    aria-label={t('inv_delete_market')}
                    className="w-9 h-9 rounded-xl border border-cream-border text-ink-500 flex items-center justify-center active:bg-pay-50 active:text-pay-text"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="w-full rounded-2xl border-2 border-dashed border-cream-border text-ink-700 py-3 text-[12.5px] font-semibold active:bg-cream-soft transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={13} strokeWidth={2.4} /> {t('inv_new_market')}
          </button>
        </div>
      </Modal>
      <CreateMarketModal open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}
