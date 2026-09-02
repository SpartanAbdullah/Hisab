import { type Locator, type Page } from '@playwright/test';
import { I18N, type I18nStringKey } from './i18n-strings';

/**
 * `Locator.isVisible()` deliberately does NOT wait (its `timeout` option is
 * ignored/deprecated in Playwright — see the type comment on
 * `locator.isVisible`) — it's a synchronous, immediate check. That's the
 * wrong tool for "is this optional, possibly-still-animating-in element
 * present at all", which several specs here need (an account picker that
 * only renders in full_tracker mode, a confirm sheet that fades in). This
 * waits up to `timeout`ms for visible, and resolves `false` instead of
 * throwing if it never shows up.
 */
export async function isVisibleSoon(locator: Locator, timeout = 5_000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

export type AppMode = 'full_tracker' | 'splits_only';

/** A locator that matches either language's copy for a given i18n key. */
export function anyLang(page: Page, key: I18nStringKey, opts?: { exact?: boolean }) {
  const { ur, en } = I18N[key];
  const loc = page.getByRole('button', { name: ur, exact: opts?.exact });
  return ur === en ? loc : loc.or(page.getByRole('button', { name: en, exact: opts?.exact }));
}

/**
 * Navigate to the app root and wait for the authenticated shell (BottomNav)
 * to mount, then report which app mode is active by which tab BottomNav
 * chose for its second slot (src/components/BottomNav.tsx: Loans in
 * full_tracker, Activity in splits_only). Assumes onboarding is already
 * complete for this account — every caller of this helper is itself gated
 * behind `hasCreds`, and by the time these specs run the shared staging
 * account has (at latest) completed onboarding via onboarding.spec.ts.
 */
export async function gotoAppShell(page: Page): Promise<AppMode> {
  await page.goto('/');
  const nav = page.getByRole('navigation');
  await nav.waitFor({ state: 'visible', timeout: 20_000 });
  const loansTab = page
    .getByRole('link', { name: I18N.nav_loans.ur, exact: true })
    .or(page.getByRole('link', { name: I18N.nav_loans.en, exact: true }));
  return (await loansTab.isVisible()) ? 'full_tracker' : 'splits_only';
}

export async function openQuickEntry(page: Page) {
  await page
    .getByRole('button', { name: I18N.a11y_quick_entry.ur })
    .or(page.getByRole('button', { name: I18N.a11y_quick_entry.en }))
    .click();
}

/**
 * Click the first account row inside an AccountSelect (src/components/
 * AccountSelect.tsx) block, identified by the field's own label text (e.g.
 * "quick_from"/"quick_pay_from"). With no selection yet the list renders
 * expanded with one button per account, so "first button under this label"
 * is a stable, name-independent way to pick "some real account" without
 * knowing the staging account's actual account names.
 */
export async function selectFirstAccount(page: Page, labelUr: string, labelEn: string) {
  const label = page.getByText(labelUr, { exact: true }).or(page.getByText(labelEn, { exact: true }));
  const container = label.locator('xpath=..');
  await container.getByRole('button').first().click();
}

/**
 * Fill the text input sitting under a field's own <label> text, for the
 * QuickEntry/Settings form fields that render a plain `<label>{t(...)}</label>`
 * above an `<input>` with no `htmlFor`/`id` pairing (so `getByLabel` can't
 * find them) — same "anchor on the label, walk to the sibling" trick as
 * `selectFirstAccount`.
 */
export async function fillFieldNearLabel(page: Page, labelUr: string, labelEn: string, value: string) {
  const label = page.getByText(labelUr, { exact: true }).or(page.getByText(labelEn, { exact: true }));
  const container = label.locator('xpath=..');
  await container.locator('input').first().fill(value);
}
