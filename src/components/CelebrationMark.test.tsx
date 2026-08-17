import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CelebrationMark } from './CelebrationMark';

// The checkmark's draw-on is a CONTRACT ACROSS TWO FILES: index.css hard-codes
// stroke-dasharray/dashoffset: 100, and this component has to normalise the
// path to that same length with pathLength="100".
//
// Break either side and nothing throws — the tick just draws wrong, and only
// in a 0.42s window that is easy to miss. During development the dash array
// was 32 against a real path length of 23.35, which drew the tick fully at 73%
// and then idled through dead time. These tests pin the coupling.
describe('CelebrationMark', () => {
  it('normalises the checkmark path to the length the CSS dash array assumes', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html).toContain('pathLength="100"');
  });

  it('carries the three animation layers the celebration timeline drives', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html).toContain('animate-celebrate-ring');
    expect(html).toContain('animate-celebrate-pop');
    expect(html).toContain('animate-celebrate-check');
  });

  it('renders the tick as one continuous path so it draws as a single gesture', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    // Two <path> elements would draw as two disconnected strokes.
    expect(html.match(/<path/g)?.length).toBe(1);
  });

  it('keeps the decorative layers out of the accessibility tree', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    // The mark is pure decoration; the surrounding copy carries the meaning.
    expect(html.match(/aria-hidden/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('honours the accent tone without falling back to the settled green', () => {
    const html = renderToStaticMarkup(<CelebrationMark tone="accent" />);
    expect(html).toContain('bg-accent-100');
    expect(html).not.toContain('bg-receive-50');
  });
});
