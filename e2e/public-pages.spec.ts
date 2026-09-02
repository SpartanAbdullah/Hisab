import { test, expect, type Page } from '@playwright/test';

// Public routes (src/App.tsx's PublicRouteSwitch) render before any auth /
// email-verification / onboarding gate — no signed-in session is needed, and
// none is used in this file (no storageState). These pages are English-only
// today (src/pages/PublicInfoPages.tsx is on eslint.config.js's I18N_SWEEP_TODO
// "Group B" list — a legal-copy decision, not a mechanical i18n gap), so
// "both languages" here means: the route renders correctly regardless of
// which language is stored in `hisaab_lang`, not that its copy changes. That
// still catches a real regression class — a language-dependent hook throwing
// before the page mounts.
async function gotoWithLang(page: Page, path: string, lang: 'ur' | 'en') {
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem('hisaab_lang', l);
    } catch {
      /* private-mode storage — page still renders with the default */
    }
  }, lang);
  await page.goto(path);
}

const PUBLIC_PAGES: { path: string; heading: string }[] = [
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Use' },
  { path: '/contact', heading: 'Contact & Support' },
  { path: '/delete-account', heading: 'Delete Your Hisaab Account' },
];

for (const { path, heading } of PUBLIC_PAGES) {
  for (const lang of ['ur', 'en'] as const) {
    test(`${path} renders under hisaab_lang=${lang}`, async ({ page }) => {
      await gotoWithLang(page, path, lang);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      // Every public page carries the same footer nav to the other three —
      // confirms the shared PublicInfoLayout mounted, not just a bare h1.
      await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Contact' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Delete Account' })).toBeVisible();
    });
  }
}

test('unmatched URL falls through to the auth gate instead of a blank page', async ({ page }) => {
  // Not one of the four public paths above, not /kameti/witness/*, not
  // /khata/* — everything else reaches AppContent (src/App.tsx), and signed
  // out that means AuthPage. This is the "404/redirect behaviour" for a
  // visitor with no session: there is no dedicated 404 page, the auth gate
  // itself is the fallback, and this proves it doesn't crash or blank out.
  await page.goto('/this-route-does-not-exist-e2e-smoke');
  await expect(page.locator('#auth-email')).toBeVisible();
});

test('public pages navigate back to the app from the header back button', async ({ page }) => {
  await page.goto('/privacy');
  await page.getByRole('button', { name: 'Back to Hisaab' }).click();
  // Signed out, "back to Hisaab" lands on AuthPage at "/".
  await expect(page.locator('#auth-email')).toBeVisible();
});
