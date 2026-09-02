import { useState } from 'react';
import { ShieldCheck, Check, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { verifyDraw } from '../lib/committeeDraw';
import type { Committee, CommitteeMember } from '../db';

interface Props {
  committee: Pick<Committee, 'payoutMethod' | 'drawSeed' | 'drawCommitment'>;
  members: CommitteeMember[];
}

// Provably-fair draw panel: publishes the seed and its seal, and recomputes the
// payout order from them so anyone — organiser, member, or a relative on the
// witness link with no account — can confirm the order wasn't rigged.
//
// Audit 2026-09 M10: the seed used to be generated on the organiser's phone,
// which made this panel a rubber stamp (re-roll until slot 1 is yours, then
// save the matching pair). The seed now comes from the server inside the same
// transaction that consumes it, so the recompute below is a real check. The
// seed is shown in full on purpose: verification you cannot reproduce by hand
// isn't verification. See src/lib/committeeDraw.ts for the exact scheme.
export function CommitteeVerifyDraw({ committee, members }: Props) {
  const t = useT();
  const [result, setResult] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  if (committee.payoutMethod !== 'ballot' || !committee.drawSeed || !committee.drawCommitment) return null;

  const verify = async () => {
    setChecking(true);
    try {
      const storedOrder = [...members].filter((m) => m.slot != null).sort((a, b) => (a.slot! - b.slot!)).map((m) => m.id);
      const ok = await verifyDraw(members.map((m) => m.id), committee.drawSeed!, committee.drawCommitment!, storedOrder);
      setResult(ok);
    } catch {
      setResult(false);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-receive-text shrink-0" strokeWidth={2.2} />
        <p className="text-[13px] font-semibold text-ink-900">{t('kameti_verify_title')}</p>
      </div>
      <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">{t('kameti_verify_desc')}</p>
      <p className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">{t('kameti_draw_server_note')}</p>
      <div className="mt-2.5 rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2">
        <p className="text-[9px] font-semibold text-ink-400 uppercase tracking-wide">{t('kameti_draw_seed')}</p>
        <p className="text-[10.5px] font-mono text-ink-600 break-all leading-snug">{committee.drawSeed}</p>
      </div>
      <div className="mt-1.5 rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2">
        <p className="text-[9px] font-semibold text-ink-400 uppercase tracking-wide">{t('kameti_commitment')}</p>
        <p className="text-[10.5px] font-mono text-ink-600 break-all leading-snug">{committee.drawCommitment.slice(0, 32)}…</p>
      </div>
      <p className="text-[10px] text-ink-400 mt-1.5 leading-relaxed">{t('kameti_draw_recompute_how')}</p>
      {result === null ? (
        <button onClick={verify} disabled={checking} className="mt-3 w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-bold disabled:opacity-50 press">
          {checking ? t('kameti_verifying') : t('kameti_verify')}
        </button>
      ) : result ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-receive-50 border border-receive-100 px-3 py-2.5">
          <Check size={15} className="text-receive-text shrink-0" strokeWidth={2.6} />
          <p className="text-[11.5px] font-semibold text-receive-text leading-snug">{t('kameti_verify_ok')}</p>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-pay-50 border border-pay-100 px-3 py-2.5">
          <X size={15} className="text-pay-text shrink-0" strokeWidth={2.6} />
          <p className="text-[11.5px] font-semibold text-pay-text leading-snug">{t('kameti_verify_fail')}</p>
        </div>
      )}
    </div>
  );
}
