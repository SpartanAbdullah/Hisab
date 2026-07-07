// The Hisaab brand mark — "Single Wink" (docs/brand/LOGO_HANDOFF.md): green
// tile with the stroke-drawn lowercase "h" and a closed-eye wink beside its
// top arm. Single in-app source for the logo — keep the geometry in sync with
// scripts/generate-icons.mjs (favicon, PWA icons, launcher, splash).
// The tile is drawn full-bleed; the glyph is scaled 100/92 about the center so
// its proportions match the handoff file (which has a 4-unit margin).
const GREEN = '#2FE3A0';
const INK = '#14182B';

export function BrandMark({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <rect width="100" height="100" rx="26.087" fill={GREEN} />
      <g transform="translate(50 50) scale(1.08696) translate(-50 -50)">
        <path
          d="M36 26 V74 M36 56 C36 42 64 42 64 54 V74"
          stroke={INK}
          strokeWidth={13}
          strokeLinecap="round"
          fill="none"
        />
        <path d="M55 27 Q61 34 67 27" stroke={INK} strokeWidth={7} strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}
