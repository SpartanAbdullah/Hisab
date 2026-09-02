import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH, hasCreds, SKIP_NO_CREDS_REASON } from './env';
import { I18N } from './i18n-strings';
import { gotoAppShell } from './helpers';

// The device PIN (src/stores/authStore.ts, src/lib/pinCrypto.ts) is stored
// entirely in this browser's own localStorage — never on the account/server —
// so there is nothing to leak or contaminate between runs or between other
// specs in this suite even if a step here fails partway: each test gets a
// fresh Playwright context loaded from AUTH_STATE_PATH, which itself was
// captured at login time in global-setup.ts, long before any PIN existed.
// The whole set → lock → unlock → remove cycle lives in ONE test so the same
// context (and therefore the same localStorage) carries across the reload.
test.describe('Settings — device PIN lock', () => {
  test.skip(!hasCreds, SKIP_NO_CREDS_REASON);
  test.use({ storageState: AUTH_STATE_PATH });

  test('set a PIN, reload into the lock screen, unlock, then remove it', async ({ page }) => {
    await gotoAppShell(page);

    await page.goto('/settings');
    await page
      .getByRole('button', { name: I18N.settings_set_pin.ur })
      .or(page.getByRole('button', { name: I18N.settings_set_pin.en }))
      .click();

    const pin1 = page.getByPlaceholder(I18N.pin_set_title.ur).or(page.getByPlaceholder(I18N.pin_set_title.en));
    const pin2 = page.getByPlaceholder(I18N.pin_confirm.ur).or(page.getByPlaceholder(I18N.pin_confirm.en));
    await pin1.fill('1234');
    await pin2.fill('1234');
    await page.getByRole('button', { name: I18N.set_pin_save.ur, exact: true }).click();

    // The PIN setup form collapses back to the Change/Remove PIN buttons —
    // confirms the app-side state (hasPin) actually flipped before we reload.
    await expect(
      page.getByRole('button', { name: I18N.settings_remove_pin.ur }).or(page.getByRole('button', { name: I18N.settings_remove_pin.en })),
    ).toBeVisible();

    // Cold-start reload: src/stores/authStore.ts computes `isLocked` from
    // whether a PIN record exists the moment the module re-evaluates, so a
    // full reload is exactly the "cold start" App.tsx's PIN gate defends.
    await page.reload();
    const pinHeading = page
      .getByRole('heading', { name: I18N.pin_title.ur })
      .or(page.getByRole('heading', { name: I18N.pin_title.en }));
    await expect(pinHeading).toBeVisible({ timeout: 15_000 });

    for (const digit of ['1', '2', '3', '4']) {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Unlocked: the app shell (BottomNav) reappears.
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 15_000 });

    // Clean up: remove the PIN so a future run (and a real device owner)
    // isn't left with a PIN this suite set.
    await page.goto('/settings');
    await page
      .getByRole('button', { name: I18N.settings_remove_pin.ur })
      .or(page.getByRole('button', { name: I18N.settings_remove_pin.en }))
      .click();
    await page
      .getByRole('button', { name: I18N.pin_remove_confirm_cta.ur })
      .or(page.getByRole('button', { name: I18N.pin_remove_confirm_cta.en }))
      .click();

    // Verify the removal actually took: reloading no longer locks.
    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 15_000 });
  });
});
