// "Bacha kya hai?" — the one-number flex budget. Monarch brands this as
// Flex Budgeting: Income − Fixed = Flex, then watch what's left. Hisaab
// computes the fixed side from FIRST-CLASS objects Monarch has to guess at:
// kameti rounds, EMI instalments and recurring templates due this month.
// Income is ENTERED, never assumed — variable income is the norm in this
// market. Primary-currency scoped (a budget is one wallet's discipline).
//
// Double-count safety, by construction:
//  - recurring posts carry meta.recurringExpansion → excluded from "spent"
//  - EMI payments are 'repayment' rows, never 'expense' → not in "spent"
//  - kameti contributions are record-only (no transaction rows)
// So fixed + flexSpent never counts the same rupee twice.
import { parseInternalNote } from './internalNotes';
import { roundDate } from './committeeMath';
import { advanceDate } from '../stores/recurringStore';
import type { Committee, EmiSchedule, Loan, RecurringTransaction, Transaction } from '../db';

export interface FlexBudgetInputs {
  /** User-entered monthly income, in the primary currency. */
  income: number;
  currency: string;
  loans: Loan[];
  schedules: EmiSchedule[];
  committees: Committee[];
  templates: RecurringTransaction[];
  transactions: Transaction[];
  today: Date;
}

export interface FlexBudgetResult {
  income: number;
  /** Known commitments this month: EMIs (taken) + kameti rounds + recurring charges. */
  fixed: number;
  fixedParts: { emi: number; kameti: number; recurring: number };
  /** Income − fixed: what was ever available to spend freely. */
  flexTotal: number;
  /** Free spending so far this month (expenses minus recurring expansions). */
  flexSpent: number;
  remaining: number;
  state: 'green' | 'yellow' | 'red';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthPrefix(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function computeFlexBudget(inp: FlexBudgetInputs): FlexBudgetResult {
  const prefix = monthPrefix(inp.today);
  // Transaction rows carry UTC ISO timestamps; a string-prefix test would
  // misfile the 00:00-05:00 local window around month edges in this app's
  // Gulf/Pakistan markets. Compare epochs against LOCAL month boundaries
  // (same convention as computeBudgetUsages). Date-ONLY fields (dueDate,
  // nextDueDate) are local calendar strings and keep string comparison.
  const monthStartMs = new Date(inp.today.getFullYear(), inp.today.getMonth(), 1).getTime();
  const nextMonthStart = new Date(inp.today.getFullYear(), inp.today.getMonth() + 1, 1);
  const nextMonthStartMs = nextMonthStart.getTime();
  const nextMonthStartIso = `${monthIso(nextMonthStart)}-01`;
  const inMonth = (iso: string) => {
    const ts = new Date(iso).getTime();
    return Number.isFinite(ts) && ts >= monthStartMs && ts < nextMonthStartMs;
  };

  // EMIs owed on active taken loans: every unpaid instalment due by the END
  // of this month (arrears from earlier months are still owed money), counted
  // at its UNCOVERED remainder — a partial repayment covers instalments
  // oldest-first (mirroring emiCoverage.ts), so the covered slice must not be
  // counted again on top of its own repayment row. PLUS repayments actually
  // made this month on taken loans — a paid instalment flips to 'paid' and
  // its money is a 'repayment' row (never an expense), so without this term
  // it would vanish from the whole equation and overstate what's left.
  const loanById = new Map(inp.loans.map((l) => [l.id, l]));
  const schedulesByLoan = new Map<string, EmiSchedule[]>();
  for (const s of inp.schedules) {
    const list = schedulesByLoan.get(s.loanId);
    if (list) list.push(s);
    else schedulesByLoan.set(s.loanId, [s]);
  }
  let emi = 0;
  for (const [loanId, list] of schedulesByLoan) {
    const loan = loanById.get(loanId);
    if (!loan || loan.status !== 'active' || loan.type !== 'taken') continue;
    if (loan.currency !== inp.currency) continue;
    const covered = Math.max(0, round2(loan.totalAmount - loan.remainingAmount));
    const sorted = [...list].sort((a, b) => a.installmentNumber - b.installmentNumber);
    let cumulative = 0;
    for (const s of sorted) {
      const before = cumulative;
      cumulative = round2(cumulative + s.amount);
      if (s.status === 'paid') continue;
      if (s.dueDate >= nextMonthStartIso) continue;
      const uncovered = round2(cumulative - Math.max(covered, before));
      if (uncovered > 0.005) emi = round2(emi + Math.min(uncovered, s.amount));
    }
  }
  for (const txn of inp.transactions) {
    if (txn.type !== 'repayment' || txn.currency !== inp.currency) continue;
    if (!inMonth(txn.createdAt)) continue;
    // "Settle — no money moved" rows are forgiveness, not cash.
    if (parseInternalNote(txn.notes).meta.writeOff) continue;
    const loan = txn.relatedLoanId ? loanById.get(txn.relatedLoanId) : undefined;
    if (!loan || loan.type !== 'taken') continue;
    emi = round2(emi + txn.amount);
  }

  // Kameti rounds landing this month.
  let kameti = 0;
  for (const c of inp.committees) {
    if (c.status !== 'active' || c.currency !== inp.currency) continue;
    for (let r = 1; r <= c.totalRounds; r += 1) {
      const iso = monthIso(roundDate(c.startDate, c.cadence, r));
      if (iso > prefix) break;
      if (iso === prefix) kameti = round2(kameti + c.contributionAmount);
    }
  }

  // Recurring charges: the WHOLE month's commitment = expansions already
  // posted this month (their nextDueDate advanced past them, and flexSpent
  // deliberately excludes them) + every remaining occurrence. A weekly 400
  // is ~4 commitments, not one. Income templates don't reduce flex.
  let recurring = 0;
  for (const txn of inp.transactions) {
    if (txn.type !== 'expense' || txn.currency !== inp.currency) continue;
    if (!inMonth(txn.createdAt)) continue;
    if (parseInternalNote(txn.notes).meta.recurringExpansion) {
      recurring = round2(recurring + txn.amount);
    }
  }
  for (const tpl of inp.templates) {
    if (!tpl.active || tpl.type === 'income' || tpl.currency !== inp.currency) continue;
    let due = tpl.nextDueDate;
    let guard = 0;
    // A missed prompt leaves nextDueDate stuck in a PAST month — fast-forward
    // into this month so the month's own occurrences never vanish from fixed.
    // (The overdue occurrences themselves file into THEIR month when the user
    // confirms them: RecurringDuePrompt posts on the original due date.)
    while (due < `${prefix}-01` && guard < 500) {
      due = advanceDate(due, tpl.cadence);
      guard += 1;
    }
    guard = 0;
    while (due.startsWith(prefix) && guard < 62) {
      recurring = round2(recurring + tpl.amount);
      due = advanceDate(due, tpl.cadence);
      guard += 1;
    }
  }

  // Free spending: this month's expenses, minus recurring expansions (those
  // already live in "fixed") and group mirrors' share is kept — the money
  // really left this wallet.
  let flexSpent = 0;
  for (const txn of inp.transactions) {
    if (txn.type !== 'expense' || txn.currency !== inp.currency) continue;
    if (!inMonth(txn.createdAt)) continue;
    if (parseInternalNote(txn.notes).meta.recurringExpansion) continue;
    flexSpent = round2(flexSpent + txn.amount);
  }

  const fixed = round2(emi + kameti + recurring);
  const flexTotal = round2(inp.income - fixed);
  const remaining = round2(flexTotal - flexSpent);
  const state: FlexBudgetResult['state'] =
    remaining <= 0 ? 'red' : flexTotal > 0 && remaining < flexTotal * 0.2 ? 'yellow' : 'green';

  return {
    income: inp.income,
    fixed,
    fixedParts: { emi, kameti, recurring },
    flexTotal,
    flexSpent,
    remaining,
    state,
  };
}

function monthIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const FLEX_INCOME_KEY = 'hisaab_flex_income';
