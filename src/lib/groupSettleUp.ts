// Group settle-up — the Statement of Account, for splits.
//
// Turns the group's pairwise debts (from groupDebts.computePairwiseDebts) into
// (a) a recipient-focused card for one member ("You pay Ali AED 120 · Bilal pays
// you AED 30") and (b) a full "who pays whom" plan. Recipient-focused and
// bilingual, delivered over WhatsApp text (reaches non-app members). Pure +
// tested; the PDF renderer and modal compose these.

import { formatMoney } from './constants';
import type { GroupDebt } from './groupDebts';

export interface MemberSettleUp {
  net: number; // signed: + this member receives overall, − they pay overall
  owes: GroupDebt[]; // debts where this member is the payer (`from`)
  owed: GroupDebt[]; // debts where this member is the payee (`to`)
}

// The transfers that involve `memberId`, plus their net position in the group.
export function memberSettleUp(debts: ReadonlyArray<GroupDebt>, memberId: string): MemberSettleUp {
  const owes = debts.filter((d) => d.from === memberId);
  const owed = debts.filter((d) => d.to === memberId);
  const owesTotal = owes.reduce((s, d) => s + d.amount, 0);
  const owedTotal = owed.reduce((s, d) => s + d.amount, 0);
  return { net: Math.round((owedTotal - owesTotal) * 100) / 100, owes, owed };
}

export interface MemberCardOptions {
  groupName: string;
  currency: string;
  greeting?: string;
  fromName?: string;
}

// Recipient-focused WhatsApp body for one member: their net + the exact
// transfers they should make/receive.
export function buildMemberCardText(su: MemberSettleUp, opts: MemberCardOptions): string {
  const { groupName, currency, greeting, fromName } = opts;
  const out: string[] = [];
  if (greeting?.trim()) {
    out.push(greeting.trim());
    out.push('');
  }
  out.push(`*Settle up — ${groupName}*`);

  if (su.net > 0.005) out.push(`You'll receive ${formatMoney(su.net, currency)} overall.`);
  else if (su.net < -0.005) out.push(`You need to pay ${formatMoney(Math.abs(su.net), currency)} overall.`);
  else out.push(`You're all settled up in ${groupName}.`);

  if (su.owes.length > 0 || su.owed.length > 0) {
    out.push('');
    for (const d of su.owes) out.push(`• You pay ${d.toName} ${formatMoney(d.amount, currency)}`);
    for (const d of su.owed) out.push(`• ${d.fromName} pays you ${formatMoney(d.amount, currency)}`);
  }

  if (fromName?.trim()) {
    out.push('');
    out.push('Thank you,');
    out.push(fromName.trim());
  }
  out.push('');
  out.push('— via Hisaab');
  return out.join('\n');
}

// The whole group's plan as text (every X-pays-Y transfer).
export function buildFullPlanText(debts: ReadonlyArray<GroupDebt>, groupName: string, currency: string): string {
  const out: string[] = [];
  out.push(`*Settle up — ${groupName}*`);
  if (debts.length === 0) {
    out.push('Everyone is settled up — nothing outstanding.');
  } else {
    out.push('');
    for (const d of debts) out.push(`• ${d.fromName} pays ${d.toName} ${formatMoney(d.amount, currency)}`);
  }
  out.push('');
  out.push('— via Hisaab');
  return out.join('\n');
}
