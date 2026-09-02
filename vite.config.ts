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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
})
