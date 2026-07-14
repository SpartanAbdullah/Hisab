// One holding: position summary with the avg-cost math visible, trade
// history (buys/sells/dividends with fees), replay-guarded delete, and the
// manual price update entry point.

import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Plus, ArrowUpRight, HandCoins, Trash2, TrendingUp } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { ListSkeleton } from '../components/ListSkeleton';
import { PageErrorState } from '../components/PageErrorState';
import { EmptyState } from '../components/EmptyState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useInvestmentStore } from '../stores/investmentStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { RecordTradeModal, type RecordTradePreset } from './RecordTradeModal';
import { UpdatePriceModal } from './UpdatePriceModal';
import { computePosition, sortTrades, unrealizedPnl, marketValue } from '../lib/investmentMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { InvestmentTrade } from '../db';

const DAY_MS = 24 * 60 * 60 * 1000;

export function HoldingDetailPage() {
  // React Router already percent-decodes params — decoding again would
  // double-decode (and throw on symbols containing a literal %).
  const { marketId = '', symbol: rawSymbol = '' } = useParams();
  const symbol = rawSymbol.toUpperCase();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();

  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const loadInvestments = useInvestmentStore((s) => s.loadInvestments);
  const deleteTrade = useInvestmentStore((s) => s.deleteTrade);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);

  const [showRecord, setShowRecord] = useState(false);
  const [recordPreset, setRecordPreset] = useState<RecordTradePreset | null>(null);
  const [showPrice, setShowPrice] = useState(false);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.all([loadInvestments(), loadAccounts()]);
  }, [loadInvestments, loadAccounts]);
  const { status, error, retry } = useAsyncLoad(load);

  const market = markets.find((m) => m.id === marketId) ?? null;
  const holdingTrades = useMemo(
    () => trades.filter((tr) => tr.marketId === marketId && tr.symbol === symbol),
    [trades, marketId, symbol],
  );
  const position = useMemo(() => computePosition(holdingTrades), [holdingTrades]);
  const priceRow = prices.find((p) => p.marketId === marketId && p.symbol === symbol) ?? null;
  const lastPrice = priceRow?.price ?? null;
  const priceAge = priceRow ? Math.floor((Date.now() - new Date(priceRow.asOf).getTime()) / DAY_MS) : null;

  const isOpen = position.quantity > 0;
  const value = lastPrice !== null ? marketValue(position, lastPrice) : null;
  const pnl = lastPrice !== null && isOpen ? unrealizedPnl(position, lastPrice) : null;

  const history = useMemo(() => sortTrades(holdingTrades).reverse(), [holdingTrades]);

  const openRecord = (kind: RecordTradePreset['kind']) => {
    setRecordPreset({ kind, marketId, symbol, lockSymbol: true });
    setShowRecord(true);
  };

  const handleDelete = async (trade: InvestmentTrade) => {
    const ok = await confirmDestructive({
      title: t('inv_delete_trade_confirm_title'),
      description: t('inv_delete_trade_confirm_body'),
      confirmLabel: t('inv_delete_trade'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusyTradeId(trade.id);
    try {
      await deleteTrade(trade.id);
      toast.show({ type: 'success', title: t('inv_delete_trade') + ' ✓' });
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setBusyTradeId(null);
    }
  };

  const accountName = (id: string | null) =>
    id ? accounts.find((a) => a.id === id)?.name ?? '' : '';

  if (status === 'loading' && markets.length === 0) {
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-5"><ListSkeleton rows={3} /></div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-5">
          <PageErrorState variant="inline" title={t('error')} message={error ?? ''} onRetry={retry} />
        </div>
      </main>
    );
  }

  if (status === 'ready' && (!market || holdingTrades.length === 0)) {
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-5">
          <EmptyState
            icon={TrendingUp}
            tone="accent"
            title={t('inv_holding_not_found')}
            description=""
            actionLabel={t('inv_title')}
            onAction={() => navigate('/investments')}
          />
        </div>
      </main>
    );
  }

  if (!market) return null;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={symbol}
          back
          action={<LanguageToggle />}
        />
        <div className="px-5 pb-7 space-y-2">
          <span className="inline-flex rounded-full bg-white/10 px-2.5 py-1 text-[10.5px] text-white/80 font-semibold">
            {market.name} · {market.currency}
          </span>
          {isOpen ? (
            <>
              <p className="text-[32px] font-semibold text-white tabular-nums tracking-tight">
                {value !== null ? formatMoney(value, market.currency) : formatMoney(position.costBasis, market.currency)}
              </p>
              <p className="text-[12px] text-white/70 tabular-nums">
                {t('inv_you_hold')
                  .replace('{qty}', position.quantity.toLocaleString())
                  .replace('{price}', formatMoney(position.avgCost, market.currency))}
              </p>
              {pnl !== null && (
                <span className={`inline-flex text-[12px] font-semibold tabular-nums rounded-full px-2 py-0.5 ${
                  pnl >= 0 ? 'bg-receive-50 text-receive-text' : 'bg-pay-50 text-pay-text'
                }`}>
                  {pnl >= 0 ? '+' : ''}{formatMoney(pnl, market.currency)} {t('inv_unrealized')}
                </span>
              )}
              <button
                type="button"
                onClick={() => setShowPrice(true)}
                className="block text-[11.5px] text-white/70 underline underline-offset-2 active:text-white"
              >
                {lastPrice !== null
                  ? `${formatMoney(lastPrice, market.currency)}${priceAge !== null && priceAge >= 7 ? ` · ${t('inv_price_asof_days').replace('{days}', String(priceAge))}` : ''} — ${t('inv_update_price')}`
                  : t('inv_price_never')}
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex rounded-full bg-white/10 px-2.5 py-1 text-[10.5px] text-white/80 font-semibold">
                {t('inv_position_closed')}
              </span>
              <p className={`text-[28px] font-semibold tabular-nums tracking-tight ${position.realizedPnl >= 0 ? 'text-receive-400' : 'text-red-300'}`}>
                {position.realizedPnl >= 0 ? '+' : ''}{formatMoney(position.realizedPnl, market.currency)}
              </p>
              <p className="text-[12px] text-white/70">{t('inv_realized')}</p>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Breakdown — auditable, not a black box. */}
        <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 space-y-2">
          {([
            [t('inv_invested'), position.costBasis, 'neutral'],
            [t('inv_current_value'), value, 'neutral'],
            [t('inv_unrealized'), pnl, 'signed'],
            [t('inv_realized'), position.realizedPnl, 'signed'],
            [t('inv_dividends'), position.dividends, 'neutral'],
            [t('inv_fees_total'), position.feesPaid, 'neutral'],
          ] as const).map(([label, amount, tone]) => (
            <div key={label} className="flex items-baseline justify-between">
              <span className="text-[12px] text-ink-500">{label}</span>
              <span className={`text-[13px] font-semibold tabular-nums ${
                tone === 'signed' && amount !== null
                  ? amount >= 0 ? 'text-receive-text' : 'text-pay-text'
                  : 'text-ink-900'
              }`}>
                {amount === null ? '—' : `${tone === 'signed' && amount > 0 ? '+' : ''}${formatMoney(amount, market.currency)}`}
              </span>
            </div>
          ))}
          <p className="text-[10px] text-ink-400 pt-1 border-t border-cream-hairline">{t('inv_avg_cost_note')}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => openRecord('buy')}
            className="flex-1 min-h-[44px] rounded-2xl bg-ink-900 text-white text-[12.5px] font-semibold active:scale-[0.98] transition-transform"
          >
            {isOpen ? t('inv_buy_more') : t('inv_buy')}
          </button>
          {isOpen && (
            <button
              onClick={() => openRecord('sell')}
              className="flex-1 min-h-[44px] rounded-2xl bg-cream-card border border-cream-border text-ink-700 text-[12.5px] font-semibold active:bg-cream-soft transition-colors"
            >
              {t('inv_sell')}
            </button>
          )}
          <button
            onClick={() => openRecord('dividend')}
            className="min-h-[44px] px-4 rounded-2xl bg-cream-card border border-cream-border text-ink-700 text-[12.5px] font-semibold active:bg-cream-soft transition-colors"
          >
            {t('inv_dividend')}
          </button>
        </div>

        {/* History */}
        <div>
          <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('inv_history')}</p>
          <div className="space-y-2">
            {history.map((tr) => {
              const Icon = tr.kind === 'buy' ? Plus : tr.kind === 'sell' ? ArrowUpRight : HandCoins;
              const iconTone = tr.kind === 'buy' ? 'bg-pay-50 text-pay-text' : 'bg-receive-50 text-receive-text';
              const cash = tr.kind === 'dividend'
                ? Math.round((tr.amount - tr.fees) * 100) / 100
                : tr.kind === 'buy'
                  ? Math.round((tr.quantity * tr.pricePerUnit + tr.fees) * 100) / 100
                  : Math.round((tr.quantity * tr.pricePerUnit - tr.fees) * 100) / 100;
              const label = tr.kind === 'dividend'
                ? t('inv_dividend')
                : `${t(tr.kind === 'buy' ? 'inv_buy' : 'inv_sell')} ${tr.quantity.toLocaleString()} @ ${tr.pricePerUnit}`;
              return (
                <div key={tr.id} className="rounded-[18px] bg-cream-card border border-cream-border p-3.5 flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconTone}`}>
                    <Icon size={15} strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-semibold text-ink-900 tabular-nums">{label}</p>
                    <p className="text-[10.5px] text-ink-500 mt-0.5">
                      {format(new Date(tr.tradedAt), 'MMM d, yyyy')}
                      {tr.fees > 0 ? ` · ${t('inv_fees')}: ${formatMoney(tr.fees, market.currency)}` : ''}
                      {tr.accountId
                        ? (accountName(tr.accountId) ? ` · ${accountName(tr.accountId)}` : '')
                        : ` · ${t('inv_outside_chip')}`}
                    </p>
                  </div>
                  <p className={`text-[12.5px] font-semibold tabular-nums shrink-0 ${tr.kind === 'buy' ? 'text-pay-text' : 'text-receive-text'}`}>
                    {tr.kind === 'buy' ? '−' : '+'}{formatMoney(cash, market.currency)}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDelete(tr)}
                    disabled={busyTradeId === tr.id}
                    aria-label={t('inv_delete_trade')}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-400 active:text-pay-text active:bg-pay-50 transition-colors shrink-0 disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <RecordTradeModal open={showRecord} onClose={() => { setShowRecord(false); setRecordPreset(null); }} preset={recordPreset} />
      <UpdatePriceModal
        open={showPrice}
        onClose={() => setShowPrice(false)}
        marketId={marketId}
        symbol={symbol}
        currency={market.currency}
        currentPrice={lastPrice}
      />
    </main>
  );
}
