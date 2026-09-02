# Hisaab design system

This is the ONE source of truth for tokens, colors, spacing, radii, and
shared UI classes. It replaced two artifacts that had drifted apart and
gone stale — `src/lib/design-tokens.ts` (a JS token file nothing but
`currencyMeta` imported) and misleading adoption comments inside
`src/index.css` (a false "155+ call sites" claim, several `@layer
components` classes marked "introduced, not yet adopted" that had
actually since been adopted, and others genuinely still at zero). See
`docs/audit-2026-09/09-ui-quality.md` §1 and §3 for the audit that found
this, and the P2 M4 task that produced this doc for the full before/after.

**How this document was built:** every token below was verified by
grepping `src/**/*.tsx` for its Tailwind utility / class name / CSS
custom property, on 2026-09-02. "Adoption table" gives the real counts.
Nothing here is aspirational — if a token/class isn't in the survivors
list, it either has real call sites today or is a documented-but-not-yet-used
placeholder explicitly called out as such.

---

## 1. Where tokens actually live

- **`src/index.css`** — the real, live token layer. The `@theme` block
  (top of file) declares CSS custom properties that Tailwind 4 turns into
  utility classes automatically (`--color-accent-600` → `bg-accent-600`,
  `text-accent-600`, `border-accent-600`, `ring-accent-600`, …). The
  `@layer components` block further down declares hand-written shared
  classes (`.input-field`, `.cta-primary`, `.selector-base`, …) for
  patterns Tailwind utilities alone don't express well.
- **`src/lib/design-tokens.ts`** — now just currency metadata
  (`currencyMeta`: flag/symbol/name per ISO code, used by 20 files). It
  used to also export `colors`/`gradients`/`shadows`/`spacing`/`radii` JS
  objects; those were deleted (0 import sites anywhere, and they actively
  contradicted the live palette — e.g. they documented expense as red
  `#ef4444` while the real UI uses coral `#D9614A`). Don't resurrect that
  pattern — a token isn't real until something renders it.

If you're ever unsure whether a color/spacing/radius value is "the
token system," the test is: **is it a `@theme` custom property in
index.css, or a class in its `@layer components` block?** If not, it's
either dead, or it's one of the many still-uncaptured arbitrary Tailwind
values (`text-[11px]`, `rounded-[18px]`, …) that the audit found in large
numbers — real in the sense that they render, but not tokenized. Folding
those into the ladders below is future work, not something this pass did.

---

## 2. Color roles

### Brand / primary action — accent (violet)

| Token | Light hex | Dark hex | Tailwind utilities |
|---|---|---|---|
| `accent-50` | `#F3F0FF` | `#221C36` | `bg-accent-50`, `from-accent-50`, `to-accent-50` |
| `accent-100` | `#EBE6FF` | `#2A2342` | `bg-accent-100`, `border-accent-100` |
| `accent-500` | `#7C5CFF` | `#8E72FF` | `bg-accent-500`, `from-accent-500`, `ring-accent-500` |
| `accent-600` | `#5B47E8` | `#7459F0` | `bg-accent-600`, `to-accent-600`, `text-accent-600` |

This is the app's real primary-action color — "calmer than indigo-600,
more violet than blue" (index.css). It's what the BottomNav FAB, the
`.auth-cta` primary button, and most solid primary CTAs across pages
(`bg-accent-600 text-white`) use. **Legacy `indigo-*` Tailwind utilities
are the leak, not accent** — see §5.

There is no `accent-700`. Buttons that need a pressed/darkened state use
`active:brightness-95` (the `.auth-cta` idiom) rather than a step down
the ramp, because the app's tap feedback is normally handled by the
`press` scale ladder (§4), not by darkening.

### Money semantics — receive (green) / pay (coral)

| Token | Light hex | Role |
|---|---|---|
| `receive-50` / `receive-100` | `#E6F4EE` / `#DEF1E7` | tint backgrounds, chip fills |
| `receive-600` / `receive-700` | `#0F9D7B` / `#076B53` | solid fills, borders |
| `receive-text` | `#0F8466` | money-in text on cream |
| `pay-50` / `pay-100` | `#FBEDE7` / `#F7DDD2` | tint backgrounds, chip fills |
| `pay-600` / `pay-700` | `#D9614A` / `#B4452C` | solid fills, borders |
| `pay-text` | `#C45339` | money-out text on cream |

**The palette rule: pay is warm coral, never red.** The rationale (index.css:16-24, still accurate): users read "you owe" lines dozens of times a week, and a hard red reads as an alarm every time. Coral keeps it calm without hiding that it's a negative. `TransactionItem.tsx` centralizes this — every transaction type maps to `receive-*` or `pay-*`, never a raw Tailwind red/green. **Known leak: `GroupDetailPage.tsx:915` uses rose `#f43f5e` directly for a negative balance** — see §6, report-only (that file is owned by another workstream).

### Warn / info

| Token | Light hex | Role |
|---|---|---|
| `warn-50` | `#FBF3DD` | warning chip/banner background |
| `warn-600` | `#8D6813` | warning fill/icon color |
| `warn-700` | `#8A6410` | warning **text on `warn-50`** — this is the AA-safe pairing; `warn-600` text directly on `warn-50` under-contrasts. Prefer `warn-700` for text. |
| `info-50` | `#E8EEFB` | info chip/banner background |
| `info-600` | `#3F6BD9` | info fill/icon/text |

### Neutral surfaces — navy (hero) / cream (body) / ink (text)

| Token | Light hex | Role |
|---|---|---|
| `navy-900`/`800`/`700`/`600` | `#0B0E2A` → `#222654` | the dark hero surface at the top of navy-hero screens (auth, onboarding, group hero). `.bg-navy-bloom` layers two radial gradients on top of `navy-800`. |
| `cream-bg` | `#F4F2EC` | page body background |
| `cream-card` | `#FFFFFF` | card/sheet surface |
| `cream-border` | `#EAE5D9` | card/input borders |
| `cream-hairline` | `#EFEBE0` | thin dividers (lighter than border) |
| `cream-soft` | `#F8F6F0` | subtle recessed surfaces (pressed rows, toggle backgrounds) |
| `ink-200` → `ink-900` | `#E6E6EF` → `#0E102B` | neutral text/icon ramp, 200 lightest to 900 darkest in light mode (the ramp **inverts** in dark mode — see the `html.dark` block in index.css) |

All of the above flip automatically in dark mode via `html.dark` value
overrides on the same custom properties — components never need a
`dark:` utility prefix (there are zero in the codebase; this is
deliberate).

### Legacy / do-not-use

`--color-brand-*` (an indigo alias ramp: `brand-50/100/500/600/700`) was
**removed** — 0 Tailwind-utility call sites anywhere in `src/`, and no
CSS rule in `index.css` referenced it via `var()` either. If you see
stray `bg-indigo-*`/`text-indigo-*`/`ring-indigo-*` utilities in a
component, that's the pre-Sukoon brand color leaking through — replace
with the matching `accent-*` token, not `brand-*`.

---

## 3. Spacing scale

No JS export backs this anymore (the old `spacing` object in
design-tokens.ts had 0 consumers) — it's a convention enforced by
review, not by a token. Use by role, not feel:

| Rung | Px | Use |
|---|---|---|
| xs | 4px | icon inner padding, chip padding, hairline gaps |
| sm | 8px | tight gaps between related rows (`gap-2`) |
| md | 12px | compact card padding, modal footer action gaps (`p-3`, `gap-3`) |
| lg | 16px | **canonical** card/input/button padding (`p-4`, `py-4`) |
| xl | 20px | section gaps, generous empty-state padding (`p-5`) |
| 2xl | 24px | page top spacing before first content block (`pt-6`) |
| 3xl | 32px | rare — between distinct page blocks |

**Page top padding**, immediately below `<PageHeader>`:
- `pt-4` — scroll-dense pages (TransactionsPage, AnalyticsPage)
- `pt-5` — **canonical default** for list pages (SettingsPage, InboxPage, GoalsPage, LoansPage, SplitsPage)
- `pt-6` — hero-prefaced pages whose first block is a premium card (GroupDetailPage, LoanDetailPage)

New pages default to `pt-5` unless there's a specific reason to deviate.

**Known drift (report-only, not fixed by this pass):** the audit measured
`px-4`×106 vs `px-5`×83 vs `px-3`×83 as horizontal page gutters — `px-5`
is the documented canonical, but it isn't the plurality in practice.
Fixing that means touching `src/pages/*`, which is out of scope here.

---

## 4. Radii

| Rung | Px | Use |
|---|---|---|
| sm | 8px | chips, pills, small round things |
| md | 12px | icon containers, tight inline hints |
| lg | 16px | **canonical** card/input/button radius (`rounded-2xl`) |
| xl | 20px | premium cards (`AccountCard`) |
| full | 9999px | avatars, badges, unread dots |

**Known drift (report-only):** `rounded-[18px]` shows up ~75 times as a
de-facto third card radius alongside `rounded-2xl`(16px)/`rounded-xl`
(12px) — e.g. `ListSkeleton.tsx:25`, `HomePage.tsx`. It isn't in the
ladder above. Left as-is; fixing it means touching many page files
outside this task's ownership.

---

## 5. Shadows

No JS export backs this anymore either (same fate as `spacing`/`radii` —
0 consumers). The real elevation system is the handful of shadow
utilities actually used inline (`shadow-sm`, `shadow-md`, `shadow-lg`
plus a few `shadow-{color}-{n}/{opacity}` tints like `shadow-accent-600/20`)
and the two elevation classes below, which ARE real:

- `.modal-sheet` — `box-shadow: 0 -20px 60px -20px rgba(11,14,42,0.4)` — the lifted-sheet shadow for the bottom-sheet modal.
- `.card-base`/`.selector-base`-adjacent inline utilities generally use `shadow-sm`/`shadow-md` with a colored tint matching the surface (e.g. `shadow-accent-600/20` for an accent-filled button).

Pick by role, not aesthetic: `shadow-sm` for default resting cards,
`shadow-md` for a lifted primary CTA, `shadow-lg`/`shadow-xl` rare and
reserved for true overlays (modal sheets, floating popovers).

---

## 6. Type scale

The audit found ~29 distinct font sizes in practice (21 arbitrary
`text-[Npx]` pixel values plus the standard Tailwind scale) — that's
real, unfixed drift, out of scope for this pass (it lives in
`src/pages/*`). What IS fixed and worth relying on:

- **Weights are disciplined** — effectively three: `font-semibold`
  (dominant), `font-bold`, `font-medium`. Don't introduce a fourth.
- **10px is the legibility floor** — documented at the (now-removed)
  `.chip-status` token and still the right rule even though that class
  had no adopters. Audit flagged live violations below the floor
  (`text-[9px]`/`text-[8px]` sites in GroupDetailPage, KametiDetailPage,
  InboxPage, HisaabAIPage) as a MEDIUM a11y issue — report-only here,
  those files are owned elsewhere.
- **Numerals are tabular** where amounts render — `.tabular-nums` (or
  the `tabular-nums` Tailwind utility) on any money figure so digits
  don't shift width as they animate/update.
- **Font**: Geist (self-hosted, see the `@font-face` block in
  `index.css`), falling back to Inter, then system UI. `--font-sukoon`
  in the `@theme` block carries the full fallback stack.

---

## 7. Shared component classes (`@layer components` in index.css)

Every class below was measured as actually rendered in `src/**/*.tsx`
(2026-09-02 census). Counts are call sites, not files.

| Class | Call sites | Role |
|---|---|---|
| `.input-field` | 65 | Form text input chrome |
| `.form-label` | 101 | Uppercase field label above an input |
| `.cta-primary` | 23 | Full-width primary footer button (indigo gradient — pre-dates the accent migration; still the CSS backing `Button`'s `gradient` variant) |
| `.cta-secondary` | 5 | Full-width secondary footer button |
| `.cta-destructive` | 2 | Full-width destructive action button |
| `.selector-base` / `.selector-selected` | 18 / 18 | Row-shaped picker option (account picker, currency picker, strategy picker) |
| `.row-base` | 2 | Structural-only row (flex/gap/align, no chrome) |
| `.row-interactive` | 2 | Tap-feedback flash, composable with `.row-base` |
| `.nav-icon-button` | 10 | Small square icon button (PageHeader back, Modal close) |
| `.modal-backdrop` / `.modal-sheet` / `.modal-header` / `.modal-body` / `.modal-footer` | 1 each | The 5 structural slots of `<Modal>` — fully adopted by `src/components/Modal.tsx` |
| `.sheet-actions` / `.sheet-transient` | 1 each | Lighter-weight bottom-sheet shell, adopted by `ConfirmDestructiveSheet.tsx` |
| `.btn-gradient` | 1 (+`.cta-primary` shares its visual) | Indigo gradient button base, backs `Button`'s `gradient` variant (2 real render sites: `ConfirmationSheet`, `EmptyState`) |
| `.bg-mesh` | 2 | Soft radial-gradient page background (empty/loading states) |
| `.bg-navy-bloom` | 9 | Navy hero surface with violet+coral radial bloom |
| `.sukoon-body` | 24 | The cream body wrapper that pulls up under a navy hero |
| `.no-scrollbar` | 8 | Hide scrollbar on a horizontally-scrolling row |
| `.pt-safe` | 5 | iOS safe-area-aware top padding |
| `.glow-attention` | 1 | Pulsing glow on a single "look here" CTA (InvestmentsPage record-trade) |
| `.wisdom-spectrum` / `.wisdom-text` / `.wisdom-wash` | 2 / 1 / 1 | Daily-wisdom popup's rainbow drift — the one surface allowed to be loud |
| `.auth-float-label` / `.auth-input` / `.auth-cta` | 2 / 1 / 1 | AuthPage's floating-label glass inputs + primary CTA |
| `.app-loading-*` (10 classes) | 10 | `AppLoadingScreen` typewriter/brand mark |
| Motion classes (`.press`/`.press-lg`/`.press-sm`/`.press-xs`, `.stagger-in`, `.skeleton-sweep`, `.animate-*`) | 100s combined | Tap-feedback ladder, list stagger, skeleton shimmer, and the named keyframe animations — see the MOTION SYSTEM comment block in index.css. All real, all adopted. |

### Deleted (0 call sites, measured 2026-09-02)

`.card-premium`, `.card-base`, `.card-interactive`, `.row-card`,
`.chip-base`, `.chip-selected`, `.chip-status`, `.toggle-row`,
`.state-hint-info`, `.state-hint-warn`, `.state-hint-error`,
`.page-shell`, `.glass`, `.glass-dark`, `.glass-brand`,
`.text-gradient-brand`, `.text-gradient-income`, `.text-gradient-expense`,
`.glow-brand`, `.glow-income`, `.glow-expense`, `.glow-savings`,
`.pb-safe`, `.bottom-safe`, and the `--color-brand-*` custom-property
ramp. ~250 lines removed from `index.css`; their dark-mode overrides
(`html.dark .card-base`, etc.) were pruned too, values untouched. If you
find yourself wanting one of these back, that's a signal to actually
adopt it at 2+ call sites first — re-introducing an unused token is how
this drift happened the first time.

---

## 8. How to add a token

1. **Prove you need it at 2+ call sites**, or that it's a structural
   pattern you're about to introduce app-wide (e.g. a new modal type).
   A token with one caller should just be an inline utility.
2. **Color/font/animation-name tokens** go in the `@theme` block at the
   top of `src/index.css`, as a `--color-*`/`--font-*`/`--animate-*`
   custom property. Tailwind 4 generates the utility classes
   automatically — you don't hand-write `.bg-my-token`.
3. **Structural/behavioral classes** (chrome that utilities can't
   express cleanly — pseudo-elements, multi-property transitions,
   `:focus-visible` rings, composable modifiers) go in the
   `@layer components` block, following the existing pattern: a short
   comment naming what it replaces/extracts from, the class, then any
   `:active`/`:focus-visible`/modifier rules directly below it.
4. **Never invent a new value** — extract it from an existing good
   implementation already in the codebase (this is how every surviving
   token here was built: "nothing invented," per the original Phase
   A–F1 comments). Grep for the pattern you're about to copy first.
5. **Update the adoption table above** when you add or remove a class,
   so this stays a measured document instead of an aspirational one.
6. **Dark mode**: if the token is a `--color-*` custom property, add its
   `html.dark` override next to the others in the `DARK THEME` block —
   utilities pick it up automatically, no `dark:` prefixes needed. If
   it's a hardcoded-hex `@layer components` class, add an explicit
   `html.dark .your-class { … }` override (see the pattern above
   `.input-field`/`.selector-base`/`.cta-secondary`).
7. **Money color, specifically**: never use raw `red-*`/`green-*`/
   `emerald-*` Tailwind colors for a money direction. Use `receive-*` for
   in, `pay-*` for out — pay is coral, never red (§2).

---

## 9. Known palette leaks outside this task's scope (report-only)

These were found while measuring adoption but live in files this task
does not own (`src/pages/*`) — flagging for whoever owns those pages
next, not fixed here.

- **`GroupDetailPage.tsx:685-686`** — `ProgressRing` colors hardcode old-brand `#10b981` (pre-Sukoon green) and `#6366f1` (indigo) instead of `receive-600`/`accent-600`.
- **`GroupDetailPage.tsx:915`** — rose `#f43f5e` for a negative balance, directly violating the "coral, not red" money-out rule (§2). Every other screen's money-out uses `pay-text`/`pay-600`.
- **`GroupDetailPage.tsx:891,916,1094,1109,1116,1127`** — several `bg-gradient-to-br from-indigo-*` chips/buttons and a `bg-ink-900 … shadow-indigo-500/20` CTA pattern.
- **Widespread `shadow-indigo-500/20`-on-`bg-ink-900` "primary submit" buttons** across many modal pages not owned by this task — `AddAccountStepper.tsx`, `AddGroupExpenseModal.tsx`, `AddUpcomingExpenseModal.tsx`, `ContactDetailSheet.tsx`, `CreateGroupModal.tsx`, `EditGroupExpenseModal.tsx`, `EditTransactionModal.tsx`, `JoinGroupModal.tsx`, `SettleUpModal.tsx`, `SpendingWarningModal.tsx` (11+ files). This is actually a **more numerous** indigo leak than the `Button.tsx` one this task fixed — same root cause (pre-Sukoon indigo never swept from inline `className` strings), just in raw JSX instead of the shared `Button` component. Worth its own pass.
- **`PinLockScreen.tsx:101,167`** and **`components/PWAInstallPrompt.tsx:168,179`** — indigo gradient backgrounds/text, same leak.
- **`components/ContactPicker.tsx:73,102,108,128`** — `focus:ring-indigo-500`, `hover:bg-indigo-50`, `text-indigo-600`/`bg-indigo-100` selected-state.
- **Focus-ring-only leaks** (`focus:ring-indigo-500/20`) inside several `inputClass` constants: `AddGroupExpenseModal.tsx`, `CreateGroupModal.tsx`, `EditGroupExpenseModal.tsx`, `JoinGroupModal.tsx`, `SettleUpModal.tsx`, `SplitWithSheet.tsx` — cosmetically minor (only visible on keyboard focus) but same root leak.
- **Typography**: 25 sites at 8-9px below the documented 10px legibility floor (§6) — `GroupDetailPage.tsx:965,969`, `KametiDetailPage.tsx:300`, `InboxPage.tsx:882`, `HisaabAIPage.tsx:634`.
- **Contrast**: `text-ink-400`/`text-ink-500` on `cream-bg` and `text-warn-600` on `warn-50` were previously measured failing WCAG AA — a separate, already-in-flight contrast pass adjusted the token *values* for this (see the ink-400/ink-500/warn-600 comments in `index.css` and `docs/accessibility-contrast.md`); not re-verified as part of this token-adoption pass.
