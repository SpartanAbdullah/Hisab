// Hisaab AI tab — main feed (two directions), cold start, monthly wrap.
// Reads atoms off window (loaded earlier). Each screen renders inside AIFrame.

const F = window.SukoonTokens;

// Shared "where it goes" dataset (June). Dining is the coral anomaly.
const SPEND = [
  { name: 'Dining', amt: 1540, color: F.pay.text, note: '↑18%' },
  { name: 'Grocery', amt: 890 },
  { name: 'Transport', amt: 620 },
  { name: 'Shopping', amt: 540 },
  { name: 'Bills', amt: 760, color: F.ink[400] },
  { name: 'Other', amt: 470 },
];

// ════════════════════════════════════════════════════════════════
// DIRECTION A — Insight-led. Leads with the headline number + the
// single most useful thing you can do about it.
// ════════════════════════════════════════════════════════════════
function FeedInsightLed({ accent = F.accent[600] }) {
  return (
    <window.AIFrame height={1408}>
      <window.CoachHero pad="14px 20px 26px">
        <window.StatusBar />
        <window.AIHeroHead sub="Subah bakhair, Muhammad" />

        {/* headline insight */}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Spent in June</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 0.9, fontVariantNumeric: 'tabular-nums' }}>4,820</span>
            <span style={{ fontSize: 17, fontWeight: 500, color: 'rgba(255,255,255,.5)' }}>AED</span>
          </div>
          <div style={{ marginBottom: 3 }}><window.DeltaChip good>12% vs May</window.DeltaChip></div>
        </div>
        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.78)', lineHeight: 1.5, marginTop: 14, letterSpacing: '-0.005em' }}>
          <strong style={{ color: '#fff', fontWeight: 600 }}>Dining</strong> is your biggest category — 32% of June, up 18% from last month. Most of it is weekday delivery.
        </div>

        {/* ask bar lives in the hero */}
        <div style={{ marginTop: 18 }}>
          <window.AskBar onNavy accent={accent} />
        </div>
      </window.CoachHero>

      <window.CreamBody pad="22px 0 112px">
        {/* where it goes */}
        <window.AISec action="Details">Where it goes · June</window.AISec>
        <div style={{ padding: '0 20px' }}>
          <window.AICard pad="16px 16px 14px">
            <window.CategoryBars data={SPEND} />
          </window.AICard>
        </div>

        {/* ways to cut */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>Ways to cut</window.AISec>
          <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <window.CutCard
              merch="Gold's Gym" color="#1F2433"
              title="Cancel Gold's Gym"
              detail="AED 200/mo · not checked in for 3 months"
              save="2,400" saveUnit="AED / yr" primary="Cancel" secondary="Keep" accent={accent} />
            <window.CutCard
              merch="Streaming" color={F.accent[600]}
              title="3 streaming subs, you use 1"
              detail="AED 92/mo across Netflix, OSN, Prime"
              save="672" saveUnit="AED / yr" primary="Trim to 1" secondary="Review" accent={accent} />
          </div>
        </div>

        {/* gentle nudge */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>For you</window.AISec>
          <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <window.NudgeCard kind="warn" title="An unusual charge appeared"
              body="AED 340 at Sharaf DG — bigger than your usual. Tap to confirm it's yours."
              action="Review" accent={accent} />
            <window.NudgeCard kind="info" title="2 expenses from yesterday aren't logged"
              body="Want me to add the karak and the Careem? Takes one tap." action="Add" accent={accent} />
          </div>
        </div>

        {/* wrap teaser */}
        <div style={{ marginTop: 22, padding: '0 20px' }}>
          <window.WrapTeaser accent={accent} />
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// DIRECTION B — Ask-led. Conversation forward: a big prompt + example
// questions up top, the insight summarised beneath.
// ════════════════════════════════════════════════════════════════
function FeedAskLed({ accent = F.accent[600] }) {
  return (
    <window.AIFrame height={1392}>
      <window.CoachHero pad="14px 20px 30px">
        <window.StatusBar />
        <window.AIHeroHead sub="Your money, samjho" />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 14, background: `linear-gradient(135deg, ${F.accent[500]}, ${accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: `0 8px 20px -6px ${accent}88` }}>
            <window.AISpark size={22} color="#fff" />
          </div>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2 }}>What do you want<br />to know?</div>
        </div>

        <window.AskBar onNavy accent={accent} placeholder="e.g. Can I afford dinner out this week?" />

        <div style={{ marginTop: 12 }}>
          <window.ChipRow onNavy items={['Where did my money go?', 'How much on groceries?', 'Can I afford AED 1,200 dinner?']} />
        </div>
      </window.CoachHero>

      <window.CreamBody pad="22px 0 112px">
        {/* this month at a glance — headline insight as a card */}
        <window.AISec action="Open">This month</window.AISec>
        <div style={{ padding: '0 20px' }}>
          <window.AICard pad="15px 16px">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div>
                <div style={{ fontSize: 11, color: F.ink[500], fontWeight: 500 }}>Spent in June</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 2 }}>
                  <span style={{ fontSize: 26, fontWeight: 600, color: F.ink[900], letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>4,820</span>
                  <span style={{ fontSize: 12, color: F.ink[500], fontWeight: 500 }}>AED</span>
                </div>
              </div>
              <window.DeltaChip good onNavy={false}>12% vs May</window.DeltaChip>
            </div>
            <div style={{ fontSize: 12, color: F.ink[600], lineHeight: 1.45, margin: '6px 0 14px' }}>
              <strong style={{ color: F.ink[900], fontWeight: 600 }}>Dining</strong> leads at 32% — up 18%, mostly weekday delivery.
            </div>
            <window.CategoryBars data={SPEND} areaH={118} />
          </window.AICard>
        </div>

        {/* one hero cut + quick wins */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>Biggest win right now</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.CutCard
              merch="Gold's Gym" color="#1F2433"
              title="Cancel Gold's Gym"
              detail="AED 200/mo · skipped 3 months running"
              save="2,400" saveUnit="AED / yr" primary="Cancel" secondary="Keep" accent={accent} />
          </div>
          <div style={{ padding: '12px 20px 0' }}>
            <window.ChipRow items={['Trim streaming · save 672/yr', 'Cook 3 nights · save 250/mo', 'Cap delivery · AED 600']} />
          </div>
        </div>

        {/* nudge */}
        <div style={{ marginTop: 22, padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <window.NudgeCard kind="streak" title="Netflix renews in 2 days — AED 56"
            body="Bhooli hui subscriptions yahin pakdenge. Keep it, or cancel before it bills?"
            action="Manage" accent={accent} />
        </div>

        <div style={{ marginTop: 22, padding: '0 20px' }}>
          <window.WrapTeaser accent={accent} />
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// COLD START — little data. Invite the first action; never feel broken.
// ════════════════════════════════════════════════════════════════
function ColdStart({ accent = F.accent[600] }) {
  return (
    <window.AIFrame height={1180}>
      <window.CoachHero pad="14px 20px 30px">
        <window.StatusBar />
        <window.AIHeroHead sub="Aao shuru karein" bell={false} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 15, background: `linear-gradient(135deg, ${F.accent[500]}, ${accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: `0 8px 22px -6px ${accent}99` }}>
            <window.AISpark size={24} color="#fff" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2 }}>Let's get to know<br />your money</div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.72)', lineHeight: 1.55, letterSpacing: '-0.005em' }}>
          Log a few expenses and I'll show you exactly where it goes — and one thing you can do about it. <strong style={{ color: '#fff', fontWeight: 600 }}>Nothing leaves your device.</strong>
        </div>
      </window.CoachHero>

      <window.CreamBody pad="20px 0 112px">
        {/* progress to first insight */}
        <div style={{ padding: '0 20px' }}>
          <window.AICard pad="16px">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: F.ink[900] }}>First insight unlocks soon</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: accent, fontVariantNumeric: 'tabular-nums' }}>3 / 10</div>
            </div>
            <div style={{ height: 8, borderRadius: 99, background: F.ink[200], overflow: 'hidden' }}>
              <div style={{ width: '30%', height: '100%', borderRadius: 99, background: `linear-gradient(90deg, ${F.accent[500]}, ${accent})` }} />
            </div>
            <div style={{ fontSize: 11, color: F.ink[500], marginTop: 9, lineHeight: 1.45 }}>Log 7 more this week and your June breakdown appears here.</div>
          </window.AICard>
        </div>

        {/* primary action */}
        <div style={{ padding: '16px 20px 0' }}>
          <button style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '15px', borderRadius: 14, border: 'none', background: `linear-gradient(135deg, ${F.accent[500]}, ${accent})`, color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', boxShadow: `0 10px 24px -10px ${accent}` }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
            Log your first expense
          </button>
          <div style={{ marginTop: 10 }}>
            <window.NudgeCard kind="info" title="Or connect an account"
              body="Import past transactions and skip ahead — read-only, you stay in control." action="Connect" accent={accent} />
          </div>
        </div>

        {/* a faded preview of what's coming */}
        <div style={{ marginTop: 24 }}>
          <window.AISec>A preview of what you'll get</window.AISec>
          <div style={{ padding: '0 20px', position: 'relative' }}>
            <div style={{ opacity: 0.5, filter: 'saturate(0.85)', pointerEvents: 'none' }}>
              <window.AICard pad="16px 16px 14px">
                <window.CategoryBars data={SPEND} areaH={112} />
              </window.AICard>
            </div>
            <div style={{ position: 'absolute', left: 20, right: 20, bottom: 0, top: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 18 }}>
              <div style={{ background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(2px)', border: `1px solid ${F.cream.border}`, borderRadius: 999, padding: '8px 14px', fontSize: 11.5, fontWeight: 600, color: F.ink[700], boxShadow: '0 6px 18px -8px rgba(11,14,42,.25)' }}>
                Unlocks at ~2 weeks of data
              </div>
            </div>
          </div>
        </div>

        {/* try asking */}
        <div style={{ marginTop: 24 }}>
          <window.AISec>Meanwhile, try asking</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.ChipRow items={['What can Hisaab AI do?', 'How do you keep my data private?', 'Set a monthly budget']} />
          </div>
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

// ════════════════════════════════════════════════════════════════
// MONTHLY WRAP — warm month-in-review moment. This tab is its home.
// ════════════════════════════════════════════════════════════════
function MonthlyWrap({ accent = F.accent[600] }) {
  return (
    <window.AIFrame height={1300}>
      <window.CoachHero pad="14px 20px 30px">
        <window.StatusBar />
        <window.HeroTopLite />
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8 }}>Month in review</div>
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.05 }}>Your June,<br />wrapped</div>
        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.7)', lineHeight: 1.5, marginTop: 12 }}>
          A calm look back — no scores, no judgement. Just what happened, and one thing worth carrying into July.
        </div>

        {/* two hero stats */}
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          {[{ k: 'Spent', v: '4,820', d: '12% less than May', good: true }, { k: 'Saved', v: '1,200', d: 'Best month this year', good: true }].map((s) => (
            <div key={s.k} style={{ flex: 1, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 16, padding: '13px 14px' }}>
              <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.55)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{s.k}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 5 }}>
                <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{s.v}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,.5)' }}>AED</span>
              </div>
              <div style={{ fontSize: 10, color: '#7BE0C4', fontWeight: 500, marginTop: 5 }}>{s.d}</div>
            </div>
          ))}
        </div>
      </window.CoachHero>

      <window.CreamBody pad="22px 0 112px">
        {/* the highlight */}
        <div style={{ padding: '0 20px' }}>
          <div style={{ background: F.receive[50], border: `1px solid ${F.receive.chip}`, borderRadius: 16, padding: '15px 16px', display: 'flex', gap: 13, alignItems: 'center' }}>
            <div style={{ width: 42, height: 42, borderRadius: 13, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 13l3-7 4 4 4-6 3 5" stroke={F.receive.text} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 18h16" stroke={F.receive.text} strokeWidth="1.8" strokeLinecap="round" /></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: F.ink[900] }}>You cooked 11 nights</div>
              <div style={{ fontSize: 11.5, color: F.ink[600], marginTop: 2, lineHeight: 1.4 }}>That's about <strong style={{ color: F.receive.text, fontWeight: 600 }}>AED 320</strong> kept out of delivery. Shabaash.</div>
            </div>
          </div>
        </div>

        {/* spent by category recap */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>Where June went</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.AICard pad="16px 16px 14px"><window.CategoryBars data={SPEND} areaH={116} /></window.AICard>
          </div>
        </div>

        {/* one thing to watch */}
        <div style={{ marginTop: 22 }}>
          <window.AISec>One thing for July</window.AISec>
          <div style={{ padding: '0 20px' }}>
            <window.NudgeCard kind="warn" title="Dining crept up 18%"
              body="Set a gentle weekly delivery cap and I'll keep an eye on it — no nagging." action="Set cap" accent={accent} />
          </div>
        </div>

        {/* share / full wrap */}
        <div style={{ marginTop: 18, padding: '0 20px', display: 'flex', gap: 10 }}>
          <button style={{ flex: 1, padding: '13px', borderRadius: 13, border: 'none', background: F.navy[800], color: '#fff', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>See full wrap</button>
          <button style={{ width: 50, borderRadius: 13, border: `1px solid ${F.cream.border}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v14" stroke={F.ink[700]} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </window.CreamBody>
    </window.AIFrame>
  );
}

// Minimal hero top for the wrap (no greeting row — just bell + back affordance).
function HeroTopLite() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 16 }}>
      <div style={{ width: 34, height: 34, borderRadius: 11, background: 'rgba(255,255,255,.09)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Hisaab AI</div>
      <window.AISpark size={18} color="rgba(255,255,255,.8)" />
    </div>
  );
}

Object.assign(window, { FeedInsightLed, FeedAskLed, ColdStart, MonthlyWrap, HeroTopLite, SPEND_DATA: SPEND });
