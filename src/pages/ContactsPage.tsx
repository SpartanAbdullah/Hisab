import { useEffect, useMemo, useState } from 'react';
import {
  Link2,
  Search,
  X,
  UserPlus,
  CheckCircle2,
  Sparkles,
  Info,
} from 'lucide-react';
import { usePersonStore } from '../stores/personStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { UserAvatar } from '../components/UserAvatar';
import { LanguageToggle } from '../components/LanguageToggle';
import { useToast } from '../components/Toast';
import { ContactDetailSheet } from './ContactDetailSheet';
import { useT } from '../lib/i18n';
import type { Person } from '../db';

// Sukoon screen 10. Full-screen replacement for the old ContactsModal.
// Contacts live in two flavours:
//   • Unlinked — a name the user keeps for their own ledger. Loans, splits
//     and reminders can still be recorded against them; the other person
//     isn't notified and there's no two-way confirmation.
//   • Linked — paired with another Hisaab user via their public code.
//     Loan/split records flow both ways: the linked user gets an inbox
//     request, confirms or declines, and the ledgers stay in sync.
// The Add flow on this page creates an unlinked contact. The user can link
// later by tapping the contact row — the existing ContactDetailSheet still
// hosts the code-lookup → confirm flow.
export function ContactsPage() {
  const persons = usePersonStore((s) => s.persons);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const createPerson = usePersonStore((s) => s.createPerson);
  const t = useT();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');

  // Add-contact form state. Inline expand-in-place form rather than a sheet
  // so the user keeps the page's letter sections visible as context.
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  // After a successful add we surface a short-lived "Link them now?" banner
  // so the user immediately understands they CAN link, without forcing it.
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [showLinkHelp, setShowLinkHelp] = useState(false);

  useEffect(() => {
    void loadPersons();
  }, [loadPersons]);

  // Filter then alphabetise. Search is case-insensitive on name only — link
  // status / external handles aren't part of the visible name so they don't
  // need to be queryable.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? persons.filter((p) => p.name.toLowerCase().includes(q))
      : persons;
    return [...base].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [persons, query]);

  // Group by first letter. Special bucket for non-alpha leads (#, digits,
  // emoji-starting names) so they always have a header rather than getting
  // tucked under "A".
  const groups = useMemo(() => {
    const map = new Map<string, Person[]>();
    for (const p of filtered) {
      const first = (p.name[0] ?? '?').toUpperCase();
      const key = /[A-Z]/.test(first) ? first : '#';
      const bucket = map.get(key) ?? [];
      bucket.push(p);
      map.set(key, bucket);
    }
    const ordered = [...map.entries()].sort(([a], [b]) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });
    return ordered;
  }, [filtered]);

  const linkedCount = useMemo(
    () => persons.filter((p) => Boolean(p.linkedProfileId)).length,
    [persons],
  );

  const lastCreated = useMemo(
    () => persons.find((p) => p.id === lastCreatedId) ?? null,
    [persons, lastCreatedId],
  );

  const selected: Person | null = selectedId
    ? persons.find((p) => p.id === selectedId) ?? null
    : null;

  const resetAddForm = () => {
    setShowAdd(false);
    setNewName('');
    setNewPhone('');
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await createPerson(trimmed, newPhone.trim() || null);
      toast.show({
        type: 'success',
        title: 'Contact added',
        subtitle: 'Saved as a local contact. Link to Hisaab from the row to enable two-way confirmation.',
      });
      setLastCreatedId(created.id);
      resetAddForm();
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not add contact',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('contacts_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="w-9 h-9 rounded-xl bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors"
                aria-label="Search"
              >
                <Search size={15} className="text-white" />
              </button>
              <button
                onClick={() => {
                  setShowAdd(true);
                  setShowSearch(false);
                }}
                className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[12px] font-semibold text-white transition-colors"
                aria-label="Add contact"
              >
                <UserPlus size={13} strokeWidth={2.4} /> Add
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-6">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {persons.length} {persons.length === 1 ? 'contact' : 'contacts'}
            {linkedCount > 0 && <> · {linkedCount} linked</>}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {showSearch && (
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts"
              className="w-full bg-cream-card border border-cream-border rounded-2xl pl-10 pr-10 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-400 active:scale-90"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Add-contact inline form. The explanatory copy here is the most
            common moment a user is asking themselves "should I link this?",
            so the linked-vs-unlinked distinction lives here, not buried
            below in a hint card. */}
        {showAdd && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 space-y-3 animate-fade-in">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
                <UserPlus size={18} className="text-accent-600" strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                  Add a contact
                </p>
                <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                  Anyone you owe or who owes you — friends, family, shopkeepers.
                  They don't need to be on Hisaab.
                </p>
              </div>
              <button
                onClick={resetAddForm}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors shrink-0"
                aria-label="Cancel"
              >
                <X size={14} />
              </button>
            </div>

            <div>
              <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-1.5">
                Name
              </label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Asif Ali"
                autoFocus
                className="w-full bg-cream-bg border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              />
            </div>

            <div>
              <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-1.5">
                Phone (optional)
              </label>
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+971 50 123 4567"
                inputMode="tel"
                className="w-full bg-cream-bg border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
              />
            </div>

            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="w-full rounded-xl bg-ink-900 text-white py-3 text-[13px] font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
            >
              {creating ? 'Adding…' : 'Add contact'}
            </button>

            {/* Inline guidance — the heart of "users shall be guided about
                the difference". Always-visible so a new user reading the
                Add form learns the model before submitting. */}
            <button
              type="button"
              onClick={() => setShowLinkHelp((v) => !v)}
              className="w-full flex items-center justify-between rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2.5 text-left active:bg-cream-hairline transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Info size={12} className="text-accent-600 shrink-0" />
                <span className="text-[11.5px] font-semibold text-ink-800 truncate">
                  What's the difference between unlinked and linked?
                </span>
              </span>
              <span className="text-[10px] text-ink-400 shrink-0">
                {showLinkHelp ? 'Hide' : 'Show'}
              </span>
            </button>

            {showLinkHelp && (
              <div className="rounded-xl bg-cream-soft border border-cream-hairline p-3 space-y-2.5 animate-fade-in">
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-lg bg-ink-200 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-semibold text-ink-600 uppercase">U</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink-900">
                      Unlinked
                    </p>
                    <p className="text-[11px] text-ink-500 leading-relaxed mt-0.5">
                      Just a name on your ledger. You record loans, splits and
                      reminders. They don't see anything — only you.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-lg bg-accent-100 flex items-center justify-center shrink-0">
                    <Link2 size={12} className="text-accent-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink-900">
                      Linked
                    </p>
                    <p className="text-[11px] text-ink-500 leading-relaxed mt-0.5">
                      Connected to another Hisaab user via their code. Loan and
                      split records go to their inbox to confirm or decline —
                      both ledgers stay in sync.
                    </p>
                  </div>
                </div>
                <p className="text-[10.5px] text-ink-400 leading-relaxed pt-1">
                  You can add now and link later — just tap their row when
                  they share a code.
                </p>
              </div>
            )}
          </div>
        )}

        {/* "Just-created" prompt — fires once after a successful add, gives
            the user an obvious one-tap path to start linking the new
            contact. They can dismiss without linking; the contact stays
            unlinked which is a perfectly valid steady state. */}
        {lastCreated && !showAdd && (
          <div className="rounded-[18px] bg-accent-50 border border-cream-border p-4 flex items-center gap-3 animate-fade-in">
            <div className="w-10 h-10 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
              <CheckCircle2 size={18} className="text-accent-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
                {lastCreated.name} added
              </p>
              <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                If they're on Hisaab too, link to enable two-way confirmation.
              </p>
            </div>
            <button
              onClick={() => {
                setSelectedId(lastCreated.id);
                setLastCreatedId(null);
              }}
              className="shrink-0 rounded-xl bg-ink-900 text-white px-3 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 active:scale-95 transition-transform"
            >
              <Link2 size={11} /> Link
            </button>
            <button
              onClick={() => setLastCreatedId(null)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-400 active:bg-cream-soft transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Linked-summary card — quiet steady-state reminder of how linking
            works, shown once the user has at least one contact. */}
        {persons.length > 0 && !showAdd && !lastCreated && (
          <div className="rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
              <Link2 size={18} className="text-accent-600" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                {linkedCount} of {persons.length} {persons.length === 1 ? 'contact is' : 'contacts are'} linked
              </p>
              <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                Tap a contact and use their Hisaab code to link — they'll get
                a confirmation request whenever you record a loan or split.
              </p>
            </div>
          </div>
        )}

        {/* Empty state — no contacts at all, or none match the query */}
        {persons.length === 0 ? (
          <div className="text-center py-10">
            <div className="w-14 h-14 rounded-3xl bg-accent-100 flex items-center justify-center mx-auto mb-3">
              <Sparkles size={22} className="text-accent-600" />
            </div>
            <p className="text-[13px] font-semibold text-ink-900">
              No contacts yet
            </p>
            <p className="text-[11px] text-ink-500 mt-1 max-w-[260px] mx-auto leading-relaxed">
              Add anyone you owe or who owes you. You can link them to Hisaab
              later when they sign up.
            </p>
            {!showAdd && (
              <button
                onClick={() => setShowAdd(true)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-ink-900 text-white px-4 py-2.5 text-[12px] font-semibold active:scale-95 transition-transform"
              >
                <UserPlus size={12} /> Add your first contact
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-[13px] text-ink-400 text-center py-10">
            No matches for "{query}"
          </p>
        ) : (
          groups.map(([letter, people]) => (
            <div key={letter}>
              <h2 className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.16em] mb-2 px-1">
                {letter}
              </h2>
              <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                {people.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => setSelectedId(person.id)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
                  >
                    <UserAvatar name={person.name} size={36} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
                          {person.name}
                        </p>
                        {person.linkedProfileId ? (
                          <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] rounded-full bg-accent-100 text-accent-600 px-1.5 py-0.5 shrink-0">
                            linked
                          </span>
                        ) : (
                          <span className="text-[8.5px] font-medium uppercase tracking-[0.1em] rounded-full bg-cream-soft border border-cream-hairline text-ink-500 px-1.5 py-0.5 shrink-0">
                            local
                          </span>
                        )}
                      </div>
                      {person.phone && (
                        <p className="text-[10.5px] text-ink-500 mt-0.5 truncate">
                          {person.phone}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <ContactDetailSheet
        open={!!selected}
        person={selected}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}
