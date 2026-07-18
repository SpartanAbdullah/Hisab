// Send one settlement request per allocation — the linked-loan counterpart of
// executeAllocatedRepayments. Nothing settles until the counterparty confirms
// each request, so the batch is naturally safe: a mid-batch failure just means
// fewer requests went out ("Sent N of M") and re-sending covers the rest.
// Dependencies are injected so the loop is unit-testable without Supabase.

import type { Currency } from '../db';
import type { SettlementSides } from './settlementSides';

export interface SettlementExecItem {
  loanId: string;
  amount: number;
}

export interface SettlementRequestInput {
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note?: string;
  requesterAccountId?: string | null;
}

export interface SettlementExecDeps {
  currency: Currency;
  note?: string;
  requesterAccountId?: string | null; // same opt-in account stamped on every request
  sidesByLoan: Record<string, SettlementSides>;
  createRequest: (input: SettlementRequestInput) => Promise<unknown>;
}

export interface SettlementExecResult {
  total: number;
  done: number;
  sent: SettlementExecItem[]; // committed prefix, in order
  failed?: { item: SettlementExecItem; error: unknown };
  totalRequested: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function executeAllocatedSettlements(
  items: SettlementExecItem[],
  deps: SettlementExecDeps,
): Promise<SettlementExecResult> {
  const sent: SettlementExecItem[] = [];
  const sum = () => round2(sent.reduce((a, x) => a + x.amount, 0));

  for (const item of items) {
    const sides = deps.sidesByLoan[item.loanId];
    if (!sides) {
      return {
        total: items.length,
        done: sent.length,
        sent,
        failed: { item, error: new Error('No linked pair found for this loan') },
        totalRequested: sum(),
      };
    }
    try {
      await deps.createRequest({
        loanPairId: sides.loanPairId,
        requesterLoanId: sides.requesterLoanId,
        responderLoanId: sides.responderLoanId,
        toUserId: sides.toUserId,
        amount: item.amount,
        currency: deps.currency,
        note: deps.note,
        requesterAccountId: deps.requesterAccountId ?? null,
      });
      sent.push(item);
    } catch (error) {
      return { total: items.length, done: sent.length, sent, failed: { item, error }, totalRequested: sum() };
    }
  }
  return { total: items.length, done: sent.length, sent, totalRequested: sum() };
}
