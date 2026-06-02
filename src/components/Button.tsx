import { Loader2 } from 'lucide-react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT_CLASSES;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

// Co-located variant map. Could be moved to a styles file to make Fast
// Refresh stricter, but it's a 6-key Tailwind lookup table tightly bound
// to the Button component's props — not worth a separate file.
// eslint-disable-next-line react-refresh/only-export-components
export const BUTTON_VARIANT_CLASSES = {
  primary: 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20 active:bg-indigo-700 active:shadow-none focus-visible:ring-indigo-500',
  secondary: 'bg-slate-100 border border-slate-200 text-slate-700 active:bg-slate-200 focus-visible:ring-slate-400',
  danger: 'bg-red-600 text-white shadow-sm shadow-red-600/20 active:bg-red-700 focus-visible:ring-red-500',
  warning: 'bg-amber-500 text-slate-950 shadow-sm shadow-amber-500/20 active:bg-amber-600 focus-visible:ring-amber-500',
  ghost: 'bg-transparent text-indigo-600 active:bg-indigo-50 focus-visible:ring-indigo-500',
  gradient: 'btn-gradient shadow-md shadow-indigo-500/25 focus-visible:ring-indigo-500',
};

const sizes = {
  sm: 'px-3.5 py-2 text-xs rounded-xl gap-1.5',
  md: 'px-5 py-3 text-sm rounded-2xl gap-2',
  lg: 'px-5 py-4 text-sm rounded-2xl gap-2 w-full justify-center',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  className = '',
  ...props
}: Props) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`inline-flex items-center font-semibold transition-all duration-200 active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 tracking-tight ${BUTTON_VARIANT_CLASSES[variant]} ${sizes[size]} ${className}`}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
