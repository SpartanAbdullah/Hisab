import { describe, it, expect } from 'vitest';
import { isSettlementSuccess, settlementFailureMessage } from './groupSettlementResult';
import { tStatic, useI18nStore } from './i18n';
import type { I18nKey } from './i18n';

const en = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'en' });
  return tStatic(key);
};
const ur = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'ur' });
  return tStatic(key);
};

describe('isSettlementSuccess', () => {
  it('is true only when the RPC said so', () => {
    expect(isSettlementSuccess({ success: true, reason_code: 'SETTLEMENT_RECORDED' })).toBe(true);
    // Idempotent replay of the same client-generated id is still a success —
    // a double tap must not read as a failure and scare the user into retrying.
    expect(isSettlementSuccess({ success: true, reason_code: 'ALREADY_RECORDED' })).toBe(true);
    expect(isSettlementSuccess({ success: false, reason_code: 'ALREADY_SETTLED' })).toBe(false);
    expect(isSettlementSuccess(null)).toBe(false);
    expect(isSettlementSuccess(undefined)).toBe(false);
    expect(isSettlementSuccess({})).toBe(false);
  });
});

describe('settlementFailureMessage', () => {
  it('maps every known reason code to translated copy, never the raw server text', () => {
    const codes = [
      'NOT_AUTHENTICATED', 'NOT_ACTIVE_MEMBER', 'INVALID_PARTICIPANTS',
      'INVALID_AMOUNT', 'ALREADY_SETTLED',
    ];
    for (const code of codes) {
      const msg = settlementFailureMessage(
        { success: false, reason_code: code, user_message: 'RAW SERVER ENGLISH' },
        en,
      );
      expect(msg, code).not.toBe('RAW SERVER ENGLISH');
      expect(msg, code).not.toBe('');
      expect(msg, code).not.toMatch(/^grp_settle_/);
    }
  });

  it('renders the outstanding cap as formatted money in the group currency', () => {
    const msg = settlementFailureMessage(
      { success: false, reason_code: 'EXCEEDS_OUTSTANDING', cap: 1234.5, currency: 'AED' },
      en,
    );
    expect(msg).toBe('Settlement cannot exceed the outstanding AED 1,234.50.');
    expect(msg).not.toContain('{amount}');
  });

  it('accepts a numeric-string cap (numeric comes back as text over PostgREST)', () => {
    const msg = settlementFailureMessage(
      { success: false, reason_code: 'EXCEEDS_OUTSTANDING', cap: '80.00', currency: 'PKR' },
      en,
    );
    expect(msg).toBe('Settlement cannot exceed the outstanding ₨ 80.00.');
  });

  it('degrades to "already settled" when the cap is unusable', () => {
    expect(
      settlementFailureMessage({ success: false, reason_code: 'EXCEEDS_OUTSTANDING' }, en),
    ).toBe('This balance is already settled.');
  });

  it('translates, so an Urdu reader never gets English error copy', () => {
    const msg = settlementFailureMessage({ success: false, reason_code: 'ALREADY_SETTLED' }, ur);
    expect(msg).toBe('Yeh hisaab pehle hi barabar ho chuka hai.');
  });

  it('falls back to a generic translated message for an unknown code with no server text', () => {
    const msg = settlementFailureMessage({ success: false, reason_code: 'SOMETHING_NEW' }, en);
    expect(msg).toBe('Settlement could not be saved. Please try again.');
  });

  it('uses the server message only as the last resort for an unknown code', () => {
    const msg = settlementFailureMessage(
      { success: false, reason_code: 'SOMETHING_NEW', user_message: 'Group is frozen.' },
      en,
    );
    expect(msg).toBe('Group is frozen.');
  });

  it('handles a missing envelope entirely (network shape changed, null data)', () => {
    expect(settlementFailureMessage(null, en)).toBe('Settlement could not be saved. Please try again.');
    expect(settlementFailureMessage({}, en)).toBe('Settlement could not be saved. Please try again.');
  });
});
