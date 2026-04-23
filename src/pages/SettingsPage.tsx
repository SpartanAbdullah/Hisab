import { useEffect, useRef, useState } from "react";
import {
  Shield,
  Download,
  Upload,
  Globe,
  Smartphone,
  Info,
  ChevronRight,
  Lock,
  Unlock,
  User,
  Mail,
  Phone,
  KeyRound,
  LogOut,
  Users,
} from "lucide-react";
import { ContactsModal } from "./ContactsModal";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { PageHeader } from "../components/PageHeader";
import { LanguageToggle } from "../components/LanguageToggle";
import { useAppModeStore } from "../stores/appModeStore";
import { useAccountStore } from "../stores/accountStore";
import { useAuthStore } from "../stores/authStore";
import { useToast } from "../components/Toast";
import { useT, useI18nStore } from "../lib/i18n";
import { exportAllData, importData, downloadJSON } from "../lib/dataExport";
import { profilesDb } from "../lib/supabaseDb";
import {
  generatePublicCodeCandidate,
  normalizePublicCode,
} from "../lib/collaboration";

export function SettingsPage() {
  const t = useT();
  const toast = useToast();
  const { mode, setMode } = useAppModeStore();
  const { accounts } = useAccountStore();
  const { lang, setLang } = useI18nStore();
  const { hasPin, setPin, removePin } = useAuthStore();
  const { signOut, user } = useSupabaseAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [email] = useState(
    () => user?.email ?? localStorage.getItem("hisaab_email") ?? "",
  );
  const [mobile, setMobile] = useState(
    () => localStorage.getItem("hisaab_mobile") ?? "",
  );
  const [newPassword, setNewPassword] = useState("");
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [publicCode, setPublicCode] = useState("");
  const userName = localStorage.getItem("hisaab_user_name") ?? "";

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const ensurePublicCode = async () => {
      const profile = await profilesDb.getCurrent();
      if (!profile || cancelled) return;

      const existing =
        typeof profile.public_code === "string" ? profile.public_code : "";
      if (existing) {
        setPublicCode(existing);
        return;
      }

      const nextCode = generatePublicCodeCandidate();
      await profilesDb.updateCurrent({
        public_code: nextCode,
        public_code_normalized: normalizePublicCode(nextCode),
      });

      if (!cancelled) setPublicCode(nextCode);
    };

    void ensurePublicCode().catch(() => {
      if (!cancelled) setPublicCode("");
    });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await exportAllData();
      const date = new Date().toISOString().slice(0, 10);
      downloadJSON(data, `hisaab_backup_${date}.json`);
      toast.show({
        type: "success",
        title: t("settings_export"),
        subtitle: `hisaab_backup_${date}.json`,
      });
    } catch {
      toast.show({ type: "error", title: t("error") });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm(t("settings_import_warn"))) {
      e.target.value = "";
      return;
    }
    try {
      const text = await file.text();
      const result = await importData(text);
      if (result.success) {
        toast.show({ type: "success", title: t("settings_import_success") });
        setTimeout(() => window.location.reload(), 1000);
      } else {
        toast.show({
          type: "error",
          title: t("settings_import_fail"),
          subtitle: result.message,
        });
      }
    } catch {
      toast.show({ type: "error", title: t("settings_import_fail") });
    }
    e.target.value = "";
  };

  const handleSetPin = async () => {
    if (pin1.length !== 4 || pin2.length !== 4) return;
    if (pin1 !== pin2) {
      toast.show({ type: "error", title: t("pin_mismatch") });
      return;
    }
    await setPin(pin1);
    toast.show({ type: "success", title: t("pin_set_success") });
    setShowPinSetup(false);
    setPin1("");
    setPin2("");
  };

  const handleRemovePin = () => {
    removePin();
    toast.show({ type: "success", title: t("pin_removed") });
  };

  const handleSaveProfile = () => {
    if (mobile) localStorage.setItem("hisaab_mobile", mobile);
    toast.show({ type: "success", title: t("settings_profile_saved") });
  };

  const handlePasswordReset = async () => {
    if (!newPassword || newPassword.length < 6) {
      toast.show({
        type: "error",
        title: "Password must be at least 6 characters",
      });
      return;
    }
    setPasswordSaving(true);
    try {
      const { changePassword } = useSupabaseAuthStore.getState();
      await changePassword(newPassword);
      toast.show({ type: "success", title: "Password updated successfully!" });
      setNewPassword("");
      setShowPasswordChange(false);
    } catch {
      toast.show({ type: "error", title: "Failed to update password" });
    } finally {
      setPasswordSaving(false);
    }
  };

  const sectionClass =
    "card-premium overflow-hidden divide-y divide-slate-100/60";
  const rowClass =
    "row-base row-interactive px-4 py-3.5";

  return (
    <div className="pb-28 bg-mesh min-h-dvh">
      <PageHeader title={t("settings_title")} action={<LanguageToggle />} />

      <div className="px-5 pt-5 space-y-4">
        {/* My Account */}
        <div className={sectionClass}>
          <button
            onClick={() => setShowProfile(!showProfile)}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center">
              <User size={16} className="text-indigo-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_my_account")}
              </p>
              <p className="text-[11px] text-slate-400">
                {userName || t("settings_my_account_desc")}
              </p>
            </div>
            <ChevronRight
              size={16}
              className={`text-slate-300 transition-transform ${showProfile ? "rotate-90" : ""}`}
            />
          </button>
          {showProfile && (
            <div className="p-4 space-y-3 animate-fade-in">
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <Mail size={10} /> {t("settings_email")}
                </label>
                <input
                  type="email"
                  value={email}
                  readOnly
                  className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] bg-slate-50 text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <Phone size={10} /> {t("settings_mobile")}
                </label>
                <input
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="+971 50 123 4567"
                  className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <User size={10} /> User Code
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={publicCode ? `@${publicCode}` : ""}
                    readOnly
                    placeholder="Generating..."
                    className="flex-1 border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] bg-slate-50 text-slate-700"
                  />
                  <button
                    onClick={async () => {
                      if (!publicCode) return;
                      await navigator.clipboard.writeText(`@${publicCode}`);
                      toast.show({
                        type: "success",
                        title: "User code copied",
                      });
                    }}
                    disabled={!publicCode}
                    className="px-4 rounded-xl bg-indigo-50 text-indigo-600 text-[12px] font-bold disabled:opacity-40"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mt-1.5">
                  People can use this code to connect with you in shared groups.
                </p>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <KeyRound size={10} /> {t("settings_password")}
                </label>
                <input
                  type="password"
                  value="••••••••"
                  readOnly
                  className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] bg-slate-50 text-slate-600 cursor-not-allowed"
                />
                <button
                  onClick={() => setShowPasswordChange(!showPasswordChange)}
                  className="text-[11px] text-indigo-500 font-semibold mt-1.5"
                >
                  {t("settings_reset_password")}
                </button>
              </div>
              {showPasswordChange && (
                <div className="space-y-2 animate-fade-in bg-indigo-50/50 rounded-xl p-3 border border-indigo-100/60">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (min 6 chars)"
                    className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all bg-white"
                  />
                  <button
                    onClick={handlePasswordReset}
                    disabled={passwordSaving || newPassword.length < 6}
                    className="w-full py-2.5 rounded-xl btn-gradient text-[12px] font-bold disabled:opacity-30"
                  >
                    {passwordSaving ? "Updating..." : "Update Password"}
                  </button>
                </div>
              )}
              <button
                onClick={handleSaveProfile}
                className="w-full py-2.5 rounded-xl btn-gradient text-[12px] font-bold"
              >
                {t("settings_save_profile")}
              </button>
            </div>
          )}
        </div>

        {/* Language */}
        <div className={sectionClass}>
          <button
            onClick={() => setLang(lang === "ur" ? "en" : "ur")}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
              <Globe size={16} className="text-blue-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_language")}
              </p>
              <p className="text-[11px] text-slate-400">
                {lang === "ur" ? "Roman Urdu" : "English"}
              </p>
            </div>
            <ChevronRight size={16} className="text-slate-300" />
          </button>
        </div>

        {/* App Mode */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-purple-50 flex items-center justify-center">
              <Smartphone size={16} className="text-purple-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_app_mode")}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("settings_mode_current")}:{" "}
                {mode === "splits_only"
                  ? t("mode_splits_title")
                  : t("mode_full_title")}
              </p>
            </div>
          </div>
          <div className="p-4 flex gap-2">
            <button
              onClick={() => {
                const unsettled = accounts.filter((a) => a.balance !== 0);
                if (unsettled.length > 0) {
                  toast.show({
                    type: "error",
                    title: t("mode_switch_blocked"),
                    subtitle: t("mode_switch_blocked_desc"),
                  });
                  return;
                }
                setMode("splits_only");
              }}
              className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold transition-all ${mode === "splits_only" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}
            >
              {t("mode_splits_title")}
            </button>
            <button
              onClick={() => setMode("full_tracker")}
              className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold transition-all ${mode === "full_tracker" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}
            >
              {t("mode_full_title")}
            </button>
          </div>
        </div>

        {/* Security */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center">
              <Shield size={16} className="text-amber-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_security")}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("settings_pin_desc")}
              </p>
            </div>
          </div>
          {showPinSetup ? (
            <div className="p-4 space-y-3">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                placeholder={t("pin_set_title")}
                value={pin1}
                onChange={(e) => setPin1(e.target.value.replace(/\D/g, ""))}
                className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-center text-lg tracking-[0.5em] font-bold"
              />
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                placeholder={t("pin_confirm")}
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                className="w-full border border-slate-200/60 rounded-xl px-4 py-3 text-center text-lg tracking-[0.5em] font-bold"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowPinSetup(false);
                    setPin1("");
                    setPin2("");
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-500 text-[12px] font-bold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSetPin}
                  disabled={pin1.length !== 4 || pin2.length !== 4}
                  className="flex-1 py-2.5 rounded-xl btn-gradient text-[12px] font-bold disabled:opacity-30"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 flex gap-2">
              {hasPin ? (
                <>
                  <button
                    onClick={() => setShowPinSetup(true)}
                    className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-[12px] font-bold flex items-center justify-center gap-1.5"
                  >
                    <Lock size={12} /> {t("settings_change_pin")}
                  </button>
                  <button
                    onClick={handleRemovePin}
                    className="flex-1 py-2.5 rounded-xl bg-red-50 text-red-500 text-[12px] font-bold flex items-center justify-center gap-1.5"
                  >
                    <Unlock size={12} /> {t("settings_remove_pin")}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowPinSetup(true)}
                  className="flex-1 py-2.5 rounded-xl btn-gradient text-[12px] font-bold flex items-center justify-center gap-1.5"
                >
                  <Lock size={12} /> {t("settings_set_pin")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Contacts */}
        <div className={sectionClass}>
          <button
            onClick={() => setShowContacts(true)}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center">
              <Users size={16} className="text-indigo-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                Your Contacts
              </p>
              <p className="text-[11px] text-slate-400">
                People linked to your loans and transactions
              </p>
            </div>
            <ChevronRight size={16} className="text-slate-300" />
          </button>
        </div>

        {/* Backup */}
        <div className={sectionClass}>
          <button
            onClick={handleExport}
            disabled={exporting}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center">
              <Download size={16} className="text-emerald-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_export")}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("settings_export_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-slate-300" />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
              <Upload size={16} className="text-blue-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_import")}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("settings_import_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-slate-300" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>

        {/* About */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center">
              <Info size={16} className="text-slate-400" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-slate-700">
                {t("settings_about")}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("settings_about_desc")}
              </p>
            </div>
          </div>
        </div>

        {/* Sign Out */}
        {user && (
          <div className={sectionClass}>
            <button
              onClick={async () => {
                await signOut();
                window.location.reload();
              }}
              className={rowClass + " w-full text-left"}
            >
              <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center">
                <LogOut size={16} className="text-red-500" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-red-600">Logout</p>
                <p className="text-[11px] text-slate-400">{user.email}</p>
              </div>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-4 pb-2">
          <p className="text-[11px] text-slate-400">
            Made with ❤️ by Shalbandian
          </p>
        </div>
      </div>

      <ContactsModal
        open={showContacts}
        onClose={() => setShowContacts(false)}
      />
    </div>
  );
}
