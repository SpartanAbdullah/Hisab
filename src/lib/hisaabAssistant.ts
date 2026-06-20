// The native Hisaab assistant — no LLM, no cloud, no training on user data.
//
// It does two jobs entirely on-device:
//   1. routes a typed message into a COMMAND (an expense to add, via the NL
//      parser) or a KNOWLEDGE answer (curated guidance about how Hisaab works);
//   2. answers "how/what/which/why" questions from a finite, curated knowledge
//      base — the "personal assistant native to Hisaab" without privacy cost.
//
// Genuinely open-ended reasoning ("if I cancel 2 subs, when do I hit my goal?")
// is flagged `openEnded` so the UI can offer the paid LLM tier later. We never
// answer those with a guess.

import { parseExpenseInput, type ParsedExpense } from './nlExpenseParser';
import { isSplitIntent, parseGroupExpenseInput, type ParsedGroupExpense } from './nlGroupExpenseParser';
import { parseDataQuery, type ParsedQuery } from './nlQuery';

export type AppMode = 'full_tracker' | 'splits_only';

export interface KnowledgeTopic {
  id: string;
  title: string;
  keywords: string[]; // multiword phrases — kept specific to avoid matching commands
  answer: string;
}

// Curated, accurate to how Hisaab works. Warm, plain, occasional roman-Urdu.
export const KNOWLEDGE_BASE: KnowledgeTopic[] = [
  {
    id: 'what-is-hisaab',
    title: 'What Hisaab can do',
    keywords: ['what can you do', 'what can hisaab', 'what is hisaab', 'who are you', 'what do you do', 'how can you help'],
    answer:
      "I'm your money assistant inside Hisaab. Tell me an expense in plain words (\"karak 3 aed\") and I'll log it after you confirm. I can also explain how anything in the app works — splits, settling up, subscriptions, the two modes — just ask.",
  },
  {
    id: 'modes-difference',
    title: 'Full Tracker vs Splits Only',
    keywords: ['which mode', 'difference between mode', 'full tracker vs', 'splits vs', 'two modes', 'what mode', 'modes mean'],
    answer:
      "Hisaab has two modes. Full Tracker manages your own money — accounts, balances, income, budgets, subscriptions and analytics. Splits Only is lightweight: just split bills with people and track who owes whom, no personal accounts. Use Splits Only if you only want to share costs with friends or flatmates; use Full Tracker if you want to manage your own finances too.",
  },
  {
    id: 'when-splits-only',
    title: 'When to use Splits Only',
    keywords: ['should i use splits', 'when splits only', 'just split', 'only split bills', 'split with flatmates', 'split with friends'],
    answer:
      "Splits Only is perfect when you just want to share costs — a flat, a trip, dinner with friends — without tracking your own bank balance. You add a shared expense, Hisaab works out everyone's share, and you settle up later. No accounts to set up. Bas, hisaab-kitaab saaf.",
  },
  {
    id: 'when-full-tracker',
    title: 'When to use Full Tracker',
    keywords: ['should i use full', 'when full tracker', 'track my money', 'track my expenses', 'manage my money', 'see where my money'],
    answer:
      "Full Tracker is the one to pick if you want to see your whole picture — every account, where your money goes each month, budgets, subscriptions and goals — on top of splitting with people. If you're asking \"where did my salary go?\", that's Full Tracker.",
  },
  {
    id: 'switch-mode',
    title: 'Switching modes',
    keywords: ['switch mode', 'change mode', 'turn on full', 'enable full tracker', 'go to splits', 'how to change mode'],
    answer:
      "You can switch anytime in Settings → App mode. Your data is kept — switching to Full Tracker just unlocks accounts, budgets and analytics; switching to Splits Only hides them and keeps things simple.",
  },
  {
    id: 'add-expense',
    title: 'Adding an expense',
    keywords: ['how to add expense', 'how do i add', 'log an expense', 'record an expense', 'add a transaction', 'how to log'],
    answer:
      "Two ways: tap the ＋ button for the step-by-step form, or just tell me here — \"add 45 aed for groceries\" — and I'll prep it. I always show a card to confirm (and let you fix the amount, account or category) before anything is saved.",
  },
  {
    id: 'settle-up',
    title: 'Settling up',
    keywords: ['how to settle', 'settle up', 'who owes', 'pay back', 'clear balance', 'record a repayment', 'mark as paid'],
    answer:
      "Open a group (or the person on the Loans page) to see who owes whom, then record a settlement when money changes hands. Hisaab updates both sides so the balance clears. In Splits Only this is the heart of the app — no accounts needed.",
  },
  {
    id: 'subscriptions',
    title: 'Subscriptions',
    keywords: ['how do subscriptions', 'subscription tracker', 'recurring expense', 'track netflix', 'cancel subscription', 'forgotten subscription'],
    answer:
      "Add a recurring expense and tag it \"Subscriptions\" — the Subscriptions page then totals your monthly and yearly burn, warns you before renewals, and flags ones you seem to have forgotten. Bhooli hui subscriptions yahin pakad lega.",
  },
  {
    id: 'groups',
    title: 'Groups & splitting',
    keywords: ['create a group', 'how do groups', 'split with', 'add members', 'invite to group', 'how to split', 'how do splits', 'splits work', 'how splitting', 'how does split'],
    answer:
      "Create a group, add the people in it, then add a shared expense and choose how to split it (equally, by share, or custom). Everyone's balance updates automatically. You can invite people with a join code so they see the same group.",
  },
  {
    id: 'accounts',
    title: 'Accounts',
    keywords: ['add an account', 'how do accounts', 'set up account', 'add a bank', 'add wallet', 'add cash'],
    answer:
      "In Full Tracker, accounts are your wallets — cash, bank, credit card. Add them from the Accounts screen, and every expense or income draws from one so your balances stay accurate. (Splits Only doesn't use accounts.)",
  },
  {
    id: 'privacy',
    title: 'Your data & privacy',
    keywords: ['is my data safe', 'privacy', 'do you sell', 'are there ads', 'is it secure', 'where is my data', 'data stays'],
    answer:
      "Your data is yours. Hisaab has no ads and never sells your information. Everyday actions like adding an expense run on your device, and I don't learn from or share your transactions. That privacy is the point — not a feature we'd trade away.",
  },
  {
    id: 'troubleshoot-balance',
    title: 'A balance looks wrong',
    keywords: ['balance is wrong', 'balance incorrect', 'balance not matching', 'fix my balance', 'wrong amount', 'something looks off'],
    answer:
      "Usually it's a missing or duplicated entry. Open the account or person, scan recent transactions, and edit or delete the odd one — balances recalculate instantly. If a transfer's currencies differ, check the conversion rate you entered. If it still looks off, tell me what you expected vs what you see.",
  },
  {
    id: 'loans',
    title: 'Lending & borrowing',
    keywords: ['how do loans', 'i lent', 'i borrowed', 'gave money to', 'someone owes me', 'track a loan'],
    answer:
      "Use the Loans page (or tell me \"lent Ali 500\") to record money you've lent or borrowed. Hisaab tracks the remaining balance and lets you log repayments over time — handy for family support or a friend who'll pay you back later.",
  },
  {
    id: 'budgets',
    title: 'Budgets',
    keywords: ['how do budgets', 'set a budget', 'spending limit', 'budget for', 'stop overspending'],
    answer:
      "In Full Tracker you can set a monthly budget per category. Hisaab shows how much of it you've used so you can ease off before you overspend — gently, no nagging.",
  },
];

export type RouteKind = 'command' | 'group' | 'query' | 'knowledge' | 'unknown';

export interface AssistantReply {
  kind: RouteKind;
  command?: ParsedExpense; // when kind === 'command' (personal expense/income)
  group?: ParsedGroupExpense; // when kind === 'group' (split/shared expense)
  query?: ParsedQuery; // when kind === 'query' (answer from local data)
  knowledge?: KnowledgeTopic; // when kind === 'knowledge'
  text?: string; // fallback text for 'unknown'
  suggestions: string[]; // tappable example prompts
  openEnded?: boolean; // a reasoning question we won't guess at (future LLM tier)
}

const QUESTION_RE =
  /\?\s*$|\b(how|what|which|why|when|who|can i|should i|do i|is my|are there|explain|guide me|tell me|difference)\b/i;

export function looksLikeQuestion(input: string): boolean {
  return QUESTION_RE.test(input.trim());
}

// Score a topic by how many (and how specific) of its keyword phrases appear.
export function findKnowledge(input: string): KnowledgeTopic | null {
  const text = ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let best: KnowledgeTopic | null = null;
  let bestScore = 0;
  for (const topic of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (text.includes(` ${kw} `) || text.includes(`${kw} `) || text.includes(` ${kw}`)) {
        score += kw.split(' ').length; // longer phrase = stronger signal
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }
  return bestScore > 0 ? best : null;
}

function suggestionsFor(mode: AppMode): string[] {
  return mode === 'splits_only'
    ? ['How do I split a bill?', 'How do I settle up?', 'Should I use Full Tracker?']
    : ['add 200 for groceries', 'Where did my money go?', 'How much does Ali owe me?'];
}

const REASONING_HINT_RE = /\b(afford|forecast|predict|how much (can|should)|if i|when will|plan|enough)\b/i;

export interface RouteContext {
  mode: AppMode;
  defaultCurrency?: string;
}

/**
 * Decide what a typed message is. Questions resolve to knowledge (or an
 * open-ended fallback); statements resolve to a command when the parser sees a
 * money intent, otherwise to knowledge, otherwise to a guided fallback.
 */
export function routeAssistantInput(rawInput: string, ctx: RouteContext): AssistantReply {
  const input = (rawInput ?? '').trim();
  const suggestions = suggestionsFor(ctx.mode);
  if (!input) {
    return { kind: 'unknown', suggestions, text: "Tell me an expense, or ask me how something in Hisaab works." };
  }

  // Easy "fetch my own data" questions answered natively, no LLM — "Ali owes me
  // how much?", "how much did I spend on food?", "how much am I owed?".
  const dataQuery = parseDataQuery(input);
  if (dataQuery) return { kind: 'query', query: dataQuery, suggestions };

  const isQuestion = looksLikeQuestion(input);
  const knowledge = findKnowledge(input);
  const parsed = parseExpenseInput(input, { defaultCurrency: ctx.defaultCurrency });
  // A money "command" signal: the parser pulled out an amount or a category.
  const commandSignal = parsed.amount !== null || parsed.category !== null;

  if (isQuestion) {
    if (knowledge) return { kind: 'knowledge', knowledge, suggestions };
    const openEnded = commandSignal || REASONING_HINT_RE.test(input);
    return {
      kind: 'unknown',
      suggestions,
      openEnded,
      text: openEnded
        ? "That's a deeper, what-if style question. I'll be able to reason through those with Hisaab AI Plus soon — for now I can log expenses and explain how the app works."
        : "I don't have an answer for that yet. I can log expenses and explain how Hisaab works — try one of these:",
    };
  }

  // Statement. A split/shared expense ("split 200 with flat") routes to the
  // group flow BEFORE the personal path, so it isn't mistaken for a personal
  // expense. Works in both modes (group expenses exist in splits-only too).
  if (isSplitIntent(input)) {
    return { kind: 'group', group: parseGroupExpenseInput(input, { defaultCurrency: ctx.defaultCurrency }), suggestions };
  }
  if (commandSignal) return { kind: 'command', command: parsed, suggestions };
  if (knowledge) return { kind: 'knowledge', knowledge, suggestions };
  return {
    kind: 'unknown',
    suggestions,
    text: "I didn't quite catch that. Tell me an expense like \"karak 3 aed\", or ask how something works.",
  };
}
