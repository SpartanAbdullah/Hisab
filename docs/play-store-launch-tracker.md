# Hisaab → Play Store Launch Tracker

Single source of truth for getting Hisaab live on Google Play. Split by owner so
we always know who's on what. Pair this with the step-by-step in
[`RELEASE.md`](../RELEASE.md).

**Status legend:** ✅ done · 🔄 in progress · ⏳ todo · 🚧 blocked (waiting on something) · 💤 deferred (post-v1)

---

## 🤖 Claude — code & assets (I do these in the repo)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C1 | Interaction-safety pass (confirmations, undo, validation, guards) | ✅ | Shipped |
| C2 | Gradle guard: fail release build if upload keystore missing | ✅ | `android/app/build.gradle` |
| C3 | Make `supabase-migration-p0-launch-blockers.sql` re-runnable | ✅ | Idempotent policy drops |
| C4 | Design the consistent Hisaab logo (pick a concept) | ✅ | Concept A chosen (navy squircle, cream H, violet bar) |
| C5 | Produce ALL icon assets from the chosen logo | ✅ | favicon, PWA (+ real maskable), apple-touch, Android mipmaps, in-app mark — via `scripts/generate-icons.mjs` |
| C6 | Hardware back button closes an open modal first | ⏳ | `nativeBridge` + `uiStore`; you verify on device |
| C7 | Draft Play store listing copy (short + full description) | ⏳ | Framed as expense/khata tracking, no lending language |
| C8 | Draft the 1024×500 feature graphic (SVG) | ⏳ | You export to PNG |
| C9 | Correct the 3 Data Safety doc details (phone, Sentry) | ⏳ | So declared = actual |
| C10 | Sentry wiring matches final decision | ✅ | Code wired (reads `VITE_SENTRY_DSN`); you provide the DSN (Y12) |

## 🧑 You — operational, hosting & Play Console (only you can do these)

| # | Task | Status | Notes |
|---|------|--------|-------|
| Y1 | Run `supabase-p0-security-verification.sql` in prod | ⏳ | Expect: "P0 security catalog verification passed" |
| Y2 | Decide: Sentry crash reporting yes/no for v1 | ✅ | Decided: **YES** |
| Y12 | Create Sentry account + set `VITE_SENTRY_DSN` in prod env | ⏳ | Free tier; sentry.io → new "Browser JavaScript" project → copy DSN |
| Y3 | Generate the upload keystore + **back it up offline** | ⏳ | `RELEASE.md` §1–2. Losing it = can't ever update the app |
| Y4 | Create `android/keystore.properties` | ⏳ | `RELEASE.md` §2 (gitignored) |
| Y5 | Build signed AAB (`./gradlew bundleRelease`) | 🚧 | Needs Y3/Y4 |
| Y6 | Host `/privacy`, `/terms`, `/delete-account`, `/contact` (HTTP 200, no login wall) | ⏳ | Confirm canonical host: apex vs www |
| Y7 | Host `/.well-known/assetlinks.json` (upload + Play signing fingerprints) | 🚧 | Needs Y3 + Play App Signing enrolled |
| Y8 | Create the app in Play Console ($25 acct) | ⏳ | Together — see below |
| Y9 | Capture ≥2 phone screenshots | ⏳ | On a device/emulator; en + ur ideal |
| Y10 | Create reviewer test account + seed data | ⏳ | `RELEASE.md` §7 |
| Y11 | Recruit 12+ closed-test testers (if new personal acct) | ⏳ | **Calendar: 14 consecutive days** — start early |

## 🤝 Together — Play Console setup (you click, I guide step-by-step)

| # | Task | Status | Notes |
|---|------|--------|-------|
| T1 | App content questionnaire (privacy URL, target audience, ads=no) | ⏳ | `RELEASE.md` §8 |
| T2 | Data Safety form | ⏳ | `RELEASE.md` §9 + the 3 corrections (C9) |
| T3 | Financial-features declaration = "no financial features" | ⏳ | No-custody tracker |
| T4 | IARC content rating (Kameti = savings-rotation, not gambling) | ⏳ | Everyone rating |
| T5 | Upload AAB → closed test → (14 days) → production | ⏳ | Staged rollout |

## 💤 Deferred (post-v1 backlog)

- Android home-screen widget (native Kotlin — `docs/android-home-widget-spec.md`)
- R8/minify + ProGuard rules
- Native at-rest encryption of the local Dexie mirror
- CI release signing automation
- Maskable PWA icon polish (web-install only; not a Play blocker)

---

### Critical path (shortest route to "live")
**C4→C5** (logo) ∥ **Y1, Y2, Y3** → **Y5** (signed AAB) → **Y6/Y7** (hosting) → **Y8 + T1–T4** (Console) → **Y11** (14-day test) → **T5** (production).

The 14-day closed test (Y11) is the long pole — everything else is days, that's weeks. Start recruiting testers as soon as the AAB exists.
