// Edit history — rendering a server-written change row into a human sentence.
//
// Audit 11-competitive-analysis.md G5 / O10: "no surfaced who-changed-what
// history per record … for a two-sided ledger, edit accountability is the
// dispute-resolution layer". The rows come from `public.record_edits`
// (supabase-migration-p2-edit-history.sql); this module turns one of them into
// lines a person can read, and nothing else.
//
// Pure. No store, no page, no supabaseDb, no i18n import, no side effect —
// same contract as whoOwesMe.ts / settleUpMinimize.ts. The {ur, en} templates
// live HERE rather than in i18n.ts because they are data this module indexes
// by field name and action; the SHEET's own chrome (title, empty state,
// "History" row label) is ordinary UI copy and lives in i18n.ts as usual.
//
// `ur` is roman Urdu (Latin script) and is the app default.

export type EditHistoryTable =
  | 'group_expenses'
  | 'group_settlements'
  | 'loans'
  | 'transactions';

export type EditHistoryAction = 'insert' | 'update' | 'delete' | 'soft_delete';

export type EditHistoryLang = 'ur' | 'en';

/** One column's before/after. `null` on either side means "absent". */
export interface EditHistoryChange {
  old: unknown;
  new: unknown;
}

/** One row of `public.record_edits`. */
export interface EditHistoryEntry {
  id: number;
  tableName: EditHistoryTable;
  recordId: string;
  groupId: string | null;
  ownerId: string | null;
  /** null = the account was deleted, OR a system path wrote it (see actorKind). */
  actorId: string | null;
  actorKind: 'user' | 'system';
  action: EditHistoryAction;
  changed: Record<string, EditHistoryChange>;
  createdAt: string;
}

/**
 * The columns each trigger tracks, mirroring
 * supabase-migration-p2-edit-history.sql §4.4 exactly.
 *
 * Kept here so the client has a checkable copy of the promise the SQL makes —
 * `editHistory.test.ts` asserts that NO account id is in any list, which is
 * the both-app-modes rule (a splits_only row carries both account ids null; a
 * full_tracker row carries real ones, and the history must not be able to
 * tell them apart).
 */
export const EDIT_HISTORY_TRACKED_FIELDS: Record<EditHistoryTable, readonly string[]> = {
  group_expenses: ['amount', 'description', 'date', 'notes', 'paid_by', 'split_type', 'splits'],
  group_settlements: ['amount', 'date', 'note', 'from_member', 'to_member'],
  loans: ['person_name', 'person_id', 'total_amount', 'remaining_amount', 'currency', 'status', 'notes'],
  transactions: ['amount', 'currency', 'related_person', 'person_id', 'notes', 'created_at'],
};

/**
 * Defence in depth for the rule above. Anything whose key looks like an
 * account reference is dropped before rendering, even if a future migration
 * widens a whitelist by mistake — the sheet is shared with GROUP MEMBERS.
 */
export function isForbiddenHistoryField(field: string): boolean {
  return /account_?id/i.test(field);
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

type Bilingual = { ur: string; en: string };

const TEMPLATES = {
  created: {
    ur: '{actor} ne yeh entry banai',
    en: '{actor} created this record',
  },
  created_amount: {
    ur: '{actor} ne yeh entry banai — {amount}',
    en: '{actor} created this record — {amount}',
  },
  deleted: {
    ur: '{actor} ne yeh entry delete ki',
    en: '{actor} deleted this record',
  },
  deleted_amount: {
    ur: '{actor} ne yeh entry delete ki — {amount}',
    en: '{actor} deleted this record — {amount}',
  },
  changed: {
    ur: '{actor} ne {field} {old} → {new} ki',
    en: '{actor} changed {field} {old} → {new}',
  },
  set: {
    ur: '{actor} ne {field} {new} rakhi',
    en: '{actor} set {field} to {new}',
  },
  cleared: {
    ur: '{actor} ne {field} hata di',
    en: '{actor} cleared {field}',
  },
  payer_changed: {
    ur: '{actor} ne payer {old} se {new} kiya',
    en: '{actor} changed the payer from {old} to {new}',
  },
  payer_set: {
    ur: '{actor} ne payer {new} rakha',
    en: '{actor} set the payer to {new}',
  },
  split_added: {
    ur: '{actor} ne {name} ko split mein shamil kiya',
    en: '{actor} added {name} to the split',
  },
  split_removed: {
    ur: '{actor} ne {name} ko split se nikala',
    en: '{actor} removed {name} from the split',
  },
  split_changed: {
    ur: '{actor} ne {name} ka hissa {old} → {new} kiya',
    en: "{actor} changed {name}'s share {old} → {new}",
  },
  loan_settled: {
    ur: '{actor} ne is qarz ko barabar mark kiya',
    en: '{actor} marked this loan settled',
  },
  loan_reopened: {
    ur: '{actor} ne is qarz ko dobara khola',
    en: '{actor} reopened this loan',
  },
} satisfies Record<string, Bilingual>;

export type EditHistoryTemplateKey = keyof typeof TEMPLATES;

/** Human label for a tracked column. */
const FIELD_LABELS: Record<string, Bilingual> = {
  amount: { ur: 'raqam', en: 'amount' },
  total_amount: { ur: 'kul raqam', en: 'total' },
  remaining_amount: { ur: 'baqi raqam', en: 'remaining' },
  date: { ur: 'tareekh', en: 'date' },
  created_at: { ur: 'tareekh', en: 'date' },
  notes: { ur: 'note', en: 'note' },
  note: { ur: 'note', en: 'note' },
  description: { ur: 'tafseel', en: 'description' },
  currency: { ur: 'currency', en: 'currency' },
  status: { ur: 'halat', en: 'status' },
  split_type: { ur: 'split ka tareeqa', en: 'split type' },
  person_name: { ur: 'naam', en: 'name' },
  person_id: { ur: 'contact', en: 'contact' },
  related_person: { ur: 'naam', en: 'name' },
  from_member: { ur: 'bhejnay wala', en: 'payer' },
  to_member: { ur: 'lenay wala', en: 'receiver' },
  paid_by: { ur: 'payer', en: 'payer' },
  splits: { ur: 'split', en: 'split' },
};

/** Fields formatted as money. Everything else renders as plain text. */
const MONEY_FIELDS = new Set(['amount', 'total_amount', 'remaining_amount']);
/** Fields formatted as a date. */
const DATE_FIELDS = new Set(['date', 'created_at']);
/** Fields whose value is a group member id, not text. */
const MEMBER_FIELDS = new Set(['paid_by', 'from_member', 'to_member']);

/**
 * Render order. Deterministic and independent of JSON key order, so two
 * clients reading the same row produce the same lines. Anything not listed
 * renders after these, in alphabetical order.
 */
const FIELD_ORDER = [
  'amount',
  'total_amount',
  'remaining_amount',
  'status',
  'currency',
  'date',
  'created_at',
  'description',
  'paid_by',
  'from_member',
  'to_member',
  'person_name',
  'person_id',
  'related_person',
  'split_type',
  'splits',
  'notes',
  'note',
];

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface EditHistoryRenderContext {
  lang: EditHistoryLang;
  /**
   * The already-resolved actor name — "Aap"/"You" for self, a group member's
   * display_name, the owner's own name, or a system label. Resolution needs
   * stores, so it happens in the sheet; this module only substitutes it.
   */
  actorName: string;
  /** memberId → display name, for split/payer sentences. */
  memberName?: (memberId: string) => string;
  /** Money formatter bound to the record's currency. */
  money?: (value: number) => string;
  /** Date formatter for `date` / `created_at` values. */
  date?: (value: string) => string;
}

export interface EditHistoryLine {
  /** Stable per (entry, field/participant) — safe as a React key. */
  key: string;
  template: EditHistoryTemplateKey;
  text: string;
}

interface NormalizedSplit {
  memberId: string;
  amount: number | null;
}

function fill(template: Bilingual, lang: EditHistoryLang, vars: Record<string, string>): string {
  let out = template[lang];
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

function labelOf(field: string, lang: EditHistoryLang): string {
  const label = FIELD_LABELS[field];
  return label ? label[lang] : field.replace(/_/g, ' ');
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Format one field value for display. Returns '' for absent/blank. */
function formatValue(field: string, value: unknown, ctx: EditHistoryRenderContext): string {
  if (value === null || value === undefined) return '';
  if (MONEY_FIELDS.has(field)) {
    const n = asNumber(value);
    if (n === null) return String(value);
    return ctx.money ? ctx.money(n) : String(n);
  }
  if (DATE_FIELDS.has(field)) {
    const raw = String(value);
    if (!raw.trim()) return '';
    return ctx.date ? ctx.date(raw) : raw;
  }
  if (MEMBER_FIELDS.has(field)) {
    const id = String(value);
    return ctx.memberName ? ctx.memberName(id) : id;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function normalizeSplits(value: unknown): NormalizedSplit[] {
  if (!Array.isArray(value)) return [];
  const out: NormalizedSplit[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const memberId = row.memberId ?? row.member_id;
    if (typeof memberId !== 'string' || memberId === '') continue;
    out.push({ memberId, amount: asNumber(row.amount) });
  }
  // Sorted so the diff never depends on serialization order — the same rule
  // record_edits_splits() applies server-side.
  return out.sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

function orderFields(fields: string[]): string[] {
  const known = FIELD_ORDER.filter((f) => fields.includes(f));
  const rest = fields.filter((f) => !FIELD_ORDER.includes(f)).sort();
  return [...known, ...rest];
}

function splitLines(
  entry: EditHistoryEntry,
  change: EditHistoryChange,
  ctx: EditHistoryRenderContext,
): EditHistoryLine[] {
  const before = normalizeSplits(change.old);
  const after = normalizeSplits(change.new);
  const beforeMap = new Map(before.map((s) => [s.memberId, s.amount]));
  const afterMap = new Map(after.map((s) => [s.memberId, s.amount]));

  const ids = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const lines: EditHistoryLine[] = [];

  for (const id of ids) {
    const name = ctx.memberName ? ctx.memberName(id) : id;
    const had = beforeMap.has(id);
    const has = afterMap.has(id);
    const oldAmount = beforeMap.get(id) ?? null;
    const newAmount = afterMap.get(id) ?? null;

    if (!had && has) {
      lines.push({
        key: `${entry.id}:splits:+${id}`,
        template: 'split_added',
        text: fill(TEMPLATES.split_added, ctx.lang, { actor: ctx.actorName, name }),
      });
    } else if (had && !has) {
      lines.push({
        key: `${entry.id}:splits:-${id}`,
        template: 'split_removed',
        text: fill(TEMPLATES.split_removed, ctx.lang, { actor: ctx.actorName, name }),
      });
    } else if (oldAmount !== newAmount) {
      lines.push({
        key: `${entry.id}:splits:~${id}`,
        template: 'split_changed',
        text: fill(TEMPLATES.split_changed, ctx.lang, {
          actor: ctx.actorName,
          name,
          old: formatValue('amount', oldAmount, ctx),
          new: formatValue('amount', newAmount, ctx),
        }),
      });
    }
  }
  return lines;
}

/**
 * One change row → the sentences that describe it.
 *
 * Returns at least one line for every entry: an `insert` or `soft_delete`
 * always yields its headline even when no tracked field carried a value, and
 * an `update` whose diff renders to nothing falls back to the headline too,
 * so a history row can never appear as an empty bullet.
 */
export function renderEditHistoryEntry(
  entry: EditHistoryEntry,
  ctx: EditHistoryRenderContext,
): EditHistoryLine[] {
  const changed = entry.changed ?? {};
  const fields = orderFields(
    Object.keys(changed).filter((f) => !isForbiddenHistoryField(f)),
  );

  // ── insert / soft_delete: one headline, carrying the money if we have it.
  if (entry.action === 'insert' || entry.action === 'delete' || entry.action === 'soft_delete') {
    const created = entry.action === 'insert';
    const moneyField: 'amount' | 'total_amount' | null = changed.amount
      ? 'amount'
      : changed.total_amount
        ? 'total_amount'
        : null;
    const side = created ? 'new' : 'old';
    const amount = moneyField ? formatValue(moneyField, changed[moneyField][side], ctx) : '';
    const template: EditHistoryTemplateKey = created
      ? (amount ? 'created_amount' : 'created')
      : (amount ? 'deleted_amount' : 'deleted');
    return [{
      key: `${entry.id}:${entry.action}`,
      template,
      text: fill(TEMPLATES[template], ctx.lang, { actor: ctx.actorName, amount }),
    }];
  }

  // ── update: one line per changed field.
  const lines: EditHistoryLine[] = [];
  for (const field of fields) {
    const change = changed[field];
    if (!change) continue;

    if (field === 'splits') {
      lines.push(...splitLines(entry, change, ctx));
      continue;
    }

    if (field === 'status' && entry.tableName === 'loans') {
      const next = typeof change.new === 'string' ? change.new : '';
      if (next === 'settled' || next === 'active') {
        const template: EditHistoryTemplateKey = next === 'settled' ? 'loan_settled' : 'loan_reopened';
        lines.push({
          key: `${entry.id}:status`,
          template,
          text: fill(TEMPLATES[template], ctx.lang, { actor: ctx.actorName }),
        });
        continue;
      }
    }

    const oldText = formatValue(field, change.old, ctx);
    const newText = formatValue(field, change.new, ctx);
    if (oldText === newText) continue;

    if (field === 'paid_by') {
      const template: EditHistoryTemplateKey = oldText ? 'payer_changed' : 'payer_set';
      lines.push({
        key: `${entry.id}:paid_by`,
        template,
        text: fill(TEMPLATES[template], ctx.lang, {
          actor: ctx.actorName,
          old: oldText,
          new: newText,
        }),
      });
      continue;
    }

    const template: EditHistoryTemplateKey = !newText ? 'cleared' : !oldText ? 'set' : 'changed';
    lines.push({
      key: `${entry.id}:${field}`,
      template,
      text: fill(TEMPLATES[template], ctx.lang, {
        actor: ctx.actorName,
        field: labelOf(field, ctx.lang),
        old: oldText,
        new: newText,
      }),
    });
  }

  if (lines.length === 0) {
    // Should not happen — the trigger refuses to write an empty update — but a
    // row whose only changed field was forbidden/unrenderable must still read
    // as something rather than as a blank bullet.
    return [{
      key: `${entry.id}:update`,
      template: 'created',
      text: fill(TEMPLATES.created, ctx.lang, { actor: ctx.actorName }),
    }];
  }
  return lines;
}

/** Every line of a whole list, newest first, flattened for rendering. */
export function renderEditHistory(
  entries: readonly EditHistoryEntry[],
  ctxFor: (entry: EditHistoryEntry) => EditHistoryRenderContext,
): { entry: EditHistoryEntry; lines: EditHistoryLine[] }[] {
  return entries.map((entry) => ({ entry, lines: renderEditHistoryEntry(entry, ctxFor(entry)) }));
}
