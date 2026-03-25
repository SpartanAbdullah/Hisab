import { Loader2 } from 'lucide-react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'gradient';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const variants = {
  primary: 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20 active:shadow-none',
  secondary: 'glass border border-slate-200/60 text-slate-700',
  danger: 'bg-red-500 text-white shadow-sm shadow-red-500/20',
  ghost: 'bg-transparent text-indigo-600 active:bg-indigo-50',
  gradient: 'btn-gradient shadow-md shadow-indigo-500/25',
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
      className={`inline-flex items-center font-semibold transition-all duration-200 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 tracking-tight ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
