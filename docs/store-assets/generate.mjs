// Regenerates the Play listing graphics from the brand mark in public/favicon.svg.
//   node docs/store-assets/generate.mjs
// Uses the repo's installed `sharp` (librsvg + pango render the SVG <text>, so the
// tagline is set in whatever "Arial, Helvetica, sans-serif" resolves to on this machine).
// Writes ONLY into docs/store-assets/: the two PNGs plus their SVG sources.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const out = (f) => join(here, f);

const MINT = '#2FE3A0';
const NAVY = '#14182B';
const INK = '#FFFFFF';       // app name
const INK_SOFT = '#B7BDCF';  // tagline (muted on navy, still >4.5:1)
const FONT = 'Arial, Helvetica, sans-serif';

// Short description, verbatim from docs/play-store-listing.md ("Short description — English").
// Wrapped at a phrase boundary so it fits the text column at a readable size.
const TAGLINE_LINES = [
  'Khata, udhaar, kameti & expense tracker',
  'for desi life — AED + PKR, no ads',
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---------- 1. Hi-res icon 512×512 ----------
// Play masks the icon itself, so the upload is a FULL-BLEED opaque square: the favicon
// rendered at 512 and its transparent rounded corners flattened onto the same mint.
const faviconSvg = readFileSync(join(root, 'public', 'favicon.svg'));
// Source SVG kept next to the PNG: identical geometry, corners filled (rx removed).
const iconSvg = faviconSvg.toString().replace('rx="26.087" ', '');
writeFileSync(out('icon-512.svg'), iconSvg);
await sharp(faviconSvg, { density: 72 })
  .resize(512, 512)
  .flatten({ background: MINT })
  .png({ compressionLevel: 9 })
  .toFile(out('icon-512.png'));

// ---------- 2. Feature graphic 1024×500 ----------
const W = 1024, H = 500;
const MARK = 180;                 // mark edge
const MARK_X = 88;
const MARK_Y = (H - MARK) / 2;    // 160
const TEXT_X = MARK_X + MARK + 56; // 324
const MAX_TEXT_W = W - TEXT_X - MARK_X; // 612 — same margin right as left
const NAME_Y = 232;               // baseline grid: 232 / 288 / 326
const TAG_Y = [288, 326];
const NAME_SIZE = 84, NAME_TRACK = 8;
const TAG_SIZE = 27;

// The mark is the favicon's own paths, translated/scaled — nothing redrawn.
const mark = `
  <g transform="translate(${MARK_X} ${MARK_Y}) scale(${MARK / 100})">
    <rect width="100" height="100" rx="26.087" fill="${MINT}"/>
    <g transform="translate(50 50) scale(1.08696) translate(-50 -50)">
      <path d="M36 26 V74 M36 56 C36 42 64 42 64 54 V74" stroke="${NAVY}" stroke-width="13" stroke-linecap="round" fill="none"/>
      <path d="M55 27 Q61 34 67 27" stroke="${NAVY}" stroke-width="7" stroke-linecap="round" fill="none"/>
    </g>
  </g>`;

const textBlock = (withName) => `
  ${withName ? `<text x="${TEXT_X}" y="${NAME_Y}" font-family="${FONT}" font-weight="700" font-size="${NAME_SIZE}" letter-spacing="${NAME_TRACK}" fill="${INK}">Hisaab</text>` : ''}
  ${TAGLINE_LINES.map((l, i) => `<text x="${TEXT_X}" y="${TAG_Y[i]}" font-family="${FONT}" font-weight="400" font-size="${TAG_SIZE}" fill="${INK_SOFT}">${esc(l)}</text>`).join('\n  ')}`;

const featureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hisaab — ${esc(TAGLINE_LINES.join(' '))}">
  <rect width="${W}" height="${H}" fill="${NAVY}"/>${mark}${textBlock(true)}
</svg>
`;
writeFileSync(out('feature-graphic-1024x500.svg'), featureSvg);
await sharp(Buffer.from(featureSvg), { density: 72 })
  .flatten({ background: NAVY })
  .png({ compressionLevel: 9 })
  .toFile(out('feature-graphic-1024x500.png'));

// ---------- 3. Verify ----------
// (a) dimensions + opacity read back from the files on disk
for (const [f, w, h] of [['icon-512.png', 512, 512], ['feature-graphic-1024x500.png', 1024, 500]]) {
  const m = await sharp(out(f)).metadata();
  const ok = m.width === w && m.height === h && !m.hasAlpha;
  console.log(`${ok ? 'OK ' : 'BAD'} ${f}: ${m.width}x${m.height} ${m.format} channels=${m.channels} alpha=${m.hasAlpha} ${(m.size ?? readFileSync(out(f)).length)} bytes`);
  if (!ok) process.exitCode = 1;
}
// (b) the text column must not run past the right margin: render text-only on navy and trim
const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${NAVY}"/>${textBlock(true)}</svg>`;
const t = await sharp(Buffer.from(probe)).trim({ background: NAVY, threshold: 10 }).toBuffer({ resolveWithObject: true });
const textRight = -t.info.trimOffsetLeft + t.info.width;
const textTop = -t.info.trimOffsetTop, textBottom = textTop + t.info.height;
console.log(`text column: x ${-t.info.trimOffsetLeft}..${textRight} (limit ${TEXT_X + MAX_TEXT_W}), y ${textTop}..${textBottom} (mark ${MARK_Y}..${MARK_Y + MARK})`);
if (textRight > TEXT_X + MAX_TEXT_W) { console.log('BAD text overflows the right margin'); process.exitCode = 1; }
