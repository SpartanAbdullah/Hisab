// Hisaab Wrapped — a shareable portrait (1080×1920, WhatsApp-Status-shaped)
// image card of the Monthly Wrap. Turns the in-app-only wrap into an organic
// growth loop: every Status view is a branded impression in front of non-users.
//
// Privacy by default: shows "proud numbers" (categories, shares, active days,
// spend-change) and only reveals exact Spent/Earned/Net when the user opts in.
// Renders via the shared renderNodeToImage core (DOM → PNG).

import { formatMoney } from './constants';
import { renderHtmlToPng } from './renderNodeToImage';
import type { WrapStats } from './monthlyWrap';

const CARD_W = 1080;
const CARD_H = 1920;
const ACCENT = '#34D399';
const MUTED = '#9DA2C0';
const WARN = '#FCA5A5';

const NODE_STYLE = [
  'display:flex',
  'flex-direction:column',
  'padding:90px 80px',
  'box-sizing:border-box',
  'color:#ffffff',
  "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
].join(';');

export interface WrapCardOptions {
  showTotals: boolean; // opt-in to exact Spent/Earned/Net figures
  connectCode?: string; // e.g. "HSB-4F2A9" so a Status viewer can find the user
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderWrapCardHtml(stats: WrapStats, opts: WrapCardOptions): string {
  const cats = stats.topCategories.map((c, i) => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:${i === 0 ? 26 : 18}px;">
      <span style="font-size:46px;font-weight:600;">${esc(c.category)}</span>
      <span style="font-size:46px;font-weight:800;color:${ACCENT};">${c.share}%</span>
    </div>`).join('');

  const change = stats.spendChangePercent == null ? '' : `
    <div>
      <p style="margin:0;font-size:70px;font-weight:800;color:${stats.spendChangePercent <= 0 ? ACCENT : WARN};">${stats.spendChangePercent <= 0 ? '▼' : '▲'} ${Math.abs(stats.spendChangePercent).toFixed(0)}%</p>
      <p style="margin:6px 0 0;font-size:28px;color:${MUTED};">vs last month</p>
    </div>`;

  const totals = opts.showTotals ? `
    <div style="display:flex;gap:56px;flex-wrap:wrap;">
      <div><p style="margin:0;font-size:26px;color:${MUTED};">Spent</p><p style="margin:6px 0 0;font-size:48px;font-weight:800;">${esc(formatMoney(stats.totalSpent, stats.primaryCurrency))}</p></div>
      <div><p style="margin:0;font-size:26px;color:${MUTED};">Earned</p><p style="margin:6px 0 0;font-size:48px;font-weight:800;">${esc(formatMoney(stats.totalIncome, stats.primaryCurrency))}</p></div>
      <div><p style="margin:0;font-size:26px;color:${MUTED};">Net</p><p style="margin:6px 0 0;font-size:48px;font-weight:800;color:${stats.net >= 0 ? ACCENT : WARN};">${esc(formatMoney(stats.net, stats.primaryCurrency))}</p></div>
    </div>` : '';

  return `
    <div style="flex:0 0 auto;">
      <p style="margin:0;font-size:30px;letter-spacing:0.2em;color:${ACCENT};font-weight:700;">HISAAB WRAPPED</p>
      <p style="margin:12px 0 0;font-size:78px;font-weight:800;line-height:1.03;">${esc(stats.monthLabel)}</p>
      <p style="margin:28px 0 0;font-size:34px;color:#C7CAE0;line-height:1.4;">${esc(stats.headline)}</p>
    </div>

    <div style="flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;gap:56px;">
      <div>
        <p style="margin:0;font-size:26px;letter-spacing:0.12em;color:${MUTED};text-transform:uppercase;">Top spending</p>
        ${cats || `<p style="margin:24px 0 0;font-size:40px;color:${MUTED};">A quiet month.</p>`}
      </div>
      <div style="display:flex;gap:70px;">
        <div>
          <p style="margin:0;font-size:70px;font-weight:800;color:${ACCENT};">${stats.activeDays}</p>
          <p style="margin:6px 0 0;font-size:28px;color:${MUTED};">active days</p>
        </div>
        ${change}
      </div>
      ${totals}
    </div>

    <div style="flex:0 0 auto;border-top:1px solid rgba(255,255,255,0.15);padding-top:40px;">
      <p style="margin:0;font-size:32px;font-weight:700;">— tracked with Hisaab</p>
      <p style="margin:10px 0 0;font-size:26px;color:${MUTED};">${opts.connectCode ? esc(opts.connectCode) + ' · ' : ''}usehisaab.com</p>
    </div>
  `;
}

export interface WrapCardResult {
  blob: Blob;
  filename: string;
}

export async function generateWrapCard(stats: WrapStats, opts: WrapCardOptions): Promise<WrapCardResult> {
  const html = renderWrapCardHtml(stats, opts);
  const { blob } = await renderHtmlToPng(html, {
    width: CARD_W,
    height: CARD_H,
    scale: 1.5, // node is already 1080 wide — 1.5 keeps it crisp while bounding memory on low-end Android
    backgroundColor: '#0B0E2A',
    nodeStyle: NODE_STYLE,
  });
  return { blob, filename: `Hisaab-Wrapped-${stats.monthKey}.png` };
}
