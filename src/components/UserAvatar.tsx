interface Props {
  name: string;
  size?: number;
  onClick?: () => void;
}

// Deterministic letter-circle avatar. Color is picked from the first letter so
// the same user always renders the same tile, without storing anything.
const PALETTES = [
  'from-indigo-400 to-purple-500',
  'from-emerald-400 to-teal-500',
  'from-rose-400 to-pink-500',
  'from-amber-400 to-orange-500',
  'from-sky-400 to-blue-500',
  'from-violet-400 to-fuchsia-500',
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

  const className = `rounded-full bg-gradient-to-br ${palette} text-white font-bold flex items-center justify-center shadow-sm shadow-slate-900/10 active:scale-95 transition-all shrink-0`;
  const style = { width: size, height: size, fontSize };

  if (onClick) {
    return (
      <button onClick={onClick} className={className} style={style} aria-label="Profile">
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
