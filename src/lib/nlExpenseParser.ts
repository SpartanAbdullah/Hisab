// Natural-language expense parser — the engine behind Hisaab AI's
// "add 3 aed for karak" quick-add.
//
// CONTRACT (the "guided, not lost" rule): this function NEVER throws and NEVER
// returns a dead end. It returns a draft plus, when it can't safely proceed, a
// short `clarify` question that tells a first-time user exactly what to type
// next. Money is never posted from here — the UI shows the draft as a confirm
// chip and only writes on an explicit tap (same trust rule as the recurring
// runner). So a misread is a one-tap edit, never a silent wrong transaction.

import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  CURRENCY_SYMBOLS,
} from './constants';

export type Direction = 'expense' | 'income';
export type Confidence = 'high' | 'medium' | 'low';

export interface ParsedExpense {
  /** Parsed amount, or null if none found. May be 0/≤0, which forces canPost=false. */
  amount: number | null;
  /** ISO currency code (e.g. "AED"), or null if none detected (UI fills default). */
  currency: string | null;
  /** True when `currency` came from the caller's default, not the text. */
  currencyAssumed: boolean;
  direction: Direction;
  /** A known category, or null when nothing matched (UI defaults / asks). */
  category: string | null;
  /** Merchant / description, Title Cased. Falls back to the category name. */
  label: string;
  confidence: Confidence;
  /** True when the text had several numbers and we had to guess which is the amount. */
  ambiguousAmount: boolean;
  /** True when we extracted enough (a positive amount) to show a confirm chip. */
  canPost: boolean;
  /** A guiding follow-up question when we can't proceed; null when canPost. */
  clarify: string | null;
  rawText: string;
}

export interface ParseOptions {
  /** Currency to assume when the text doesn't name one. */
  defaultCurrency?: string;
}

// ── Currency synonyms → ISO code. Only codes the app supports, plus the
// common spoken/written forms used in the target market. ──
const CURRENCY_WORDS: Record<string, string> = {
  aed: 'AED', dirham: 'AED', dirhams: 'AED', dhs: 'AED', dh: 'AED',
  pkr: 'PKR', rs: 'PKR', rupee: 'PKR', rupees: 'PKR', rupya: 'PKR',
  php: 'PHP', peso: 'PHP', pesos: 'PHP',
  sar: 'SAR', riyal: 'SAR', riyals: 'SAR',
  qar: 'QAR', omr: 'OMR', kwd: 'KWD', dinar: 'KWD', bhd: 'BHD',
  usd: 'USD', dollar: 'USD', dollars: 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
};

// Keyword → category. Order matters only across categories (first hit wins);
// within the market these rarely collide. Merchant names double as labels.
const EXPENSE_KEYWORDS: Record<string, string> = {
  // Subscriptions (check before generic words)
  netflix: 'Subscriptions', spotify: 'Subscriptions', osn: 'Subscriptions',
  prime: 'Subscriptions', youtube: 'Subscriptions', icloud: 'Subscriptions',
  subscription: 'Subscriptions', anghami: 'Subscriptions', shahid: 'Subscriptions',
  gym: 'Subscriptions',
  // Food & Dining
  karak: 'Food & Dining', chai: 'Food & Dining', tea: 'Food & Dining',
  coffee: 'Food & Dining', latte: 'Food & Dining', cappuccino: 'Food & Dining',
  lunch: 'Food & Dining', dinner: 'Food & Dining', breakfast: 'Food & Dining',
  restaurant: 'Food & Dining', food: 'Food & Dining', burger: 'Food & Dining',
  pizza: 'Food & Dining', shawarma: 'Food & Dining', biryani: 'Food & Dining',
  talabat: 'Food & Dining', zomato: 'Food & Dining', swiggy: 'Food & Dining',
  cafe: 'Food & Dining', snack: 'Food & Dining', meal: 'Food & Dining',
  // Groceries
  grocery: 'Groceries', groceries: 'Groceries', carrefour: 'Groceries',
  lulu: 'Groceries', supermarket: 'Groceries', vegetables: 'Groceries',
  milk: 'Groceries', bread: 'Groceries', kirana: 'Groceries',
  // Transport
  uber: 'Transport', careem: 'Transport', taxi: 'Transport', cab: 'Transport',
  fuel: 'Transport', petrol: 'Transport', diesel: 'Transport', metro: 'Transport',
  bus: 'Transport', parking: 'Transport', salik: 'Transport', ride: 'Transport',
  // Rent
  rent: 'Rent',
  // Utilities
  dewa: 'Utilities', sewa: 'Utilities', electricity: 'Utilities',
  water: 'Utilities', utility: 'Utilities', utilities: 'Utilities',
  // Phone & Internet
  etisalat: 'Phone & Internet', du: 'Phone & Internet', mobile: 'Phone & Internet',
  recharge: 'Phone & Internet', internet: 'Phone & Internet', wifi: 'Phone & Internet',
  data: 'Phone & Internet', sim: 'Phone & Internet',
  // Healthcare
  pharmacy: 'Healthcare', medicine: 'Healthcare', doctor: 'Healthcare',
  hospital: 'Healthcare', clinic: 'Healthcare', panadol: 'Healthcare',
  // Education
  school: 'Education', tuition: 'Education', fees: 'Education',
  course: 'Education', books: 'Education', udemy: 'Education',
  // Shopping
  amazon: 'Shopping', noon: 'Shopping', clothes: 'Shopping', shoes: 'Shopping',
  shopping: 'Shopping', mall: 'Shopping', namshi: 'Shopping', electronics: 'Shopping',
  // Entertainment
  cinema: 'Entertainment', movie: 'Entertainment', vox: 'Entertainment',
  concert: 'Entertainment', game: 'Entertainment',
  // Family Support
  family: 'Family Support', ammi: 'Family Support', abbu: 'Family Support',
  parents: 'Family Support',
  // Loan Payment
  loan: 'Loan Payment', emi: 'Loan Payment', installment: 'Loan Payment',
  qist: 'Loan Payment',
  // Savings
  savings: 'Savings', deposit: 'Savings',
};

const INCOME_KEYWORDS: Record<string, string> = {
  salary: 'Salary', tankhwa: 'Salary', payroll: 'Salary', wage: 'Salary',
  freelance: 'Freelance', gig: 'Freelance', client: 'Freelance',
  business: 'Business', revenue: 'Business',
  dividend: 'Investment', profit: 'Investment', interest: 'Investment',
  gift: 'Gift', eidi: 'Gift', tip: 'Gift',
  refund: 'Refund', refunded: 'Refund', cashback: 'Refund', returned: 'Refund',
};

const INCOME_TRIGGERS = new Set([
  'got', 'received', 'receive', 'earned', 'credited', 'income', 'salary',
  'refund', 'refunded', 'cashback', 'bonus', 'freelance', 'tankhwa', 'eidi',
]);

// Filler removed from the label. Currency words and numbers are stripped
// separately. Kept tight on purpose so descriptive words ("with", "team")
// survive.
const LABEL_STOPWORDS = new Set([
  'add', 'for', 'on', 'spent', 'spend', 'paid', 'pay', 'bought', 'buy',
  'got', 'get', 'received', 'receive', 'a', 'an', 'the', 'please', 'pls',
  'i', 'my', 'me', 'to', 'of', 'from', 'just', 'today', 'yesterday',
  // roman-urdu fillers
  'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'par', 'liye', 'wala', 'wali',
]);

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Parse a numeric token like "1,200", "12.50", "2k", "3" into a number.
function parseNumberToken(tok: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(k)?$/i.exec(tok);
  if (!m) return null;
  const intPart = m[1].replace(/,/g, '');
  let value = parseFloat(intPart + (m[2] ?? ''));
  if (m[3]) value *= 1000; // "2k" → 2000
  return Number.isFinite(value) ? value : null;
}

const KNOWN_CURRENCY_CODES = new Set(Object.keys(CURRENCY_SYMBOLS));

/**
 * Parse free text into an expense/income draft. Pure and total — never throws.
 */
export function parseExpenseInput(text: string, opts: ParseOptions = {}): ParsedExpense {
  const rawText = (text ?? '').trim();

  // Normalise: lowercase, turn currency symbols into words, expand magnitude
  // suffixes (2k, 5 lakh, 1cr — common in the target market), then split
  // digit/letter runs so "3aed", "aed3", "rs500", "₨500" all tokenise cleanly.
  let s = ` ${rawText.toLowerCase()} `;
  s = s
    .replace(/₨/g, ' pkr ')
    .replace(/₱/g, ' php ')
    .replace(/\$/g, ' usd ')
    .replace(/€/g, ' eur ')
    .replace(/£/g, ' gbp ');
  const scale = (mult: number) => (_m: string, n: string) =>
    ` ${Math.round(parseFloat(n.replace(/,/g, '')) * mult)} `;
  s = s
    .replace(/(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/gi, scale(1_000))
    .replace(/(\d+(?:\.\d+)?)\s*(?:lakh|lac)\b/gi, scale(100_000))
    .replace(/(\d+(?:\.\d+)?)\s*(?:crore|cr)\b/gi, scale(10_000_000))
    .replace(/(\d+(?:\.\d+)?)\s*(?:m|million)\b/gi, scale(1_000_000));
  s = s.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');

  // Tokenise; strip surrounding punctuation but keep , and . inside numbers.
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w.,₨₱$€£]+|[^\w.,]+$/g, ''))
    .filter(Boolean);

  // ── Numbers + adjacency to currency words ──
  interface NumHit { value: number; index: number; currency: string | null; }
  const numbers: NumHit[] = [];
  let firstCurrencyAnywhere: string | null = null;

  tokens.forEach((tok, i) => {
    if (CURRENCY_WORDS[tok] && firstCurrencyAnywhere === null) {
      firstCurrencyAnywhere = CURRENCY_WORDS[tok];
    }
    const value = parseNumberToken(tok);
    if (value !== null) {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const adj =
        (prev && CURRENCY_WORDS[prev]) || (next && CURRENCY_WORDS[next]) || null;
      numbers.push({ value, index: i, currency: adj });
    }
  });

  // Choose the amount: a currency-adjacent number wins; else the largest.
  let amount: number | null = null;
  let currency: string | null = null;
  let ambiguousAmount = false;
  if (numbers.length > 0) {
    const currencied = numbers.find((n) => n.currency);
    if (currencied) {
      amount = currencied.value;
      currency = currencied.currency;
    } else {
      const max = numbers.reduce((a, b) => (b.value > a.value ? b : a));
      amount = max.value;
    }
    ambiguousAmount = numbers.length > 1;
  }
  if (!currency) currency = firstCurrencyAnywhere;

  // Drop unsupported currencies (e.g. USD/EUR/GBP we detected but can't store)
  // back to "assume default" rather than emitting something the UI can't use.
  let currencyAssumed = false;
  if (currency && !KNOWN_CURRENCY_CODES.has(currency)) currency = null;
  if (!currency && opts.defaultCurrency) {
    currency = opts.defaultCurrency;
    currencyAssumed = true;
  }

  // ── Direction ──
  let direction: Direction = 'expense';
  for (const tok of tokens) {
    if (INCOME_TRIGGERS.has(tok) || INCOME_KEYWORDS[tok]) {
      direction = 'income';
      break;
    }
  }

  // ── Category ──
  const keywordMap = direction === 'income' ? INCOME_KEYWORDS : EXPENSE_KEYWORDS;
  let category: string | null = null;
  for (const tok of tokens) {
    if (keywordMap[tok]) {
      category = keywordMap[tok];
      break;
    }
  }
  // Guard: only emit categories that actually exist in the constants.
  const validCats: readonly string[] =
    direction === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  if (category && !validCats.includes(category)) category = null;

  // ── Label (merchant/description) ──
  const numberTokens = new Set(numbers.map((n) => tokens[n.index]));
  const labelWords = tokens.filter(
    (tok) =>
      !numberTokens.has(tok) &&
      !CURRENCY_WORDS[tok] &&
      !LABEL_STOPWORDS.has(tok) &&
      !INCOME_TRIGGERS.has(tok),
  );
  let label = titleCase(labelWords.join(' '));
  if (!label) label = category ?? (direction === 'income' ? 'Income' : 'Expense');

  // ── Posting readiness + clarify ──
  const hasPositiveAmount = amount !== null && amount > 0;
  const canPost = hasPositiveAmount;

  let clarify: string | null = null;
  if (!canPost) {
    const subject =
      labelWords.length > 0 ? label.toLowerCase() : category?.toLowerCase() ?? '';
    if (amount !== null && amount <= 0) {
      clarify = "Amount needs to be more than zero — try 'karak for 3 aed'.";
    } else if (subject) {
      clarify = `How much was ${subject}? Try '${subject} for 20 aed'.`;
    } else {
      clarify = "Tell me what you spent — like 'add 12 aed for lunch' or 'karak 3'.";
    }
  }

  // ── Confidence ──
  let confidence: Confidence;
  if (!hasPositiveAmount) confidence = 'low';
  else if (category && currency && !currencyAssumed && !ambiguousAmount) confidence = 'high';
  else confidence = 'medium';

  return {
    amount, // raw parsed value (may be ≤0); canPost gates whether it can be saved
    currency,
    currencyAssumed,
    direction,
    category,
    label,
    confidence,
    ambiguousAmount,
    canPost,
    clarify,
    rawText,
  };
}
