// Icon inference for recurring templates / subscriptions. Labels are typed by
// the user ("Netflix", "Gym", "Salary"), so we infer a glyph by name, falling
// back to the category. Emoji only — the app must work fully offline
// (Capacitor), so no remote brand images; emoji render from the OS font and
// match the existing group-emoji visual language. Pure + tested.

export interface BrandIcon {
  emoji: string;
  matched: 'brand' | 'category' | 'none';
}

// Ordered substring matches — first hit wins, so more specific names go
// before generic ones. Curated for the app's UAE / Pakistan audience.
const BRAND_MATCHES: Array<[string[], string]> = [
  [['netflix'], '🎬'],
  [['spotify', 'anghami'], '🎧'],
  [['youtube'], '▶️'],
  [['amazon', 'prime'], '📦'],
  [['disney'], '🏰'],
  [['apple', 'icloud', 'itunes'], '🍎'],
  [['google'], '🔍'],
  [['microsoft', 'office', '365'], '🪟'],
  [['adobe'], '🎨'],
  [['chatgpt', 'openai', 'claude', 'anthropic'], '🤖'],
  [['playstation', 'xbox', 'nintendo', 'steam', 'game pass'], '🎮'],
  [['starzplay', 'shahid', 'osn', 'tv'], '📺'],
  [['careem', 'uber'], '🚗'],
  [['du ', 'etisalat', 'e&'], '📡'],
  [['jazz', 'zong', 'ufone', 'telenor', 'mobile'], '📶'],
  [['ptcl', 'internet', 'wifi', 'broadband', 'fiber'], '🌐'],
  [['gym', 'fitness', 'club'], '🏋️'],
  [['rent', 'kiraya'], '🏠'],
  [['salary', 'payroll', 'tankhwah'], '💰'],
  [['electric', 'dewa', 'sewa', 'kahraba', 'k-electric', 'lesco', 'wapda', 'bijli'], '⚡'],
  [['water', 'pani'], '💧'],
  [['gas', 'sui'], '🔥'],
  [['school', 'tuition', 'college', 'university', 'fees'], '🎓'],
  [['insurance', 'takaful'], '🛡️'],
  [['maid', 'cleaner', 'driver'], '🧹'],
];

// Category fallback — covers EXPENSE_CATEGORIES + INCOME_CATEGORIES from
// constants.ts. Keep keys lowercase.
const CATEGORY_EMOJI: Record<string, string> = {
  'food & dining': '🍽️',
  groceries: '🛒',
  transport: '🚗',
  rent: '🏠',
  utilities: '💡',
  'phone & internet': '📶',
  healthcare: '🩺',
  education: '🎓',
  shopping: '🛍️',
  entertainment: '🎬',
  subscriptions: '🔁',
  remittance: '✈️',
  'family support': '👨‍👩‍👧',
  'loan payment': '🤝',
  savings: '🐖',
  salary: '💰',
  freelance: '💻',
  business: '🏢',
  investment: '📈',
  gift: '🎁',
  refund: '↩️',
  other: '💳',
};

/**
 * Resolve an emoji for a subscription / recurring entry. Brand substring
 * match on the label first, then the category map. `matched: 'none'` tells
 * the caller to render its own fallback (first-letter avatar).
 */
export function brandIconFor(label: string, category?: string): BrandIcon {
  const name = (label || category || '').trim().toLowerCase();
  if (name) {
    for (const [needles, emoji] of BRAND_MATCHES) {
      if (needles.some((n) => name.includes(n))) return { emoji, matched: 'brand' };
    }
  }
  const cat = (category ?? '').trim().toLowerCase();
  const catEmoji = CATEGORY_EMOJI[cat];
  if (catEmoji) return { emoji: catEmoji, matched: 'category' };
  return { emoji: '', matched: 'none' };
}
