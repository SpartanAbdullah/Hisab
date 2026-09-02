import { defineConfig } from 'vitest/config';

// Tests cover pure functions only (math, routing, scheduling). The stores
// and DB layer talk to Supabase — those need integration tests with a
// staging instance, which we'll add later. Keep this config minimal so
// the unit suite stays fast (<1s) and dependency-light.
export default defineConfig({
  test: {
    // Node environment is fine for the pure-function suite. If we later
    // add component-level tests, switch a specific file to `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // vitest.setup.ts pins process.env.TZ = 'UTC' on its first line and pins
    // the UI language; CI additionally exports TZ=UTC at the job level. Time
    // math runs in the user's real local timezone in production, so UTC here
    // is about determinism, not fidelity — a DST-boundary regression that only
    // reproduces in Asia/Karachi will NOT be caught by this suite.
    setupFiles: ['./vitest.setup.ts'],
  },
});
