interface Props {
  rows?: number;
  withAvatar?: boolean;
  withTrailing?: boolean;
}

// Skeleton placeholder for any cream-card list (accounts, loans, transactions,
// contacts, groups, etc). Renders before the first load completes so we never
// flash an empty state on a screen that's about to fill in.
export function ListSkeleton({ rows = 3, withAvatar = true, withTrailing = true }: Props) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3"
        >
          {withAvatar && (
            <div className="w-11 h-11 rounded-2xl bg-cream-soft animate-pulse shrink-0" />
          )}
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-32 rounded-full bg-cream-hairline animate-pulse" />
            <div className="h-2.5 w-20 rounded-full bg-cream-hairline animate-pulse" />
          </div>
          {withTrailing && (
            <div className="h-3.5 w-14 rounded-full bg-cream-hairline animate-pulse" />
          )}
        </div>
      ))}
    </div>
  );
}
