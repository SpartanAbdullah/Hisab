# Android (Capacitor) Setup

The existing `android/` folder is a partial stub from an earlier scaffold attempt and is missing key files (`AndroidManifest.xml`, Java sources, gradle wrappers). Regenerate it cleanly before building.

## One-time setup

```powershell
# 1. Close Android Studio + any process holding the android/ folder.
# 2. Wipe the stub and regenerate via Capacitor:
Remove-Item -Recurse -Force android
npx cap add android

# 3. Build the web bundle + copy it into the Android project:
npm run cap:sync

# 4. (Optional) Open in Android Studio to inspect / run on a device:
npm run cap:open:android
```

## Required AndroidManifest.xml patches

After `cap add android`, edit `android/app/src/main/AndroidManifest.xml` and:

### Inside the `<application>` tag — set the launch background
```xml
<application
    android:allowBackup="true"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    android:roundIcon="@mipmap/ic_launcher_round"
    android:supportsRtl="true"
    android:theme="@style/AppTheme">
```

### Inside the `MainActivity` `<activity>` tag — add deep links
Add this `<intent-filter>` immediately after the launcher one:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="hisaab.yourdomain.com" />
    <data android:pathPrefix="/join/" />
</intent-filter>
```

Replace `hisaab.yourdomain.com` with your production host. The capacitor.config.ts already wires `appUrlOpen` → react-router so `/join/:token` resolves automatically.

### `android/app/src/main/res/values/colors.xml`
Set the splash/background colour to Sukoon navy:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#0B0E2A</color>
    <color name="colorPrimaryDark">#0B0E2A</color>
    <color name="colorAccent">#0B0E2A</color>
    <color name="splash_background">#0B0E2A</color>
</resources>
```

### Verify Site URL on Play Store (Digital Asset Links)
When you publish to Play Store, the `android:autoVerify="true"` on the deep-link filter only works if your domain hosts an `assetlinks.json` file at `https://hisaab.yourdomain.com/.well-known/assetlinks.json`. Use the [Asset Links Tool](https://developers.google.com/digital-asset-links/tools/generator) to generate it. Without this, deep links open in a chooser rather than directly in the app.

## Native plugins already wired

All initialised by `src/lib/nativeBridge.ts` (no-op on web):

- **`@capacitor/app`** — hardware back-button handler. Without this, every Android back press exits the app immediately.
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
