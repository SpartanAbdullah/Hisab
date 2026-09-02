import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app's own version, read straight from package.json and substituted into
// the bundle as `__APP_VERSION__` (typed in src/vite-env.d.ts). This is what
// the minimum-supported-version gate compares on web — see src/lib/versionGate.ts
// and supabase-migration-p1-app-config.sql. Android compares versionCode from
// android/app/build.gradle instead, read at runtime via @capacitor/app.
//
// Read with fs rather than `import pkg from './package.json'` so the JSON never
// enters the module graph (no resolveJsonModule, no bundled copy of the file).
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version?: string }

// Vendor chunk splitting (P2 M2a, docs/audit-2026-09/03-performance.md H1).
//
// Without this, every vendor dependency (react, supabase-js, dexie, recharts,
// jspdf, ...) gets bundled into the same entry chunk as our own app code, so a
// one-line app change invalidates ~1.2 MB of code the CDN could otherwise have
// cached across deploys unchanged. This groups node_modules code by package
// into stable, independently-cacheable chunks.
//
// Heavy/rare libraries (recharts, jspdf, modern-screenshot, jsqr,
// qrcode-generator) are already behind either a lazy route (AnalyticsPage) or
// a `await import(...)` inside src/lib (renderNodeToImage.ts, QRScanner.tsx) —
// see docs/performance.md for the grep that confirmed this — so they do NOT
// end up in the entry chunk regardless of this config. Naming them here just
// gives their already-split chunks stable, cacheable names instead of Rollup's
// auto-generated per-entry chunks, and keeps them from being duplicated across
// multiple async entry points.
//
// posthog-js is intentionally NOT listed: it's reached only via a dynamic
// `import('posthog-js')` in src/lib/telemetry.ts behind a consent/DSN gate,
// and Rollup already code-splits it into its own async chunk on its own.
// Naming it here risks changing when/how eagerly that chunk gets fetched, so
// it's left to Rollup's default per-dynamic-import chunking (per the M2a task
// note: "do not break that").
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  const norm = id.replace(/\\/g, '/')

  if (
    norm.includes('/node_modules/react/') ||
    norm.includes('/node_modules/react-dom/') ||
    norm.includes('/node_modules/react-router/') ||
    norm.includes('/node_modules/react-router-dom/') ||
    norm.includes('/node_modules/scheduler/')
  ) {
    return 'vendor-react'
  }
  if (norm.includes('/node_modules/@supabase/')) return 'vendor-supabase'
  if (norm.includes('/node_modules/dexie/')) return 'vendor-dexie'
  if (norm.includes('/node_modules/recharts/')) return 'vendor-recharts'
  if (norm.includes('/node_modules/jspdf/')) return 'vendor-jspdf'
  if (norm.includes('/node_modules/modern-screenshot/')) return 'vendor-modern-screenshot'
  if (norm.includes('/node_modules/jsqr/') || norm.includes('/node_modules/qrcode-generator/')) {
    return 'vendor-qr'
  }
  if (norm.includes('/node_modules/lucide-react/')) return 'vendor-lucide'
  if (norm.includes('/node_modules/date-fns/')) return 'vendor-date-fns'

  return undefined
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
    modulePreload: {
      // Filter the <link rel="modulepreload"> hints Vite/Rolldown emits into
      // index.html. Without this, grouping the rare, dynamically-imported
      // vendor libs above into their own named chunks made the bundler's
      // preload-dependency analysis start eagerly modulepreloading
      // vendor-jspdf (measured 2026-09-02: it appeared in index.html's head
      // even though jspdf is only ever reached via `await import('jspdf')`
      // inside src/lib/renderNodeToImage.ts — see docs/performance.md). That
      // defeats the whole point of splitting it out: every cold boot would
      // fetch+parse a ~400 kB chunk nobody asked for. Explicitly excluding
      // the heavy/rare vendor chunk names here keeps them fetched only when
      // the dynamic import that needs them actually runs, regardless of what
      // the bundler's default preload heuristic decides.
      resolveDependencies: (_filename, deps, { hostType }) => {
        if (hostType !== 'html') return deps
        const neverPreload = [
          'vendor-jspdf',
          'vendor-recharts',
          'vendor-modern-screenshot',
          'vendor-qr',
          'html2canvas',
        ]
        return deps.filter((dep) => !neverPreload.some((name) => dep.includes(name)))
      },
    },
    // Default is 500 kB (raw, pre-gzip). After manualChunks above, every
    // chunk in the build already falls under that default (measured
    // 2026-09-02: entry 281.76 kB, largest chunk overall vendor-jspdf at
    // 401.07 kB — a lazy chunk only loaded when a PDF is generated). Rather
    // than leave the stock 500 kB as an accident, it's set here deliberately
    // at 450 kB: comfortably above today's largest chunk (~12% headroom for
    // routine growth) while still failing the build's warning the moment a
    // genuinely new heavy dependency lands uncontrolled. See
    // docs/performance.md for the full before/after chunk table and
    // scripts/check-bundle-size.mjs for the enforced (not just warned) entry
    // chunk budget.
    chunkSizeWarningLimit: 450,
  },
})
