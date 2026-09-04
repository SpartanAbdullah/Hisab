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
  FileText,
  Bell,
  BellRing,
  Clock,
  Ban,
  BellOff,
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
import { TelemetryConsentToggle } from "../components/TelemetryConsentToggle";
import { FeedbackCard } from "../components/FeedbackCard";
import { useBlockStore } from "../stores/blockStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePersonStore } from "../stores/personStore";
import { useSubmitGuard } from "../lib/useSubmitGuard";
import { confirmDestructive } from "../components/ConfirmDestructiveSheet";
import { ManageCategoriesModal } from "../components/ManageCategoriesModal";
import { useThemeStore, type ThemeMode } from "../stores/themeStore";
import { useT, useI18nStore } from "../lib/i18n";
import { validatePassword, PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy";
import { exportAllData, importData, downloadJSON } from "../lib/dataExport";
import { profilesDb } from "../lib/supabaseDb";
import { supabase } from "../lib/supabase";
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

// Quiet hours are stored as whole local hours (0-23) per
// docs/notifications.md §3 — `notification_prefs.quiet_hours_start/_end`.
// The pickers are <input type="time">, which round-trips "HH:MM"; only the
// hour is kept, on the minute-precision-would-lie-about-what's-stored theory.
const DEFAULT_QUIET_START_HOUR = 22;
const DEFAULT_QUIET_END_HOUR = 7;

function hourToTimeInput(hour: number | null, fallback: number): string {
  const h = hour ?? fallback;
  return `${String(h).padStart(2, "0")}:00`;
}

function timeInputToHour(value: string): number | null {
  const match = /^(\d{1,2}):/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : null;
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

// Founder decision D1 (2026-09-04, supabase-migration-p3-account-deletion-
// balance-gate.sql): the same RPC also refuses while the caller has a non-zero
// net position in a shared group that still has a counterparty — the rule
// leave_group already applies. DETAIL is a server-composed English list
// ("Flatmates: owes AED 20.00; Trip: is owed PKR 1,500.00"), shown as
// supporting detail under localized copy, the GROUP_HAS_OUTSTANDING_BALANCES
// convention.
const UNSETTLED_BALANCES_MARKER = "UNSETTLED_GROUP_BALANCES";

function readUnsettledBalancesBlocker(error: unknown): { blocked: boolean; detail: string } {
  const parts: string[] = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    for (const key of ["message", "details", "hint", "code"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  if (!parts.join(" | ").includes(UNSETTLED_BALANCES_MARKER)) return { blocked: false, detail: "" };
  const details =
    error && typeof error === "object" && typeof (error as Record<string, unknown>).details === "string"
      ? ((error as Record<string, unknown>).details as string).trim()
      : "";
  return { blocked: true, detail: details.includes(UNSETTLED_BALANCES_MARKER) ? "" : details };
}

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
  // M5 quiet hours + real push opt-in (docs/notifications.md §8.2, audit N-6).
  // Quiet hours mirror `notification_prefs`' global row through the store;
  // both null (no window configured yet) shows the DEFAULT_QUIET_* fallback
  // in the pickers without writing anything until the user actually changes
  // one — a silent auto-write on first render would surprise a user who never
  // touched this screen.
  const quietHours = useNotificationStore((s) => s.quietHours);
  const loadNotificationPrefs = useNotificationStore((s) => s.loadPrefs);
  const setQuietHoursPref = useNotificationStore((s) => s.setQuietHours);
  const [quietHoursBusy, setQuietHoursBusy] = useState(false);
  // Global mute (docs/notifications.md §8.2) — the group_id-null prefs row.
  // Mode-agnostic like the rest of the notification system (§7): it reads
  // and writes the same global row regardless of full_tracker/splits_only.
  const globalMuted = useNotificationStore((s) => s.globalMuted);
  const setGlobalMutedPref = useNotificationStore((s) => s.setGlobalMuted);
  const [globalMuteBusy, setGlobalMuteBusy] = useState(false);
  // Push permission state — read straight off the Capacitor plugin (native
  // only) rather than duplicating registration logic; pushRegistration.ts
  // already owns the actual register/token flow.
  const [pushPermission, setPushPermission] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [pushBusy, setPushBusy] = useState(false);
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
  // Blocked people (audit M17). Names are resolved from local contacts where a
  // linked row exists; a block can outlive the contact row, so an unresolved id
  // renders as a neutral "Hisaab user" rather than a raw UUID.
  const blocks = useBlockStore((s) => s.blocks);
  const blocksLoading = useBlockStore((s) => s.loading);
  const loadBlocks = useBlockStore((s) => s.loadBlocks);
  const unblock = useBlockStore((s) => s.unblock);
  const persons = usePersonStore((s) => s.persons);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const unblockGuard = useSubmitGuard();
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

  // Blocked-people list + the contacts that give those ids names. Both stores
  // gate on their own freshness window, so this is cheap on a re-visit.
  useEffect(() => {
    void loadBlocks();
    void loadPersons().catch(() => {});
  }, [loadBlocks, loadPersons]);

  // Notification prefs (quiet hours) — best-effort, tolerates the M5
  // migration not being applied yet (loadPrefs swallows that itself).
  useEffect(() => {
    void loadNotificationPrefs();
  }, [loadNotificationPrefs]);

  // Current push permission, native only. Re-checked after the opt-in button
  // runs so the row reflects what the OS dialog actually decided.
  const refreshPushPermission = async () => {
    if (!isNativeRuntime()) return;
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const perm = await PushNotifications.checkPermissions();
      const receive = String(perm.receive);
      setPushPermission(receive === "granted" || receive === "denied" || receive === "prompt" ? receive : "unknown");
    } catch {
      setPushPermission("unknown");
    }
  };
  useEffect(() => {
    void refreshPushPermission();
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
      description: t('set_import_warn_body'),
      confirmLabel: t('set_import_cta'),
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
          // Brand name — identical in both languages, not a copy string.
          // eslint-disable-next-line no-restricted-syntax
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
      const unsettled = readUnsettledBalancesBlocker(error);
      if (owned.blocked) {
        toast.show({
          type: "error",
          title: t("del_account_owned_groups_title"),
          subtitle: owned.names
            ? t("del_account_owned_groups_body").replace("{names}", owned.names)
            : t("del_account_owned_groups_generic"),
        });
      } else if (unsettled.blocked) {
        // D1: the same rule as leaving a group — settle first. The server's
        // DETAIL already names each group with the direction and amount.
        toast.show({
          type: "error",
          title: t("del_account_unsettled_title"),
          subtitle: unsettled.detail
            ? t("del_account_unsettled_body").replace("{details}", unsettled.detail)
            : t("del_account_unsettled_generic"),
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

  // 3D clay tier 2, neutral: a settings group is informational chrome around
  // rows that are individually tappable — the group itself is not, so it is a
  // card, never a tile. `.clay-card` + `.clay-neutral` are the utility form of
  // <Card3D tint="neutral">; used as a class string here because this is a
  // shared className constant applied to ~15 <div>s, not a component call.
  // Radius stays 18px (between the tile's 16 and the card's 24) so the
  // Settings rhythm is unchanged, and overflow-hidden keeps the divided rows
  // clipped to it — safe, because no group here carries a floating icon.
  const sectionClass =
    "clay-card clay-neutral rounded-[18px] overflow-hidden divide-y divide-cream-hairline";
  const rowClass =
    "row-base row-interactive px-4 py-3.5";

  // A window is "on" only when both edges are set and distinct — matches the
  // server's own reading of the global row (docs/notifications.md §3: "Both
  // null, or equal, means no window").
  const quietHoursEnabled =
    quietHours.start !== null && quietHours.end !== null && quietHours.start !== quietHours.end;
  const quietHoursTz =
    quietHours.tz ||
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return "Asia/Karachi";
      }
    })();

  const blockedName = (profileId: string): string =>
    persons.find((p) => p.linkedProfileId === profileId)?.name ?? t('blk_unknown_person');

  const handleUnblock = (profileId: string) => unblockGuard.run(async () => {
    const name = blockedName(profileId);
    const ok = await confirmDestructive({
      title: t('blk_unblock_confirm_title').replace('{name}', name),
      description: t('blk_unblock_confirm_body'),
      confirmLabel: t('blk_action_unblock'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await unblock(profileId);
      toast.show({ type: 'success', title: t('blk_unblocked_toast').replace('{name}', name) });
    } catch {
      toast.show({ type: 'error', title: t('blk_failed') });
    }
  });

  const copyUserCode = async () => {
    if (!publicCode) return;
    try {
      await copyShareText(`@${publicCode}`);
      toast.show({ type: "success", title: t('set_code_copied') });
    } catch {
      toast.show({ type: "error", title: t('set_code_copy_failed') });
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
              {t('set_code_chip_label')}
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
                  <User size={10} /> {t('set_user_code_label')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={publicCode ? `@${publicCode}` : ""}
                    readOnly
                    placeholder={t('set_code_generating')}
                    className="flex-1 border border-cream-border rounded-xl px-4 py-3 text-[13px] bg-cream-soft text-ink-900"
                  />
                  <button
                    onClick={async () => {
                      if (!publicCode) return;
                      await navigator.clipboard.writeText(`@${publicCode}`);
                      toast.show({
                        type: "success",
                        title: t('set_code_copied'),
                      });
                    }}
                    disabled={!publicCode}
                    className="px-4 rounded-xl bg-accent-100 text-accent-600 text-[12px] font-semibold disabled:opacity-40"
                  >
                    {t('set_copy')}
                  </button>
                </div>
                <p className="text-[10px] text-ink-500 mt-1.5">
                  {t('set_code_help')}
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

        {/* Global mute — M5 (docs/notifications.md §8.2). Same server-side
            row as the per-group mute in GroupDetailPage, just group_id null:
            suppresses every `notifications` row (and therefore every push)
            for this user. The in-app Inbox / Activity feed are unaffected —
            copy below says so explicitly, same honesty rule as the per-group
            mute. Mode-agnostic like the rest of §3/§7. */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <BellOff size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">{t("settings_mute_all")}</p>
              <p className="text-[11px] text-ink-500">{t("settings_mute_all_desc")}</p>
            </div>
            <button
              disabled={globalMuteBusy}
              onClick={() => {
                void (async () => {
                  setGlobalMuteBusy(true);
                  try {
                    await setGlobalMutedPref(!globalMuted);
                  } catch {
                    toast.show({ type: "error", title: t("settings_mute_all_failed") });
                  } finally {
                    setGlobalMuteBusy(false);
                  }
                })();
              }}
              aria-pressed={globalMuted}
              aria-label={t("settings_mute_all")}
              className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-50 ${globalMuted ? "bg-receive-600" : "bg-cream-border"}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${globalMuted ? "left-6" : "left-1"}`} />
            </button>
          </div>
        </div>

        {/* Quiet hours — M5 (docs/notifications.md §8.2). Mode-agnostic and not
            native-only: it governs a server-side push delivery decision, so a
            web user can set it even though they'll never see the effect
            themselves. Mute suppresses the notifications row entirely; quiet
            hours only soften how a push rings — the in-app Inbox always gets
            every item regardless. */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
              <Clock size={16} className="text-accent-600" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-ink-900">{t("settings_quiet_hours")}</p>
              <p className="text-[11px] text-ink-500">{t("settings_quiet_hours_desc")}</p>
            </div>
            <button
              disabled={quietHoursBusy}
              onClick={() => {
                void (async () => {
                  setQuietHoursBusy(true);
                  try {
                    if (quietHoursEnabled) {
                      await setQuietHoursPref(null, null);
                    } else {
                      await setQuietHoursPref(DEFAULT_QUIET_START_HOUR, DEFAULT_QUIET_END_HOUR);
                    }
                  } catch {
                    toast.show({ type: "error", title: t("settings_quiet_hours_failed") });
                  } finally {
                    setQuietHoursBusy(false);
                  }
                })();
              }}
              aria-pressed={quietHoursEnabled}
              aria-label={t("settings_quiet_hours")}
              className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-50 ${quietHoursEnabled ? "bg-receive-600" : "bg-cream-border"}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${quietHoursEnabled ? "left-6" : "left-1"}`} />
            </button>
          </div>
          {quietHoursEnabled && (
            <div className={rowClass}>
              <div className="flex-1 flex items-center gap-3">
                <label className="flex-1">
                  <span className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-widest mb-1">
                    {t("settings_quiet_hours_start")}
                  </span>
                  <input
                    type="time"
                    step={3600}
                    disabled={quietHoursBusy}
                    value={hourToTimeInput(quietHours.start, DEFAULT_QUIET_START_HOUR)}
                    onChange={(e) => {
                      const hour = timeInputToHour(e.target.value);
                      if (hour === null) return;
                      void setQuietHoursPref(hour, quietHours.end ?? DEFAULT_QUIET_END_HOUR).catch(() =>
                        toast.show({ type: "error", title: t("settings_quiet_hours_failed") }),
                      );
                    }}
                    className="w-full bg-cream-soft border border-cream-border rounded-lg px-3 py-2 text-[13px] text-ink-900 outline-none focus:border-accent-500 disabled:opacity-50"
                  />
                </label>
                <label className="flex-1">
                  <span className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-widest mb-1">
                    {t("settings_quiet_hours_end")}
                  </span>
                  <input
                    type="time"
                    step={3600}
                    disabled={quietHoursBusy}
                    value={hourToTimeInput(quietHours.end, DEFAULT_QUIET_END_HOUR)}
                    onChange={(e) => {
                      const hour = timeInputToHour(e.target.value);
                      if (hour === null) return;
                      void setQuietHoursPref(quietHours.start ?? DEFAULT_QUIET_START_HOUR, hour).catch(() =>
                        toast.show({ type: "error", title: t("settings_quiet_hours_failed") }),
                      );
                    }}
                    className="w-full bg-cream-soft border border-cream-border rounded-lg px-3 py-2 text-[13px] text-ink-900 outline-none focus:border-accent-500 disabled:opacity-50"
                  />
                </label>
              </div>
            </div>
          )}
          {quietHoursEnabled && (
            <p className="px-4 pb-3.5 text-[10.5px] text-ink-400 leading-relaxed">
              {t("settings_quiet_hours_tz").replace("{tz}", quietHoursTz)}
            </p>
          )}
        </div>

        {/* Dedicated push opt-in — audit N-6: push used to be welded to the
            local-reminders toggle above with no way to enable one without the
            other. Native only; a PWA tab has no OS-level push channel here. */}
        {isNativeRuntime() && (
          <div className={sectionClass}>
            <div className={rowClass}>
              <div className="w-9 h-9 rounded-xl bg-accent-100 flex items-center justify-center">
                <BellRing size={16} className="text-accent-600" />
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-ink-900">{t("push_title")}</p>
                <p className="text-[11px] text-ink-500">{t("push_desc")}</p>
              </div>
              {pushPermission === "granted" ? (
                <span className="text-[10.5px] font-bold uppercase tracking-widest text-receive-text bg-receive-50 rounded-full px-2.5 py-1 shrink-0">
                  {t("push_status_on")}
                </span>
              ) : pushPermission === "denied" ? (
                <span className="text-[10.5px] font-bold uppercase tracking-widest text-pay-text bg-pay-50 rounded-full px-2.5 py-1 shrink-0">
                  {t("push_status_denied")}
                </span>
              ) : (
                <button
                  disabled={pushBusy}
                  onClick={() => {
                    void (async () => {
                      setPushBusy(true);
                      try {
                        await requestPushPermissionAndRegister((to) => navigate(to));
                        await refreshPushPermission();
                      } finally {
                        setPushBusy(false);
                      }
                    })();
                  }}
                  className="shrink-0 px-3.5 py-2 rounded-xl bg-ink-900 text-white text-[11.5px] font-bold disabled:opacity-50"
                >
                  {pushBusy ? t("cds_working") : t("push_enable_cta")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Phone discovery — opt-in, and the ONLY contact-matching Hisaab
            does. No address-book access anywhere in the app. */}
        <PhoneDiscoverySection sectionClass={sectionClass} rowClass={rowClass} />

        {/* Blocked people — audit M17. Users must be able to see and undo what
            they did; a block with no visible list is an action they can never
            take back. The blocked party can never read these rows. */}
        <div className={sectionClass}>
          <div className={rowClass}>
            <div className="w-9 h-9 rounded-xl bg-pay-50 flex items-center justify-center">
              <Ban size={16} className="text-pay-text" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-ink-900">{t('blk_list_title')}</p>
              <p className="text-[11px] text-ink-500">{t('blk_list_sub')}</p>
            </div>
          </div>
          {blocks.length === 0 ? (
            <p className="px-4 py-3.5 text-[11.5px] text-ink-500 leading-relaxed">
              {blocksLoading ? t('gdp_loading') : t('blk_list_empty')}
            </p>
          ) : (
            blocks.map((entry) => (
              <div key={entry.blockedId} className={rowClass}>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900 truncate">
                    {blockedName(entry.blockedId)}
                  </p>
                  <p className="text-[10.5px] text-ink-500 tabular-nums">
                    {t('blk_list_since').replace(
                      '{date}',
                      new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
                    )}
                  </p>
                  {entry.reason && (
                    <p className="text-[10.5px] text-ink-400 italic truncate">{entry.reason}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleUnblock(entry.blockedId)}
                  className="shrink-0 px-3 py-2 rounded-xl bg-cream-soft border border-cream-hairline text-ink-700 text-[11px] font-bold active:bg-cream-hairline transition-colors"
                >
                  {t('blk_action_unblock')}
                </button>
              </div>
            ))
          )}
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
                  {t('set_pin_cancel')}
                </button>
                <button
                  onClick={handleSetPin}
                  disabled={pin1.length !== 4 || pin2.length !== 4}
                  className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-30"
                >
                  {t('set_pin_save')}
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
                <p className="text-[13px] font-semibold text-ink-900">{t('set_row_budgets')}</p>
                <p className="text-[11px] text-ink-500">{t('set_row_budgets_sub')}</p>
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
                <p className="text-[13px] font-semibold text-ink-900">{t('set_row_subs')}</p>
                <p className="text-[11px] text-ink-500">{t('set_row_subs_sub')}</p>
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

        {/* Opt-in usage stats — device-level, default OFF, no free text and no
            amounts (audit report 10 §5.2). Self-contained card. */}
        <TelemetryConsentToggle />

        {/* Group header — About & legal */}
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-500 px-1 pt-2">
          {t('settings_grp_about')}
        </p>

        {/* Talk to us — the only in-app channel a confused-but-not-crashed
            user has (audit report 10, F3). Self-contained card. */}
        <FeedbackCard />

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
              <p className="text-[13px] font-semibold text-ink-900">{t('set_row_privacy')}</p>
              <p className="text-[11px] text-ink-500">{t('set_row_privacy_sub')}</p>
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
              <p className="text-[13px] font-semibold text-ink-900">{t('set_row_terms')}</p>
              <p className="text-[11px] text-ink-500">{t('set_row_terms_sub')}</p>
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
              <p className="text-[13px] font-semibold text-ink-900">{t('set_row_contact')}</p>
              <p className="text-[11px] text-ink-500">{t('set_row_contact_sub')}</p>
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
              <p className="text-[13px] font-semibold text-ink-900">{t('set_row_deletion')}</p>
              <p className="text-[11px] text-ink-500">{t('set_row_deletion_sub')}</p>
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
                  {t('set_delete_account')}
                </p>
                <p className="text-[11px] text-ink-500">
                  {t('set_delete_account_sub')}
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
                    {t('set_delete_irreversible')}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                    {t('set_delete_body')}
                  </p>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-pay-text uppercase tracking-widest mb-1.5 block">
                    {t('set_delete_type_label')}
                  </label>
                  <input
                    value={deleteConfirm}
                    onChange={(event) => setDeleteConfirm(event.target.value)}
                    disabled={deleteSaving}
                    className="w-full border border-pay-100 rounded-xl px-4 py-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-pay-600/20 focus:border-pay-text transition-all bg-cream-card"
                    placeholder={t('set_delete_placeholder')}
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
                <p className="text-[13px] font-semibold text-pay-text">{t('set_logout')}</p>
                <p className="text-[11px] text-ink-500">{user.email}</p>
              </div>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-4 pb-2">
          <p className="text-[11px] text-ink-500">
            {t('set_footer_credit')}
          </p>
        </div>
      </div>

      <ManageCategoriesModal open={showCategories} onClose={() => setShowCategories(false)} />
    </main>
  );
}
