// Deliberate (double) confirmation before sending a cross-user linked loan
// request. Cross-user records are mirrored to the other person and their
// currency can't be edited after they accept, so this is a Tier-2 action:
// show the magnitude (incl. the approximate other-currency value), warn about
// irreversibility, and require an explicit confirm. Blocks gross typos outright.

import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { plausibilityCheck, approxOther } from './currencyValidation';
import { formatMoney } from './constants';

export interface CrossUserGuardResult {
  ok: boolean; // user confirmed and it's safe to proceed
  blockedReason?: string; // set when the amount was refused outright (no confirm shown)
}

export async function confirmCrossUserRequest(params: {
  amount: number;
  currency: string;
  personName: string;
}): Promise<CrossUserGuardResult> {
  const check = plausibilityCheck(params.amount, params.currency);
  if (!check.passed && check.severity === 'block') {
    return { ok: false, blockedReason: check.reason ?? "That amount doesn't look right." };
  }

  const approx = approxOther(params.amount, params.currency);
  const warn = !check.passed && check.reason ? ` ${check.reason}` : '';
  const description =
    `${approx ? `${approx}. ` : ''}` +
    `This is mirrored to ${params.personName}'s device and can't be edited after they accept.${warn}`;

  const ok = await confirmDestructive({
    title: `Send ${formatMoney(params.amount, params.currency)} to ${params.personName}?`,
    description,
    confirmLabel: 'Send request',
    cancelLabel: 'Back',
    tone: 'warning',
  });
  return { ok };
}
