import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { linkedRequestsDb } from '../lib/supabaseDb';
import { SUPPORTED_CURRENCIES } from '../db';
import type { LinkedRequest, LinkedRequestKind, Currency, Loan } from '../db';
import { plausibilityCheck } from '../lib/currencyValidation';
import { translateLinkedWriteError, isDuplicateKeyError } from '../lib/linkedErrorMap';
import { syncCandidateLoans } from '../lib/syncableLoans';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';
import { usePersonStore } from './personStore';
import { useAccountStore } from './accountStore';
import { reportError } from '../lib/errorReporter';

// Currencies the linked_transaction_requests SQL check constraint allows.
// Was ['AED','PKR'] to match the original hard CHECK in
// supabase-migration-phase2b-linked-requests.sql:14 — which silently killed
// cross-user udhaar for 6 of the 8 shipped currencies on the un-gated primary
// paths (audit 2026-09, F-MIG2 / H6). supabase-migration-audit-p0-currencies.sql
// widens the DB constraint to the full SUPPORTED_CURRENCIES list, so the client
// gate now mirrors it exactly. If a build ever reaches a database without that
// migration, the insert fails with SQLSTATE 23514 and createRequest below
// translates it into friendly bilingual copy instead of a raw Postgres string.
export const LINKED_REQUEST_CURRENCIES = SUPPORTED_CURRENCIES;
export type LinkedRequestCurrency = typeof LINKED_REQUEST_CURRENCIES[number];
function isLinkedRequestCurrency(c: Currency): c is LinkedRequestCurrency {
  return (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(c);
}

interface CreateInput {
  toUserId: string;
  personId: string;
  kind: LinkedRequestKind;
  amount: number;
  currency: Currency;
  note?: string;
  // Phase 2D: when set, the request references an existing sender-side
  // loan instead of creating a fresh one on acceptance.
  preExistingLoanId?: string | null;
  // Sender's opted-in account — debited (lent) / credited (borrowed) when
  // the other side accepts. Null ⇒ sender side ledger-only. Never combined
  // with preExistingLoanId (past money must not double-count).
  requesterAccountId?: string | null;
  // Idempotency key (audit 2026-09, F-8). The row id is the table's client
  // -supplied `text primary key`, so a caller that mints ONE id per submit
  // intent (see useSubmitIntentId) turns a double-fire into a primary-key
  // collision instead of two identical debt requests mirrored onto the
  // counterparty's ledger. Omitted ⇒ a fresh uuid per call, i.e. the old
  // behaviour, so untouched callers are unaffected.
  requestId?: string;
}

export interface SyncableLoansBreakdown {
  // Loans eligible to sync right now: active, remaining > 0, currency
  // accepted by linked_transaction_requests, not already in a pending
  // sync request.
  syncable: Loan[];
  // Loans that match the person + active state but have a currency
  // the linked request table doesn't accept yet (everything outside
  // LINKED_REQUEST_CURRENCIES). Surface the count so the UI can be
  // honest about what won't be sent.
  skipped: Loan[];
}

export interface SyncPastRecordsResult extends SyncableLoansBreakdown {
  // The N requests we just created — one per loan in `syncable`.
  created: LinkedRequest[];
}

interface LinkedRequestState {
  requests: LinkedRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  createRequest: (input: CreateInput) => Promise<LinkedRequest>;
  accept: (requestId: string, responderAccountId?: string | null) => Promise<LinkedRequest>;
  reject: (requestId: string, reason?: string) => Promise<LinkedRequest>;
  cancel: (requestId: string) => Promise<LinkedRequest>;
  incomingPending: (myUserId: string) => LinkedRequest[];
  outgoingPending: (myUserId: string) => LinkedRequest[];
  forTab: (tab: 'incoming' | 'outgoing', myUserId: string) => LinkedRequest[];
  // Returns the syncable + skipped split for a person. UI uses syncable
  // to render the per-currency open-balance preview, and skipped to
  // surface "N loans in unsupported currencies were left as local-only".
  syncableBreakdownFor: (personId: string) => SyncableLoansBreakdown;
  // Fires N linked-request inserts in parallel — one per loan in
  // `syncable`. Returns the breakdown + created list so the caller can
  // render a confirmation summary.
  syncPastRecords: (personId: string) => Promise<SyncPastRecordsResult>;
  reset: () => void;
}

const INITIAL: Pick<LinkedRequestState, 'requests' | 'loading'> = {
  requests: [],
  loading: false,
};

function upsert(list: LinkedRequest[], next: LinkedRequest): LinkedRequest[] {
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export const useLinkedRequestStore = create<LinkedRequestState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadRequests: async () => {
    set({ loading: true });
    try {
      const requests = await linkedRequestsDb.getAll();
      set({ requests });
    } finally {
      set({ loading: false });
    }
  },

  createRequest: async (input) => {
    // Server-of-last-resort: refuse a gross currency typo at the source, before
    // it can ever be mirrored onto the other user (currency locks on accept).
    const check = plausibilityCheck(input.amount, input.currency);
    if (!check.passed && check.severity === 'block') {
      throw new Error(check.reason ?? "That amount doesn't look right.");
    }
    const id = input.requestId ?? uuid();
    try {
      await linkedRequestsDb.insert({
        id,
        toUserId: input.toUserId,
        personId: input.personId,
        kind: input.kind,
        amount: input.amount,
        currency: input.currency,
        note: input.note ?? '',
        preExistingLoanId: input.preExistingLoanId ?? null,
        requesterAccountId: input.requesterAccountId ?? null,
      });
    } catch (err) {
      // Idempotent create (audit F-8): the id is this submit intent's key, so
      // a primary-key collision means THIS request already exists — a second
      // tap or a retry after an ambiguous network failure. Treat it as
      // success and fall through to the reload, which returns the row that
      // actually landed. If the 23505 came from some other constraint the
      // lookup below finds nothing and still throws.
      if (!isDuplicateKeyError(err)) {
        // Graceful fallback for a database that hasn't had
        // supabase-migration-audit-p0-currencies.sql applied yet: the raw
        // SQLSTATE 23514 check violation used to reach the toast verbatim and
        // the whole entry was lost with no explanation (audit F-MIG2 / H6).
        // Every caller surfaces `err.message`, so translating here covers the
        // AddLoanModal, QuickEntry (both modes) and sync-past-records paths.
        // Report the RAW error before translation - see F-MIG2 above.
        reportError(err, { feature: 'linkedRequestStore.createRequest', extra: { requestId: id, kind: input.kind } });
        throw translateLinkedWriteError(err, 'loan');
      }
    }
    // Reload to get the canonical row (status, created_at, etc.).
    await get().loadRequests();
    const inserted = get().requests.find((r) => r.id === id);
    if (!inserted) throw new Error('Request created but could not be reloaded');
    return inserted;
  },

  accept: async (requestId, responderAccountId) => {
    const updated = await linkedRequestsDb.accept(requestId, responderAccountId ?? null);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    // Pull the newly-mirrored loan + transaction rows, plus accounts: either
    // side may have opted into a balance effect (sender at create, receiver
    // just now). A no-op reload for ledger-only accepts.
    try {
      await useLoanStore.getState().loadLoans();
      await useTransactionStore.getState().loadTransactions();
      await useAccountStore.getState().loadAccounts();
    } catch (err) {
      reportError(err, { feature: 'linkedRequestStore.accept.reload', extra: { requestId } });
    }
    return updated;
  },

  reject: async (requestId, reason) => {
    const updated = await linkedRequestsDb.reject(requestId, reason);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  cancel: async (requestId) => {
    const updated = await linkedRequestsDb.cancel(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  syncableBreakdownFor: (personId) => {
    // A loan must not be offered for sync if it's already shared with the
    // other user — re-sending it would create a duplicate request and leave
    // both ledgers ambiguous (the reported "keeps asking to sync again" bug).
    // syncCandidateLoans encodes the three "already shared" signals; see
    // src/lib/syncableLoans.ts. Currency support is applied below.
    const candidates = syncCandidateLoans(personId, useLoanStore.getState().loans, get().requests);
    const syncable: Loan[] = [];
    const skipped: Loan[] = [];
    for (const loan of candidates) {
      if (isLinkedRequestCurrency(loan.currency)) syncable.push(loan);
      else skipped.push(loan);
    }
    return { syncable, skipped };
  },

  syncPastRecords: async (personId) => {
    const person = usePersonStore.getState().persons.find((p) => p.id === personId);
    if (!person) throw new Error('Contact not found');
    if (!person.linkedProfileId) {
      throw new Error('Contact is not linked to a Hisaab user yet');
    }
    const { syncable, skipped } = get().syncableBreakdownFor(personId);
    if (syncable.length === 0) return { syncable, skipped, created: [] };

    // Build requests in parallel. We send each loan's CURRENT remaining
    // amount (not original total) so the receiver sees what's actually
    // open between them. The local sender-side loan keeps its full
    // history — the accept_linked_request RPC reuses it on acceptance,
    // no duplicate row created. Each request carries its OWN currency
    // from the underlying loan; mixed-currency contacts produce one
    // request per currency naturally.
    const created: LinkedRequest[] = await Promise.all(
      syncable.map((loan) =>
        get().createRequest({
          toUserId: person.linkedProfileId!,
          personId: person.id,
          kind: loan.type === 'given' ? 'lent' : 'borrowed',
          amount: loan.remainingAmount,
          currency: loan.currency,
          note: loan.notes ?? '',
          preExistingLoanId: loan.id,
        }),
      ),
    );

    return { syncable, skipped, created };
  },

  incomingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.toUserId === myUserId),

  outgoingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.fromUserId === myUserId),

  forTab: (tab, myUserId) =>
    get().requests.filter((r) =>
      tab === 'incoming' ? r.toUserId === myUserId : r.fromUserId === myUserId,
    ),
}));
