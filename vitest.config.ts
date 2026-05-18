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
    // Time math runs in the user's local timezone in production. Pinning
    // to UTC in CI keeps DST-boundary assertions deterministic.
    setupFiles: ['./vitest.setup.ts'],
  },
});
