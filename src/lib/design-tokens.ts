// ============================================
// HISAAB DESIGN TOKEN SYSTEM
// Premium micro-SaaS fintech design language
// ============================================

// ----- SEMANTIC COLORS -----
export const colors = {
  // Primary brand
  brand: {
    50: '#eef2ff',
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
  },

  // Semantic: Money In / Success
  income: {
    light: '#ecfdf5',
    base: '#10b981',
    dark: '#059669',
    gradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  },

  // Semantic: Money Out / Danger
  expense: {
    light: '#fef2f2',
    base: '#ef4444',
    dark: '#dc2626',
    gradient: 'linear-gradient(135deg, #f87171 0%, #ef4444 100%)',
  },

  // Semantic: Loan Given / Info
  given: {
    light: '#eff6ff',
    base: '#3b82f6',
    dark: '#2563eb',
    gradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
  },

  // Semantic: Loan Taken / Warning
  taken: {
    light: '#fffbeb',
    base: '#f59e0b',
    dark: '#d97706',
    gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
  },

  // Semantic: Savings / Goals
  savings: {
    light: '#faf5ff',
    base: '#a855f7',
    dark: '#9333ea',
    gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)',
  },

  // Neutral
  surface: {
    0: '#ffffff',
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },
} as const;

// ----- GRADIENTS -----
export const gradients = {
  brand: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 50%, #4338ca 100%)',
  brandSoft: 'linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%)',
  income: 'linear-gradient(135deg, #34d399 0%, #10b981 50%, #059669 100%)',
  expense: 'linear-gradient(135deg, #fca5a5 0%, #f87171 50%, #ef4444 100%)',
  given: 'linear-gradient(135deg, #93c5fd 0%, #60a5fa 50%, #3b82f6 100%)',
  taken: 'linear-gradient(135deg, #fcd34d 0%, #fbbf24 50%, #f59e0b 100%)',
  savings: 'linear-gradient(135deg, #d8b4fe 0%, #c084fc 50%, #a855f7 100%)',
  dark: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
  glass: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.7) 100%)',
  mesh: 'radial-gradient(at 40% 20%, rgba(99,102,241,0.08) 0%, transparent 50%), radial-gradient(at 80% 80%, rgba(168,85,247,0.06) 0%, transparent 50%)',
} as const;

// ----- SHADOW HIERARCHY -----
// Use by role, not aesthetics. Each step communicates how "present" the
// surface is in the visual stack.
//
//   xs          → hint banners, flat chips, depressed states
//   sm          → default card elevation (.card-premium baseline)
//   md          → primary CTAs with brand tint, slightly lifted cards
//   lg          → floating elements (hover-lift on primary CTAs, FAB hover)
//   xl          → rare; reserved for modal containers / overlays
//   glow.*      → focus/emphasis moments; NOT for default state
//   card / cardHover → explicit pairing for interactive surfaces
//   float       → fixed elements that float over content (FAB)
//
// When adding a shadow to a new element, pick the smallest step that
// clearly reads. Climbing the ladder for "just in case" stack pollution.
export const shadows = {
  xs: '0 1px 2px rgba(0,0,0,0.04)',
  sm: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
  md: '0 4px 6px -1px rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04)',
  lg: '0 10px 15px -3px rgba(0,0,0,0.06), 0 4px 6px -4px rgba(0,0,0,0.04)',
  xl: '0 20px 25px -5px rgba(0,0,0,0.06), 0 8px 10px -6px rgba(0,0,0,0.04)',
  glow: {
    brand: '0 0 20px rgba(99,102,241,0.25)',
    income: '0 0 20px rgba(16,185,129,0.25)',
    expense: '0 0 20px rgba(239,68,68,0.2)',
    savings: '0 0 20px rgba(168,85,247,0.25)',
  },
  card: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)',
  cardHover: '0 2px 8px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)',
  float: '0 8px 30px rgba(0,0,0,0.08)',
} as const;

// ----- SPACING SCALE -----
// Use by role, not feel. A mobile screen rarely needs anything above `2xl`.
//
//   xs   4px   → icon inner padding, chip paddings, hair gaps
//   sm   8px   → tight gaps between related rows, inside list rows (gap-2)
//   md  12px   → compact card padding, modal footer action gaps (p-3, gap-3)
//   lg  16px   → CANONICAL card/input/button padding (p-4, py-4)
//   xl  20px   → section gaps, generous empty-state padding (p-5)
//   2xl 24px   → page top spacing before first content block (pt-6)
//   3xl 32px   → rare; between distinct page blocks
//   4xl/5xl    → reserved; avoid on mobile unless explicitly justified
export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  '3xl': '32px',
  '4xl': '40px',
  '5xl': '48px',
} as const;

// ----- PAGE SPACING RHYTHM -----
// Per-page top padding (`pt-*`) for the first content wrapper that sits
// immediately below `<PageHeader>`. Pick by content type, not feel. All
// three live alongside canonical `px-5` horizontal padding.
//
//   pt-4  (16px)  → SCROLL-DENSE pages where many rows or chart sections
//                    stack tightly and breathing room hurts.
//                    Canonical call sites: TransactionsPage, AnalyticsPage.
//
//   pt-5  (20px)  → CANONICAL list pages — settings, goals, inbox, splits.
//                    Default choice when no other rule applies.
//                    Canonical call sites: SettingsPage, InboxPage, GoalsPage,
//                    LoansPage, SplitsPage, ContactsModal pages.
//
//   pt-6  (24px)  → HERO-PREFACED pages whose first content block is a large
//                    premium card (gradient hero, progress ring, avatar).
//                    The extra 4px prevents the hero from feeling crowded
//                    under the sticky header.
//                    Canonical call sites: GroupDetailPage, LoanDetailPage.
//
// New pages: default to `pt-5`. Only deviate with explicit justification.

// ----- RADIUS LADDER -----
// Mobile-first. Most cards should round at `lg`; sharper corners (≤ md)
// belong on dense inline chips; softer ones (xl+) on premium surfaces.
//
//   sm   8px   → chips, pills, small round things
//   md  12px   → icon containers, tight inline error hints (.state-hint-error)
//   lg  16px   → CANONICAL card/input/button radius (rounded-2xl)
//   xl  20px   → premium cards (AccountCard, .card-premium baseline)
//   2xl 24px   → legacy (old ActionCard); avoid for new surfaces
//   full       → avatars, badges, unread dots
export const radii = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  full: '9999px',
} as const;

// ----- ICON SIZE LADDER (container × glyph) -----
// Four named tiers. Pick by role, not aesthetics. The container radius
// usually follows the radius ladder at `md` or `lg` depending on chip
// vs card context.
//
//   Tier   Size    Role                            Canonical call sites
//   ────   ─────   ──────────────────────────────  ────────────────────────────
//   nav    32×14   Nav / header icon buttons       .nav-icon-button
//                  empty-state micro-row icons     (PageHeader back, Modal X,
//                                                   GroupsEducationCard rows)
//
//   tight  36×16   Tight list rows / compact       Inbox card leading dots,
//                  dense row layouts               modal row chips
//
//   std    40×18   CANONICAL row / tile icon       ActionCard chip, Settings
//                                                   row icons, Contacts avatars
//
//   card   44×20   Premium card icons / avatars    AccountCard chip, linked-loan
//                  (44px) or hero avatars (48×22)   hero avatars, ContactDetailSheet
//                                                   header avatar
//
// Avoid w-9 (36) for surfaces that aren't explicitly dense rows — bias
// toward `std` (40) for standard navigation list rows.
//
// This ladder is documentation-only; runtime values live in component
// classes (w-8 / w-9 / w-10 / w-11 / w-12).

// ----- ANIMATION TIMING CONVENTIONS -----
// Three timing curves coexist by role. Pick by what's animating, not by
// habit. Runtime differences are subtle but the consistency matters on
// careful inspection.
//
//   DEFAULT (Tailwind)       cubic-bezier(0.4, 0, 0.2, 1)
//     → Use for inputs, rows, chips, nav, tap-state bg flashes, and
//       anything that flows smoothly between states in place.
//     → Canonical tokens: .input-field, .row-interactive, .selector-base,
//       .chip-base, .nav-icon-button, .modal-backdrop, .cta-secondary,
//       .cta-destructive.
//
//   ELEVATED (expo ease-out)  cubic-bezier(0.16, 1, 0.3, 1)
//     → Use for elements that LIFT into view — cards settling, sheets
//       sliding up, elevated surfaces reacting. Snappier deceleration
//       communicates "premium weight."
//     → Canonical tokens: .card-premium, .card-base, .card-interactive,
//       .modal-sheet (slide-up), animate-slide-up, animate-scale-in.
//
//   LEGACY (ease)             cubic-bezier(0.25, 0.1, 0.25, 1)  -- AVOID
//     → Still present inside .btn-gradient and .cta-primary because those
//       were extracted from pre-token inline patterns. DO NOT reach for
//       `ease` on new tokens; pick DEFAULT or ELEVATED by role.
//
// Durations: 150ms for tap-state flashes, 200ms for card settles, 300ms
// for backdrop fades, 350ms for sheet slides. Stick to these four.

// ----- CURRENCY FLAGS -----
export const currencyFlags: Record<string, string> = {
  AED: '\u{1F1E6}\u{1F1EA}',
  PKR: '\u{1F1F5}\u{1F1F0}',
};

export const currencyMeta: Record<string, { flag: string; symbol: string; name: string }> = {
  AED: { flag: '\u{1F1E6}\u{1F1EA}', symbol: 'AED', name: 'UAE Dirham' },
  PKR: { flag: '\u{1F1F5}\u{1F1F0}', symbol: '\u20A8', name: 'Pakistani Rupee' },
};
