// Native data-query parser — answers the "fetch my own data" questions people
// most ask finance assistants (per research: "where did my money go", "what's
// my balance", "am I over budget", "more than last month", "who owes me"),
// all from local stores, no LLM. Pure intent + entity extraction; the UI does
// the lookup and writes the answer.

export type QueryKind =
  | 'person-balance' // "Ali owes me how much?"
  | 'net-balance' // "how much am I owed?"
  | 'account-balance' // "what's my balance / how much do I have?"
  | 'category-spend' // "how much did I spend on food?"
  | 'top-spend' // "where did my money go / what did I spend most on?"
  | 'trend' // "am I spending more than last month?"
  | 'budget-status'; // "what's left in my budget / am I over budget on X?"

export interface ParsedQuery {
  kind: QueryKind;
  personName?: string;
  category?: string; // category-spend, budget-status, trend (optional)
}

function clean(s: string): string {
  return (s ?? '').trim().replace(/[?.!,]+$/g, '').replace(/\s+/g, ' ').trim();
}
function tidy(s: string): string {
  return clean(s).replace(/\b(please|now|exactly|in total|total|this month|last month|today)\b\s*$/i, '').trim();
}

const NET_RES = [
  /^how much (am i owed|is owed to me)\s*$/i,
  /^who owes me( money)?\s*$/i,
  /^how much (money )?(do people|does everyone) owe me\s*$/i,
  /^total (i'?m )?owed\s*$/i,
  /^am i owed (any )?money\s*$/i,
];

const ACCOUNT_RES = [
  /^how much (money )?(do i have|have i got|i have)\s*$/i,
  /^what'?s my (account )?balance\s*$/i,
  /^my (account )?balance\s*$/i,
  /^how much (is |do i have )?in my (.+ )?account\s*$/i,
  /^how much can i spend\s*$/i,
];

const TOP_SPEND_RES = [
  /^where(?:'?s| is| did| does)? my money go(?:ing)?\s*$/i,
  /^what did i spend (?:the )?most on\s*$/i,
  /^what'?s my biggest (?:expense|spend|spending|category)\s*$/i,
  /^break ?down my spending.*$/i,
  /^where am i spending(?: the)? most\s*$/i,
];

const TREND_RES = [
  /^am i spending more (?:than|vs) last month\s*$/i,
  /^how does this month compare(?: to last)?\s*$/i,
  /^is my (.+?) (?:spending )?going up\s*$/i,
  /^(?:am i )?(?:spending )?(?:more|less) than last month\s*$/i,
];

const BUDGET_RES = [
  /^what'?s left (?:in|on) my budget\s*$/i,
  /^how am i doing on my budget\s*$/i,
  /^am i over budget(?: on (.+?))?\s*$/i,
  /^how much (?:can i (?:still )?spend|(?:is )?left)(?: on| for) (.+?)\s*$/i,
  /^budget (?:for|on) (.+?)\s*$/i,
];

const PERSON_RES = [
  /^how much does (.+?) owe(?: me)?\s*$/i,
  /^how much do i owe (.+?)\s*$/i,
  /^how much (?:does )?(.+?) owes? me(?: how much)?\s*$/i,
  /^(.+?) owes me(?: how much)?\s*$/i,
  /^i owe (.+?)(?: how much)?\s*$/i,
  /^(?:what'?s my |my )?balance with (.+?)\s*$/i,
  /^(.+?) (?:ka|ki) hisaab\s*$/i,
];

const CATEGORY_RES = [
  /^how much (?:did i |have i )?(?:spend|spent) on (.+?)(?: this month| last month| today)?\s*$/i,
  /^how much (?:on|for) (.+?)(?: this month| last month| today)?\s*$/i,
  /^my (.+?) (?:spend|spending|expenses?)\s*$/i,
];

function firstMatch(res: RegExp[], s: string): RegExpExecArray | null {
  for (const re of res) {
    const m = re.exec(s);
    if (m) return m;
  }
  return null;
}

export function parseDataQuery(text: string): ParsedQuery | null {
  const s = clean(text ?? '');
  if (!s) return null;

  // Budget first — "am I over budget on food" also reads like a category query.
  const budget = firstMatch(BUDGET_RES, s);
  if (budget) {
    const cat = budget[1] ? tidy(budget[1]) : undefined;
    return { kind: 'budget-status', category: cat || undefined };
  }

  if (firstMatch(TOP_SPEND_RES, s)) return { kind: 'top-spend' };

  const trend = firstMatch(TREND_RES, s);
  if (trend) return { kind: 'trend', category: trend[1] ? tidy(trend[1]) : undefined };

  if (firstMatch(NET_RES, s)) return { kind: 'net-balance' };
  if (firstMatch(ACCOUNT_RES, s)) return { kind: 'account-balance' };

  const person = firstMatch(PERSON_RES, s);
  if (person && person[1]) {
    const name = tidy(person[1]);
    if (name && !/^\d+$/.test(name)) return { kind: 'person-balance', personName: name };
  }

  const category = firstMatch(CATEGORY_RES, s);
  if (category && category[1]) {
    const c = tidy(category[1]);
    if (c) return { kind: 'category-spend', category: c };
  }

  return null;
}
