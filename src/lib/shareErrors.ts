// Maps splitMath's language-agnostic error codes onto i18n keys. Kept out of
// splitMath itself so that module stays a pure, UI-free calculator, and shared
// by every surface that computes shares (the group expense form and the ad-hoc
// split sheet) so the same problem never gets two different messages.

import type { ShareErrorCode } from './splitMath';
import type { I18nKey } from './i18n';

export const SHARE_ERROR_KEYS: Record<ShareErrorCode, I18nKey> = {
  no_participants: 'val_pick_member',
  exact_mismatch: 'group_total_mismatch',
  percentage_mismatch: 'group_pct_mismatch',
  shares_zero: 'val_shares_zero',
};
