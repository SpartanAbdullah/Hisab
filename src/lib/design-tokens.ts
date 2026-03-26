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

// ----- SHADOWS -----
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

// ----- SPACING -----
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

// ----- RADII -----
export const radii = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  full: '9999px',
} as const;

// ----- CURRENCY FLAGS -----
export const currencyFlags: Record<string, string> = {
  AED: '\u{1F1E6}\u{1F1EA}',
  PKR: '\u{1F1F5}\u{1F1F0}',
};

export const currencyMeta: Record<string, { flag: string; symbol: string; name: string }> = {
  AED: { flag: '\u{1F1E6}\u{1F1EA}', symbol: 'AED', name: 'UAE Dirham' },
  PKR: { flag: '\u{1F1F5}\u{1F1F0}', symbol: '\u20A8', name: 'Pakistani Rupee' },
};
