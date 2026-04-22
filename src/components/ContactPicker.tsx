import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersonStore } from '../stores/personStore';

export interface ContactValue {
  id: string | null;
  name: string;
}

interface Props {
  value: ContactValue;
  onChange: (next: ContactValue) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

// Controlled contact input. Typing sets { id: null, name: typed }.
// Selecting an existing match sets { id, name }. The parent is responsible
// for calling personStore.findOrCreateByName(name) on submit to resolve
// any id-less value into a persisted person before writing the loan/txn.
export function ContactPicker({ value, onChange, placeholder, required, className }: Props) {
  const persons = usePersonStore((s) => s.persons);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const query = value.name.trim();
  const queryLower = query.toLocaleLowerCase();

  const matches = useMemo(() => {
    if (!queryLower) return [];
    return persons
      .filter((p) => p.name.toLocaleLowerCase().includes(queryLower))
      .slice(0, 6);
  }, [persons, queryLower]);

  const exactMatch = useMemo(
    () => matches.find((p) => p.name.toLocaleLowerCase() === queryLower) ?? null,
    [matches, queryLower],
  );

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const showDropdown = open && focused && query.length > 0 && (matches.length > 0 || !exactMatch);

  const inputClass =
    className ??
    'w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all';

  return (
    <div ref={wrapperRef} className="relative">
      <input
        value={value.name}
        onChange={(e) => {
          onChange({ id: null, name: e.target.value });
          setOpen(true);
        }}
        onFocus={() => { setFocused(true); setOpen(true); }}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        required={required}
        className={inputClass}
        autoComplete="off"
      />

      {showDropdown && (
        <div className="absolute left-0 right-0 mt-1 z-20 rounded-2xl border border-slate-200/70 bg-white shadow-lg overflow-hidden">
          {matches.map((p) => (
            <button
              type="button"
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange({ id: p.id, name: p.name });
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 text-[13px] font-medium text-slate-700 hover:bg-indigo-50/60 active:bg-indigo-100/60 transition-colors border-b border-slate-100/60 last:border-0"
            >
              {p.name}
            </button>
          ))}
          {!exactMatch && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                // Keep id:null — parent resolves via findOrCreateByName on submit.
                onChange({ id: null, name: query });
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 text-[12px] font-semibold text-indigo-600 hover:bg-indigo-50/60 active:bg-indigo-100/60 transition-colors"
            >
              + Create new: &ldquo;{query}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
