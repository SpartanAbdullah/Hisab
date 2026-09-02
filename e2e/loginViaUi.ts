import type { Page } from '@playwright/test';
import { I18N } from './i18n-strings';

/**
 * Log in through the real AuthPage UI (src/pages/AuthPage.tsx) — there is no
 * API shortcut here on purpose: this is meant to exercise the same form a
 * real user fills in, per docs/testing-the-trust-boundary.md's E2E rule.
 * Shared by global-setup.ts (the primary E2E_EMAIL account, once per run)
 * and cross-user-loan.spec.ts (a throwaway login for the second account,
 * inside its own short-lived context).
 *
 * Throws with a diagnosable message rather than timing out silently — a
 * broken login is a real regression signal for this suite, not something to
 * paper over with a skip.
 */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/', { waitUntil: 'load' });
  await page.locator('#auth-email').waitFor({ state: 'visible', timeout: 30_000 });

  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);

  const loginButton = page.getByRole('button', {
    name: new RegExp(`${I18N.auth_cta_login.ur}|${I18N.auth_cta_login.en}`),
  });
  await loginButton.click();

  await page
    .locator('#auth-email')
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => {
      /* handled by the still-visible check below */
    });

  if (await page.locator('#auth-email').isVisible().catch(() => false)) {
    const alertText = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    throw new Error(
      `[e2e/loginViaUi] Login did not leave AuthPage for ${email}. ` +
        (alertText
          ? `Error shown on screen: "${alertText.trim()}".`
          : 'No error text found — check the credentials for this hisaab-staging account.'),
    );
  }
}
