import { useState } from 'react';
import { Wallet, Building2, Smartphone, PiggyBank, CreditCard, Check } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { StepIndicator } from '../components/StepIndicator';
import type { AccountType, Currency } from '../db';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';

interface Props { open: boolean; onClose: () => void; onComplete?: () => void; inline?: boolean; }

const ACCOUNT_TYPES = [
  { value: 'cash' as AccountType, label_key: 'type_cash' as const, icon: Wallet, gradient: 'from-emerald-500 to-teal-500', soft: 'bg-gradient-to-br from-emerald-50 to-emerald-100/50 text-emerald-600 border-emerald-100' },
  { value: 'bank' as AccountType, label_key: 'type_bank' as const, icon: Building2, gradient: 'from-blue-500 to-indigo-500', soft: 'bg-gradient-to-br from-blue-50 to-blue-100/50 text-blue-600 border-blue-100' },
  { value: 'digital_wallet' as AccountType, label_key: 'type_wallet' as const, icon: Smartphone, gradient: 'from-purple-500 to-violet-500', soft: 'bg-gradient-to-br from-purple-50 to-purple-100/50 text-purple-600 border-purple-100' },
  { value: 'savings' as AccountType, label_key: 'type_savings' as const, icon: PiggyBank, gradient: 'from-amber-500 to-orange-500', soft: 'bg-gradient-to-br from-amber-50 to-amber-100/50 text-amber-600 border-amber-100' },
  { value: 'credit_card' as AccountType, label_key: 'type_credit_card' as const, icon: CreditCard, gradient: 'from-slate-700 to-slate-900', soft: 'bg-gradient-to-br from-slate-100 to-slate-200/50 text-slate-700 border-slate-200' },
];

const BANK_PRESETS = [
  { name: 'Mashreq Bank', currency: 'AED' as Currency },
  { name: 'Emirates NBD', currency: 'AED' as Currency },
  { name: 'ADCB', currency: 'AED' as Currency },
  { name: 'Emirates Islamic', currency: 'AED' as Currency },
  { name: 'HBL', currency: 'PKR' as Currency },
  { name: 'Meezan Bank', currency: 'PKR' as Currency },
  { name: 'UBL', currency: 'PKR' as Currency },
];

const WALLET_PRESETS = [
  { name: 'EasyPaisa', walletType: 'easypaisa', currency: 'PKR' as Currency },
  { name: 'JazzCash', walletType: 'jazzcash', currency: 'PKR' as Currency },
  { name: 'NayaPay', walletType: 'nayapay', currency: 'PKR' as Currency },
  { name: 'SadaPay', walletType: 'sadapay', currency: 'PKR' as Currency },
];

const CC_ISSUER_PRESETS = [
  { name: 'Mashreq', currency: 'AED' as Currency },
  { name: 'Emirates NBD', currency: 'AED' as Currency },
  { name: 'Emirates Islamic', currency: 'AED' as Currency },
  { name: 'ADCB', currency: 'AED' as Currency },
  { name: 'HBL', currency: 'PKR' as Currency },
  { name: 'Meezan Bank', currency: 'PKR' as Currency },
];

export function AddAccountStepper({ open, onClose, onComplete, inline }: Props) {
  const { accounts, createAccount, loadAccounts } = useAccountStore();
  const toast = useToast();
  const t = useT();

  const [step, setStep] = useState(0);
  const [accountType, setAccountType] = useState<AccountType>('cash');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('AED');
  const [balance, setBalance] = useState('');
  const [bankName, setBankName] = useState('');
  const [walletType, setWalletType] = useState('');
  // Credit card fields
  const [ccIssuer, setCcIssuer] = useState('');
  const [ccLast4, setCcLast4] = useState('');
  const [ccLimit, setCcLimit] = useState('');
  const [ccDueDay, setCcDueDay] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setStep(0); setAccountType('cash'); setName(''); setCurrency('AED');
    setBalance(''); setBankName(''); setWalletType('');
    setCcIssuer(''); setCcLast4(''); setCcLimit(''); setCcDueDay('');
  };
  const handleClose = () => { reset(); onClose(); };

  const selectType = (type: AccountType) => {
    setAccountType(type);
    if (type === 'cash') { setName(''); setCurrency('AED'); }
    setStep(1);
  };

  const selectPreset = (preset: { name: string; currency: Currency; walletType?: string }) => {
    setName(preset.name); setCurrency(preset.currency);
    if ('walletType' in preset && preset.walletType) setWalletType(preset.walletType);
    if (accountType === 'bank') setBankName(preset.name);
    setStep(2);
  };

  const selectCcIssuer = (preset: { name: string; currency: Currency }) => {
    setCcIssuer(preset.name); setCurrency(preset.currency);
    setName(`${preset.name} Credit Card`);
  };

  const canProceedStep1 = () => {
    if (accountType === 'credit_card') {
      return ccIssuer.trim() && ccLast4.length === 4 && parseFloat(ccLimit) > 0 && parseInt(ccDueDay) > 0;
    }
    return name.trim().length > 0;
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const metadata: Record<string, string> = {};
      if (accountType === 'bank' && bankName) metadata.bankName = bankName;
      if (accountType === 'digital_wallet' && walletType) metadata.walletType = walletType;
      if (accountType === 'credit_card') {
        metadata.issuer = ccIssuer;
        metadata.last4 = ccLast4;
        metadata.creditLimit = ccLimit;
        metadata.dueDay = ccDueDay;
      }

      // Credit card: balance = available credit = limit (new card, nothing spent)
      const initialBalance = accountType === 'credit_card'
        ? parseFloat(ccLimit) || 0
        : parseFloat(balance) || 0;

      const accountName = accountType === 'credit_card'
        ? `${ccIssuer} ••••${ccLast4}`
        : name.trim();

      const isFirstAccount = accounts.length === 0;
      await createAccount({
        name: accountName,
        type: accountType,
        currency,
        balance: initialBalance,
        metadata,
      });
      await loadAccounts();
      if (isFirstAccount) {
        toast.show({ type: 'success', title: t('first_acct_congrats'), subtitle: t('first_acct_msg') });
      } else {
        toast.show({ type: 'success', title: t('acct_created'), subtitle: `${accountName} — ${currency}` });
      }
      reset(); onComplete?.(); if (!inline) onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : 'Account nahi bana' });
    } finally { setSaving(false); }
  };

  const isCreditCard = accountType === 'credit_card';
  const title = inline ? t('acct_create_first') : step === 0 ? t('acct_what_type') : step === 1 ? t('acct_details') : t('acct_opening');

  const footerContent = step === 1 ? (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(0)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-slate-200/60 text-slate-500 active:bg-slate-50">&#x2190;</button>
      {isCreditCard ? (
        <button onClick={handleSubmit} disabled={saving || !canProceedStep1()}
          className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
        >{saving ? t('acct_creating') : <><Check size={16} /> {t('acct_create')}</>}</button>
      ) : (
        <button onClick={() => setStep(2)} disabled={!canProceedStep1()} className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">{t('quick_next')} &#x2192;</button>
      )}
    </div>
  ) : step === 2 ? (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(1)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-slate-200/60 text-slate-500 active:bg-slate-50">&#x2190;</button>
      <button onClick={handleSubmit} disabled={saving || !name.trim()}
        className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
      >{saving ? t('acct_creating') : <><Check size={16} /> {t('acct_create')}</>}</button>
    </div>
  ) : undefined;

  return (
    <Modal open={open} onClose={handleClose} title={title} footer={footerContent}>
      <div className="space-y-4">
        <StepIndicator steps={['Type', 'Details', ...(isCreditCard ? [] : ['Balance'])]} current={step} />

        {/* Step 0: Type */}
        {step === 0 && (
          <div className="space-y-2.5 animate-fade-in">
            {inline && (
              <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/60 rounded-2xl p-3.5 mb-3">
                <p className="text-[12px] text-amber-700 font-semibold tracking-tight">{t('acct_need_for_tx')}</p>
              </div>
            )}
            {ACCOUNT_TYPES.map(at => {
              const Icon = at.icon;
              const isActive = accountType === at.value;
              return (
                <button key={at.value} onClick={() => selectType(at.value)}
                  className={`w-full p-4 rounded-2xl border-2 flex items-center gap-3.5 text-left transition-all active:scale-[0.98] ${
                    isActive ? `bg-gradient-to-r ${at.gradient} text-white border-transparent shadow-md` : `${at.soft}`
                  }`}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isActive ? 'bg-white/20' : ''}`}>
                    <Icon size={20} strokeWidth={1.8} />
                  </div>
                  <span className="font-semibold text-[13px] tracking-tight">{t(at.label_key)}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Step 1: Details */}
        {step === 1 && (
          <div className="space-y-4 animate-fade-in">
            {/* Credit card specific fields */}
            {isCreditCard ? (
              <>
                {/* Issuer presets */}
                <div>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('cc_issuer')}</p>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {CC_ISSUER_PRESETS.map(p => {
                      const meta = currencyMeta[p.currency];
                      return (
                        <button key={p.name} type="button" onClick={() => selectCcIssuer(p)}
                          className={`p-3 rounded-2xl border-2 text-left transition-all active:scale-[0.97] ${
                            ccIssuer === p.name ? 'border-indigo-400 bg-indigo-50/50 shadow-sm' : 'border-slate-200/60 bg-white'
                          }`}
                        >
                          <p className="font-semibold text-[12px] text-slate-700 tracking-tight">{p.name}</p>
                          <p className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">{meta?.flag} {p.currency}</p>
                        </button>
                      );
                    })}
                  </div>
                  <input value={ccIssuer} onChange={e => { setCcIssuer(e.target.value); setName(`${e.target.value} Credit Card`); }}
                    placeholder="Or type issuer name..." className="input-field" />
                </div>

                <div>
                  <label className="form-label">{t('cc_last4')}</label>
                  <input value={ccLast4} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setCcLast4(v); }}
                    placeholder="e.g. 4521" maxLength={4} inputMode="numeric" className="input-field text-center text-lg font-bold tracking-[0.3em]" />
                </div>

                <div>
                  <label className="form-label">{t('cc_limit')}</label>
                  <input type="number" step="0.01" value={ccLimit} onChange={e => setCcLimit(e.target.value)}
                    placeholder="e.g. 10000" className="input-field text-center text-lg font-bold tabular-nums" />
                </div>

                <div>
                  <label className="form-label">{t('cc_due_day')}</label>
                  <input type="number" min="1" max="31" value={ccDueDay} onChange={e => setCcDueDay(e.target.value)}
                    placeholder="e.g. 15" className="input-field text-center" />
                </div>

                <div>
                  <label className="form-label">Currency</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['AED', 'PKR'] as Currency[]).map(c => {
                      const meta = currencyMeta[c];
                      return (
                        <button key={c} type="button" onClick={() => setCurrency(c)}
                          className={`py-3 rounded-2xl border-2 text-[13px] font-semibold text-center transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${
                            currency === c ? 'border-indigo-400 bg-indigo-50/50 text-indigo-700 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white text-slate-500'
                          }`}
                        >{meta?.flag} {c}</button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Bank/Wallet presets */}
                {(accountType === 'bank' || accountType === 'digital_wallet') && (
                  <div>
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('acct_quick_select')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(accountType === 'bank' ? BANK_PRESETS : WALLET_PRESETS).map(p => {
                        const meta = currencyMeta[p.currency];
                        return (
                          <button key={p.name} onClick={() => selectPreset(p)}
                            className={`p-3.5 rounded-2xl border-2 text-left transition-all active:scale-[0.97] ${
                              name === p.name ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                            }`}
                          >
                            <p className="font-semibold text-[12px] text-slate-700 tracking-tight">{p.name}</p>
                            <p className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">{meta?.flag} {p.currency}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className={accountType === 'bank' || accountType === 'digital_wallet' ? 'border-t border-slate-100/60 pt-4' : ''}>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                    {accountType === 'bank' || accountType === 'digital_wallet' ? t('acct_or_type') : t('acct_name')}
                  </p>
                  <input value={name} onChange={e => setName(e.target.value)}
                    placeholder={accountType === 'cash' ? 'e.g. Jaib Kharcha' : accountType === 'bank' ? 'e.g. My Account' : 'e.g. My Wallet'}
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="form-label">Currency</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['AED', 'PKR'] as Currency[]).map(c => {
                      const meta = currencyMeta[c];
                      return (
                        <button key={c} type="button" onClick={() => setCurrency(c)}
                          className={`py-3 rounded-2xl border-2 text-[13px] font-semibold text-center transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${
                            currency === c ? 'border-indigo-400 bg-indigo-50/50 text-indigo-700 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white text-slate-500'
                          }`}
                        >{meta?.flag} {c}</button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2: Balance (non-credit-card only) */}
        {step === 2 && !isCreditCard && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-slate-50/80 rounded-2xl p-4 text-center border border-slate-100/60">
              <p className="text-[10px] text-slate-400 uppercase tracking-widest">{t('acct_new')}</p>
              <p className="font-bold text-[15px] mt-1 text-slate-800 tracking-tight">{name}</p>
              <p className="text-[11px] text-slate-400 capitalize mt-0.5 flex items-center gap-1 justify-center">
                <span>{currencyMeta[currency]?.flag}</span> {accountType.replace('_', ' ')} — {currency}
              </p>
            </div>

            <div>
              <label className="form-label">{t('acct_how_much')}</label>
              <input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)}
                placeholder="0.00"
                className="input-field text-center text-xl font-bold tabular-nums"
                autoFocus
              />
              <p className="text-[11px] text-slate-400 text-center mt-1.5">{t('acct_leave_empty')}</p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
