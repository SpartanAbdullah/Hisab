// One-page "settle-up plan" PDF for a split group: every X-pays-Y transfer plus
// the itemised expenses behind them. Reuses the shared renderNodeToImage core
// and the statement's visual language (navy letterhead, hairlines, tabular
// figures, currency stated once, E&OE).

import { renderHtmlToA4Pdf } from './renderNodeToImage';
import type { GroupDebt } from './groupDebts';

const NAVY = '#0B0E2A';
const INK = '#1A1A24';
const MUTED = '#6B6B66';
const HAIRLINE = '#E7E3D6';
const ROWLINE = '#F0ECE0';
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

export interface GroupPlanExpense {
  date: string; // ISO
  description: string;
  paidByName: string;
  amount: number;
}

export interface GroupSettleUpPdfInput {
  groupName: string;
  emoji?: string;
  currency: string;
  debts: ReadonlyArray<GroupDebt>;
  expenses: ReadonlyArray<GroupPlanExpense>;
  simplify: boolean;
  asOf: string; // ISO
  fromName?: string;
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
  return name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'group';
}

export function renderGroupSettleUpInnerHtml(input: GroupSettleUpPdfInput): string {
  const { groupName, emoji, currency, debts, expenses, simplify, asOf } = input;

  const transfersRows = debts.length === 0
    ? `<tr><td colspan="3" style="padding:10px 6px;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">Everyone is settled up — nothing outstanding.</td></tr>`
    : debts.map((d) => `<tr>
        <td style="padding:8px 6px;border-top:1px solid ${ROWLINE};">${esc(d.fromName)}</td>
        <td style="padding:8px 6px;border-top:1px solid ${ROWLINE};color:${MUTED};">→ ${esc(d.toName)}</td>
        <td style="padding:8px 0 8px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};font-weight:600;">${fmtAmount(d.amount)}</td>
      </tr>`).join('');

  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const expenseRows = expenses.length === 0
    ? `<tr><td colspan="4" style="padding:10px 6px;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">No expenses recorded.</td></tr>`
    : expenses.map((e) => `<tr>
        <td style="padding:7px 6px 7px 0;color:${MUTED};white-space:nowrap;border-top:1px solid ${ROWLINE};">${fmtDate(e.date)}</td>
        <td style="padding:7px 6px;border-top:1px solid ${ROWLINE};">${esc(e.description || '—')}</td>
        <td style="padding:7px 6px;color:${MUTED};border-top:1px solid ${ROWLINE};">${esc(e.paidByName)}</td>
        <td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${fmtAmount(e.amount)}</td>
      </tr>`).join('');

  return `
    <div style="background:${NAVY};padding:20px 44px;display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Hisaab</div>
        <div style="font-size:12px;color:#9DA2C0;margin-top:2px;">Settle-up plan</div>
      </div>
      <div style="text-align:right;color:#ffffff;line-height:1.5;">
        <div style="font-size:12px;">As of ${fmtDate(asOf)}</div>
        <div style="font-size:11px;color:#9DA2C0;">${simplify ? 'Simplified' : 'Direct — who owes whom'}</div>
      </div>
    </div>

    <div style="padding:18px 44px 0;">
      <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">Group</p>
      <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:${INK};letter-spacing:-0.015em;">${emoji ? `${esc(emoji)} ` : ''}${esc(groupName)}</p>
    </div>

    <div style="padding:18px 44px 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
        <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Who pays whom</span>
        <span style="font-size:10px;color:${MUTED};">All amounts in ${esc(currency)}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:13px;font-variant-numeric:tabular-nums;">
        <tbody>${transfersRows}</tbody>
      </table>
    </div>

    <div style="padding:20px 44px 0;">
      <div style="border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
        <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Expenses</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:12.5px;font-variant-numeric:tabular-nums;">
        <thead>
          <tr style="color:${MUTED};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;">
            <th style="font-weight:600;text-align:left;padding:8px 6px 6px 0;">Date</th>
            <th style="font-weight:600;text-align:left;padding:8px 6px 6px;">Description</th>
            <th style="font-weight:600;text-align:left;padding:8px 6px 6px;">Paid by</th>
            <th style="font-weight:600;text-align:right;padding:8px 0 6px 6px;">Amount</th>
          </tr>
        </thead>
        <tbody>${expenseRows}</tbody>
        <tfoot>
          <tr style="border-top:2px solid ${NAVY};">
            <td colspan="3" style="padding:10px 6px 0 0;font-weight:600;">Total</td>
            <td style="padding:10px 0 0 6px;text-align:right;font-weight:700;">${fmtAmount(expenseTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div style="margin-top:auto;padding:14px 44px;background:#FAF8F1;border-top:1px solid ${HAIRLINE};display:flex;justify-content:space-between;align-items:flex-end;gap:16px;">
      <p style="margin:0;font-size:10px;color:${MUTED};line-height:1.6;">
        Settle the transfers above to clear the group. Generated by Hisaab on ${fmtDateTime(asOf)}. A summary of recorded expenses, not a legal document. E&amp;OE.
      </p>
      <p style="margin:0;font-size:10px;color:${MUTED};white-space:nowrap;">Page 1 of 1</p>
    </div>
  `;
}

export interface GroupSettleUpPdfResult {
  blob: Blob;
  filename: string;
}

export async function generateGroupSettleUpPdf(input: GroupSettleUpPdfInput): Promise<GroupSettleUpPdfResult> {
  const html = renderGroupSettleUpInnerHtml(input);
  const blob = await renderHtmlToA4Pdf(html, {
    width: PAGE_W,
    nodeStyle: NODE_STYLE,
    scale: 2,
    title: `Settle up — ${input.groupName}`,
    subject: 'Group settle-up plan',
    author: input.fromName || 'Hisaab',
  });
  const datePart = new Date(input.asOf).toISOString().slice(0, 10);
  const filename = `SettleUp-${sanitizeFilename(input.groupName)}-${datePart}.pdf`;
  return { blob, filename };
}
