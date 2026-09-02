import { useEffect, useState } from 'react';
import { Shield, Check, Gift, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { committeesDb } from '../lib/supabaseDb';
import { CommitteeVerifyDraw } from '../components/CommitteeVerifyDraw';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
import {
  poolAmount, currentRound, roundDate, recipientForRound, hasPaid, paymentsForRound,
} from '../lib/committeeMath';
import type { Committee, CommitteeMember, CommitteePayment } from '../db';

// Read-only "witness" view of a committee, reachable WITHOUT an account via a
// share token. Renders the same honest ledger every member sees: schedule,
// who-paid-this-round, the baari recipient, and the provably-fair draw to
// verify. No edit controls. Token is parsed from the path so it works whether
// or not it's mounted inside the router.
export function KametiWitnessPage() {
  const t = useT();
  const [data, setData] = useState<{ committee: Committee; members: CommitteeMember[]; payments: CommitteePayment[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid'>('loading');

  useEffect(() => {
    const token = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    let active = true;
    void committeesDb.getWitness(token)
      .then((res) => {
        if (!active) return;
        if (res) {
          setData(res);
          setStatus('ready');
          // Catalog #23 — deliberately anonymous. A witness has no session
          // and is never identify()'d; this is a bare, unidentified event.
          track('kameti_witness_viewed', {});
        } else {
          setStatus('invalid');
        }
      })
      .catch(() => { if (active) setStatus('invalid'); });
    return () => { active = false; };
  }, []);

  if (status === 'loading') {
    return <main className="min-h-dvh bg-navy-900 flex items-center justify-center"><p className="text-white/60 text-sm">…</p></main>;
  }
  if (status === 'invalid' || !data) {
    return (
      <main className="min-h-dvh bg-navy-900 flex flex-col items-center justify-center px-6 text-center">
        <p className="text-white text-[15px] font-semibold">{t('kameti_witness_invalid')}</p>
        <a href="/" className="mt-4 text-accent-500 text-[13px] font-semibold">{t('kameti_get_app')}</a>
      </main>
    );
  }

  const { committee, members, payments } = data;
  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  const round = currentRound(committee.startDate, committee.cadence, committee.totalRounds);
  const collected = paymentsForRound(payments, round).length;
  const recipient = recipientForRound(members, round);

  return (
    <main className="min-h-dvh bg-cream-bg pb-12">
      {/* Navy header */}
      <div className="bg-navy-bloom px-5 pt-[max(20px,env(safe-area-inset-top))] pb-7">
        <div className="flex items-center gap-1.5 text-white/70">
          <Eye size={13} strokeWidth={2.2} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">{t('kameti_witness_title')}</span>
        </div>
        <h1 className="text-[22px] font-bold text-white mt-2 tracking-tight">{committee.name}</h1>
        <p className="text-[12px] text-white/60 mt-1 tabular-nums">
          {formatMoney(committee.contributionAmount, committee.currency)} · {members.length} {t('kameti_members').toLowerCase()} · {t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(committee.totalRounds))}
        </p>
      </div>

      <div className="px-5 pt-5 space-y-4">
        {/* Witness banner. The expiry and the initials-only notice ride along
            (audit UX-24): a link that dies in 90 days should say so, and
            initials must read as a deliberate privacy setting rather than as
            missing data. */}
        <div className="flex items-start gap-2.5 rounded-2xl bg-receive-50 border border-receive-100 p-3">
          <Shield size={16} className="text-receive-text shrink-0 mt-0.5" strokeWidth={2.2} />
          <div className="min-w-0">
            <p className="text-[11.5px] text-receive-text leading-relaxed">{t('kameti_witness_banner')}</p>
            {committee.witnessExpiresAt && (
              <p className="text-[10.5px] text-receive-text/80 mt-1 tabular-nums">
                {t('kameti_witness_expires_on').replace('{date}', format(new Date(committee.witnessExpiresAt), 'd MMM yyyy'))}
              </p>
            )}
          </div>
        </div>

        {committee.witnessInitialsOnly && (
          <p className="text-[11px] text-ink-500 leading-relaxed rounded-2xl bg-cream-card border border-cream-border p-3">
            {t('kameti_witness_initials_note')}
          </p>
        )}

        {/* Pool */}
        <div className="rounded-2xl bg-cream-card border border-cream-border p-4 flex items-baseline justify-between">
          <div>
            <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">{t('kameti_pool')}</p>
            <p className="text-[24px] font-bold text-ink-900 tabular-nums tracking-tight">{formatMoney(pool, committee.currency)}</p>
          </div>
          <span className="inline-flex items-center rounded-full bg-accent-50 text-accent-600 px-2 py-1 text-[10px] font-semibold">{t('kameti_sood_free')}</span>
        </div>

        {/* Provably-fair draw */}
        <CommitteeVerifyDraw committee={committee} members={members} />

        {/* This round's recipient */}
        {recipient && (
          <div className="rounded-2xl bg-gradient-to-br from-accent-100 to-accent-50 border border-accent-100 p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-white/70 flex items-center justify-center shrink-0">
              <Gift size={16} className="text-accent-600" strokeWidth={1.9} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold text-accent-600 uppercase tracking-wide">{t('kameti_baari_label')}</p>
              <p className="text-[15px] font-bold text-ink-900 truncate">{recipient.name}</p>
            </div>
            {recipient.payoutReceivedAt && <span className="text-[10px] font-semibold text-receive-text bg-receive-50 rounded-full px-2 py-0.5 shrink-0">{t('kameti_received')}</span>}
          </div>
        )}

        {/* This round — read-only paid list */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">{t('kameti_this_round')}</h2>
            <span className="text-[11px] font-semibold text-ink-700 tabular-nums">{t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}</span>
          </div>
          <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-cream-hairline overflow-hidden">
            {members.map((m) => {
              const paid = hasPaid(payments, m.id, round);
              return (
                <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-3">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${paid ? 'bg-receive-600 text-white' : 'bg-cream-soft text-transparent border border-cream-border'}`}>
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <p className="flex-1 text-[13px] font-medium text-ink-900 truncate">
                    {m.name}
                    {m.slot != null && <span className="ml-1.5 text-[9px] text-ink-400 font-semibold">#{m.slot}</span>}
                  </p>
                  <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 shrink-0 ${paid ? 'text-receive-text bg-receive-50' : 'text-ink-400 bg-cream-soft'}`}>
                    {paid ? t('kameti_paid_badge') : t('kameti_unpaid_badge')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Schedule */}
        <div>
          <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5">{t('kameti_schedule')}</h2>
          <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-cream-hairline overflow-hidden">
            {Array.from({ length: committee.totalRounds }, (_, i) => i + 1).map((r) => {
              const rec = recipientForRound(members, r);
              return (
                <div key={r} className={`flex items-center gap-3 px-3.5 py-2.5 ${r === round ? 'bg-accent-50/50' : ''}`}>
                  <span className="text-[11px] font-bold text-ink-400 tabular-nums w-5">{r}</span>
                  <span className="flex-1 text-[12.5px] text-ink-900 truncate">{rec?.name ?? '—'}</span>
                  {rec?.payoutReceivedAt && <Check size={12} className="text-receive-text shrink-0" strokeWidth={2.6} />}
                  <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">{format(roundDate(committee.startDate, committee.cadence, r), 'd MMM')}</span>
                </div>
              );
            })}
          </div>
        </div>

        <a href="/" className="block text-center text-[12px] font-semibold text-accent-600 pt-2">{t('kameti_get_app')}</a>
      </div>
    </main>
  );
}
