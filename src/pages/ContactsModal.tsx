import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { usePersonStore } from '../stores/personStore';
import { ContactDetailSheet } from './ContactDetailSheet';
import type { Person } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Read-only alphabetical list of the user's contacts. Tapping a row opens
// ContactDetailSheet where Phase 2A's link-to-Hisaab-user flow lives.
export function ContactsModal({ open, onClose }: Props) {
  const persons = usePersonStore((s) => s.persons);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...persons].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [persons],
  );

  // Re-resolve the selected person from the latest store snapshot so state
  // transitions (link/unlink) reflect immediately when the sheet closes.
  const selected: Person | null = selectedId ? persons.find((p) => p.id === selectedId) ?? null : null;

  return (
    <>
      <Modal open={open} onClose={onClose} title="Your Contacts">
        {sorted.length === 0 ? (
          <p className="text-[13px] text-slate-400 text-center py-10">No contacts yet.</p>
        ) : (
          <div className="space-y-1.5">
            {sorted.map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => setSelectedId(person.id)}
                className="row-base row-card row-interactive"
              >
                <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-[13px] font-bold">
                  {(person.name[0] ?? '?').toUpperCase()}
                </div>
                <p className="flex-1 text-[13px] font-semibold text-slate-700 tracking-tight truncate">
                  {person.name}
                </p>
                {person.linkedProfileId ? (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 rounded-full px-2.5 py-1">
                    Linked
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Modal>

      <ContactDetailSheet
        open={!!selected}
        person={selected}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
