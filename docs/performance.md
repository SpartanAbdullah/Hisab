# Performance — P2 item M2

Scope: **§1-§5 = part (a)** — vendor chunk splitting, a bundle-size budget
check, and self-hosting the Geist font. **§6.1-§6.4 = part (b)** — the lazy
Sentry SDK, Realtime Broadcast for the money tables, and the boot-load dedupe.
**§6.5 = part (c)** — the lazy app-level modals and the first SQL-side analytics
aggregate. **§6.6 = part (d)** — TransactionsPage windowing + the recent-window
default, the two remaining analytics RPCs (Analytics stops fetching the full
history), and the `monthlyTrend` bucket-end fix.
**§7** is what is still open across the whole M2 family.

Part (a) below is written as it was at the time; where it says "out of scope,
owned elsewhere", §6 is the task that picked it up.
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

## 6. M2(b) — Sentry lazy-load, Broadcast realtime, boot-load dedupe

Landed 2026-09-02 in a second pass over the same M2 family. §1-§5 above are
M2(a) (bundle splitting + font self-hosting) and are unchanged.

Files touched by M2(b): `src/lib/errorReporter.ts`, `src/lib/sentryReporter.ts`,
`src/main.tsx`, `src/lib/realtime.ts`, `src/lib/profileCache.ts` (new),
`src/App.tsx` (boot effects only), `src/stores/supabaseAuthStore.ts`,
`src/stores/onboardingStore.ts`, `src/stores/committeeStore.ts`,
`src/stores/transactionStore.ts` (`ensureSupportingStoresLoaded` only),
`supabase-migration-p2-realtime-broadcast.sql` (new), plus
`src/lib/errorReporter.test.ts` and `src/lib/profileCache.test.ts` (new).

### 6.1 Sentry is no longer in the eager graph (H1 / quick win #13)

`@sentry/browser` was reached through a static `import * as Sentry` in
`sentryReporter.ts`, which `main.tsx` imports at module scope. The DSN check
gated `init()`, not the download. It is now:

* `sentryReporter.ts` type-imports the SDK (`import type * as SentryNs`,
  erased at compile time) and does the real import inside
  `loadSentryReporter()` as `await import('@sentry/browser')`;
* `main.tsx` checks `import.meta.env.VITE_SENTRY_DSN` — statically replaced
  at build time, so a **build with no DSN never reaches the `import()` and
  never fetches the chunk** — and, when there is one, schedules the load in
  the first `requestIdleCallback` slot after first paint (`setTimeout(…, 0)`
  fallback on browsers without it, i.e. Safari).

Measured with `npx vite build` + `node scripts/check-bundle-size.mjs` on this
working tree (2026-09-02, `.env` carrying a DSN so the loading path is live):

| | entry chunk raw | entry chunk gzip | Sentry SDK |
|---|---|---|---|
| Before (static import) | 275.26 kB | **78.86 kB** | inside the entry chunk |
| After (lazy, destructured) | 193.52 kB | **51.58 kB** | `prod-*.js`, 80.98 kB raw / 27.26 kB gzip, async |

**−81.74 kB raw / −27.28 kB gzip off the entry chunk (−34.6%)**, and the SDK
chunk is *not* in `dist/index.html`'s `modulepreload` list, so it is not
fetched during boot at all. Total bundle bytes are unchanged (3,627.36 →
3,629.97 kB raw; 1,079.02 → 1,079.92 kB gzip) — nothing was duplicated.

> **Do not turn the destructuring back into a namespace import.** The first
> attempt used `const Sentry = await import('@sentry/browser')`. A namespace
> binding keeps every export reachable, so the lazy chunk came out at
> **430.90 kB raw / 140.20 kB gzip** — the entry chunk still shrank, but the
> app grew by ~350 kB of dead SDK. Destructuring the four functions actually
> used (`init`, `withScope`, `captureException`, `captureMessage`) restores
> the tree-shaking the old static import had: 80.98 kB.

**No error is lost in the new window.** `reportError`/`reportMessage` keep
their synchronous signature; `errorReporter.ts` gained a deferred-reporter
seam (`beginDeferredReporter` / `resolveDeferredReporter`). Between module
evaluation and the idle callback resolving, events are buffered in a queue
bounded at **50, dropping the OLDEST** (the newest describe the state the app
ended up in), and the number dropped rides on the first replayed event as
`extra.droppedWhilePending` so the loss is visible in Sentry. The H1 de-dupe
runs **before** queueing, so a boot-time retry loop contributes one entry, not
fifty. A failed chunk fetch resolves the queue against the noop reporter
rather than buffering forever. Covered by `src/lib/errorReporter.test.ts`
(11 cases); `mutationSafety.test.ts`'s reporter assertions are unchanged and
still green.

### 6.2 Realtime Broadcast for the money tables (H5 / F-SC1)

`accounts`, `transactions` and `loans` were the three `postgres_changes`
bindings on the highest-churn tables — one expense entry writes two of them,
and postgres_changes runs an RLS check per subscriber per WAL change on a
single-threaded service. They now have a Broadcast path:

* **Server** — `supabase-migration-p2-realtime-broadcast.sql` adds nine
  `AFTER … FOR EACH STATEMENT` triggers (three events × three tables;
  PostgreSQL forbids transition tables on a multi-event trigger) calling
  `realtime.send(payload, event, topic, private)` once **per affected user per
  statement**. Topic `user:<uid>`, event = the table name, payload
  `{table, op, rows}` — no money, names or ids. A batch write (the
  consolidated-repayment loop) therefore costs one message, where
  postgres_changes charged per row.
* **RLS** — one SELECT policy on `realtime.messages`:
  `extension = 'broadcast' AND realtime.topic() = 'user:' || (select auth.uid())::text`.
  No INSERT policy is added, so only the database can write a user topic; a
  client cannot forge "your balance changed" into someone else's.
* **Client** — `src/lib/realtime.ts` subscribes to
  `supabase.channel('user:<uid>', { config: { private: true } })` after
  `supabase.realtime.setAuth()`, with the *same* handler as before
  (`markMirrorStale` → debounced store reload, factored into
  `onMoneyTableChanged` so both transports are provably identical).
* **Cross-user tables are untouched.** `notifications`, `group_members` and
  the three request tables stay on `postgres_changes`: low churn, written by
  the *other* user, and their per-change RLS check is what makes delivery
  correct.

**Both app modes:** ledger-only users own no `accounts` rows, so the trigger
never fires for them and the `accounts` event simply never arrives — there is
no mode branch in the client and nothing to break. `transactions` and `loans`
exist in both modes and behave identically.

### 6.3 Boot-load dedupe (audit M2)

* **The `profiles` row was read 3-4× per cold boot** — `isDeletedProfile` in
  `supabaseAuthStore.initialize`, again from the `INITIAL_SESSION` auth event,
  `profilesDb.getCurrent()` in `onboardingStore.checkOnboarding`, and
  `getProfile()` in App's hydration effect. New `src/lib/profileCache.ts`
  shares one in-flight promise plus a 15 s memo keyed by user id; it queries
  by **explicit** user id (not `localStorage.hisaab_supabase_uid`, which is
  not yet written when the deleted-account gate runs). Invalidated on every
  profile write, on sign-out and on user change. `SettingsPage`,
  `MyConnectCode` and `PhoneDiscoverySection` still call `profilesDb.getCurrent()`
  directly and are unaffected.
* **`TOKEN_REFRESHED` no longer runs the deleted-account gate** (quick win
  #9) — that was one `profiles` read per session per hour, fleet-wide, on an
  event that cannot change `is_deleted`.
* **Committees loaded twice** (App boot + HomePage mount, 3 queries each).
  `committeeStore.loadAll` now shares an in-flight promise and skips inside a
  60 s window; `runBallot`'s ALREADY_DRAWN resync passes `{ force: true }`, and
  `reset()` clears the gate so a user switch always re-fetches.
* **Mode-gated boot loads** (quick win #8). The boot effect is split in two:
  a mode-independent one (`[user?.id]`: persons, the three request inboxes,
  notifications, groups, custom categories, committees) and a full-tracker-only
  one (`[user?.id, mode]`: accounts, budgets, recurring templates + the
  expansion runner). Categories stay in both modes — group expenses are
  categorised in `splits_only` too. Reminder rescheduling is called in both
  branches (loans, kameti and upcoming expenses all generate reminders in
  ledger mode), just no longer chained off `loadTemplates()`.
* **`ensureSupportingStoresLoaded` is parallel** (M11 / quick win #4): four
  independent, conditional store loads that were awaited one after another —
  up to four serial round-trips in front of the first save after boot.

**Boot request counts** (derived from code: App-level gates + the App boot
effect + HomePage's duplicate committee load; excludes HomePage's own
transactions/loans/goals/EMI/investments loads, which are unchanged):

| | full_tracker before | full_tracker after | splits_only before | splits_only after |
|---|---|---|---|---|
| `profiles` reads | 4 | **1** | 4 | **1** |
| `accounts.count` (onboarding gate) | 1 | 1 | 1 | 1 |
| `app_config` (version gate) | 1 | 1 | 1 | 1 |
| persons / 3 request tables / notifications | 5 | 5 | 5 | 5 |
| groups (`loadGroups`) | 3-4 | 3-4 | 3-4 | 3-4 |
| custom categories | 1 | 1 | 1 | 1 |
| committees (App) | 3 | 3 | 3 | 3 |
| committees (HomePage, duplicate) | 3 | **0** | 3 | **0** |
| accounts (mirror) | 1-2 | 1-2 | 1-2 | **0** |
| budgets (mirror) | 1-2 | 1-2 | 1-2 | **0** |
| recurring templates | 1 | 1 | 1 | **0** |
| **total** | **24-27** | **18-21** | **24-27** | **15-16** |

So: **−6 requests per boot in full_tracker** (3 profile reads, 3 duplicate
committee queries) and **−9 to −11 in splits_only**, plus one `profiles` read
per hour per open session removed everywhere. Nothing full_tracker loads was
removed — the mode gate only skips stores whose routes `splits_only` redirects
away from.

Two honest caveats:

1. On **Android with reminders opted in**, `notificationScheduler.ensureLoaded()`
   lazily loads any empty store it needs — including accounts and recurring —
   so a `splits_only` device with reminders on pays some of those back at
   reschedule time. That file is owned elsewhere and was not touched.
2. A `splits_only` user on a **fresh device** (no `hisaab_app_mode` in
   localStorage) starts at the `full_tracker` default, so the full-tracker
   effect runs once before the profile flips the mode — same request count as
   today, never worse. Every subsequent boot is gated.

### 6.4 The two flags and how to roll this out

| Flag | Default | What it does |
|---|---|---|
| `VITE_SENTRY_DSN` | set in prod, empty locally | Unchanged meaning, new consequence: **empty ⇒ the Sentry chunk is never fetched or parsed**, not merely not initialised. |
| `VITE_REALTIME_BROADCAST` | unset (**off**) | `'true'` ⇒ money-table events ride the private Broadcast topic and the three `postgres_changes` bindings are not registered. Anything else ⇒ today's behaviour, unchanged. |

Rollout order for Broadcast (the migration header carries the same list plus
verification SQL):

1. Apply `supabase-migration-p2-realtime-broadcast.sql`. It is **safe ahead of
   the client**: with the flag off, broadcasts are written and nobody
   subscribes. Run its §6 checks — especially **V1** (`realtime.send` present)
   and **V6** (a real broadcast row appears after saving a test expense).
2. Ship a build with `VITE_REALTIME_BROADCAST=true` to web.
3. Ship the Android AAB with the same flag (per the repo's both-surfaces rule)
   and wait for the Play rollout — the binary lags the web deploy.
4. Only then run §5 of the migration (`ALTER PUBLICATION supabase_realtime DROP
   TABLE …`) to actually stop the postgres_changes work. Until step 4 both
   transports are live, so rollback is "unset the flag / roll back the deploy"
   with no SQL involved.

The migration validated on `postgres:15` in Docker with a stubbed `realtime`
schema (`realtime.messages` as a plain table, `realtime.send` / `realtime.topic`
as SQL stubs — the real ones do not exist on a bare Postgres image): applies
clean, re-applies clean (idempotent), one message per user per statement
(a 2-row insert produced one message with `rows: 2`), two messages for a
statement touching two users' rows, none for `user_id IS NULL`, and a money
write still commits both when `realtime.send` is **absent** (the
`to_regprocedure` guard) and when it **raises** (the trigger's own
`EXCEPTION` block downgrades it to a `WARNING`). What Docker cannot prove:
that the hosted Realtime service delivers the messages and that the
private-channel authorization handshake accepts the RLS policy — that is what
V6 plus a two-device smoke test on staging is for.

## 6.5 M2(c) — lazy app-level modals + SQL-side analytics aggregates

Landed 2026-09-02 in a third pass over the same M2 family. §1-§5 are M2(a),
§6.1-§6.4 are M2(b); both are unchanged by this section.

Files touched by M2(c): the modal import + mount region of `src/App.tsx`,
`src/components/MonthlyWrapModal.tsx`, `src/components/DailyQuote.tsx`,
`src/components/RecurringDuePrompt.tsx`, `src/lib/dailyQuotePrefs.ts` (new,
+ test), `src/lib/analytics.ts` (+ `analytics.test.ts`),
`src/pages/AnalyticsPage.tsx`, a new `analyticsDb` section appended at the end
of `src/lib/supabaseDb.ts`, `supabase-migration-p2-analytics-aggregates.sql`
(new), `.env.example`.

### 6.5.1 The eagerly-mounted app-level modals are gone from the boot graph (H1)

§3 flagged this and deliberately left it: `QuickEntry`, `AddGroupExpenseModal`,
`CreateGroupModal`, `RecurringDuePrompt`, `MonthlyWrapModal` and `DailyQuote`
were **static** imports in `src/App.tsx`, so every cold boot downloaded and
parsed all six — plus everything they reach, including the
`MonthlyWrapModal → wrapCard.ts → renderNodeToImage.ts → jspdf +
modern-screenshot` chain that §2 had to neutralise with a `modulePreload`
filter. All six are now `React.lazy` and mount only when their trigger fires.

Measured with `npx vite build` + `node scripts/check-bundle-size.mjs`, both
builds run minutes apart on the same working tree with **only** the six
declarations differing (static `import` vs `lazy(() => import(...))`):

| | entry chunk raw | entry chunk gzip |
|---|---|---|
| Before (static imports) | 267.21 kB | **72.73 kB** |
| After (lazy + mount on trigger) | 144.85 kB | **42.90 kB** |

**−122.36 kB raw / −29.83 kB gzip off the entry chunk (−41.0%).** Total bundle
bytes grew slightly (3,683.05 → 3,688.99 kB raw; 1,093.24 → 1,102.56 kB gzip) —
the usual per-chunk overhead of splitting six modules out, paid once, off the
critical path.

`dist/index.html`'s `<link rel="modulepreload">` list went from **24 entries to
16**. Nine left, and every one of them is modal-graph code: `Modal`, `Toast`,
`Button`, `useDiscardGuard`, `useSubmitGuard`, `linkedRequestStore`,
`accountGroups`, `design-tokens`, `primaryCurrency`. One appeared (`i18n`,
which was already an eagerly-reachable chunk and is now hinted explicitly
rather than folded in). None of `QuickEntry-*`, `DailyQuote-*`,
`MonthlyWrapModal-*`, `RecurringDuePrompt-*`, `CreateGroupModal-*`,
`AddGroupExpenseModal-*`, `vendor-jspdf`, `vendor-modern-screenshot`,
`html2canvas`, `vendor-recharts` or `vendor-qr` appears in it.

**Every trigger still runs; only the component is deferred.** The three modals
that used to self-trigger from inside themselves had to have their trigger
lifted out first — a component cannot decide "I have nothing to show" without
being downloaded:

| Modal | Trigger, and where it lives now |
|---|---|
| `QuickEntry` | The FAB. Unchanged state flag. Additionally **warmed on `requestIdleCallback` after boot**, so the most-tapped action in the app doesn't pay a cold chunk fetch on tap — it is out of the entry graph and out of the preload list, but resident before the first tap. |
| `AddGroupExpenseModal` | Already conditional on `groupExpenseTarget`. |
| `CreateGroupModal` | `createGroupForExpense`, latched to stay mounted after first open so its exit transition still plays. |
| `RecurringDuePrompt` | The `hisaab:recurring-due` window event. **This one is a trap**: `recurringRunner` dispatches it once, at boot; a lazily-fetched component adds its listener a tick or two *later* and would miss it forever. `App.tsx` now listens eagerly, captures the payload, and seeds it into the component as `initialTemplates`. The component keeps its own listener (deduped by id) for any later event. |
| `MonthlyWrapModal` | "New month, not shown yet, ≥3 prior-month transactions in the primary currency." The gate dynamic-imports the pure `monthlyWrap.ts` after the same 1200 ms delay the component used, reads `transactionStore` **imperatively** (`getState` + `subscribe`, never as a hook — subscribing `AppContent` to `transactions` would re-render the whole app shell on every ledger write), and mounts the modal only with real stats in hand. |
| `DailyQuote` | Two `localStorage` reads. Moved into `src/lib/dailyQuotePrefs.ts` (pure, 6 tests) precisely so the gate can answer "is it due?" without importing the chunk it is trying to defer. |

Both app modes: none of the six gates is mode-dependent. `MonthlyWrapModal`'s
computation reads type/amount/currency/category/`createdAt` only — never an
account id — so a `splits_only` ledger row with BOTH account ids null feeds it
exactly like a full-tracker row.

One honest note: `fallback={null}` is used for all six Suspense boundaries on
purpose. These are overlays; the right thing to show while a chunk arrives is
the page the user is already on, never a full-screen `PageLoader`. A chunk that
fails to load is handled by the existing `GlobalChunkRecoveryOverlay`. The two
components §3 called out as deliberately static — `PinLockScreen` and
`UpdateRequiredScreen` — were **not** touched: they are gates, and a gate that
depends on a fetch is not a gate.

### 6.5.2 SQL-side analytics aggregates (H3 / M2)

`supabase-migration-p2-analytics-aggregates.sql` adds one read-only RPC:

```
analytics_monthly_summary(p_from timestamptz, p_to timestamptz, p_tz text DEFAULT 'UTC')
  → (month_start date, currency text, type text, category text,
     total numeric, tx_count bigint, latest_at timestamptz)
```

One row per (local calendar month, currency, transaction type, category) for
the **calling** user. `SECURITY DEFINER` with a pinned `search_path`, **no
user-id parameter of any kind**, an explicit `user_id = auth.uid()` predicate,
a hard `AUTH_REQUIRED` refusal on a null `auth.uid()`, `EXECUTE` revoked from
`public`/`anon` and granted only to `authenticated`.

**Deviation from the audit's suggested signature, and why.** The item names
`(p_from date, p_to date)`. Whole-day `date` parameters cannot express the
windows AnalyticsPage actually uses — three of its four periods end at `now`
(mid-day), and `last_month` ends at `…, 0, 23, 59, 59` — so a `date` signature
would have had to widen the final day and silently include future-dated rows
the client path excludes (Hisaab lets the user set `createdAt`, so those
exist). Since the whole point was that both paths produce *identical* figures,
the parameters are `timestamptz` and the boundary is exact. `p_tz` affects only
month bucketing, so a UTC+4 device's April is the device's April.

**The rule-port table** lives in the migration header (R1-R10) and is not
repeated here. The headline rules: soft-deleted rows excluded; owner-scoped;
window inclusive at both ends; `category || 'Other'` folds `''` *and* NULL; **no
currency conversion anywhere** (`conversion_rate` describes the account leg and
is never read by analytics — figures stay strictly per-currency); **all**
transaction types returned rather than filtering to income/expense in SQL, so
"what counts as spend" keeps exactly one definition, in `analytics.ts`; and **no
predicate on either account id**, so `splits_only` and `full_tracker` produce
identical rows.

**What proved them equal.** `src/lib/analytics.ts` gained
`monthlySummaryFromTransactions` — the TypeScript twin of the RPC — plus
`sumByCurrencyFromSummary`, `groupByCategoryFromSummary` and
`summaryCurrencies`, which rebuild the shipped client outputs from a summary.
`analytics.test.ts` runs one fixture (`ANALYTICS_FIXTURE`: two currencies, a
`conversionRate`-bearing row, a ledger-only row with both account ids null, an
empty category, four non-income/expense types, two calendar months, rows
exactly on each window edge and just outside each edge) through **both** routes
and asserts deep equality of the derivations.

Then Docker, `postgres:15` + the Supabase scaffold from
`docs/audit-2026-09/APPLY-ORDER.md` §3 + `transactions` + this migration, seeded
with that same fixture emitted verbatim from the test file, plus two negative
controls the TS fixture cannot express (a soft-deleted row and a row owned by a
second user):

- applies clean; **re-applies clean** (idempotent — only `already exists,
  skipping` NOTICEs);
- V1 `prosecdef=t`, `provolatile=s`, `proconfig={search_path=public, pg_temp}`;
- V2 `anon=f`, `authenticated=t`, `public=f`;
- **the equality run: 15 result rows, identical element for element** —
  `month_start`, `currency`, `type`, `category`, `tx_count` and `latest_at`
  exact, `total` within 1e-9 — against
  `monthlySummaryFromTransactions(ANALYTICS_FIXTURE, …)`;
- N1 the soft-deleted row never appears; N2 the other user's row never appears;
  N3 `sum(tx_count)` over an unbounded window == the caller's own non-deleted
  row count; N4 the ledger-only row is counted (AED "Food & Dining" = 160 over
  2 rows, one of which has BOTH account ids null); N5 `p_tz='Asia/Dubai'` moves
  a `23:59:59Z` row into the *next* month's bucket, proving the zone is really
  applied; N6 an unknown zone falls back to UTC instead of erroring; N7 a NULL
  window is refused (`BAD_WINDOW`); N8 a session with no jwt claim is refused
  (`AUTH_REQUIRED`); N9 role `anon` cannot execute it at all.

What Docker does **not** prove: PostgREST's named-argument binding and its
NUMERIC/BIGINT-as-string return shape (handled defensively with `Number()` in
`analyticsDb.monthlySummary`), the real RLS/JWT plumbing, and anything about
plan quality at real data volume — `EXPLAIN` was not run against a large table
(V7 in the migration is there for that).

**Scope, stated plainly.** The RPC serves the summary cards, the currency chips
and the category pie. It does **not** serve the daily chart (needs per-day
grain), the top-expenses list (needs rows) or the monthly trend (needs a window
that is not the selected period, and its bucket end drops the last 999 ms of
every month — serving it from a `date_trunc` bucket would introduce a
divergence rather than hide one). So this removes the client-side **summing**
for three surfaces; it does **not** yet remove the full-history **fetch**. That
needs two more RPCs and is listed in §7.

One subtlety worth recording: category **colour** is assigned by first
appearance in the transaction array (the `Map` insertion index is used *before*
the sort by amount), and the store holds transactions `createdAt DESC` — so
first appearance is the category with the greatest `createdAt`. That is why the
RPC returns `max(created_at)` per bucket: ordering categories by it reproduces
the client's colour assignment without shipping row-level data. Only an exact
`createdAt` tie between two different categories could swap a pair of colours;
amounts, percentages and ranking are unaffected.

### 6.5.3 The flag

| Flag | Default | What it does |
|---|---|---|
| `VITE_ANALYTICS_RPC` | unset (**off**) | `'true'` ⇒ the summary cards, currency chips and category pie come from `analyticsDb.monthlySummary`. Anything else ⇒ today's client aggregation, byte for byte — `rpcRows` stays `null` and the RPC is never called. |

Unlike `VITE_REALTIME_BROADCAST`, this flag **fails soft**: a missing migration
(`PGRST202`), an offline device or any other RPC error is reported through
`reportError` and the page falls back to the client aggregation. A finance app
must never answer "how much did I spend" with a blank card because a request
failed. That is also why the migration is safe to apply — or not apply — in
either order relative to the client build.

Rollout: apply `supabase-migration-p2-analytics-aggregates.sql` (non-breaking,
creates one function and one index, touches nothing existing) → run its §6
checks → ship a web build with `VITE_ANALYTICS_RPC=true` → ship the Android AAB
with the same flag. Rollback at any point is unsetting the flag; the SQL side is
inert without a caller. Apply position: after `p1-money-bounds`, and in practice
last, after everything in `APPLY-ORDER.md` §1/§2 and after
`p2-realtime-broadcast` — it shares no object with any of them.

**Index.** `supabase-migration-performance-indexes.sql` already creates
`idx_transactions_user_created ON transactions (user_id, created_at DESC)`,
which supports the RPC's range perfectly; the migration restates it with
`IF NOT EXISTS` only so it is self-sufficient. The actual addition is
`idx_transactions_analytics_summary ON transactions (user_id, created_at)
INCLUDE (currency, type, category, amount) WHERE deleted_at IS NULL` — partial
and covering, so the aggregate can be an index-only scan. Honest cost: that is
a **second index on the app's most write-heavy table**, maintained on every
transaction write. §5 of the migration documents dropping it if write latency
ever matters more than Analytics; the RPC still works without it.

## 6.6 M2(d) — list virtualization + the rest of the Analytics fetch

Landed 2026-09-02 in a fourth pass over the same M2 family. §1-§5 are M2(a),
§6.1-§6.4 M2(b), §6.5 M2(c); none of them are changed by this section.

Files touched by M2(d): `src/pages/TransactionsPage.tsx`,
`src/pages/AnalyticsPage.tsx`, `src/lib/analytics.ts` (+ `analytics.test.ts`),
the `analyticsDb` section of `src/lib/supabaseDb.ts`,
`src/components/VirtualList.ts` (new, + `VirtualList.test.ts`),
`supabase-migration-p2-analytics-aggregates-2.sql` (new),
`supabase/tests/tests/8x-analytics-rpcs.sql` (new),
`supabase/tests/apply-order.txt`, and four `i18n.ts` keys.

### 6.6.1 The `monthlyTrend` bucket-end bug — fixed in TypeScript first

§6.5.2 recorded this as a reason NOT to port the trend into SQL. It is a bug,
not a preference, and it is now fixed:

```diff
- const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
+ const end = endOfMonthExact(now.getFullYear(), now.getMonth() - i);
```

`new Date(y, m + 1, 0, 23, 59, 59)` is the last day of the month at
23:59:59.**000**, and every comparison against it is `<=`. A transaction stamped
in the final 999 ms of a month therefore belonged to **no bucket at all** — not
its own month (past the end), not the next one (before its start). Money in the
ledger, money in no chart. Hisaab lets the user set `createdAt`, and a
`23:59:59.5` stamp is exactly what a "just before midnight" entry produces.

`endOfMonthExact(y, m)` is `new Date(y, m + 1, 1).getTime() - 1` — the same
boundary with no hole. Pinned by three tests in `analytics.test.ts`
("counts a transaction in the LAST 999 ms of a month", the leap-year/December
edges, and a contiguity check that no instant falls between two buckets).

The same `…, 0, 23, 59, 59` form appeared twice more in `AnalyticsPage` —
`getDateRange('last_month')` and all four arms of `previousRange` — and both are
fixed the same way. `now` also became a single instant carried in state
alongside the period, so the cards, the previous-period comparison and the trend
buckets can no longer be cut from three different `new Date()` calls (a page
left open across midnight could do that).

**The fix is what makes the trend portable.** A corrected bucket is *exactly*
one calendar month, which is exactly what `date_trunc('month', …)` produces. So
the trend needs **no RPC of its own**: it is `analytics_monthly_summary` called
over the trend's own window, folded by `monthlyTrendFromSummary`. The
spend-trend card is the same story over `previousRange`. Two new RPCs cover
three surfaces.

### 6.6.2 The two new RPCs

`supabase-migration-p2-analytics-aggregates-2.sql` adds:

```
analytics_daily_series(p_from timestamptz, p_to timestamptz, p_tz text DEFAULT 'UTC')
  → (day date, currency text, type text, total numeric, tx_count bigint)

analytics_top_expenses(p_from timestamptz, p_to timestamptz, p_limit int DEFAULT 5)
  → (id text, created_at timestamptz, amount numeric, currency text,
     category text, notes text)
```

Same discipline as M2(c): `SECURITY DEFINER` with a pinned `search_path`, **no
user-id parameter of any kind**, an explicit `user_id = auth.uid()` predicate, a
hard `AUTH_REQUIRED` refusal on a null `auth.uid()`, a `BAD_WINDOW` refusal on a
null window, `deleted_at IS NULL`, **no predicate on either account id**, no
currency conversion anywhere, `STABLE` + `RETURNS TABLE`, and `EXECUTE` revoked
from `public`/`anon` and granted only to `authenticated`. The rule-port table
(D1-D8, T1-T7) lives in the migration header and is not repeated here.

Three decisions worth calling out:

* **`analytics_daily_series` returns real calendar DATES, not the chart's bar
  keys.** The daily chart keys bars by DAY-OF-MONTH and stops after 31 bars, so
  over a 61-day window April 5 and May 5 share a bar. That is a quirk, and it is
  shipped. The SQL returns the fact (a date); the quirk is applied afterwards by
  `dailySpendingFromSeries` through `dailyFromDayOfMonthTotals` — the *same*
  helper the client path now calls. Neither path can drift into "fixing" it
  unilaterally.
* **`analytics_top_expenses` is partitioned by currency, and drops the
  `p_currency` the audit suggested.** The page flips between currency chips
  without re-fetching (it re-slices in memory today). A per-currency parameter
  would make every chip tap a round-trip; top-N *per currency* answers every
  chip from one call and is a strict superset of any single-currency call.
  Result size is `p_limit × currencies-you-actually-spend-in` — single digits.
  `p_limit` is clamped to 1..100 so a caller cannot turn a top-5 list into a
  full-table export.
* **It is the only analytics RPC that returns rows**, so "an aggregate has
  nothing per-row to authorise" — M2(c)'s argument for `SECURITY DEFINER` — does
  not apply to it. Its compensating controls are doing real work, which is why
  the harness asserts every one of them.

### 6.6.3 What Docker proved

`bash supabase/tests/run.sh` (postgres:15, the **whole** SQL corpus in canonical
apply order — 69 files with this one added after its sibling — then every
`supabase/tests/tests/*.sql` as role `authenticated`). New file:
`supabase/tests/tests/8x-analytics-rpcs.sql`, **16 assertions, all green**; the
harness as a whole was green on the last run (357 assertions, 0 failed — the
total moves as other agents in this batch land their own test files).

Seed: `ANALYTICS_FIXTURE` from `analytics.test.ts` inserted verbatim (two
currencies, a `conversion_rate`-bearing row, TWO ledger-only rows with BOTH
account ids NULL, an empty category, four non-income/expense types, two calendar
months, both window edges, one row outside each edge), plus three negative
controls the TS fixture cannot express: a soft-deleted 99,999 row, a row owned
by a **second user** sitting in the middle of the window, and an amount-tie
triple parked outside the window.

The expected values are **not hand-written** — they were dumped from
`dailySeriesFromTransactions(...)` and `topExpensesFromTransactions(...)` and
pasted into the test file, so a drift in either direction fails the harness.

| | What was proven |
|---|---|
| A1 | `analytics_daily_series` == `dailySeriesFromTransactions`, **row for row** (15 rows: same day/currency/type, totals within 1e-9, same counts) |
| A2 | Returned in `(day, currency, type)` order, so the two sides compare 1:1 without re-sorting |
| A3 | Window inclusive at BOTH ends; the two rows just outside never appear |
| A4 | `p_tz='Asia/Dubai'` really moves a `23:59:59Z` row into the next local day; an unknown zone falls back to UTC instead of erroring |
| A5 | No FX: the `conversion_rate 0.013` row sums at face value; PKR never folds into AED |
| A6 | **Both app modes** — the two ledger-only rows (BOTH account ids NULL) are counted, and the unbounded series' `sum(tx_count)` equals the caller's non-deleted row count exactly |
| A7 | The soft-deleted row is invisible to both RPCs |
| A8 | The second user's row is invisible to both; a session with no jwt claim gets `AUTH_REQUIRED` from both |
| A9 | `analytics_top_expenses` == `topExpensesFromTransactions`, row for row and **in order** (5 AED + 2 PKR) |
| A10 | `p_limit` clamped: 0 → 1 per currency, NULL → the default 5, 100000 → never more than 100 per currency |
| A11 | The tie rule: three equal amounts come back `t3, t2, t1` — `created_at DESC` then `id DESC`, the stable-sort port |
| A12 | Both functions are `SECURITY DEFINER` + `STABLE` + pinned `search_path`; `anon` and `public` cannot execute either; `authenticated` can |
| A13 | Cross-RPC consistency — the daily series and the monthly summary agree per `(currency, type)` over the same window |
| A14 | A NULL window is refused (`BAD_WINDOW`), not silently treated as unbounded |

Re-applying the migration into an already-migrated database was checked
separately (`--apply-only --keep`, then the file again): clean, no errors —
idempotent.

**What Docker does NOT prove:** PostgREST's named-argument binding and its
NUMERIC/BIGINT-as-string return shape (handled defensively with `Number()` in
`analyticsDb`), the real RLS/JWT plumbing, and plan quality at real data volume
(§6 V7 of the migration is there for that).

### 6.6.4 AnalyticsPage no longer fetches the history

With `VITE_ANALYTICS_RPC=true` the page issues **five aggregate calls in
parallel** — `monthlySummary` over the period, over the trend window and over
the previous window, plus `dailySeries` and `topExpenses` — and calls
`loadTransactions()` **not at all**. `loadGroups()` still runs (it always did).

The fallback is a latch, not a per-call retry: if ANY of the five errors, it is
reported through `reportError`, `rpcFailed` flips, `loadEverything`'s identity
changes, `useAsyncLoad` re-runs it and the page loads the full history and
renders the pre-M2 client aggregation. Once latched it stays latched for the
life of the screen — five failed requests per period tap against an unapplied
migration is not a fallback, it is a retry storm.

With the flag OFF nothing changed: no RPC is called, `loadTransactions()` runs
as before, every figure comes from the same expression as before.

### 6.6.5 TransactionsPage: the render window and the recent window

Two separate mechanisms, deliberately not conflated.

> **Amended 2026-09-03 (founder request: "just load the latest 15 entries, then
> a Load more button").** The automatic day-group reveal described in (a) was
> replaced on `TransactionsPage` by an explicit **15-entry page + "Load more"
> button** (`src/lib/listPaging.ts`: `sliceBlocks`, `nextPageCount`; 24 tests).
> The unit is now an *entry*, a day group is cut mid-way with its whole-day
> total still shown in the header, and nothing is revealed by scrolling. The
> two properties that mattered are kept: the page count only grows and is
> remembered in a module variable for the session (same reason as below — the
> POP scroll restoration needs the page to re-render at the height it left
> with), and totals/search/filters run over the full loaded window, never over
> what is painted. `useProgressiveBlocks` / `resetBlockMemory` in
> `VirtualList.ts` therefore have **no consumer** today; they stay exported and
> tested for any list that still wants scroll-driven reveal. The text below
> describes the mechanism as originally built.

**(a) Windowed rendering** — `src/components/VirtualList.ts`
(`useProgressiveBlocks` + `deferredBlockStyle`). No new dependency. The unit is
a **day group**, not a row.

* Day groups past `visibleGroups` (8 initially, +8 per step) are not mounted at
  all. An `IntersectionObserver` sentinel with an 800 px `rootMargin` reveals
  the next batch before the user reaches it.
* Groups that ARE mounted but off-screen carry
  `content-visibility: auto; contain-intrinsic-size: auto <est>px`, so the
  browser skips their layout and paint while keeping the scrollbar honest.
* **The window only ever grows, and it remembers how far it grew** (a module
  `Map`, keyed `'transactions'`, alive for the session).

That last point is the whole reason a classic virtual list was rejected.
`src/App.tsx` (H7 / MF-18) takes manual control of scroll restoration and calls
`window.scrollTo(0, recorded)` in an effect right after a POP navigation
commits. Under classic virtualization the document height is a function of
what is mounted *at that instant*, so the browser clamps the restore and the
user lands at the wrong place. Growing-only + remembered depth means the page
re-renders at the height it left with, and the restore lands. Rows are also not
fixed-height here (a day group is a header plus 1..n rows, and an ad-hoc split
row expands in place), which rules out row-height math anyway.

Degradation is honest: **no `IntersectionObserver` ⇒ everything renders**,
exactly as before. Find-in-page cannot reach an unrevealed group (it *can* reach
a `content-visibility: auto` one — browsers expand those for find); the page's
own search box searches the full filtered set, which is the search that matters
on this screen.

**(b) The recent window** — the default view is the last **90 days**, with a
"Show full history" affordance.

It is a *rendering* window, not a fetch window (the store still holds
everything; other screens need it), and — critically — **it switches off the
moment any filter or search is active**:

```ts
const windowActive = !showFullHistory && !filtersActive;
```

So search and filter semantics are byte-identical to before this change: a
search always runs over the complete loaded history, never over 90 days of it.
The day-group totals, the split bundling, the month-flow hero and the results
count are all unchanged.

**Truncation honesty.** Three distinct states, worded apart on purpose:

| State | What the user sees |
|---|---|
| Recent window on, older entries exist | "Showing the last 90 days · N older entries are hidden" + **Show full history** |
| Every matching row is older than the window | The same card *instead of* an empty state — "no transactions" is never shown when there ARE transactions |
| The local mirror is short of the server | "N of M entries are loaded on this device — the rest are safe on the server" |

The third row is the H4/F-FE1 surfacing. `fetchAllPages` already **detects** a
partial fetch, but it reports it through `reportMessage` (Sentry) only, and the
route that would carry that flag to the UI runs through `mirrorCache` →
`transactionStore` — files this task does not own. The ownership-safe equivalent
is `analyticsDb.transactionHistoryCount()`: a PostgREST `head: true, count:
'exact'` request that transfers **no rows**, fired once per mount after the
first load resolves, compared against what the store holds. It is arguably the
stronger signal — it also catches a mirror that is short for reasons
`pagedFetch` never saw. It fails silently (returns `null`), because a count that
does not answer must never block a list from rendering.

**Both app modes.** Nothing on this page reads an account id for windowing,
grouping or search; a `splits_only` row with BOTH account ids null flows through
`filtered` → `windowed` → `dayGroups` → `bundleSplitEvents` exactly like a
full-tracker row, and the ledger-only repayment record renders through the same
`TransactionItem`. The recent window and the render window are both purely
`createdAt`-based.

### 6.6.6 Measurements

`npx vite build` + `node scripts/check-bundle-size.mjs` on this working tree:

```
Entry chunk: index-1SADXkay.js
  raw:  143.47 kB
  gzip: 41.88 kB   (budget: 90.00 kB)      → OK
TOTAL (all JS chunks)  3762.09 kB raw / 1122.44 kB gzip
```

No new dependency was added, so the entry chunk is where M2(c) left it.

The render-cost claim is structural rather than benchmarked, and should be read
that way: on the default view, a user with three years of history renders **8
day groups** instead of ~1,100, and the Analytics page issues **5 aggregate
requests returning tens of rows** instead of a keyset walk of the entire
`transactions` table (500 rows a page, unbounded). No device timing was captured
— this task had no instrumented low-end Android to hand, and quoting a number
from a desktop dev build would be worse than quoting none.

`npx vitest run`: **139 files, 1782 tests, all passing** (46 of them in
`analytics.test.ts`, 6 in `VirtualList.test.ts`). `npx tsc -b --noEmit` is clean
for every file this task owns; it currently reports errors in
`src/pages/KametiDetailPage.tsx`, `src/stores/committeeStore.ts` and
`src/components/AllocateRepaymentModal.tsx`, all in-flight work by other agents
in this batch. `npx eslint` on the owned files reports only the pre-existing
`jsx-a11y/no-autofocus` warning on the search box.

### 6.6.7 Rollout and open risks

Rollout is unchanged from M2(c) and still gated by the same flag:

1. Apply `supabase-migration-p2-analytics-aggregates.sql` (if it is not applied
   yet), then `supabase-migration-p2-analytics-aggregates-2.sql`. Both are
   non-breaking and safe ahead of the client.
2. Run §6 of each file's verification block.
3. Ship a web build with `VITE_ANALYTICS_RPC=true`.
4. Ship the Android AAB with the same flag (the Play binary lags the web
   deploy). Per the repo's both-surfaces rule, `npm run build && npx cap sync
   android` then hand the Gradle build to the user.

Rollback at any point is unsetting the flag; the SQL side is inert without a
caller. **The virtualization and the recent window are NOT flag-gated** — they
are pure client rendering changes with no server dependency, and gating them
would mean shipping two list implementations.

Open risks, stated plainly:

* **The recent window changes what the default view shows.** A user who scrolls
  looking for something from six months ago now has to tap "Show full history"
  first. The footer says so, with the exact count of hidden entries, and any
  search or filter lifts the window automatically — but it is a behaviour
  change, not a pure optimisation, and it is the one thing here a user could
  notice and dislike.
* **`transactionHistoryCount()` is one extra request per TransactionsPage
  mount.** It transfers no rows, but it is not free. If it ever shows up in a
  request budget, gate it behind "only when the store looks suspiciously round"
  (a multiple of 500) rather than removing the honesty.
* **The five analytics calls are five round-trips.** They are small and
  parallel, and they replace an unbounded paged walk, but on a very high-latency
  connection five parallel small requests can feel slower than one big one that
  streams. A single `analytics_bundle` RPC returning all five result sets as
  JSON would fix that; it was not built here because it would have made the
  rule-port table (and its Docker proof) five times harder to read.
* **Category colours can still swap on a `createdAt` tie** — inherited from
  M2(c) R9, unchanged, amounts and ranking unaffected.
* **Nothing here has been exercised against a real Supabase project.** Docker
  proves the SQL; the RPC binding, the fallback latch and the scroll-restoration
  interaction need one pass on a device with a real history before this is
  called done.

## 7. Remaining M2-family items — still not done

- **Boot RPC consolidation** (M2's "L" fix: 1-2 `SECURITY DEFINER` boot RPCs
  instead of ~15 parallel PostgREST reads). The dedupe above removes the
  duplicates; it does not batch what remains.
- **Parallelising `isDeletedProfile` with the session publish** (quick win #9,
  second half): the gate still awaits one round-trip before the session is
  published. It is now a *shared* round-trip, but still serial.
- **`scripts/check-bundle-size.mjs` is still not wired into CI** — see §5.
- **A single `analytics_bundle` RPC** to collapse Analytics' five parallel calls
  into one — see the third open risk in §6.6.7.
- **A device pass on the M2(d) client work.** Docker proves the SQL; the POP
  scroll-restoration interaction, the reveal-on-scroll feel and the fallback
  latch have not been walked on a real Android build with a real history.

### Done since this list was written

- ~~**SQL-side analytics aggregates**~~ — §6.5.2 (flag-gated, migration pending
  the user applying it).
- ~~**The eagerly-mounted app-level modals**~~ — §6.5.1. All six are lazy;
  entry chunk 72.73 → 42.90 kB gzip.
- ~~**Transactions list virtualization**~~ — §6.6.5. Day-group windowing +
  `content-visibility`, no new dependency, plus a 90-day default view that is
  explicit about what it is hiding and a banner when the local mirror is short
  of the server (the H4 truncation surfacing).
- ~~**The rest of the Analytics fetch**~~ — §6.6.2/§6.6.4. Two new RPCs
  (`analytics_daily_series`, `analytics_top_expenses`); the trend and the
  spend-trend card come from the EXISTING monthly-summary RPC over their own
  windows, which the `monthlyTrend` bucket-end fix (§6.6.1) made exact. With the
  flag on, AnalyticsPage no longer calls `loadTransactions()` at all. Migration
  pending the user applying it.
- ~~**The `monthlyTrend` 999 ms bucket hole**~~ — §6.6.1, fixed in TypeScript
  with three regression tests.
- ~~**The unbounded transactions FETCH**~~ — §7.1 below. `loadTransactions()`
  is windowed, `ensureTransactionHistory()` pages the rest on demand, and
  `historyCoverage` makes the difference inspectable instead of implicit.

---

## 7.1 The bounded transaction load

Landed 2026-09-02. This is the item §7 above described as "not a rendering
problem any more; a store-shape problem". It is the store-shape change.

Files: `src/lib/historyWindow.ts` (new, + `historyWindow.test.ts`),
`src/lib/historyCoverageContract.test.ts` (new), the transactions region of
`src/lib/supabaseDb.ts`, `src/lib/mirrorCache.ts`, the load/hydration region of
`src/stores/transactionStore.ts` (+ `transactionStore.test.ts`), the store call
sites in `src/pages/TransactionsPage.tsx`, `HomePage.tsx`, `LoansPage.tsx`,
`AnalyticsPage.tsx`, `AccountDetailPage.tsx`,
`src/components/SendStatementModal.tsx`,
`src/lib/migrations/backfillPersons.ts`, and two `i18n.ts` keys.

No SQL. No migration. No feature flag — see "Rollout" at the end for why.

### 7.1.1 The window rule

> **The default load is every transaction from the last 12 calendar months,
> extended until it has read at least 1000 rows — whichever reaches further
> back — and it stops at the end of the table before either floor if the user
> simply has less history than that.**

Both numbers live in `src/lib/historyWindow.ts` with their reasoning, and the
stop rule is one exported, unit-tested predicate (`shouldStopWindowPaging`)
that requires **both** floors to be satisfied:

* **12 months** because every recurring surface the store feeds sits inside it:
  the monthly-wrap gate reads the previous calendar month, budgets the current
  one, the Hisaab-check ritual the last few weeks, TransactionsPage's default
  view 90 days, and Analytics' longest client-side window (`monthlyTrend`) six
  months. Twelve covers the widest of those twice over.
* **1000 rows** because a date-only window would be a regression for this app's
  most common user — someone with a few hundred lifetime entries whose whole
  history costs one or two pages. For them the row floor walks to the end of the
  table, coverage comes back `complete: true`, and every "needs everything"
  consumer resolves with no second fetch. It is two `TRANSACTION_PAGE_SIZE`
  pages, and deliberately sits at the PostgREST max-rows default: a windowed
  load costs at most what one unbounded `select('*')` used to silently
  *truncate to*.

The floor **never narrows**. `planHistoryLoad` takes the earliest of the window
start, the coverage already established, and any explicit `since`, so a user who
tapped "Show full history" and then saved an expense is not quietly demoted back
to 12 months by the reload that follows the write.

H4's truncation detection is untouched and now feeds the contract: a truncated
walk vetoes `complete`, and the coverage floor drops to the oldest row the pager
actually managed to read rather than the `since` it was aiming for.

### 7.1.2 The coverage contract

`historyCoverage: { since: string | null, complete: boolean }` is public store
state. Read the two fields **together** — `since: null` is not "since the
beginning of time", it is "no floor established":

| `complete` | `since` | meaning |
|---|---|---|
| `true` | any | every non-deleted transaction the user owns is in the store |
| `false` | `null` | **nothing is guaranteed** — initial state, or a load answered purely from cache |
| `false` | ISO | every row with `createdAt >= since` is in the store |

Four rules make it usable:

1. **The store may hold rows older than `since`.** The Dexie mirror keeps
   whatever it already had and the row floor over-fetches. Those rows are real
   and they are shown. They are simply not a *promise*: nothing asserts they are
   the complete set for their period. `transactions.length` is not evidence.
2. **Coverage only widens within a session** (`mergeCoverage` is the union of
   two contiguous half-open ranges, i.e. the earlier floor). `reset()` — a user
   switch — drops it back to nothing, so the next account cannot inherit "we
   hold everything" over an empty store.
3. **A bare request means "all".** `coverageSatisfies(coverage, {})` is false
   unless coverage is complete: a caller that does not say what it needs is
   assumed to need everything.
4. **The floor is persisted, but only believed under one condition.** It rides
   on the mirror's sync row and is adopted on boot only when the cursors say an
   incremental sync is what runs next — §7.1.3a below.

`ensureTransactionHistory({ all })` walks the whole table; `({ since })` fetches
only the gap **below** the current floor (`historyGap`), inclusive at both ends
so rows sharing the boundary instant cannot fall between the two fetches. Both
**merge** — `mergeTransactionRows` is keyed by id, incoming wins a collision,
and nothing is ever dropped. `set({ transactions: fetched })` on a partial
result would have deleted the newest rows from the screen exactly the way the
mirror's `clear()` used to delete them from Dexie (F-FE1). One in-flight promise
is shared per request shape, so Home + a statement sheet + the person backfill
mounting together cost one walk, not three.

### 7.1.3 Mirror behaviour

`mirrorCache` gained one field (`RemoteFetchResult.completeFrom`) and one option
(`windowKeyOf`). When a fetch declares itself windowed the mirror:

* **merges instead of replacing** — the fetch is partial by construction, and
  clearing on a partial result is precisely F-FE1;
* **reconciles inside the window** — a mirror row at/after `completeFrom` that
  the fetch did not return was deleted on another device, so it is pruned. This
  is what the daily full refresh's clear-and-replace used to do for tombstones;
  without it, merge-only would let a remote deletion linger.
* **leaves everything older alone** — this fetch has no opinion about it.

Rows edited today but *created* years ago are outside the created_at window and
are still caught, because the incremental path filters on `updated_at`, not
`created_at`. That path is unchanged.

One robustness fix rode along: the merge paths answer from the mirror, and on a
device with no usable IndexedDB (private mode, a locked-down WebView, a quota
failure) every mirror write silently no-ops and that read comes back empty —
which would have handed the caller an empty list while a perfectly good server
response sat in hand. `preferMirror` never returns less than was just fetched.

**Both app modes.** Nothing on this path reads an account id: the window, the
merge, the sort and the reconcile are all `createdAt`-keyed. A `splits_only` row
with BOTH account ids null is windowed by date exactly like a full-tracker row,
and the store test asserts the two modes produce equal results — same windowed
count, same completeness, same merged total — from identical rows.

### 7.1.3a The persisted coverage floor

Added 2026-09-03, closing the first two open risks below. Files:
`src/db/database.ts` (two non-indexed fields on `MirrorSyncState` — no Dexie
version bump), `src/lib/mirrorSyncPolicy.ts` (all the rules, pure),
`src/lib/mirrorCache.ts` (the I/O + the invalidation wiring), the LOAD region of
`src/stores/transactionStore.ts`. New suites: `mirrorCache.coverage.test.ts`,
`transactionHistoryPersistence.test.ts`, plus additions to
`mirrorSyncPolicy.test.ts` and `historyCoverageContract.test.ts`.

**The shape.** `coverageSince: string | null` + `coverageComplete: boolean`,
stored on the `mirrorSync` row for `transactions` — i.e. next to the very
cursors that vouch for the mirror's contents, and inside the per-user Dexie
partition that sign-out deletes. Both fields are optional and unindexed: a row
written before this shipped simply reads as "nothing proven".

**When it is written.** Only when the store's live coverage widens or completes,
and only *after* the fetched rows are in the mirror (`adoptHistoryCoverage`,
the single call site of `writeMirrorCoverage`; the contract suite asserts both).
The write **replaces** the stored floor rather than widening it — the live floor
is the truth, and a union with disk would let an invalidated claim resurrect.
It never creates a sync row: a floor with no cursor beside it could never be
trusted anyway, and inventing a cursor would make the next load skip a refresh.

**When it is believed.** On a load answered from cache — the case that used to
earn nothing at all — and then only if `planMirrorRefresh` on the current
cursors returns anything but `'full'` (`persistedCoverageIsTrustworthy`). A
`'full'` plan means the mirror is empty, has no watermark, or the daily
reconciliation is due; that reconciliation exists *because* the incremental
cursor can have missed a tombstone, so until it lands the mirror is not
known-good and the session claims nothing it did not prove itself. Not "trust it
a little" — a narrowed stale claim is still a stale claim.

**When it is invalidated** (`coverageSurvives`), each because it can leave rows
missing below or above the floor:

| event | why |
|---|---|
| a server truncation warning (`fetchAllPages`' max-rows probe) | a server that just under-reported is not evidence for anything |
| a clear-and-replace of the mirror | every row below the floor is gone unless that one fetch returned it |
| an in-window reconcile that pruned rows | the right repair for a missed tombstone, but indistinguishable from a short page, which would punch a hole *above* the floor |
| sign-out / user switch | the whole per-user database goes; `reset()` clears the floor explicitly as well |

And deliberately **not** invalidated by the incremental path's
`fetchDeletedSince`. That is an explicit tombstone list — it names the ids the
server says are gone and removes exactly those, leaving no hole. Dropping the
floor there would drop it every time a user deletes an expense, which would make
persisting one pointless. A control test pins that down, because a blanket
"clear on anything" would pass every safety assertion and quietly buy nothing.

One signal had to be split to make this work. A *windowed* caller sets
`RemoteFetchResult.truncated` on **every** fetch — it means "this set is partial
by construction, do not clear the mirror" — so reading it as a truncation
warning would have invalidated the floor on every daily refresh. The DAL's real
max-rows warning now travels separately as `serverTruncated`; unwindowed callers
are unchanged, since for them `truncated` already meant exactly that.

**What it buys.** A returning user with a warm mirror that already holds five
years now starts the session knowing it, so the first statement or account
screen resolves with **no** walk instead of a full one. The two safeguards are
layered rather than alternatives: the trust gate stops a stale floor being read,
and the invalidation stops a stale floor being there to read.

### 7.1.4 Consumers: what each one now asks for

| Consumer | Requests | Why |
|---|---|---|
| `HomePage` | window, then `{ since: oldest loan }` | `cardFundedLoanIds` keys a loan to its funding card, and that link exists only on the loan's **origin** row, which can predate the window. Missing it double-counts the same debt in "this week". Bounded to the oldest loan, not the whole table — this is a boot path. Non-fatal on failure. |
| `LoansPage` | window, then `{ since: oldest loan }` | Same origin-row problem, twice: card-funded loans, and `buildAdhocSplitIndex`. A missed origin row silently re-classifies old card debt as a person's debt. |
| `TransactionsPage` | window; `{ all: true }` on "Show full history" **and** on any active filter/search | The button now fetches as well as lifting the 90-day render window — a tap that only lifted the window would show the same 12 months and call it "full history". §6.6.5 promises that search runs over the complete history; that promise is now paid for on demand. |
| `SendStatementModal` (the only `buildStatement` call site — LoansPage, LoanDetailPage, ContactDetailSheet all route through it) | `{ all: true }`, **awaited** | A statement of account is a ledger sent to another person as a record of a debt. Built from a window it would drop older repayments and **overstate** what is owed. It refuses to build until `historyCoverage.complete`; while it waits it says so, and it never renders "no activity with X" over an in-flight fetch. |
| `AnalyticsPage` (client fallback only) | window, then `{ all: true }` | The period selector offers "this year" and "all time", and `monthlyTrend` walks six months back regardless of period. With `VITE_ANALYTICS_RPC=true` the page still fetches no rows at all (§6.6.4) — this only affects the fallback. |
| `AccountDetailPage` | window, then `{ all: true }` | It *is* an account's statement, and a card's cycle debt is derived from advance/bill rows that can be years old. A user-initiated navigation, not a boot path. |
| `backfillPersons` | window, then `{ all: true }` | A one-shot migration that rewrites `person_id` on every historical row **and then marks itself done**. Over a window it would leave older rows unlinked forever. |
| `exportAllData` | unchanged | Already went straight to `transactionsDb.getAll()` (the keyset walk), never through the store. Pinned by a test so a future "reuse the store's rows" tidy-up cannot silently start exporting 12 months. |
| `monthlyWrap` gate (App.tsx) | unchanged | Reads the **previous calendar month** only — always inside a 12-month window. This is one of the reasons the window is 12 months and not 3. |
| `HisaabCheckModal`, `BudgetsPage`, `notificationScheduler`, `QuickEntry`, `EditTransactionModal`, `ContactDetailSheet`'s recent list | unchanged | All read the recent end of the ledger. The window is strictly more than they need. |

### 7.1.5 Before / after boot payload

**Derived from code, not measured** — there is no instrumented device or real
2-year account in this task's reach, and a number from a dev machine would be
worse than an honest formula. The inputs are the two page sizes and the walk
rules in `pagedFetch.ts` / `supabaseDb.ts`.

Take a two-year user at ~2.7 entries/day ≈ **2,000 transaction rows**, evenly
spread, so roughly 1,000 of them fall in the last 12 months.
`TRANSACTION_PAGE_SIZE` is 500, and the keyset cursor is **inclusive**, so every
page after the first re-delivers one boundary row (`fetchAllPages` de-duplicates
it by id).

| | requests | rows transferred |
|---|---|---|
| **Before** — `getAllPaged()` walks the table | 500 · 500 · 500 · 500 · 4 = **5** (the last page is short and ends the walk) | **2,000** |
| **After** — `getWindowPaged({ since: −12mo, minRows: 1000 })` | 500 · 500 · 500 = **3** (after page 2 the row floor is met but the oldest row read is still inside the window, so one more page runs; the stop fires when both floors clear) | **~1,500** |

**≈ −25% rows and −2 requests on a cold boot at that volume.** The point is not
that number, though — it is that the "after" column stops growing. At the same
~1,000 entries per year, the window is always ~1,000 rows, so:

| user | before (requests / rows) | after (requests / rows) |
|---|---|---|
| 1 year, 1,000 rows | 3 / 1,000 | **3 / 1,000** (identical — the walk reaches the end) |
| 2 years, 2,000 rows | 5 / 2,000 | **3 / ~1,500** (−25%) |
| 5 years, 5,000 rows | 11 / 5,000 | **3 / ~1,500** (−70%) |
| 10 years, 10,000 rows | 21 / 10,000 | **3 / ~1,500** (−85%) |

The before column is `1 + ceil((N − 500) / 499)` requests — each page after the
first re-delivers one boundary row — and it grows without bound. The after
column is flat, because the window is a function of *time*, not of how long the
user has been keeping books. Below ~1,000 lifetime rows the two columns are
identical **by design**: the row floor walks to the end of the table and
coverage comes back complete, so the app's most common user pays exactly what
they paid before and every "needs everything" consumer resolves for free.

A denser user shifts the crossover rather than removing it: at 3,000 entries a
year the 12-month window is ~3,000 rows (7 requests), so a two-year user of that
shape saves nothing on boot and a ten-year one still saves ~70%.

Three honest qualifications:

1. **This is the cold-boot and daily-full-refresh cost, not every load.** The
   Dexie mirror already served warm boots from cache and money writes through
   the incremental `getUpdatedSince` diff (§6.2 / H2). The full walk was paid on
   a cold start with an empty mirror, on a new device, on the daily
   reconciliation, and on any device where IndexedDB is unavailable — which is
   also exactly where a slow first paint hurts most.
2. **Some users pay a second, bounded request.** Home and Loans top up to their
   oldest loan; a statement, an account screen or the person backfill asks for
   everything. Each is a no-op once coverage answers it, and none of them is on
   the boot path except the loan top-up — which itself resolves without a
   request for any user whose oldest loan is inside a year.
3. **Row size was not measured.** The table is ~22 columns and a typical row
   serialises to roughly 400-600 bytes of PostgREST JSON before gzip, so 2,000
   rows is on the order of 1 MB uncompressed. That figure is an estimate and is
   not the basis of any claim above; the request and row counts are.

### 7.1.6 Verification

`npx vitest run`: **143 files, 1887 tests, all passing** — 36 new in
`historyWindow.test.ts` (window arithmetic, the coverage lattice, the merge
rule, the stop predicate), 8 in `historyCoverageContract.test.ts`, and 13 new
store tests in `transactionStore.test.ts` covering the windowed load, the sparse
user's complete coverage, the non-narrowing floor, the gap fetch, in-flight
sharing, a locally-written row surviving a merge, and mode parity.

The persisted floor (§7.1.3a) added 24 more: 11 pure ones in
`mirrorSyncPolicy.test.ts` (the trust gate, the normaliser's degrade-to-less
rule, the survival predicate), 13 in `mirrorCache.coverage.test.ts` (the real
`loadCacheFirst`/`refreshMirror`/`reconcileWindow` over an in-memory table with
Dexie's shape — round-trip, carry-forward across a sync, each invalidation
trigger, and the control case that must *not* invalidate), 11 in
`transactionHistoryPersistence.test.ts` (a simulated restart honouring the floor
with zero round-trips, the same restart refusing it when a full refresh is due,
truncation and an untombstoned deletion invalidating it, sign-out clearing it,
and full-tracker vs `splits_only` producing byte-identical results), and 4 more
source-level ones in `historyCoverageContract.test.ts`.

Dexie cannot run in the Node suite, which is why those two files fake `../db`
rather than `mirrorCache`: the policy, the cache and the store under test are
all the real implementations, and only IndexedDB is substituted.

`historyCoverageContract.test.ts` is deliberately a **source-level** assertion.
The failure it guards against is invisible to every other kind of test: the
store is populated, the component renders, the arithmetic is correct, and the
answer is quietly smaller than the truth. It names each completeness-critical
file and fails by name if the guard is ever dropped — including the specific
assertion that `SendStatementModal` gates `buildStatement` on
`historyCoverage.complete` rather than merely firing the fetch.

`npx tsc -b --noEmit`: clean across the repo. `npx eslint` on the touched files:
only the pre-existing `jsx-a11y/no-autofocus` warnings.

### 7.1.7 Rollout and open risks

**Not flag-gated, and deliberately.** There is no SQL and no server dependency;
gating would mean shipping two store shapes and two sets of consumer call sites,
and the consumer changes (the statement gate, the backfill) are *correctness*
fixes that a flag would leave half-applied. Rollback is a revert.

Ships to both surfaces per the repo rule: `npm run build && npx cap sync
android`, then the Gradle AAB build goes to the user.

Open risks, stated plainly:

* ~~**Coverage is session state, not persisted.**~~ **Done 2026-09-03** —
  §7.1.3a. The floor rides on the mirror's sync row, is adopted on boot only
  when an incremental sync is what runs next, and is dropped by every event that
  can remove rows below it. The stated reason for not doing it originally ("a
  persisted claim that outlives the data it describes is a worse bug than an
  extra fetch") is what the trust gate and the invalidation rules are for.
* ~~**A load answered from cache earns no coverage.**~~ **Done 2026-09-03** —
  same change. A cache-answered load still proves nothing itself; it may now
  *adopt* the persisted floor, which is the only claim available that something
  else already paid for.
* **A widened floor makes the next full refresh wider too.** Coverage never
  narrows, so a session that adopted `complete` plans `getAllPaged` on its next
  real fetch instead of the 12-month window. That costs nothing on the cache and
  incremental plans (they skip `fetchRemote` entirely), so in practice it is
  paid once a day at most, by a user who had already proved completeness — but
  it is the price of the non-narrowing rule and it is worth knowing about.
* **The floor is trusted per-mirror, not per-row.** It says the mirror holds
  everything from an instant onward; it cannot say *which* rows, so a mirror
  corrupted by something outside these paths (a partial IndexedDB failure that
  silently drops writes) would still be claimed as complete. The invalidation
  rules cover every path this code owns, not every way a browser can lose data.
* **The statement sheet now has a loading state it did not have.** On a slow
  connection the user taps "Send statement" and waits on a walk of their whole
  history before seeing figures. That is the right trade for a document that
  asserts a debt, but it is a visible behaviour change and the most likely thing
  to draw a complaint.
* **`preferMirror` masks a genuinely-emptied mirror.** If a user really did have
  their local data cleared while the server still has rows, the merge path now
  returns the fetched rows rather than the empty mirror. That is the desired
  behaviour, but it means "mirror is empty" is no longer observable from the
  return value alone.
* **Nothing here has been exercised against a real Supabase project.** The stop
  rule, the merge and the coverage lattice are unit-tested against an in-memory
  DAL; the PostgREST paging behaviour at the window boundary — particularly a
  large block of rows sharing one `created_at`, which is what H4's truncation
  detection exists for — has not been walked against a real table with real
  history.
