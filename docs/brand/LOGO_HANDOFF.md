# Hisaab logo — final mark ("Single Wink", option 2b)

Chosen direction: the existing green-tile "h" kept as-is, with one closed-eye
wink curve floating beside the top arm of the h. No other decoration.

## Files
- hisaab-mark.svg — primary app icon (green tile, ink glyph)
- hisaab-mark-dark-tile.svg — inverted tile for contexts where the green tile clashes
- hisaab-glyph.svg — glyph only (h + wink), no tile, for wordmark lockups / watermarks

## Colors
- Brand green (tile): #2FE3A0
- Ink (glyph, dark surfaces): #14182B
- Cream (light app background): #F4F2EB

## Geometry (viewBox 0 0 100 100)
- Tile: rect x=4 y=4 w=92 h=92 rx=24
- h: path "M36 26 V74 M36 56 C36 42 64 42 64 54 V74", stroke #14182B,
  stroke-width 13, round caps, fill none
- Wink: path "M55 27 Q61 34 67 27", stroke-width 7, round caps, fill none

## Usage rules
- Wink is part of the mark — never remove or reposition it.
- Minimum size 16px; the wink stays legible down to favicon size.
- Do not add gradients, shadows, or outlines to the tile.
- On dark UI, use the standard green tile (preferred) or the dark-tile variant.
