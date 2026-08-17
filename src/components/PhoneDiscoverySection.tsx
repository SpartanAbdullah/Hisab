import { useEffect, useState } from 'react';
import { Check, Phone, X } from 'lucide-react';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { phoneDiscoveryDb, profilesDb } from '../lib/supabaseDb';
import { formatE164, toE164 } from '../lib/phoneIdentity';

interface Props {
  sectionClass: string;
  rowClass: string;
}

// "Let people who already have my number find me on Hisaab."
//
// The privacy-preserving alternative to scanning the device address book:
// Hisaab never reads contacts and never asks for READ_CONTACTS. Instead each
// user decides, once, whether their own number can be matched. Discovery then
// only ever fires on numbers the OTHER person already had saved themselves.
//
// Two independent facts, deliberately not collapsed into one toggle:
//   • whether a number is stored at all
//   • whether it may be matched
// Turning discovery off keeps the number (it's useful to have on file) but
// makes the user unfindable, which is what "off" has to mean to be honest.
export function PhoneDiscoverySection({ sectionClass, rowClass }: Props) {
  const t = useT();
  const toast = useToast();

  const [saved, setSaved] = useState<string | null>(null);
  const [discoverable, setDiscoverable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Null means "the columns aren't there yet" — the migration hasn't been
  // applied. Hide the whole section rather than showing a control that
  // silently fails.
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const profile = await profilesDb.getCurrent();
      if (cancelled) return;
      if (!profile || !('phone_e164' in profile)) {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      const value = profile.phone_e164;
      setSaved(typeof value === 'string' && value ? value : null);
      setDiscoverable(profile.phone_discoverable === true);
    })().catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // Live preview of what will actually be stored. Showing the normalised form
  // BEFORE saving is what stops "I entered my number but nobody finds me" —
  // if we couldn't parse it, the user sees that immediately.
  const previewed = editing ? toE164(draft) : null;
  const draftHasDigits = draft.replace(/[^\d]/g, '').length > 0;

  const save = async () => {
    const e164 = toE164(draft);
    if (!e164) return;
    setBusy(true);
    try {
      // A newly added number defaults to discoverable — the user is adding it
      // here, under copy that says exactly what it's for. They can flip the
      // toggle off immediately below.
      await phoneDiscoveryDb.setMyPhone(e164, saved ? discoverable : true);
      setSaved(e164);
      if (!saved) setDiscoverable(true);
      setEditing(false);
      toast.show({ type: 'success', title: t('disc_my_phone_saved') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(null, false);
      setSaved(null);
      setDiscoverable(false);
      setEditing(false);
      toast.show({ type: 'success', title: t('disc_my_phone_removed') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  const toggleDiscoverable = async () => {
    if (!saved) return;
    const next = !discoverable;
    setBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(saved, next);
      setDiscoverable(next);
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  if (available !== true) return null;

  return (
    <div className={sectionClass}>
      <div className={rowClass}>
        <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
          <Phone size={16} className="text-accent-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink-900">{t('disc_my_phone_title')}</p>
          <p className="text-[11px] text-ink-500 leading-relaxed">{t('disc_my_phone_desc')}</p>
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3">
        {editing ? (
          <>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && previewed) { e.preventDefault(); void save(); }
                  if (e.key === 'Escape') setEditing(false);
                }}
                placeholder={t('disc_my_phone_placeholder')}
                inputMode="tel"
                className="flex-1 min-w-0 bg-cream-bg border border-cream-border rounded-xl px-3.5 py-2.5 text-[13px] outline-none focus:border-accent-500"
              />
              <button
                type="button"
                disabled={busy || !previewed}
                onClick={() => void save()}
                className="w-9 h-9 rounded-xl bg-receive-50 text-receive-text flex items-center justify-center disabled:opacity-40 press-xs"
                aria-label={t('cat_save')}
              >
                <Check size={16} strokeWidth={2.8} />
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="w-9 h-9 rounded-xl bg-cream-soft text-ink-400 flex items-center justify-center press-xs"
                aria-label={t('cancel')}
              >
                <X size={16} />
              </button>
            </div>
            {previewed ? (
              <p className="text-[11px] text-ink-500">
                {t('disc_my_phone_confirm').replace('{number}', formatE164(previewed))}
              </p>
            ) : draftHasDigits ? (
              <p className="text-[11px] text-warn-700 leading-relaxed">{t('disc_my_phone_invalid')}</p>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <p className="flex-1 min-w-0 text-[13px] text-ink-900 truncate">
              {saved ? formatE164(saved) : (
                <span className="text-ink-400">{t('disc_my_phone_none')}</span>
              )}
            </p>
            <button
              type="button"
              onClick={() => { setDraft(saved ?? ''); setEditing(true); }}
              className="shrink-0 text-[11.5px] font-semibold text-accent-600"
            >
              {saved ? t('contact_whatsapp_edit') : t('contact_whatsapp_add')}
            </button>
            {saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="shrink-0 text-[11.5px] font-semibold text-pay-text disabled:opacity-50"
              >
                {t('cat_remove')}
              </button>
            )}
          </div>
        )}

        {saved && !editing && (
          <div className="flex items-center gap-3 pt-1 border-t border-cream-hairline">
            <p className="flex-1 min-w-0 text-[11.5px] text-ink-600 leading-relaxed pt-3">
              {t('disc_my_phone_toggle')}
              {!discoverable && (
                <span className="block text-[10.5px] text-ink-400 mt-0.5">
                  {t('disc_my_phone_hidden')}
                </span>
              )}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggleDiscoverable()}
              aria-pressed={discoverable}
              aria-label={t('disc_my_phone_toggle')}
              className={`relative w-12 h-7 rounded-full transition-colors shrink-0 mt-3 disabled:opacity-50 ${discoverable ? 'bg-receive-600' : 'bg-cream-border'}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${discoverable ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
