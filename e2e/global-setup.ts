import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AUTH_STATE_PATH, BASE_URL, E2E_EMAIL, E2E_PASSWORD, hasCreds } from './env';
import { loginViaUi } from './loginViaUi';

// Logs the shared staging account in through the REAL AuthPage UI once per
// run, then saves the resulting session as storageState — every authenticated
// spec in this suite loads that file (via `test.use({ storageState })`)
// instead of re-authenticating. See docs/staging-environment.md: this must be
// a hisaab-staging account, never production, and docs/testing-the-trust-
// boundary.md's "E2E smoke" section for the full rule.
//
// No credentials configured is a supported, GREEN outcome: every
// authenticated spec guards itself with `test.skip(!hasCreds, ...)`, so this
// just logs a note and returns without writing a storageState file.
export default async function globalSetup(): Promise<void> {
  if (!hasCreds) {
    console.log(
      '[e2e/global-setup] E2E_EMAIL/E2E_PASSWORD not set — skipping login. ' +
        'Authenticated specs will self-skip with a clear reason.',
    );
    return;
  }

  mkdirSync(dirname(AUTH_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();
  // Explicit baseURL: a manually created context does not inherit
  // playwright.config.ts's `use.baseURL` the way the `page` test fixture does.
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();

  try {
    await loginViaUi(page, E2E_EMAIL, E2E_PASSWORD);

    // A staging account with an unconfirmed email lands on
    // UnverifiedEmailScreen (App.tsx), not the app shell. loginViaUi() only
    // confirms AuthPage itself is gone — that's also true for this screen, so
    // check for it explicitly. This is a fixture problem, not a flake: fail
    // loudly instead of silently skipping every authenticated spec for an
    // inscrutable reason.
    const unverified = await page
      .getByRole('heading', { name: /verify|email/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (unverified) {
      throw new Error(
        `[e2e/global-setup] ${E2E_EMAIL} appears to be unverified (email_confirmed_at not set). ` +
          'The E2E staging account must be pre-verified — confirm it once in Supabase Studio ' +
          '(Authentication → Users) or via a real verification email, then re-run.',
      );
    }

    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`[e2e/global-setup] Logged in as ${E2E_EMAIL}; storageState saved to ${AUTH_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}
