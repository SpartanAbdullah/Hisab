const INTERNAL_NOTE_PREFIX = '[[HISAAB_META:';
const INTERNAL_NOTE_SUFFIX = ']]';

export interface InternalNoteMeta {
  expenseDescription?: string;
  groupExpenseId?: string;
  groupId?: string;
  groupName?: string;
  linkedTransactionId?: string;
  paidFromAccountId?: string;
  // Cash-advance repayments: the amount ACTUALLY credited to the funding card
  // when the credit was clamped below the repayment amount (card near/at its
  // limit). Deletion reverses exactly this, not the row's full amount.
  cardCreditedAmount?: string;
  // Goal contribution made FROM the account the goal is stored in — no
  // balance legs were applied (money stayed put); deletion must skip them too.
  goalSelfStored?: string;
  // Recurring expansion idempotency key: `${templateId}@${dueDate}`. A due
  // charge posts at most once per (template, due date) across retries/devices.
  recurringExpansion?: string;
  // "Settle — no money moved": this repayment row records a write-off /
  // forgiveness, not cash. Money views (flex budget, week flow) must skip it,
  // unlike other ledger-only repayment rows which DO stand in for real money.
  writeOff?: string;
}

export interface ParsedInternalNote {
  visibleNote: string;
  meta: InternalNoteMeta;
}

export function parseInternalNote(raw: string | null | undefined): ParsedInternalNote {
  const note = raw ?? '';

  if (!note.startsWith(INTERNAL_NOTE_PREFIX)) {
    return { visibleNote: note, meta: {} };
  }

  const endIndex = note.indexOf(INTERNAL_NOTE_SUFFIX);
  if (endIndex === -1) {
    return { visibleNote: note, meta: {} };
  }

  const encodedMeta = note.slice(INTERNAL_NOTE_PREFIX.length, endIndex);
  const visibleNote = note.slice(endIndex + INTERNAL_NOTE_SUFFIX.length).replace(/^\n/, '');

  try {
    const meta = JSON.parse(decodeURIComponent(encodedMeta)) as InternalNoteMeta;
    return { visibleNote, meta };
  } catch {
    return { visibleNote: note, meta: {} };
  }
}

export function buildInternalNote(visibleNote: string, meta: InternalNoteMeta = {}): string {
  const compactMeta = Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== '')
  ) as InternalNoteMeta;

  if (Object.keys(compactMeta).length === 0) {
    return visibleNote;
  }

  const encodedMeta = encodeURIComponent(JSON.stringify(compactMeta));
  const noteBody = visibleNote ? `\n${visibleNote}` : '';

  return `${INTERNAL_NOTE_PREFIX}${encodedMeta}${INTERNAL_NOTE_SUFFIX}${noteBody}`;
}

export function isGroupLinkedNote(raw: string | null | undefined): boolean {
  return Boolean(parseInternalNote(raw).meta.groupExpenseId);
}
