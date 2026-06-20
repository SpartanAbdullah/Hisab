import { describe, expect, it } from 'vitest';
import {
  routeAssistantInput,
  findKnowledge,
  looksLikeQuestion,
  KNOWLEDGE_BASE,
} from './hisaabAssistant';

const full = { mode: 'full_tracker' as const, defaultCurrency: 'AED' };
const splits = { mode: 'splits_only' as const, defaultCurrency: 'AED' };

describe('looksLikeQuestion', () => {
  it('detects question words and trailing question marks', () => {
    expect(looksLikeQuestion('how do splits work')).toBe(true);
    expect(looksLikeQuestion('which mode should I use?')).toBe(true);
    expect(looksLikeQuestion('is my data safe')).toBe(true);
    expect(looksLikeQuestion('karak 3 aed')).toBe(false);
    expect(looksLikeQuestion('add 45 for groceries')).toBe(false);
  });
});

describe('findKnowledge', () => {
  const cases: Array<[string, string]> = [
    ['what can hisaab do', 'what-is-hisaab'],
    ['which mode should I use', 'modes-difference'],
    ['how do I settle up with ali', 'settle-up'],
    ['how do subscriptions work', 'subscriptions'],
    ['is my data safe', 'privacy'],
    ['how do I add an expense', 'add-expense'],
    ['my balance is wrong', 'troubleshoot-balance'],
    ['how do I switch mode', 'switch-mode'],
  ];
  it.each(cases)('matches %s → %s', (input, id) => {
    expect(findKnowledge(input)?.id).toBe(id);
  });
  it('returns null when nothing matches', () => {
    expect(findKnowledge('asdfgh qwerty')).toBeNull();
    expect(findKnowledge('karak 3')).toBeNull();
  });
  it('every topic has a non-empty answer and keywords', () => {
    for (const t of KNOWLEDGE_BASE) {
      expect(t.answer.length).toBeGreaterThan(20);
      expect(t.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe('routeAssistantInput — commands', () => {
  it('routes a clear expense to a command in full tracker', () => {
    const r = routeAssistantInput('add 3 aed for karak', full);
    expect(r.kind).toBe('command');
    expect(r.command?.amount).toBe(3);
    expect(r.command?.category).toBe('Food & Dining');
  });
  it('routes a terse expense to a command', () => {
    expect(routeAssistantInput('karak 3', full).kind).toBe('command');
  });
  it('routes a command the same way in splits-only (UI decides how to handle it)', () => {
    const r = routeAssistantInput('45 groceries', splits);
    expect(r.kind).toBe('command');
  });
});

describe('routeAssistantInput — group / split', () => {
  it('routes a split statement to the group flow', () => {
    const r = routeAssistantInput('split 200 for dinner with flat', full);
    expect(r.kind).toBe('group');
    expect(r.group?.amount).toBe(200);
    expect(r.group?.description).toBe('Dinner');
  });
  it('routes "divide ... between us" to group', () => {
    expect(routeAssistantInput('divide 600 between us', splits).kind).toBe('group');
  });
  it('does NOT treat an ordinary "with team" note as a split', () => {
    expect(routeAssistantInput('spent 45 on lunch with team', full).kind).toBe('command');
  });
  it('routes split intent the same way in splits-only mode', () => {
    expect(routeAssistantInput('split 300 groceries with flat', splits).kind).toBe('group');
  });
});

describe('routeAssistantInput — data queries', () => {
  it('routes "Ghulam owes me how much?" to a person-balance query', () => {
    const r = routeAssistantInput('Ghulam owes me how much?', full);
    expect(r.kind).toBe('query');
    expect(r.query).toEqual({ kind: 'person-balance', personName: 'Ghulam' });
  });
  it('routes "how much did I spend on food" to a category query', () => {
    expect(routeAssistantInput('how much did I spend on food', full).kind).toBe('query');
  });
  it('routes "how much am I owed" to a net-balance query', () => {
    expect(routeAssistantInput('how much am I owed', full).kind).toBe('query');
  });
  it('still routes a how-to question to knowledge, not a query', () => {
    expect(routeAssistantInput('how do splits work?', full).kind).toBe('knowledge');
  });
});

describe('routeAssistantInput — knowledge', () => {
  it('answers a how-to question from the knowledge base', () => {
    const r = routeAssistantInput('how do splits work?', full);
    expect(r.kind).toBe('knowledge');
    expect(r.knowledge?.answer).toBeTruthy();
  });
  it('answers "which mode should I use?"', () => {
    expect(routeAssistantInput('which mode should I use?', splits).kind).toBe('knowledge');
  });
  it('treats a settle statement as guidance', () => {
    expect(routeAssistantInput('settle up with ali', full).kind).toBe('knowledge');
  });
});

describe('routeAssistantInput — open-ended & fallback', () => {
  it('flags a what-if reasoning question as open-ended (future LLM tier)', () => {
    const r = routeAssistantInput('can I afford AED 1200 on dinner this week?', full);
    expect(r.kind).toBe('unknown');
    expect(r.openEnded).toBe(true);
    expect(r.text).toMatch(/Plus/);
  });
  it('does NOT mistake a reasoning question for an add command', () => {
    // "1200 dinner" parses as money, but the question framing must win.
    const r = routeAssistantInput('should I spend 1200 on dinner?', full);
    expect(r.kind).not.toBe('command');
  });
  it('gives a guided fallback for gibberish', () => {
    const r = routeAssistantInput('asdfgh qwerty', full);
    expect(r.kind).toBe('unknown');
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
  it('gives a guided fallback for empty input', () => {
    expect(routeAssistantInput('   ', full).kind).toBe('unknown');
  });
  it('offers mode-appropriate suggestions', () => {
    expect(routeAssistantInput('', splits).suggestions[0]).toMatch(/split/i);
    expect(routeAssistantInput('', full).suggestions.some((s) => /add|owe|money/i.test(s))).toBe(true);
  });
});
