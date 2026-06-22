interface Props {
  steps: string[];
  current: number;
}

export function StepIndicator({ steps, current }: Props) {
  return (
    <div className="flex items-center gap-2 px-1">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-1">
          <div className="relative flex-1 h-1 rounded-full bg-accent-100 overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out ${
                i < current ? 'w-full bg-accent-500' :
                i === current ? 'w-full bg-gradient-to-r from-accent-500 to-accent-600' :
                'w-0 bg-ink-200'
              }`}
            />
          </div>
          {i === current && (
            <span className="text-[10px] font-bold text-accent-600 whitespace-nowrap animate-fade-in tracking-tight">
              {label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
