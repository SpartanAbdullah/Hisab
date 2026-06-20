// Hisaab 2.0 · Coach — shared atoms, phone frame, bottom nav, health ring.
// Builds on the Sukoon system (tokens.jsx + primitives.jsx). Every coach
// screen composes these. Context carries tweak state + navigation handlers.

const C = window.SukoonTokens;
const CCUR = window.SukoonCurrencies;

// Shared app context — accent (live tweak), tone, score style, navigation.
const CoachCtx = React.createContext({
  accent: C.accent[600], tone: 'warm', scoreStyle: 'ring',
  screen: 'home', go: () => {}, openAdd: () => {}, openSheet: () => {},
});

// ─── Navy hero (deep navy + violet bloom) ─────────────────────
function CoachHero({ children, style = {}, pad = '4px 20px 26px' }) {
  return (
    <div style={{ position: 'relative', background: C.navy[800], color: '#fff', overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', inset: 0, background: C.navy.bloom, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', zIndex: 1, padding: pad }}>{children}</div>
    </div>
  );
}

// ─── Header: greeting OR titled top bar ───────────────────────
function HeroTop({ title, back, action }) {
  const { go } = React.useContext(CoachCtx);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 14px' }}>
      {back && (
        <div onClick={() => go(back)} style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      )}
      <div style={{ flex: 1, fontSize: 17, fontWeight: 600, letterSpacing: '-0.015em' }}>{title}</div>
      {action}
    </div>
  );
}

// Small round icon tile used in hero corners.
function IconTile({ children, onClick, dot, dark = true, size = 32 }) {
  return (
    <div onClick={onClick} style={{ width: size, height: size, borderRadius: 11, background: dark ? 'rgba(255,255,255,.09)' : C.cream.soft, border: dark ? 'none' : `1px solid ${C.cream.hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', cursor: onClick ? 'pointer' : 'default', flexShrink: 0 }}>
      {children}
      {dot && <div style={{ position: 'absolute', top: 7, right: 8, width: 6, height: 6, borderRadius: 3, background: C.pay[600], border: `1.5px solid ${C.navy[800]}` }} />}
    </div>
  );
}

// ─── Health ring — animated SVG donut, colored by score band ──
function bandColor(score) {
  if (score >= 80) return C.receive[600];
  if (score >= 60) return C.warn[600];
  return C.pay[600];
}
function HealthRing({ score = 82, size = 104, stroke = 11, track = 'rgba(255,255,255,.13)', label = true }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  // Render the arc at its true value immediately (no rAF dependency) so the
  // fill is correct even when the tab is backgrounded; CSS eases later changes.
  const shown = score;
  const col = bandColor(score);
  const off = circ * (1 - score / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(.2,.7,.3,1), stroke 200ms' }} />
      </svg>
      {label && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: C.fontDisplay }}>
          <div style={{ fontSize: size * 0.34, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{shown}</div>
          <div style={{ fontSize: size * 0.10, fontWeight: 500, color: 'rgba(255,255,255,.5)', marginTop: 2 }}>/ 100</div>
        </div>
      )}
    </div>
  );
}

// ─── Streak chip ──────────────────────────────────────────────
function StreakChip({ icon = '🔥', n, label, done = false }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, background: C.cream.card, border: `1px solid ${C.cream.border}`, borderRadius: 14, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 15, lineHeight: 1 }}>{done ? '✓' : icon}</span>
        {n != null && <span style={{ fontSize: 17, fontWeight: 600, color: C.ink[900], letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{n}</span>}
      </div>
      <div style={{ fontSize: 10.5, fontWeight: 500, color: C.ink[600], lineHeight: 1.25 }}>{label}</div>
    </div>
  );
}

// ─── Stat cell (Today's snapshot) ─────────────────────────────
function StatCell({ label, value, unit, sub, accent, progress }) {
  return (
    <div style={{ padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 10.5, fontWeight: 500, color: C.ink[500], letterSpacing: '0.01em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 600, color: accent || C.ink[900], letterSpacing: '-0.025em', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: 11, fontWeight: 500, color: C.ink[500] }}>{unit}</span>}
      </div>
      {progress != null && (
        <div style={{ height: 4, borderRadius: 99, background: C.ink[200], marginTop: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', borderRadius: 99, background: accent || C.receive[600] }} />
        </div>
      )}
      {sub && <div style={{ fontSize: 10.5, color: C.ink[500], marginTop: progress != null ? 1 : 0 }}>{sub}</div>}
    </div>
  );
}

// ─── Section label (cream) ────────────────────────────────────
function SecLabel({ children, action, onAction }) {
  const { accent } = React.useContext(CoachCtx);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 10px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.ink[500] }}>{children}</div>
      {action && <div onClick={onAction} style={{ fontSize: 11.5, fontWeight: 600, color: accent, cursor: onAction ? 'pointer' : 'default' }}>{action}</div>}
    </div>
  );
}

// ─── Brand-ish subscription / merchant tile (flat letter, not a logo) ──
function MerchTile({ name, color, size = 38, radius = 12 }) {
  const letter = (name || '?').trim()[0]?.toUpperCase() || '?';
  return (
    <div style={{ width: size, height: size, borderRadius: radius, background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.42, fontFamily: 'Geist Mono, monospace', flexShrink: 0, letterSpacing: '-0.02em' }}>{letter}</div>
  );
}

// ─── Cream pill button ────────────────────────────────────────
function GhostBtn({ children, onClick, dashed = false, full = true }) {
  return (
    <button onClick={onClick} style={{ width: full ? '100%' : 'auto', padding: '13px 16px', borderRadius: 14, background: 'transparent', border: dashed ? `1.5px dashed ${C.cream.border}` : `1px solid ${C.cream.border}`, color: C.ink[700], fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>{children}</button>
  );
}

// ─── Bottom nav — Home · Loans · [+] · Hisaab AI · Splits ─────
function NavIcon({ id, size = 23, filled }) {
  const s = { width: size, height: size };
  if (id === 'home') return <svg {...s} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8}><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-9z" strokeLinejoin="round" /></svg>;
  if (id === 'loans') return <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3.4" fill={filled ? 'currentColor' : 'none'} /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9.5" r="2.6" /><path d="M16 20c0-2.5 1.4-4.4 3.8-5" /></svg>;
  if (id === 'ai') return <svg {...s} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7"><path d="M12 3l1.6 4.8L18.5 9l-4.9 1.4L12 15l-1.6-4.6L5.5 9l4.9-1.2L12 3z" strokeLinejoin="round" /><path d="M18 14.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1z" strokeLinejoin="round" /></svg>;
  if (id === 'splits') return <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8.5" cy="12" r="5" fill={filled ? 'currentColor' : 'none'} /><circle cx="15.5" cy="12" r="5" /></svg>;
  return null;
}
function CoachNav() {
  const { screen, go, openAdd, accent } = React.useContext(CoachCtx);
  const items = [
    { id: 'home', label: 'Home' },
    { id: 'loans', label: 'Loans' },
    { id: 'fab' },
    { id: 'ai', label: 'Hisaab AI' },
    { id: 'splits', label: 'Splits' },
  ];
  return (
    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderTop: `1px solid rgba(234,229,217,.7)`, paddingBottom: 18, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', alignItems: 'center', zIndex: 30 }}>
      {items.map(it => {
        if (it.id === 'fab') return (
          <div key="fab" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <div onClick={openAdd} style={{ width: 56, height: 56, borderRadius: 19, marginTop: -24, background: `linear-gradient(135deg, ${C.accent[500]}, ${accent})`, boxShadow: `0 8px 22px -2px ${accent}66, 0 0 0 4px ${C.cream.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer' }}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
            </div>
          </div>
        );
        const active = screen === it.id;
        const isAI = it.id === 'ai';
        const col = active ? (isAI ? accent : C.ink[900]) : C.ink[500];
        return (
          <div key={it.id} onClick={() => go(it.id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: col, cursor: 'pointer' }}>
            <NavIcon id={it.id} filled={active} />
            <div style={{ fontSize: 9.5, fontWeight: active ? 600 : 500 }}>{it.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Phone frame (interactive, scaled to fit) ─────────────────
function CoachPhone({ children, overlay, scale = 1 }) {
  return (
    <div style={{ width: 402, height: 872, borderRadius: 52, position: 'relative', background: C.cream.bg, overflow: 'hidden', boxShadow: '0 40px 80px -24px rgba(11,14,42,.4), 0 0 0 10px #0A0C20, 0 0 0 11px #23264A', fontFamily: C.fontBody, color: C.ink[900], WebkitFontSmoothing: 'antialiased', transform: `scale(${scale})`, transformOrigin: 'center center' }}>
      {/* dynamic island */}
      <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', width: 116, height: 33, borderRadius: 20, background: '#000', zIndex: 70 }} />
      {/* status bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 54, zIndex: 65, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 28px 0', boxSizing: 'border-box', fontWeight: 600, fontSize: 15, color: '#fff', mixBlendMode: 'difference' }}>
        <span>9:41</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <svg width="17" height="11" viewBox="0 0 17 11"><g fill="#fff"><rect x="0" y="7" width="2.6" height="4" rx="0.5" /><rect x="4" y="5" width="2.6" height="6" rx="0.5" /><rect x="8" y="2.7" width="2.6" height="8.3" rx="0.5" /><rect x="12" y="0" width="2.6" height="11" rx="0.5" /></g></svg>
          <svg width="22" height="11" viewBox="0 0 22 11"><rect x="0.5" y="0.5" width="19" height="10" rx="2.5" stroke="#fff" strokeOpacity=".5" fill="none" /><rect x="2" y="2" width="15.5" height="7" rx="1.3" fill="#fff" /><path d="M21 4v3c.6-.25 1-.8 1-1.5s-.4-1.25-1-1.5z" fill="#fff" fillOpacity=".5" /></svg>
        </div>
      </div>
      {/* screen */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
      {overlay}
      {/* home indicator */}
      <div style={{ position: 'absolute', bottom: 9, left: '50%', transform: 'translateX(-50%)', width: 134, height: 5, borderRadius: 100, zIndex: 60, background: 'rgba(14,16,43,.28)', mixBlendMode: 'multiply' }} />
    </div>
  );
}

// ─── Scrollable screen body (cream, sits under hero) ──────────
function ScreenScroll({ children, pull = true }) {
  return (
    <div className="coach-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', background: C.cream.bg }}>
      {children}
    </div>
  );
}
function CreamBody({ children, pad = '22px 0 108px' }) {
  return (
    <div style={{ background: C.cream.bg, marginTop: -16, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: pad, position: 'relative', minHeight: 1 }}>
      {children}
    </div>
  );
}

Object.assign(window, {
  CoachCtx, CoachHero, HeroTop, IconTile, HealthRing, bandColor,
  StreakChip, StatCell, SecLabel, MerchTile, GhostBtn,
  CoachNav, NavIcon, CoachPhone, ScreenScroll, CreamBody,
});
