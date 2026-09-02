import { test, expect } from '@playwright/test';
import {
  AUTH_STATE_PATH,
  BASE_URL,
  E2E_EMAIL_2,
  E2E_PASSWORD_2,
  hasCreds,
  hasSecondAccount,
  SKIP_NO_CREDS_REASON,
  SKIP_NO_SECOND_ACCOUNT_REASON,
} from './env';
import { I18N } from './i18n-strings';
import { loginViaUi } from './loginViaUi';
import { fillFieldNearLabel, gotoAppShell, isVisibleSoon, openQuickEntry, selectFirstAccount } from './helpers';

// Cross-user request flow (docs/staging-environment.md's "cross-user account
// effects" area): the primary staging account (E2E_EMAIL) links a SECOND
// staging account by its public connect code, then records a loan_given
// against that linked contact. Because the contact is linked, QuickEntry
// branches the entry into a mirrored request (src/lib/confirmCrossUserRequest.ts,
// src/pages/QuickEntry.tsx ~line 820) instead of an immediate local loan — it
// only becomes a real loan once the SECOND account accepts, which this suite
// does not automate. So the assertion here is deliberately shallow: the
// request was sent. That's also why there's no delete/cleanup step — the
// product has no "cancel a sent linked request" affordance to drive (checked
// src/stores/linkedRequestStore.ts), so nothing here can un-send it.
//
// To keep repeat runs from piling up duplicate pending requests anyway, the
// amount/note are FIXED (not timestamped): QuickEntry derives its dedup
// requestId from `[type, contact, amount, notes]` (src/pages/QuickEntry.tsx's
// `nextRequestId`), so an identical resend collides on the same id server-side
// instead of minting a new pending request every run.
test.describe('Cross-user request — loan to a linked contact', () => {
  test.skip(!hasCreds, SKIP_NO_CREDS_REASON);
  test.skip(!hasSecondAccount, SKIP_NO_SECOND_ACCOUNT_REASON);
  test.use({ storageState: AUTH_STATE_PATH });

  const FIXED_AMOUNT_DIGIT = '1';
  const FIXED_NOTE = 'Hisaab E2E smoke — cross-user loan (safe to ignore/decline)';

  test('link a second staging account by code, then send a loan request to them', async ({ page, browser }) => {
    await gotoAppShell(page);

    // 1. Fetch the second account's own connect code (src/components/
    //    MyConnectCode.tsx, surfaced on ContactsPage) from a throwaway login —
    //    this never touches the primary storageState.
    const context2 = await browser.newContext({ baseURL: BASE_URL });
    const page2 = await context2.newPage();
    let code = '';
    try {
      await loginViaUi(page2, E2E_EMAIL_2, E2E_PASSWORD_2);
      await page2.goto('/contacts');
      const codeButton = page2
        .getByText(I18N.mcc_hsb_tag.ur, { exact: true })
        .or(page2.getByText(I18N.mcc_hsb_tag.en, { exact: true }))
        .locator('xpath=..');
      await codeButton.waitFor({ state: 'visible', timeout: 15_000 });
      const text = (await codeButton.textContent()) ?? '';
      const match = text.match(/@([A-Za-z0-9]+)/);
      if (!match) {
        throw new Error(`Could not read a connect code out of "${text}" — see src/components/MyConnectCode.tsx.`);
      }
      code = match[1];
    } finally {
      await context2.close();
    }

    // 2. As the primary account, resolve the code (src/pages/ConnectByCodePage.tsx).
    await page.goto(`/u/${code}`);
    const addButton = page
      .getByRole('button', { name: I18N.addc_cta_linked.ur })
      .or(page.getByRole('button', { name: I18N.addc_cta_linked.en }));
    const alreadyLinked = page.getByText(I18N.cbc_on_hisaab.ur).or(page.getByText(I18N.cbc_on_hisaab.en));
    await Promise.race([
      addButton.waitFor({ state: 'visible', timeout: 20_000 }),
      alreadyLinked.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);

    // The display name sits in the sibling <p> right above the "on Hisaab"
    // caption — capture it now, before we navigate away, to search for it in
    // ContactPicker below.
    const nameParagraph = alreadyLinked.locator('xpath=preceding-sibling::p[1]');
    const displayName = ((await nameParagraph.textContent()) ?? '').trim();
    expect(displayName, 'Could not read the linked account\'s display name from ConnectByCodePage').not.toBe('');

    if (await addButton.isVisible().catch(() => false)) {
      await addButton.click();
      await page.waitForURL('**/contacts', { timeout: 15_000 });
    } else {
      // Already linked from a previous run of this spec — idempotent no-op.
      await page.goto('/contacts');
    }

    // 3. Record a loan_given to that contact. person_money is offered in both
    //    app modes (unlike plain "Spend Money" — see quick-entry.spec.ts).
    await openQuickEntry(page);
    await page
      .getByRole('button')
      .filter({ hasText: I18N.intent_person.ur })
      .or(page.getByRole('button').filter({ hasText: I18N.intent_person.en }))
      .first()
      .click();
    await page
      .getByRole('button')
      .filter({ hasText: I18N.person_gave.ur })
      .or(page.getByRole('button').filter({ hasText: I18N.person_gave.en }))
      .first()
      .click();

    // Amount.
    await page.getByRole('button', { name: FIXED_AMOUNT_DIGIT, exact: true }).click();
    await page
      .getByRole('button', { name: I18N.quick_next.ur })
      .or(page.getByRole('button', { name: I18N.quick_next.en }))
      .click();

    // Details: contact (pick the linked match from the dropdown, not just
    // typed text, so this resolves to the SAME person row the code just
    // linked), an account if this account is in full_tracker mode (splits_only
    // has no accounts to pick from — src/pages/QuickEntry.tsx's
    // isLedgerOnlyPersonFlow), and a note.
    const whoLabel = page.getByText(I18N.quick_who.ur, { exact: true }).or(page.getByText(I18N.quick_who.en, { exact: true }));
    await whoLabel.locator('xpath=..').locator('input').fill(displayName);
    await page.getByRole('button').filter({ hasText: displayName }).first().click();

    const fromLabel = page.getByText(I18N.quick_from.ur, { exact: true }).or(page.getByText(I18N.quick_from.en, { exact: true }));
    if (await isVisibleSoon(fromLabel, 3_000)) {
      await selectFirstAccount(page, I18N.quick_from.ur, I18N.quick_from.en);
    }

    await fillFieldNearLabel(page, I18N.quick_note.ur, I18N.quick_note.en, FIXED_NOTE);

    // Save — a linked contact branches this into a mirrored request, so the
    // button reads "Send for confirmation" instead of "Save".
    await page
      .getByRole('button', { name: I18N.quick_save.ur })
      .or(page.getByRole('button', { name: I18N.quick_save.en }))
      .or(page.getByRole('button', { name: I18N.ltr_branch_cta.ur }))
      .or(page.getByRole('button', { name: I18N.ltr_branch_cta.en }))
      .click();

    // A second, Tier-2 confirmation (src/lib/confirmCrossUserRequest.ts) asks
    // for an explicit go-ahead before mirroring anything cross-user.
    const sendConfirm = page
      .getByRole('button', { name: I18N.confirm_send_cta.ur, exact: true })
      .or(page.getByRole('button', { name: I18N.confirm_send_cta.en, exact: true }));
    if (await isVisibleSoon(sendConfirm, 5_000)) {
      await sendConfirm.click();
    }

    // The request left. This branch closes QuickEntry directly (no
    // ConfirmationSheet, since nothing settles until the other side accepts —
    // see src/pages/QuickEntry.tsx ~line 844), so "the FAB is reachable again"
    // is the reliable end-of-flow signal; the toast is a bonus check.
    await expect(page.getByRole('button', { name: I18N.a11y_quick_entry.ur }).or(page.getByRole('button', { name: I18N.a11y_quick_entry.en }))).toBeVisible({
      timeout: 15_000,
    });
  });
});
