interface MoneyDisplayProps {
  amount: number;
  currency?: string;
  // Font size in px for the integer portion. Currency and cents scale
  // off this — 45% and 42% respectively — per Sukoon's spec.
  size?: number;
  tone?: 'on-navy' | 'on-cream';
  // Show explicit + sign for positive amounts.
  signed?: boolean;
  // Override the muted (currency + cents) color. Useful when the hero
  // background isn't navy/cream — e.g. an accent-tinted card.
  mutedColor?: string;
  // Override the primary (integer) color.
  color?: string;
}

// Sukoon's 3-part baseline-aligned money composition:
//   <currency code>  <integer>  .<cents>
//        45%           100%       42%
// All `tabular-nums`. Currency and cents sit on the same baseline as
// the integer so the number reads as one unit, not three. Letter
// spacing is tightened at display sizes per Sukoon's typography spec.
export function MoneyDisplay({
  amount,
  currency = 'AED',
  size = 36,
  tone = 'on-cream',
  signed = false,
  mutedColor,
  color,
}: MoneyDisplayProps) {
  const abs = Math.abs(amount);
  const intPart = Math.floor(abs).toLocaleString('en-US');
  const cents = (abs - Math.floor(abs)).toFixed(2).slice(2);
  const isNegative = amount < 0;
  const sign = isNegative ? '−' : signed && amount > 0 ? '+' : '';

  const primary = color ?? (tone === 'on-navy' ? '#ffffff' : 'var(--color-ink-900)');
  const muted   = mutedColor ?? (tone === 'on-navy' ? 'rgba(255,255,255,0.5)' : 'var(--color-ink-500)');

  return (
    <span
      className="inline-flex items-baseline"
      style={{
        gap: Math.max(4, size * 0.12),
        letterSpacing: '-0.025em',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ fontSize: size * 0.45, fontWeight: 500, color: muted }}>{currency}</span>
      <span style={{ fontSize: size, fontWeight: 600, color: primary }}>
        {sign}{intPart}
      </span>
      <span style={{ fontSize: size * 0.42, fontWeight: 500, color: muted }}>.{cents}</span>
    </span>
  );
}
