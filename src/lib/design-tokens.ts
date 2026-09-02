// ============================================
// HISAAB CURRENCY METADATA
//
// This file used to double as a broader "design token system" (color
// scales, shadow/spacing/radius ladders). That JS layer had zero real
// consumers — every one of its color/gradient/shadow/spacing/radius
// exports was measured at 0 import sites across src/, and it actively
// contradicted the live Sukoon palette shipped in src/index.css (e.g. it
// documented expense as red #ef4444 while the real UI uses coral
// #D9614A). It was deleted in full rather than patched — see
// docs/audit-2026-09/09-ui-quality.md §1.1 for the measurement.
//
// The actual design system — the tokens that are real because Tailwind
// generates utilities from them — lives in the `@theme` block at the top
// of src/index.css (colors, fonts, animation names) plus the
// `@layer components` classes further down (buttons, inputs, cards,
// modal anatomy, etc). docs/design-system.md is the documented source of
// truth for that system: color roles, spacing scale, radii, shadows,
// type scale, and how to add a token.
//
// What's left here is currency metadata — flags/symbols/names keyed by
// ISO code — which IS imported everywhere currency needs to render
// (AccountCard, QuickEntry, AccountsPage, and 17 other call sites).
// ============================================

export const currencyMeta: Record<string, { flag: string; symbol: string; name: string }> = {
  AED: { flag: '\u{1F1E6}\u{1F1EA}', symbol: 'AED', name: 'UAE Dirham' },
  PKR: { flag: '\u{1F1F5}\u{1F1F0}', symbol: '₨', name: 'Pakistani Rupee' },
  PHP: { flag: '\u{1F1F5}\u{1F1ED}', symbol: '₱', name: 'Philippine Peso' },
  SAR: { flag: '\u{1F1F8}\u{1F1E6}', symbol: 'SAR', name: 'Saudi Riyal' },
  QAR: { flag: '\u{1F1F6}\u{1F1E6}', symbol: 'QAR', name: 'Qatari Riyal' },
  OMR: { flag: '\u{1F1F4}\u{1F1F2}', symbol: 'OMR', name: 'Omani Rial' },
  KWD: { flag: '\u{1F1F0}\u{1F1FC}', symbol: 'KWD', name: 'Kuwaiti Dinar' },
  BHD: { flag: '\u{1F1E7}\u{1F1ED}', symbol: 'BHD', name: 'Bahraini Dinar' },
};
