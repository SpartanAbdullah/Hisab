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

---

## 10. 3D clay

A surface treatment for buttons and cards — a flat, faintly luminous
tinted panel with a rendered 3D icon floating over it. It is a
**system**, not a skin: two tiers, seven tints, one press. Everything
lives in the `3D CLAY` block at the bottom of `src/index.css` (clearly
delimited by banner comments), the pure helpers in `src/lib/clay.ts`, and
four components.

**No existing token value was changed to add it.** Every `--clay-*`
property is new, and where a ramp already existed (`receive-*`, `pay-*`,
`warn-*`, `info-*`, `accent-*`, `cream-*`) the clay tokens *reference*
it rather than copying it, so the tint flips in dark mode for free.

### 10.0 The lip was removed (2026-09-03) — read this before adding an edge

v1 of this system gave every `.clay-tile` and every `.clay-depth` button a
**3px solid bottom lip** in a lighter shade of its own tint, and gave
`.clay-card` a softer version of the same edge. The founder's verdict, on
seeing it shipped:

> "I didn't like the design, especially the underlining border which you
> always place whatever site you design and it is so obvious that this is
> a vibe coded app and which results in trust drain. It doesn't give the
> premium look."

He is right, and the reasoning generalises: a hard candy-coloured edge
drawn under every surface is the single most templated thing a UI can do,
and in a money app *looking* templated is a trust cost, not a taste
disagreement. It was removed everywhere — tiles, cards, and the
`.clay-depth` buttons — and replaced with the recipe in §10.1.

The tokens were **deleted, not zeroed**: `--clay-lip-depth`,
`--clay-lip-depth-pressed`, `--clay-press-travel`, all seven
`--clay-*-lip` values and all five `--clay-solid-*-lip` values are gone
from `index.css`. A `0px` lip left sitting in the token list is an
invitation to turn it back on. The **class names** all survived
(`.clay-tile`, `.clay-card`, `.clay-depth`, `.clay-depth-{primary,
secondary,danger,warning,ink}`), which is why the swap reached every page
in the app without a single page file changing.

**Do not reintroduce a bottom edge, a `border`, or an outset ring on any
clay surface.** If you need more separation, reach for the shadow spread
or the radius, never for a drawn line.

### 10.1 The two tiers — never collapse them

The surface recipe, in paint order, is the same for both tiers:

1. **fill** — `linear-gradient(var(--clay-grad-dir), var(--clay-top),
   var(--clay-bottom))`, always **lighter at the top**. Only the
   *direction* token flips per theme (`to top` light, `to bottom` dark),
   because the ramps disagree about which rung is the lighter one — a
   colour token could not do this (see the `var()`-resolution note in
   §10.2). v1 ran darker-at-top in light mode, which put the darkest band
   directly under the white highlight and made every panel read as
   *dished*; lighter-at-top is what makes it read as lit from above.
2. **hairline** — `inset 0 0 0 1px rgb(var(--clay-key) / .14)`: 1px in the
   surface's *own* hue, inside the radius. Never grey, never black, never
   outset — an outset ring is a drawn edge, an inset one is where the
   material ends.
3. **top highlight** — `inset 0 1px 0 0 rgba(255,255,255,.45)`. Weaker
   than v1's `.6`; it should read as light catching an edge, not as a
   white line.
4. **contact** — `0 1px 2px -1px` navy at 5%. One pixel of grounding.
5. **ambient** — a large-radius, heavily-negative-spread shadow in the
   surface's own hue. This is the *only* elevation cue now.

| | `.clay-tile` | `.clay-card` |
|---|---|---|
| Role | **Pressable** | **Informational** |
| Radius | 16px (`--clay-radius-tile`) | 24px (`--clay-radius-card`) |
| Layers 1–4 | as above | same |
| Ambient shadow | `0 8px 24px -12px` tint @ 25% | `0 12px 32px -16px` tint @ 20% |
| Press | `scale(.985)` + shadow 25%→14%, 140ms | none |
| Focus ring | `2px accent-500`, offset 2 | none (not focusable) |

A tile's shadow sits **tighter and stronger**, a card's **wider and
flatter** — a tile reads as liftable, a card as floating. That plus the
radius gap is what separates the tiers now that neither has an edge
treatment of its own, and the radius gap is load-bearing: a user must be
able to tell "I can press this" from "this is telling me something"
*before* touching either. If a card needs a tap, it is not a card — use
`Tile3D`.

Dark mode is the same recipe with **every shadow off** (`--clay-*-alpha`
→ 0; a cast shadow on a dark ground is invisible at best, muddy at worst)
and the tint hairline replaced by an **inset** 1px rim light at 7% white
(`--clay-rim`). Inset, again, because an outset ring paints a hard 1px
edge outside the radius — the exact look this rebuild removed.

### 10.2 Tokens added

Geometry and lighting, on `:root`:

| Token | Light | Dark | Note |
|---|---|---|---|
| `--clay-radius-tile` | `16px` | — | = §4 "lg", the canonical card/button radius |
| `--clay-radius-card` | `24px` | — | = the `.sukoon-body` corner |
| `--clay-press-scale` | `0.985` | — | the whole press; there is no travel |
| `--clay-press-duration` | `140ms` | — | |
| `--clay-press-ease` | `cubic-bezier(.16,1,.3,1)` | — | the app's existing decel curve |
| `--clay-highlight` | `rgba(255,255,255,.45)` | `rgba(255,255,255,.06)` | |
| `--clay-hairline-alpha` | `.14` | `0` | alpha of the inset 1px in `--clay-key`'s hue |
| `--clay-ambient-rgb` | `11 14 42` | — | navy-900, same ink as `.modal-sheet`'s shadow |
| `--clay-ambient-alpha` | `.05` | `0` | the 1px contact shadow |
| `--clay-shadow-alpha` | `.25` | `0` | the tile's ambient; also what `.clay-depth` uses |
| `--clay-shadow-alpha-pressed` | `.14` | `0` | what `:active` remaps `--clay-shadow-alpha` to |
| `--clay-card-shadow-alpha` | `.2` | `0` | the card's (wider, flatter) ambient |
| `--clay-rim` | `0 0 0 0 transparent` | `inset 0 0 0 1px rgba(255,255,255,.07)` | dark-mode edge cue |
| `--clay-grad-dir` | `to top` | `to bottom` | keeps both themes lighter-at-top over inverting ramps |

The shadow **layers** are written inline in `.clay-tile` / `.clay-card`
rather than hoisted into a single `--clay-shadow` token, and that is not
laziness: a custom property whose value contains `var(--clay-key)`
resolves that `var()` on the element it is **declared** on (`:root`), not
on the element it is used on, so a hoisted token would paint every tint
with the neutral key. The *alphas* can be hoisted because they carry no
`var()` of their own — which is also what lets `:active` and `:disabled`
remap one property and have the whole stack recompute.

Tint ramps. Each supplies `-top` (gradient start), `-bottom` (gradient
end), `-key` (an `R G B` triple driving the hairline, the ambient shadow
*and* the icon's drop-shadow — one hue doing all three is what makes a
panel read as a single material), and `-strong` (a saturated on-tint
colour). Values in **bold** are new hex; the rest are `var()` references
to existing tokens. **v1's `-lip` column is gone** (§10.0).

| Tint | Role | `-top` L / D | `-bottom` L / D | `-key` (L) | `-strong` L / D |
|---|---|---|---|---|---|
| `gold` | kameti / coins | **#F8EAC4** / **#372F15** | `warn-50` #FBF3DD / #2A2410 | `218 180 78` | `warn-700` |
| `sky` | splits / chat | **#D4DFF7** / **#1C2A4B** | `info-50` #E8EEFB / #15203A | `104 141 223` | `info-600` |
| `blush` | khata / hands | **#F6DAE3** / **#361621** | **#F9EBF0** / **#281018** | `218 108 145` | **#99294E** / **#E56C94** |
| `mint` | savings / receive | `receive-100` #DEF1E7 / #163528 | `receive-50` #E6F4EE / #12271F | `107 199 150` | `receive-700` |
| `coral` | money out | `pay-100` #F7DDD2 / #371C15 | `pay-50` #FBEDE7 / #2A1611 | `227 138 99` | `pay-700` |
| `accent` | primary action | `accent-100` #EBE6FF / #2A2342 | `accent-50` #F3F0FF / #221C36 | `139 113 244` | `accent-600` |
| `neutral` | untinted | `cream-card` #FFFFFF / #1E1F27 | `cream-soft` #F8F6F0 / #191A21 | `11 14 42` | `ink-700` |

**`blush` is the only fully new ramp** — no pink existed in the palette.
Hue 340° puts it clearly apart from coral (18°) and accent violet (252°),
and far enough from red that it never reads as an error state.

**Two tints beyond the five product ones**, each for a stated reason:
- `accent` — Button's `depth` primary. §2 makes accent violet the app's
  real primary-action colour and pay-coral the money-OUT semantic;
  painting every primary CTA coral would break the "coral means you owe"
  read users get dozens of times a week. Coral stays available as a tile
  tint, it just isn't wired to the primary button.
- `neutral` — `Card3D`'s default. An informational surface with no domain
  meaning must not borrow one.

Solid-fill shadow hues (Button `depth` only). A solid button paints its
own fill and takes nothing from the tint ramps above — it needs only an
`R G B` triple to tint its ambient shadow with, and that triple is the
fill's own colour. These replace v1's five `--clay-solid-*-lip` tokens
one-for-one; the classes consuming them kept their names, so no call site
changed.

| Token | Value | Why |
|---|---|---|
| `--clay-depth-accent-rgb` | `91 71 232` | accent-600 `#5B47E8` |
| `--clay-depth-pay-rgb` | `217 97 74` | pay-600 `#D9614A` |
| `--clay-depth-warn-rgb` | `141 104 19` | warn-600 `#8D6813` |
| `--clay-depth-neutral-rgb` | = `--clay-ambient-rgb` | a slate-100 button has no colour worth casting |
| `--clay-depth-ink-rgb` | = `--clay-ambient-rgb` | ink-900 cast as ink-900 is just black; navy at low alpha is softer |

`--clay-depth-ink-rgb` serves the app's very common raw `bg-ink-900
text-white` CTA (§9 lists 11+ files carrying it inline). It needed no
dark-mode value at all, which is itself the argument for the new recipe:
v1's lip needed one (the ink ramp **inverts**, so `bg-ink-900` is a
*light* fill in dark mode and a near-black lip under it read as a drawn
line), whereas the shadow simply switches off with every other shadow
when `--clay-shadow-alpha` goes to 0.

`.clay-depth` paints **no** hairline and **no** top highlight — a
saturated fill supplies its own edge, and an inset white line across the
top of an accent-600 button is the "glossy web 2.0 button" tell.

Selection also gets a slot in the tile's shadow list rather than its own
stack: `--clay-ring` (`0 0 0 0 transparent` → `inset 0 0 0 2px
accent-500`), so `.clay-tile-selected` switches on a ring by remapping one
property instead of redeclaring five values it does not care about.

### 10.3 Contrast — computed, not eyeballed

Body text on a clay surface is `ink-900` (title) or `ink-600` (subtitle).
Ratios below are the **worst case for each tint** — measured against the
darker gradient stop in light mode and the lighter one in dark, i.e. the
end of the gradient where dark-on-light / light-on-dark is hardest.
Computed with `src/lib/contrast.ts`; AA normal-text floor is 4.5:1.

| Tint | Light: ink-900 / ink-700 / ink-600 | Dark: ink-900 / ink-700 / ink-600 |
|---|---|---|
| gold | 15.57 / 8.35 / **5.47** | 12.22 / 8.68 / **6.62** |
| sky | 13.92 / 7.47 / **4.89** | 13.03 / 9.26 / **7.06** |
| blush | 14.24 / 7.64 / **5.00** | 14.93 / 10.61 / **8.09** |
| mint | 15.82 / 8.49 / **5.56** | 12.27 / 8.72 / **6.65** |
| coral | 14.39 / 7.72 / **5.06** | 14.42 / 10.24 / **7.81** |
| accent | 15.34 / 8.23 / **5.39** | 13.62 / 9.68 / **7.38** |
| neutral | 18.62 / 9.99 / **6.54** | 15.08 / 10.71 / **8.17** |

Every pairing clears AA in both themes; the binding case is `ink-600` on
`sky` in light mode at **4.89:1**. `ink-400`/`ink-500` are *not* cleared
for use on clay — don't reach past `ink-600` for a subtitle.

`.clay-tile-badge` deliberately does **not** use `--clay-*-strong` as a
fill: white on `receive-600` is 2.9:1, and a per-tint text colour would
be seven more values to keep honest. It uses `cream-card` + `ink-900`
instead — 18.6:1 light, 15.1:1 dark, in every tint.

A stacked tile's title (`iconPlacement="top"`) is **`ink-700`, not
`ink-900`** — it is a caption under the art, not a heading. `ink-700`
clears AA on every tint in both themes by a wide margin (7.47:1 worst
case light, on `sky`; 8.68:1 worst case dark), so the demotion costs
nothing in legibility. `ink-600` remains the floor; do not reach past it.

The hairline and the ambient shadow are decorative depth, not state
indicators, so neither is held to the 3:1 non-text bar — they sit at 14%
and 25% of the tint's own hue by design. Nothing in this system now
communicates state through an edge at all: state is the selection ring
(inset 2px accent-500), the focus outline, `opacity` for disabled, and
`aria-*` on the element.

### 10.4 Utility class contract

| Class | Contract |
|---|---|
| `.clay-tile` | Tier-1 chrome + geometry. Put it on a `<button>` or `<Link>`, never a `<div>`. Honours `:disabled` and `[aria-disabled="true"]`. |
| `.clay-tile:active` | Remaps `--clay-shadow-alpha` to `--clay-shadow-alpha-pressed` and scales to `--clay-press-scale`. No translate, no edge change. |
| `.clay-tile-has-icon` | Corner layout, md icon. Reserves the 64px inline-end gutter; min-height 76px. **Values frozen** — this is what every pre-`iconSize` call site renders. |
| `.clay-tile-has-icon-sm` | Corner layout, sm icon: 52px gutter, min-height 64px. |
| `.clay-tile-has-icon-lg` | Corner layout, lg icon: 80px gutter, min-height 92px. A wide hero tile — a 4-up grid uses `top` placement instead. |
| `.clay-tile-stack` + `.clay-tile-stack-{sm,md,lg}` | Stacked ("top") layout: centred text, 6px inline padding, and a top padding reserving the icon's visible height + 8px (30 / 37 / 46px). No inline-end gutter. Title is 11px/500/`ink-700` here, subtitle 10px. |
| `.clay-tile-stack-bare` | Layers on the stack classes for `label="hidden"`: 14px bottom padding (no text to hold the box open) and `min-height: 44px` so the tap target stays legal. Never replaces them — the icon's reserved top padding still has to be there. |
| `.clay-tile-selected` | The one selection treatment: `--clay-ring: inset 0 0 0 2px accent-500`. Inset, so it stays distinguishable from the outset focus ring. |
| `.clay-card` | Tier-2 chrome + geometry. No padding of its own — pair with a `.clay-card-*`. |
| `.clay-card-none` / `-sm` / `-md` / `-lg` | 0 / 14 / 20 / 24px padding. |
| `.clay-card-has-icon` | 64px inline-end gutter for a card carrying a corner icon. Never applied under `padding="none"`. |
| `.clay-gold` `.clay-sky` `.clay-blush` `.clay-mint` `.clay-coral` `.clay-accent` `.clay-neutral` | Tint **scopes**. They only remap custom properties — they paint nothing — so they compose onto a tile, a card, a `.clay-depth` button, or a bare wrapper whose children should inherit the tint. |
| `.clay-depth` + `.clay-depth-{primary,secondary,danger,warning}` | Ambient shadow + scale press for an element that paints its own fill (`0 6px 18px -8px` in the variant's own hue). No hairline, no highlight. This is what Button's `depth` prop emits. |
| `.clay-depth-ink` | Depth for the raw `bg-ink-900 text-white` CTA idiom (§9), which is **not** a `<Button>` variant. Compose by hand: `class="bg-ink-900 text-white … clay-depth clay-depth-ink"`. Adding an `ink` variant to `BUTTON_VARIANT_CLASSES` was considered and rejected — §9 lists that idiom as an indigo-era leak awaiting its own sweep, and blessing it as a first-class variant would entrench it. |
| `.clay-icon` | The `<img>` itself: tint-coloured `drop-shadow(0 5px 10px … / .2)` (light mode only). |
| `.clay-icon-sm` / `-md` / `-lg` | 36 / 48 / 64px box. Must stay in lockstep with `CLAY_ICON_SIZES` in `src/lib/clay.ts` — `clay.test.ts` pins the numbers. |
| `.clay-icon-float` | Negative block-start margin = 35% of the icon's height (−13 / −17 / −22px), so it overhangs the container's top edge. |
| `.clay-tile-icon`, `.clay-card-icon` | One rule, two selectors — absolute anchor at the surface's top inline-**end** corner (logical property — mirrors correctly under RTL). Tier-neutral on purpose; see §10.6. |
| `.clay-tile-icon-top` | Stacked anchor: centred via `inset-inline: 0` + `margin-inline: auto` (direction-agnostic, unlike `left:50%` + a translate) with a 40% overhang (−14 / −19 / −26px). Icon3D is rendered **without** `float` here — this class owns the offset, so two negative margins can never stack. |
| `.clay-tile-title` / `.clay-tile-sub` / `.clay-tile-badge` | Tile type slots. |
| `.clay-tile-badge-corner` | Layers on `.clay-tile-badge`: pins it to the top inline-end corner with a 2px ring in the tile's colour *at its top edge* — `--clay-bottom` in light, `--clay-top` in dark (an `html.dark` override outside the layer) — so it reads over a floating icon. |

**Why most of this block is non-layered:** `.clay-depth` has to beat the
`shadow-sm` / `active:shadow-none` Tailwind utilities already baked into
`BUTTON_VARIANT_CLASSES`, and a `@layer components` rule always loses to
a utility. Surface/shadow rules therefore sit outside the layer (the same
trick the `html.dark` overrides use). **Geometry** — padding, min-size,
radius, type — stays *inside* `@layer components`, so page code can still
override it with a plain `p-4` or `rounded-none`.

### 10.5 Motion

Only `transform` is transitioned (140ms). The shadow pull-in is
**instantaneous** — `box-shadow` is never animated, per the MOTION SYSTEM
performance contract in `index.css` (transform/opacity only; this app
ships to low-end Android WebViews).

The press is `scale(0.985)` and nothing else. Deliberately **not** a
translate: a tile that moves down leaves a visible gap at its old top
edge, which is a large part of what made v1 read as a button decal.

Under `prefers-reduced-motion: reduce` the transform is dropped and the
instant shadow change carries the whole press. Unchanged in kind from v1
— only the thing carrying the residual feedback moved (lip → shadow).
Same reasoning as the `.press` ladder in §7: a tap that produces no
feedback at all is worse than a subtle one; reduced motion means reduce
*animation*, not remove state changes.

#### 10.5.1 Cute motion (2026-09-05)

Five micro-animations, founder-approved on 2026-09-05 from a playable
preview. They live in the MOTION SYSTEM block of `index.css` under the
"Cute motion" heading and are bound by the same contract as everything
else there: `transform` / `opacity` only, no `will-change`, and every one
is silenced in the block's **single** `prefers-reduced-motion` gate —
never per-component. Each lands in its final state under reduced motion;
nothing is left stuck at `opacity: 0` unless invisible *is* its final
state (the coin and the confetti bits, which are transient by design).

The class names are a contract. Components consume them by exact name
and never invent siblings:

| # | Motion | Class | Where it applies | Duration | Reduced motion |
|---|--------|-------|------------------|----------|----------------|
| 1 | Tap squish | `.clay-icon-squish` | the `Icon3D` `<img>` inside a pressed `Tile3D` | 420ms, once per tap, spring curve, anchored at the icon's base | `animation: none` — icon rests at `scale(1)` |
| 2 | Coin drop | `.animate-coin-drop` on the coin, `.animate-wallet-catch` on the wallet | the `ConfirmationSheet` header — the sheet every saved money entry ends in (Quick Entry, record payment, record trade; both app modes): a coin falls into the wallet icon, the wallet catches it | 1.15s each, starting 260ms after the sheet mounts, once per save | coin pinned at `opacity: 0`, wallet at rest; the sheet itself still shows |
| 3 | Confetti burst | `.animate-confetti-bit` | inside `CelebrationMark`, over the existing ring / pop / check — rendered by `ConfirmationSheet` when the save closed a debt (`settled`); the daily Hisaab check draws the mark with `burst={false}` | 1.05s per bit, staggered via `--d`, once per settle-up | bits pinned at `opacity: 0`; ring / pop / check gate exactly as before |
| 4 | Greeting wave | `.animate-wave-once` | the waving-hand emoji in the Home greeting | 1.15s, once per app open, 200ms in, pivots at the wrist | `animation: none` — hand at `rotate(0)` |
| 5 | Idle float | `.animate-float-idle` | the `Icon3D` on a full-page `EmptyState` — never the `compact` inline variant, which sits beside live content | 3.6s loop, 5px of travel, only while the screen is empty | `animation: none` — icon still |

Notes that are easy to get wrong:

- **Squish** shares the spring curve (`cubic-bezier(.34,1.56,.64,1)`)
  with `celebrate-pop`. Those are the only two uses of it in the app; both
  are tactile moments. Do not reach for it on entrances, reveals or
  anything the user did not physically touch.
- **Coin** is a small absolutely-positioned `<img>` over the wallet
  `<img>`. Both animations start at the same 260ms offset so the wallet's
  squash lands with the coin. `both` fill keeps the coin at `opacity: 0`
  through the delay and after it sinks — a sheet opened twice never shows a
  coin lying in the wallet. The sheet clips at its rounded top edge, so the
  coin's rest position sits 46px+ below it and the whole fall is seen; move
  the stage and re-check that headroom. If either clay asset is missing the
  sheet falls back to its old tick — never a coin dropping into nothing.
- **Confetti** bits are absolutely-positioned `<i>` elements centred on
  the mark (8px round, or 7×10px with a 2px radius), each given
  `--dx`, `--dy`, `--rot`, `--d` and an inline `background: rgb(R G B)`
  by the component. One keyframe serves every bit; the custom properties
  do the spreading, the same trick as `--sweep-delay` on the skeleton.
  The burst is opt-out (`burst={false}`) and the mark has two hosts: the
  `ConfirmationSheet` when a repayment closed a loan (`settled`, wired
  from Quick Entry's four repayment paths in both app modes), and the daily
  Hisaab check, which deliberately draws the tick *without* the burst — a
  burst that fires every day is a tic, and it would cheapen the one that
  means a debt closed. `RepaymentModal` (record payment from the loan
  page) opens the same sheet and should pass `settled` too; the kameti
  payout slip stays burst-free by an earlier decision (its own amount
  swell is "far short of anything that would look like celebration
  confetti over someone else's money").
- **Wave** must sit on an `inline-block` span — transforms do nothing on
  inline text. The emoji is decorative and carries `aria-hidden`. Its host
  `<p>` is `truncate` and shrink-to-content, so it carries `pr-1`: the 16°
  swing pushes the fingertips ~3px past the name, and without that padding
  the clip edge cuts them at both peaks of the wave.
- **Float** is the one deliberate loop in the block. It exists for the
  *absence* of content; never put it on a screen that has any — which is
  why `EmptyState`'s `compact` variant (inline beside a balance or a list
  header) renders its icon still.
- None of the five draws an edge, lip, border or shadow. Every moving
  element is an existing `<img>` or a colour-filled dot — §10.0 holds.

**Not shipped — screen slide (candidate 6).** The preview also showed a
list → detail push / pop slide on navigation. Deliberately dropped. It
would run on every route change on every tap, compositing two full-screen
layers at once — on the low-end Android WebViews this app targets, that
is the most expensive thing a page can animate, and unlike the five above
it is not a moment, it is a tax on all of them. If it ever ships it needs
a Settings toggle (off by default on low-RAM devices) and a
reduced-motion path that only crossfades. Nothing in the codebase should
reference it today.

### 10.6 Component APIs

```tsx
// src/components/Icon3D.tsx
<Icon3D name="coins" size="sm|md|lg" float className="" />
```
Renders `<img src="/3d/<name>.webp" srcSet="/3d/<name>@2x.webp 2x" width
height alt="" aria-hidden loading="lazy" decoding="async">`. Purely
decorative by construction — the meaning always lives in the adjacent
label. **An unknown `name` renders nothing at all**, never a broken-image
glyph: the asset pipeline is a separate workstream, so a tile may
legitimately name an icon that has not been produced yet.

```tsx
// src/components/Tile3D.tsx  — TIER 1, pressable
<Tile3D
  tint="gold"            // ClayTint, default 'neutral'
  icon="coins"           // optional; unknown names simply render no icon
  iconPlacement="corner" // 'corner' (default) | 'top'
  iconSize="md"          // 'sm' (36px) | 'md' (48px, default) | 'lg' (64px)
  title={t('key')}       // required, ALWAYS — even when label="hidden"
  label="below"          // 'below' (default) | 'hidden' (top placement only)
  subtitle={t('key')}    // optional; dropped under label="hidden"
  badge={<>…</>}         // optional ReactNode → neutral pill
  badgePlacement="inline"// 'inline' (default) | 'corner'
  selected               // optional; ring + aria-pressed / aria-current
  onClick={fn}           // renders <button type="button">
  to="/route"            // renders react-router <Link> instead
  disabled               // forces <button disabled>, never a dead <Link>
  className=""
/>
```

**`iconPlacement="top"`** centres the icon over the tile's top edge (40%
overhang, vs 35% for `corner` — with the title beneath rather than beside,
it needs to clear the edge more decisively) and centres the title and
subtitle below it, with **no 64px inline-end gutter**. That gutter is
exactly why the option exists: a 4-up grid on a 360px phone leaves ~74px
per tile, so `corner` cannot fit. Title/subtitle are 11px/10px in this
shape — 10px is the §6 legibility floor, do not go below it to win
another character.

**`iconSize="lg"` (64px) on a 4-up grid** is the home shape, and it is
deliberately out of proportion: 64px of art on a 74px tile is 86% of the
tile's width, overhanging its top edge by 26px. The founder's ask on
2026-09-03 was "can we make the icons on the home page more obvious", and
the answer is that the art has to be visibly *bigger than its box* — a
64px icon politely contained inside a 74px tile just looks like a 74px
tile. This only renders because nothing in the clay system sets
`overflow: hidden`; give the grid `pt-7` and `gap-y-7` or the first row
clips.

**`label="hidden"`** is the other half of that ask ("not write the names
on those cards, or otherwise make the words font smaller" — the app ships
the smaller-words option, this prop is the art-only one). It renders the
title as an `sr-only` span rather than dropping it, so the tile keeps a
real accessible name; only the pixels go. It is honoured on `top`
placement with an icon and ignored everywhere else, because a corner tile
with no visible text is an empty box with an icon bolted to one side.
**Never** omit `title` to get this shape — an icon-only button with no
accessible name is unusable with a screen reader. A `badge` still renders
under `hidden`; pair it with `badgePlacement="corner"`, the only
placement that makes sense with no text under the art.

The tile's `padding-block-start` under a stacked icon reserves the icon's
*visible* height plus an 8px gap, so the title can never collide with the
art. Those numbers are derived by `clayTileStackPadding()` and pinned to
the `.clay-tile-stack-*` CSS by `clay.test.ts` — change the ratio or the
size ladder and the test tells you the CSS has to move too.

**`badgePlacement="corner"`** pins the pill to the top inline-end corner
(the old QuickTile shape), ringed 2px in the tile's own `--clay-top` so it
stays legible over a floating icon. It *layers on* `.clay-tile-badge`
rather than replacing it, so it keeps the cream-card + ink-900 pairing.

**`selected`** is the app's one selection treatment: an **inset**
accent-500 ring, deliberately inset so it never gets confused with the
outset `:focus-visible` ring (same colour, same width) — selection is
state, focus is position, and a keyboard user has to be able to see both
at once. It also emits `aria-pressed` on a `<button>` and
`aria-current="page"` on a `<Link>`. Leave it **`undefined`** on a tile
that is not part of a selectable set: the component then emits neither
attribute, so a plain navigation tile is not announced as an unpressed
toggle.

```tsx
// src/components/Card3D.tsx  — TIER 2, informational
<Card3D
  tint="neutral"         // ClayTint, default 'neutral'
  as="div"               // 'div' (default) | 'section' | 'article' | 'li'
  padding="md"           // 'none' | 'sm' | 'md' (default) | 'lg'
  icon="trophy"          // optional floating corner icon
  style={{ animationDelay: '120ms' }}  // per-item inline style
>…</Card3D>
```

`padding="none"` is for a list container that supplies its own row
padding — the card contributes the surface and the radius only, so rows
can run edge to edge. It is the one case where `icon` does **not** add
the 64px gutter: a caller who asked for no padding owns the spacing.

`style` exists for one narrow reason — a per-item `animationDelay` on a
staggered list, which cannot be a class because the value is an index.
Do not reach for it to set colours or spacing; those are tokens.

**Floating icons on tier-2 cards are sanctioned.** What separates the
tiers is the *press, the focus ring, the shadow spread and the radius* —
the affordances — not the art. A card with a floating icon still cannot be
pressed and still reads as informational, so the boundary holds.
`.clay-card-icon` is a true alias of `.clay-tile-icon` (one rule, two
selectors), not a variant, so the two cannot drift.

```tsx
// src/components/Button.tsx
<Button variant="primary" depth>…</Button>
```
`depth?: boolean`, default `false`. Adds the ambient shadow + scale press
to `primary`, `secondary`, `danger`, `warning`; a no-op for `ghost` (a
coloured shadow under a transparent fill is a halo around nothing) and
`gradient` (it already paints its own pressed overlay via
`.btn-gradient`). With `depth` off the emitted class string is
byte-identical to what the component produced before the prop existed.
When `depth` is on, the Tailwind `active:scale` utilities are dropped —
Tailwind 4 sets the `scale` property while `.clay-depth` sets
`transform`, so leaving both on composes two scales into one tap.

```ts
// src/lib/clay.ts — pure, tested (src/lib/clay.test.ts)
CLAY_TINTS, CLAY_TINT_BY_DOMAIN, ClayTint, ClaySize
ClayTileIconSize (= ClaySize), ClayTileLabel ('below' | 'hidden')
CLAY_ICON_SIZES, CLAY_FLOAT_RATIO, CLAY_STACK_FLOAT_RATIO, CLAY_STACK_GAP
clayTintClass, clayIconPx, clayIconFloatOffset, clayIconClass
clayIconStackOffset, clayIconVisibleHeight, clayTileStackPadding
clayTileLayoutClasses, clayTileIconClass, clayBadgeClass, clayCardLayoutClasses
clayIconSrc, clayIconSrcSet
normalizeClayIconRegistry, resolveClayIcon
```
`normalizeClayIconRegistry` exists because
`src/lib/clayIcons.generated.ts` is written by the asset pipeline, not by
hand: it accepts a record of metadata, an array of names, a `Set`, or
`manifest.json`'s own `[{ name, width, height, … }]` shape, tolerates
both the `{w,h}` and `{width,height}` spellings, and **fails closed** (an
empty table, so nothing renders) on anything else.

### 10.7 Icon-pack gotchas

The CC0 pack (§11) was picked for its look, not its naming, and several
files are named for the slot they fill rather than for what the art
actually shows. **Choose by what the art shows, not by the filename** —
open `public/3d/<name>.webp` before you commit to it. Known mismatches:

| Name | What it actually renders |
|---|---|
| `handshake` | a **thumbs-up**, not two clasped hands |
| `bell` | a **megaphone** |
| `pot` | a **paint bucket** (still reads well for kameti — a pot everyone pays into) |
| `piggybank` | a **blue money bag**, not a pig |

None of these are wrong for their slot; they just aren't what the name
predicts, and a page agent picking blind by name will ship art that
contradicts its label. If you need a genuinely different subject, that is
a request to the asset pipeline (§11), not a rename.

### 10.8 Preview

`src/components/ClayShowcase.tsx` renders both tiers, all seven tints,
every icon size, three 4-up stacked rows (`sm` + label, `lg` + 11px
label, `lg` + hidden label), tile states and the Button `depth` row, with
an `html.dark` toggle. **It is not routed and not imported by anything**, so
Vite tree-shakes it out of the production bundle — it costs zero bytes
while still being typechecked and linted. Drop `<ClayShowcase />` into a
page temporarily to eyeball the system, then delete the line. Do not
route it, do not link to it, do not import it from a shipped file.

### 10.9 Do / don't

**Do**
- Pick the tier by behaviour, not by looks: tappable → `Tile3D`,
  read-only → `Card3D`.
- Pick the tint by domain (`CLAY_TINT_BY_DOMAIN` is the mapping: kameti →
  gold, splits → sky, khata → blush, savings → mint, spending → coral).
- Give a tile grid room above the first row (`pt-6`/`gap-y-6` for sm/md
  art, `pt-7`/`gap-y-7` for `lg`) — the floating icon overhangs the tile's
  top edge by 35–40% of its height, 26px at `lg`, and **will clip inside
  an `overflow-hidden` container**.
- Let the art be the bold thing on a dense grid: `iconSize="lg"` with an
  11px caption. One bold element per screen region, and on the home grid
  it is the icons.
- Keep subtitles at `ink-600` or darker (§10.3).
- Pass copy in as props. `Tile3D`/`Card3D` hold no strings of their own,
  so the i18n ratchet is satisfied at the call site with `t('key')`.

**Don't**
- **Don't reintroduce a lip, a `border`, or an outset ring** on any clay
  surface. §10.0 is the whole story; the founder can see it from across
  the room and it costs trust. More separation = more shadow spread or a
  different radius, never a drawn line.
- Don't drop `title` to get an icon-only tile. Use `label="hidden"`,
  which keeps the accessible name.
- Don't add a hover transform, a hover lift, or a glow. The press is the
  only motion in this system, and it is what makes the press feel like
  something. Adding a second motion makes both feel like nothing.
- Don't put `.clay-tile` on a `<div>` with an `onClick`. Use the
  component; it renders a real `<button>` or `<Link>`.
- Don't hand-roll a selection ring. Use `selected` — that prop exists
  because four call sites had already started drifting apart.
- Don't pass `selected={false}` to a tile that isn't selectable; leave it
  undefined so no `aria-pressed` is emitted (§10.6).
- Don't pick an icon by its filename. Open the art first (§10.7).
- Don't give `.clay-card` a press or a focus ring to "make it feel
  alive". That is precisely the tier confusion the radius gap exists to
  prevent.
- Don't animate `box-shadow` — including on entrance. See §10.5.
- Don't use `--clay-*-strong` as a text background; it is an icon/dot
  colour and does not clear AA for white text on every tint.
- Don't hardcode `/3d/foo.webp` in a page. Go through `Icon3D`, which is
  what guarantees a missing asset degrades to nothing instead of a broken
  image.
- Don't invent an eighth tint. Seven is already two more than the brief;
  another one means another dark ramp, another contrast row, and another
  thing to keep honest.

## 11. 3D icon assets

Glossy "clay/color" 3D icons for buttons/cards (coins, receipt, chat
bubble, wallet, etc. — inspired by, but never copied from, JazzCash's
committee page) live in `public/3d/`. Source: **3dicons** by Vijay Verma
(https://3dicons.co, https://github.com/realvjy/3dicons), `color` style,
`dynamic` camera angle, **CC0-1.0** — verbatim license text and provenance
in `public/3d/LICENSE.md`, per-icon source (incl. a `style` field) in
`public/3d/manifest.json`.

- **Files**: `public/3d/<name>.webp` (160×160, 1x) and
  `public/3d/<name>@2x.webp` (320×320, 2x), transparent background,
  quality 82, no metadata. Same-origin static assets — no CSP change
  needed (`img-src 'self'` already covers `public/`).
- **Contract**: `src/lib/clayIcons.generated.ts` exports
  `CLAY_ICONS: Record<name, {w, h}>` and `type ClayIconName`. This file
  is **generated** — don't hand-edit it.
- **Budget**: ≤25 KB per 1x file, ≤60 KB per 2x file. All 29 current
  icons land well under that (largest is `piggybank@2x.webp` at 16.8 KB).
- **The set** (29 icons). Our `<name>` is a *role* name, the slug is the
  upstream 3dicons file — they often differ, so check this table before
  assuming the art matches the name. **Pick by the "art" column, never by
  the role name**: four entries below lie (`bell` is a megaphone,
  `handshake` a thumbs-up, `pot` a paint bucket, `piggybank` a money bag),
  and a founder review in 2026-09 found every one of them mis-used on a
  live surface. There is **no multi-person asset** in the pack —
  `person`/`person2` are both single figures, and the `people` role name
  (a duplicate of `person`'s art) was deleted for exactly that reason.
  Group surfaces use `chat` (two overlapping speech bubbles) instead:

  | name | 3dicons slug | art |
  |---|---|---|
  | `alarm` | `clock` | the pack's **alarm clock** (twin bells), not a wall/wrist clock |
  | `bag` | `bag` | **shopping bag** with handles |
  | `bell` | `megaphone` | megaphone — used for announcements/alerts |
  | `calculator` | `calculator` | calculator, red/black keypad |
  | `calendar` | `calender` | calendar (upstream slug is misspelled) |
  | `card` | `card` | payment card |
  | `chart` | `chart` | bar chart |
  | `chat` | `chat-bubble` | chat bubble |
  | `coins` | `3d-coin` | coin stack |
  | `cup` | `tea-cup` | tea cup |
  | `gift` | `gift` | wrapped gift box |
  | `handshake` | `thumb-up` | thumbs-up (no handshake exists in the pack) |
  | `key` | `key` | key |
  | `link` | `link` | chain link |
  | `lock` | `lock` | padlock |
  | `money` | `money` | **banknote stack** (not coins — use `coins` for those) |
  | `person` | `boy` | **one** person bust |
  | `person2` | `girl` | a second, visually distinct **single** figure; pairs with `person` for two-party UI |
  | `phone` | `mobile` | mobile phone |
  | `piggybank` | `money-bag` | money bag |
  | `plus` | `plus` | plus sign |
  | `pot` | `bucket` | bucket — the kameti/pot slot |
  | `receipt` | `file-text` | text document |
  | `shield` | `sheild` | shield (upstream slug is misspelled) |
  | `sparkle` | `star` | star |
  | `target` | `target` | dartboard + dart |
  | `tick` | `tick` | check mark |
  | `trophy` | `trophy` | trophy |
  | `wallet` | `wallet` | wallet |

- **Style variants**: `color` is the default/shipped style
  (`npm run build:3d`, no flag). A `gradient` variant also exists as
  source (`assets-src/3d-icons/gradient/`) and can be built on request
  with `npm run build:3d -- --style=gradient`, which writes to
  `public/3d/gradient/` + `public/3d/gradient/manifest.json` without
  touching the default `color` output or `clayIcons.generated.ts` — it is
  **not** generated by default.
- **Adding an icon**:
  1. Find a same-style (`color`, `dynamic` angle) source PNG — either
     from 3dicons.co's picker or its CDN, e.g.
     `https://3dicons.sgp1.cdn.digitaloceanspaces.com/v1/dynamic/color/<slug>-dynamic-color.png`
     (slug list: `content/3dicons-meta/*.md` in the `develop` branch of
     `realvjy/3dicons`), or another **verified CC0** source — never an
     asset traced/copied from JazzCash or any other product's UI.
  2. Save it as `assets-src/3d-icons/<name>.png` — deliberately **outside**
     `public/` (Vite copies `public/` verbatim into `dist/`, so raw
     multi-hundred-KB originals must never live there or they'd ship to
     both web and Android). This directory is gitignored; only the built
     WebP output is committed.
  3. Run `npm run build:3d` (`scripts/build-3d-icons.mjs`, uses `sharp`).
     It's idempotent: it rebuilds every `assets-src/3d-icons/*.png` into
     `public/3d/<name>.webp` + `@2x.webp`, rewrites
     `public/3d/manifest.json` and regenerates
     `src/lib/clayIcons.generated.ts`, and prints a size table flagging
     anything over budget.
  4. Add the new `source`/`license` line for the icon in the script's
     `SLUG_MAP` if it came from 3dicons.co, so the manifest keeps
     accurate provenance.
- **Never** substitute a non-CC0/non-permissively-licensed asset (e.g.
  paid Iconscout packs) to fill a gap — leave the icon out and note the
  gap instead.
