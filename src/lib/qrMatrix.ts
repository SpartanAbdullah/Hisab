import qrcode from 'qrcode-generator';

// The geometry half of QR rendering, split out from the component so it can
// be round-trip tested (encode → rasterise → decode) without a DOM. A QR that
// renders but doesn't scan is indistinguishable from a working one by eye,
// which is exactly why this needs a test rather than a screenshot.

export interface QrMatrix {
  /** Module grid INCLUDING the quiet zone. `true` = dark. */
  modules: boolean[][];
  /** Edge length in modules, quiet zone included. */
  extent: number;
  /** SVG path data, one 1×1 square per dark module. */
  path: string;
}

/**
 * Error correction level M (~15% recoverable).
 *
 * H would survive a logo punched through the middle, but for a payload this
 * short it pushes the symbol to a higher version — more, smaller modules.
 * On a phone screen held at arm's length, denser modules scan measurably
 * worse than sparser ones, and nothing is ever overlaid on this code.
 */
const ERROR_CORRECTION = 'M' as const;

/**
 * Build the module grid for `value`.
 *
 * `margin` is the quiet zone in MODULES; the spec asks for 4, and below that
 * scanners start failing against busy backgrounds.
 */
export function buildQrMatrix(value: string, margin = 4): QrMatrix {
  // Type 0 = auto-select the smallest version that fits the payload.
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const extent = count + margin * 2;
  const modules: boolean[][] = Array.from({ length: extent }, () =>
    Array.from({ length: extent }, () => false),
  );

  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      modules[row + margin][col + margin] = true;
      parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }

  // One path for the whole symbol — one DOM node instead of ~900 rects,
  // which matters on the low-end Androids this app targets.
  return { modules, extent, path: parts.join('') };
}
