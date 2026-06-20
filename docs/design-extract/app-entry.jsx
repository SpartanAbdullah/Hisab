// Hisaab AI tab — design-canvas composition.
// All seven states as phone artboards across two sections, plus a Tweaks
// panel (accent, nudge tone) wired through window.CoachCtx so atoms that read
// the context (CoachNav, IconTile) pick up the live accent.

const CV = window.SukoonTokens;

function AICanvasApp() {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "accent": "#5B47E8",
    "nudgeTone": "friendly",
    "urdu": true
  }/*EDITMODE-END*/;
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const accent = t.accent;

  // Context so CoachNav renders with the right accent + the AI tab active.
  const ctx = {
    accent, tone: 'warm', scoreStyle: 'ring',
    screen: 'ai', go: () => {}, openAdd: () => {}, openSheet: () => {},
  };

  const abStyle = { background: CV.cream.bg, borderRadius: 30 };

  return (
    <window.CoachCtx.Provider value={ctx}>
      <window.DesignCanvas>
        <window.DCSection id="feed" title="Hisaab AI · Main feed"
          subtitle="Two directions for the default, populated state — pick one to take forward.">
          <window.DCArtboard id="feed-a" label="A · Insight-led" width={402} height={1408} style={abStyle}>
            <window.FeedInsightLed accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="feed-b" label="B · Ask-led" width={402} height={1392} style={abStyle}>
            <window.FeedAskLed accent={accent} />
          </window.DCArtboard>
        </window.DCSection>

        <window.DCSection id="states" title="States"
          subtitle="Cold start, conversation, drill-down, thinking, the wrap moment, and the premium gate.">
          <window.DCArtboard id="cold" label="Cold start · new user" width={402} height={1180} style={abStyle}>
            <window.ColdStart accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="convo" label="Conversation" width={402} height={1320} style={abStyle}>
            <window.Conversation accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="detail" label="Insight detail · Dining" width={402} height={1300} style={abStyle}>
            <window.InsightDetail accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="thinking" label="Thinking / loading" width={402} height={872} style={abStyle}>
            <window.Thinking accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="wrap" label="Monthly wrap" width={402} height={1300} style={abStyle}>
            <window.MonthlyWrap accent={accent} />
          </window.DCArtboard>
          <window.DCArtboard id="upgrade" label="Upgrade moment" width={402} height={1280} style={abStyle}>
            <window.Upgrade accent={accent} />
          </window.DCArtboard>
        </window.DCSection>

        {/* a couple of orientation notes on the canvas */}
        <window.DCSection id="notes" title="Where the AI tab lives"
          subtitle="Nav placement & how it connects to the rest of Hisaab.">
          <window.DCArtboard id="nav-note" label="Bottom nav" width={402} height={300}
            style={{ background: '#fff', borderRadius: 18 }}>
            <NavNote accent={accent} />
          </window.DCArtboard>
        </window.DCSection>
      </window.DesignCanvas>

      <TweaksPanel>
        <TweakSection label="Brand accent" />
        <TweakColor label="Accent" value={t.accent}
          options={['#5B47E8', '#7C5CFF', '#2A6CDB', '#0F8466', '#B4452C']}
          onChange={(v) => setTweak('accent', v)} />
        <TweakSection label="Proactive nudges" />
        <TweakRadio label="Tone" value={t.nudgeTone} options={['friendly', 'direct']}
          onChange={(v) => setTweak('nudgeTone', v)} />
        <TweakSection label="Microcopy" />
        <TweakToggle label="Roman-Urdu touches" value={t.urdu}
          onChange={(v) => setTweak('urdu', v)} />
      </TweaksPanel>
    </window.CoachCtx.Provider>
  );
}

// A small explainer card placed on the canvas.
function NavNote({ accent }) {
  const items = [
    { id: 'home', label: 'Home' },
    { id: 'loans', label: 'Loans' },
    { id: 'fab' },
    { id: 'ai', label: 'Hisaab AI' },
    { id: 'splits', label: 'Splits' },
  ];
  return (
    <div style={{ padding: '20px 20px 0', fontFamily: CV.fontBody, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: CV.ink[900], letterSpacing: '-0.01em' }}>Hisaab AI keeps its own tab</div>
      <div style={{ fontSize: 12, color: CV.ink[600], lineHeight: 1.5, marginTop: 8 }}>
        It sits in the 4th slot — a persistent home for intelligence, beside the central <span style={{ color: accent, fontWeight: 600 }}>＋</span> quick-add. Tapping a category insight opens <strong>Insight detail</strong>; cut cards deep-link into <strong>Subscriptions</strong>; the wrap pulls from <strong>Analytics</strong>.
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ position: 'relative', height: 80, margin: '0 -20px' }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, background: 'rgba(255,255,255,.95)', borderTop: `1px solid ${CV.cream.border}`, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', alignItems: 'center', paddingBottom: 10 }}>
            {items.map((it) => {
              if (it.id === 'fab') return (
                <div key="fab" style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: 50, height: 50, borderRadius: 17, marginTop: -22, background: `linear-gradient(135deg, ${CV.accent[500]}, ${accent})`, boxShadow: `0 8px 20px -4px ${accent}66, 0 0 0 4px ${CV.cream.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                  </div>
                </div>
              );
              const active = it.id === 'ai';
              return (
                <div key={it.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: active ? accent : CV.ink[500] }}>
                  <window.NavIcon id={it.id} filled={active} size={21} />
                  <div style={{ fontSize: 9, fontWeight: active ? 600 : 500 }}>{it.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AICanvasApp />);
