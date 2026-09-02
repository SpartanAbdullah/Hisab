import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH, hasCreds, SKIP_NO_CREDS_REASON } from './env';
import { I18N } from './i18n-strings';
import { fillFieldNearLabel, gotoAppShell, openQuickEntry, selectFirstAccount } from './helpers';

// A plain "Spend Money" (expense) entry only exists in full_tracker mode —
// src/pages/QuickEntry.tsx filters splits_only's intent list down to just
// person_money/group_expense, since a ledger has no accounts to debit. If the
// shared staging account is in splits_only mode (e.g. onboarding.spec.ts
// chose it on this account's very first run), this spec self-skips rather
// than failing on an intent tile that was never offered.
test.describe('QuickEntry — expense entry', () => {
  test.skip(!hasCreds, SKIP_NO_CREDS_REASON);
  test.use({ storageState: AUTH_STATE_PATH });

  test('creates an expense with an amount + note, it appears in Transactions, then is deleted', async ({ page }) => {
    const mode = await gotoAppShell(page);
    test.skip(
      mode !== 'full_tracker',
      'This staging account is in splits_only mode — plain expense entries are not offered there.',
    );

    const note = `Hisaab E2E smoke ${Date.now()}`;

    await openQuickEntry(page);

    // Step 1: "What happened?" — pick Spend Money.
    await page
      .getByRole('button')
      .filter({ hasText: I18N.intent_spend.ur })
      .or(page.getByRole('button').filter({ hasText: I18N.intent_spend.en }))
      .first()
      .click();

    // Step 0: amount, via the in-app numpad (the real input is readOnly on
    // purpose — see src/pages/QuickEntry.tsx's comment on inputMode="none").
    await page.getByRole('button', { name: '2', exact: true }).click();
    await page.getByRole('button', { name: '5', exact: true }).click();
    await page
      .getByRole('button', { name: I18N.quick_next.ur })
      .or(page.getByRole('button', { name: I18N.quick_next.en }))
      .click();

    // Step 2: details — pick any account to spend from, add the note, save.
    await selectFirstAccount(page, I18N.quick_from.ur, I18N.quick_from.en);
    await fillFieldNearLabel(page, I18N.quick_note.ur, I18N.quick_note.en, note);
    await page
      .getByRole('button', { name: I18N.quick_save.ur })
      .or(page.getByRole('button', { name: I18N.quick_save.en }))
      .click();

    // A ConfirmationSheet (src/components/ConfirmationSheet.tsx) appears on
    // success; dismissing it is what actually closes QuickEntry.
    await page
      .getByRole('button', { name: I18N.done_btn.ur })
      .or(page.getByRole('button', { name: I18N.done_btn.en }))
      .click();

    // It shows up in the transactions list.
    await page.goto('/transactions');
    const row = page.getByText(note, { exact: false });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });

    // Clean up: open it, delete it, so the staging account stays reusable.
    await row.first().click();
    await page
      .getByRole('button', { name: I18N.tx_delete_entry.ur })
      .or(page.getByRole('button', { name: I18N.tx_delete_entry.en }))
      .click();
    await expect(page.getByText(note, { exact: false })).toHaveCount(0);
  });
});
