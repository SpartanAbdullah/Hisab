import { useCallback, useState } from 'react';
import { Plus, Coins, ChevronRight, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCommitteeStore } from '../stores/committeeStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { CreateCommitteeModal } from './CreateCommitteeModal';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { currentRound, poolAmount, paymentsForRound } from '../lib/committeeMath';

export function KametiPage() {
  const t = useT();
  const navigate = useNavigate();
  const committees = useCommitteeStore((s) => s.committees);
  const loadAll = useCommitteeStore((s) => s.loadAll);
  const membersOf = useCommitteeStore((s) => s.membersOf);
  const paymentsOf = useCommitteeStore((s) => s.paymentsOf);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => { await loadAll(); }, [loadAll]);
  const { status } = useAsyncLoad(load);

  const active = committees.filter((c) => c.status === 'active');

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('kameti_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button onClick={() => setShowCreate(true)} className="h-9 px-3 rounded-xl bg-white/10 active:bg-white/15 flex items-center gap-1.5 text-[12px] font-semibold text-white transition-colors">
                <Plus size={13} strokeWidth={2.4} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/55 tracking-[0.12em] uppercase">
            {t('kameti_active_count').replace('{n}', String(active.length))}
          </p>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1">
            <Shield size={11} className="text-white/80" strokeWidth={2.2} />
            <span className="text-[10.5px] font-medium text-white/80">{t('kameti_no_custody')}</span>
          </div>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {status === 'loading' && committees.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : committees.length === 0 ? (
          <EmptyState
            icon={Coins}
            tone="accent"
            title={t('kameti_empty_title')}
            description={t('kameti_empty_desc')}
            actionLabel={t('kameti_empty_cta')}
            onAction={() => setShowCreate(true)}
          />
        ) : (
          committees.map((c) => {
            const members = membersOf(c.id);
            const payments = paymentsOf(c.id);
            const round = currentRound(c.startDate, c.cadence, c.totalRounds);
            const collected = paymentsForRound(payments, round).length;
            const recipient = members.find((m) => m.slot === round);
            const pool = poolAmount(c.contributionAmount, c.memberCount);
            return (
              <button
                key={c.id}
                onClick={() => navigate(`/kameti/${c.id}`)}
                className="w-full text-left rounded-2xl bg-cream-card border border-cream-border p-4 active:scale-[0.99] transition-transform"
              >
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-accent-100 to-accent-50 text-accent-600 flex items-center justify-center shrink-0">
                    <Coins size={20} strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">{c.name}</p>
                      {c.status === 'completed' && (
                        <span className="text-[9px] font-bold uppercase rounded-full bg-receive-50 text-receive-text px-1.5 py-0.5">✓</span>
                      )}
                    </div>
                    <p className="text-[11px] text-ink-500 mt-0.5 tabular-nums">
                      {formatMoney(c.contributionAmount, c.currency)} · {members.length} {t('kameti_members').toLowerCase()}
                      {c.status === 'active' && <> · {t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(c.totalRounds))}</>}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[13px] font-bold text-ink-900 tabular-nums">{formatMoney(pool, c.currency)}</p>
                    <p className="text-[10px] text-ink-400 mt-0.5">{t('kameti_pool')}</p>
                  </div>
                  <ChevronRight size={16} className="text-ink-300 shrink-0" />
                </div>
                {c.status === 'active' && c.drawnAt && (
                  <div className="mt-2.5 flex items-center justify-between gap-2 text-[10.5px]">
                    <span className="text-ink-500">
                      {recipient ? `${t('kameti_baari_label')}: ${recipient.name}` : t('kameti_undrawn')}
                    </span>
                    <span className="text-ink-500 tabular-nums">{t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}</span>
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>

      <CreateCommitteeModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/kameti/${id}`)} />
    </main>
  );
}
