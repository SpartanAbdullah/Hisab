import { useEffect, useMemo, useState } from 'react';
import { FileText, Copy, MessageCircle, CheckCircle2 } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { moneyFormatter } from '../lib/maskMoney';
import { buildStatement } from '../lib/statementOfAccount';
import { useTransactionStore } from '../stores/transactionStore';
import { renderStatementText, netBalanceLabel, greetingLine, type GreetingStyle } from '../lib/statementText';
import { generateStatementPdf } from '../lib/statementPdf';
import { shareStatementFile } from '../lib/shareStatement';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';
import { buildReceiptText } from '../lib/receiptText';
import { track } from '../lib/telemetry';
import type { Loan, Transaction } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  partyName: string;
  loans: Loan[]; // contact scope: all their loans · loan scope: [loan]
  transactions: Transaction[]; // builder filters by relatedLoanId
  scope: 'contact' | 'loan';
  phone?: string | null;
  fromName?: string;
  refCode?: string;
  // Friendly lead-in shown at the top — used by the post-repayment nudge.
  intro?: string;
  // When present, the sheet defaults to a "payment received" receipt (with a
  // toggle back to the full statement). Set post-repayment on `given` loans.
  receipt?: { receivedAmount: number; currency: string; remaining: number | null; date: string };
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextarea(text));
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    document.body.removeChild(textarea);
  }
}

export function SendStatementModal({
  open, onClose, partyName, loans, transactions, scope, phone = null, fromName, refCode, intro, receipt,
}: Props) {
  const t = useT();
  const toast = useToast();
  const [preparing, setPreparing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [greetingStyle, setGreetingStyle] = useState<GreetingStyle>('hello');
  // 'receipt' = a warm "payment received" acknowledgement; 'statement' = the
  // full ledger. Defaults to receipt when a payment just arrived.
  const [mode, setMode] = useState<'statement' | 'receipt'>('statement');
  // Privacy: hide every figure in the shared artefacts (PDF, text, preview).
  // Names, dates and structure survive; the numbers become the mask.
  const [hideAmounts, setHideAmounts] = useState(false);
  // Freeze the "as of" instant when the sheet opens so every artefact (PDF,
  // text, preview) reports the same generation time.
  const [asOf, setAsOf] = useState('');

  useEffect(() => {
    if (open) {
      setAsOf(new Date().toISOString());
      setMode(receipt ? 'receipt' : 'statement');
      setHideAmounts(false);
    }
    // `receipt` is read only at open-time to choose the default mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── The completeness gate (docs/performance.md §7) ────────────────────────
  // A statement of account is a LEDGER the user sends to another person as a
  // record of what is owed. `transactionStore.loadTransactions()` returns a
  // bounded window now, so building this from whatever happens to be in the
  // store would quietly drop older repayments and overstate a debt — the one
  // class of bug this whole file exists to avoid.
  //
  // The gate lives HERE, not at the three call sites (LoansPage,
  // LoanDetailPage, ContactDetailSheet), because this is the single place
  // `buildStatement` is reached from and all three pass store-derived rows: the
  // fetch lands, the parent re-renders, richer `transactions` arrive as props.
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const historyComplete = useTransactionStore((s) => s.historyCoverage.complete);
  const historyLoading = useTransactionStore((s) => s.historyLoading);
  const [historyFailed, setHistoryFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHistoryFailed(false);
    void ensureTransactionHistory({ all: true }).catch(() => setHistoryFailed(true));
  }, [open, ensureTransactionHistory]);

  // Not "is it still spinning" — "is the set provably complete". A fetch that
  // failed leaves this false, and the sheet says so rather than rendering a
  // confident-looking ledger built on a partial history.
  const historyReady = historyComplete;

  // The user's own name (set at onboarding, used across groups/committees)
  // signs the statement off; an explicit fromName prop can override it.
  const myName = useMemo(() => (localStorage.getItem('hisaab_user_name') ?? '').trim(), []);
  const preparedName = (fromName && fromName.trim()) || myName || undefined;

  const statement = useMemo(() => {
    if (!asOf) return null;
    // Never build on a partial history — see the completeness gate above.
    if (!historyReady) return null;
    return buildStatement({ partyName, loans, transactions, asOf, scope });
  }, [asOf, historyReady, partyName, loans, transactions, scope]);

  const greeting = useMemo(() => greetingLine(greetingStyle, partyName), [greetingStyle, partyName]);
  const receiptText = useMemo(
    () => (receipt ? buildReceiptText({ ...receipt, fromName: preparedName, greeting, hideAmounts }) : null),
    [receipt, preparedName, greeting, hideAmounts],
  );
  const statementMessage = useMemo(
    () => (statement ? renderStatementText(statement, { greeting, fromName: preparedName, hideAmounts }) : ''),
    [statement, greeting, preparedName, hideAmounts],
  );
  // In-modal money formatter — the headline receipt card mirrors the toggle.
  const showMoney = moneyFormatter(hideAmounts);
  const message = mode === 'receipt' && receiptText ? receiptText.message : statementMessage;
  const hasContent = mode === 'receipt' ? !!receiptText : !!statement?.hasActivity;
  const whatsappUrl = buildWhatsAppUrl(phone, message);
  const knownNumber = hasWhatsAppNumber(phone);
  const greetLabels: Record<GreetingStyle, string> = {
    hello: t('soa_greet_hello'),
    salaam: t('soa_greet_salaam'),
    dear: t('soa_greet_dear'),
    none: t('soa_greet_none'),
  };

  const handleSendPdf = async () => {
    if (!statement) return;
    setPreparing(true);
    try {
      const { blob, filename } = await generateStatementPdf(statement, { fromName: preparedName, phone, refCode, greeting, hideAmounts });
      const outcome = await shareStatementFile({
        blob,
        filename,
        title: `${t('soa_title')} — ${partyName}`,
        text: `${partyName} · ${t('soa_title')} (Hisaab)`,
      });
      if (outcome === 'downloaded' || outcome === 'shared') {
        // Catalog #26. 'statement' is the only doc_type this PDF path can
        // produce — the receipt toggle only ever generates the text message.
        track('statement_shared', { doc_type: 'statement', channel: outcome === 'shared' ? 'share_sheet' : 'other' });
      }
      if (outcome === 'downloaded') {
        toast.show({ type: 'success', title: t('soa_downloaded') });
      } else if (outcome === 'shared') {
        toast.show({ type: 'success', title: t('soa_ready') });
      } else if (outcome === 'error') {
        toast.show({ type: 'error', title: t('soa_share_failed') });
      }
    } catch {
      toast.show({ type: 'error', title: t('soa_share_failed') });
    } finally {
      setPreparing(false);
    }
  };

  const handleCopy = async () => {
    setCopying(true);
    try {
      await copyWithFallback(message);
      track('statement_shared', { doc_type: mode === 'receipt' ? 'receipt' : 'statement', channel: 'copy' });
      toast.show({ type: 'success', title: t('soa_copied') });
    } catch {
      toast.show({ type: 'error', title: t('soa_copy_failed') });
    } finally {
      setCopying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'receipt' ? t('rcpt_title') : t('soa_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          {/* PDF is a statement-mode action; the receipt is a quick text send. */}
          {mode === 'statement' && (
            <button
              onClick={handleSendPdf}
              disabled={preparing || !hasContent}
              className="w-full rounded-2xl py-3.5 text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-40 press"
              style={{ background: '#0B0E2A' }}
            >
              <FileText size={16} strokeWidth={2.2} /> {preparing ? t('soa_preparing') : t('soa_send_pdf')}
            </button>
          )}
          <div className="flex gap-2.5">
            {/* Text-only WhatsApp ping — opens the chat when we know the number,
                the picker otherwise. Carries the receipt / statement body. */}
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                track('statement_shared', { doc_type: mode === 'receipt' ? 'receipt' : 'statement', channel: 'whatsapp' });
                toast.show({ type: 'success', title: t('reminder_wa_opening') });
              }}
              className={`flex-1 rounded-2xl py-3 text-[13px] font-bold flex items-center justify-center gap-2 ${hasContent ? '' : 'pointer-events-none opacity-40'} press`}
              style={{ background: '#1FA855', color: '#fff' }}
            >
              <MessageCircle size={14} /> {t('soa_whatsapp_text')}
            </a>
            <button
              onClick={handleCopy}
              disabled={copying || !hasContent}
              className="px-4 rounded-2xl py-3 text-[13px] font-bold bg-cream-soft text-ink-700 flex items-center justify-center gap-2 active:bg-cream-border disabled:opacity-30"
            >
              <Copy size={14} /> {copying ? t('quick_processing') : t('soa_copy')}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {intro && (
          <div className="rounded-2xl bg-receive-50/70 border border-receive-100/70 p-3.5 flex items-start gap-2.5">
            <CheckCircle2 size={16} className="text-receive-text mt-0.5 shrink-0" strokeWidth={2.2} />
            <p className="text-[12.5px] text-ink-800 leading-relaxed">{intro}</p>
          </div>
        )}

        {/* Receipt ⇄ Statement toggle — only when a payment just arrived. */}
        {receipt && (
          <div className="grid grid-cols-2 gap-2">
            {(['receipt', 'statement'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`py-2 rounded-xl text-[12px] font-bold border transition-all active:scale-95 ${mode === m ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-500 border-cream-border'}`}
              >
                {m === 'receipt' ? t('rcpt_toggle_receipt') : t('rcpt_toggle_statement')}
              </button>
            ))}
          </div>
        )}

        {/* Headline — received amount (receipt) or per-currency net (statement). */}
        {mode === 'receipt' && receipt ? (
          <div className="rounded-2xl p-4 border bg-receive-50/60 border-receive-100/70">
            <p className="text-[10px] font-bold uppercase tracking-widest text-receive-text">{t('rcpt_received')}</p>
            <p className="text-[18px] font-extrabold text-ink-900 mt-1 tabular-nums">{showMoney(receipt.receivedAmount, receipt.currency)}</p>
            <p className="text-[11px] text-ink-500 mt-1">
              {receipt.remaining == null
                ? t('rcpt_thanks_short')
                : receipt.remaining <= 0.005
                ? t('rcpt_settled_short')
                : t('rcpt_remaining_short').replace('{amount}', showMoney(receipt.remaining, receipt.currency))}
            </p>
          </div>
        ) : statement && statement.sections.length > 0 ? (
          <div className="space-y-2">
            {statement.sections.map((section) => {
              const positive = section.closing > 0.005;
              const settled = Math.abs(section.closing) <= 0.005;
              return (
                <div
                  key={section.currency}
                  className={`rounded-2xl p-4 border ${settled || positive ? 'bg-receive-50/60 border-receive-100/70' : 'bg-pay-50/60 border-pay-100/70'}`}
                >
                  <p className={`text-[10px] font-bold uppercase tracking-widest ${settled || positive ? 'text-receive-text' : 'text-pay-text'}`}>
                    {settled ? `${section.currency} · ${t('soa_settled_chip')}` : section.currency}
                  </p>
                  <p className="text-[15px] font-extrabold text-ink-900 mt-1">
                    {settled
                      ? t('soa_settled_celebrate').replace('{name}', partyName)
                      : netBalanceLabel(partyName, section.closing, section.currency, showMoney)}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-1">
                    {section.lines.length} {section.lines.length === 1 ? 'entry' : 'entries'}
                  </p>
                </div>
              );
            })}
          </div>
        ) : !historyReady ? (
          // "No activity with Ahmed" while the older half of the ledger is
          // still in flight would be a false statement of account, so the two
          // are worded apart: still loading, or loaded-but-short.
          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4">
            <p className="text-[13px] text-ink-600">
              {historyFailed && !historyLoading ? t('tx_history_partial')
                .replace('{n}', String(transactions.length))
                .replace('{m}', '—') : t('tx_history_loading')}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4">
            <p className="text-[13px] text-ink-600">{t('soa_none').replace('{name}', partyName)}</p>
          </div>
        )}

        {/* Greeting selector — the statement opens with this line and signs
            off with your name, so it reads as a message, not an export. */}
        {hasContent && (
          <div>
            <p className="form-label">{t('soa_greeting_label')}</p>
            <div className="grid grid-cols-4 gap-2">
              {(['hello', 'salaam', 'dear', 'none'] as GreetingStyle[]).map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => setGreetingStyle(style)}
                  className={`py-2 rounded-xl text-[11px] font-bold border transition-all active:scale-95 ${
                    greetingStyle === style ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-500 border-cream-border'
                  }`}
                >
                  {greetLabels[style]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Privacy: hide the numbers — names, dates and structure stay. */}
        {hasContent && (
          <label className="flex items-center justify-between gap-3 rounded-2xl bg-cream-card border border-cream-border px-4 py-3 cursor-pointer">
            <span className="text-[12.5px] font-semibold text-ink-800">
              {t('soa_hide_amounts')}
              <span className="block text-[10.5px] font-normal text-ink-500 mt-0.5">{t('soa_hide_amounts_sub')}</span>
            </span>
            <input
              type="checkbox"
              checked={hideAmounts}
              onChange={(e) => setHideAmounts(e.target.checked)}
              className="w-4 h-4 accent-accent-600 shrink-0"
            />
          </label>
        )}

        {/* Text preview — mirrors what the WhatsApp ping / copy will contain. */}
        {hasContent && (
          <div>
            <p className="form-label">{t('soa_preview')}</p>
            <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4 max-h-56 overflow-auto">
              <p className="text-[12px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
            </div>
            <p className="text-[10px] text-ink-500 mt-2">
              {(knownNumber ? t('reminder_wa_to_name') : t('reminder_wa_pick')).replace('{name}', partyName)}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
