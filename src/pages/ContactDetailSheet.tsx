import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { usePersonStore, DuplicateLinkedContactError } from '../stores/personStore';
import { resolveProfileByCode } from '../lib/collaboration';
import type { Person } from '../db';

interface Props {
  open: boolean;
  person: Person | null;
  onClose: () => void;
}

type Mode = 'idle' | 'entering' | 'resolved';

// Phase 2A: per-contact sheet. Shows name, linked state, and one action —
// "Link to Hisaab user" or "Unlink". The code lookup only runs on explicit
// Resolve button press, never on keystrokes.
export function ContactDetailSheet({ open, person, onClose }: Props) {
  const { linkToProfile, unlinkFromProfile } = usePersonStore();

  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<{ profileId: string; displayName: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      // Reset any in-flight link flow when the sheet closes.
      setMode('idle');
      setCode('');
      setResolving(false);
      setResolved(null);
      setError('');
      setSaving(false);
    }
  }, [open]);

  if (!person) return null;

  const isLinked = !!person.linkedProfileId;

  const handleResolve = async () => {
    setError('');
    setResolved(null);
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a user code to continue.');
      return;
    }
    setResolving(true);
    try {
      const found = await resolveProfileByCode(trimmed);
      if (!found) {
        setError('No user with this code.');
        return;
      }
      setResolved(found);
      setMode('resolved');
    } catch {
      setError('Could not look up this code. Try again.');
    } finally {
      setResolving(false);
    }
  };

  const handleConfirmLink = async () => {
    if (!resolved) return;
    setSaving(true);
    setError('');
    try {
      await linkToProfile(person.id, resolved.profileId);
      onClose();
    } catch (err) {
      if (err instanceof DuplicateLinkedContactError) {
        setError('Another of your contacts is already linked to this user.');
      } else {
        setError('Could not link this contact. Try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = async () => {
    setSaving(true);
    setError('');
    try {
      await unlinkFromProfile(person.id);
      onClose();
    } catch {
      setError('Could not unlink this contact. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all';

  return (
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-sm font-bold">
            {(person.name[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-slate-800 truncate">{person.name}</p>
            <p className="text-[11px] text-slate-400">
              {isLinked ? 'Linked to a Hisaab user' : 'Not linked to a Hisaab user'}
            </p>
          </div>
          {isLinked && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 rounded-full px-2.5 py-1">
              Linked
            </span>
          )}
        </div>

        {isLinked ? (
          <div className="space-y-3">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Linking is private &mdash; the other user is not notified.
            </p>
            <button
              onClick={handleUnlink}
              disabled={saving}
              className="w-full py-3 rounded-2xl bg-red-50 text-red-500 text-[13px] font-bold active:bg-red-100 transition-all disabled:opacity-50"
            >
              {saving ? 'Working…' : 'Unlink'}
            </button>
          </div>
        ) : mode === 'idle' ? (
          <button
            onClick={() => setMode('entering')}
            className="w-full py-3 rounded-2xl btn-gradient text-[13px] font-bold shadow-md shadow-indigo-500/20"
          >
            Link to Hisaab user
          </button>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                User code
              </label>
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  // Invalidate any prior resolved state on every edit so the
                  // user must press Resolve again for the new value.
                  if (resolved) setResolved(null);
                  if (mode === 'resolved') setMode('entering');
                  if (error) setError('');
                }}
                placeholder="HSB-XXXXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                className={inputClass}
              />
              <p className="text-[11px] text-slate-400 mt-1.5">
                Ask them to copy their code from Settings &rarr; My Account.
              </p>
            </div>

            {mode === 'resolved' && resolved ? (
              <div className="rounded-2xl border border-emerald-100/70 bg-emerald-50/60 p-3">
                <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-widest">Found</p>
                <p className="text-[14px] font-semibold text-slate-800 mt-0.5">{resolved.displayName}</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Confirming will tag this contact with their account. No messages are sent.
                </p>
              </div>
            ) : (
              <button
                onClick={handleResolve}
                disabled={resolving || !code.trim()}
                className="w-full py-3 rounded-2xl bg-indigo-50 text-indigo-600 text-[13px] font-bold active:bg-indigo-100 transition-all disabled:opacity-40"
              >
                {resolving ? 'Looking up…' : 'Resolve'}
              </button>
            )}

            {mode === 'resolved' && resolved && (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setMode('entering');
                    setResolved(null);
                  }}
                  disabled={saving}
                  className="px-4 py-3 rounded-2xl bg-slate-100 text-slate-500 text-[12px] font-bold active:bg-slate-200 transition-all disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmLink}
                  disabled={saving}
                  className="flex-1 py-3 rounded-2xl btn-gradient text-[13px] font-bold disabled:opacity-40 shadow-md shadow-indigo-500/20"
                >
                  {saving ? 'Linking…' : 'Confirm link'}
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-[12px] text-red-500 font-semibold bg-red-50 rounded-xl p-3">{error}</p>
        )}
      </div>
    </Modal>
  );
}
