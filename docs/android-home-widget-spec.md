# Android home-screen widget — implementation spec

This is the one W7 piece that can't live in the React/Capacitor layer: a true
home-screen widget is native Android (a `AppWidgetProvider`). It's specced here
so it can be dropped into `android/app/src/main` directly.

## Goal

A small home-screen widget that delivers the app's two highest-frequency jobs
without opening Hisaab:

1. **One-tap quick-add** — tapping the widget (or its `+`) opens the app
   straight into Quick Entry / the AI quick-add bar. This is the killer use:
   log "karak 3 aed" in 2 seconds from the home screen.
2. **At-a-glance balance** — show the primary-account balance (or net) and the
   primary currency, so the user sees their money without launching anything.

Keep it calm and on-brand (Sukoon): cream surface, navy text, one accent pill
for the `+`.

## Files to add (native Android)

```
android/app/src/main/
  java/<pkg>/HisaabWidgetProvider.kt        # AppWidgetProvider subclass
  res/layout/widget_hisaab.xml              # RemoteViews layout
  res/xml/hisaab_widget_info.xml            # AppWidgetProviderInfo
  res/drawable/widget_bg.xml                # rounded cream background
```

And register the provider in `AndroidManifest.xml`:

```xml
<receiver
    android:name=".HisaabWidgetProvider"
    android:exported="false">
  <intent-filter>
    <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
  </intent-filter>
  <meta-data
      android:name="android.appwidget.provider"
      android:resource="@xml/hisaab_widget_info" />
</receiver>
```

## Data bridge (web → widget)

The widget can't call the React app. Use **`@capacitor/preferences`** (already a
dependency) which writes to Android `SharedPreferences`; the widget reads the
same store.

- In the web app, whenever the home balance changes, persist a tiny snapshot:

  ```ts
  import { Preferences } from '@capacitor/preferences';
  await Preferences.set({
    key: 'widget_snapshot',
    value: JSON.stringify({ balance: primaryTotal, currency: primaryCurrency, updatedAt: Date.now() }),
  });
  ```

  Capacitor Preferences maps to `SharedPreferences` file
  `CapacitorStorage`, key `widget_snapshot`.

- In `HisaabWidgetProvider.onUpdate`, read it:

  ```kotlin
  val prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
  val json = prefs.getString("widget_snapshot", null)
  // parse balance + currency, bind into RemoteViews
  ```

- Trigger a widget refresh from the web side after writing (optional but nice)
  by broadcasting `APPWIDGET_UPDATE`, or just let the system's periodic
  `updatePeriodMillis` (set in `hisaab_widget_info.xml`, min 30 min) refresh it.

## Deep link into quick-add

The widget's tap target opens the app on the quick-add surface. Use a
`PendingIntent` with a deep link the app already understands, or add one:

```kotlin
val intent = Intent(Intent.ACTION_VIEW, Uri.parse("hisaab://quick-add"))
val pi = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
views.setOnClickPendingIntent(R.id.widget_add, pi)
```

Web side: handle the deep link on launch (Capacitor `App.addListener('appUrlOpen', …)`),
and route to Quick Entry. A `hisaab://quick-add` scheme needs an
`<intent-filter>` with `<data android:scheme="hisaab" android:host="quick-add"/>`
on the main activity.

## Acceptance

- Widget shows the cached balance + currency, updated within ~30 min of a change.
- Tapping it opens Hisaab directly in Quick Entry.
- Renders correctly in light and dark (the widget uses its own colors — provide
  a `night/` variant of `widget_bg.xml` + text colors mirroring the dark tokens
  in `src/index.css`).

## Why it's not in this repo

Capacitor bundles a web app inside a WebView; it has no API for OS home-screen
widgets. This must be authored in the native Android project and built via
Android Studio / Gradle — outside the JS build this repo runs.
