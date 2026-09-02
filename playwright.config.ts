import { defineConfig, devices } from '@playwright/test';

// Pin the timezone for anything Node-side in this config/tests (date
// formatting, retry logic, etc.) — mirrors vitest.setup.ts's TZ pin so E2E
// runs don't drift with the host machine's local zone. The browser's own
// clock is pinned separately via `use.timezoneId` below.
process.env.TZ = process.env.TZ || 'UTC';

// `E2E_BASE_URL` overrides the target (default: the repo's own Vite dev
// server). `E2E_WEB_SERVER_CMD` overrides how Playwright brings that target
// up (default: `npm run dev`) — .github/workflows/e2e.yml points this at
// `npm run build && npx vite preview --port 4173` and E2E_BASE_URL at
// `http://localhost:4173`, so CI exercises the production build rather than
// the dev server. `E2E_SKIP_WEBSERVER=1` skips starting anything at all, for
// the case where E2E_BASE_URL already points at something running outside
// Playwright's control (a staging/preview deployment — see
// docs/staging-environment.md §2).
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const webServerCommand = process.env.E2E_WEB_SERVER_CMD || 'npm run dev';
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A shared, real Supabase account (see docs/staging-environment.md) backs
  // every authenticated spec — parallel workers would race the same rows
  // (PIN set/remove, transaction create/delete). One worker keeps the suite
  // deterministic; it is still fast (a handful of specs).
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
    timezoneId: 'UTC',
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: webServerCommand,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
