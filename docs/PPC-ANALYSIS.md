# PPC Ads Distribution Analysis

> Is paid search/social viable for our products? Competition, cost, viability assessment.

## TL;DR

**PPC is not viable for Worktrees or Hangar** — our developer audience discovers tools organically, and CPC for relevant keywords is high relative to our likely ACV. **PPC may be necessary for Windtunnel** to reach non-developer consumers, but only after product-market fit is proven organically.

## Market Benchmarks (Q1 2026)

- Cross-industry average CPC: **$2.96** (up 12% YoY)
- B2B SaaS average CPC: **$4.51**
- Competitive B2B SaaS keywords: **$8–12/click**
- High-intent SaaS keywords: **$50+/click**

## Keyword Analysis

### Developer Keywords (Worktrees / Hangar)

| Keyword | Est. CPC | Competition | Monthly Volume | Notes |
|---|---|---|---|---|
| "AI coding tool" | $8–15 | Very High | High | Cursor, Copilot dominate |
| "AI code generator" | $5–10 | Very High | High | Consumer + dev mixed intent |
| "autonomous coding agent" | $3–6 | Medium | Low | Nascent category |
| "AI task management developer" | $4–8 | Medium | Very Low | Niche, low volume |
| "self-hosted AI coding" | $2–4 | Low | Very Low | Our niche but tiny volume |
| "parallel AI agents code" | $2–3 | Low | Very Low | Too specific |
| "AI deploy platform" | $6–12 | High | Medium | Railway, Vercel, CF compete |
| "git worktree AI" | <$1 | None | Negligible | Nobody searches this |

**Verdict:** The keywords that have volume are expensive and dominated by Cursor/Copilot/GitHub. The keywords that describe us specifically have no search volume. Developers don't Google for tools — they find them on HN, GitHub, Twitter, and through peers.

### Consumer Keywords (Windtunnel)

| Keyword | Est. CPC | Competition | Monthly Volume | Notes |
|---|---|---|---|---|
| "AI app builder" | $5–10 | High | High | Lovable, Bolt, Replit compete |
| "AI website builder" | $8–15 | Very High | Very High | Wix, Squarespace + AI tools |
| "build app with AI" | $4–8 | High | High | Growing fast |
| "no code app builder" | $10–20 | Very High | Very High | Established no-code players |
| "AI make me a website" | $3–6 | Medium | Medium | Long-tail, consumer intent |
| "vibe coding" | $2–4 | Medium | Growing | Category-defining term |

**Verdict:** Volume exists for consumer keywords, but CPCs are high and competition is fierce. Lovable and Bolt grew to $400M+ and $40M+ ARR respectively without significant PPC spend — suggesting product virality matters more than paid acquisition in this space.

## Do Our Competitors Run Ads?

Based on research: **No significant paid search campaigns were found for any major AI coding tool.**

- **Cursor:** No evidence of Google/Meta ads. Growth entirely through PLG, developer community, Twitter virality.
- **Lovable:** No evidence of paid ads. Hit $400M ARR with 146 employees through organic/viral growth.
- **Bolt.new:** No evidence of paid ads. $20M ARR in 60 days through browser-based PLG.
- **Replit:** Some brand ads historically, but growth primarily education market + organic.
- **Devin:** Enterprise sales, not paid search.
- **Windsurf:** No evidence. PLG via free tier.

**Interpretation:** The entire AI coding tools market grew without significant PPC. This suggests either:
1. Product virality is so strong that PPC isn't needed (optimistic view)
2. Developer tools specifically resist paid acquisition (developers trust peers, not ads)
3. The CAC math doesn't work at current price points (most tools are $20–25/mo)

## Unit Economics Assessment

### Worktrees (OSS, potential hosted tier)

| Metric | Estimate |
|---|---|
| Target ACV | $0 (OSS) to $40/seat/mo (hosted) |
| CPC for relevant keywords | $5–15 |
| Landing page conversion rate | 2–5% (generous for dev tools) |
| Cost per signup | $100–750 |
| Free-to-paid conversion | 2–5% |
| **Cost per paying customer** | **$2,000–37,500** |
| LTV at $40/mo, 12mo retention | $480 |
| **LTV:CAC ratio** | **0.01–0.24** |

**Verdict: Catastrophically negative.** PPC for Worktrees would burn money. Organic is the only viable path.

### Windtunnel (hosted, consumer pricing)

| Metric | Estimate |
|---|---|
| Target ACV | $25–50/mo |
| CPC for "AI app builder" keywords | $5–10 |
| Landing page conversion rate | 3–8% |
| Cost per signup | $62–333 |
| Free-to-paid conversion | 5–10% |
| **Cost per paying customer** | **$625–6,660** |
| LTV at $25/mo, 6mo retention | $150 |
| **LTV:CAC ratio** | **0.02–0.24** |

**Verdict: Still negative at current estimates.** Consumer AI builder churn is high (projects are often one-off). PPC only works if:
- Retention dramatically improves (>12 months)
- ACV increases (business tier at $50+)
- Brand search (people searching "Windtunnel" directly) reduces blended CPC
- Retargeting converts free users who already know the brand

## Viable Paid Channels (If/When)

If we eventually pursue paid distribution for Windtunnel:

### 1. YouTube Pre-roll / Sponsorships — Best Option
- Target: tech/startup/no-code YouTube channels
- CPV: $0.03–0.10 (much cheaper than search)
- Demo-friendly format (show app being built in 30s)
- Influencer sponsorships: $500–5,000 per video
- **Verdict: Best paid channel for consumer AI builder product**

### 2. Twitter/X Promoted Posts — Decent for Developers
- Target: developer audiences, Claude/Cursor followers
- CPE: $1–3
- Native format (demo videos, threads)
- **Verdict: Viable for Worktrees awareness, not conversion**

### 3. Reddit Ads — Risky
- Target: r/webdev, r/programming, r/nocode
- CPC: $1–5
- Reddit users are ad-hostile; organic posts work better
- **Verdict: Test small, expect low conversion**

### 4. Dev Newsletter Sponsorships — Efficient
- TLDR, Bytes, JavaScript Weekly, Changelog
- CPM: varies, but $500–5,000 per placement
- High-intent developer audience
- **Verdict: Best paid channel for Worktrees awareness**

## Recommendation

### Worktrees & Hangar
**Do not spend on PPC.** Invest all distribution effort in:
- GitHub presence (stars, README, issues, contributions)
- Hacker News launches
- Developer Twitter/X content
- Community (Discord, Reddit organic)
- Dev newsletter sponsorships (only paid channel worth testing)

### Windtunnel (when the time comes)
1. **Prove PMF organically first** — if the product doesn't grow at all without ads, ads won't save it
2. **Start with YouTube** — sponsorships and pre-roll on tech/no-code channels
3. **Test Google Ads on brand terms only** — "Windtunnel AI" to capture intent you've already created
4. **Avoid generic keyword bidding** — "AI app builder" is a money pit at current CAC:LTV
5. **Invest in virality mechanics instead** — "Built with Windtunnel" badges, referral credits, template sharing
