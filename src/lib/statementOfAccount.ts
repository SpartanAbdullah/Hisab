// Statement of Account (SOA) builder.
//
// Turns a contact's (or a single loan's) loans + repayment ledger into a
// signed, chronological statement that can be rendered to text (for a WhatsApp
// deep link) or to a one-page PDF (see statementPdf.ts).
//
// Sign convention throughout: POSITIVE means "the counterparty owes you"
// (a receivable), NEGATIVE means "you owe the counterparty" (a payable). This
// matches ContactDetailSheet.relationshipBalances, so a statement's closing
// balance lines up with what the app shows on screen.
//
// Two data modes are handled:
//   - Full tracker: every disbursement + repayment is a Transaction row, so we
//     build a real running-balance ledger from getByLoan-style data.
//   - Ledger-only ('splits_only'): repayments live only on Loan.remainingAmount
//     with NO Transaction rows. There is no itemised history to show, so each
//     still-open loan becomes a single "outstanding" line and the section is
//     flagged `estimated` so the renderer can add an honest note.

import type { Currency, Loan, Transaction } from '../db';

export type StatementScope = 'contact' | 'loan';

export interface StatementLine {
  date: string; // ISO timestamp of the underlying event
  description: string; // neutral, human-readable label
  note?: string; // optional free-text from the transaction
  delta: number; // signed change (+ increases what they owe you)
  balance: number; // signed running balance AFTER this line
  estimated?: boolean; // synthetic line (ledger-only mode, no real ledger row)
}

export interface StatementSection {
  currency: Currency;
  lines: StatementLine[];
  closing: number; // signed net position in this currency
  estimated: boolean; // true when any line is synthetic
}

export interface Statement {
  partyName: string;
  asOf: string; // ISO timestamp the statement was generated for
  scope: StatementScope;
  sections: StatementSection[];
  hasActivity: boolean; // false ⇒ nothing to show (fully settled / no history)
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const isNonZero = (n: number): boolean => Math.abs(n) > 0.005;

// One event's signed effect on "what they owe you", given the direction of the
// loan the transaction belongs to. Returns null for transaction types that
// don't belong on a loan ledger.
function signedDelta(txn: Transaction, loanType: Loan['type']): number | null {
  switch (txn.type) {
    case 'loan_given':
      return txn.amount; // you lent — they owe you more
    case 'loan_taken':
      return -txn.amount; // you borrowed — you owe them more
    case 'repayment':
      // A repayment moves the balance back toward zero. On a loan you GAVE,
      // money coming back reduces what they owe you (−). On a loan you TOOK,
      // paying it back reduces what you owe them (+).
      return loanType === 'given' ? -txn.amount : txn.amount;
    default:
      return null;
  }
}

function describe(txn: Transaction, loanType: Loan['type']): string {
  switch (txn.type) {
    case 'loan_given':
      return 'Loan given';
    case 'loan_taken':
      return 'Loan taken';
    case 'repayment':
      return loanType === 'given' ? 'Repayment received' : 'Repayment paid';
    default:
      return 'Adjustment';
  }
}

export interface BuildStatementInput {
  partyName: string;
  // Loans already scoped to the contact (or a single loan). Deleted loans
  // should be filtered out by the caller.
  loans: Loan[];
  // Transactions to draw the ledger from. May be the full store list — only
  // rows whose relatedLoanId matches one of `loans` are used.
  transactions: Transaction[];
  asOf: string; // ISO; callers pass new Date().toISOString()
  scope: StatementScope;
}

export function buildStatement(input: BuildStatementInput): Statement {
  const { partyName, loans, transactions, asOf, scope } = input;

  const loanById = new Map<string, Loan>();
  for (const loan of loans) loanById.set(loan.id, loan);

  // Bucket loans by currency so PKR is never quietly summed into AED.
  const currencies: Currency[] = [];
  const loansByCurrency = new Map<Currency, Loan[]>();
  for (const loan of loans) {
    const bucket = loansByCurrency.get(loan.currency);
    if (bucket) {
      bucket.push(loan);
    } else {
      loansByCurrency.set(loan.currency, [loan]);
      currencies.push(loan.currency);
    }
  }
  currencies.sort((a, b) => a.localeCompare(b));

  const sections: StatementSection[] = [];

  for (const currency of currencies) {
    const currencyLoans = loansByCurrency.get(currency) ?? [];
    const loanIds = new Set(currencyLoans.map((l) => l.id));

    const events = transactions
      .filter((t) => t.relatedLoanId && loanIds.has(t.relatedLoanId) && !t.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const lines: StatementLine[] = [];
    let running = 0;

    if (events.length > 0) {
      for (const txn of events) {
        const loan = txn.relatedLoanId ? loanById.get(txn.relatedLoanId) : undefined;
        if (!loan) continue;
        const delta = signedDelta(txn, loan.type);
        if (delta === null) continue;
        running = round2(running + delta);
        lines.push({
          date: txn.createdAt,
          description: describe(txn, loan.type),
          note: txn.notes?.trim() || undefined,
          delta: round2(delta),
          balance: running,
        });
      }
    } else {
      // Ledger-only mode: no transaction rows exist. Represent each still-open
      // loan as a single outstanding line so there is at least a balance to
      // show; the section is flagged estimated so the renderer can say so.
      const openLoans = currencyLoans
        .filter((l) => isNonZero(l.remainingAmount))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const loan of openLoans) {
        const delta = loan.type === 'given' ? loan.remainingAmount : -loan.remainingAmount;
        running = round2(running + delta);
        lines.push({
          date: loan.createdAt,
          description: loan.type === 'given' ? 'Outstanding (you lent)' : 'Outstanding (you borrowed)',
          note: loan.notes?.trim() || undefined,
          delta: round2(delta),
          balance: running,
          estimated: true,
        });
      }
    }

    if (lines.length === 0) continue; // nothing to show for this currency

    sections.push({
      currency,
      lines,
      closing: round2(running),
      estimated: lines.some((l) => l.estimated),
    });
  }

  return {
    partyName,
    asOf,
    scope,
    sections,
    hasActivity: sections.length > 0,
  };
}

// Keep a statement to one page by folding older lines into a single
// "brought forward" opening balance. Returns the opening line (or null when no
// trimming was needed) plus the visible tail.
export interface TrimmedSection {
  opening: { balance: number; count: number } | null;
  lines: StatementLine[];
}

export function trimSection(section: StatementSection, maxLines: number): TrimmedSection {
  if (section.lines.length <= maxLines) {
    return { opening: null, lines: section.lines };
  }
  const visibleCount = Math.max(1, maxLines - 1); // reserve a row for the b/f line
  const cutIndex = section.lines.length - visibleCount;
  const openingBalance = section.lines[cutIndex - 1]?.balance ?? 0;
  return {
    opening: { balance: round2(openingBalance), count: cutIndex },
    lines: section.lines.slice(cutIndex),
  };
}
