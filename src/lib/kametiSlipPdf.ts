// Kameti (committee/ROSCA) payout slip — a premium "You received the Round N
// payout" one-pager the organiser sends to the member who just took their baari.
// Footed with the anonymous witness link so a suspicious member can verify the
// honest ledger + provably-fair draw independently. Reuses the shared
// renderNodeToImage core and the statement's visual language.

import { renderHtmlToA4Pdf } from './renderNodeToImage';
import { AMOUNT_MASK } from './maskMoney';

const NAVY = '#0B0E2A';
const INK = '#1A1A24';
const MUTED = '#6B6B66';
const HAIRLINE = '#E7E3D6';
const POS = '#047857';
const POS_TINT = '#ECFDF5';
const PAGE_W = 794;
const PAGE_H = 1123;

const NODE_STYLE = [
  `width:${PAGE_W}px`,
  `min-height:${PAGE_H}px`,
  'display:flex',
  'flex-direction:column',
  'box-sizing:border-box',
  'background:#ffffff',
  "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans','Noto Nastaliq Urdu',sans-serif",
  `color:${INK}`,
  'font-variant-numeric:tabular-nums',
].join(';');

export interface KametiSlipInput {
  committeeName: string;
  currency: string;
  round: number;
  totalRounds: number;
  pool: number; // the payout amount
  recipientName: string;
  contributed: number; // recipient's contributions so far
  net: number; // received − contributed
  witnessUrl?: string; // anonymous "verify live" link
  date: string; // ISO payout date
  organiserName?: string;
  // Privacy: every figure renders as the fixed-width mask. NOTE the witness
  // link (when present) still opens the live ledger with real amounts — the
  // slip's trust seal is deliberately not maskable.
  hideAmounts?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtAmount(n: number): string {
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'kameti';
}

export function renderKametiSlipInnerHtml(input: KametiSlipInput): string {
  const { committeeName, currency, round, totalRounds, pool, recipientName, contributed, net, witnessUrl, date, organiserName } = input;
  // "Hide amounts": bare-number mask (currency is stated once in the hero label).
  const fmt = input.hideAmounts ? () => AMOUNT_MASK : fmtAmount;

  const witnessBlock = witnessUrl
    ? `<div style="padding:18px 44px 0;">
        <div style="border:1px solid ${HAIRLINE};border-radius:8px;padding:14px 16px;">
          <p style="margin:0;font-size:11px;color:${MUTED};font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Verify this kameti live</p>
          <p style="margin:6px 0 0;font-size:13px;color:${INK};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;">${esc(witnessUrl)}</p>
          <p style="margin:6px 0 0;font-size:11px;color:${MUTED};">Anyone can open this read-only link to check every contribution and the provably-fair draw.</p>
        </div>
      </div>`
    : '';

  const preparedBy = organiserName
    ? `<div style="text-align:right;"><p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">Organiser</p><p style="margin:3px 0 0;font-size:13px;font-weight:600;color:${INK};">${esc(organiserName)}</p></div>`
    : '';

  return `
    <div style="background:${NAVY};padding:20px 44px;display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Hisaab</div>
        <div style="font-size:12px;color:#9DA2C0;margin-top:2px;">Kameti payout slip</div>
      </div>
      <div style="text-align:right;color:#ffffff;line-height:1.5;">
        <div style="font-size:12px;">Round ${round} of ${totalRounds}</div>
        <div style="font-size:11px;color:#9DA2C0;">${fmtDate(date)}</div>
      </div>
    </div>

    <div style="padding:18px 44px 0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;">
      <div>
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">Committee</p>
        <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:${INK};letter-spacing:-0.015em;">${esc(committeeName)}</p>
      </div>
      ${preparedBy}
    </div>

    <div style="margin:18px 44px 0;background:${POS_TINT};border-radius:8px;padding:16px 18px;">
      <p style="margin:0;font-size:10px;color:${POS};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">You received · ${esc(currency)}</p>
      <p style="margin:4px 0 0;font-size:34px;font-weight:700;color:${POS};letter-spacing:-0.01em;">${fmt(pool)}</p>
      <p style="margin:5px 0 0;font-size:13px;color:${INK};">${esc(recipientName)} received the Round ${round} payout.</p>
    </div>

    <div style="padding:18px 44px 0;">
      <div style="display:flex;gap:44px;">
        <div>
          <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.05em;text-transform:uppercase;">Contributed so far</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:600;">${fmt(contributed)}</p>
        </div>
        <div>
          <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.05em;text-transform:uppercase;">Net position</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:600;color:${net >= 0 ? POS : INK};">${net >= 0 ? '+' : '−'}${fmt(net)}</p>
        </div>
      </div>
    </div>

    ${witnessBlock}

    <div style="margin-top:auto;padding:14px 44px;background:#FAF8F1;border-top:1px solid ${HAIRLINE};display:flex;justify-content:space-between;align-items:flex-end;gap:16px;">
      <p style="margin:0;font-size:10px;color:${MUTED};line-height:1.6;">
        A no-custody record — Hisaab tracks the committee, it never holds the pool. Generated on ${fmtDateTime(date)}. E&amp;OE.
      </p>
      <p style="margin:0;font-size:10px;color:${MUTED};white-space:nowrap;">Page 1 of 1</p>
    </div>
  `;
}

export interface KametiSlipResult {
  blob: Blob;
  filename: string;
}

export async function generateKametiSlipPdf(input: KametiSlipInput): Promise<KametiSlipResult> {
  const html = renderKametiSlipInnerHtml(input);
  const blob = await renderHtmlToA4Pdf(html, {
    width: PAGE_W,
    nodeStyle: NODE_STYLE,
    scale: 2,
    title: `Kameti payout — ${input.committeeName} (Round ${input.round})`,
    subject: 'Kameti payout slip',
    author: input.organiserName || 'Hisaab',
  });
  const datePart = new Date(input.date).toISOString().slice(0, 10);
  const filename = `Kameti-Payout-${sanitizeFilename(input.committeeName)}-R${input.round}-${datePart}.pdf`;
  return { blob, filename };
}
