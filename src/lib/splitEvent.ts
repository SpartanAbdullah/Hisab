// Ad-hoc split: "I paid for lunch, split it with these people" — with no group
// involved. One user action fans out into several ordinary rows, because the
// primitives Hisaab already has (an expense + a per-person loan) express this
// correctly and a throwaway SplitGroup would not.
//
// THE MONEY MODEL — the part that matters:
//
//   I paid (tracker mode), total T, my share m, each person i owes s_i:
//     · one `expense` of m           → only MY share counts as spending
//     · one `loan_given` of s_i each  → each becomes a receivable
//   The account is debited m + Σs_i = T, i.e. exactly what really left it,
//   while flexBudget/Analytics (which count `type === 'expense'` only) see m.
//   Recording the full T as an expense would double-count money that is coming
//   back; recording only m would leave the account overstated. Splitwise can
//   dodge this because it never touches your accounts. We can't.
//
//   They paid: a single `taken` loan for my share. NO transaction, NO account
//   leg — no money moved in my wallet. It moves when I repay, and the existing
//   repayment path carries it. Same treatment `loan_taken` already gets
//   app-wide; a borrowed amount is not spending, the repayment is.
//
//   splits_only mode: no accounts exist, so both directions are loans only.
//
// ATOMICITY: Supabase has no cross-row transaction here and each
// processTransaction opens its own mutation scope, so this is N+1 independent
// commits — the same committed-prefix model as executeAllocatedRepayments. On
// failure we keep what committed and report "2 of 4" honestly rather than
// pretending to roll back money that already moved.
//
// ORDER: receivables commit BEFORE the payer's own-share expense. Who owes you
// what is the part you cannot reconstruct from memory next week; your own share
// is on the receipt in your pocket. So a mid-batch failure loses the
// recoverable row, never the obligations.

import { v4 as uuid } from 'uuid';
import { buildInternalNote } from './internalNotes';
import type { Currency } from '../db';

export type SplitDirection = 'i_paid' | 'they_paid';

export interface SplitParticipant {
  personId: string;
  personName: string;
  amount: number;
}

// Structurally matches the store's TransactionInput members we use, so the real
// processTransaction can be passed straight in.
export type SplitTransactionInput =
  | {
      type: 'expense';
      amount: number;
      sourceAccountId: string;
      category?: string;
      notes?: string;
    }
  | {
      type: 'loan_given';
      amount: number;
      sourceAccountId: string;
      personName: string;
      personId?: string | null;
      notes?: string;
    };

export interface CreateSplitLoanInput {
  personName: string;
  personId?: string | null;
  type: 'given' | 'taken';
  totalAmount: number;
  currency: Currency;
  notes?: string;
}

export interface SplitEventDeps {
  processTransaction: (input: SplitTransactionInput) => Promise<unknown>;
  createLoan: (input: CreateSplitLoanInput) => Promise<unknown>;
}

export interface SplitEventInput {
  /** Shared by every row of this split; generated for you when omitted. */
  splitEventId?: string;
  /** Human label for the whole event, e.g. "Friday lunch". */
  label: string;
  category?: string;
  notes?: string;
  mode: 'tracker' | 'splits_only';
  direction: SplitDirection;
  currency: Currency;
  /** The current user's own share of the bill. */
  myShare: number;
  /** i_paid: what each other participant owes me. Ignored for they_paid. */
  others: SplitParticipant[];
  /** they_paid: who fronted the money. Required for that direction. */
  payer?: { personId: string; personName: string };
  /** tracker + i_paid: the account the bill was actually paid from. */
  accountId?: string;
}

export type SplitStepKind = 'receivable' | 'my_share' | 'payable';

export interface SplitStep {
  kind: SplitStepKind;
  /** Person name for receivable/payable, the label for my_share. */
  label: string;
  amount: number;
}

export interface SplitEventResult {
  splitEventId: string;
  total: number;
  done: number;
  committed: SplitStep[];
  failed?: { step: SplitStep; error: unknown };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The total the payer's account should move by — used for the confirmation
 * copy and by tests to assert the account was debited the real bill, not a
 * share of it.
 */
export function splitAccountImpact(input: Pick<SplitEventInput, 'direction' | 'mode' | 'myShare' | 'others'>): number {
  if (input.direction !== 'i_paid' || input.mode !== 'tracker') return 0;
  return round2(input.myShare + input.others.reduce((sum, o) => sum + o.amount, 0));
}

export async function executeSplitEvent(
  input: SplitEventInput,
  deps: SplitEventDeps,
): Promise<SplitEventResult> {
  const splitEventId = input.splitEventId ?? uuid();
  const label = input.label.trim();
  const visibleNote = input.notes?.trim() ?? '';
  const partyCount = input.direction === 'i_paid' ? input.others.length + 1 : 2;

  // Only transaction rows carry the meta blob. Loan.notes is rendered raw in a
  // dozen places (LoansPage, LoanDetailPage, statements, the repayment
  // allocators) and would leak `[[HISAAB_META:…]]` straight into the UI.
  const txNotes = buildInternalNote(visibleNote || label, {
    splitEventId,
    splitLabel: label,
    splitPartyCount: String(partyCount),
  });
  const loanNote = visibleNote ? `${label} — ${visibleNote}` : label;

  const committed: SplitStep[] = [];
  const fail = (step: SplitStep, error: unknown, total: number): SplitEventResult => ({
    splitEventId,
    total,
    done: committed.length,
    committed,
    failed: { step, error },
  });

  if (input.direction === 'they_paid') {
    const payer = input.payer;
    if (!payer) throw new Error('A payer is required when someone else paid');
    const step: SplitStep = { kind: 'payable', label: payer.personName, amount: round2(input.myShare) };
    try {
      await deps.createLoan({
        personName: payer.personName,
        personId: payer.personId,
        type: 'taken',
        totalAmount: step.amount,
        currency: input.currency,
        notes: loanNote,
      });
      committed.push(step);
    } catch (error) {
      return fail(step, error, 1);
    }
    return { splitEventId, total: 1, done: 1, committed };
  }

  const isTracker = input.mode === 'tracker';
  if (isTracker && !input.accountId) {
    throw new Error('An account is required to record a split you paid for');
  }

  // Receivables first — see ORDER above. Only the payer's own share is charged
  // to the account in tracker mode; splits_only has no accounts at all.
  const steps: SplitStep[] = input.others.map((o) => ({
    kind: 'receivable' as const,
    label: o.personName,
    amount: round2(o.amount),
  }));
  const myShare = round2(input.myShare);
  const chargesMyShare = isTracker && myShare > 0;
  const total = steps.length + (chargesMyShare ? 1 : 0);

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const person = input.others[i];
    try {
      if (isTracker) {
        await deps.processTransaction({
          type: 'loan_given',
          amount: step.amount,
          sourceAccountId: input.accountId!,
          personName: person.personName,
          personId: person.personId,
          notes: txNotes,
        });
      } else {
        await deps.createLoan({
          personName: person.personName,
          personId: person.personId,
          type: 'given',
          totalAmount: step.amount,
          currency: input.currency,
          notes: loanNote,
        });
      }
      committed.push(step);
    } catch (error) {
      return fail(step, error, total);
    }
  }

  if (chargesMyShare) {
    const step: SplitStep = { kind: 'my_share', label, amount: myShare };
    try {
      await deps.processTransaction({
        type: 'expense',
        amount: myShare,
        sourceAccountId: input.accountId!,
        category: input.category,
        notes: txNotes,
      });
      committed.push(step);
    } catch (error) {
      return fail(step, error, total);
    }
  }

  return { splitEventId, total, done: committed.length, committed };
}
