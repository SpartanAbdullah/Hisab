import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TransactionItem } from './TransactionItem';
import { buildInternalNote } from '../lib/internalNotes';
import type { Transaction } from '../db';

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    type: 'expense',
    amount: 400,
    currency: 'AED',
    sourceAccountId: 'acc',
    destinationAccountId: null,
    relatedPerson: null,
    relatedLoanId: null,
    relatedGoalId: null,
    conversionRate: null,
    category: 'Food',
    notes: '',
    createdAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
}

const SPLIT_NOTE = buildInternalNote('', {
  splitEventId: 'evt',
  splitLabel: 'Friday lunch',
  splitPartyCount: '3',
});

describe('TransactionItem — ad-hoc split rows', () => {
  it('titles a split row with the event label instead of its category', () => {
    const html = renderToStaticMarkup(<TransactionItem transaction={txn({ notes: SPLIT_NOTE })} />);
    expect(html).toContain('Friday lunch');
    expect(html).toContain('split 3 ways');
  });

  // The receivable rows are loan_given, whose normal label already names the
  // person ("You gave to Ali"). Once the split label replaces that title, the
  // name has to come back as a suffix or the row never says who owes it.
  it('still names the person on a receivable row whose title became the event label', () => {
    const html = renderToStaticMarkup(
      <TransactionItem
        transaction={txn({
          id: 't2',
          type: 'loan_given',
          relatedPerson: 'Ali',
          relatedLoanId: 'loan-1',
          notes: SPLIT_NOTE,
        })}
      />,
    );
    expect(html).toContain('Friday lunch');
    expect(html).toContain('Ali');
  });

  it('leaves an ordinary expense titled by its category', () => {
    const html = renderToStaticMarkup(<TransactionItem transaction={txn()} />);
    expect(html).toContain('Food');
    expect(html).not.toContain('split');
  });
});
