# Android (Capacitor) Setup

The checked-in `android/` project is a reproducible Capacitor wrapper for package
ID `com.hisaab.app`. Do not commit `local.properties`, Gradle caches, copied web
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

## Optional App Links patch

Add this only after `https://usehisaab.com/.well-known/assetlinks.json` is
published as JSON without redirects. App Links are not required for the base
Capacitor wrapper to build.

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
    <data android:scheme="https" android:host="usehisaab.com" />
    <data android:pathPrefix="/join/" />
</intent-filter>
```

The capacitor.config.ts already wires `appUrlOpen` → react-router so `/join/:token` resolves automatically.

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
When you publish to Play Store, the `android:autoVerify="true"` on the deep-link filter only works if your domain hosts an `assetlinks.json` file at `https://usehisaab.com/.well-known/assetlinks.json`. Use the [Asset Links Tool](https://developers.google.com/digital-asset-links/tools/generator) to generate it. Without this, deep links open in a chooser rather than directly in the app.

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
