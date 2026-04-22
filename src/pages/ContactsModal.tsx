import { useMemo } from 'react';
import { Modal } from '../components/Modal';
import { usePersonStore } from '../stores/personStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Read-only alphabetical list of the user's contacts. No create / edit /
// delete / merge. No derived counts. Intentionally minimal — it exists so
// users can confirm the contact layer is populated and to give later phases
// a place to hang rename / link actions.
export function ContactsModal({ open, onClose }: Props) {
  const persons = usePersonStore((s) => s.persons);

  const sorted = useMemo(
    () => [...persons].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [persons],
  );

  return (
    <Modal open={open} onClose={onClose} title="Your Contacts">
      {sorted.length === 0 ? (
        <p className="text-[13px] text-slate-400 text-center py-10">No contacts yet.</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((person) => (
            <div
              key={person.id}
              className="flex items-center gap-3 p-3 rounded-2xl bg-white border border-slate-200/60"
            >
              <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-[13px] font-bold">
                {(person.name[0] ?? '?').toUpperCase()}
              </div>
              <p className="text-[13px] font-semibold text-slate-700 tracking-tight truncate">
                {person.name}
              </p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
