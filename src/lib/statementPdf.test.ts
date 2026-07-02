import { describe, it, expect } from 'vitest';
import { renderStatementInnerHtml } from './statementPdf';
import { buildStatement } from './statementOfAccount';
import type { Loan, Transaction } from '../db';

function loan(p: Partial<Loan> & Pick<Loan, 'id' | 'type' | 'totalAmount' | 'remainingAmount' | 'currency'>): Loan {
  return { personName: 'Ahmed', personId: 'p1', status: 'active', notes: '', createdAt: '2026-01-01T00:00:00.000Z', ...p } as Loan;
}
function txn(p: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount' | 'currency' | 'relatedLoanId' | 'createdAt'>): Transaction {
  return { sourceAccountId: null, destinationAccountId: null, relatedPerson: 'Ahmed', personId: 'p1', relatedGoalId: null, conversionRate: null, category: '', notes: '', ...p } as Transaction;
}

// Positive AED (they owe you) + negative PKR (you owe them), with a repayment
// so both Debit and Credit columns are exercised.
function sampleHtml(): string {
  const loans = [
    loan({ id: 'L1', type: 'given', totalAmount: 10500, remainingAmount: 8000, currency: 'AED' }),
    loan({ id: 'L2', type: 'taken', totalAmount: 30000, remainingAmount: 30000, currency: 'PKR', createdAt: '2026-06-25T00:00:00.000Z' }),
  ];
  const transactions = [
    txn({ id: 'a1', type: 'loan_given', amount: 10000, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-21T00:00:00.000Z', notes: 'Visa application' }),
    txn({ id: 'a2', type: 'repayment', amount: 2500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-28T00:00:00.000Z', notes: 'Part payment' }),
    txn({ id: 'a3', type: 'loan_given', amount: 500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-07-01T00:00:00.000Z', notes: 'Medical' }),
    txn({ id: 'b1', type: 'loan_taken', amount: 30000, currency: 'PKR', relatedLoanId: 'L2', createdAt: '2026-06-25T00:00:00.000Z', notes: 'Rent deposit' }),
  ];
  const statement = buildStatement({ partyName: 'Maryam Corpuz', loans, transactions, asOf: '2026-07-02T14:30:00.000Z', scope: 'contact' });
  return renderStatementInnerHtml(statement, { phone: '+971 52 449 5778', fromName: 'Muhammad Abdullah' });
}

describe('renderStatementInnerHtml', () => {
  const html = sampleHtml();

  it('carries the trust scaffolding (letterhead, statement no, period, parties, E&OE)', () => {
    expect(html).toContain('Statement of account');
    expect(html).toMatch(/No\. HIS-\d{6}-[0-9A-Z]{4}/); // statement number
    expect(html).toContain('Period 21 Jun 2026 – 02 Jul 2026');
    expect(html).toContain('Maryam Corpuz');
    expect(html).toContain('Prepared by');
    expect(html).toContain('E&amp;OE');
    expect(html).toContain('Page 1 of 1');
  });

  it('leads with a hero net number per currency, bilingual', () => {
    expect(html).toContain('Net outstanding · AED');
    expect(html).toContain('Net outstanding · PKR');
    expect(html).toContain('Maryam Corpuz owes you'); // English
    expect(html).toContain('dena hai'); // Roman-Urdu companion
  });

  it('uses the canonical Debit/Credit/Balance ledger with currency stated once', () => {
    expect(html).toContain('>Debit<');
    expect(html).toContain('>Credit<');
    expect(html).toContain('>Balance<');
    expect(html).toContain('All amounts in AED');
    expect(html).toContain('All amounts in PKR');
    expect(html).toContain('Opening balance');
  });

  it('color-codes direction with the CVD-safe palette and a redundant sign', () => {
    expect(html).toContain('#047857'); // owed-to-you teal
    expect(html).toContain('#C2410C'); // you-owe vermillion
    expect(html).toContain('+8,000.00'); // positive AED closing, signed
    expect(html).toContain('−30,000.00'); // negative PKR closing, signed
  });

  it('uses contrast-safe muted text (#6B6B66), not the failing #9A9A93', () => {
    expect(html).toContain('#6B6B66');
    expect(html).not.toContain('#9A9A93');
  });

  it('reconciles: the AED closing equals opening + debits − credits', () => {
    // 0 + (10,000 + 500) − 2,500 = 8,000.00 shown as the AED net.
    expect(html).toContain('8,000.00');
  });
});
