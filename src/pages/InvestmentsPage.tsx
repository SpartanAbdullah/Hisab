// Investment Tracker main page: per-currency portfolio summary (never
// cross-summed — LoansPage discipline), market chips, holdings grouped by
// market, closed positions collapsed at the bottom. Record-keeping framing
// throughout — Hisaab never advises or holds investments.

import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, TrendingUp, NotebookPen, ChevronDown, ChevronRight, Settings2 } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import { PageErrorState } from '../components/PageErrorState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useInvestmentStore, holdingsFor, portfolioTotals, type HoldingView } from '../stores/investmentStore';
import { useAccountStore } from '../stores/accountStore';
import { RecordTradeModal, type RecordTradePreset } from './RecordTradeModal';
import { CreateMarketModal } from './CreateMarketModal';
import { ManageMarketsSheet } from './ManageMarketsSheet';
import { UpdatePricesSheet } from './UpdatePricesSheet';
import { formatMoney } from '../lib/constants';
import { unrealizedPnl, marketValue } from '../lib/investmentMath';
import { marketColorFor } from '../lib/marketColors';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { getPrimaryCurrency } from '../lib/primaryCurrency';

const DAY_MS = 24 * 60 * 60 * 1000;

function priceAgeDays(asOf: string | null): number | null {
  if (!asOf) return null;
  return Math.floor((Date.now() - new Date(asOf).getTime()) / DAY_MS);
}

export function InvestmentsPage() {
  const navigate = useNavigate();
  const t = useT();
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const loadInvestments = useInvestmentStore((s) => s.loadInvestments);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);

  // Home's per-market card rows deep-link here as /investments?market=<id> —
  // land already scoped to that market instead of the mixed all-markets view.
  const [searchParams] = useSearchParams();
  const [scopedMarketId, setScopedMarketId] = useState<string | null>(() => searchParams.get('market'));
  const [showRecord, setShowRecord] = useState(false);
  const [recordPreset, setRecordPreset] = useState<RecordTradePreset | null>(null);
  const [showCreateMarket, setShowCreateMarket] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [showBulkPrices, setShowBulkPrices] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([loadInvestments(), loadAccounts()]);
  }, [loadInvestments, loadAccounts]);
  const { status, error, retry } = useAsyncLoad(load);

  const scopedMarket = scopedMarketId ? markets.find((m) => m.id === scopedMarketId) ?? null : null;
  const primaryCurrency = getPrimaryCurrency();

  const totals = useMemo(() => {
    const scoped = scopedMarket ? markets.filter((m) => m.id === scopedMarket.id) : markets;
    return portfolioTotals(scoped, trades, prices);
  }, [markets, scopedMarket, trades, prices]);
  // Headline: the primary currency when present, else the biggest bucket.
  const headline = totals.find((b) => b.currency === primaryCurrency) ?? totals[0] ?? null;
  const pockets = totals.filter((b) => b !== headline);

  // Scope by the RESOLVED market, not the raw id — a stale deep-link id
  // (deleted market) must fall back to the all-markets view, not an empty one.
  const holdings = useMemo(
    () => holdingsFor(scopedMarket?.id ?? null, trades, prices),
    [scopedMarket, trades, prices],
  );
  const open = holdings.filter((h) => h.position.quantity > 0);
  const closed = holdings.filter((h) => h.position.quantity === 0);
  const marketById = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);

  const openRecord = (preset: RecordTradePreset | null = null) => {
    setRecordPreset(preset);
    setShowRecord(true);
  };

  const renderHolding = (h: HoldingView) => {
    const market = marketById.get(h.marketId);
    if (!market) return null;
    const color = marketColorFor(market.id);
    const isOpen = h.position.quantity > 0;
    const value = h.lastPrice !== null ? marketValue(h.position, h.lastPrice) : null;
    const pnl = h.lastPrice !== null && isOpen ? unrealizedPnl(h.position, h.lastPrice) : null;
    const pnlPct = pnl !== null && h.position.costBasis > 0 ? (pnl / h.position.costBasis) * 100 : null;
    const age = priceAgeDays(h.priceAsOf);
    return (
      <button
        key={`${h.marketId}:${h.symbol}`}
        type="button"
        onClick={() => navigate(`/investment/${h.marketId}/${encodeURIComponent(h.symbol)}`)}
        className="w-full rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 text-left hover:shadow-sm hover:border-cream-hairline hover:bg-cream-soft active:scale-[0.99] transition-all"
      >
        <div className={`w-11 h-11 rounded-2xl ${color.tint} border ${color.border} flex items-center justify-center shrink-0`}>
          <span className={`text-[12px] font-bold ${color.text} tracking-tight`}>{h.symbol.slice(0, 3)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-tight">
            {h.symbol}
            {!scopedMarket && (
              <span className={`text-[9.5px] font-semibold ml-1.5 rounded-full px-2 py-0.5 ${color.tint} ${color.text}`}>
                {market.name}
              </span>
            )}
          </p>
          {isOpen ? (
            <>
              <p className="text-[11px] text-ink-500 mt-0.5 tabular-nums">
                {h.position.quantity.toLocaleString()} @ {formatMoney(h.position.avgCost, market.currency)}
              </p>
              {h.lastPrice === null ? (
                <p className="text-[10px] text-warn-600 mt-0.5">{t('inv_price_never')}</p>
              ) : age !== null && age >= 7 ? (
                <p className={`text-[10px] mt-0.5 ${age > 30 ? 'text-warn-600' : 'text-ink-400'}`}>
                  {t('inv_price_asof_days').replace('{days}', String(age))}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[11px] text-ink-500 mt-0.5">{t('inv_position_closed')}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          {isOpen ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums">
                {value !== null ? formatMoney(value, market.currency) : `— ${market.currency}`}
              </p>
              {pnl !== null && (
                <p className={`text-[11px] font-semibold tabular-nums mt-0.5 ${pnl >= 0 ? 'text-receive-text' : 'text-pay-text'}`}>
                  {pnl >= 0 ? '+' : ''}{formatMoney(pnl, market.currency)}
                  {pnlPct !== null ? ` · ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}
                </p>
              )}
            </>
          ) : (
            <p className={`text-[12px] font-semibold tabular-nums ${h.position.realizedPnl >= 0 ? 'text-receive-text' : 'text-pay-text'}`}>
              {h.position.realizedPnl >= 0 ? '+' : ''}{formatMoney(h.position.realizedPnl, market.currency)}
            </p>
          )}
        </div>
      </button>
    );
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('inv_title')}
          back
          action={
            <div className="flex items-center gap-2">
              {markets.length > 0 && (
                <button
                  onClick={() => openRecord(scopedMarket ? { marketId: scopedMarket.id } : null)}
                  className="glow-attention min-h-[32px] px-3.5 py-1.5 rounded-full bg-gradient-to-b from-accent-500 to-accent-600 text-white text-[11px] font-semibold flex items-center gap-1.5 hover:brightness-110 active:scale-95 transition-all"
                >
                  <Plus size={12} strokeWidth={2.4} /> {t('inv_record_trade')}
                </button>
              )}
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7 space-y-3">
          {/* Compliance posture, stated once, calmly. */}
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5">
            <NotebookPen size={11} className="text-white/70" />
            <p className="text-[10.5px] text-white/80 font-medium">{t('inv_record_only')}</p>
          </div>
          {headline && (
            <div>
              <p className="text-[11px] text-white/60 font-semibold uppercase tracking-[0.12em]">
                {t('inv_current_value')} · {headline.currency}
              </p>
              <p className="text-[32px] font-semibold text-white tabular-nums tracking-tight mt-0.5">
                {formatMoney(headline.currentValue, headline.currency)}
              </p>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className="text-[12px] text-white/70 tabular-nums">
                  {t('inv_invested')} {formatMoney(headline.invested, headline.currency)}
                </span>
                <span className={`text-[12px] font-semibold tabular-nums rounded-full px-2 py-0.5 ${
                  headline.unrealized >= 0 ? 'bg-receive-50 text-receive-text' : 'bg-pay-50 text-pay-text'
                }`}>
                  {headline.unrealized >= 0 ? '+' : ''}{formatMoney(headline.unrealized, headline.currency)}
                  {headline.invested > 0 ? ` · ${headline.unrealized >= 0 ? '+' : ''}${((headline.unrealized / headline.invested) * 100).toFixed(1)}%` : ''}
                </span>
              </div>
              {(headline.realized !== 0 || headline.dividends !== 0) && (
                <p className="text-[11px] text-white/60 tabular-nums mt-1">
                  {t('inv_realized')} {headline.realized >= 0 ? '+' : ''}{formatMoney(headline.realized, headline.currency)}
                  {headline.dividends !== 0 ? ` · ${t('inv_dividends')} ${formatMoney(headline.dividends, headline.currency)}` : ''}
                </p>
              )}
              {headline.unpricedCount > 0 && (
                <p className="text-[10.5px] text-white/50 mt-1">
                  {t('inv_unpriced_chip').replace('{n}', String(headline.unpricedCount))} — {t('inv_price_never')}
                </p>
              )}
            </div>
          )}
          {pockets.map((b) => (
            <div key={b.currency} className="flex items-baseline justify-between rounded-xl bg-white/5 px-3 py-2">
              <span className="text-[11px] text-white/70 font-semibold">
                {currencyMeta[b.currency]?.flag} {b.currency}
              </span>
              <span className="text-[12px] text-white tabular-nums font-semibold">
                {formatMoney(b.currentValue, b.currency)}
                <span className={`ml-2 ${b.unrealized >= 0 ? 'text-receive-400' : 'text-red-300'}`}>
                  {b.unrealized >= 0 ? '+' : ''}{formatMoney(b.unrealized, b.currency)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {status === 'error' && (
          <PageErrorState variant="inline" title={t('error')} message={error ?? ''} onRetry={retry} />
        )}

        {/* A failed load must not fall through to the "create your first
            market" empty state — the user may well have markets. */}
        {status === 'error' && markets.length === 0 ? null : status === 'loading' && markets.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : markets.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            tone="accent"
            title={t('inv_empty_title')}
            description={t('inv_empty_desc')}
            actionLabel={t('inv_empty_cta')}
            onAction={() => setShowCreateMarket(true)}
          />
        ) : (
          <>
            {/* Market scope chips — hidden while there's only one market. */}
            {markets.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                <button
                  type="button"
                  onClick={() => setScopedMarketId(null)}
                  className={`shrink-0 min-h-[36px] px-3.5 py-1.5 rounded-full text-[12px] font-semibold border transition-all hover:scale-[1.03] ${
                    !scopedMarketId ? 'border-ink-900 bg-ink-900 text-white' : 'border-cream-border bg-cream-card text-ink-600 hover:bg-cream-soft'
                  }`}
                >
                  {t('inv_all_markets')}
                </button>
                {markets.map((m) => {
                  const color = marketColorFor(m.id);
                  const selected = scopedMarketId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setScopedMarketId(m.id === scopedMarketId ? null : m.id)}
                      className={`shrink-0 min-h-[36px] px-3.5 py-1.5 rounded-full text-[12px] font-semibold border transition-all active:scale-95 flex items-center gap-1.5 ${
                        selected
                          ? `${color.solid} text-white border-transparent shadow-sm`
                          : `${color.tint} ${color.text} ${color.border} hover:shadow-sm`
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${selected ? 'bg-white/80' : color.dot}`} />
                      {m.name} · {m.currency}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setShowManage(true)}
                  aria-label={t('inv_manage_markets')}
                  className="shrink-0 min-h-[36px] w-9 rounded-full border border-cream-border bg-cream-card text-ink-600 flex items-center justify-center hover:bg-info-50 hover:text-info-600 hover:border-info-600/25 active:bg-cream-soft transition-colors"
                >
                  <Settings2 size={14} />
                </button>
              </div>
            )}
            {markets.length === 1 && (
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  {markets[0].name} · {markets[0].currency}
                </p>
                <button
                  type="button"
                  onClick={() => setShowManage(true)}
                  className="text-[11px] font-semibold text-ink-500 flex items-center gap-1 active:opacity-70"
                >
                  <Settings2 size={12} /> {t('inv_manage_markets')}
                </button>
              </div>
            )}

            {/* Bulk price update + unpriced hint, shown when useful. */}
            {open.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setShowBulkPrices(true)}
                  className="min-h-[34px] px-3 py-1.5 rounded-full bg-info-50 border border-cream-border text-info-600 text-[11px] font-semibold hover:bg-info-600 hover:text-white active:scale-95 transition-all"
                >
                  {t('inv_update_prices')}
                </button>
                {(() => {
                  const unpriced = open.filter((h) => h.lastPrice === null).length;
                  return unpriced > 0 ? (
                    <span className="text-[11px] text-warn-600 font-semibold">
                      {t('inv_unpriced_chip').replace('{n}', String(unpriced))}
                    </span>
                  ) : null;
                })()}
              </div>
            )}

            {trades.length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                tone="accent"
                title={t('inv_empty_title')}
                description={t('inv_empty_desc')}
                actionLabel={t('inv_first_trade_cta')}
                onAction={() => openRecord(scopedMarket ? { marketId: scopedMarket.id } : null)}
              />
            ) : (
              <>
                <div className="space-y-2.5">{open.map(renderHolding)}</div>
                {open.length === 0 && closed.length > 0 && (
                  <p className="text-[12px] text-ink-500 text-center py-2">{t('inv_position_closed')}</p>
                )}
                {closed.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowClosed(!showClosed)}
                      className="w-full flex items-center justify-between py-2 px-1"
                    >
                      <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                        {t('inv_closed_positions')} · {closed.length}
                      </span>
                      {showClosed ? <ChevronDown size={14} className="text-ink-400" /> : <ChevronRight size={14} className="text-ink-400" />}
                    </button>
                    {showClosed && <div className="space-y-2.5">{closed.map(renderHolding)}</div>}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <RecordTradeModal open={showRecord} onClose={() => { setShowRecord(false); setRecordPreset(null); }} preset={recordPreset} />
      <CreateMarketModal open={showCreateMarket} onClose={() => setShowCreateMarket(false)} />
      <ManageMarketsSheet open={showManage} onClose={() => setShowManage(false)} />
      <UpdatePricesSheet
        open={showBulkPrices}
        onClose={() => setShowBulkPrices(false)}
        marketId={scopedMarketId}
      />
    </main>
  );
}
