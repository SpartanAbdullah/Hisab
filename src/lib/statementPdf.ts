// One-page PDF rendering of a Statement of Account.
//
// Approach: build a fully self-contained, inline-styled DOM node offscreen,
// rasterise it with modern-screenshot, then place that image onto a single A4
// page with jsPDF. Rendering the DOM (rather than drawing text with jsPDF's
// core fonts) means the BROWSER shapes the text — so contact names in any
// script (Urdu/Arabic included) render correctly, and the output matches the
// app's look without embedding fonts. jsPDF + modern-screenshot are lazy
// dynamic-imported so they never touch the initial app bundle.

import { formatMoney } from './constants';
import { netBalanceLabel } from './statementText';
import { trimSection } from './statementOfAccount';
import type { Statement, StatementLine } from './statementOfAccount';

const NAVY = '#0B0E2A';
const INK = '#1A1A24';
const MUTED = '#6B6B66';
const HAIRLINE = '#E7E3D6';
const RECEIVE_BG = '#E1F5EE';
const RECEIVE_TEXT = '#0F6E56';
const PAY_BG = '#FCEBEB';
const PAY_TEXT = '#A32D2D';

// A4 at 96dpi is ~794 × 1123 CSS px. We build at that width so the raster maps
// cleanly onto the PDF page.
const PAGE_W = 794;
const MAX_ROWS_PER_SECTION = 18;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function signed(delta: number, currency: string): string {
  const sign = delta < 0 ? '−' : '+';
  return `${sign}${formatMoney(Math.abs(delta), currency)}`;
}

function rowHtml(line: StatementLine, currency: string): string {
  const desc = line.note ? `${esc(line.description)} · ${esc(line.note)}` : esc(line.description);
  const deltaColor = line.delta < 0 ? MUTED : RECEIVE_TEXT;
  return `<tr>
    <td style="padding:8px 0;color:${MUTED};white-space:nowrap;vertical-align:top;">${fmtDate(line.date)}</td>
    <td style="padding:8px 12px;color:${INK};vertical-align:top;">${desc}</td>
    <td style="padding:8px 0;text-align:right;color:${deltaColor};white-space:nowrap;font-variant-numeric:tabular-nums;">${signed(line.delta, currency)}</td>
    <td style="padding:8px 0;text-align:right;color:${INK};white-space:nowrap;font-variant-numeric:tabular-nums;">${formatMoney(line.balance, currency)}</td>
  </tr>`;
}

function sectionHtml(statement: Statement, section: Statement['sections'][number]): string {
  const positive = section.closing > 0.005;
  const settled = Math.abs(section.closing) <= 0.005;
  const bg = settled ? '#F1EFE8' : positive ? RECEIVE_BG : PAY_BG;
  const fg = settled ? MUTED : positive ? RECEIVE_TEXT : PAY_TEXT;
  const label = netBalanceLabel(statement.partyName, section.closing, section.currency);

  const { opening, lines } = trimSection(section, MAX_ROWS_PER_SECTION);
  const openingRow = opening
    ? `<tr>
        <td style="padding:8px 0;color:${MUTED};white-space:nowrap;vertical-align:top;">—</td>
        <td style="padding:8px 12px;color:${MUTED};vertical-align:top;">Balance brought forward · ${opening.count} earlier ${opening.count === 1 ? 'entry' : 'entries'}</td>
        <td style="padding:8px 0;text-align:right;color:${MUTED};white-space:nowrap;"></td>
        <td style="padding:8px 0;text-align:right;color:${INK};white-space:nowrap;font-variant-numeric:tabular-nums;">${formatMoney(opening.balance, section.currency)}</td>
      </tr>`
    : '';

  const estimatedNote = section.estimated
    ? `<p style="margin:8px 0 0;font-size:12px;color:${MUTED};">Balance only — itemised repayment history is not tracked for these loans.</p>`
    : '';

  return `<div style="margin-top:22px;">
    <div style="display:flex;justify-content:space-between;align-items:center;background:${bg};border-radius:8px;padding:12px 16px;">
      <span style="font-size:13px;font-weight:600;color:${fg};">${esc(label)}</span>
      <span style="font-size:11px;font-weight:600;color:${fg};letter-spacing:0.04em;">${section.currency}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;">
      <thead>
        <tr style="color:${MUTED};text-align:left;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;">
          <th style="font-weight:600;padding:0 0 8px;">Date</th>
          <th style="font-weight:600;padding:0 12px 8px;">Description</th>
          <th style="font-weight:600;padding:0 0 8px;text-align:right;">Amount</th>
          <th style="font-weight:600;padding:0 0 8px;text-align:right;">Balance</th>
        </tr>
      </thead>
      <tbody style="border-top:1px solid ${HAIRLINE};">
        ${openingRow}
        ${lines.map((l) => rowHtml(l, section.currency)).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid ${HAIRLINE};">
          <td colspan="3" style="padding:11px 0 0;font-weight:600;color:${INK};">Outstanding balance</td>
          <td style="padding:11px 0 0;text-align:right;font-weight:600;color:${fg};white-space:nowrap;font-variant-numeric:tabular-nums;">${esc(formatMoney(Math.abs(section.closing), section.currency))}</td>
        </tr>
      </tfoot>
    </table>
    ${estimatedNote}
  </div>`;
}

export interface StatementPdfOptions {
  fromName?: string; // the current user's display name, shown as "Prepared by"
  phone?: string | null; // counterparty phone, shown under their name when known
  refCode?: string; // short reference id, e.g. an account/public code
}

function buildNode(statement: Statement, opts: StatementPdfOptions): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${PAGE_W}px`,
    'box-sizing:border-box',
    'padding:44px 48px',
    'background:#ffffff',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans','Noto Nastaliq Urdu',sans-serif",
    `color:${INK}`,
    'pointer-events:none',
  ].join(';');

  const asOf = fmtDate(statement.asOf);
  const sectionsHtml = statement.hasActivity
    ? statement.sections.map((s) => sectionHtml(statement, s)).join('')
    : `<div style="margin-top:22px;background:#F1EFE8;border-radius:8px;padding:16px;">
        <span style="font-size:14px;font-weight:600;color:${MUTED};">Settled up with ${esc(statement.partyName)} — nothing outstanding.</span>
      </div>`;

  const partyPhone = opts.phone ? `<p style="margin:1px 0 0;font-size:13px;color:${MUTED};">${esc(opts.phone)}</p>` : '';
  const preparedBy = opts.fromName
    ? `<div>
        <p style="margin:0;font-size:10px;color:#9A9A93;letter-spacing:0.05em;text-transform:uppercase;">Prepared by</p>
        <p style="margin:3px 0 0;font-size:14px;font-weight:600;color:${INK};">${esc(opts.fromName)}</p>
      </div>`
    : '';
  const refHtml = opts.refCode
    ? `<p style="margin:2px 0 0;font-size:11px;color:#9A9A93;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">Ref ${esc(opts.refCode)}</p>`
    : '';

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid ${HAIRLINE};padding-bottom:16px;">
      <div>
        <div style="font-size:20px;font-weight:700;color:${NAVY};letter-spacing:-0.01em;">Hisaab</div>
        <p style="margin:4px 0 0;font-size:13px;color:${MUTED};">Statement of account</p>
      </div>
      <div style="text-align:right;">
        <p style="margin:0;font-size:13px;color:${MUTED};">As of ${asOf}</p>
        ${refHtml}
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;gap:16px;margin-top:16px;">
      <div>
        <p style="margin:0;font-size:10px;color:#9A9A93;letter-spacing:0.05em;text-transform:uppercase;">Account of</p>
        <p style="margin:3px 0 0;font-size:15px;font-weight:600;color:${INK};">${esc(statement.partyName)}</p>
        ${partyPhone}
      </div>
      ${preparedBy}
    </div>

    ${sectionsHtml}

    <div style="margin-top:26px;border-top:1px solid ${HAIRLINE};padding-top:12px;">
      <p style="margin:0;font-size:11px;color:#9A9A93;">Generated by Hisaab on ${fmtDateTime(statement.asOf)}. A summary of recorded transactions, not a legal document.</p>
    </div>
  `;

  return el;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'contact';
}

export interface StatementPdfResult {
  blob: Blob;
  filename: string;
}

export async function generateStatementPdf(
  statement: Statement,
  opts: StatementPdfOptions = {},
): Promise<StatementPdfResult> {
  const [{ domToPng }, jspdfModule] = await Promise.all([
    import('modern-screenshot'),
    import('jspdf'),
  ]);
  const JsPDF = jspdfModule.jsPDF;

  const node = buildNode(statement, opts);
  document.body.appendChild(node);

  let dataUrl: string;
  let cssWidth: number;
  let cssHeight: number;
  try {
    // Two paints so layout + web fonts settle before the snapshot.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = node.getBoundingClientRect();
    cssWidth = rect.width || PAGE_W;
    cssHeight = rect.height || PAGE_W * 1.414;
    dataUrl = await domToPng(node, {
      scale: 2,
      backgroundColor: '#ffffff',
      width: cssWidth,
      height: cssHeight,
    });
  } finally {
    node.remove();
  }

  // A4 portrait in points.
  const pageW = 595.28;
  const pageH = 841.89;
  const pdf = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });

  // Fit the rendered image to the page width; if that overflows the page
  // height, clamp to height instead so it always stays a single page.
  const ratio = cssHeight / cssWidth;
  let drawW = pageW;
  let drawH = pageW * ratio;
  if (drawH > pageH) {
    drawH = pageH;
    drawW = pageH / ratio;
  }
  const offsetX = (pageW - drawW) / 2;
  pdf.addImage(dataUrl, 'PNG', offsetX, 0, drawW, drawH, undefined, 'FAST');

  const blob = pdf.output('blob') as Blob;
  const datePart = new Date(statement.asOf).toISOString().slice(0, 10);
  const filename = `Statement-${sanitizeFilename(statement.partyName)}-${datePart}.pdf`;
  return { blob, filename };
}
