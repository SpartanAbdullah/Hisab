# Native crash reporting for the Android app

**Status:** decided, NOT applied. Nothing in this document has been installed —
`package.json` and `android/` are untouched. Apply in the next native change
window (the one where you are already running Gradle and shipping an AAB).

**Why this exists:** audit 2026-09 `13-engineering-standards.md §2.3` —
*"No native crash reporting — HIGH for a mobile-first app. A webview process
crash, ANR, or plugin-layer failure on the primary target platform is
invisible."* Today only JavaScript errors inside the WebView reach Sentry
(`src/lib/sentryReporter.ts`). Everything below the WebView — a native crash in
a Capacitor plugin, an OOM kill, an ANR, a Play-vitals-affecting freeze — is
dark. Play Console's own vitals dashboard sees some of it, but with no stack,
no user id, no release correlation and no link to the `feature` tags that H1
just wired into the money layer.

---

## Decision

**Adopt `@sentry/capacitor` (currently 4.3.0).** It is a *conditional* drop-in:
every version constraint checks out on paper, but it ships native Android code
and therefore cannot be proven without a real Gradle build, which does not run
inside the agent sandbox. Treat the checklist in §4 as part of the change.

Fallback if the Capacitor 8 native build fails: **Firebase Crashlytics**
(§5) — cheaper to wire (the `com.google.gms:google-services` classpath and
`firebase-messaging` are already in `android/build.gradle` /
`android/variables.gradle` for push), but it splits observability across two
dashboards and cannot see the `feature` tags.

---

## 1. Compatibility evidence

Checked against the registry on 2026-09-02 (`npm view`, read-only — nothing
was installed):

| Constraint | `@sentry/capacitor@4.3.0` wants | This repo has | Verdict |
|---|---|---|---|
| `@sentry/browser` | `10.69.0` (hard **dependency**, exact) | `^10.54.0` (resolved 10.54.0) | ✅ `^10.54.0` **includes** 10.69.0, so npm hoists a single copy — see the dedup warning below |
| `@sentry/core` | `10.69.0` (dependency) | transitively 10.54.0 | ✅ same hoist |
| `@capacitor/core` | `>=3.0.0` (peer) | `^8.3.4` | ✅ satisfied — but see the Capacitor 8 caveat |
| `@sentry/react` / `angular` / `vue` | peers, **all optional** (`peerDependenciesMeta`) | none installed | ✅ this repo uses the plain `@sentry/browser` sibling |
| `minSdkVersion` (sentry-android) | 21 | 24 (`android/variables.gradle`) | ✅ |
| AGP | 8.x | `8.13.0` (`android/build.gradle`) | ✅ |

### The one real risk: two copies of `@sentry/browser`

`@sentry/capacitor` depends on an **exact** `@sentry/browser@10.69.0`. If
`package.json` still says `^10.54.0` *and* the lockfile pins 10.54.0, npm may
install a **nested** second copy under `node_modules/@sentry/capacitor/`. Two
copies = two independent Sentry clients: `Sentry.init` runs on one and every
`reportError` call in the app runs on the other, so **the JS events silently
stop arriving** while native crashes keep working. This is the classic way this
integration goes wrong.

Mitigation is mandatory and is why Sentry's own docs say `--exact`:

```jsonc
// package.json — pin BOTH, no carets
"@sentry/browser": "10.69.0",
"@sentry/capacitor": "4.3.0",
```

then verify (§4 step 3) that `npm ls @sentry/browser` prints exactly one entry.

### The Capacitor 8 caveat

`>=3.0.0` is a permissive peer range; sentry-capacitor 4.x was developed
against Capacitor 6/7. Nothing indicates a break — Capacitor's Android plugin
contract is stable and the plugin consumes `android/variables.gradle` the same
way every other plugin here does — but "the peer range allows it" is not the
same as "someone has built it against Capacitor 8.3". The first
`gradlew bundleRelease` after `cap sync` is the actual proof.

---

## 2. Exact steps

### 2.1 Install (one command, user runs it)

```bash
npm install --save-exact @sentry/capacitor@4.3.0 @sentry/browser@10.69.0
npx cap sync android
```

`cap sync` auto-registers the plugin's Android module — Capacitor discovers
plugins from `package.json` and writes them into
`android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle`.

### 2.2 Gradle changes: **none required**

- No manual `implementation` line — `cap sync` handles it.
- No `minSdkVersion` bump — 24 already exceeds sentry-android's 21.
- No Sentry Android Gradle plugin (`io.sentry.android.gradle`). Its jobs are
  ProGuard-mapping upload and NDK symbolication; `minifyEnabled` is **false**
  in `android/app/build.gradle`, so release stacks are already unobfuscated and
  the plugin would buy nothing today. Revisit it in the same change that turns
  R8 on.
- No CSP change. `index.html` already allows
  `https://*.ingest.de.sentry.io` in `connect-src`, and native events leave the
  device over the Android SDK's own HTTP client anyway (CSP does not apply).

Verify after `cap sync` that `android/app/capacitor.build.gradle` gained a
`project(':sentry-capacitor')` entry. If it did not, the plugin did not
register and the build will be JS-only.

### 2.3 Init code — the whole diff

`@sentry/capacitor` wraps the sibling SDK: you call **its** `init` and pass the
browser SDK's `init` as the second argument. It then starts the native layer
and forwards JS events through it. `src/main.tsx` does not change at all —
`initSentry()` keeps its signature and still returns `ErrorReporter | null`, so
the noop/console fallback when no DSN is set is preserved exactly.

The block below is already present, commented out, at the top of
`src/lib/sentryReporter.ts`. Applying the change is: swap the two imports,
swap the one `Sentry.init(...)` call, delete the comment markers.

```ts
// ── imports ──────────────────────────────────────────────────────────────
- import * as Sentry from '@sentry/browser';
+ import * as Sentry from '@sentry/capacitor';
+ import { init as browserInit } from '@sentry/browser';

// ── inside initSentry(), replacing the current Sentry.init({...}) call ────
- Sentry.init({
-   dsn,
-   environment: import.meta.env.MODE,
-   tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
-   sendDefaultPii: false,
-   ignoreErrors: [ /* unchanged */ ],
- });
+ Sentry.init(
+   {
+     dsn,
+     environment: import.meta.env.MODE,
+     tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
+     sendDefaultPii: false,
+     // Native-only knobs. `enableNative` is a no-op on web, so ONE build
+     // still ships to both Vercel and the Capacitor wrapper.
+     enableNative: true,
+     // ANRs are the failure the Play vitals dashboard flags and we cannot
+     // currently explain. This is the single biggest win of the change.
+     anrEnabled: true,
+     // The WebView process dying takes the JS handlers with it, so this one
+     // can ONLY be caught natively.
+     enableWatchdogTerminationTracking: true,
+     ignoreErrors: [ /* unchanged */ ],
+   },
+   browserInit,
+ );
```

Everything below that line in `sentryReporter.ts` — `applyContext`,
`captureException`, `captureMessage`, the `feature` tag, the fingerprint —
keeps working unchanged: `@sentry/capacitor` re-exports the same
`withScope` / `captureException` / `captureMessage` surface.

### 2.4 Release health (do this in the same change)

Set the release identifier so a native crash can be attributed to an AAB:

```ts
release: `hisaab@${import.meta.env.VITE_APP_VERSION ?? 'dev'}`,
dist: import.meta.env.VITE_ANDROID_VERSION_CODE,   // matches versionCode
```

`android/app/build.gradle` currently hardcodes `versionCode 1` /
`versionName "1.0.0"`; `docs/updating-the-android-app.md` is where those get
bumped. Without a matching `release`/`dist`, every native crash from every
build collapses into one issue.

---

## 3. What this buys, concretely

| Failure | Today | After |
|---|---|---|
| JS error in a store / money mutation | ✅ Sentry (H1 wired ~70 sites) | ✅ unchanged |
| WebView process crash / OOM kill | ❌ invisible | ✅ native event |
| ANR (main-thread freeze) | ⚠️ Play vitals count only, no stack | ✅ ANR event with thread dump |
| Crash inside a Capacitor plugin (push, filesystem, local-notifications) | ❌ invisible | ✅ native stack |
| Startup crash before the WebView loads | ❌ invisible | ✅ native event |

The last row matters most: a crash before `main.tsx` runs is *by construction*
unreportable from JS, and it is also the crash class that produces a 1-star
"app won't open" review with no diagnostic trail.

---

## 4. Verification checklist (the lead runs this)

1. `npm install --save-exact @sentry/capacitor@4.3.0 @sentry/browser@10.69.0`
2. `npm run build` — must stay clean (`tsc -b` + vite).
3. **`npm ls @sentry/browser` → exactly ONE entry at 10.69.0.** Two entries
   means the nested-copy trap in §1; fix by pinning, then
   `rm -rf node_modules package-lock.json && npm install`.
4. `npx cap sync android`, then confirm `android/app/capacitor.build.gradle`
   contains `sentry-capacitor`.
5. `cd android && ./gradlew bundleRelease` **in the user's own PowerShell** —
   Gradle needs a localhost socket and fails inside the agent sandbox
   ("Unable to establish loopback connection"). This is the step that actually
   proves Capacitor 8 compatibility.
6. On a device: trigger a JS error → confirm it still arrives *and still
   carries the `feature` tag* (this is the regression that the nested-copy trap
   causes). Then force a native crash and confirm a second, native-typed event.
7. Web smoke test on Vercel — `enableNative` must be inert in the browser and
   the DSN-absent path must still fall back to the console reporter.
8. Update `docs/privacy-data-safety-inventory.md` and
   `docs/play-store-data-safety.md`: the native SDK collects device model, OS
   version and (with `anrEnabled`) thread state. `sendDefaultPii: false` still
   applies, so no email/IP, but the *crash-log* Play data-safety category must
   be declared honestly.

---

## 5. Fallback: Firebase Crashlytics

Only if step 5 above fails and cannot be resolved quickly.

- `android/build.gradle`: add
  `classpath 'com.google.firebase:firebase-crashlytics-gradle:3.0.6'`
  (the `com.google.gms:google-services:4.4.4` classpath is already there).
- `android/app/build.gradle`: `apply plugin: 'com.google.firebase.crashlytics'`
  and `implementation 'com.google.firebase:firebase-crashlytics'`.
- `google-services.json` is already wired for push, so no new Firebase project.

Trade-off: covers native crashes and ANRs well, requires **zero** JS changes
and carries **zero** risk to the existing Sentry pipeline — but it is a second
dashboard with no `feature` tag, no user id correlation, and no link between "a
native crash happened" and "this user's `mutationSafety.rollback.
compensationFailed` fired 40 seconds earlier". That correlation is the entire
point of the H1 work, which is why Sentry is the primary recommendation.

---

## 6. Open risks

- **Unproven native build.** Nothing here has been compiled. §4 step 5 is the
  gate; everything before it is desk-checked only.
- **`@sentry/browser` bump 10.54 → 10.69** rides along with this change. Minor
  version, same major, no known breaking change — but it is a real dependency
  bump in the same PR as a native integration, so keep it as its own commit so
  it can be reverted independently.
- **Quota.** Native crashes are a *new* event stream on the same DSN. The
  de-dupe added in `errorReporter.ts` protects the JS side only; native events
  bypass it entirely. Watch the quota for the first week after release and set
  `tracesSampleRate` to 0 if tracing is still buying nothing
  (`10-product-analytics.md` F6).
- **`package.json` ownership.** The install line touches a file this task did
  not own. It is deliberately left to the lead.
