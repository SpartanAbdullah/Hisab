// Bundle-size budget check (P2 M2a — docs/audit-2026-09/03-performance.md H1
// / low-severity #4: "no bundle monitoring exists in CI").
//
// Reads dist/assets after `npm run build`, finds the entry chunk (the script
// index.html loads directly, i.e. the code that must download+parse before
// React can even mount), and fails the process if its gzip size regresses
// past a budget. Also prints a full chunk table (raw + gzip, largest last)
// so a size regression review has the whole picture, not just the one
// number the assertion checks.
//
// Usage: node scripts/check-bundle-size.mjs   (run after `npm run build`)
//
// Not wired into package.json or CI here — both are owned by another P2
// agent in this batch. The lead should add:
//   "check:bundle": "node scripts/check-bundle-size.mjs"
// to package.json scripts, and a step running `npm run check:bundle` after
// the build step in .github/workflows/ci.yml. See docs/performance.md.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const assetsDir = join(distDir, 'assets');
const indexHtmlPath = join(distDir, 'index.html');

// Budget: measured entry chunk gzip size on 2026-09-02 (after the vite.config.ts
// manualChunks split landed) was ~81.4 kB. Set 10% above that, per the M2a task
// spec, and rounded up slightly for stability across minifier/dependency
// micro-fluctuations that aren't real regressions.
//   81.4 kB * 1.10 = 89.5 kB -> 90 kB
// If this fails after a legitimate, reviewed increase in entry-chunk content,
// re-measure and update this constant deliberately — don't just raise it to
// make CI pass.
const ENTRY_GZIP_BUDGET_BYTES = 90 * 1024;

function fail(message) {
  console.error(`\n[check-bundle-size] FAIL: ${message}\n`);
  process.exitCode = 1;
}

if (!existsSync(distDir) || !existsSync(indexHtmlPath)) {
  fail(`dist/ not found (looked for ${indexHtmlPath}). Run "npm run build" first.`);
  process.exit(1);
}

// Find the entry chunk: the module script index.html loads directly (not a
// modulepreload hint, the actual <script type="module" src="..."> tag).
const html = readFileSync(indexHtmlPath, 'utf-8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
if (!entryMatch) {
  fail('Could not find the entry <script type="module" src="..."> tag in dist/index.html.');
  process.exit(1);
}
const entryRelUrl = entryMatch[1]; // e.g. /assets/index-XXXXXXXX.js
const entryFileName = entryRelUrl.split('/').pop();
const entryPath = join(distDir, entryRelUrl.replace(/^\//, ''));

if (!existsSync(entryPath)) {
  fail(`Entry chunk referenced by index.html (${entryRelUrl}) does not exist on disk.`);
  process.exit(1);
}

// Build the full chunk table from dist/assets/*.js.
const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const rows = jsFiles.map((name) => {
  const filePath = join(assetsDir, name);
  const raw = readFileSync(filePath);
  const gzipSize = gzipSync(raw, { level: 9 }).length;
  return { name, rawBytes: raw.length, gzipBytes: gzipSize, isEntry: name === entryFileName };
});
rows.sort((a, b) => a.rawBytes - b.rawBytes);

const fmtKb = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const nameWidth = Math.max(...rows.map((r) => r.name.length), 'chunk'.length) + 2;

console.log('\nBundle chunk report (dist/assets/*.js)\n');
console.log(
  `${'chunk'.padEnd(nameWidth)}${'raw'.padStart(12)}${'gzip'.padStart(12)}  `,
);
console.log('-'.repeat(nameWidth + 26));
for (const row of rows) {
  const marker = row.isEntry ? '  <- entry' : '';
  console.log(
    `${row.name.padEnd(nameWidth)}${fmtKb(row.rawBytes).padStart(12)}${fmtKb(row.gzipBytes).padStart(12)}${marker}`,
  );
}

const totalRaw = rows.reduce((sum, r) => sum + r.rawBytes, 0);
const totalGzip = rows.reduce((sum, r) => sum + r.gzipBytes, 0);
console.log('-'.repeat(nameWidth + 26));
console.log(`${'TOTAL (all JS chunks)'.padEnd(nameWidth)}${fmtKb(totalRaw).padStart(12)}${fmtKb(totalGzip).padStart(12)}`);

const entryRow = rows.find((r) => r.isEntry);
console.log(`\nEntry chunk: ${entryRow.name}`);
console.log(`  raw:  ${fmtKb(entryRow.rawBytes)}`);
console.log(`  gzip: ${fmtKb(entryRow.gzipBytes)}  (budget: ${fmtKb(ENTRY_GZIP_BUDGET_BYTES)})`);

if (entryRow.gzipBytes > ENTRY_GZIP_BUDGET_BYTES) {
  fail(
    `entry chunk gzip size ${fmtKb(entryRow.gzipBytes)} exceeds the ${fmtKb(ENTRY_GZIP_BUDGET_BYTES)} budget. ` +
      `Something got pulled into the entry graph that shouldn't be there — check for a new eager import ` +
      `(App.tsx eager component tree, or a store/lib newly reachable from it) before raising the budget.`,
  );
} else {
  console.log('\n[check-bundle-size] OK — entry chunk within budget.\n');
}
