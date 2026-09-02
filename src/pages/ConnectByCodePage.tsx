import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Link2, UserPlus } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { UserAvatar } from '../components/UserAvatar';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useToast } from '../components/Toast';
import { usePersonStore, DuplicateLinkedContactError } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { codeLookupBudgetSpent, resolveProfileByCode } from '../lib/collaboration';
import { formatLinkError, retryAfterMinutes } from '../lib/contactLinkStatus';
import { extractConnectCode } from '../lib/connectQr';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useT } from '../lib/i18n';

// Landing page for a scanned Hisaab QR (https://usehisaab.com/u/HSB-XXXXXX).
//
// A QR opened in the phone's own camera app has no idea Hisaab exists, so it
// hands the URL to the browser or — once App Links verify — straight to the
// app. Either way it arrives HERE, and here has one job: show who this code
// belongs to and offer to add them. Nothing is written until the user taps.
export function ConnectByCodePage() {
  const { code: rawCode } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();

  const user = useSupabaseAuthStore((s) => s.user);
  const persons = usePersonStore((s) => s.persons);
  const createPerson = usePersonStore((s) => s.createPerson);
  const linkToProfile = usePersonStore((s) => s.linkToProfile);

  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'limited' | 'error'>('loading');
  const [found, setFound] = useState<{ profileId: string; displayName: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Double-tap guard (audit C10/F-8). See src/lib/useSubmitGuard.ts.
  const addGuard = useSubmitGuard();

  const normalised = extractConnectCode(rawCode ?? '');

  const resolve = useCallback(async () => {
    if (!normalised) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    try {
      const result = await resolveProfileByCode(normalised);
      if (!result) {
        // A throttled lookup answers with zero rows — same as a genuine miss —
        // so the only signal we have is our own count of charges this hour.
        setStatus(codeLookupBudgetSpent() ? 'limited' : 'notfound');
        return;
      }
      setFound(result);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [normalised]);

  useEffect(() => {
    // Resolution needs an authenticated session (the lookup RPC excludes the
    // caller's own row). Signed-out visitors get sent to auth; the URL is
    // preserved by the router so they land back here afterwards.
    if (!user?.id) return;
    void resolve();
  }, [user?.id, resolve]);

  // Already in the user's contacts — nothing to do but say so.
  const existing = found ? persons.find((p) => p.linkedProfileId === found.profileId) ?? null : null;

  const handleAdd = () => addGuard.run(runAdd);
  const runAdd = async () => {
    if (!found) return;
    setSaving(true);
    setError('');
    try {
      const created = await createPerson(found.displayName, null);
      // The CODE crosses the wire, not the resolved uuid: only the server may
      // decide which account a code belongs to (audit 2026-09 C6). `found` is
      // passed as the pre-migration fallback and for nothing else.
      let linkState: 'pending' | 'mutual' = 'pending';
      try {
        const linked = await linkToProfile(created.id, normalised ?? '', found);
        linkState = linked.linkState;
      } catch (err) {
        if (err instanceof DuplicateLinkedContactError) {
          setError(t('contact_dup_link_generic'));
          return;
        }
        setError(formatLinkError(err, t));
        return;
      }
      toast.show({
        type: 'success',
        title: `${found.displayName} added & connected`,
        // Consent semantics: a link is one-sided until they add you back.
        subtitle:
          linkState === 'mutual'
            ? t('clink_mutual')
            : t('clink_waiting').replace('{name}', found.displayName),
      });
      navigate('/contacts', { replace: true });
    } catch {
      setError(t('addc_link_err_lookup'));
    } finally {
      setSaving(false);
    }
  };

  if (!user?.id) {
    return (
      <main className="min-h-dvh bg-cream-bg">
        <NavyHero>
          <TopBar title="Connect on Hisaab" back />
        </NavyHero>
        <div className="sukoon-body px-5 pt-6">
          <PageErrorState
            variant="inline"
            title="Sign in to connect"
            message="Open Hisaab and sign in, then scan this code again."
            onRetry={() => navigate('/auth')}
            actionLabel="Sign in"
          />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar title="Connect on Hisaab" back />
        <div className="px-5 pb-6">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {normalised ? `HSB-${normalised}` : 'Invalid code'}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[50dvh] px-5 pt-5 space-y-4">
        {status === 'loading' && <ListSkeleton rows={2} />}

        {status === 'notfound' && (
          <PageErrorState
            variant="inline"
            title={t('addc_link_err_notfound')}
            message="Double-check the code, or ask them to show their QR again."
            onRetry={() => navigate('/contacts')}
            actionLabel="Go to Contacts"
          />
        )}

        {status === 'limited' && (
          <PageErrorState
            variant="inline"
            title={t('clink_err_rate_limited').replace('{minutes}', String(retryAfterMinutes(undefined)))}
            message={t('clink_err_no_match')}
            onRetry={() => void resolve()}
          />
        )}

        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('addc_link_err_lookup')}
            message="Check your connection and try again."
            onRetry={() => void resolve()}
          />
        )}

        {status === 'ready' && found && (
          <>
            <div className="rounded-[18px] bg-cream-card border border-cream-border p-5 flex items-center gap-3">
              <UserAvatar name={found.displayName} size={44} />
              <div className="min-w-0 flex-1">
                {/* No verified seal here (audit 2026-09 SEC-09): this is a
                    code lookup, not a link — nothing has been accepted by
                    either side yet, and the seal must mean exactly one thing
                    app-wide (an accepted, two-way contact link). */}
                <p className="text-[15px] font-semibold text-ink-900 flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{found.displayName}</span>
                </p>
                <p className="text-[11.5px] text-ink-500 mt-0.5">on Hisaab</p>
              </div>
            </div>

            {existing ? (
              <div className="rounded-[18px] bg-receive-50 border border-receive-100 p-4 flex items-start gap-3">
                <CheckCircle2 size={18} className="text-receive-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900">
                    Already in your contacts as {existing.name}
                  </p>
                  <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">
                    Nothing to do — open them from Contacts to record a loan or settle up.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-[18px] bg-accent-50 border border-accent-100 p-4 flex items-start gap-3">
                  <Link2 size={17} className="text-accent-600 shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-ink-600 leading-relaxed">
                    {t('addc_link_q_desc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleAdd()}
                  disabled={saving}
                  className="w-full py-3.5 rounded-2xl bg-ink-900 text-white text-[13.5px] font-bold flex items-center justify-center gap-2 disabled:opacity-40 press"
                >
                  <UserPlus size={15} strokeWidth={2.3} />
                  {saving ? 'Connecting…' : t('addc_cta_linked')}
                </button>
              </>
            )}

            {error && (
              <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
