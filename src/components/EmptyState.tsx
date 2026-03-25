import { Button } from './Button';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, title, description, actionLabel, onAction }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
      <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-indigo-50 to-purple-50 text-indigo-400 flex items-center justify-center mb-5 shadow-sm shadow-indigo-500/5">
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <h3 className="font-bold text-[15px] text-slate-700 tracking-tight">{title}</h3>
      <p className="text-[13px] text-slate-400 mt-1.5 max-w-[240px] leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <div className="mt-5">
          <Button variant="gradient" size="md" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
