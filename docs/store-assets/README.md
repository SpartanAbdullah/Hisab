# Play Store listing graphics

Generated from the brand mark in `public/favicon.svg` (mint `#2FE3A0` rounded square,
navy `#14182B` "h" with a tilde). Flat surfaces, no gradients, no drawn edges or bottom
lips (founder rule, 2026-09-03). Upload targets: Play Console → **Grow → Store presence →
Main store listing → Graphics**. Copy for the same screen lives in
`docs/play-store-listing.md`.

## Files

| File | What it is | Size / format |
|---|---|---|
| `icon-512.png` | **App icon** (hi-res). The favicon rendered at 512 px and flattened onto the same mint, so it is a full-bleed opaque square — Play applies its own rounded mask, so the upload must not carry rounded corners or transparency. | 512×512, 24-bit PNG, no alpha, 8.9 KB |
| `icon-512.svg` | Source for the above: `public/favicon.svg` with the corner radius removed. | vector |
| `feature-graphic-1024x500.png` | **Feature graphic**. Navy ground, the mark at left, "Hisaab" (700, tracked) and the English short description from `docs/play-store-listing.md` (400) on a single left-aligned baseline grid, 88 px margins both sides. | 1024×500, 24-bit PNG, no alpha, 22 KB |
| `feature-graphic-1024x500.svg` | Source for the above. Text is SVG `<text>` in `Arial, Helvetica, sans-serif`, so it rasterises with whatever that resolves to on the machine that runs the script (Arial on Windows). | vector |
| `generate.mjs` | The generator. Reads `public/favicon.svg`, writes the four files above, then reads the PNG dimensions/alpha back with `sharp` and checks the text column stays inside the right margin. | script |

The tagline is the listing's short description verbatim
(`Khata, udhaar, kameti & expense tracker for desi life — AED + PKR, no ads`), wrapped at
"tracker / for" so it fits the text column at 27 px. If the short description changes,
update `TAGLINE_LINES` in `generate.mjs` and rerun.

## Play size requirements (as of 2026-09)

- **App icon:** 512×512, 32-bit PNG (alpha is accepted but ignored — upload it opaque and
  full-bleed; Play masks it), ≤ 1 MB. Must match the icon inside the AAB well enough that
  review does not flag a mismatch — the launcher icon in `android/` uses the same mark.
- **Feature graphic:** 1024×500, PNG or JPEG, no transparency, ≤ 15 MB. Shown at the top
  of the listing and in promotions; keep text away from the outer ~10 % since some surfaces
  crop it. Required before the listing can be published.
- **Phone screenshots:** minimum **2**, maximum **8**. PNG (24-bit, no alpha) or JPEG.
  Each side between **320 px and 3840 px**, aspect ratio **16:9 or 9:16** (Play now also
  accepts other portrait ratios, but 9:16 is the safe default). Max 8 MB each.
  Recommended: **1080×1920** (exact 9:16) or **1080×2400** (the native ratio of most current
  Android phones — Play accepts it). Capture them on the founder's own phone from the
  release build, real-looking (not empty) data, Roman-Urdu default language or English —
  pick one and keep all shots consistent:
  1. Home (balances + coach card)
  2. Quick Entry (type-first, an amount half-typed)
  3. A group with a split and a settle-up state
  4. A kameti with the draw order and paid marks
  5. Loans / khata (a person with an open udhaar and an instalment schedule)
  Optional: Budgets, Insights. Do not screenshot the PIN lock or any "offline" state — those
  are not listing claims (see the claims ledger in `docs/play-store-listing.md`).
- **7-inch / 10-inch tablet screenshots:** optional for a phone-only launch; skip for
  closed testing.
- **Promo video:** optional, YouTube URL only; skip.

Screenshots should NOT be committed to this folder unless they have been scrubbed of any
real contact names, phone numbers or balances — use seeded demo data.

## Regenerate

```bash
node docs/store-assets/generate.mjs
```

Requires the repo's installed `sharp` (`node_modules/sharp`, 0.35.x — bundled libvips with
librsvg/pango/fontconfig). The script prints one `OK`/`BAD` line per PNG with the
dimensions read back from disk, plus the measured text-column extent; a non-zero exit means
a check failed. Rerun whenever `public/favicon.svg`, the brand colours, or the short
description changes, and review the PNGs by eye before uploading — pango picks the font at
run time, so a machine without Arial will produce a slightly different tagline.
