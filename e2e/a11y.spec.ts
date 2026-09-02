import { test, expect, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Automated a11y (axe-core) sweep of every route that renders with no
// session — the four public info pages (src/pages/PublicInfoPages.tsx) plus
// the auth gate (src/pages/AuthPage.tsx, mounted at '/' when signed out —
// see e2e/auth-page.spec.ts). No storageState / secrets needed, so this
// suite runs in CI (.github/workflows/e2e.yml) even when the staging
// E2E_EMAIL/E2E_PASSWORD secrets aren't configured.
//
// Runs on every Playwright project declared in playwright.config.ts (today:
// 'mobile' — Pixel 5 — and 'desktop'), since this is a mobile-first app
// (CLAUDE.md) and axe's viewport-size / touch-target-adjacent checks can
// differ by device.
//
// Threshold: an axe violation with impact 'serious' or 'critical' FAILS the
// test — those are the tiers axe-core itself defines as "likely to block or
// severely hinder a user" vs. 'moderate'/'minor' which are more often false-
// positive-prone or cosmetic. 'moderate' violations are attached to the test
// report as a warning artifact instead of failing, per this item's brief.
//
// Both languages: this app's default language is roman Urdu (src/lib/i18n.ts
// DEFAULT_LANGUAGE), and a language switch can change DOM structure (label
// text length, RTL-adjacent formatting is NOT used here — 'ur' is Latin-
// script roman Urdu, not right-to-left Perso-Arabic — but copy length alone
// can still trip things like target-size or text-spacing rules). Language is
// set the same way e2e/public-pages.spec.ts's `gotoWithLang` does: seed
// `hisaab_lang` in localStorage via an init script before navigating, since
// that is what src/lib/i18n.ts's `readStoredLang()` reads on boot — the same
// mechanism AuthPage's own "EN"/"UR" toggle button writes to at runtime
// (e2e/auth-page.spec.ts), just applied up front so every page under test
// (not only AuthPage) picks it up on first paint.
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

interface PageUnderTest {
  name: string;
  path: string;
  /** Locator that proves the real page (not a blank/loading shell) mounted. */
  ready: (page: Page) => Locator;
}

const PAGES: PageUnderTest[] = [
  {
    name: 'privacy',
    path: '/privacy',
    ready: (page) => page.getByRole('heading', { level: 1, name: 'Privacy Policy' }),
  },
  {
    name: 'terms',
    path: '/terms',
    ready: (page) => page.getByRole('heading', { level: 1, name: 'Terms of Use' }),
  },
  {
    name: 'contact',
    path: '/contact',
    ready: (page) => page.getByRole('heading', { level: 1, name: 'Contact & Support' }),
  },
  {
    name: 'delete-account',
    path: '/delete-account',
    ready: (page) => page.getByRole('heading', { level: 1, name: 'Delete Your Hisaab Account' }),
  },
  {
    // '/' with no session renders AuthPage (src/App.tsx's auth gate) —
    // see e2e/auth-page.spec.ts.
    name: 'auth',
    path: '/',
    ready: (page) => page.locator('#auth-email'),
  },
];

const SERIOUS_IMPACTS = new Set(['serious', 'critical']);

/**
 * Known serious/critical violations that live entirely in files this agent
 * cannot edit for this task (src/pages/** is owned by other concurrently-
 * running agents — see the M3 task's file-ownership boundary). Documented in
 * full in docs/accessibility-contrast.md ("axe findings"). Per this item's
 * brief: don't weaken the shared threshold to paper over these — mark only
 * the specific known-failing test as `test.fixme` with the reason, so a NEW
 * regression anywhere else (including a different rule on these same pages)
 * still fails the suite.
 *
 * Verified lang-independent (both 'ur' and 'en' hit the identical single
 * violation — same markup, only body copy differs by language), so this is
 * keyed on page name only, not (name, lang).
 *
 * 2026-09-02 follow-up pass: both prior findings were fixed —
 * PublicInfoPages.tsx:66 "Last updated" bumped from text-white/45 to
 * text-white/60 (7.16:1 on bg-navy-900, comfortably clears 4.5:1) and
 * AuthPage.tsx's password show/hide button gained an aria-label from
 * auth_show_password / auth_hide_password (src/lib/i18n.ts). Map is empty —
 * kept (not deleted) so a future regression on these same pages has a
 * documented place to record a fixme again, per the same brief.
 */
const KNOWN_VIOLATIONS: Partial<Record<string, { rule: string; file: string; reason: string }>> = {};

for (const { name, path, ready } of PAGES) {
  for (const lang of ['ur', 'en'] as const) {
    test(`${name} (${path}) has no serious/critical axe violations — ${lang}`, async ({ page }, testInfo) => {
      const known = KNOWN_VIOLATIONS[name];
      test.fixme(
        !!known,
        known &&
          `axe "${known.rule}" in ${known.file}: ${known.reason} File is out of this agent's edit scope for this task — see docs/accessibility-contrast.md.`,
      );

      await gotoWithLang(page, path, lang);
      await expect(ready(page)).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();

      const serious = results.violations.filter((v) => SERIOUS_IMPACTS.has(v.impact ?? ''));
      const moderate = results.violations.filter((v) => v.impact === 'moderate');

      if (moderate.length > 0) {
        await testInfo.attach(`axe-moderate-${name}-${lang}`, {
          body: JSON.stringify(
            moderate.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              helpUrl: v.helpUrl,
              nodes: v.nodes.map((n) => n.target),
            })),
            null,
            2,
          ),
          contentType: 'application/json',
        });
        // Also surface in the console/CI log — attachments are easy to miss
        // when just skimming a green run.
        console.warn(
          `[a11y] ${moderate.length} moderate violation(s) on ${path} (${lang}): ` +
            moderate.map((v) => v.id).join(', '),
        );
      }

      expect(
        serious,
        serious.length === 0
          ? undefined
          : `serious/critical axe violation(s) on ${path} (${lang}):\n` +
              serious
                .map(
                  (v) =>
                    `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`,
                )
                .join('\n'),
      ).toEqual([]);
    });
  }
}
