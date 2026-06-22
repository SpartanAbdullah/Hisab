// Deliberate (double) confirmation before sending a cross-user linked loan
// request. Cross-user records are mirrored to the other person and their
// currency can't be edited after they accept, so this is a Tier-2 action:
// show the magnitude (incl. the approximate other-currency value), warn about
// irreversibility, and require an explicit confirm. Blocks gross typos outright.

import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { plausibilityCheck, approxOther } from './currencyValidation';
import { formatMoney } from './constants';
import { useI18nStore } from './i18n';

export interface CrossUserGuardResult {
  ok: boolean; // user confirmed and it's safe to proceed
  blockedReason?: string; // set when the amount was refused outright (no confirm shown)
}

// Local mirror of the confirm_send_* i18n keys. This is a non-React .ts
// module, so it can't call useT(); the shared S dictionary in i18n.ts isn't
// exported either. These strings are kept byte-for-byte identical to the
// confirm_send_title/body/cta entries in i18n.ts — update both together.
const SEND_COPY = {
  title: {
    ur: '{name} ko {amount} bhejein?',
    en: 'Send {amount} to {name}?',
  },
  body: {
    ur: '{approx}Yeh {name} ko bhi dikhega aur accept hone ke baad badla nahi ja sakta.',
    en: "{approx}This is mirrored to {name} and can't be edited after they accept.",
  },
  cta: {
    ur: 'Request bhejo',
    en: 'Send request',
  },
} as const;

export async function confirmCrossUserRequest(params: {
  amount: number;
  currency: string;
  personName: string;
}): Promise<CrossUserGuardResult> {
  const check = plausibilityCheck(params.amount, params.currency);
  if (!check.passed && check.severity === 'block') {
    return { ok: false, blockedReason: check.reason ?? "That amount doesn't look right." };
  }

  const lang = useI18nStore.getState().lang;
  const approx = approxOther(params.amount, params.currency);
  const warn = !check.passed && check.reason ? ` ${check.reason}` : '';
  const approxPrefix = approx ? `${approx}. ` : '';

  const title = SEND_COPY.title[lang]
    .replace('{amount}', formatMoney(params.amount, params.currency))
    .replace('{name}', params.personName);
  const description = SEND_COPY.body[lang]
    .replace('{approx}', approxPrefix)
    .replace('{name}', params.personName) + warn;

  const ok = await confirmDestructive({
    title,
    description,
    confirmLabel: SEND_COPY.cta[lang],
    cancelLabel: 'Back',
    tone: 'warning',
  });
  return { ok };
}
