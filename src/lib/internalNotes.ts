const INTERNAL_NOTE_PREFIX = '[[HISAAB_META:';
const INTERNAL_NOTE_SUFFIX = ']]';

export interface InternalNoteMeta {
  expenseDescription?: string;
  groupExpenseId?: string;
  groupId?: string;
  groupName?: string;
  linkedTransactionId?: string;
  paidFromAccountId?: string;
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
