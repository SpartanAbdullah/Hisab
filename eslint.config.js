import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// ────────────────────────────────────────────────────────────────────────────
// i18n guard — no bare user-facing string literals in UI code
// ----------------------------------------------------------------------------
// Audit 2026-09 (06-user-experience.md UX-31, 12-qa-review.md F-16/K-2, item
// H5): hardcoded English had saturated the most-visited screens and the
// highest-stakes sentences in an app whose default language is roman Urdu.
// Translations for many of them already existed, unused, in src/lib/i18n.ts —
// the mechanism was fine, it just wasn't applied. This rule is the ratchet
// that keeps it applied.
//
// Implemented with `no-restricted-syntax` selectors rather than
// eslint-plugin-react's `react/jsx-no-literals`: no new dependency, and the
// selectors can be tuned precisely to the four places copy actually leaks.
//
// WHAT IS FLAGGED (and only this):
//   1. Bare JSX text nodes            <p>Good to see you</p>
//   2. User-facing JSX attributes     placeholder= aria-label= alt= title=
//   3. String children in braces      <p>{'Good to see you'}</p>
//   4. Copy-carrying object props     toast.show({ title: 'Budget set' })
//                                     confirmDestructive({ confirmLabel: … })
//
// THE ALLOWLIST IS THE `[A-Za-z]{2,}` GUARD, not a list of exceptions.
// Everything without two consecutive Latin letters passes untouched, which
// covers the non-copy literals by construction:
//   • className / class, and every other attribute not named above
//   • emoji and pictographs      <span>🎉</span>
//   • symbols and separators     {' · '}  &mdash;  −  ✓
//   • numbers and units          <span>{n}%</span>  "0"  "44px"
//   • single letters             <span>U</span>
// A genuine non-copy literal that still trips it (a brand name, a code format
// like "HSB-XXXXXX") gets either an i18n key with identical ur/en values, or a
// one-line `// eslint-disable-next-line no-restricted-syntax` WITH a comment
// saying why. Do not widen the selectors to make a violation go away.
//
// NOT COVERED, on purpose: template literals. `${a} owes you ${b}` needs the
// call rewritten to t('key').replace('{x}', …), which a selector can't
// distinguish from a log line or a URL. Grep for backticks in JSX when
// touching a screen.
// ----------------------------------------------------------------------------
const I18N_NO_BARE_LITERALS = [
  {
    selector: 'JSXText[value=/[A-Za-z]{2,}/]',
    message:
      'Hardcoded user-facing text in JSX. Move it to src/lib/i18n.ts as { ur, en } and render t(\'key\') — ur is roman Urdu and is the default language.',
  },
  {
    selector:
      'JSXAttribute[name.name=/^(placeholder|aria-label|alt|title)$/] > Literal[value=/[A-Za-z]{2,}/]',
    message:
      'Hardcoded user-facing attribute. Move it to src/lib/i18n.ts as { ur, en } and pass t(\'key\').',
  },
  {
    selector: 'JSXElement > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]',
    message:
      'Hardcoded user-facing text in JSX. Move it to src/lib/i18n.ts as { ur, en } and render t(\'key\').',
  },
  {
    selector: 'JSXFragment > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]',
    message:
      'Hardcoded user-facing text in JSX. Move it to src/lib/i18n.ts as { ur, en } and render t(\'key\').',
  },
  {
    selector:
      'Property[key.name=/^(title|subtitle|message|body|confirmLabel|cancelLabel)$/] > Literal[value=/[A-Za-z]{2,}/]',
    message:
      'Hardcoded user-facing copy in a toast / confirm sheet. Move it to src/lib/i18n.ts as { ur, en } and pass t(\'key\') or tStatic(\'key\').',
  },
]

// ────────────────────────────────────────────────────────────────────────────
// TODO: shrink this list to zero.
// ----------------------------------------------------------------------------
// These files still hold bare literals. They are ignored so the rule can ship
// GREEN today and stop NEW debt everywhere else — not because they are
// exempt. Counts are as of the H5 sweep (2026-09-02); update them when a file
// is done and delete the entry when it reaches zero.
//
// Group A — owned by other in-flight audit work at the time of the sweep, so
// this pass deliberately did not touch them. Sweep them with their own change.
//   src/pages/QuickEntry.tsx            10
//   src/pages/CreateGroupModal.tsx      12
//   src/pages/SplitsPage.tsx            11
//   src/pages/AuthPage.tsx               5
//   src/pages/CreateCommitteeModal.tsx   2
//   src/pages/OnboardingPage.tsx         2
//
// Group B — needs a decision or a copy pass, not a mechanical sweep:
//   src/pages/PublicInfoPages.tsx       84  Privacy policy / Terms / Contact /
//                                           Deletion. Legal prose: the Urdu
//                                           version is a legal + content
//                                           decision, not a dev translation.
//   src/pages/HisaabAIPage.tsx          33  Conversational assistant copy, much
//                                           of it template literals the rule
//                                           cannot see anyway. Needs a persona
//                                           copy pass in both languages.
//   src/pages/RemittancesPage.tsx       36  DEAD CODE — zero importers, no
//                                           route (Remit was removed
//                                           2026-06-19). Delete the file rather
//                                           than translating it.
//
// Test files are excluded outright (below): they assert English copy on
// purpose, and vitest.setup.ts pins hisaab_lang='en' for exactly that reason.
const I18N_SWEEP_TODO = [
  'src/pages/QuickEntry.tsx',
  'src/pages/CreateGroupModal.tsx',
  'src/pages/SplitsPage.tsx',
  'src/pages/AuthPage.tsx',
  'src/pages/CreateCommitteeModal.tsx',
  'src/pages/OnboardingPage.tsx',
  'src/pages/PublicInfoPages.tsx',
  'src/pages/HisaabAIPage.tsx',
  'src/pages/RemittancesPage.tsx',
]

export default defineConfig([
  globalIgnores([
    'dist',
    'android/**/build',
    'android/app/src/main/assets/public',
    // Supabase Edge Functions run on Deno, not in the browser: `Deno` is a
    // global here and imports resolve against Deno's module graph. Linting
    // them with the app's browser config only produces false positives.
    'supabase/functions',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['**/*.test.tsx', ...I18N_SWEEP_TODO],
    rules: {
      'no-restricted-syntax': ['error', ...I18N_NO_BARE_LITERALS],
    },
  },
])
