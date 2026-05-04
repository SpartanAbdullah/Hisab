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
  AED: 'AED',
  PKR: '\u20A8',
  SAR: 'SAR',
  QAR: 'QAR',
  OMR: 'OMR',
  KWD: 'KWD',
  BHD: 'BHD',
};

export const formatMoney = (amount: number, currency: string): string => {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol} ${formatted}`;
};

export const formatSignedMoney = (amount: number, currency: string): string => (
  amount < 0 ? `-${formatMoney(amount, currency)}` : formatMoney(amount, currency)
);
