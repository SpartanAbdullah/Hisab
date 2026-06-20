// Shared screen primitives for the Sukoon redesign.
// Phone bezel + all building blocks used across 11+ screens.
// Compact by design — every screen composes these.

const T = window.SukoonTokens;
const CUR = window.SukoonCurrencies;

// ─── Phone bezel ──────────────────────────────────────────────
// 360 × 760 — smaller than IOS frame so the canvas stays browsable
// with 12+ phones laid out. Dynamic island + home indicator kept.
function Phone({ children, dark = false, status = 'light', tag, label }) {
  const bg = dark ? T.navy[900] : T.cream.bg;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 360, height: 760, borderRadius: 42, position: 'relative',
        background: bg, overflow: 'hidden',
        boxShadow: '0 30px 60px -20px rgba(11,14,42,.25), 0 0 0 9px #0A0C20, 0 0 0 10px #1F2240',
        fontFamily: T.fontBody, color: dark ? '#fff' : T.ink[900],
        WebkitFontSmoothing: 'antialiased',
      }}>
        {/* dynamic island */}
        <div style={{
          position: 'absolute', top: 9, left: '50%', transform: 'translateX(-50%)',
          width: 105, height: 30, borderRadius: 20, background: '#000', zIndex: 60,
        }} />
        {/* status bar */}
        <PhoneStatus dark={status === 'dark'} />
        {/* screen */}
        <div style={{ position: 'absolute', inset: 0, paddingTop: 47, paddingBottom: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            {children}
          </div>
        </div>
        {/* home indicator */}
        <div style={{
          position: 'absolute', bottom: 7, left: '50%', transform: 'translateX(-50%)',
          width: 124, height: 4.5, borderRadius: 100, zIndex: 60,
          background: dark ? 'rgba(255,255,255,.7)' : 'rgba(14,16,43,.32)',
        }} />
        {tag && <div style={{
          position: 'absolute', top: 14, right: 18, fontSize: 9, fontWeight: 600,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: dark ? 'rgba(255,255,255,.5)' : 'rgba(14,16,43,.35)',
        }}>{tag}</div>}
      </div>
      {label && <div style={{
        fontFamily: T.fontDisplay, fontSize: 11, fontWeight: 500, color: 'rgba(40,30,20,.6)',
        textAlign: 'center', maxWidth: 360,
      }}>{label}</div>}
    </div>
  );
}

function PhoneStatus({ dark = false, time = '9:41' }) {
  const c = dark ? '#fff' : T.ink[900];
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 47, zIndex: 30,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 24px 0', boxSizing: 'border-box',
      fontFamily: T.fontDisplay, fontWeight: 600, fontSize: 14, color: c,
    }}>
      <span style={{ marginTop: 4 }}>{time}</span>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 4 }}>
        {/* signal */}
        <svg width="16" height="10" viewBox="0 0 16 10"><g fill={c}>
          <rect x="0" y="6.5" width="2.5" height="3.5" rx="0.5"/>
          <rect x="3.7" y="4.5" width="2.5" height="5.5" rx="0.5"/>
          <rect x="7.4" y="2.5" width="2.5" height="7.5" rx="0.5"/>
          <rect x="11.1" y="0" width="2.5" height="10" rx="0.5"/>
        </g></svg>
        {/* wifi */}
        <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
          <path d="M7 2.5c1.9 0 3.6.7 4.9 1.9l1-1A8 8 0 0 0 7 1a8 8 0 0 0-5.9 2.4l1 1A6.9 6.9 0 0 1 7 2.5z" fill={c}/>
          <path d="M7 5.6c1.2 0 2.2.4 3 1.2l1-1A5 5 0 0 0 7 4.3a5 5 0 0 0-4 1.5l1 1c.8-.8 1.8-1.2 3-1.2z" fill={c}/>
          <circle cx="7" cy="8.6" r="1.2" fill={c}/>
        </svg>
        {/* battery */}
        <svg width="22" height="10" viewBox="0 0 22 10">
          <rect x="0.5" y="0.5" width="19" height="9" rx="2" stroke={c} strokeOpacity=".4" fill="none"/>
          <rect x="2" y="2" width="16" height="6" rx="1" fill={c}/>
          <path d="M20.5 3.5v3c.6-.2 1-.7 1-1.5s-.4-1.3-1-1.5z" fill={c} fillOpacity=".4"/>
        </svg>
      </div>
    </div>
  );
}

// ─── Avatar ──────────────────────────────────────────────────
function Avatar({ name = '?', size = 36, flag, dark = false, ring = false }) {
  const [bg, fg] = window.pickAvatarColor(name);
  const initials = (name || '?').trim().split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase().slice(0,2);
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: bg, color: fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 600, fontSize: size * 0.36,
        fontFamily: T.fontDisplay, letterSpacing: '-0.01em',
        boxShadow: ring ? '0 0 0 2px ' + (dark ? 'rgba(255,255,255,.18)' : '#fff') : 'none',
      }}>{initials}</div>
      {flag && (
        <div style={{
          position: 'absolute', bottom: -2, right: -2,
          width: size * 0.42, height: size * 0.42,
          borderRadius: '50%', background: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.30,
          boxShadow: '0 1px 3px rgba(0,0,0,.15)',
        }}>{flag}</div>
      )}
    </div>
  );
}

// ─── Bottom nav (light variant, used on body screens) ────────
function BottomNav({ active = 'home', dark = false, hideFab = false }) {
  const items = [
    { id: 'home', label: 'Home', icon: IconHome },
    { id: 'ledger', label: 'Ledger', icon: IconLedger },
    { id: 'fab', label: '', icon: null, fab: true },
    { id: 'people', label: 'People', icon: IconPeople },
    { id: 'inbox', label: 'Inbox', icon: IconInbox, badge: 2 },
  ];
  const surface = dark ? 'rgba(20,23,55,.85)' : 'rgba(255,255,255,.92)';
  const border  = dark ? 'rgba(255,255,255,.06)' : 'rgba(234,229,217,.7)';
  const ink     = dark ? 'rgba(255,255,255,.55)' : T.ink[500];
  const inkActive = dark ? '#fff' : T.ink[900];
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, height: 78,
      background: surface, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderTop: `1px solid ${border}`, paddingBottom: 16,
      display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', alignItems: 'center',
      zIndex: 20,
    }}>
      {items.map(it => {
        if (it.fab) {
          if (hideFab) return <div key="fab" />;
          return (
            <div key="fab" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
              <div style={{
                width: 54, height: 54, borderRadius: 18, marginTop: -22,
                background: `linear-gradient(135deg, ${T.accent[500]}, ${T.accent[600]})`,
                boxShadow: `0 8px 20px -2px ${T.accent[500]}66, 0 0 0 4px ${dark ? T.navy[900] : T.cream.bg}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/>
                </svg>
              </div>
            </div>
          );
        }
        const Icon = it.icon;
        const isActive = active === it.id;
        return (
          <div key={it.id} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: isActive ? inkActive : ink, position: 'relative',
          }}>
            <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <Icon size={22} filled={isActive} />
              {it.badge ? <div style={{
                position: 'absolute', top: -3, right: -7, minWidth: 14, height: 14, borderRadius: 7,
                background: T.pay[600], color: '#fff', fontSize: 9, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
              }}>{it.badge}</div> : null}
            </div>
            <div style={{ fontSize: 9.5, fontWeight: isActive ? 600 : 500, letterSpacing: 0 }}>{it.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Icons (line, with optional fill on active) ──────────────
function IconHome({ size = 22, filled }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8}>
    <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-9z" strokeLinejoin="round"/>
  </svg>;
}
function IconLedger({ size = 22, filled }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8}>
    <rect x="4" y="3" width="16" height="18" rx="2"/>
    <path d="M8 8h8M8 12h8M8 16h5" stroke={filled ? '#fff' : 'currentColor'} strokeWidth="1.6" strokeLinecap="round"/>
  </svg>;
}
function IconPeople({ size = 22, filled }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8}>
    <circle cx="9" cy="8" r="3.4"/>
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
    <circle cx="17" cy="9.5" r="2.6" fill="none" stroke="currentColor"/>
    <path d="M15.5 20c0-2.5 1.6-4.5 4-5" fill="none" stroke="currentColor"/>
  </svg>;
}
function IconInbox({ size = 22, filled }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8}>
    <path d="M4 13l2-8h12l2 8v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6z" strokeLinejoin="round"/>
    <path d="M4 13h5l1 2h4l1-2h5" stroke={filled ? '#fff' : 'currentColor'} strokeWidth="1.6"/>
  </svg>;
}

// ─── Small components ────────────────────────────────────────
function Chip({ children, tone = 'neutral', size = 'md' }) {
  const tones = {
    neutral: { bg: '#FFFFFF', fg: T.ink[800], bd: T.cream.border },
    receive: { bg: T.receive.chip, fg: T.receive.text, bd: 'transparent' },
    pay:     { bg: T.pay.chip, fg: T.pay.text, bd: 'transparent' },
    accent:  { bg: T.accent[100], fg: T.accent[600], bd: 'transparent' },
    dark:    { bg: 'rgba(255,255,255,.10)', fg: 'rgba(255,255,255,.9)', bd: 'rgba(255,255,255,.14)' },
    warn:    { bg: T.warn[50], fg: T.warn[600], bd: 'transparent' },
  };
  const t = tones[tone];
  const pad = size === 'sm' ? '3px 8px' : '5px 10px';
  return <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    borderRadius: 999, padding: pad, fontSize: size === 'sm' ? 10 : 11,
    fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap',
  }}>{children}</span>;
}

function PillToggle({ options, value, dark = false }) {
  const bg = dark ? 'rgba(255,255,255,.07)' : '#fff';
  const bd = dark ? 'rgba(255,255,255,.10)' : T.cream.border;
  const activeFg = dark ? T.navy[900] : '#fff';
  const activeBg = dark ? '#fff' : T.ink[900];
  const muted = dark ? 'rgba(255,255,255,.55)' : T.ink[500];
  return (
    <div style={{
      display: 'inline-flex', background: bg, border: `1px solid ${bd}`,
      borderRadius: 999, padding: 3,
    }}>
      {options.map(o => (
        <div key={o} style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          borderRadius: 999,
          background: o === value ? activeBg : 'transparent',
          color: o === value ? activeFg : muted,
        }}>{o}</div>
      ))}
    </div>
  );
}

// "AED 12,450" with overlap: massive integer, smaller cents.
function MoneyDisplay({ amount, currency = 'AED', size = 36, color = '#fff', muted = 'rgba(255,255,255,.5)', dim = false }) {
  const abs = Math.abs(amount);
  const intPart = Math.floor(abs).toLocaleString('en-US');
  const cents = (abs - Math.floor(abs)).toFixed(2).slice(2);
  return (
    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, fontFamily: T.fontDisplay, letterSpacing: '-0.025em' }}>
      <span style={{ fontSize: size * 0.45, fontWeight: 500, color: muted }}>{currency}</span>
      <span style={{ fontSize: size, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums', filter: dim ? 'blur(8px)' : 'none' }}>{amount < 0 ? '−' : ''}{intPart}</span>
      <span style={{ fontSize: size * 0.42, fontWeight: 500, color: muted, fontVariantNumeric: 'tabular-nums', filter: dim ? 'blur(6px)' : 'none' }}>.{cents}</span>
    </div>
  );
}

function Card({ children, style, pad = 16 }) {
  return <div style={{
    background: T.cream.card, border: `1px solid ${T.cream.border}`,
    borderRadius: 20, padding: pad, ...style,
  }}>{children}</div>;
}

function SectionLabel({ children, action, dark = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 20px 10px',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: dark ? 'rgba(255,255,255,.45)' : T.ink[500],
      }}>{children}</div>
      {action && <div style={{ fontSize: 11, fontWeight: 600, color: dark ? '#fff' : T.accent[600] }}>{action}</div>}
    </div>
  );
}

// Subtle row used in lists (settings, contacts, transactions)
function Row({ left, title, sub, right, sub2, divider = true }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', minHeight: 56,
      borderBottom: divider ? `1px solid ${T.cream.hairline}` : 'none',
    }}>
      {left && <div style={{ flexShrink: 0 }}>{left}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: T.ink[900], letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: T.ink[500], marginTop: 2 }}>{sub}</div>}
      </div>
      {(right || sub2) && (
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          {right && <div>{right}</div>}
          {sub2 && <div style={{ fontSize: 11, color: T.ink[400], marginTop: 2 }}>{sub2}</div>}
        </div>
      )}
    </div>
  );
}

// Top header bar (back, title, action)
function TopBar({ title, back = false, dark = false, action }) {
  const fg = dark ? '#fff' : T.ink[900];
  const subtle = dark ? 'rgba(255,255,255,.7)' : T.ink[600];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '6px 16px 12px',
      gap: 12, position: 'relative', zIndex: 5,
    }}>
      {back ? (
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: dark ? 'rgba(255,255,255,.08)' : 'rgba(14,16,43,.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M15 6l-6 6 6 6" stroke={fg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ) : null}
      <div style={{ flex: 1, fontSize: 17, fontWeight: 600, color: fg, letterSpacing: '-0.015em' }}>{title}</div>
      {action}
    </div>
  );
}

// Reusable transaction line with avatar + meta + amount on the right
function TxLine({ name, kind, currency, amount, sign, when, divider = true, last = false }) {
  const color = sign === '+' ? T.receive.text : sign === '-' ? T.pay.text : T.ink[900];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
      borderBottom: divider && !last ? `1px solid ${T.cream.hairline}` : 'none',
    }}>
      <Avatar name={name} size={36} flag={currency ? CUR[currency]?.flag : null} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: T.ink[900], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11, color: T.ink[500], marginTop: 1 }}>{kind}{when ? ` · ${when}` : ''}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{
          fontSize: 13.5, fontWeight: 600, color,
          fontFamily: T.fontNumeric, fontVariantNumeric: 'tabular-nums',
        }}>{sign}{amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        <div style={{ fontSize: 10, color: T.ink[400], marginTop: 1 }}>{currency}</div>
      </div>
    </div>
  );
}

Object.assign(window, {
  Phone, PhoneStatus, Avatar, BottomNav, Chip, PillToggle, MoneyDisplay,
  Card, SectionLabel, Row, TopBar, TxLine,
  IconHome, IconLedger, IconPeople, IconInbox,
});
