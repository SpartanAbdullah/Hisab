import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Props {
  title: string;
  back?: boolean;
  action?: React.ReactNode;
}

export function PageHeader({ title, back, action }: Props) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 glass border-b border-slate-100/60 px-5 py-3.5 flex items-center justify-between z-40">
      <div className="flex items-center gap-2.5">
        {back && (
          <button
            onClick={() => navigate(-1)}
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors -ml-1"
          >
            <ArrowLeft size={16} className="text-slate-500" />
          </button>
        )}
        <h1 className="text-[17px] font-bold tracking-tight text-slate-800">{title}</h1>
      </div>
      {action}
    </header>
  );
}
