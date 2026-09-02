# Monetization — Hisaab

**Date:** 2026-09-02 · **For:** the founder · **Status:** decisions pending — no
entitlement, billing, or payment code exists anywhere in `src/` today
(confirmed absence, not just "not found" — `grep -ri "entitlement|billing|purchase"
src/` returns no monetization-related hits). Revenue surface is currently one
i18n string and a design mock. This doc turns opportunity **O9** from
`docs/audit-2026-09/11-competitive-analysis.md` and roadmap item **L3** from
`00-executive-summary.md` §6.4 into a buildable plan.

**Do not build anything in §2 before the founder has made the calls in §1.**
Pricing, tier scope, and launch market gate every technical decision below.

---

## 0. Why AI, and why not sooner

`11-competitive-analysis.md` G11: every researched competitor monetizes —
Khatabook via lending distribution, Udhaar Book via SBP-regulated payment
commissions, Tricount as a bunq neobank funnel, Splid/Settle Up via IAP. Every
one of those routes is closed to Hisaab: `00-executive-summary.md` §1 notes
Hisaab's no-custody stance "deliberately forecloses" the lending pivot that
is CreditBook's — the exact Pakistani free-ledger precedent — only survival
path (11 §3, G11). Monarch is the counter-precedent: proven willingness to
pay **$99.99–199.99/yr for AI-over-your-financial-data** in the same
competitive set (11 §1 Cluster B, O9). Hisaab already ships the only free
conversational AI entry in the researched field (`/hisaab-ai`, 11 §4.4) plus a
premium-gate design mock (`docs/design-extract/ai-tab-3.jsx:260-266`, the
`Upgrade` component) — AI is the first monetization mechanism because it's the
one lever with a proven price point, a shipped free wedge to gate past, and
zero custody risk.

---

## 1. Decisions the founder must make

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **What is premium** | AI beyond N free queries/day (mock specs 5/day, `ai-tab-3.jsx:262`) + advanced insights (forecasts, "what-if", cut plans, `ai-tab-3.jsx:263-264`) + statement/PDF exports beyond a free cap. **Everything else — every transaction, loan, split, kameti, budget, account, and core AI Q&A up to the cap — free forever.** No currency gate: 8-currency support is already free (`src/db/types.ts:1`); gating it breaks the "free tracking forever" promise (`i18n.ts:604-605`, `docs/go-to-market.md` §1.4 row 7). | Matches the design mock, leaves the product wedge (kameti/udhaar/splits) untouched, mirrors Monarch's own tracking-free/AI-paid split. |
| D2 | **Pricing hypothesis** | Anchor **below** Monarch's $99–199/yr — smaller slice, smaller-ARPU market. Hypothesis: **PKR 350–500/mo (≈PKR 3,500–4,500/yr)**; **AED 15–20/mo (≈AED 150–180/yr)**. Validate via Phase 1 pricing surveys (§3) — no Pakistani/Gulf AI-tier willingness-to-pay data exists yet (`11-competitive-analysis.md` §7). | Local anchors (free khata apps, transaction-fee JazzCash/easypaisa) set lower expectations than a US PFM app's price point. |
| D3 | **Refund / grace policy** | Play's standard refund window; on lapse, **downgrade gracefully** — keep AI history readable, stop new queries past the cap, mirroring the "silently clamps" overpayment-guard pattern (`CLAUDE.md` "Money-mutation safety"). **7-day grace period** after a failed renewal before downgrade. | Absorbs common prepaid-card renewal failures without a punitive hard-lock; matches the product's existing guard-rail philosophy. |
| D4 | **Launch market** | **Play (Android) first** — matches `CLAUDE.md` "Shipping rule" and the fact no `ios/` directory exists (`docs/go-to-market.md` §4). Web follows once Android's entitlement plumbing + `check_entitlement()` are proven. | Play Billing avoids the Pakistan merchant-of-record problem (§2.3); doubling platforms on a first monetization attempt doubles the ways to get it wrong. |

**Do not announce a date, price, or feature list publicly** until entitlement
code exists — `docs/go-to-market.md` §5 "Monetization messaging — no dates"
already states this rule for marketing copy; this doc is the trigger that
retires that constraint once D1–D4 are locked and §2 ships.

---

## 2. Technical design

### 2.1 `entitlements` table + `check_entitlement()`

```sql
create table public.entitlements (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  plan               text not null default 'free' check (plan in ('free','premium_ai')),
  source             text not null check (source in ('play','web','manual')),
  status             text not null default 'active' check (status in ('active','grace','expired','cancelled')),
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

alter table public.entitlements enable row level security;

-- Self-read only. No client INSERT/UPDATE/DELETE policy — writes are
-- service-role only, from the Play/Stripe verification path (§2.2/§2.4).
create policy "users read own entitlement"
  on public.entitlements for select
  using (auth.uid() = user_id);

create or replace function public.check_entitlement(p_feature text)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select coalesce(
    (select status = 'active' and (current_period_end is null or current_period_end > now())
       from public.entitlements
      where user_id = auth.uid() and plan = 'premium_ai'),
    false
  );
$$;
```

Follows this repo's existing pattern for money-adjacent tables exactly:
`SECURITY DEFINER` RPC for the gated check (mirrors `apply_account_balance_delta`,
`join_group_by_code`), self-read RLS, and no client write path — matches
`CLAUDE.md` "Data flow." Ships as a new
`supabase-migration-entitlements.sql` at the repo root, following the existing
hand-applied-migration convention (`CLAUDE.md` "Supabase migrations") and the
apply-order discipline in `docs/audit-2026-09/APPLY-ORDER.md` (append to
`supabase/tests/apply-order.txt` per `db-tests.yml`'s own CI check, which
fails the build if a new migration file isn't listed there).

A user with no row is implicitly free-tier — `check_entitlement()` returns
`false` for a missing row via `coalesce`, so no backfill is needed for
existing users.

### 2.2 Android: Google Play Billing

| Option | What it is | Trade-off |
|---|---|---|
| **RevenueCat** (`@revenuecat/purchases-capacitor`) | Hosted receipt validation, cross-platform, webhook-driven entitlement sync | Vendor fee (free under ~$2.5k MTR, then a % — verify current pricing) but handles renewal/grace/cancellation/refund state entirely. Fits this repo's existing bus-factor-1 profile (`docs/release-and-rollback.md` §4). |
| **`@capgo/capacitor-native-purchases`** | Thinner wrapper over native Play Billing, no hosted backend | No vendor %, but the team writes and owns Play Developer API server-side validation and all subscription-state edge cases. |
| **Raw Play Billing + Supabase edge function** | A plugin drives the purchase flow; a new edge function (alongside `supabase/functions/push-notify`) validates the token via the Play Developer API using a service-account secret, then writes `entitlements` as `service_role`. | Zero vendor fee, most maintenance — renewal/grace/hold/refund all tracked via Play's Real-time Developer Notifications, which itself needs a webhook receiver. |

**Recommendation: RevenueCat for v1.** No existing edge function does
payment validation (`push-notify` is a push relay, not a validator); RevenueCat's
webhook maps straight to a `service_role` upsert into `entitlements` — far
smaller surface than hand-rolling RTDN + Play Developer API auth. Revisit raw
Play Billing only once RevenueCat's % meaningfully exceeds an engineer-week.

### 2.3 Web: Stripe vs. merchant-of-record alternatives

**Stripe does not support Pakistan-incorporated business entities as a
merchant of record** — a known Stripe limitation, not a Hisaab constraint.
Options, in order of fit:

1. **Paddle or Lemon Squeezy** (merchant-of-record) — handle international
   tax/VAT compliance, no Pakistan-eligible Stripe account needed. **Recommended
   default** if the founder's entity stays in Pakistan.
2. **Stripe via a UAE entity** — if a UAE entity exists for the Gulf-market
   side of the business anyway (`docs/go-to-market.md` §3.2), Stripe supports
   it directly: Stripe Checkout + a webhook edge function (same pattern as
   §2.2 — verify signature, upsert `entitlements` as `service_role`).
3. **Stripe via a payment-facilitator/reseller** — higher fees, not a first move.

Sequence web **after** Android (§1 D4) — the entity/processor choice is a
founder call this doc can't make, and Android's RevenueCat path has no
equivalent blocker.

### 2.4 Client: `useEntitlement()` hook + gate pattern

```ts
// src/hooks/useEntitlement.ts — sketch, not yet implemented
function useEntitlement() {
  // reads a cached entitlements row (mirror pattern already used for other
  // read-mostly tables per CLAUDE.md "src/db/ is a read mirror") and exposes
  // { plan, isPremium, dailyAiQueriesUsed, dailyAiQueryLimit }
}
```

Gate pattern: wrap the AI-tab's query composer and insight-detail routes with
a check against `useEntitlement().isPremium || queriesUsedToday < freeLimit`;
on exhaustion, render the existing `Upgrade` design (`ai-tab-3.jsx:260-266`)
rather than inventing new UI. **Never gate client-side only** — the daily
free-query counter must be enforced server-side (a `SECURITY DEFINER` RPC
incrementing a per-user, per-day counter, same optimistic-lock discipline as
`apply_account_balance_delta`) since a client-only counter is trivially
bypassed by clearing local storage.

### 2.5 Other plumbing

- **i18n:** every new string (`premium_ai_upsell_title`, `premium_ai_daily_limit_reached`,
  etc.) goes into `src/lib/i18n.ts` as `{ ur, en }` pairs per `CLAUDE.md` —
  no exceptions for paywall copy.
- **CSP / `connect-src`:** RevenueCat's/Paddle's/Lemon Squeezy's domains need
  adding to both `vercel.json`'s CSP header and the meta-CSP in `index.html:30`
  in the same change (both must stay in sync — see the PostHog precedent at
  `index.html:12-17`). Exact domains depend on the vendor chosen in §2.2/§2.3.
- **Play data-safety:** the "Data safety" form needs a "Financial info —
  purchase history" disclosure once billing ships; `docs/play-store-listing.md`
  needs a pricing/subscription section, under the same listing-honesty
  discipline `docs/go-to-market.md` §5 set for the PIN/offline/currency claims.

---

## 3. Sequencing, effort, and keeping "free forever" auditable

| Phase | Scope | Effort | Prerequisite |
|---|---|---|---|
| P1 | Lock D1–D4 (founder decisions, §1); pricing survey in the closed-test cohort (`docs/go-to-market.md` §3.1 Phase 1) | S | Closed test running with real users to survey |
| P2 | `entitlements` table + `check_entitlement()` RPC + `supabase-migration-entitlements.sql`, added to `supabase/tests/apply-order.txt` and exercised by a new `supabase/tests/tests/*.sql` assertion file (pattern: `db-tests.yml`'s existing trust-boundary suite) | S | Analytics live (`VITE_POSTHOG_KEY` set — `docs/go-to-market.md` §3.1) so the pricing/paywall funnel is measurable from day one, per roadmap H2/O11 |
| P3 | RevenueCat integration + Android purchase flow + `useEntitlement()` hook + AI-tab gate wired to the existing `Upgrade` mock | M | P2 live; RevenueCat account created (founder) |
| P4 | Server-side daily-free-query counter RPC + rate limiting | S | P3 |
| P5 | Web checkout (Paddle/Lemon Squeezy, or Stripe-via-UAE-entity per §2.3) | M | P3 proven on Android; founder's entity/processor decision made |
| P6 | Play Console data-safety update + listing pricing section + i18n copy sweep (both `ur`/`en`) | S | P3 |

**Prerequisite:** the trust story must be true before a paywall sits on top of
it — shipping premium while the PIN/offline/currency claims are still false
(`00-executive-summary.md` Top Finding #3, P0 C3) means charging on top of an
unresolved trust deficit. Sequence monetization **after** the P0 security/
trust batch (`docs/audit-2026-09/APPLY-ORDER.md` §2) is live in production.

**Keeping "free tracking forever" auditable:** `docs/go-to-market.md` §1.4
row 7 already set the pattern — a claims table stating each promise's status
against actual repo/production state, re-checked before every campaign push.
Extend that table (or a sibling `docs/monetization-claims.md`) with one row
per money-tracking feature, each stating "free, un-gated, verified by `grep`
for entitlement checks on this code path" — so "free forever" stays a
checkable fact, the same way PIN/offline/currency claims were downgraded from
aspiration to verified fact in the P0 remediation.

---

*Grounded against commit `2248327` and the working tree, 2026-09-02. No
entitlement/billing/payment code exists in `src/` — everything in §2 is a
proposed design, not shipped code.*
