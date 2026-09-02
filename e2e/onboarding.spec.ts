import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH, hasCreds, SKIP_NO_CREDS_REASON } from './env';
import { I18N } from './i18n-strings';

// src/stores/onboardingStore.ts marks a profile onboarded FOREVER
// (`profiles.onboarding_completed = true`, checked server-side on every
// boot) — there is no "reset onboarding" affordance in the product. On a
// reused staging account this screen is only reachable the very first time
// this suite ever logs that account in; every run after that lands straight
// on the app shell. That is treated the same way missing credentials are —
// a clear, honest runtime skip, not a failure — via the mid-test
// `test.skip(...)` below.
test.describe('Onboarding', () => {
  test.skip(!hasCreds, SKIP_NO_CREDS_REASON);
  test.use({ storageState: AUTH_STATE_PATH });

  test('choosing splits_only during onboarding lands on home', async ({ page }) => {
    await page.goto('/');

    const nav = page.getByRole('navigation');
    const onboardStart = page.getByRole('button', { name: I18N.onboard_start.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.onboard_start.en, exact: true }));

    await Promise.race([
      nav.waitFor({ state: 'visible', timeout: 20_000 }),
      onboardStart.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);

    test.skip(
      await nav.isVisible(),
      'This staging account has already completed onboarding (profiles.onboarding_completed is permanent) — the onboarding gate is not reachable again from the UI.',
    );

    // Step 0: Welcome.
    await onboardStart.click();

    // Step 1: Name (required to advance).
    await page.getByPlaceholder('e.g. Ahmed, Faizan, Bilal').fill('Hisaab E2E');
    await page.getByRole('button', { name: I18N.onboard_next.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.onboard_next.en, exact: true }))
      .click();

    // Step 2: Intent — skip it, we're choosing the mode explicitly at step 4.
    await page.getByRole('button', { name: I18N.onboard_intent_skip.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.onboard_intent_skip.en, exact: true }))
      .click();

    // Step 3: Safety reassurance.
    await page.getByRole('button', { name: I18N.onboard_safety_btn.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.onboard_safety_btn.en, exact: true }))
      .click();

    // Step 4: Mode quiz — skip straight to the mode cards, pick Splits Only.
    await page.getByRole('button', { name: I18N.quiz_skip.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.quiz_skip.en, exact: true }))
      .click();
    await page.getByRole('button').filter({ hasText: I18N.mode_splits_title.ur }).first().click();
    await page.getByRole('button', { name: I18N.onboard_next.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.onboard_next.en, exact: true }))
      .click();

    // Step 5 (splits_only): the whole "Fresh Start" card is the one button —
    // splits_only needs no account, so this finishes onboarding directly.
    await page
      .getByRole('button')
      .filter({ hasText: I18N.onboard_fresh_title.ur })
      .or(page.getByRole('button').filter({ hasText: I18N.onboard_fresh_title.en }))
      .first()
      .click();

    // Landed on the app shell: BottomNav mounts, and splits_only shows the
    // Activity tab (full_tracker shows Loans in that slot instead — see
    // src/components/BottomNav.tsx) — a functional confirmation the chosen
    // mode actually took, not just that SOME home screen rendered.
    await expect(nav).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: I18N.nav_activity.en })).toBeVisible();
  });
});
