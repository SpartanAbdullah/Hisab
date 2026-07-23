// Payment-received receipt text.
//
// The mirror image of a reminder: when money ARRIVES, the receiver sends a warm
// acknowledgement back to the PAYER ("Received AED 500 from you on 3 Jul —
// remaining AED 1,500. Shukriya!"). Addressed to the payer ("from you"),
// bilingual (English + Roman-Urdu), strictly single-currency, no-custody framing
// (it records that money was received; it never moves money or implies interest).
//
// Delivered over WhatsApp text so it reaches non-app-users, same as the reminder
// and statement. Pure + unit-tested; the UI (SendStatementModal) composes it.

import { format } from 'date-fns';
import { moneyFormatter } from './maskMoney';

export interface ReceiptTextInput {
  receivedAmount: number;
  currency: string;
  // Remaining balance AFTER this payment. null ⇒ not derivable here (e.g. a
  // linked settlement accept) — the receipt then omits the remaining clause.
  remaining: number | null;
  date: string; // ISO timestamp of when it was received
  fromName?: string; // the receiver's own name — signs the receipt off
  greeting?: string; // optional opener, e.g. "Hello Rashid,"
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
}

export interface ReceiptText {
  english: string; // the "Received …" line
  urdu: string; // Roman-Urdu companion
  message: string; // full assembled WhatsApp body
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd MMM yyyy');
}

export function buildReceiptText(input: ReceiptTextInput): ReceiptText {
  const { receivedAmount, currency, remaining, date, fromName, greeting } = input;
  const money = moneyFormatter(!!input.hideAmounts);
  const amountStr = money(receivedAmount, currency);
  const dateStr = shortDate(date);
  const on = dateStr ? ` on ${dateStr}` : '';

  let english: string;
  let urdu: string;
  if (remaining === null || remaining === undefined) {
    english = `Received ${amountStr} from you${on}.`;
    urdu = `${amountStr} mil gaye. Shukriya!`;
  } else if (remaining <= 0.005) {
    english = `Received ${amountStr} from you${on} — now fully settled.`;
    urdu = `${amountStr} mil gaye — ab hisaab barabar. Shukriya!`;
  } else {
    const remStr = money(remaining, currency);
    english = `Received ${amountStr} from you${on} — remaining ${remStr}.`;
    urdu = `${amountStr} mil gaye — baqi ${remStr}. Shukriya!`;
  }

  const out: string[] = [];
  if (greeting?.trim()) {
    out.push(greeting.trim());
    out.push('');
  }
  out.push('*Payment received*');
  out.push(english);
  out.push(urdu);
  if (fromName?.trim()) {
    out.push('');
    out.push('Thank you,');
    out.push(fromName.trim());
  }
  out.push('');
  out.push('— via Hisaab');

  return { english, urdu, message: out.join('\n') };
}
