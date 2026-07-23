import { useEffect, useMemo, useState } from 'react';
import { FileText, Copy, MessageCircle } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { moneyFormatter } from '../lib/maskMoney';
import { poolAmount, memberPosition } from '../lib/committeeMath';
import { generateKametiSlipPdf } from '../lib/kametiSlipPdf';
import { shareStatementFile } from '../lib/shareStatement';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import type { Committee, CommitteeMember, CommitteePayment } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  committee: Committee;
  recipient: CommitteeMember;
  round: number;
  payments: CommitteePayment[];
  witnessUrl?: string;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); return Promise.resolve(); }
  catch (e) { return Promise.reject(e); }
  finally { document.body.removeChild(ta); }
}

export function KametiPayoutSlipSheet({ open, onClose, committee, recipient, round, payments, witnessUrl }: Props) {
  const t = useT();
  const toast = useToast();
  const [preparing, setPreparing] = useState(false);
  const [copying, setCopying] = useState(false);
  // Privacy: hide every figure in the shared slip/text. The witness link (if
  // present) still opens the live ledger with real amounts — noted in the UI.
  const [hideAmounts, setHideAmounts] = useState(false);

  useEffect(() => {
    if (open) setHideAmounts(false);
  }, [open]);

  const organiserName = useMemo(() => (localStorage.getItem('hisaab_user_name') ?? '').trim() || undefined, []);
  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  const position = useMemo(
    () => memberPosition(recipient, payments, committee.contributionAmount, committee.memberCount, committee.totalRounds),
    [recipient, payments, committee],
  );

  const message = useMemo(() => {
    const lines: string[] = [];
    lines.push(`*${t('kslip_title')} — ${committee.name}*`);
    lines.push(
      t('kslip_received_line')
        .replace('{amount}', moneyFormatter(hideAmounts)(pool, committee.currency))
        .replace('{r}', String(round))
        .replace('{n}', String(committee.totalRounds)),
    );
    lines.push('Shukriya!');
    if (witnessUrl) {
      lines.push('');
      lines.push(`${t('kslip_verify')}: ${witnessUrl}`);
    }
    lines.push('');
    lines.push(organiserName ? `— ${organiserName}, via Hisaab` : '— via Hisaab');
    return lines.join('\n');
  }, [t, committee, pool, round, witnessUrl, organiserName, hideAmounts]);

  const whatsappUrl = buildWhatsAppUrl(recipient.phone ?? null, message);

  const handleCopy = async () => {
    setCopying(true);
    try { await copyText(message); toast.show({ type: 'success', title: t('soa_copied') }); }
    catch { toast.show({ type: 'error', title: t('soa_copy_failed') }); }
    finally { setCopying(false); }
  };

  const handleSendPdf = async () => {
    setPreparing(true);
    try {
      const { blob, filename } = await generateKametiSlipPdf({
        committeeName: committee.name,
        currency: committee.currency,
        round,
        totalRounds: committee.totalRounds,
        pool,
        recipientName: recipient.name,
        contributed: position.contributed,
        net: position.net,
        witnessUrl,
        date: new Date().toISOString(),
        organiserName,
        hideAmounts,
      });
      const outcome = await shareStatementFile({ blob, filename, title: `${t('kslip_title')} — ${committee.name}`, text: `${recipient.name} · ${t('kslip_title')} (Hisaab)` });
      if (outcome === 'downloaded') toast.show({ type: 'success', title: t('soa_downloaded') });
      else if (outcome === 'shared') toast.show({ type: 'success', title: t('soa_ready') });
      else if (outcome === 'error') toast.show({ type: 'error', title: t('soa_share_failed') });
    } catch {
      toast.show({ type: 'error', title: t('soa_share_failed') });
    } finally {
      setPreparing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kslip_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          <button
            onClick={handleSendPdf}
            disabled={preparing}
            className="w-full rounded-2xl py-3.5 text-sm font-bold text-white flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-40"
            style={{ background: '#0B0E2A' }}
          >
            <FileText size={16} strokeWidth={2.2} /> {preparing ? t('soa_preparing') : t('kslip_pdf')}
          </button>
          <div className="flex gap-2.5">
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
              className="flex-1 rounded-2xl py-3 text-[13px] font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
              style={{ background: '#1FA855', color: '#fff' }}
            >
              <MessageCircle size={14} /> {t('soa_whatsapp_text')}
            </a>
            <button
              onClick={handleCopy}
              disabled={copying}
              className="px-4 rounded-2xl py-3 text-[13px] font-bold bg-cream-soft text-ink-700 flex items-center justify-center gap-2 active:bg-cream-border disabled:opacity-30"
            >
              <Copy size={14} /> {copying ? t('quick_processing') : t('soa_copy')}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl p-4 border bg-receive-50/60 border-receive-100/70">
          <p className="text-[10px] font-bold uppercase tracking-widest text-receive-text">{t('kslip_received')} · {committee.currency}</p>
          <p className="text-[22px] font-extrabold text-ink-900 mt-1 tabular-nums">{formatMoney(pool, committee.currency)}</p>
          <p className="text-[11px] text-ink-500 mt-1">
            {t('kslip_intro').replace('{name}', recipient.name).replace('{r}', String(round))}
          </p>
        </div>

        {/* Privacy: hide the numbers — the witness link still shows live amounts. */}
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-cream-card border border-cream-border px-4 py-3 cursor-pointer">
          <span className="text-[12.5px] font-semibold text-ink-800">
            {t('soa_hide_amounts')}
            <span className="block text-[10.5px] font-normal text-ink-500 mt-0.5">
              {witnessUrl ? `${t('soa_hide_amounts_sub')} ${t('kslip_hide_witness_note')}` : t('soa_hide_amounts_sub')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={hideAmounts}
            onChange={(e) => setHideAmounts(e.target.checked)}
            className="w-4 h-4 accent-accent-600 shrink-0"
          />
        </label>

        <div>
          <p className="form-label">{t('soa_preview')}</p>
          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4 max-h-56 overflow-auto">
            <p className="text-[12px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
