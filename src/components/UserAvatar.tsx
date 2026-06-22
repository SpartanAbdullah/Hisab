interface Props {
  name: string;
  size?: number;
  onClick?: () => void;
}

// Deterministic letter-circle avatar. Color is picked from the first letter so
// the same user always renders the same tile, without storing anything.
// Palettes derive from the Sukoon money/semantic families (accent / receive /
// pay / info / warn). Every stop is a 600/700 shade so white initials clear
// AA contrast on the gradient regardless of which palette a name lands on.
const PALETTES = [
  'from-accent-500 to-accent-600',
  'from-receive-600 to-receive-700',
  'from-pay-600 to-pay-700',
  'from-warn-600 to-warn-700',
  'from-info-600 to-accent-600',
  'from-accent-500 to-info-600',
];

// Simple djb2 hash so different letters/names actually land on different
// palettes — a plain charCode % N distributes poorly (lots of names collide
// on violet because A/G/M/S/Y all map to the same bucket).
function hashName(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function UserAvatar({ name, size = 40, onClick }: Props) {
  const trimmed = name.trim();
  const letter = (trimmed[0] || 'U').toUpperCase();
  const palette = PALETTES[hashName(trimmed || 'User') % PALETTES.length];
  const fontSize = Math.round(size * 0.42);

  const className = `rounded-full bg-gradient-to-br ${palette} text-white font-bold flex items-center justify-center shadow-sm shadow-ink-900/10 active:scale-95 transition-all shrink-0`;
  const style = { width: size, height: size, fontSize };

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2`}
        style={style}
        aria-label="Profile"
      >
        {letter}
      </button>
    );
  }
  return (
    <div className={className} style={style} aria-hidden>
      {letter}
    </div>
  );
}
