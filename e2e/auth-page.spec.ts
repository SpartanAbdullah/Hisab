import { test, expect } from '@playwright/test';
import { I18N } from './i18n-strings';

// AuthPage (src/pages/AuthPage.tsx) is the very first screen for a
// signed-out visitor — src/App.tsx's auth gate. No storageState in this file:
// every test here starts logged out on purpose.
test.describe('AuthPage', () => {
  test('renders the login form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('#auth-password')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hisaab' })).toBeVisible();
  });

  test('language toggle switches the visible copy between ur and en', async ({ page }) => {
    await page.goto('/');
    // No stored preference yet → src/lib/i18n.ts DEFAULT_LANGUAGE = "ur".
    // auth_cta_login is the primary CTA, always on screen in the default
    // (login) mode, so it's a reliable before/after marker for the toggle.
    await expect(page.getByRole('button', { name: I18N.auth_cta_login.ur, exact: true })).toBeVisible();

    // The corner globe button (aria-free, but its own text reads "EN"/"UR" —
    // src/pages/AuthPage.tsx renders `{lang === 'ur' ? 'EN' : 'UR'}` inside
    // it) is the only control that flips `hisaab_lang`. `exact: true`
    // matters here: "UR" is otherwise a substring match inside "Your" in the
    // "New here? Create your free..." hint button that's also on screen.
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('button', { name: I18N.auth_cta_login.en, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: I18N.auth_cta_login.ur, exact: true })).toHaveCount(0);

    // Toggle back — same control now reads "UR".
    await page.getByRole('button', { name: 'UR', exact: true }).click();
    await expect(page.getByRole('button', { name: I18N.auth_cta_login.ur, exact: true })).toBeVisible();
  });

  test('signup/login tabs and the reset-password link are reachable', async ({ page }) => {
    await page.goto('/');
    // "Sign Up"/"Login" each appear twice (the tab switcher AND the footer's
    // "Don't have an account? Sign Up" / "Have an account? Login" link) —
    // the tab switcher renders first, so `.first()` picks it.
    await page.getByRole('button', { name: 'Sign Up', exact: true }).first().click();
    await expect(page.locator('#auth-password')).toHaveAttribute('autocomplete', 'new-password');
    await page.getByRole('button', { name: 'Login', exact: true }).first().click();
    await expect(page.locator('#auth-password')).toHaveAttribute('autocomplete', 'current-password');
  });
});
