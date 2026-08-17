interface Props {
  rows?: number;
  withAvatar?: boolean;
  withTrailing?: boolean;
}

// Skeleton placeholder for any cream-card list (accounts, loans, transactions,
// contacts, groups, etc). Renders before the first load completes so we never
// flash an empty state on a screen that's about to fill in.
//
// Blinking opacity (`animate-pulse`) reads as "stalled" — it's the same visual
// language as a disabled control. A directional sweep reads as "working",
// which is what a loading state is actually claiming. The sweep is a
// transform-animated pseudo-element, so it composites on the GPU instead of
// repainting each bar every frame.
//
// Rows are phase-offset so the list reads top-to-bottom rather than pulsing as
// one block — the same reading-order logic as .stagger-in.
export function ListSkeleton({ rows = 3, withAvatar = true, withTrailing = true }: Props) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3"
          // Passed as a custom property, not animation-delay: the animation
          // lives on .skeleton-sweep::after and animation-delay does NOT
          // inherit, whereas custom properties do — so this is the only way
          // the offset reaches the pseudo-element.
          //
          // NEGATIVE value: the sweep starts already in progress, so rows are
          // visibly out of phase on the first frame. A positive delay would
          // hold them in sync for one full cycle and separate only afterwards.
          style={{ '--sweep-delay': `${i * -260}ms` } as React.CSSProperties}
        >
          {withAvatar && (
            <div className="w-11 h-11 rounded-2xl bg-cream-soft skeleton-sweep shrink-0" />
          )}
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-32 rounded-full bg-cream-hairline skeleton-sweep" />
            <div className="h-2.5 w-20 rounded-full bg-cream-hairline skeleton-sweep" />
          </div>
          {withTrailing && (
            <div className="h-3.5 w-14 rounded-full bg-cream-hairline skeleton-sweep" />
          )}
        </div>
      ))}
    </div>
  );
}
