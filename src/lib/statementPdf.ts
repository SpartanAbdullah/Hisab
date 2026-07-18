// One-page PDF rendering of a Statement of Account.
//
// Approach: build a fully self-contained, inline-styled DOM node offscreen,
// rasterise it with modern-screenshot, then place that image onto a single A4
// page with jsPDF. Rendering the DOM (rather than drawing text with jsPDF's
// core fonts) means the BROWSER shapes the text — so contact names in any
// script (Urdu/Arabic included) render correctly, and the output matches the
// app's look without embedding fonts. jsPDF + modern-screenshot are lazy
// dynamic-imported so they never touch the initial app bundle.
//
// The layout is grounded in fintech/accounting/typography research (see the
// design notes): one HERO net number first, a canonical Debit/Credit/Balance
// ledger, a CVD-safe color system (teal-green #047857 owed-to-you / vermillion
// #C2410C you-owe, always paired with a sign + label so color is never the sole
// cue — WCAG 1.4.1), tabular figures with the currency stated once, restraint
// over ornament (hairlines, no zebra), and honest trust scaffolding (statement
// number, period, E&OE) with no fake verification marks.

import { payOrReceiveLabel } from './statementText';
import { trimSection } from './statementOfAccount';
import type { Statement, StatementLine, StatementSection } from './statementOfAccount';
import { renderHtmlToA4Pdf } from './renderNodeToImage';

// Frame / neutrals
const NAVY = '#0B0E2A';
const INK = '#1A1A24';
const MUTED = '#6B6B66'; // ~5:1 on white — passes WCAG 4.5:1 (was #9A9A93 ≈ 2.9:1)
const HAIRLINE = '#E7E3D6';
const ROWLINE = '#F0ECE0';
// Direction (CVD-safe: differ in hue AND luminance; always paired with sign + label)
const POS = '#047857'; // owed-to-you / money in  (~4.9:1 on white)
const NEG = '#C2410C'; // you-owe / money out      (~5.0:1 on white)
const NEUTRAL = '#4B5563'; // zero / settled        (~7:1 on white)
const POS_LABEL = '#036249'; // darker teal for small labels on tinted fills
// Hero tints (fill only — never the sole carrier of meaning)
const POS_TINT = '#ECFDF5';
const NEG_TINT = '#FEF2F2';
const SETTLED_TINT = '#F1EFE8';

// A4 at 96dpi ≈ 794 × 1123 CSS px. Building at that size lets the raster map
// cleanly onto the page and lets the footer pin to the bottom edge so the page
// reads as framed and filled, not a screenshot with white space below.
const PAGE_W = 794;
const PAGE_H = 1123;
const MAX_ROWS_PER_SECTION = 16;

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

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Bare number, grouped, fixed 2dp — currency is declared once per section, not
// per row (Butterick / accounting convention), so ledger cells stay aligned.
function fmtAmount(n: number): string {
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Signed, color-coded balance. Color is redundant with the +/− sign so a
// grayscale print or a color-blind reader loses nothing.
function balanceCellHtml(n: number): string {
  if (n > 0.005) return `<span style="color:${POS};">+${fmtAmount(n)}</span>`;
  if (n < -0.005) return `<span style="color:${NEG};">−${fmtAmount(n)}</span>`;
  return `<span style="color:${NEUTRAL};">${fmtAmount(0)}</span>`;
}

// Deterministic, human-readable statement number (no persisted sequence). Same
// party + same as-of day ⇒ same number, so a re-generated statement is stable.
function statementNumber(statement: Statement, override?: string): string {
  if (override) return override;
  const d = new Date(statement.asOf);
  const ym = Number.isNaN(d.getTime())
    ? '000000'
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const seed = statement.partyName + statement.asOf.slice(0, 10);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const suffix = h.toString(36).toUpperCase().slice(0, 4).padStart(4, '0');
  return `HIS-${ym}-${suffix}`;
}

function periodLabel(statement: Statement): string | null {
  const dates = statement.sections.flatMap((s) => s.lines.map((l) => l.date)).filter(Boolean);
  if (dates.length === 0) return null;
  const from = dates.reduce((a, b) => (a.localeCompare(b) <= 0 ? a : b));
  return `${fmtDate(from)} – ${fmtDate(statement.asOf)}`;
}

function heroRowHtml(section: StatementSection, big: boolean, senderName?: string): string {
  // Recipient perspective: they PAY when they owe (out ⇒ red, −), they RECEIVE
  // when they're owed (in ⇒ green, +). Colour follows the reader's situation.
  const pr = payOrReceiveLabel(section.closing, section.currency, senderName);
  const owe = pr.mode === 'pay';
  const settled = pr.mode === 'settled';
  // Settled celebrates in green — a clean slate is good news, not a gray zero.
  const tint = settled ? POS_TINT : owe ? NEG_TINT : POS_TINT;
  const color = settled ? POS : owe ? NEG : POS;
  const labelColor = settled ? POS_LABEL : owe ? NEG : POS_LABEL;
  const sign = settled ? '' : owe ? '− ' : '+ ';
  const heading = settled
    ? `All settled 🎉 · ${section.currency}`
    : owe
      ? `Amount you need to pay · ${section.currency}`
      : `Amount you'll receive · ${section.currency}`;
  const numSize = big ? 34 : 23;
  const number = settled
    ? `<p style="margin:4px 0 0;font-size:${big ? 21 : 16}px;font-weight:700;color:${color};letter-spacing:-0.01em;">Nothing pending to pay</p>`
    : `<p style="margin:4px 0 0;font-size:${numSize}px;font-weight:700;color:${color};letter-spacing:-0.01em;">${sign}${fmtAmount(section.closing)}</p>`;
  return `<div style="background:${tint};border-radius:8px;padding:15px 18px;">
    <p style="margin:0;font-size:10px;color:${labelColor};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">${heading}</p>
    ${number}
    <p style="margin:5px 0 0;font-size:13px;color:${INK};">${esc(pr.english)} · <span style="color:${MUTED};">${esc(pr.urdu)}</span></p>
  </div>`;
}

function heroBlockHtml(statement: Statement, senderName?: string): string {
  if (!statement.hasActivity) {
    return `<div style="margin:18px 44px 0;background:${POS_TINT};border-radius:8px;padding:16px 18px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:${POS};">🎉 Congratulations — nothing pending, all settled!</p>
      <p style="margin:5px 0 0;font-size:13px;color:${INK};">Mubarak ho — hisaab bilkul barabar hai!</p>
    </div>`;
  }
  const big = statement.sections.length === 1;
  const rows = statement.sections.map((s) => heroRowHtml(s, big, senderName)).join('');
  return `<div style="margin:18px 44px 0;display:flex;flex-direction:column;gap:10px;">${rows}</div>`;
}

function ledgerRowHtml(line: StatementLine): string {
  // Description prefers the human note (kills the repeated "Loan given ·");
  // the Debit/Credit column position already encodes the entry type.
  // Recipient-focused colour: a Debit adds to what THEY owe (red = you'll pay
  // this), a Credit is a payment they made (green = reduces what you owe). The
  // running balance is negated to the recipient's side (owe = −red, receive = +green).
  const desc = line.note ? esc(line.note) : esc(line.description);
  // Fold/summary lines carry gross two-sided flows (given AND repaid, net
  // zero) — show both so the reader's payments never look erased.
  const debit = line.grossGiven && line.grossGiven > 0.005
    ? `<span style="color:${NEG};">${fmtAmount(line.grossGiven)}</span>`
    : line.delta > 0.005 ? `<span style="color:${NEG};">${fmtAmount(line.delta)}</span>` : '';
  const credit = line.grossRepaid && line.grossRepaid > 0.005
    ? `<span style="color:${POS};">${fmtAmount(line.grossRepaid)}</span>`
    : line.delta < -0.005 ? `<span style="color:${POS};">${fmtAmount(line.delta)}</span>` : '';
  return `<tr>
    <td style="padding:7px 6px 7px 0;color:${MUTED};white-space:nowrap;vertical-align:top;border-top:1px solid ${ROWLINE};">${fmtDateShort(line.date)}</td>
    <td style="padding:7px 6px;color:${INK};vertical-align:top;border-top:1px solid ${ROWLINE};">${desc}</td>
    <td style="padding:7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${debit}</td>
    <td style="padding:7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${credit}</td>
    <td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${balanceCellHtml(-line.balance)}</td>
  </tr>`;
}

function sectionHtml(section: StatementSection): string {
  const { opening, lines } = trimSection(section, MAX_ROWS_PER_SECTION);
  const openingBalance = opening ? opening.balance : 0;
  const openingLabel = opening
    ? `Balance brought forward · ${opening.count} earlier ${opening.count === 1 ? 'entry' : 'entries'}`
    : 'Opening balance';

  // Period totals over the VISIBLE rows so opening + debits − credits = closing
  // reconciles exactly with what's printed.
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    // Gross lines add equally to both sides (net zero on the balance), so
    // the totals row reflects the REAL money story: everything given,
    // everything paid back, and the difference still reconciles.
    if (l.grossGiven) totalDebit += l.grossGiven;
    if (l.grossRepaid) totalCredit += l.grossRepaid;
    if (l.delta > 0.005) totalDebit += l.delta;
    else if (l.delta < -0.005) totalCredit += -l.delta;
  }

  const estimatedNote = section.estimated
    ? `<p style="margin:8px 0 0;font-size:11px;color:${MUTED};">Some entries are summarised from loan balances — itemised rows weren't recorded for them.</p>`
    : '';

  return `<div style="padding:16px 44px 0;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
      <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Activity</span>
      <span style="font-size:10px;color:${MUTED};">All amounts in ${section.currency}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:12.5px;font-variant-numeric:tabular-nums;">
      <thead>
        <tr style="color:${MUTED};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;">
          <th style="font-weight:600;text-align:left;padding:8px 6px 6px 0;">Date</th>
          <th style="font-weight:600;text-align:left;padding:8px 6px 6px;">Description</th>
          <th style="font-weight:600;text-align:right;padding:8px 6px 6px;">You received<br><span style="font-weight:500;text-transform:none;letter-spacing:0;">Aap ko mila</span></th>
          <th style="font-weight:600;text-align:right;padding:8px 6px 6px;">You gave<br><span style="font-weight:500;text-transform:none;letter-spacing:0;">Aap ne diye</span></th>
          <th style="font-weight:600;text-align:right;padding:8px 0 6px 6px;">Balance<br><span style="font-weight:500;text-transform:none;letter-spacing:0;">Baqi</span></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:7px 6px 7px 0;color:${MUTED};border-top:1px solid ${ROWLINE};">—</td>
          <td style="padding:7px 6px;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">${openingLabel}</td>
          <td style="border-top:1px solid ${ROWLINE};"></td>
          <td style="border-top:1px solid ${ROWLINE};"></td>
          <td style="padding:7px 0 7px 6px;text-align:right;border-top:1px solid ${ROWLINE};">${balanceCellHtml(-openingBalance)}</td>
        </tr>
        ${lines.map(ledgerRowHtml).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid ${NAVY};">
          <td colspan="2" style="padding:10px 6px 0 0;font-weight:600;color:${INK};">Outstanding balance</td>
          <td style="padding:10px 6px 0;text-align:right;font-weight:600;color:${NEG};">${fmtAmount(totalDebit)}</td>
          <td style="padding:10px 6px 0;text-align:right;font-weight:600;color:${POS};">${fmtAmount(totalCredit)}</td>
          <td style="padding:10px 0 0 6px;text-align:right;font-weight:700;">${balanceCellHtml(-section.closing)}</td>
        </tr>
      </tfoot>
    </table>
    ${estimatedNote}
  </div>`;
}

export interface StatementPdfOptions {
  fromName?: string; // current user's display name — shown as "Prepared by" and signs off the statement
  phone?: string | null; // counterparty phone, shown under their name when known
  refCode?: string; // override the auto statement number
  greeting?: string; // friendly opener, e.g. "Hello Rashid," — empty ⇒ omitted
}

// Inline styles for the offscreen page node. Exported so a dev harness / test
// can render the exact same markup a browser rasterises into the PDF.
export const STATEMENT_NODE_STYLE = [
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

// The full inner markup of the statement page. Pure string → deterministic and
// unit-testable; buildNode wraps it in the offscreen node for rasterisation.
export function renderStatementInnerHtml(statement: Statement, opts: StatementPdfOptions = {}): string {
  const stmtNo = statementNumber(statement, opts.refCode);
  const period = periodLabel(statement);
  const partyPhone = opts.phone
    ? `<p style="margin:1px 0 0;font-size:12px;color:${MUTED};">${esc(opts.phone)}</p>`
    : '';
  const preparedBy = opts.fromName
    ? `<div style="text-align:right;">
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">Prepared by</p>
        <p style="margin:3px 0 0;font-size:13px;font-weight:600;color:${INK};">${esc(opts.fromName)}</p>
      </div>`
    : '';
  // Warm opener + sign-off so the statement reads as a message, not an export.
  const greetingHtml = opts.greeting?.trim()
    ? `<div style="padding:14px 44px 0;"><p style="margin:0;font-size:15px;color:${INK};">${esc(opts.greeting.trim())}</p></div>`
    : '';
  const signOffHtml = opts.fromName?.trim()
    ? `<div style="padding:16px 44px 4px;">
        <p style="margin:0;font-size:12.5px;color:${MUTED};">Thank you,</p>
        <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${INK};">${esc(opts.fromName.trim())}</p>
      </div>`
    : '';

  return `
    <div style="background:${NAVY};padding:20px 44px;display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Hisaab</div>
        <div style="font-size:12px;color:#9DA2C0;margin-top:2px;">Statement of account</div>
      </div>
      <div style="text-align:right;line-height:1.5;color:#ffffff;">
        <div style="font-size:11px;color:#C7CAE0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">No. ${esc(stmtNo)}</div>
        <div style="font-size:12px;margin-top:2px;">As of ${fmtDate(statement.asOf)}</div>
        ${period ? `<div style="font-size:11px;color:#9DA2C0;">Period ${period}</div>` : ''}
      </div>
    </div>

    <div style="padding:18px 44px 0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;">
      <div>
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">Account of</p>
        <p style="margin:4px 0 0;font-size:25px;font-weight:700;color:${INK};letter-spacing:-0.015em;line-height:1.1;">${esc(statement.partyName)}</p>
        ${partyPhone}
      </div>
      ${preparedBy}
    </div>

    ${greetingHtml}

    ${heroBlockHtml(statement, opts.fromName)}

    ${statement.hasActivity ? statement.sections.map(sectionHtml).join('') : ''}

    ${signOffHtml}

    <div style="margin-top:auto;padding:14px 44px;background:${SETTLED_TINT};border-top:1px solid ${HAIRLINE};display:flex;justify-content:space-between;align-items:flex-end;gap:16px;">
      <p style="margin:0;font-size:10px;color:${MUTED};line-height:1.6;">
        <span style="color:${NEG};font-weight:600;">− you need to pay</span> &nbsp;·&nbsp; <span style="color:${POS};font-weight:600;">+ you'll receive</span> &nbsp;·&nbsp; "You received" adds to your balance, "You gave" reduces it<br>
        Generated by Hisaab on ${fmtDateTime(statement.asOf)} · A summary of recorded transactions, not a legal document. E&amp;OE.
      </p>
      <p style="margin:0;font-size:10px;color:${MUTED};white-space:nowrap;">Page 1 of 1</p>
    </div>
  `;
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
  const html = renderStatementInnerHtml(statement, opts);
  const blob = await renderHtmlToA4Pdf(html, {
    width: PAGE_W,
    nodeStyle: STATEMENT_NODE_STYLE, // carries min-height so the footer pins to the page bottom
    scale: 2,
    title: `Statement of account — ${statement.partyName}`,
    subject: `Statement of account as of ${fmtDate(statement.asOf)}`,
    author: opts.fromName || 'Hisaab',
  });
  // Local date, not UTC — a Gulf user generating at 00:15 local would
  // otherwise get yesterday's date in the filename while the statement
  // itself says today. en-CA formats as YYYY-MM-DD.
  const datePart = new Date(statement.asOf).toLocaleDateString('en-CA');
  const filename = `Statement-${sanitizeFilename(statement.partyName)}-${datePart}.pdf`;
  return { blob, filename };
}
