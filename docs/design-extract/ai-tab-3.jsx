// Hisaab AI tab — Conversation, Insight detail, Thinking, Upgrade.

const S = window.SukoonTokens;

// ─── chat bubbles ───
function UserBubble({ children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
      <div style={{ maxWidth: '80%', padding: '10px 14px', borderRadius: 16, borderBottomRightRadius: 5, background: S.ink[900], color: '#fff', fontSize: 13, lineHeight: 1.45, letterSpacing: '-0.005em' }}>{children}</div>
    </div>
  );
}
function AIBubble({ children }) {
  return (
    <div style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
      <div style={{ width: 26, height: 26, borderRadius: 9, background: `linear-gradient(135deg, ${S.accent[500]}, ${S.accent[600]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
        <window.AISpark size={14} color="#fff" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ background: '#fff', border: `1px solid ${S.cream.border}`, borderRadius: 16, borderTopLeftRadius: 5, padding: '13px 14px', fontSize: 13, lineHeight: 1.5, color: S.ink[800], letterSpacing: '-0.005em' }}>{children}</div>
      </div>
    </div>
  );
}

// inline mini horizontal-bar breakdown for a chat answer
function MiniBreakdown({ rows }) {
  const max = Math.max(...rows.map((r) => r.amt));
  return (
    <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map((r) => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 64, fontSize: 11.5, color: S.ink[600], flexShrink: 0 }}>{r.name}</div>
          <div style={{ flex: 1, height: 8, borderRadius: 99, background: S.cream.soft, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((r.amt / max) * 100)}%`, height: '100%', borderRadius: 99, background: r.color }} />
          </div>
          <div style={{ width: 42, textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: S.ink[900], fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{r.amt}</div>
        </div>
      ))}
    </div>
  );
}

// inline answer: a single big number + a budget meter (afford? questions)
function AffordMeter({ label, used, total, accent }) {
  const pct = Math.min(1, used / total);
  return (
    <div style={{ marginTop: 11, background: S.cream.soft, borderRadius: 12, padding: '12px 13px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, color: S.ink[600], fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: S.ink[900], fontVariantNumeric: 'tabular-nums' }}>{used} / {total} AED</span>
      </div>
      <div style={{ height: 9, borderRadius: 99, background: S.ink[200], overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 99, background: pct > 0.9 ? S.pay.text : S.receive.text }} />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// CONVERSATION — 3 turns, each answer = short text + a small visual.
// ════════════════════════════════════════════════════════════════
function Conversation({ accent = S.accent[600] }) {
  return (
    <window.AIFrame height={1320}>
      <window.CoachHero pad="14px 20px 18px">
        <window.StatusBar />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#fff', letterSpacing: '-0.015em' }}>Ask Hisaab</span>
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', padding: '3px 6px', borderRadius: 999, background: 'rgba(255,255,255,.13)', color: 'rgba(255,255,255,.8)' }}>BETA</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'rgba(255,255,255,.6)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z" stroke="rgba(255,255,255,.6)" strokeWidth="1.6" strokeLinejoin="round" /></svg>
            On-device
          </div>
        </div>
      </window.CoachHero>

      <window.CreamBody pad="18px 0 150px">
        <div style={{ padding: '0 16px' }}>
          {/* turn 1 */}
          <UserBubble>Where did my money go last month?</UserBubble>
          <AIBubble>
            <div>You spent <strong style={{ color: S.ink[900] }}>AED 4,820</strong> in June across six categories. Here are the top four:</div>
            <MiniBreakdown rows={[
              { name: 'Dining', amt: 1540, color: S.pay.text },
              { name: 'Grocery', amt: 890, color: S.receive.text },
              { name: 'Bills', amt: 760, color: S.info[600] },
              { name: 'Transport', amt: 620, color: S.ink[400] },
            ]} />
            <div style={{ marginTop: 11, color: S.ink[600] }}>Dining is a third of it — want a weekly cap?</div>
          </AIBubble>

          {/* turn 2 */}
          <UserBubble>Can I afford AED 1,200 on dinner this week?</UserBubble>
          <AIBubble>
            <div>Carefully, yes. You've used <strong style={{ color: S.ink[900] }}>AED 420</strong> of your AED 1,600 dining budget this week — AED 1,180 left.</div>
            <AffordMeter label="Dining budget · this week" used={420} total={1600} accent={accent} />
            <div style={{ marginTop: 11, color: S.ink[600] }}>That AED 1,200 fits, but it leaves almost nothing for the weekend. Split it across two nights?</div>
          </AIBubble>

          {/* turn 3 */}
          <UserBubble>How much on groceries?</UserBubble>
          <AIBubble>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <strong style={{ color: S.ink[900] }}>AED 890</strong> across 9 trips — steady, slightly down from May.
              </div>
              <window.Sparkline pts={[120, 90, 150, 80, 110, 95, 70, 85]} color={S.receive.text} w={84} h={32} />
            </div>
          </AIBubble>
        </div>
      </window.CreamBody>

      {/* pinned input + suggestions */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 80, padding: '10px 14px 12px', background: 'linear-gradient(to top, rgba(244,242,236,1) 60%, rgba(244,242,236,0))' }}>
        <div className="coach-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 9 }}>
          {['Set a dining cap', 'Biggest expense?', 'Can I save more?'].map((q) => (
            <div key={q} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 500, padding: '7px 12px', borderRadius: 999, background: '#fff', border: `1px solid ${S.cream.border}`, color: S.ink[700], whiteSpace: 'nowrap' }}>{q}</div>
          ))}
        </div>
        <window.AskBar accent={accent} placeholder="Ask Hisaab…" />
      </div>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// INSIGHT DETAIL — drill into Dining.
// ════════════════════════════════════════════════════════════════
function InsightDetail({ accent = S.accent[600] }) {
  const weeks = [
    { name: 'Wk 1', amt: 310 },
    { name: 'Wk 2', amt: 360 },
    { name: 'Wk 3', amt: 410, color: S.pay.text, note: 'peak' },
    { name: 'Wk 4', amt: 460, color: S.pay.text, note: '↑18%' },
  ];
  const merchants = [
    { name: 'Talabat', sub: '11 orders · weekday lunch', amt: 612, color: '#FF6D2E' },
    { name: 'Careem Food', sub: '6 orders', amt: 388, color: '#3DDB85' },
    { name: 'Allo Beirut', sub: '3 visits', amt: 290, color: '#C79A4A' },
    { name: 'Café misc.', sub: '9 small charges', amt: 250, color: S.ink[400] },
  ];
  return (
    <window.AIFrame height={1300}>
      <window.CoachHero pad="14px 20px 26px">
        <window.StatusBar />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 18 }}>
          <div style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Dining</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>🍽️</div>
        </div>

        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Spent on dining · June</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 0.9, fontVariantNumeric: 'tabular-nums' }}>1,540</span>
            <span style={{ fontSize: 16, fontWeight: 500, color: 'rgba(255,255,255,.5)' }}>AED</span>
          </div>
          <div style={{ marginBottom: 3 }}><window.DeltaChip good={false}>18% vs May</window.DeltaChip></div>
        </div>
        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.75)', lineHeight: 1.5, marginTop: 13 }}>
          It's climbed every week this month. Mostly <strong style={{ color: '#fff', fontWeight: 600 }}>weekday lunch delivery</strong> — AED 38 average across 21 orders.
        </div>
      </window.CoachHero>

      <window.CreamBody pad="22px 0 112px">
        {/* by week */}
        <window.AISec>By week</window.AISec>
        <div style={{ padding: '0 20px' }}>
          <window.AICard pad="16px 16px 14px"><window.CategoryBars data={weeks} areaH={120} /></window.AICard>
        </div>

        {/* by merchant */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>Where it went</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.AICard pad="6px 0">
              {merchants.map((m, i) => (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 15px', borderTop: i ? `1px solid ${S.cream.hairline}` : 'none' }}>
                  <window.MerchTile name={m.name} color={m.color} size={34} radius={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: S.ink[900] }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: S.ink[500], marginTop: 1 }}>{m.sub}</div>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: S.pay.text, fontVariantNumeric: 'tabular-nums' }}>−{m.amt}</div>
                </div>
              ))}
            </window.AICard>
          </div>
        </div>

        {/* tied cut suggestion */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>One way to ease it</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.NudgeCard kind="streak" title="Bring lunch 3 days a week"
              body="Swaps ~12 delivery orders → roughly AED 410/mo back. I'll track it for you." action="Try it" accent={accent} />
          </div>
        </div>

        {/* contextual ask */}
        <div style={{ marginTop: 20, padding: '0 20px' }}>
          <window.AskBar accent={accent} placeholder="Ask about dining…" />
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// THINKING / LOADING — calm, on-brand. Pulsing bloom + shimmer, not a spinner.
// ════════════════════════════════════════════════════════════════
function Thinking({ accent = S.accent[600] }) {
  return (
    <window.AIFrame height={872}>
      <window.CoachHero pad="14px 20px 26px" style={{ height: '100%' }}>
        <window.StatusBar />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600, color: '#fff', letterSpacing: '-0.015em' }}>Hisaab AI</div>
        </div>
      </window.CoachHero>

      {/* centered calm thinking state — sibling of the hero so it centers in
          the full screen, not the hero's padding box */}
      <div style={{ position: 'absolute', inset: 0, bottom: 80, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: '0 50px', pointerEvents: 'none' }}>
        <div style={{ position: 'relative', width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="ai-bloom" style={{ position: 'absolute', inset: -18, borderRadius: '50%', background: `radial-gradient(circle, ${accent}66 0%, ${accent}00 70%)` }} />
          <div className="ai-bloom2" style={{ position: 'absolute', inset: 6, borderRadius: '50%', border: `1.5px solid rgba(255,255,255,.14)` }} />
          <div style={{ width: 58, height: 58, borderRadius: 20, background: `linear-gradient(135deg, ${S.accent[500]}, ${accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 12px 34px -6px ${accent}` }}>
            <window.AISpark size={28} color="#fff" />
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Soch raha hoon…</div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.6)', marginTop: 6, lineHeight: 1.5 }}>Reading your June transactions —<br />all on your device, sukoon se.</div>
        </div>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 9, marginTop: 4 }}>
          {[100, 78, 88].map((w, i) => (
            <div key={i} className="ai-shimmer" style={{ height: 11, width: `${w}%`, borderRadius: 6, background: 'rgba(255,255,255,.10)', animationDelay: `${i * 0.18}s` }} />
          ))}
        </div>
      </div>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// UPGRADE — tasteful premium gate for advanced AI. No dark patterns.
// ════════════════════════════════════════════════════════════════
function Upgrade({ accent = S.accent[600] }) {
  const plus = [
    { t: 'Ask anything, unlimited', s: 'Free gives you 5 questions a day' },
    { t: 'Forecasts & “what-if”', s: '“If I cancel 2 subs, when do I hit my goal?”' },
    { t: 'Personalised cut plans', s: 'A monthly plan tuned to your habits' },
  ];
  const free = ['Where your money goes', 'Top insights & nudges', '5 questions a day'];
  return (
    <window.AIFrame height={1280}>
      <window.CoachHero pad="14px 20px 28px">
        <window.StatusBar />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 22 }}>
          <div style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
          </div>
          <div style={{ flex: 1 }} />
        </div>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.14)', marginBottom: 16 }}>
          <window.AISpark size={15} color="#fff" />
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.02em', color: '#fff' }}>Hisaab AI Plus</span>
        </div>
        <div style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.15, color: '#fff' }}>Go deeper with<br />your money</div>
        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.72)', lineHeight: 1.5, marginTop: 12 }}>
          Forecasts, unlimited questions, and a cut plan made for you. <strong style={{ color: '#fff', fontWeight: 600 }}>No ads, ever</strong> — your data stays yours.
        </div>
      </window.CoachHero>

      <window.CreamBody pad="20px 0 112px">
        {/* Plus features */}
        <div style={{ padding: '0 20px' }}>
          <window.AICard pad="6px 0">
            {plus.map((f, i) => (
              <div key={f.t} style={{ display: 'flex', gap: 12, padding: '13px 16px', borderTop: i ? `1px solid ${S.cream.hairline}` : 'none', alignItems: 'center' }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: S.accent[50], display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4 10-10" stroke={accent} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: S.ink[900] }}>{f.t}</div>
                  <div style={{ fontSize: 11, color: S.ink[500], marginTop: 1 }}>{f.s}</div>
                </div>
              </div>
            ))}
          </window.AICard>
        </div>

        {/* what's already free — so the free tab never feels crippled */}
        <div style={{ marginTop: 16, padding: '0 20px' }}>
          <div style={{ background: S.cream.soft, border: `1px solid ${S.cream.border}`, borderRadius: 14, padding: '13px 15px' }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: S.ink[500], marginBottom: 9 }}>Always free</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
              {free.map((f) => (
                <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: S.ink[700], fontWeight: 500 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4 10-10" stroke={S.receive.text} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>{f}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* price + CTA */}
        <div style={{ marginTop: 20, padding: '0 20px' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, background: '#fff', border: `1.5px solid ${accent}`, borderRadius: 14, padding: '13px 14px', position: 'relative' }}>
              <div style={{ position: 'absolute', top: -9, left: 13, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', color: '#fff', background: accent, padding: '3px 8px', borderRadius: 999 }}>SAVE 35%</div>
              <div style={{ fontSize: 11.5, color: S.ink[600], fontWeight: 500 }}>Yearly</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginTop: 3 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: S.ink[900], letterSpacing: '-0.02em' }}>149</span>
                <span style={{ fontSize: 11, color: S.ink[500] }}>AED/yr</span>
              </div>
            </div>
            <div style={{ flex: 1, background: '#fff', border: `1px solid ${S.cream.border}`, borderRadius: 14, padding: '13px 14px' }}>
              <div style={{ fontSize: 11.5, color: S.ink[600], fontWeight: 500 }}>Monthly</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginTop: 3 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: S.ink[900], letterSpacing: '-0.02em' }}>19</span>
                <span style={{ fontSize: 11, color: S.ink[500] }}>AED/mo</span>
              </div>
            </div>
          </div>
          <button style={{ width: '100%', marginTop: 12, padding: '15px', borderRadius: 14, border: 'none', background: `linear-gradient(135deg, ${S.accent[500]}, ${accent})`, color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', boxShadow: `0 12px 26px -10px ${accent}` }}>
            Try 14 days free
          </button>
          <div style={{ textAlign: 'center', fontSize: 11, color: S.ink[500], marginTop: 10 }}>Then AED 149/yr · cancel anytime · no ads</div>
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

Object.assign(window, { Conversation, InsightDetail, Thinking, Upgrade });
