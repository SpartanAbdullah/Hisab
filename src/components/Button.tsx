import { Loader2 } from 'lucide-react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT_CLASSES;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  /**
   * Opt into the clay depth treatment: a soft, large-radius ambient shadow
   * tinted with the button's own fill, which pulls in as the button scales to
   * 0.985 on press. Off by default — every existing call site keeps the exact
   * class string it had before.
   *
   * (v1 of this prop painted a 3px solid bottom LIP instead. It was removed
   * on founder feedback, 2026-09-03 — see index.css's "3D CLAY" header.)
   *
   * Only the four solid variants get it (see BUTTON_DEPTH_CLASSES); `ghost`
   * ignores it, because a coloured shadow under a transparent fill is a halo
   * around nothing, and `gradient` already paints its own pressed-overlay
   * state via `.btn-gradient`.
   */
  depth?: boolean;
  children: React.ReactNode;
}

// Co-located variant map. Could be moved to a styles file to make Fast
// Refresh stricter, but it's a 6-key Tailwind lookup table tightly bound
// to the Button component's props — not worth a separate file.
// eslint-disable-next-line react-refresh/only-export-components
export const BUTTON_VARIANT_CLASSES = {
  // House accent (violet), not legacy indigo — matches the dominant
  // primary-button fill used elsewhere (HomePage quick actions,
  // LoansPage repay CTA, SettleUpModal toggle, .auth-cta). No accent-700
  // exists for an active:bg-* darken step, so press feedback follows the
  // same idiom as .auth-cta: active:brightness-95 alongside the shared
  // active:scale-[0.97] on the base className below.
  primary: 'bg-accent-600 text-white shadow-sm shadow-accent-600/20 active:brightness-95 active:shadow-none focus-visible:ring-accent-500',
  secondary: 'bg-slate-100 border border-slate-200 text-slate-700 active:bg-slate-200 focus-visible:ring-slate-400',
  danger: 'bg-pay-600 text-white shadow-sm shadow-pay-600/20 active:bg-pay-700 focus-visible:ring-pay-600',
  warning: 'bg-warn-600 text-white shadow-sm shadow-warn-600/20 active:bg-warn-600 focus-visible:ring-warn-600',
  ghost: 'bg-transparent text-accent-600 active:bg-accent-50 focus-visible:ring-accent-500',
  // Left on the legacy indigo gradient deliberately: it composes with the
  // `.btn-gradient` CSS class (index.css), whose background is a hardcoded
  // indigo linear-gradient value — out of scope here (this pass is
  // dead-token removal, not CSS value changes) and still real UI
  // (ConfirmationSheet, EmptyState). Ring/shadow stay indigo so they don't
  // mismatch the fill they sit on.
  gradient: 'btn-gradient shadow-md shadow-indigo-500/25 focus-visible:ring-indigo-500',
};

const sizes = {
  sm: 'px-3.5 py-2 text-xs rounded-xl gap-1.5',
  md: 'px-5 py-3 text-sm rounded-2xl gap-2',
  lg: 'px-5 py-4 text-sm rounded-2xl gap-2 w-full justify-center',
};

// Clay depth, per variant (index.css, "3D CLAY" block). Each `.clay-depth-*`
// class only picks the shadow HUE — the geometry and the press live on
// `.clay-depth`. A solid button paints its own fill, so these point at the
// --clay-depth-*-rgb triples rather than at the pale tint ramps.
//
// Empty string = this variant has no depth; `depth` is then a no-op for it.
// Not exported: it is an implementation detail of the prop, unlike
// BUTTON_VARIANT_CLASSES which real call sites read.
const BUTTON_DEPTH_CLASSES: Record<keyof typeof BUTTON_VARIANT_CLASSES, string> = {
  primary: 'clay-depth clay-depth-primary',
  secondary: 'clay-depth clay-depth-secondary',
  danger: 'clay-depth clay-depth-danger',
  warning: 'clay-depth clay-depth-warning',
  ghost: '',
  gradient: '',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  depth = false,
  className = '',
  ...props
}: Props) {
  const depthClass = depth ? BUTTON_DEPTH_CLASSES[variant] : '';

  // The two press treatments are mutually exclusive. Tailwind 4's scale
  // utilities set the `scale` property while `.clay-depth` sets `transform`,
  // so leaving both on would compose two scales into one tap. When there is no
  // depth class, the class list is byte-identical to what this component
  // emitted before `depth` existed.
  const classes = [
    'inline-flex items-center font-semibold transition-all duration-200',
    depthClass || 'active:scale-[0.97]',
    'disabled:opacity-60 disabled:cursor-not-allowed',
    depthClass ? '' : 'disabled:active:scale-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 tracking-tight',
    BUTTON_VARIANT_CLASSES[variant],
    sizes[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...props} disabled={disabled || loading} className={classes}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
