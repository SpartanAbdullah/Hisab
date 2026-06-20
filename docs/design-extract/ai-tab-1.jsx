// Hisaab AI tab — shared atoms for the design canvas.
// Flat phone frame (no bezel — the canvas card is the bezel), status bar,
// hero header, ask bar, the signature vertical "where it goes" bars, cut
// cards, nudges, wrap teaser, and small inline charts for chat answers.
// Builds on the Sukoon system (tokens.jsx) + coach-atoms.jsx (CoachHero, CoachNav).

const C = window.SukoonTokens;

// Sparkle mark — the Hisaab AI glyph, reused at several sizes.
function Spark({ size = 20, color = '#fff', op = 0.85 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3l1.6 4.8L18.5 9l-4.9 1.4L12 15l-1.6-4.6L5.5 9l4.9-1.2L12 3z" fill={color} />
      <path d="M18.5 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" fill={color} fillOpacity={op} />
    </svg>
  );
}

// White status bar — sits at the very top of the navy hero on every screen.
function StatusBar({ color = '#fff' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 16, marginBottom: 12, color, fontFamily: C.fontNumeric }}>
      <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }}>9:41</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <svg width="17" height="11" viewBox="0 0 17 11"><g fill="currentColor"><rect x="0" y="7" width="2.6" height="4" rx="0.5" /><rect x="4" y="5" width="2.6" height="6" rx="0.5" /><rect x="8" y="2.7" width="2.6" height="8.3" rx="0.5" /><rect x="12" y="0" width="2.6" height="11" rx="0.5" /></g></svg>
        <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><path d="M8 2.2c1.9 0 3.7.7 5 1.9l1.1-1.2A9 9 0 0 0 8 .5 9 9 0 0 0 1.9 2.9L3 4.1A7.4 7.4 0 0 1 8 2.2zM8 5.3c1 0 2 .4 2.7 1.1l1.1-1.2A6 6 0 0 0 8 3.6 6 6 0 0 0 4.2 5.2l1.1 1.2A4 4 0 0 1 8 5.3zm0 3a2 2 0 0 0-1.4.6L8 10.5l1.4-1.6A2 2 0 0 0 8 8.3z" /></svg>
        <svg width="24" height="11" viewBox="0 0 24 11"><rect x="0.5" y="0.5" width="20" height="10" rx="2.6" stroke="currentColor" strokeOpacity=".45" fill="none" /><rect x="2" y="2" width="16.5" height="7" rx="1.4" fill="currentColor" /><path d="M22 4v3c.6-.25 1-.8 1-1.5S22.6 4.25 22 4z" fill="currentColor" fillOpacity=".5" /></svg>
      </div>
    </div>
  );
}

// Flat phone frame — fills a design-canvas artboard. Nav pinned to the
// bottom of the artboard; screens add their own bottom padding to clear it.
function AIFrame({ children, height = 1000 }) {
  return (
    <div style={{ width: 402, height, position: 'relative', background: C.cream.bg, overflow: 'hidden', fontFamily: C.fontBody, color: C.ink[900], WebkitFontSmoothing: 'antialiased' }}>
      {children}
      <window.CoachNav />
    </div>
  );
}

// Hero top bar — avatar · title + roman-Urdu sub · BETA · bell.
function AIHeroHead({ greeting = 'Subah bakhair', name = 'Muhammad', sub, beta = true, bell = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, paddingBottom: 18 }}>
      <window.Avatar name="Muhammad Sharif" size={38} ring dark />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.015em', color: '#fff' }}>Hisaab AI</span>
          {beta && <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', padding: '3px 6px', borderRadius: 999, background: 'rgba(255,255,255,.13)', color: 'rgba(255,255,255,.8)' }}>BETA</span>}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', fontWeight: 500, marginTop: 1 }}>{sub || `${greeting}, ${name}`}</div>
      </div>
      {bell && (
        <window.IconTile dot>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 8a7 7 0 0114 0v5l2 3H3l2-3V8z M9 19a3 3 0 006 0" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
        </window.IconTile>
      )}
    </div>
  );
}

// The conversational ask bar. Two skins: translucent on the navy hero, or a
// white card on the cream body.
function AskBar({ onNavy = false, placeholder = 'Ask anything about your money…', accent }) {
  const a = accent || C.accent[600];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, borderRadius: 15, padding: '11px 11px 11px 14px',
      background: onNavy ? 'rgba(255,255,255,.10)' : '#fff',
      border: onNavy ? '1px solid rgba(255,255,255,.16)' : `1px solid ${C.cream.border}`,
      boxShadow: onNavy ? 'none' : '0 4px 16px -10px rgba(11,14,42,.25)',
    }}>
      <window.Spark size={17} color={onNavy ? 'rgba(255,255,255,.85)' : a} op={0.7} />
      <div style={{ flex: 1, fontSize: 13, color: onNavy ? 'rgba(255,255,255,.62)' : C.ink[400], letterSpacing: '-0.005em' }}>{placeholder}</div>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3zM6 11a6 6 0 0012 0M12 17v3" stroke={onNavy ? 'rgba(255,255,255,.6)' : C.ink[400]} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <div style={{ width: 32, height: 32, borderRadius: 10, background: onNavy ? '#fff' : a, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke={onNavy ? C.navy[800] : '#fff'} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
}

// Suggestion chip row (horizontal). On navy or cream.
function ChipRow({ items, onNavy = false }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {items.map((q) => (
        <div key={q} style={{
          fontSize: 11.5, fontWeight: 500, padding: '7px 12px', borderRadius: 999, whiteSpace: 'nowrap',
          background: onNavy ? 'rgba(255,255,255,.08)' : '#fff',
          border: onNavy ? '1px solid rgba(255,255,255,.14)' : `1px solid ${C.cream.border}`,
          color: onNavy ? 'rgba(255,255,255,.82)' : C.ink[700],
        }}>{q}</div>
      ))}
    </div>
  );
}

// Short money formatter for compact labels: 1,540 -> "1.5k".
function shortAmt(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ─── The signature "where your money goes" — vertical category bars ───
// data: [{ name, amt, color?, note? }]. The biggest/flagged category is
// coral; the rest are calm neutrals so the eye lands on the anomaly.
function CategoryBars({ data, areaH = 132, cur = 'AED' }) {
  const max = Math.max(...data.map((d) => d.amt));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9, height: areaH }}>
        {data.map((d) => {
          const h = Math.max(8, Math.round((d.amt / max) * (areaH - 26)));
          const col = d.color || C.ink[300];
          return (
            <div key={d.name} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: 6 }}>
              {d.note && (
                <div style={{ fontSize: 8.5, fontWeight: 700, color: C.pay.text, background: C.pay[50], padding: '2px 5px', borderRadius: 6, lineHeight: 1, whiteSpace: 'nowrap' }}>{d.note}</div>
              )}
              <div style={{ fontSize: 10, fontWeight: 600, color: C.ink[700], fontVariantNumeric: 'tabular-nums' }}>{shortAmt(d.amt)}</div>
              <div style={{ width: '100%', maxWidth: 34, height: h, borderRadius: 8, background: col }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 9, marginTop: 9 }}>
        {data.map((d) => (
          <div key={d.name} style={{ flex: '1 1 0', minWidth: 0, textAlign: 'center', fontSize: 9.5, fontWeight: 500, color: C.ink[500], lineHeight: 1.2 }}>{d.name}</div>
        ))}
      </div>
    </div>
  );
}

// A white rounded card — the body workhorse.
function Card({ children, style = {}, pad = 16, onTone }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.cream.border}`, borderRadius: 16, padding: pad, ...style }}>{children}</div>
  );
}

// ─── Actionable "cut" card — quantified saving + gentle actions ───
function CutCard({ merch, color, title, detail, save, saveUnit = '/yr', primary = 'Cancel', secondary = 'Keep', accent }) {
  const a = accent || C.accent[600];
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.cream.border}`, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 12, padding: '14px 15px' }}>
        <window.MerchTile name={merch} color={color} size={40} radius={12} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink[900], letterSpacing: '-0.01em', lineHeight: 1.3 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: C.ink[500], marginTop: 3, lineHeight: 1.4 }}>{detail}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 9.5, fontWeight: 600, color: C.receive.text, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Save</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.receive.text, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, marginTop: 1 }}>{save}</div>
          <div style={{ fontSize: 9.5, color: C.ink[400], fontWeight: 500 }}>{saveUnit}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '0 15px 14px' }}>
        <button style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', background: a, color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>{primary}</button>
        <button style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `1px solid ${C.cream.border}`, background: 'transparent', color: C.ink[700], fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>{secondary}</button>
      </div>
    </div>
  );
}

// ─── Gentle proactive nudge — friendly, action-oriented (never shaming) ───
// tone: 'friendly' (default) | 'direct'
function NudgeCard({ kind = 'info', title, body, action, accent }) {
  const map = {
    info: { bg: C.info[50], fg: C.info[600], ic: 'M12 16v-5M12 8h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    warn: { bg: C.warn[50], fg: C.warn[600], ic: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    streak: { bg: C.accent[50], fg: C.accent[600], ic: 'M12 3c1 4-2 5-2 8a4 4 0 1 0 8 0c0-1-.5-2-1-3 .2 2-1 3-2 3 .5-3-2-5-1-8' },
  }[kind];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: '#fff', border: `1px solid ${C.cream.border}`, borderRadius: 16, padding: '13px 14px' }}>
      <div style={{ width: 34, height: 34, borderRadius: 11, background: map.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d={map.ic} stroke={map.fg} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink[900], letterSpacing: '-0.005em' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: C.ink[500], marginTop: 2, lineHeight: 1.45 }}>{body}</div>
      </div>
      {action && (
        <button style={{ flexShrink: 0, alignSelf: 'center', padding: '7px 12px', borderRadius: 9, border: 'none', background: (accent || C.accent[600]), color: '#fff', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}>{action}</button>
      )}
    </div>
  );
}

// ─── Monthly-wrap teaser — a mini navy hero card inside the cream body ───
function WrapTeaser({ accent }) {
  const a = accent || C.accent[600];
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 18, background: C.navy[800], color: '#fff', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: C.navy.bloom, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 46, height: 46, borderRadius: 14, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.12)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>30</span>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,.55)', fontWeight: 600, letterSpacing: '0.08em', marginTop: 2 }}>JUN</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Your June, wrapped</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', marginTop: 2, lineHeight: 1.4 }}>A calm month-in-review — ready in 3 days</div>
        </div>
        <div style={{ padding: '8px 13px', borderRadius: 10, background: `linear-gradient(135deg, ${C.accent[500]}, ${a})`, fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}>Preview</div>
      </div>
    </div>
  );
}

// Section label that matches coach SecLabel but works without the nav ctx
// dependency for the canvas (still reads accent if present).
function AISec({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 11px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.ink[500] }}>{children}</div>
      {action && <div style={{ fontSize: 11.5, fontWeight: 600, color: C.accent[600] }}>{action}</div>}
    </div>
  );
}

// Tiny inline sparkline for chat answers / detail.
function Sparkline({ pts, color, w = 96, h = 30, fill = true }) {
  const max = Math.max(...pts), min = Math.min(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const xy = pts.map((p, i) => [i * step, h - 3 - ((p - min) / span) * (h - 6)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${d} L${w} ${h} L0 ${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {fill && <path d={area} fill={color} fillOpacity="0.10" />}
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.6" fill={color} />
    </svg>
  );
}

// Delta chip (e.g. "−12% vs May"). good=true → green, else coral.
function DeltaChip({ children, good = true, onNavy = true }) {
  const fg = good ? (onNavy ? '#7BE0C4' : C.receive.text) : (onNavy ? '#FFB59E' : C.pay.text);
  const bg = good ? (onNavy ? 'rgba(15,157,123,.18)' : C.receive[50]) : (onNavy ? 'rgba(217,97,74,.2)' : C.pay[50]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 999, background: bg, fontSize: 11, fontWeight: 600, color: fg }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ transform: good ? 'none' : 'rotate(180deg)' }}><path d="M5 14l7-7 7 7M12 7v13" stroke={fg} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {children}
    </span>
  );
}

Object.assign(window, {
  AISpark: Spark, StatusBar, AIFrame, AIHeroHead, AskBar, ChipRow,
  CategoryBars, AICard: Card, CutCard, NudgeCard, WrapTeaser, AISec,
  Sparkline, DeltaChip, shortAmt,
});
