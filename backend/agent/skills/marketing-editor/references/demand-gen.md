# Demand Generation Ads Editing Playbook

## Editing Philosophy: Zero Wasted Frames

The first 5 seconds contain 120 frames at 24fps. Each of those 120 frames should have a purpose. In demand gen, editors are marketers — they must understand CTR, CPM, CPA, and ROAS, and know how their editing choices directly impact these metrics.

**"The creative IS the targeting."** The people who engage with your ads teach the algorithm who to show them to next. A poorly edited demand gen ad doesn't just underperform — it actively degrades targeting quality over time. Creative quality accounts for 30–40% of Demand Gen campaign results.

Key mindset: lead with the pain point, show the product early, match offer to audience readiness (cold = educational; warm = case studies; hot = demos), design for sound-off first. Opening with branding signals triggers skip reflexes.

---

## Frameworks That Drive Action

### PAS (Problem-Agitate-Solve)
- **Problem** (0–5s): identify the audience's challenge
- **Agitate** (5–15s): amplify the cost of inaction
- **Solve** (15–25s): present compelling answer

### AIDA (Attention-Interest-Desire-Action)
- **Attention** (0–3s): bold question or striking visual — NOT logos
- **Interest** (3–10s): scene change and product introduction
- **Desire** (10–20s): emotional connection and social proof
- **Action** (final 3–5s): clear single CTA

---

## CTA Placement Science

The three-point CTA approach increases conversion by 270% versus end-only placement:
1. **Ultra-light CTA** after the hook (subtle, non-intrusive)
2. **Primary CTA** immediately after the biggest value moment (mid-video)
3. **Reinforcing CTA** at the end

Spoken CTA combined with on-screen graphic outperforms either alone. Specific CTAs outperform generic dramatically: "Request a Demo" beats "Click Here"; "Start Free Trial" beats "Learn More."

Ads with embedded CTAs see 380% increase in conversion rates overall.

---

## Structure Templates

**6-second bumper:**
- Single pain point + brand + minimal CTA
- For frequency/awareness, not direct conversions

**15-second ad:**
- Visual jolt + pain point (0–3s) -> Solution + key benefit (3–10s) -> CTA (10–12s), 3s brand reinforcement

**30-second ad:**
- Problem/provocative statement (0–5s) -> Agitation (5–12s) -> Solution/demo (12–22s) -> Social proof (22–26s) -> CTA (26–30s)

**60-second ad:**
- Hook (0–5s) -> Problem + agitation (5–15s) -> Solution intro (15–25s) -> Product demo/features (25–40s) -> Social proof/testimonials (40–50s) -> CTA + urgency (50–60s)

### Pacing Rules
- At least 2 shots in first 3–5 seconds to energize
- Tight framing on subject
- Open with real people/faces — faces drive engagement
- Mobile-first: faster pacing, larger text, brighter footage

---

## Demand Gen Editing Techniques

### Advanced Transition Stack
- **J-cuts and L-cuts** for smooth audio-visual storytelling
- **Quick and jump cuts** for dynamic pacing
- **Match and smash cuts** for impactful scene transitions
- **Speed ramping** for stylistic emphasis on key moments
- **Masking and object isolation** for highlighting specific UI elements
- **Motion tracking** for callouts and annotations

### Product Demo Editing
- For product demos, generate AI images of UI screens and animate with `generate_video(mode='image_to_video')`
- Keep demo sequences under 90 seconds on the timeline
- Use text overlays via `add_subtitle` to highlight key features and steps
- Annotations to emphasize key features

### Social Proof Integration
- Testimonial clips belong at the "Desire" phase (post-solution, pre-CTA)
- Text overlays with key stats ("Rated 4.9 stars with 1,000+ reviews")
- Short customer quote clips: 5–8 seconds each with lower-third name and title
- Urgency overlays in final seconds: countdown timers, stock indicators, animated CTA buttons with subtle pulse

### A/B Testing at the Edit Level
- Test families of hooks on the same body content
- Keep problem, solution, proof, and CTA identical while swapping only first 3–5 seconds
- Give same footage to 2 different editors and compare results
- Create 3–5 hook variations per video body as standard practice

---

## Platform-Specific Demand Gen

### Google Demand Gen
- Discovery-based, creative-driven — lifestyle images outperform product-only dramatically
- Video + product feed is strongest format combination
- Adopting 3 of 4 Google-recommended best practices yields 40%+ more conversions and 58% higher ROAS
- Lookalike audiences exclusive to Demand Gen (not in PMax or Search)
- Set Target CPA at 2x standard campaign CPA (mid-funnel discovery context)
- Budget: 15x Target CPA daily for algorithm learning, 2–3 week minimum learning period
- Never edit existing ad groups (resets learning) — create new ones

### LinkedIn
- Sound-off, professional-mindset environment
- Best formats: 1:1 or 4:5 mobile-optimized video
- "Knowledge-rich" content demonstrating expertise outperforms sales messages
- Lead gen forms attach directly to video — no landing page needed
- CPL: $40–$150 for video campaigns
- Budget split: 70% feed, 30% Audience Network initially
- Thought Leader Ads: 10–20% CTR at $5–8 CPMs

### YouTube
- Only major platform primarily sound-on — voiceover, sound design, music essential
- Google's ABCD Framework: Attract attention -> Brand introduction -> Connect with story -> Direct action
- YouTube Shorts demand gen: budget 20–30% of YouTube spend for under-35 audiences
- CTV: 95%+ completion, requires higher-production 30–60s creative for lean-back viewing

### Meta Lead Gen
- Scroll-driven, short attention, sound-off default
- UGC-style content delivers 4x higher CTR than standard creative
- PAS for pain-point-heavy offers; AIDA for aspirational products
- Video can reduce cost-per-engagement by up to 30%

---

## Demand Gen Mistakes That Burn Budgets

- **Expecting bottom-of-funnel CPAs from mid-funnel traffic.** Demand gen is discovery-based — users are browsing, not searching with purchase intent.
- **Insufficient budget.** $10/day targeting USA teaches the algorithm nothing. Google recommends 15x Target CPA daily.
- **Judging too quickly.** Run demand gen for minimum 3 months before scaling decisions. Blended CPA tells the real story.
- **Weak/generic CTAs.** "Learn More" instead of "Request a Demo."
- **Too much brand fluff before the ask.** Lead with the pain point.
- **No urgency elements.** Countdown timers, limited availability, and specific deadlines move action.
- **Showing product too late.** In a skippable environment, front-load the product.
- **Designing for sound-on when 50%+ of LinkedIn and Meta views are muted.**
- **Reusing Search ad copy for visual formats.** Demand Gen competes with Shorts and influencer content — it must stop the scroll.

---

## Cost Per Lead Benchmarks (2025)

| Channel | Average CPL |
|---------|-------------|
| Google Ads overall | $70.11 (up 5.13% YoY) |
| Meta/Facebook Lead Ads | $27.66 |
| LinkedIn B2B video | $40–$150 |

**Key performance data:**
- Embedded CTAs: 380% conversion increase
- Three-point CTA: 270% higher conversion vs end-only
- LinkedIn sub-30s completion: 200% lift
- Brand before skip button: 40% higher view-through
- Sustainable B2B/SaaS LTV:CAC ratio: 3:1 or greater

Track cost-per-opportunity rather than cost-per-lead when comparing channels — MQLs are vanity metrics if they don't convert to pipeline. Creative metrics: hook rate, video completion rate, CTR. Blended metrics: whole-account CPA lift, search volume lift, retargeting pool growth.

Update creatives monthly — campaigns with regular refreshes see 25% lift in conversion rates. Lookalike audiences from high-value customer lists deliver 20% increase in conversions.
