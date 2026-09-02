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
  Wallet2,
  Repeat,
  Tags,
  Moon,
  Coins,
  Lightbulb,
  Database,
  RefreshCw,
  FileText,
  Bell,
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
import { isNativeRuntime } from "../lib/runtime";
import { enableRemindersFlow, remindersEnabled, rescheduleNotifications, REMINDERS_KEY } from "../lib/notificationScheduler";
import { requestPushPermissionAndRegister } from "../lib/pushRegistration";
import { PhoneDiscoverySection } from "../components/PhoneDiscoverySection";
import { confirmDestructive } from "../components/ConfirmDestructiveSheet";
import { ManageCategoriesModal } from "../components/ManageCategoriesModal";
import { useThemeStore, type ThemeMode } from "../stores/themeStore";
import { useT, useI18nStore, type I18nKey } from "../lib/i18n";
import { validatePassword, PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy";
import { exportAllData, importData, downloadJSON } from "../lib/dataExport";
import { profilesDb } from "../lib/supabaseDb";
import { supabase } from "../lib/supabase";
import { db } from "../db";
import {
  getCoreMirrorSyncSnapshots,
  type MirrorSyncSnapshot,
} from "../lib/mirrorCache";
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

// Audit C2 (client half): `delete_current_user` refuses to run when the caller
// still owns groups that have other members, RAISEing with this marker and a
// detail listing the group names. Without mapping, the user sees a raw Postgres
// string. Everything the driver gives us is searched — PostgrestError splits the
// RAISE across message/details/hint depending on how it was thrown.
const OWNED_GROUPS_MARKER = "OWNED_GROUPS_WITH_MEMBERS";

function readOwnedGroupsBlocker(error: unknown): { blocked: boolean; names: string } {
  const parts: string[] = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    for (const key of ["message", "details", "hint", "code"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  const blob = parts.join(" | ");
  const at = blob.indexOf(OWNED_GROUPS_MARKER);
  if (at === -1) return { blocked: false, names: "" };
  // The RPC raises the marker as the message and puts the comma-separated
  // group names in DETAIL (PostgrestError.details). Fall back to whatever
  // trails the marker in the same fragment for other transports.
  const trailing = blob
    .slice(at + OWNED_GROUPS_MARKER.length)
    .split(" | ")[0]
    .replace(/^[\s:;,—–-]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  const details =
    error && typeof error === "object" && typeof (error as Record<string, unknown>).details === "string"
      ? ((error as Record<string, unknown>).details as string).trim()
      : "";
  const names = trailing || (details.includes(OWNED_GROUPS_MARKER) || /joined one of your groups/i.test(details) ? "" : details);
  return { blocked: true, names };
}

// Audit UX-09: the whole Sync Status card is gated behind VITE_ENABLE_OUTBOX,
// the same flag that gates the outbox runner (src/lib/outboxRunner.ts:29). The
// outbox is inert in shipping builds — stores are only partially rewired to it
// — so a card headlined "Queued offline changes: 0" told users offline queueing
// existed and their unsent edits were safe. It is not deleted, only hidden, so
// it returns the day the outbox actually ships.
const OUTBOX_UI_ENABLED = import.meta.env.VITE_ENABLE_OUTBOX === "true";

const SYNC_LABEL_KEYS: Record<MirrorSyncSnapshot["key"], I18nKey> = {
  accounts: "sync_tbl_accounts",
  transactions: "sync_tbl_transactions",
  loans: "sync_tbl_loans",
  budgets: "sync_tbl_budgets",
};

function SyncStatusRow({ snapshot }: { snapshot: MirrorSyncSnapshot }) {
  const t = useT();
  // i18n'd here rather than in a module-level helper: the old formatSyncTime
  // returned hardcoded "Not synced yet" / "Unknown" strings.
  const formatSyncTime = (value: string | null): string => {
    if (!value) return t("sync_never");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("sync_unknown");
    return date.toLocaleString([], {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-ink-800">
          {t(SYNC_LABEL_KEYS[snapshot.key])}
        </p>
        <p className="text-[10px] text-ink-400 mt-0.5">
          {t("sync_full_refresh")}: {formatSyncTime(snapshot.lastFullRefreshAt)}
        </p>
      </div>
      <p className={`text-[10.5px] font-semibold text-right tabular-nums ${snapshot.lastSyncedAt ? "text-receive-text" : "text-ink-400"}`}>
        {formatSyncTime(snapshot.lastSyncedAt)}
      </p>
    </div>
  );
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
  const [showCategories, setShowCategories] = useState(false);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const [dailyQuoteOn, setDailyQuoteOn] = useState(() => localStorage.getItem("hisaab_daily_quote_enabled") !== "false");
  // Payment reminders (Android local notifications). Native-only surface;
  // the toggle drives REMINDERS_KEY and the permission flow.
  const [remindersOn, setRemindersOn] = useState(() => remindersEnabled());
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [email] = useState(
    () => user?.email ?? localStorage.getItem("hisaab_email") ?? "",
  );
  const [mobile, setMobile] = useState(
    () => localStorage.getItem("hisaab_mobile") ?? "",
  );
  const [newPassword, setNewPassword] = useState("");
  // Re-auth (audit SEC-12): both the password change and the account deletion
  // now demand the CURRENT password. Separate fields so neither flow leaks the
  // other's typed secret into a form the user didn't intend to submit.
  const [currentPassword, setCurrentPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [publicCode, setPublicCode] = useState("");
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [syncSnapshots, setSyncSnapshots] = useState<MirrorSyncSnapshot[]>([]);
  const [syncStatusLoading, setSyncStatusLoading] = useState(true);
  const [outboxCount, setOutboxCount] = useState(0);
  const userName = localStorage.getItem("hisaab_user_name") ?? "";

  const loadSyncStatus = async () => {
    setSyncStatusLoading(true);
    try {
      const [snapshots, queuedCount] = await Promise.all([
        getCoreMirrorSyncSnapshots(),
        db.outbox.count(),
      ]);
      setSyncSnapshots(snapshots);
      setOutboxCount(queuedCount);
    } catch {
      setSyncSnapshots([]);
      setOutboxCount(0);
    } finally {
      setSyncStatusLoading(false);
    }
  };

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

  useEffect(() => {
    // No card, no query: skip the mirror reads and the outbox count entirely
    // while the Sync Status card is hidden (audit UX-09).
    if (!OUTBOX_UI_ENABLED) return;
    void loadSyncStatus();
  }, []);

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
    const ok = await confirmDestructive({
      title: t("settings_import_warn"),
      description: 'Existing data may be overwritten by the imported file.',
      confirmLabel: 'Import',
      tone: 'warning',
    });
    if (!ok) {
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
        // Audit M8: importData now validates the file before touching a row,
        // so the reason is a localised key ("nothing was deleted") rather than
        // a raw Postgres/JSON error string.
        toast.show({
          type: "error",
          title: t("settings_import_fail"),
          subtitle: t(result.messageKey),
          duration: 7000,
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
    try {
      await setPin(pin1);
    } catch {
      // WebCrypto missing (insecure origin / ancient WebView) — say so instead
      // of claiming a PIN was set, which is the exact false promise the audit
      // flagged in the first place.
      toast.show({ type: "error", title: t("pin_set_failed") });
      return;
    }
    toast.show({ type: "success", title: t("pin_set_success") });
    setShowPinSetup(false);
    setPin1("");
    setPin2("");
  };

  const handleRemovePin = async () => {
    const ok = await confirmDestructive({
      title: t("pin_remove_confirm_title"),
      description: t("pin_remove_confirm_body"),
      confirmLabel: t("pin_remove_confirm_cta"),
      cancelLabel: t("cancel"),
      tone: "warning",
    });
    if (!ok) return;
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

  // Proof-of-identity for the two irreversible actions on this page. With only
  // the anon key, re-signing in with the session's own email is the way to
  // check a password; it mints a fresh session for the SAME user, so nothing
  // else in the app is disturbed. (audit SEC-12 / M2)
  const verifyCurrentPassword = async (
    password: string,
  ): Promise<{ ok: boolean; message: string }> => {
    if (!email) return { ok: false, message: t("reauth_check_failed") };
    if (!password) return { ok: false, message: t("reauth_required") };
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return { ok: true, message: "" };
      const text = (error.message ?? "").toLowerCase();
      const wrongPassword =
        error.status === 400 ||
        text.includes("invalid login") ||
        text.includes("credential");
      return {
        ok: false,
        message: wrongPassword ? t("reauth_wrong_password") : t("reauth_check_failed"),
      };
    } catch {
      return { ok: false, message: t("reauth_check_failed") };
    }
  };

  const handlePasswordReset = async () => {
    const policy = validatePassword(newPassword);
    if (!policy.valid) {
      toast.show({
        type: "error",
        title: policy.code === "too_short"
          ? t("password_too_short")
          : t("password_missing_complexity"),
      });
      return;
    }
    setPasswordSaving(true);
    try {
      const reauth = await verifyCurrentPassword(currentPassword);
      if (!reauth.ok) {
        toast.show({ type: "error", title: reauth.message });
        return;
      }
      const { changePassword } = useSupabaseAuthStore.getState();
      await changePassword(newPassword);
      toast.show({ type: "success", title: t("password_updated") });
      setNewPassword("");
      setCurrentPassword("");
      setShowPasswordChange(false);
    } catch {
      toast.show({ type: "error", title: t("password_update_failed") });
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "DELETE") return;
    setDeleteSaving(true);
    try {
      const reauth = await verifyCurrentPassword(deletePassword);
      if (!reauth.ok) {
        toast.show({ type: "error", title: reauth.message });
        setDeleteSaving(false);
        return;
      }
      await deleteAccount();
      window.location.assign("/");
    } catch (error) {
      // The RPC refuses while the user still owns groups with other members —
      // deleting them would strand everyone else's shared ledger. Tell them
      // exactly which groups, and what to do about it.
      const owned = readOwnedGroupsBlocker(error);
      if (owned.blocked) {
        toast.show({
          type: "error",
          title: t("del_account_owned_groups_title"),
          subtitle: owned.names
            ? t("del_account_owned_groups_body").replace("{names}", owned.names)
            : t("del_account_owned_groups_generic"),
        });
      } else {
        toast.show({
          type: "error",
          title: t("del_account_failed"),
          subtitle: error instanceof Error ? error.message : t("del_account_retry"),
        });
      }
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
        {/* Group header — Account & security. Lightweight visual chunking only;
            no behaviour change. */}
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-500 px-1 pt-1">
          {t('settings_grp_account')}
        </p>

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
              {showPasswordChange && (() => {
                const policy = validatePassword(newPassword);
                return (
                  <div className="space-y-2 animate-fade-in bg-accent-50 rounded-xl p-3 border border-cream-border">
                    {/* Re-auth: the current password must be proven before the
                        new one is accepted (audit SEC-12). */}
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder={t("reauth_current_password")}
                      className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all bg-cream-card"
                    />
                    <p className="text-[10.5px] text-ink-500 leading-relaxed">
                      {t("reauth_why")}
                    </p>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={`New password (min ${PASSWORD_MIN_LENGTH} chars)`}
                      className="w-full border border-cream-border rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all bg-cream-card"
                    />
                    <p className={`text-[10.5px] leading-relaxed ${
                      newPassword.length === 0 ? 'text-ink-500'
                      : policy.valid ? 'text-receive-text font-semibold'
                      : 'text-pay-text font-semibold'
                    }`}>
                      {newPassword.length === 0
                        ? t('password_hint_12')
                        : policy.code === 'too_short'
                          ? t('password_too_short')
                          : policy.code === 'missing_complexity'
                            ? t('password_missing_complexity')
                            : t('password_hint_12')}
                    </p>
                    <button
                      onClick={handlePasswordReset}
                      disabled={passwordSaving || !policy.valid || !currentPassword}
                      className="w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30"
                    >
                      {passwordSaving ? "Updating..." : "Update Password"}
                    </button>
                  </div>
                );
              })()}
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

        {/* Appearance */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Moon size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">{t("settings_appearance")}</p>
              <p className="text-[11px] text-ink-500">{t("settings_appearance_desc")}</p>
            </div>
          </div>
          <div className="p-4 pt-0 flex gap-2">
            {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setThemeMode(m)}
                className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold transition-all ${themeMode === m ? "bg-ink-900 text-white" : "bg-cream-soft text-ink-500"}`}
              >
                {m === "light" ? t("theme_light") : m === "dark" ? t("theme_dark") : t("theme_system")}
              </button>
            ))}
          </div>
        </div>

        {/* Daily money wisdom */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Lightbulb size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">{t("settings_daily_quote")}</p>
              <p className="text-[11px] text-ink-500">{t("settings_daily_quote_desc")}</p>
            </div>
            <button
              onClick={() => {
                const next = !dailyQuoteOn;
                setDailyQuoteOn(next);
                localStorage.setItem("hisaab_daily_quote_enabled", next ? "true" : "false");
              }}
              aria-pressed={dailyQuoteOn}
              aria-label={t("settings_daily_quote")}
              className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${dailyQuoteOn ? "bg-receive-600" : "bg-cream-border"}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${dailyQuoteOn ? "left-6" : "left-1"}`} />
            </button>
          </div>
        </div>

        {/* Payment reminders — Android local notifications, derived from
            live state (a paid bill never rings). Native-only surface. */}
        {isNativeRuntime() && (
          <div className={sectionClass}>
            <div className={rowClass}>
              <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
                <Bell size={16} className="text-accent-600" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-ink-900">{t("settings_reminders")}</p>
                <p className="text-[11px] text-ink-500">{t("settings_reminders_desc")}</p>
              </div>
              <button
                disabled={remindersBusy}
                onClick={() => {
                  void (async () => {
                    setRemindersBusy(true);
                    try {
                      const next = !remindersOn;
                      if (next) {
                        // The flow OWNS the REMINDERS_KEY write (it must be
                        // true before its internal reschedule runs, or that
                        // run schedules nothing) — we only mirror the result.
                        const enabled = await enableRemindersFlow();
                        setRemindersOn(enabled);
                        if (!enabled) {
                          toast.show({ type: "error", title: t("settings_reminders_denied") });
                        } else {
                          // Android 13+ has ONE notification permission for
                          // the whole app, so the moment the user grants it
                          // here we also register for push. Asking twice for
                          // the same grant is how apps train people to deny.
                          void requestPushPermissionAndRegister((to) => navigate(to));
                        }
                      } else {
                        try {
                          localStorage.setItem(REMINDERS_KEY, "false");
                        } catch { /* storage off */ }
                        setRemindersOn(false);
                        // Cancels everything pending immediately.
                        await rescheduleNotifications({ force: true });
                      }
                    } finally {
                      setRemindersBusy(false);
                    }
                  })();
                }}
                aria-pressed={remindersOn}
                aria-label={t("settings_reminders")}
                className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-50 ${remindersOn ? "bg-receive-600" : "bg-cream-border"}`}
              >
                <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${remindersOn ? "left-6" : "left-1"}`} />
              </button>
            </div>
          </div>
        )}

        {/* Phone discovery — opt-in, and the ONLY contact-matching Hisaab
            does. No address-book access anywhere in the app. */}
        <PhoneDiscoverySection sectionClass={sectionClass} rowClass={rowClass} />

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

        {/* Group header — Your money */}
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-500 px-1 pt-2">
          {t('settings_grp_money')}
        </p>

        {/* Phase 3: Money tools — only meaningful in full_tracker mode.
            Each row deep-links to the matching feature page. */}
        {mode === 'full_tracker' && (
          <div className={sectionClass}>
            <button
              onClick={() => navigate('/budgets')}
              className={rowClass + " w-full text-left"}
            >
              <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center">
                <Wallet2 size={16} className="text-receive-text" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-ink-900">Budgets</p>
                <p className="text-[11px] text-ink-500">Monthly caps per category, soft warnings</p>
              </div>
              <ChevronRight size={16} className="text-ink-300" />
            </button>
            <button
              onClick={() => navigate('/subscriptions')}
              className={rowClass + " w-full text-left"}
            >
              <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
                <Repeat size={16} className="text-accent-600" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-ink-900">Subscription Tracker</p>
                <p className="text-[11px] text-ink-500">Subscriptions, salary, rent, EMIs — all recurring</p>
              </div>
              <ChevronRight size={16} className="text-ink-300" />
            </button>
            <button
              onClick={() => setShowCategories(true)}
              className={rowClass + " w-full text-left"}
            >
              <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center">
                <Tags size={16} className="text-receive-text" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-ink-900">{t('cat_manage_row')}</p>
                <p className="text-[11px] text-ink-500">{t('cat_manage_sub')}</p>
              </div>
              <ChevronRight size={16} className="text-ink-300" />
            </button>
          </div>
        )}

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
            onClick={() => navigate('/kameti')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center">
              <Coins size={16} className="text-receive-text" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">{t('kameti_title')}</p>
              <p className="text-[11px] text-ink-500">{t('kameti_tile_desc')}</p>
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

        {/* Group header — Data & backup */}
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-500 px-1 pt-2">
          {t('settings_grp_data')}
        </p>

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

        {/* Sync Status — audit UX-09. Hidden unless VITE_ENABLE_OUTBOX is on,
            because "Queued offline changes: 0" is a promise the inert outbox
            cannot keep. Kept (not deleted) so it returns with the feature. */}
        {OUTBOX_UI_ENABLED && (
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-info-50 flex items-center justify-center">
              <Database size={16} className="text-info-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-ink-900">
                {t("sync_title")}
              </p>
              <p className="text-[11px] text-ink-500">
                {syncStatusLoading
                  ? t("sync_checking")
                  : outboxCount > 0
                    ? outboxCount === 1
                      ? t("sync_queued_one")
                      : t("sync_queued_n").replace("{n}", String(outboxCount))
                    : t("sync_ready")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadSyncStatus()}
              disabled={syncStatusLoading}
              aria-label={t("sync_refresh_aria")}
              className="nav-icon-button shrink-0 disabled:opacity-40"
            >
              <RefreshCw size={14} className={`text-ink-500 ${syncStatusLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="px-4 py-3 space-y-2.5">
            {syncSnapshots.length === 0 && !syncStatusLoading ? (
              <p className="text-[11px] text-ink-500 leading-relaxed">
                {t("sync_empty")}
              </p>
            ) : (
              syncSnapshots.map((snapshot) => (
                <SyncStatusRow key={snapshot.key} snapshot={snapshot} />
              ))
            )}
            <div className="pt-2 border-t border-cream-hairline flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold text-ink-700">{t("sync_queued_label")}</p>
              <span className={`text-[11px] font-semibold tabular-nums ${outboxCount > 0 ? "text-warn-600" : "text-receive-text"}`}>
                {outboxCount}
              </span>
            </div>
          </div>
        </div>
        )}

        {/* Group header — About & legal */}
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-500 px-1 pt-2">
          {t('settings_grp_about')}
        </p>

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

        {/* Trust — the security/philosophy work translated into human
            sentences, plus the business-model-as-feature answer to
            "why is this free?". Plain-speech, both languages. */}
        <div className={sectionClass}>
          <div className="px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-900 mb-2.5">{t('trust_title')}</p>
            <div className="space-y-2">
              {[t('trust_line_1'), t('trust_line_2'), t('trust_line_3'), t('trust_line_4')].map((line) => (
                <div key={line} className="flex items-start gap-2.5">
                  <span className="text-receive-text text-[12px] mt-px shrink-0">✓</span>
                  <p className="text-[12px] text-ink-700 leading-relaxed">{line}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-900 mb-1">{t('trust_why_free_title')}</p>
            <p className="text-[12px] text-ink-600 leading-relaxed">{t('trust_why_free_body')}</p>
          </div>
        </div>

        {/* Legal and support */}
        <div className={sectionClass}>
          <button
            onClick={() => navigate('/privacy')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-info-50 flex items-center justify-center">
              <Shield size={16} className="text-info-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">Privacy Policy</p>
              <p className="text-[11px] text-ink-500">How Hisaab handles your data</p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
          <button
            onClick={() => navigate('/terms')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-cream-soft flex items-center justify-center">
              <FileText size={16} className="text-ink-500" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">Terms of Use</p>
              <p className="text-[11px] text-ink-500">Early-release service terms</p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
          <button
            onClick={() => navigate('/contact')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-receive-50 flex items-center justify-center">
              <Mail size={16} className="text-receive-text" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">Contact & Support</p>
              <p className="text-[11px] text-ink-500">Privacy, deletion, and bug reports</p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
          <button
            onClick={() => navigate('/delete-account')}
            className={rowClass + " w-full text-left"}
          >
            <div className="w-9 h-9 rounded-xl bg-pay-50 flex items-center justify-center">
              <Trash2 size={16} className="text-pay-text" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">Deletion Instructions</p>
              <p className="text-[11px] text-ink-500">How to delete your Hisaab account</p>
            </div>
            <ChevronRight size={16} className="text-ink-300" />
          </button>
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
                  Permanently delete your Hisaab account
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
                    Your login identity and personal finance records will be deleted.
                    Shared groups or records you created may be removed or adjusted.
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
                {/* Re-auth: irreversible destruction of years of khata history
                    must not be one tap away on an unlocked phone (SEC-12). */}
                <div>
                  <label className="text-[10px] font-bold text-pay-text uppercase tracking-widest mb-1.5 block">
                    {t("reauth_current_password")}
                  </label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                    disabled={deleteSaving}
                    className="w-full border border-pay-100 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-pay-600/20 focus:border-pay-text transition-all bg-cream-card"
                    placeholder={t("reauth_current_password")}
                  />
                  <p className="text-[10.5px] text-ink-500 mt-1.5 leading-relaxed">
                    {t("reauth_why")}
                  </p>
                </div>
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirm !== "DELETE" || !deletePassword || deleteSaving}
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
                const ok = await confirmDestructive({
                  title: t("logout_confirm_title"),
                  description: t("logout_confirm_body"),
                  confirmLabel: t("logout_confirm_yes"),
                  tone: "warning",
                });
                if (!ok) return;
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
            Hisaab by Muhammad Abdullah
          </p>
        </div>
      </div>

      <ManageCategoriesModal open={showCategories} onClose={() => setShowCategories(false)} />
    </main>
  );
}
