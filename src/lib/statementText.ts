// Plain-text rendering of a Statement of Account, for the WhatsApp deep-link
// body (wa.me carries text only) and the "copy" fallback. The PDF renderer in
// statementPdf.ts is the richer sibling; this is the always-available,
// zero-dependency path that works for any contact, app user or not.

import { format } from 'date-fns';
import { formatMoney } from './constants';
import type { Statement, StatementLine } from './statementOfAccount';
import { trimSection } from './statementOfAccount';

// Human sentence for a signed net balance. Positive ⇒ they owe you.
export function netBalanceLabel(partyName: string, closing: number, currency: string): string {
  if (closing > 0.005) return `${partyName} owes you ${formatMoney(closing, currency)}`;
  if (closing < -0.005) return `You owe ${partyName} ${formatMoney(Math.abs(closing), currency)}`;
  return `Settled up with ${partyName}`;
}

function signedAmount(delta: number, currency: string): string {
  const sign = delta < 0 ? '−' : '+'; // − vs +
  return `${sign}${formatMoney(Math.abs(delta), currency)}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'd MMM yyyy');
}

function lineText(line: StatementLine, currency: string): string {
  const parts = [shortDate(line.date), line.description, signedAmount(line.delta, currency)];
  return `• ${parts.filter(Boolean).join(' · ')}`; // • date · desc · +amt
}

export interface RenderStatementTextOptions {
  asOfLabel?: string; // pre-formatted date; defaults to formatting statement.asOf
  maxLinesPerSection?: number; // keep the message short; older lines fold to b/f
}

export function renderStatementText(statement: Statement, opts: RenderStatementTextOptions = {}): string {
  const { partyName, sections } = statement;
  const asOf = opts.asOfLabel ?? shortDate(statement.asOf);
  const maxLines = opts.maxLinesPerSection ?? 10;

  const out: string[] = [];
  out.push('*Statement of account*');
  out.push(partyName);
  if (asOf) out.push(`As of ${asOf}`);

  if (sections.length === 0) {
    out.push('');
    out.push(`Settled up with ${partyName} — nothing outstanding.`);
  }

  for (const section of sections) {
    out.push(''); // blank line between blocks
    out.push(netBalanceLabel(partyName, section.closing, section.currency));

    const { opening, lines } = trimSection(section, maxLines);
    if (opening) {
      out.push(
        `• Balance brought forward · ${signedAmount(opening.balance, section.currency)}` +
          ` (${opening.count} earlier ${opening.count === 1 ? 'entry' : 'entries'})`,
      );
    }
    for (const line of lines) out.push(lineText(line, section.currency));

    out.push(`Outstanding: ${netBalanceLabel(partyName, section.closing, section.currency)}`);
    if (section.estimated) {
      out.push('(Balance only — itemised history not tracked in this mode.)');
    }
  }

  out.push('');
  out.push('— via Hisaab');
  return out.join('\n');
}
