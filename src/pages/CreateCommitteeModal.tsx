import { useState } from 'react';
import { Plus, X, Trash2, Shield } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useToast } from '../components/Toast';
import { useCommitteeStore, type NewCommitteeMember } from '../stores/committeeStore';
import { currencyMeta } from '../lib/design-tokens';
import { poolAmount } from '../lib/committeeMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency, type CommitteeCadence, type CommitteePayoutMethod } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}

type Row = { name: string; phone: string };

export function CreateCommitteeModal({ open, onClose, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const createCommittee = useCommitteeStore((s) => s.createCommittee);

  const myName = localStorage.getItem('hisaab_user_name') || '';
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => (localStorage.getItem('hisaab_primary_currency') as Currency) || 'PKR');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<CommitteeCadence>('monthly');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<CommitteePayoutMethod>('fixed');
  // Row 0 is always the organizer (you); the rest are other members.
  const [organizerName, setOrganizerName] = useState(myName);
  const [rows, setRows] = useState<Row[]>([{ name: '', phone: '' }, { name: '', phone: '' }]);
  const [saving, setSaving] = useState(false);

  const memberCount = 1 + rows.filter((r) => r.name.trim()).length;
  const amt = parseFloat(amount) || 0;

  const reset = () => {
    setName(''); setAmount(''); setCadence('monthly'); setMethod('fixed');
    setStartDate(new Date().toISOString().slice(0, 10));
    setOrganizerName(myName);
    setRows([{ name: '', phone: '' }, { name: '', phone: '' }]);
  };

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { name: '', phone: '' }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  // Disable-until-valid: a name, a positive contribution, and at least one
  // named member (you're added as organizer automatically).
  const canCreate = !!name.trim() && amt > 0 && rows.some((r) => r.name.trim());
  const isDirty = !!name.trim() || !!amount.trim() || rows.some((r) => r.name.trim() || r.phone.trim());

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleCreate = () => submitGuard.run(runCreate);

  const runCreate = async () => {
    if (!name.trim()) { toast.show({ type: 'error', title: t('kameti_name') }); return; }
    if (!(amt > 0)) { toast.show({ type: 'error', title: t('val_need_amount') }); return; }
    const named = rows.filter((r) => r.name.trim());
    // You're added automatically as organizer, so one named row = 2 people.
    // (The old copy said "add 2 members" which didn't match this threshold.)
    if (named.length < 1) { toast.show({ type: 'error', title: t('kameti_need_one_member') }); return; }

    const members: NewCommitteeMember[] = [
      { name: organizerName.trim() || t('kameti_you_organizer'), isOrganizer: true },
      ...named.map((r) => ({ name: r.name.trim(), phone: r.phone.trim() || null })),
    ];

    setSaving(true);
    try {
      const c = await createCommittee({
        name: name.trim(), currency, contributionAmount: amt, cadence, startDate,
        payoutMethod: method, members,
      });
      reset();
      onClose();
      onCreated?.(c.id);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kameti_new')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <button onClick={handleCreate} disabled={saving || !canCreate} className="cta-primary">
          {saving ? t('kameti_creating') : t('kameti_create')}
        </button>
      }
    >
      <div className="space-y-4">
        {/* No-custody reassurance up front */}
        <div className="flex items-start gap-2.5 rounded-2xl bg-receive-50 border border-receive-100 p-3">
          <Shield size={16} className="text-receive-text shrink-0 mt-0.5" strokeWidth={2.2} />
          <p className="text-[11.5px] text-receive-text leading-relaxed">{t('kameti_no_custody_desc')}</p>
        </div>

        <div>
          <label className="form-label">{t('kameti_name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('kameti_name_ph')} className="input-field" />
        </div>

        <div>
          <label className="form-label">{t('kameti_amount')}</label>
          <input type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" />
          {amt > 0 && (
            <p className="text-[11px] text-ink-500 mt-1.5 text-center">
              {t('kameti_pool')}: <span className="font-semibold text-ink-800 tabular-nums">{formatMoney(poolAmount(amt, memberCount), currency)}</span> · {memberCount} {t('kameti_members').toLowerCase()}
            </p>
          )}
        </div>

        <div>
          <label className="form-label">Currency</label>
          <div className="grid grid-cols-4 gap-2">
            {SUPPORTED_CURRENCIES.map((c) => (
              <button key={c} type="button" onClick={() => setCurrency(c)}
                className={`justify-center text-[12px] font-semibold ${currency === c ? 'selector-base selector-selected' : 'selector-base'}`}>
                <span className="text-ink-800">{currencyMeta[c]?.flag} {c}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">{t('kameti_cadence')}</label>
          <div className="grid grid-cols-3 gap-2">
            {([['daily', 'kameti_cadence_daily'], ['weekly', 'kameti_cadence_weekly'], ['monthly', 'kameti_cadence_monthly']] as const).map(([c, key]) => (
              <button key={c} type="button" onClick={() => setCadence(c)}
                className={`py-2.5 rounded-xl text-[12px] font-semibold border transition-all ${cadence === c ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-600 border-cream-border'}`}>
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">{t('kameti_start_date')}</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field" />
        </div>

        <div>
          <label className="form-label">{t('kameti_method')}</label>
          <div className="space-y-2">
            {([['fixed', 'kameti_method_fixed', 'kameti_method_fixed_desc'], ['ballot', 'kameti_method_ballot', 'kameti_method_ballot_desc']] as const).map(([m, label, desc]) => (
              <button key={m} type="button" onClick={() => setMethod(m)}
                className={`w-full text-left ${method === m ? 'selector-base selector-selected' : 'selector-base'}`}>
                <span className="flex flex-col">
                  <span className="text-[13px] font-semibold text-ink-900">{t(label)}</span>
                  <span className="text-[11px] text-ink-500">{t(desc)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Members */}
        <div>
          <label className="form-label">{t('kameti_members')}</label>
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-2xl bg-accent-50 border border-accent-100 px-3 py-2.5">
              <span className="text-[10px] font-semibold text-accent-600 shrink-0">{t('kameti_you_organizer')}</span>
              <input value={organizerName} onChange={(e) => setOrganizerName(e.target.value)} placeholder={t('kameti_member_name_ph')} className="flex-1 bg-transparent outline-none text-[13px] text-ink-900 placeholder:text-ink-400" />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 rounded-2xl bg-cream-card border border-cream-border px-3 py-2">
                  <input value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} placeholder={t('kameti_member_name_ph')} className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-ink-900 placeholder:text-ink-400" />
                  <input value={r.phone} onChange={(e) => updateRow(i, { phone: e.target.value })} placeholder={t('kameti_member_phone_ph')} inputMode="tel" className="w-28 bg-transparent outline-none text-[11px] text-ink-600 placeholder:text-ink-400 border-l border-cream-hairline pl-2" />
                </div>
                {rows.length > 1 && (
                  <button type="button" onClick={() => removeRow(i)} className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-400 active:bg-cream-soft" aria-label="Remove">
                    {rows.length > 2 ? <Trash2 size={14} /> : <X size={14} />}
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addRow} className="w-full py-2.5 rounded-2xl border border-dashed border-accent-500/50 text-accent-600 text-[12px] font-semibold flex items-center justify-center gap-1.5 active:bg-accent-50/60">
              <Plus size={13} strokeWidth={2.6} /> {t('kameti_add_member')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
