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
| C4 | Design the consistent Hisaab logo (pick a concept) | ✅ | "Single Wink" chosen 2026-07-07 (green #2FE3A0 tile, ink stroke "h" + wink — see docs/brand/LOGO_HANDOFF.md); replaced Concept A (navy squircle, cream H, violet bar) |
| C5 | Produce ALL icon assets from the chosen logo | ✅ | favicon, PWA (+ real maskable), apple-touch, Android mipmaps, in-app mark — via `scripts/generate-icons.mjs` |
| C6 | Hardware back button closes an open modal first | ✅ | Done; **verify on device** (RELEASE.md smoke test) |
| C7 | Draft Play store listing copy (short + full description) | ✅ | `docs/play-store-listing.md` — en + Roman-Urdu + release notes + ASO keywords |
| C8 | Draft the 1024×500 feature graphic (SVG) | ⏳ | You export to PNG |
| C9 | Correct the Data Safety doc details (phone, Sentry) | ✅ | Phone=collected, crash logs=shared w/ Sentry. Verified: **no user ID is sent to Sentry** (capability dormant) |
| C10 | Sentry wiring matches final decision | ✅ | Code wired (reads `VITE_SENTRY_DSN`); you provide the DSN (Y12) |

## 🧑 You — operational, hosting & Play Console (only you can do these)

| # | Task | Status | Notes |
|---|------|--------|-------|
| Y1 | Run `supabase-p0-security-verification.sql` in prod | ⏳ | Expect: "P0 security catalog verification passed" |
| Y2 | Decide: Sentry crash reporting yes/no for v1 | ✅ | Decided: **YES** |
| Y12 | Create Sentry account + set `VITE_SENTRY_DSN` in prod env | ✅ | DSN added to local `.env`; dashboard shows "Waiting for first event" |
| Y3 | Generate the upload keystore + **back it up offline** | ✅ | `hisaab-upload.jks` created, backed up to Google Drive. Cert: `CN=abdullah … C=AE` |
| Y4 | Create `android/keystore.properties` | ✅ | Filled with the upload password (gitignored) |
| Y5 | Build signed AAB (`./gradlew bundleRelease`) | ✅ | **`app-release.aab` (3.4 MB)**, signed with the upload key. Built in user's own terminal (agent sandbox blocks Gradle's loopback socket) |
| Y6 | Host `/privacy`, `/terms`, `/delete-account`, `/contact` (HTTP 200, no login wall) | ⏳ | Confirm canonical host: apex vs www |
| Y7 | Host `/.well-known/assetlinks.json` (upload + Play signing fingerprints) | 🚧 | Needs Play App Signing enrolled. **Upload-key SHA-256:** `0B:B6:45:86:3D:98:A4:E4:91:10:D5:FD:F0:66:34:F4:EA:FE:2D:71:08:77:02:F1:C5:93:5B:82:9D:47:6D:A5` |
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
