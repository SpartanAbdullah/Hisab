export const EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Rent',
  'Utilities',
  'Phone & Internet',
  'Healthcare',
  'Education',
  'Shopping',
  'Entertainment',
  'Remittance',
  'Family Support',
  'Loan Payment',
  'Savings',
  'Other',
] as const;

export const INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
  'Business',
  'Investment',
  'Gift',
  'Refund',
  'Other',
] as const;

export const CURRENCY_SYMBOLS: Record<string, string> = {
  AED: 'د.إ',
  PKR: '₨',
};

export const formatMoney = (amount: number, currency: string): string => {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol} ${formatted}`;
};
