# Android (Capacitor) Setup

The checked-in `android/` project is a reproducible Capacitor wrapper for package
ID `com.usehisaab.app`. Do not commit `local.properties`, Gradle caches, copied web
assets, APKs, AABs, or signing keystores.

## Build setup

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

# Build the web bundle and copy it into the ignored Android asset folder.
npm run cap:sync

# Produce an ignored release bundle for local verification.
cd android
.\gradlew.bat bundleRelease
```

The local release bundle is written to
`android/app/build/outputs/bundle/release/app-release.aab`.

## App Links (deep links) — assetlinks.json

The App Links intent filter is **already live** in
`android/app/src/main/AndroidManifest.xml` (`android:autoVerify="true"`,
covering `https://usehisaab.com/join/*`, `/u/*`, and `/kameti/witness/*` —
these three match the app's actual public-link routes in `src/App.tsx`).
`capacitor.config.ts` + `src/lib/nativeBridge.ts` already wire both
`appUrlOpen` (warm start) and `App.getLaunchUrl()` (cold start) through to
react-router, so once verification passes, tapping any of those links —
killed app or not — opens straight into Hisaab.

What's still missing is the file Android checks to verify the app is allowed
to claim those URLs: **`public/.well-known/assetlinks.json`**. It's checked
into the repo with placeholder fingerprints — until both are filled in with real
values, every one of these links keeps falling back to opening in the browser
(graceful, but not the real experience). **Status 2026-09-05: slot 0 (the
upload key, `0B:B6:…:6D:A5`, read from `hisaab-upload.jks` with `keytool`) is
filled in; slot 1 still carries `REPLACE_WITH_PLAY_SIGNING_KEY_SHA256` and can
only be filled after the first Play upload (step 2 below).**

### 1. Get the upload-key fingerprint

This is the key you sign the AAB with locally (`android/app/hisaab-upload.jks`,
gitignored — see `RELEASE.md` §§1-2 if it doesn't exist yet):

```bash
keytool -list -v -keystore android/app/hisaab-upload.jks -alias hisaab-upload
```

Copy the `SHA256:` line (the colon-separated hex string) into
`sha256_cert_fingerprints[0]` in `public/.well-known/assetlinks.json`, in
place of `REPLACE_WITH_UPLOAD_KEY_SHA256`.

### 2. Get the Play App Signing fingerprint

Play re-signs the app with its own key before distributing it, so the
upload-key fingerprint alone is not enough once the app is live — Play's key
must be listed too, or every device that installed from the Play Store (as
opposed to a sideloaded AAB) fails verification.

1. Play Console → your app → **Setup → App integrity → App signing**.
2. Copy the **"App signing key certificate" → SHA-256 certificate fingerprint**.
3. Paste it into `sha256_cert_fingerprints[1]`, in place of
   `REPLACE_WITH_PLAY_SIGNING_KEY_SHA256`.

This value doesn't exist until the app has been uploaded to Play at least
once and Play App Signing is enrolled — until then, the upload-key
fingerprint alone verifies sideloaded/local-signed AABs, and the Play-key
slot stays a placeholder (invalid values in the array are simply ignored by
the verifier, so a leftover placeholder doesn't break verification of the
other entry).

### 3. Deploy and confirm it's served correctly

`public/` deploys as-is to `usehisaab.com` on Vercel (no build step needed
for static files), so pushing the updated JSON to `main` is enough. **Confirm
after deploy** that Vercel is serving it as a static file, not falling
through the SPA catch-all rewrite in `vercel.json`
(`{ "source": "/(.*)", "destination": "/index.html" }`) — Vercel's static
filesystem match normally wins over rewrites, but this has not been verified
in production for this project:

```bash
curl -sI https://usehisaab.com/.well-known/assetlinks.json
```

Expect `HTTP/2 200` and `content-type: application/json` (or
`application/json; charset=utf-8`) — **not** `text/html`. If it comes back as
HTML, the rewrite is winning and needs an explicit exception added to
`vercel.json`'s `rewrites` (e.g. exclude `/.well-known/*`) or a `routes`
override.

### 4. Verify with Google's tool ("Statement List" tester)

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://usehisaab.com&relation=delegate_permission/common.handle_all_urls
```

This is the same endpoint Android itself calls to verify the link on
install. It should return a JSON `statements` array listing
`com.usehisaab.app` with the fingerprints from the file. If it's empty or
errors, fix the file before testing on-device — verification will silently
keep failing and links will keep opening the browser.

### 5. Verify on a real device

1. Install a release-signed build (App Links verification is skipped for
   debug-signed builds on some OS versions).
2. Send yourself an invite link (`/join/...`) via WhatsApp — or a kameti
   witness link (`/kameti/witness/...`) — and tap it **with the app fully
   killed** (swipe it away first; this is the cold-start path fixed by
   `App.getLaunchUrl()` in `nativeBridge.ts`, not just the warm-start
   `appUrlOpen` path).
3. It should open directly into Hisaab at that route, no chooser dialog, no
   browser. If it still opens the browser, re-run step 4's query — Android
   caches a failed verification and can take a reboot or
   `adb shell pm verify-app-links --re-verify com.usehisaab.app` to retry.

### `android/app/src/main/res/values/colors.xml`
Splash/background colour, Sukoon navy — already set in the checked-in
resources; only relevant if you're regenerating this file from a fresh
`cap add android`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#0B0E2A</color>
    <color name="colorPrimaryDark">#0B0E2A</color>
    <color name="colorAccent">#0B0E2A</color>
    <color name="splash_background">#0B0E2A</color>
</resources>
```

## Native plugins already wired

All initialised by `src/lib/nativeBridge.ts` (no-op on web):

- **`@capacitor/app`** — hardware back-button handler, plus deep-link routing: `appUrlOpen` (warm start) AND `App.getLaunchUrl()` (cold start — app was killed) both route into react-router, deduped. Without this, every Android back press exits the app immediately, and (before the cold-start fix) a killed-app invite tap silently dropped the token.
- **`@capacitor/status-bar`** — status bar colour locked to Sukoon navy with light icons.
- **`@capacitor/splash-screen`** — auto-hides after React first paint.
- **`@capacitor/keyboard`** — `native` resize mode (WebView resizes when keyboard opens).
- **`@capacitor/preferences`** — available for future native key-value storage (currently unused).

## What `npm run cap:sync` does

1. Runs `vite build` to refresh `dist/`.
2. Runs `npx cap sync android` which:
   - Copies `dist/` → `android/app/src/main/assets/public/`
   - Updates `capacitor.config.json` inside the Android project
   - Re-pulls plugin native code

Run this every time you change web code that you want to ship to the device.

## Building a release APK / AAB

```powershell
# Open in Android Studio, then: Build → Generate Signed Bundle / APK.
# Or, headless:
cd android
./gradlew bundleRelease    # produces app/build/outputs/bundle/release/app-release.aab
```

Sign with your release keystore (Play Store requires this). Do **not** commit the keystore to git.

## Known gotchas

- The default `MainActivity.java` after `cap add android` does **not** need editing — Capacitor handles routing via the bridge.
- If splash screen hangs, comment out the `SplashScreen.hide()` call in `nativeBridge.ts` and let `launchAutoHide: true` in `capacitor.config.ts` handle timing.
- Status bar colour only takes effect after the first paint; the static `<meta name="theme-color">` in `index.html` covers the brief pre-paint window.
- Back button does not currently close modals before going back — modals are click-outside-to-close already, so the priority is keeping the app from exiting on accidental back presses. Add a modal-aware `canGoBack` later if needed.
