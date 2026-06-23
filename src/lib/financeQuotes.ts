// A small, curated set of SHORT money-wisdom quotes for the daily popup.
//
// Deliberately one-liners with attribution (the standard "quote of the day"
// pattern) — famous lines, timeless proverbs, and a couple of desi ones. We do
// NOT reproduce long passages from copyrighted books; short attributed quotes
// are the norm for this kind of feature.
export interface FinanceQuote {
  text: string;
  author: string;
}

export const FINANCE_QUOTES: FinanceQuote[] = [
  { text: "Do not save what is left after spending, but spend what is left after saving.", author: 'Warren Buffett' },
  { text: 'An investment in knowledge pays the best interest.', author: 'Benjamin Franklin' },
  { text: 'Beware of little expenses; a small leak will sink a great ship.', author: 'Benjamin Franklin' },
  { text: "It's not how much money you make, but how much you keep.", author: 'Robert Kiyosaki' },
  { text: 'The rich have money work for them; everyone else works for money.', author: 'Robert Kiyosaki' },
  { text: 'A budget is telling your money where to go instead of wondering where it went.', author: 'Dave Ramsey' },
  { text: "Money is a terrible master but an excellent servant.", author: 'P.T. Barnum' },
  { text: 'The habit of saving is itself an education.', author: 'T.T. Munger' },
  { text: 'Never spend your money before you have earned it.', author: 'Thomas Jefferson' },
  { text: 'Saving is the gap between your ego and your income.', author: 'Morgan Housel' },
  { text: "Wealth is what you don't see.", author: 'Morgan Housel' },
  { text: 'Spending to show people how much you have is the fastest way to have less.', author: 'Morgan Housel' },
  { text: 'A penny saved is a penny earned.', author: 'Benjamin Franklin' },
  { text: "Financial peace is learning to live on less than you make.", author: 'Dave Ramsey' },
  { text: "Every time you borrow money, you're robbing your future self.", author: 'Nathan W. Morris' },
  { text: 'If you would be wealthy, think of saving as well as getting.', author: 'Benjamin Franklin' },
  { text: "It's not your salary that makes you rich, it's your spending habits.", author: 'Charles A. Jaffe' },
  { text: "Buy what you don't need and soon you'll sell what you do.", author: 'Filipino proverb' },
  { text: 'Know what you own, and know why you own it.', author: 'Peter Lynch' },
  { text: 'Wealth consists not in having great possessions, but in having few wants.', author: 'Epictetus' },
  { text: 'He who buys what he does not need steals from himself.', author: 'Swedish proverb' },
  { text: 'Cut your coat according to your cloth.', author: 'Proverb' },
  { text: 'Chadar dekh kar paaon phailao — live within your means.', author: 'Urdu proverb' },
  { text: 'Bachat aadhi kamai hai — saving is half your earning.', author: 'Desi wisdom' },
  { text: 'Patience and small, steady savings build real wealth.', author: 'Timeless principle' },
  { text: 'The goal is not more money — it is living life on your own terms.', author: 'Chris Brogan' },
  { text: 'Too many spend money they haven’t earned, on things they don’t need.', author: 'Will Rogers' },
  { text: 'Pay yourself first — set aside savings before you spend a rupee.', author: 'Timeless principle' },
  { text: 'The art is not in making money, but in keeping it.', author: 'Proverb' },
  { text: 'Money looks better in the bank than on your feet.', author: 'Sophia Amoruso' },
  { text: 'Empty pockets never held anyone back — only empty heads and hearts can.', author: 'Norman Vincent Peale' },
  { text: 'Small daily habits with money compound into big outcomes over time.', author: 'Timeless principle' },
];

// Day ordinal (local) — so the quote changes once per calendar day and everyone
// on the same day sees the same one.
export function dayOrdinal(date: Date = new Date()): number {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86400000);
}

// Deterministically pick the quote for a given day, cycling through the list.
export function quoteForDay(date: Date = new Date(), quotes: FinanceQuote[] = FINANCE_QUOTES): FinanceQuote {
  const n = quotes.length;
  return quotes[((dayOrdinal(date) % n) + n) % n];
}
