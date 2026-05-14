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
  AlertTriangle,
  Trash2,
  Share2,
  Sparkles,
  Copy,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { NavyHero, TopBar } from "../components/NavyHero";
import { UserAvatar } from "../components/UserAvatar";
import { LanguageToggle } from "../components/LanguageToggle";
import { useAppModeStore } from "../stores/appModeStore";
import { useAccountStore } from "../stores/accountStore";
import { useAuthStore } from "../stores/authStore";
import { useToast } from "../components/Toast";
import { useT, useI18nStore } from "../lib/i18n";
import { exportAllData, importData, downloadJSON } from "../lib/dataExport";
import { profilesDb } from "../lib/supabaseDb";
import {
  buildAppShareUrl,
  generatePublicCodeCandidate,
  normalizePublicCode,
} from "../lib/collaboration";

function copyWithTextareaFallback(text: string): Promise<void> {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    document.body.removeChild(textarea);
  }
}

function copyShareText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextareaFallback(text));
  }

  return copyWithTextareaFallback(text);
}

export function SettingsPage() {
  const t = useT();
  const toast = useToast();
  const { mode, setMode } = useAppModeStore();
  const { accounts } = useAccountStore();
  const { lang, setLang } = useI18nStore();
  const { hasPin, setPin, removePin } = useAuthStore();
  const { signOut, deleteAccount, user } = useSupabaseAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [exporting, setExporting] = useState(false);
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
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);
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

  const handleShareApp = async () => {
    const shareUrl = buildAppShareUrl();
    const shareText = t("settings_share_app_text");

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Hisaab",
          text: shareText,
          url: shareUrl,
        });
        return;
      }

      await copyShareText(`${shareText}\n${shareUrl}`);
      toast.show({
        type: "success",
        title: t("settings_share_app_copied"),
        subtitle: shareUrl,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.show({ type: "error", title: t("settings_share_app_failed") });
    }
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

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "DELETE") return;
    setDeleteSaving(true);
    try {
      await deleteAccount();
      window.location.assign("/");
    } catch (error) {
      toast.show({
        type: "error",
        title: "Could not delete account",
        subtitle: error instanceof Error ? error.message : "Please try again.",
      });
      setDeleteSaving(false);
    }
  };

  const sectionClass =
    "rounded-[18px] bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline";
  const rowClass =
    "row-base row-interactive px-4 py-3.5";

  const copyUserCode = async () => {
    if (!publicCode) return;
    try {
      await copyShareText(`@${publicCode}`);
      toast.show({ type: "success", title: "User code copied" });
    } catch {
      toast.show({ type: "error", title: "Couldn't copy code" });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t("settings_title")}
          back
          action={<LanguageToggle />}
        />
        <div className="px-5 pb-7">
          <div className="flex items-center gap-3">
            <UserAvatar name={userName || email || "User"} size={56} />
            <div className="min-w-0 flex-1">
              <p className="text-white text-[16px] font-semibold tracking-tight truncate">
                {userName || "Hisaab user"}
              </p>
              {email && (
                <p className="text-[11px] text-white/55 truncate mt-0.5">{email}</p>
              )}
            </div>
          </div>

          {/* Copyable user-code chip — Sukoon's identity surface. Stays
              minimal until the public_code is ready; tap copies @code. */}
          <button
            onClick={copyUserCode}
            disabled={!publicCode}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-white active:bg-white/20 transition-colors disabled:opacity-50"
          >
            <span className="text-white/55 uppercase tracking-[0.12em] text-[9px]">
              code HSB
            </span>
            <span className="tabular-nums">
              {publicCode ? `@${publicCode}` : "—"}
            </span>
            {publicCode && <Copy size={11} strokeWidth={2.2} />}
          </button>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* My Account */}
        <div className={sectionClass}>
          <button
            onClick={() => setShowProfile(!showProfile)}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <User size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_my_account")}
              </p>
              <p className="text-[11px] text-ink-500">
                {userName || t("settings_my_account_desc")}
              </p>
            </div>
            <ChevronRight
              size={16}
              className={`text-ink-300 transition-transform ${showProfile ? "rotate-90" : ""}`}
            />
          </button>
          {showProfile && (
            <div className="p-4 space-y-3 animate-fade-in">
              <div>
                <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <Mail size={10} /> {t("settings_email")}
                </label>
                <input
                  type="email"
                  value={email}
                  readOnly
                  className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] bg-cream-soft text-ink-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <Phone size={10} /> {t("settings_mobile")}
                </label>
                <input
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="+971 50 123 4567"
                  className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <User size={10} /> User Code
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={publicCode ? `@${publicCode}` : ""}
                    readOnly
                    placeholder="Generating..."
                    className="flex-1 border border-cream-border rounded-xl px-4 py-3 text-[13px] bg-cream-soft text-ink-900"
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
                    className="px-4 rounded-xl bg-accent-100 text-accent-600 text-[12px] font-semibold disabled:opacity-40"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[10px] text-ink-500 mt-1.5">
                  People can use this code to connect with you in shared groups.
                </p>
              </div>
              <div>
                <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                  <KeyRound size={10} /> {t("settings_password")}
                </label>
                <input
                  type="password"
                  value="••••••••"
                  readOnly
                  className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] bg-cream-soft text-ink-600 cursor-not-allowed"
                />
                <button
                  onClick={() => setShowPasswordChange(!showPasswordChange)}
                  className="text-[11px] text-accent-600 font-semibold mt-1.5"
                >
                  {t("settings_reset_password")}
                </button>
              </div>
              {showPasswordChange && (
                <div className="space-y-2 animate-fade-in bg-accent-50 rounded-xl p-3 border border-cream-border">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (min 6 chars)"
                    className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all bg-white"
                  />
                  <button
                    onClick={handlePasswordReset}
                    disabled={passwordSaving || newPassword.length < 6}
                    className="w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30"
                  >
                    {passwordSaving ? "Updating..." : "Update Password"}
                  </button>
                </div>
              )}
              <button
                onClick={handleSaveProfile}
                className="w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold"
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
            <div className="w-9 h-9 rounded-xl bg-info-50 flex items-center justify-center">
              <Globe size={16} className="text-info-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_language")}
              </p>
              <p className="text-[11px] text-ink-500">
                {lang === "ur" ? "Roman Urdu" : "English"}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
        </div>

        {/* App Mode */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Smartphone size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_app_mode")}
              </p>
              <p className="text-[11px] text-ink-500">
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
                void profilesDb.updateCurrent({ app_mode: "splits_only" }).catch(() => {});
              }}
              className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold transition-all ${mode === "splits_only" ? "bg-ink-900 text-white" : "bg-cream-soft text-ink-500"}`}
            >
              {t("mode_splits_title")}
            </button>
            <button
              onClick={() => {
                setMode("full_tracker");
                void profilesDb.updateCurrent({ app_mode: "full_tracker" }).catch(() => {});
              }}
              className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold transition-all ${mode === "full_tracker" ? "bg-ink-900 text-white" : "bg-cream-soft text-ink-500"}`}
            >
              {t("mode_full_title")}
            </button>
          </div>
        </div>

        {/* Security */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-warn-50 flex items-center justify-center">
              <Shield size={16} className="text-warn-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_security")}
              </p>
              <p className="text-[11px] text-ink-500">
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
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-center text-lg tracking-[0.5em] font-bold"
              />
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                placeholder={t("pin_confirm")}
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                className="w-full border border-cream-border rounded-xl px-4 py-3 text-center text-lg tracking-[0.5em] font-bold"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowPinSetup(false);
                    setPin1("");
                    setPin2("");
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-cream-soft text-ink-500 text-[12px] font-bold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSetPin}
                  disabled={pin1.length !== 4 || pin2.length !== 4}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30"
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
                    className="flex-1 py-2.5 rounded-xl bg-cream-soft text-ink-600 text-[12px] font-bold flex items-center justify-center gap-1.5"
                  >
                    <Lock size={12} /> {t("settings_change_pin")}
                  </button>
                  <button
                    onClick={handleRemovePin}
                    className="flex-1 py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold flex items-center justify-center gap-1.5"
                  >
                    <Unlock size={12} /> {t("settings_remove_pin")}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowPinSetup(true)}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold flex items-center justify-center gap-1.5"
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
            onClick={() => navigate('/contacts')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Users size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_contacts_tile")}
              </p>
              <p className="text-[11px] text-ink-500">
                {t("settings_contacts_tile_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
          <button
            onClick={handleShareApp}
            className={rowClass + " w-full text-left"}
          >
            <div className="relative w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Share2 size={16} className="text-accent-600" />
              <span className="absolute -right-1 -top-1 w-4 h-4 rounded-full bg-warn-50 border border-warn-50 flex items-center justify-center">
                <Sparkles size={10} className="text-warn-600" />
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-semibold text-ink-900 truncate">
                  {t("settings_share_app")}
                </p>
                <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent-600">
                  {t("settings_share_app_badge")}
                </span>
              </div>
              <p className="text-[11px] text-ink-500 leading-relaxed">
                {t("settings_share_app_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
        </div>

        {/* Backup */}
        <div className={sectionClass}>
          <button
            onClick={handleExport}
            disabled={exporting}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center">
              <Download size={16} className="text-receive-text" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_export")}
              </p>
              <p className="text-[11px] text-ink-500">
                {t("settings_export_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-info-50 flex items-center justify-center">
              <Upload size={16} className="text-info-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_import")}
              </p>
              <p className="text-[11px] text-ink-500">
                {t("settings_import_desc")}
              </p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
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
            <div className="w-9 h-9 rounded-xl bg-cream-soft flex items-center justify-center">
              <Info size={16} className="text-ink-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("settings_about")}
              </p>
              <p className="text-[11px] text-ink-500">
                {t("settings_about_desc")}
              </p>
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        {user && (
          <div className="rounded-[18px] bg-cream-card overflow-hidden border border-pay-100 divide-y divide-pay-100/60">
            <button
              onClick={() => setShowDeleteAccount(!showDeleteAccount)}
              className="row-base row-interactive px-4 py-3.5 w-full text-left"
            >
              <div className="w-9 h-9 rounded-xl bg-pay-50 flex items-center justify-center">
                <AlertTriangle size={16} className="text-pay-text" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-pay-text">
                  Delete account
                </p>
                <p className="text-[11px] text-ink-500">
                  Anonymize your profile and sign out
                </p>
              </div>
              <ChevronRight
                size={16}
                className={`text-pay-text/60 transition-transform ${showDeleteAccount ? "rotate-90" : ""}`}
              />
            </button>
            {showDeleteAccount && (
              <div className="p-4 space-y-3 bg-pay-50 animate-fade-in">
                <div className="rounded-xl border border-pay-100 bg-cream-card px-3.5 py-3">
                  <p className="text-[12px] font-bold text-pay-text">
                    This cannot be undone.
                  </p>
                  <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                    Your profile will be marked deleted and shown as Deleted User.
                    Shared groups, expenses, settlements, and financial history stay
                    intact so other members keep their accounting records.
                  </p>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-pay-text uppercase tracking-widest mb-1.5 block">
                    Type DELETE to confirm
                  </label>
                  <input
                    value={deleteConfirm}
                    onChange={(event) => setDeleteConfirm(event.target.value)}
                    disabled={deleteSaving}
                    className="w-full border border-pay-100 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-pay-600/20 focus:border-pay-text transition-all bg-cream-card"
                    placeholder="DELETE"
                  />
                </div>
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirm !== "DELETE" || deleteSaving}
                  className="w-full py-2.5 rounded-xl bg-pay-600 text-white text-[12px] font-semibold disabled:opacity-30 flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all"
                >
                  <Trash2 size={13} />
                  {deleteSaving ? "Deleting..." : "Delete my account"}
                </button>
              </div>
            )}
          </div>
        )}

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
              <div className="w-9 h-9 rounded-xl bg-pay-50 flex items-center justify-center">
                <LogOut size={16} className="text-pay-text" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-pay-text">Logout</p>
                <p className="text-[11px] text-ink-500">{user.email}</p>
              </div>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-4 pb-2">
          <p className="text-[11px] text-ink-500">
            Made with ❤️ by Shalbandian
          </p>
        </div>
      </div>

    </main>
  );
}
