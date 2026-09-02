import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
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
// Group A (QuickEntry.tsx, CreateGroupModal.tsx, SplitsPage.tsx, AuthPage.tsx,
// CreateCommitteeModal.tsx, OnboardingPage.tsx) was swept 2026-09-02 and is
// gone from this list — see git history for that pass.
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
//
// Test files are excluded outright (below): they assert English copy on
// purpose, and vitest.setup.ts pins hisaab_lang='en' for exactly that reason.
const I18N_SWEEP_TODO = [
  'src/pages/PublicInfoPages.tsx',
  'src/pages/HisaabAIPage.tsx',
]

// ────────────────────────────────────────────────────────────────────────────
// jsx-a11y — ARIA/semantics linting for src/pages + src/components
// ----------------------------------------------------------------------------
// Audit 2026-09 (13-engineering-standards.md §2.5, "Accessibility maturity"):
// no a11y linting existed anywhere in this repo. `eslint-plugin-jsx-a11y`'s
// own `flatConfigs.recommended` ships every rule at "error" (a few off by
// default — anchor-ambiguous-text, control-has-associated-label,
// label-has-for). Per this item's brief, only a named subset of
// user-impacting rules stays at "error"; every other rule the recommended
// preset turns on is downgraded to "warn" so it's visible without blocking
// CI on the long tail (color-contrast-adjacent role rules, scope, etc. — this
// repo already has a dedicated, computed contrast pass, see
// docs/accessibility-contrast.md).
//
// `no-noninteractive-element-interactions` was evaluated for the critical
// list and left at "warn": scoped lint runs below turned up real violations
// (bare onClick handlers on <div>/<li> rows without a role or keyboard
// handler) spread across call sites this agent cannot edit (pages/components
// are off-limits — see file-ownership header in the M3 task). Promoting it to
// "error" would either block CI on files outside this agent's remit or force
// an oversized ignore-list; `no-static-element-interactions` (also in scope)
// already catches the same authoring mistake's most common shape (a static
// element used as if it were interactive), so the critical/blocking coverage
// isn't lost — this rule keeps flagging the rest as warnings for a future
// pass to clear.
const A11Y_CRITICAL_RULES = [
  'jsx-a11y/alt-text',
  'jsx-a11y/aria-props',
  'jsx-a11y/aria-role',
  'jsx-a11y/role-has-required-aria-props',
  'jsx-a11y/label-has-associated-control',
  'jsx-a11y/click-events-have-key-events',
  'jsx-a11y/no-static-element-interactions',
]

function a11ySeverityOf(entry) {
  return Array.isArray(entry) ? entry[0] : entry
}

function a11yAsWarn(entry) {
  return Array.isArray(entry) ? ['warn', ...entry.slice(1)] : 'warn'
}

// Recommended preset rules, downgraded to "warn" except for
// A11Y_CRITICAL_RULES (kept at "error") and the handful already "off".
const A11Y_RULES = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, entry]) => {
    if (a11ySeverityOf(entry) !== 'error' || A11Y_CRITICAL_RULES.includes(rule)) {
      return [rule, entry]
    }
    return [rule, a11yAsWarn(entry)]
  }),
)

// ────────────────────────────────────────────────────────────────────────────
// TODO: shrink this list to zero.
// ----------------------------------------------------------------------------
// Files where an A11Y_CRITICAL_RULES rule fires and this agent cannot edit
// the file (src/pages/**, src/components/** are owned by other concurrently-
// running agents per this item's file boundaries). Same pattern as
// I18N_SWEEP_TODO above: ignored so the ruleset ships GREEN today, not
// because the violation is acceptable. Counts are per rule, as of the M3
// sweep (2026-09-02); update/delete an entry once its file is fixed.
//
// Every entry below is the same underlying shape: a full-screen `<div
// onClick={...}>` used as a backdrop click-catcher (dismiss a sheet/menu/
// dialog on outside-click) or a stopPropagation() wrapper next to one, with
// no keyboard handler and no interactive role — `click-events-have-key-
// events` + `no-static-element-interactions` fire in a pair on the same
// line. `docs/accessibility-contrast.md` §4 already describes the identical
// pattern in `Modal.tsx`'s own backdrop as "a decorative click-catcher
// only" — Escape-to-close plus a real focus trap (present on the dialog
// bodies that already carry `role="dialog"`) is the actual accessible path
// for a keyboard/screen-reader user, not a keyboard handler bolted onto the
// backdrop div itself. Fixing these for real means giving each such div
// `role="presentation"` (removing it from the a11y tree entirely, since it's
// non-content) rather than fabricating a fake interactive role — a page/
// component-level change, out of this agent's file ownership.
//
// 2026-09-02 follow-up sweep: all 8 files above got that real fix —
// role="presentation" on every backdrop/stopPropagation click-catcher div
// (aria-hidden="true" for DailyQuote.tsx's backdrop, which sits inside a
// wrapper that already carries role="dialog"; Modal.tsx's backdrop instead
// moved the dismiss handler onto the decorative-only div and dropped the
// dialog sheet's now-redundant stopPropagation, since role="presentation"
// would have collided with its real role="dialog") — see
// docs/accessibility-contrast.md §6.2 for the per-file rundown.
// `src/pages/LoanDetailPage.tsx` (overflow-menu scrim, L389, same shape as
// GoalsPage.tsx's L462) got the same role="presentation" fix in a later pass
// once file ownership passed to this agent. List is now empty.
const A11Y_SWEEP_TODO = []

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
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['**/*.test.tsx', ...A11Y_SWEEP_TODO],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: A11Y_RULES,
  },
])
