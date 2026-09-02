import { describe, it, expect } from 'vitest';
import {
  isKhataToken,
  buildKhataLinkUrl,
  parseCreateKhataLinkResponse,
  parseRevokeKhataLinkResponse,
  isMissingKhataRpcError,
  khataStatusFromThrown,
  khataStatusMessageKey,
  formatKhataError,
  parseKhataView,
  daysUntilExpiry,
  shouldOfferKhataShareNudge,
  snoozeKhataShareNudge,
} from './khataLinkStatus';

const TOKEN = 'a'.repeat(64);
const BASE = 'https://usehisaab.com';

describe('isKhataToken', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isKhataToken(TOKEN)).toBe(true);
    expect(isKhataToken('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects everything the server would also refuse to hash', () => {
    expect(isKhataToken('')).toBe(false);
    expect(isKhataToken(null)).toBe(false);
    expect(isKhataToken(undefined)).toBe(false);
    expect(isKhataToken('a'.repeat(63))).toBe(false);
    expect(isKhataToken('a'.repeat(65))).toBe(false);
    expect(isKhataToken('A'.repeat(64))).toBe(false); // uppercase hex
    expect(isKhataToken('z'.repeat(64))).toBe(false); // not hex
    expect(isKhataToken(`${TOKEN} `)).toBe(false);
  });
});

describe('buildKhataLinkUrl', () => {
  it('joins the configured origin with the public route', () => {
    expect(buildKhataLinkUrl(TOKEN, BASE)).toBe(`${BASE}/khata/${TOKEN}`);
  });

  it('never doubles a slash when the base already ends in one', () => {
    expect(buildKhataLinkUrl(TOKEN, `${BASE}///`)).toBe(`${BASE}/khata/${TOKEN}`);
  });

  it('falls back to a root-relative path when there is no origin', () => {
    expect(buildKhataLinkUrl(TOKEN, '')).toBe(`/khata/${TOKEN}`);
    expect(buildKhataLinkUrl(TOKEN, '/')).toBe(`/khata/${TOKEN}`);
  });
});

describe('parseCreateKhataLinkResponse', () => {
  it('narrows a success, building the shareable URL', () => {
    const result = parseCreateKhataLinkResponse(
      {
        status: 'ok',
        token: TOKEN,
        expires_at: '2026-12-01T00:00:00.000Z',
        initials_only: true,
        show_notes: true,
        replaced_previous: true,
      },
      BASE,
    );
    expect(result).toEqual({
      status: 'ok',
      token: TOKEN,
      url: `${BASE}/khata/${TOKEN}`,
      expiresAt: '2026-12-01T00:00:00.000Z',
      initialsOnly: true,
      showNotes: true,
      replacedPrevious: true,
    });
  });

  it('unwraps a single-row array (RETURNS TABLE / .select() shape)', () => {
    const result = parseCreateKhataLinkResponse([{ status: 'ok', token: TOKEN }], BASE);
    expect(result.status).toBe('ok');
  });

  it('defaults the three booleans to false when the server omits them', () => {
    const result = parseCreateKhataLinkResponse({ status: 'ok', token: TOKEN }, BASE);
    expect(result).toMatchObject({
      initialsOnly: false,
      showNotes: false,
      replacedPrevious: false,
      expiresAt: '',
    });
  });

  it('carries show_notes independently of initials_only', () => {
    // Off by default: a server payload that omits it must not be treated as opted in.
    expect(parseCreateKhataLinkResponse({ status: 'ok', token: TOKEN, show_notes: false }, BASE)).toMatchObject({
      showNotes: false,
    });
    expect(parseCreateKhataLinkResponse({ status: 'ok', token: TOKEN, show_notes: true }, BASE)).toMatchObject({
      showNotes: true,
    });
  });

  it.each(['NOT_AUTHENTICATED', 'NOT_FOUND', 'CONTACT_ARCHIVED'])(
    'passes %s through as a failure status',
    (status) => {
      expect(parseCreateKhataLinkResponse({ status }, BASE)).toEqual({ status });
    },
  );

  it('normalises case and whitespace on the status', () => {
    expect(parseCreateKhataLinkResponse({ status: ' not_found ' }, BASE)).toEqual({ status: 'NOT_FOUND' });
    expect(parseCreateKhataLinkResponse({ status: 'OK', token: TOKEN }, BASE).status).toBe('ok');
  });

  it('maps an unrecognised status to UNKNOWN rather than trusting it', () => {
    expect(parseCreateKhataLinkResponse({ status: 'WAT' }, BASE)).toEqual({ status: 'UNKNOWN' });
  });

  it('refuses a "success" whose token is missing or malformed', () => {
    // Handing the share sheet a broken URL is worse than an honest error.
    expect(parseCreateKhataLinkResponse({ status: 'ok' }, BASE)).toEqual({ status: 'UNKNOWN' });
    expect(parseCreateKhataLinkResponse({ status: 'ok', token: 'short' }, BASE)).toEqual({ status: 'UNKNOWN' });
    expect(parseCreateKhataLinkResponse({ status: 'ok', token: 42 }, BASE)).toEqual({ status: 'UNKNOWN' });
  });

  it('handles a null / non-object payload', () => {
    expect(parseCreateKhataLinkResponse(null, BASE)).toEqual({ status: 'UNKNOWN' });
    expect(parseCreateKhataLinkResponse([], BASE)).toEqual({ status: 'UNKNOWN' });
    expect(parseCreateKhataLinkResponse('nope', BASE)).toEqual({ status: 'UNKNOWN' });
    expect(parseCreateKhataLinkResponse({ token: TOKEN }, BASE)).toEqual({ status: 'UNKNOWN' });
  });
});

describe('parseRevokeKhataLinkResponse', () => {
  it('reports whether a live link was actually killed', () => {
    expect(parseRevokeKhataLinkResponse({ status: 'ok', was_active: true })).toEqual({
      status: 'ok',
      wasActive: true,
    });
  });

  it('is idempotent-friendly: a second revoke is ok/false, not an error', () => {
    expect(parseRevokeKhataLinkResponse({ status: 'ok', was_active: false })).toEqual({
      status: 'ok',
      wasActive: false,
    });
  });

  it('passes failures through', () => {
    expect(parseRevokeKhataLinkResponse({ status: 'NOT_FOUND' })).toEqual({ status: 'NOT_FOUND' });
    expect(parseRevokeKhataLinkResponse(null)).toEqual({ status: 'UNKNOWN' });
  });
});

describe('isMissingKhataRpcError / khataStatusFromThrown', () => {
  it('detects an un-applied migration from PostgREST codes and prose', () => {
    expect(isMissingKhataRpcError({ code: 'PGRST202' })).toBe(true);
    expect(isMissingKhataRpcError({ code: '42883' })).toBe(true);
    expect(isMissingKhataRpcError({ message: 'Could not find the function public.get_khata_view' })).toBe(true);
    expect(isMissingKhataRpcError({ message: 'schema cache' })).toBe(true);
    expect(isMissingKhataRpcError({ message: 'something else' })).toBe(false);
    expect(isMissingKhataRpcError(null)).toBe(false);
  });

  it('maps transport errors into the shared vocabulary', () => {
    expect(khataStatusFromThrown({ code: 'PGRST202' })).toBe('RPC_MISSING');
    expect(khataStatusFromThrown({ message: 'Failed to fetch' })).toBe('NETWORK');
    expect(khataStatusFromThrown({ message: 'JWT expired' })).toBe('NOT_AUTHENTICATED');
    expect(khataStatusFromThrown({ message: 'khata_links: KHATA_LINK_IS_SERVER_ONLY' })).toBe('RPC_MISSING');
    expect(khataStatusFromThrown({ message: 'boom' })).toBe('UNKNOWN');
    expect(khataStatusFromThrown('network down')).toBe('NETWORK');
    expect(khataStatusFromThrown(undefined)).toBe('UNKNOWN');
  });
});

describe('message keys', () => {
  it('has a key for every failure status', () => {
    for (const status of ['NOT_AUTHENTICATED', 'NOT_FOUND', 'CONTACT_ARCHIVED', 'RPC_MISSING', 'NETWORK', 'UNKNOWN'] as const) {
      expect(khataStatusMessageKey(status)).toBeTruthy();
    }
  });

  it('formats a rejected result object and a raw error identically', () => {
    const translate = (key: string) => `t:${key}`;
    expect(formatKhataError({ status: 'NOT_FOUND' }, translate as never)).toBe('t:clink_err_contact_missing');
    expect(formatKhataError({ code: 'PGRST202' }, translate as never)).toBe('t:khata_err_unavailable');
    expect(formatKhataError(new Error('kaboom'), translate as never)).toBe('t:khata_err_unknown');
  });
});

describe('parseKhataView', () => {
  const payload = {
    owner: { name: 'Ali Raza' },
    person: { name: 'Sana Khan' },
    initialsOnly: false,
    expiresAt: '2026-12-01T00:00:00.000Z',
    asOf: '2026-09-02T00:00:00.000Z',
    net: [
      { currency: 'PKR', balance: 14000 },
      { currency: 'AED', balance: -500 },
    ],
    loans: [
      {
        id: 'L1', type: 'given', totalAmount: 25000, remainingAmount: 20000,
        currency: 'PKR', status: 'active', notes: 'Bike repair',
        createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
      },
      {
        id: 'L2', type: 'taken', totalAmount: 8000, remainingAmount: 6000,
        currency: 'PKR', status: 'active', notes: '',
        createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    transactions: [
      { id: 'T1', type: 'loan_given', amount: 25000, currency: 'PKR', relatedLoanId: 'L1', notes: '', createdAt: '2026-08-03T00:00:00.000Z' },
      // The splits_only case: a ledger repayment. The projection carries no
      // account ids at all, so this must survive parsing unchanged.
      { id: 'T3', type: 'repayment', amount: 2000, currency: 'PKR', relatedLoanId: 'L2', notes: 'ledger-mode', createdAt: '2026-09-01T00:00:00.000Z' },
    ],
  };

  it('narrows the whole projection', () => {
    const view = parseKhataView(payload);
    expect(view).not.toBeNull();
    expect(view!.ownerName).toBe('Ali Raza');
    expect(view!.personName).toBe('Sana Khan');
    expect(view!.net).toEqual([
      { currency: 'PKR', balance: 14000 },
      { currency: 'AED', balance: -500 },
    ]);
    expect(view!.loans).toHaveLength(2);
    expect(view!.transactions).toHaveLength(2);
  });

  it('carries showNotes, defaulting to false when the server omits it', () => {
    expect(parseKhataView(payload)!.showNotes).toBe(false);
    expect(parseKhataView({ ...payload, showNotes: false })!.showNotes).toBe(false);
    expect(parseKhataView({ ...payload, showNotes: true })!.showNotes).toBe(true);
  });

  it('treats a hidden (server-nulled) note as no note, not a crash', () => {
    // show_notes=false on the server means every `notes` field in the payload
    // is null — the parser must not choke on that, same as an empty string.
    const view = parseKhataView({
      ...payload,
      showNotes: false,
      loans: [{ ...payload.loans[0], notes: null }],
      transactions: [{ ...payload.transactions[0], notes: null }],
    })!;
    expect(view.showNotes).toBe(false);
    expect(view.loans[0].notes).toBe('');
    expect(view.transactions[0].notes).toBe('');
  });

  it('produces rows buildStatement can consume, in BOTH app modes', () => {
    const view = parseKhataView(payload)!;
    // Every projected loan carries the party name so a renderer never has to
    // reach back into the payload for it.
    expect(view.loans.every((l) => l.personName === 'Sana Khan')).toBe(true);
    // splits_only: both account ids null is the normal, valid shape here.
    const ledgerRepayment = view.transactions.find((t) => t.id === 'T3')!;
    expect(ledgerRepayment.sourceAccountId).toBeNull();
    expect(ledgerRepayment.destinationAccountId).toBeNull();
    expect(ledgerRepayment.relatedLoanId).toBe('L2');
    expect(ledgerRepayment.type).toBe('repayment');
  });

  it('returns null for the server\'s one uniform refusal', () => {
    // Unknown / revoked / expired / blocked / rate-limited all arrive as NULL.
    expect(parseKhataView(null)).toBeNull();
    expect(parseKhataView(undefined)).toBeNull();
    expect(parseKhataView([])).toBeNull();
    expect(parseKhataView('nope')).toBeNull();
  });

  it('returns null rather than rendering a page addressed to nobody', () => {
    expect(parseKhataView({ ...payload, owner: {} })).toBeNull();
    expect(parseKhataView({ ...payload, person: { name: '   ' } })).toBeNull();
  });

  it('accepts the initials-only payload as a normal one', () => {
    const view = parseKhataView({
      ...payload,
      initialsOnly: true,
      owner: { name: 'A.R.' },
      person: { name: 'S.K.' },
    })!;
    expect(view.initialsOnly).toBe(true);
    expect(view.ownerName).toBe('A.R.');
    expect(view.personName).toBe('S.K.');
  });

  it('drops rows it cannot key on, and coerces junk numbers to 0', () => {
    const view = parseKhataView({
      ...payload,
      loans: [{ id: '', type: 'given' }, { id: 'L9', type: 'given', totalAmount: 'oops' }],
      transactions: [{ id: 'T9', type: 'repayment', amount: 1, relatedLoanId: null }, { id: '', relatedLoanId: 'L9' }],
    })!;
    expect(view.loans.map((l) => l.id)).toEqual(['L9']);
    expect(view.loans[0].totalAmount).toBe(0);
    // A transaction with no loan to attach to would be invisible on the
    // statement anyway — dropping it keeps the counts honest.
    expect(view.transactions).toHaveLength(0);
  });

  it('defaults a missing asOf to now instead of an empty string', () => {
    const view = parseKhataView({ ...payload, asOf: undefined })!;
    expect(Number.isFinite(Date.parse(view.asOf))).toBe(true);
  });

  it('treats an unknown loan type as "given" and an unknown status as active', () => {
    const view = parseKhataView({
      ...payload,
      loans: [{ id: 'L1', type: 'weird', status: 'weird', currency: 'PKR', createdAt: 'x' }],
    })!;
    expect(view.loans[0].type).toBe('given');
    expect(view.loans[0].status).toBe('active');
  });
});

describe('daysUntilExpiry', () => {
  const now = Date.parse('2026-09-02T00:00:00.000Z');

  it('counts whole days, rounding up', () => {
    expect(daysUntilExpiry('2026-12-01T00:00:00.000Z', now)).toBe(90);
    expect(daysUntilExpiry('2026-09-02T12:00:00.000Z', now)).toBe(1);
  });

  it('floors at zero for an already-expired or unreadable date', () => {
    expect(daysUntilExpiry('2026-09-01T00:00:00.000Z', now)).toBe(0);
    expect(daysUntilExpiry('', now)).toBe(0);
    expect(daysUntilExpiry('not a date', now)).toBe(0);
  });
});

describe('khata share-at-save nudge memory', () => {
  const now = Date.parse('2026-09-02T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  it('offers a person who has never been nudged', () => {
    expect(shouldOfferKhataShareNudge('p-fresh', now)).toBe(true);
  });

  it('goes quiet for 14 days after being shown, then reopens', () => {
    snoozeKhataShareNudge('p-1', now);
    expect(shouldOfferKhataShareNudge('p-1', now)).toBe(false);
    expect(shouldOfferKhataShareNudge('p-1', now + 13 * DAY)).toBe(false);
    expect(shouldOfferKhataShareNudge('p-1', now + 14 * DAY)).toBe(true);
  });

  it('tracks each person independently', () => {
    snoozeKhataShareNudge('p-2', now);
    expect(shouldOfferKhataShareNudge('p-3', now)).toBe(true);
  });

  it('never offers for an empty id', () => {
    expect(shouldOfferKhataShareNudge('', now)).toBe(false);
  });
});
