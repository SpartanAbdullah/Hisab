interface Props {
  size?: number;
  /** 'receive' = settled / cleared (green). 'accent' = a neutral milestone. */
  tone?: 'receive' | 'accent';
  className?: string;
}

// The "you're clear" mark.
//
// A static tick says "this is true". A tick that DRAWS says "this just became
// true" — and that difference is the whole payoff of the Hisaab check ritual
// and of settling a debt. Those are the two moments the product exists for,
// so they get the app's only bouncy curve; everything else settles on the
// calm expo ease.
//
// Three layers on one timeline (see .animate-celebrate-* in index.css):
//   0.00s  disc scales up past 1 and settles back
//   0.05s  ring expands outward and dissolves
//   0.28s  checkmark strokes itself on, left segment then right
//
// Total ~0.75s: long enough to register as a moment, short enough that it's
// finished before the user's thumb reaches the Done button.
export function CelebrationMark({ size = 56, tone = 'receive', className = '' }: Props) {
  const ringColor = tone === 'receive' ? 'var(--color-receive-600)' : 'var(--color-accent-500)';
  const discClass = tone === 'receive' ? 'bg-receive-50' : 'bg-accent-100';
  const strokeColor = tone === 'receive' ? 'var(--color-receive-600)' : 'var(--color-accent-600)';

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Expanding ring. Pointer-events-none and aria-hidden: it is pure
          decoration that briefly overflows its box. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full animate-celebrate-ring pointer-events-none"
        style={{ border: `2px solid ${ringColor}` }}
      />
      <span className={`absolute inset-0 rounded-full ${discClass} animate-celebrate-pop`} aria-hidden />
      <svg
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        className="relative"
        aria-hidden
      >
        {/* One continuous path so the tick draws as a single gesture.
            pathLength normalises its length to 100 units no matter what the
            geometry actually measures, which is what lets
            .animate-celebrate-check use an exact dash array. Without it the
            dash values have to guess the real length (~23.35 here) and the
            draw either finishes early and idles, or never closes. */}
        <path
          d="M4 12.5 L9.5 18 L20 6.5"
          pathLength={100}
          stroke={strokeColor}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-celebrate-check"
        />
      </svg>
    </div>
  );
}
