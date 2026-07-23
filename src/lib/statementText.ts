// Plain-text rendering of a Statement of Account, for the WhatsApp deep-link
// body (wa.me carries text only) and the "copy" fallback. The PDF renderer in
// statementPdf.ts is the richer sibling; this is the always-available,
// zero-dependency path that works for any contact, app user or not.

import { format } from 'date-fns';
import { formatMoney } from './constants';
import { moneyFormatter } from './maskMoney';
import type { Statement, StatementLine } from './statementOfAccount';
import { trimSection } from './statementOfAccount';

// formatMoney-compatible formatter threaded through the render helpers so the
// "Hide amounts" toggle swaps every figure for the mask in one place.
export type MoneyFmt = (amount: number, currency: string) => string;

// A friendly opener so the statement reads as a message between two people, not
// a bank export. The style is user-selectable; default 'hello'.
export type GreetingStyle = 'hello' | 'salaam' | 'dear' | 'none';

export function greetingLine(style: GreetingStyle, name: string): string {
  const n = name.trim();
  if (!n) return '';
  switch (style) {
    case 'hello': return `Hello ${n},`;
    case 'salaam': return `Assalam-o-Alaikum, ${n}`;
    case 'dear': return `Dear ${n},`;
    case 'none': default: return '';
  }
}

// Human sentence for a signed net balance. Positive ⇒ they owe you.
export function netBalanceLabel(partyName: string, closing: number, currency: string, fmt: MoneyFmt = formatMoney): string {
  if (closing > 0.005) return `${partyName} owes you ${fmt(closing, currency)}`;
  if (closing < -0.005) return `You owe ${partyName} ${fmt(Math.abs(closing), currency)}`;
  return `Settled up with ${partyName}`;
}

// Roman-Urdu companion to netBalanceLabel, for the bilingual hero line on the
// PDF (the audience is Pakistan/Gulf and the doc is sent over WhatsApp).
export function netBalanceLabelUrdu(partyName: string, closing: number, currency: string, fmt: MoneyFmt = formatMoney): string {
  if (closing > 0.005) return `${partyName} aap ko ${fmt(closing, currency)} dena hai`;
  if (closing < -0.005) return `Aap ko ${partyName} ko ${fmt(Math.abs(closing), currency)} dena hai`;
  return `${partyName} ke saath hisaab barabar hai`;
}

// RECIPIENT-focused label. The statement is addressed to the account holder,
// so it must tell THEM whether they pay or receive. `closing` is the internal
// (sender-side) net where positive = "they owe you"; from the recipient's seat
// that means THEY must pay. Colour then follows the recipient: pay = out (red),
// receive = in (green).
export type PayReceiveMode = 'pay' | 'receive' | 'settled';
export interface PayReceiveText {
  mode: PayReceiveMode;
  english: string;
  urdu: string;
}
export function payOrReceiveLabel(
  closing: number,
  currency: string,
  senderName?: string,
  fmt: MoneyFmt = formatMoney,
): PayReceiveText {
  const money = fmt(Math.abs(closing), currency);
  const who = senderName?.trim();
  if (closing > 0.005) {
    // Recipient owes the sender ⇒ recipient must PAY.
    return {
      mode: 'pay',
      english: who ? `You need to pay ${who} ${money}` : `You need to pay ${money}`,
      urdu: who ? `Aap ko ${who} ko ${money} dena hai` : `Aap ko ${money} dena hai`,
    };
  }
  if (closing < -0.005) {
    // Sender owes the recipient ⇒ recipient will RECEIVE.
    return {
      mode: 'receive',
      english: who ? `You will receive ${money} from ${who}` : `You will receive ${money}`,
      urdu: who ? `Aap ko ${who} se ${money} milega` : `Aap ko ${money} milega`,
    };
  }
  // Fully settled deserves warmth, not bank-speak — this is the moment the
  // relationship's books close clean.
  return {
    mode: 'settled',
    english: '🎉 Congratulations — nothing pending, all settled!',
    urdu: 'Mubarak ho — hisaab bilkul barabar hai!',
  };
}

function signedAmount(delta: number, currency: string, fmt: MoneyFmt = formatMoney): string {
  const sign = delta < 0 ? '−' : '+'; // − vs +
  return `${sign}${fmt(Math.abs(delta), currency)}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'd MMM yyyy');
}

function lineText(line: StatementLine, currency: string, fmt: MoneyFmt = formatMoney): string {
  // Fold/summary lines: equal money given and paid back — say so instead of
  // printing a meaningless "+0.00".
  if (line.grossGiven || line.grossRepaid) {
    const gross = fmt(line.grossRepaid ?? line.grossGiven ?? 0, currency);
    return `• ${[shortDate(line.date), line.description].filter(Boolean).join(' · ')} · ${gross} paid & cleared ✓`;
  }
  // Recipient perspective: negate so a charge (they owe more) reads as −out and
  // a payment they made reads as +in, matching the PDF's Debit/Credit colours.
  const parts = [shortDate(line.date), line.description, signedAmount(-line.delta, currency, fmt)];
  return `• ${parts.filter(Boolean).join(' · ')}`; // • date · desc · +amt
}

export interface RenderStatementTextOptions {
  asOfLabel?: string; // pre-formatted date; defaults to formatting statement.asOf
  maxLinesPerSection?: number; // keep the message short; older lines fold to b/f
  greeting?: string; // pre-composed opener, e.g. "Hello Rashid,"
  fromName?: string; // signs the message off: "Thank you, {fromName}"
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
}

export function renderStatementText(statement: Statement, opts: RenderStatementTextOptions = {}): string {
  const { partyName, sections } = statement;
  const asOf = opts.asOfLabel ?? shortDate(statement.asOf);
  const maxLines = opts.maxLinesPerSection ?? 10;
  const money = moneyFormatter(!!opts.hideAmounts);

  const out: string[] = [];
  if (opts.greeting?.trim()) {
    out.push(opts.greeting.trim());
    out.push('');
  }
  out.push('*Statement of account*');
  out.push(partyName);
  if (asOf) out.push(`As of ${asOf}`);

  if (sections.length === 0) {
    out.push('');
    out.push('🎉 Congratulations — nothing pending, all settled!');
    out.push('Mubarak ho — hisaab bilkul barabar hai!');
  }

  for (const section of sections) {
    const pr = payOrReceiveLabel(section.closing, section.currency, opts.fromName, money);
    out.push(''); // blank line between blocks
    out.push(pr.english);

    const { opening, lines } = trimSection(section, maxLines);
    if (opening) {
      out.push(
        `• Balance brought forward · ${signedAmount(-opening.balance, section.currency, money)}` +
          ` (${opening.count} earlier ${opening.count === 1 ? 'entry' : 'entries'})`,
      );
    }
    for (const line of lines) out.push(lineText(line, section.currency, money));

    // Settled: the English celebration already opened the block — close with
    // the Urdu companion instead of repeating it.
    out.push(pr.mode === 'settled' ? pr.urdu : `Outstanding — ${pr.english}`);
    if (section.estimated) {
      out.push('(Some entries are summarised from loan balances.)');
    }
  }

  if (opts.fromName?.trim()) {
    out.push('');
    out.push('Thank you,');
    out.push(opts.fromName.trim());
  }

  out.push('');
  out.push('— via Hisaab');
  return out.join('\n');
}
