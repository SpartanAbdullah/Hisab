# Performance — bundle splitting & font self-hosting (P2 M2a)

Scope: this document covers **part (a)** of P2 item M2 only — vendor chunk
splitting, a bundle-size budget check, and self-hosting the Geist font.
Source evidence: `docs/audit-2026-09/03-performance.md` H1 ("1.15 MB
monolithic entry bundle") and the Quick wins list, plus
`docs/audit-2026-09/07-mobile-first.md` MF-14/MF-15 (cold start on low-end
Android over 3G; render-blocking Google Fonts).

Files touched: `vite.config.ts`, `index.html` (font `<link>` tags + CSP
`font-src`/`style-src` only), `public/fonts/geist-latin-variable.woff2`
(new), `src/index.css` (new `@font-face` block at the top only —
`@theme` token values below it are owned by a different concurrent agent
and were not touched), `scripts/check-bundle-size.mjs` (new).

Everything below was measured 2026-09-02 against this repo's actual working
tree (which has many other concurrent P0/P1/P2 changes in flight — `tsc -b`
currently fails on an unrelated in-progress file, `src/pages/InsightDetailPage.tsx`,
owned by another agent). All builds here ran `npx vite build` directly
(bypassing `tsc -b`) to isolate the bundler-level change from that unrelated,
in-progress TypeScript error. Once the other agent's change lands, `npm run
build` (`tsc -b && vite build`) should be re-run once to confirm both parts
pass together — that recheck was not possible from this task's isolated
scope.

---

## 1. Vendor chunk splitting (vite.config.ts)

### Before

Stock `vite.config.ts` (7 lines, `react()` + `tailwindcss()` plugins only, no
`build` config at all). One `npx vite build`:

```
dist/assets/index-3gkBkGeS.js   1,269.59 kB   │ gzip: 367.49 kB   <- entry, everything
```

Everything — React, react-router-dom, @supabase/supabase-js, dexie, zustand,
~20 stores, the full bilingual i18n table, @sentry/browser, and the three
eagerly-mounted app-level components (QuickEntry, AddGroupExpenseModal,
CreateGroupModal, MonthlyWrapModal — see §3) — landed in one chunk. No
`modulepreload` hints were emitted at all (nothing to hint at: one chunk).
Already-lazy async chunks existed independently of this (route-level
`lazy()` in `src/App.tsx`, and a few libraries dynamic-imported from
`src/lib`) — see §3 for which ones and why they didn't help the entry chunk.

### After

`build.rollupOptions.output.manualChunks` groups vendor code from
`node_modules` into named, stable chunks; `build.modulePreload.resolveDependencies`
stops a handful of them from being eagerly preloaded (see §2).

```
dist/assets/index-CQ9DXDTN.js          281.76 kB   │ gzip:  81.37 kB   <- entry
dist/assets/vendor-react-DP0FINvc.js   224.76 kB   │ gzip:  72.09 kB
dist/assets/vendor-supabase-...        183.84 kB   │ gzip:  47.72 kB
dist/assets/vendor-dexie-...            93.82 kB   │ gzip:  30.85 kB
dist/assets/vendor-lucide-...           36.75 kB   │ gzip:  12.73 kB
dist/assets/vendor-date-fns-...         21.29 kB   │ gzip:   6.08 kB
dist/assets/vendor-recharts-...        353.14 kB   │ gzip: 103.14 kB   (async — AnalyticsPage only)
dist/assets/vendor-jspdf-...           401.07 kB   │ gzip: 130.47 kB   (async — statement/receipt PDFs only)
dist/assets/vendor-modern-screenshot-  24.22 kB   │ gzip:   9.51 kB   (async — same PDF/image-card paths)
dist/assets/vendor-qr-...              150.59 kB   │ gzip:  54.80 kB   (async — QR scan/generate only)
```

**Entry chunk: 1,269.59 kB → 281.76 kB raw (−78%), 367.49 kB → 81.37 kB gzip
(−78%).** This is the number that gates first paint / time-to-interactive on
every cold boot, PWA or bundled-in-the-APK Android — H1's headline number.

The rest of the app's code (react, supabase-js, dexie, all the stores,
route pages) didn't get smaller — it's the same code — it got **regrouped**.
The wins:
- The entry chunk itself shrank because supabaseDb.ts, i18n.ts/Sentry
  (`module-*.js`, see §3), and transactionStore.ts turned out to already be
  reachable via *both* a static import and a dynamic `import()` somewhere in
  the app (Vite's own `INEFFECTIVE_DYNAMIC_IMPORT` build warnings list
  these). Once `manualChunks` gave the bundler vendor groupings to work
  with, its automatic shared-chunk splitting for these dual-reachable
  modules kicked in too and pulled them out of the entry chunk into their
  own chunks — that's a side effect of this change, not something the
  `manualChunks` function explicitly requested (it only names
  `node_modules` packages; app code placement was untouched).
- `vendor-react`, `vendor-supabase`, `vendor-dexie`, `vendor-lucide`,
  `vendor-date-fns` are now named, stable chunks: a change to app code no
  longer busts their cache, and a Vercel deploy only re-downloads what
  actually changed instead of the whole 1.2 MB (see the audit's H1
  citation of `vercel.json`'s immutable asset caching).
- `vendor-recharts`, `vendor-jspdf`, `vendor-modern-screenshot`, `vendor-qr`
  now have stable, discoverable names instead of Rollup's auto-generated
  per-entry chunk names (`jspdf.es.min-*`, `jsQR-*`) — same async-only
  loading behavior as before (see §3), just named consistently and no
  longer duplicated across multiple lazy-loading call sites.

`build.chunkSizeWarningLimit` is set to **450 kB** (default is 500 kB). After
the split, every chunk in the build already falls under the stock 500 kB
default (`vendor-jspdf` at 401.07 kB is the largest of all chunks, and it's
a lazy one). Rather than leave the 500 kB default as an accident, it's set
here deliberately to 450 kB: ~12% above today's largest chunk — enough
headroom for routine growth, tight enough to fail the build's warning the
moment a genuinely new heavy dependency lands uncontrolled. See the comment
above `chunkSizeWarningLimit` in `vite.config.ts` for the full reasoning.

`posthog-js` was deliberately **left out** of `manualChunks` — it's reached
only via `await import('posthog-js')` behind a consent/DSN gate in
`src/lib/telemetry.ts`, and Rollup already code-splits it into its own async
chunk on its own. Naming it in `manualChunks` risks changing *when* that
chunk gets fetched; per the task spec ("do not break that") it was left to
the bundler's default per-dynamic-import chunking.

---

## 2. The `vendor-jspdf` modulepreload regression (and the fix)

Grouping `jspdf` into a named `vendor-jspdf` chunk had a side effect worth
recording: the bundler's default preload-hint analysis started emitting
`<link rel="modulepreload" href="/assets/vendor-jspdf-*.js">` into
`index.html`, even though `jspdf` is *only* ever reached via `await
import('jspdf')` inside `src/lib/renderNodeToImage.ts` (used by the
statement PDF / group settle-up PDF / kameti slip / Wrapped card
generators). Confirmed by rebuilding with the stock, pre-`manualChunks`
config: no `modulepreload` links were emitted at all in that build (single
chunk, nothing to hint at) — so this was specifically introduced by naming
the chunk, not a pre-existing behavior.

If left in place, every cold boot would have fetched+parsed a ~400 kB / 130
kB gzip chunk that most sessions never need — directly working against the
point of splitting it out.

Fix: `build.modulePreload.resolveDependencies` in `vite.config.ts` filters
the HTML-entry preload-dependency list, excluding `vendor-jspdf`,
`vendor-recharts`, `vendor-modern-screenshot`, `vendor-qr`, and
`html2canvas` by name. Verified by rebuilding and re-diffing
`dist/index.html`'s `<link rel="modulepreload">` list — `vendor-jspdf` no
longer appears; the legitimately-eager chunks (`vendor-react`,
`vendor-supabase`, `vendor-dexie`, `vendor-lucide`, `vendor-date-fns`,
`supabaseDb`, `transactionStore`, `splitStore`, `notificationScheduler`,
etc. — i.e. the actual eager-import graph reachable from `App.tsx`) still
do, unchanged in size.

`html2canvas` (194.90 kB raw / 45.26 kB gzip) is a separate chunk that
appears in the build independent of this task's manual grouping — it isn't
a direct dependency in `package.json`; it's pulled in transitively (likely
by `jspdf`'s optional SVG/image support). It was added to the
never-preload list defensively since it rides along the same PDF-generation
path and has no reason to be fetched at boot.

---

## 3. Heavy-lib eager-import audit (recharts / jspdf / modern-screenshot / jsqr)

Per the task spec, this was checked by grep, and — **no source changes were
made**, since `src/**` (other than the `index.css` `@font-face` block) is
out of scope for this task:

| Library | Where it's imported | Eager or lazy? |
|---|---|---|
| `recharts` | `src/pages/AnalyticsPage.tsx` only (static `import`) | **Lazy.** `AnalyticsPage` is `lazy()`-loaded in `src/App.tsx:64`. Confirmed: it ships as its own async chunk (`vendor-recharts` after this change; `AnalyticsPage-*.js` inlined before it), never touches the entry. |
| `jspdf` | `src/lib/renderNodeToImage.ts:82`, dynamic `await import('jspdf')` only — no static import anywhere in `src/` (grep confirmed) | **Lazy**, and already was before this task (the pre-existing code already dynamic-imports it). See §2 for the modulepreload wrinkle this task found and fixed. |
| `modern-screenshot` | `src/lib/renderNodeToImage.ts:39`, dynamic `await import('modern-screenshot')` only | **Lazy**, same as jspdf. |
| `jsqr` | `src/components/QRScanner.tsx:156`, dynamic `import('jsqr')` only | **Lazy.** `QRScanner` itself is imported (statically) only from `ContactsPage.tsx` and `ContactDetailSheet.tsx`, both reached only through the `lazy()`-loaded `ContactsPage` route. |
| `qrcode-generator` | `src/lib/qrMatrix.ts`, static import | Used by whatever imports `qrMatrix.ts` (QR *generation*, not scanning) — not separately audited for eager/lazy reachability in this pass; grouped into the same `vendor-qr` chunk as `jsqr` for a stable name. |

**One eager-reachability fact worth flagging (report-only, not fixed, since
it's inside `src/` and out of scope):** `MonthlyWrapModal` is statically
imported in `src/App.tsx` (line 92 in the version read during this task) —
i.e. it is *not* behind `lazy()`, unlike every route page. It imports
`src/lib/wrapCard.ts` → `src/lib/renderNodeToImage.ts` — the same shared
module that dynamic-imports both `jspdf` and `modern-screenshot`. Because
`renderNodeToImage.ts` is reached statically through this chain, the
bundler's preload analysis treated `jspdf` (though not `modern-screenshot`,
for reasons not fully explained by static analysis alone — possibly a
chunk-size or reachability-count heuristic specific to this Vite/Rolldown
build) as eagerly-preloadable, which is what caused the §2 issue. The
`resolveDependencies` filter in `vite.config.ts` neutralizes the symptom
(no more eager fetch) regardless of this deeper cause, but the underlying
fact — `MonthlyWrapModal` is eagerly mounted alongside `QuickEntry`,
`AddGroupExpenseModal`, `CreateGroupModal` (all confirmed eager via grep of
`src/App.tsx`'s non-`lazy()` imports) — is exactly what H1 already flagged
("three app-level modals" — MonthlyWrapModal is a fourth). Lazy-mounting
these behind their open/trigger conditions is explicitly called out as a
remaining item in §5; it is **not** done here (it's a `src/App.tsx` change,
out of this task's scope).

---

## 4. Font: Geist self-hosted

### Before

`index.html` loaded Geist from Google Fonts:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" />
```
This is a render-blocking, cross-origin stylesheet fetch on every load — MF-15
confirmed this blocks first paint even inside the **bundled Android app**
(the same `dist/index.html` ships in the Capacitor WebView via `webDir:
'dist'`), where it's easy to assume "local build = no network dependency."
It was also two extra allowed hosts in the CSP (`style-src`, `font-src`).

### What was downloaded

The weights actually used by the app are 400/500/600/700 (grepped
`src/index.css` — `.theme`/base styles set `font-family: 'Geist', ...` with
no other explicit `font-family` override found for it, and the app's
`font-normal`/`font-medium`/`font-semibold`/`font-bold` Tailwind utility
usage maps to those four numeric weights). Fetching Google's own
`css2?family=Geist:wght@400;500;600;700` response revealed **all four
requested weights resolve to the exact same underlying file**
(`gyByhwUxId8gMEwcGFU.woff2`, Latin subset) — Geist is shipped as a single
variable-font file covering the full weight axis, and Google's static CSS
API just emits one `@font-face` block per requested weight, all pointing at
that one file. So: **one file, not four**, downloads all the weights this
app uses.

Downloaded and committed:
```
public/fonts/geist-latin-variable.woff2   29,400 bytes (29.4 kB)
```
(Verified as a real, valid woff2 file — magic bytes `wOF2` — not a
placeholder. Source: `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwcGFU.woff2`,
fetched 2026-09-02 via Google's `css2` API response for
`family=Geist:wght@400;500;600;700`. If Geist is ever version-bumped,
re-fetch that URL — Google's font versioning means the hash in the path
will change with any update to the family.)

### After

`src/index.css` — new `@font-face` block at the top of the file (above the
pre-existing `@theme` block, which a different concurrent agent owns):
```css
@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/geist-latin-variable.woff2') format('woff2-variations'),
       url('/fonts/geist-latin-variable.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
```
`font-weight: 100 900` (a range, not a fixed value) is correct for a single
variable-font file — browsers pick the right instance along the axis for
whatever weight is requested, so this one `@font-face` rule serves
400/500/600/700 without four separate declarations. `unicode-range` is
copied verbatim from Google's own "latin" subset split for Geist. The
existing `--font-sukoon` token (elsewhere in `src/index.css`, owned by
another agent) already lists a full system fallback stack
(`"Geist", "Inter", -apple-system, BlinkMacSystemFont, system-ui,
sans-serif`) — untouched, and it means text is never blocked on this file:
`font-display: swap` plus that fallback chain guarantees visible text
immediately, Geist swaps in once the 29.4 kB file lands. Note: that
token's own comment still says "Loaded via Google Fonts in index.html" —
now stale, but it's in the other agent's owned region of the file and was
left untouched per the task's file-ownership boundary; worth a one-line
fix by whoever next touches that block.

`index.html`:
```html
<link rel="preload" href="/fonts/geist-latin-variable.woff2" as="font" type="font/woff2" crossorigin />
```
replaces the two `preconnect` tags and the Google stylesheet `<link>` —
one same-origin file, no third-party round trip, no render-blocking
stylesheet fetch (a preloaded font doesn't block first paint the way a
blocking stylesheet request does).

Verified: `npx vite build` copies `public/fonts/geist-latin-variable.woff2`
into `dist/fonts/geist-latin-variable.woff2` unchanged (Vite's default
`public/` passthrough), and `dist/index.html` carries the new preload link.

### CSP diff

```diff
- style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
+ style-src 'self' 'unsafe-inline';

- font-src 'self' https://fonts.gstatic.com data:;
+ font-src 'self' data:;
```
`fonts.googleapis.com` and `fonts.gstatic.com` are fully removed from the
CSP — the app no longer talks to either host for anything. Nothing else in
the CSP changed (per the task note, the `connect-src` block another agent
[H2] had just edited was left untouched — confirmed by re-reading
`index.html` immediately before each edit).

**Outcome: downloaded, not a placeholder.** If a future environment can't
reach `fonts.gstatic.com` to re-fetch (e.g. a version bump), the fallback
plan is documented above (exact source URL + the fact that all four weights
share one file) so it's a single `curl` away, not a research task.

---

## 5. Verification run

```
npx vite build            # succeeds; see §1/§2 for output
node scripts/check-bundle-size.mjs
```
```
Entry chunk: index-CAElBewp.js
  raw:  275.15 kB
  gzip: 78.81 kB  (budget: 90.00 kB)

[check-bundle-size] OK — entry chunk within budget.
```
(The script's own gzip computation — Node's `zlib.gzipSync` at level 9 —
comes in a little lower than Vite's build-time reporter, ~79 kB vs ~81 kB;
both are well inside the budget. Exit code 0.)

`npx tsc -b --noEmit` was checked for `vite.config.ts` specifically (not the
whole repo — see the note at the top of this document about the unrelated,
in-progress `InsightDetailPage.tsx` TypeScript error from a concurrent
agent): clean, no errors attributable to `vite.config.ts`.

`scripts/check-bundle-size.mjs` is **not** wired into `package.json` or CI
in this change — both files are owned by other agents in this batch. The
lead should add:
```jsonc
// package.json, "scripts"
"check:bundle": "node scripts/check-bundle-size.mjs"
```
and, in `.github/workflows/ci.yml`, a step running `npm run check:bundle`
immediately after the existing production build step (so it has a
`dist/assets/` to read).

---

## 6. Remaining M2 items — not done in this task (M2a scope only)

These were listed in the M2 task family but are explicitly out of this
task's scope (M2a = `vite.config.ts` / `index.html` font+CSP / new
`public/fonts/` / new `scripts/check-bundle-size.mjs` / this file only):

- **Sentry dynamic import.** `@sentry/browser` (`module-*.js` in the chunk
  table above, ~262-268 kB raw / ~86-89 kB gzip depending on build) is
  statically imported in `src/main.tsx` / owned by `src/lib/sentryReporter.ts`,
  gated only by a runtime DSN check, not a lazy `import()`. It currently
  ships in every build regardless of whether `VITE_SENTRY_DSN` is set —
  audit H1's fix #13 ("Dynamic-import Sentry behind the DSN check"). Owned
  elsewhere (`sentryReporter.ts` is `src/**`, off-limits here). It is
  **not** part of the entry chunk any more post-split (it landed in its own
  chunk per §1's explanation of the dual-reachability side effect), so its
  fetch no longer blocks the entry chunk's own parse — but it's still an
  eager network+parse cost worth fixing at the source.
- **Transactions list virtualization** (H3: unbounded `transactions.getAll`,
  no pagination, no windowing in `TransactionsPage.tsx`). Pure `src/**`
  application logic — out of scope here.
- **SQL-side analytics aggregates** (H3: `AnalyticsPage.tsx` sums the full
  transaction array client-side). Needs a Postgres RPC — SQL migrations and
  `src/**` both out of scope for this task.
- **Broadcast realtime** (H5: postgres_changes on high-churn tables, no
  Supabase Broadcast fallback). SQL + `src/lib/realtime.ts`, out of scope.
- **Boot-load dedupe** (M2 in the audit itself: ~25-30 REST round-trips at
  boot, profile fetched 3×, committees loaded 2×, no app-mode gate). Pure
  `src/**` store/boot-effect logic (`App.tsx`, `supabaseAuthStore.ts`,
  `onboardingStore.ts`, `committeeStore.ts`) — out of scope here; this task
  only reduced what has to be *downloaded and parsed* before that boot
  sequence can start running, not how many requests the sequence itself
  makes once it does.

None of the above were touched, edited, or worked around by this task —
they're recorded here purely as pointers for whichever task picks up the
rest of M2.
