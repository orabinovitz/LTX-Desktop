# Platform Specs, Safe Zones, and Export Reference

## Safe Zones: Where NOT to Place Text

Platform UI elements cover significant screen real estate. Text, logos, or CTAs in these zones are functionally invisible.

| Platform | Placement | Top Clear | Bottom Clear | Right Side | Effective Safe Area |
|----------|-----------|-----------|--------------|------------|-------------------|
| Meta Stories | 9:16 | 270 px (14%) | 384 px (20%) | 65 px each side | ~950x1266 px |
| Meta Reels | 9:16 | 270 px (14%) | 672 px (35%) | 65 px each side | ~950x978 px |
| Instagram Reels | 9:16 | 108 px | 320 px | L: 60 px, R: 120 px | ~900x1492 px |
| TikTok | 9:16 | 130 px | 350 px (450 for Shopping) | 64 px (right) | ~1016x1440 px |
| Snapchat | 9:16 | 150 px | 150 px | — | ~1080x1620 px |

**Practical rule:** Design all CTA and key text within center ~1010x1280 px on a 1080x1920 canvas. TikTok provides downloadable safe zone overlays via Ads Manager — use them.

---

## Platform Video Specs

### Meta (Facebook + Instagram)

| Format | Aspect Ratio | Resolution | Duration Sweet Spot | Max File Size |
|--------|-------------|------------|-------------------|--------------|
| Feed | 4:5 or 1:1 | 1080x1350 / 1080x1080 | 5–15 seconds | 4 GB |
| Stories | 9:16 | 1080x1920 | 5–15 seconds | 4 GB |
| Reels | 9:16 | 1080x1920 | Under 30 seconds | 4 GB |

- 4:5 vertical takes up more mobile screen real estate -> higher CTR than 1:1 or 16:9
- 30 fps cap enforced by Meta
- Sound-off is default — captions and text overlays carry the message
- UGC-style Reels often double the CTR of Feed ads
- Meta Lead Gen: 7.72% average conversion rate, 2.53% CTR, video CPC as low as $0.18

### TikTok

| Format | Aspect Ratio | Resolution | Duration Sweet Spot | Max File Size |
|--------|-------------|------------|-------------------|--------------|
| In-Feed | 9:16 | 1080x1920 | 9–15s (completion) / 21–34s (engagement) | 500 MB |

- 9:16 vertical is non-negotiable — letterboxed content dies
- Sound-on is mandatory — 88% of users say sound is vital
- Change angles/scenes every 2–3 seconds
- Completion rate sweet spot: 7–13 seconds
- Engagement sweet spot: 21–34 seconds
- Spark Ads (boosted organic): 3%+ CTR vs 1.5–2% for standard in-feed
- 90% of ad recall impact captured in first 6 seconds
- Products on screen boost brand affinity 65%, recall 25%
- Brands running 10+ unique creatives see 1.3x higher ad recall, 3.0x purchase intent

### YouTube

| Format | Aspect Ratio | Resolution | Duration Sweet Spot | Max File Size |
|--------|-------------|------------|-------------------|--------------|
| Skippable Pre-Roll | 16:9 | 1920x1080 | 15s–3 min | 256 GB |
| Non-Skippable | 16:9 | 1920x1080 | 15 seconds | 256 GB |
| Bumper | 16:9 | 1920x1080 | 6 seconds exactly | 256 GB |
| Shorts | 9:16 | 1080x1920 | 15–60 seconds | 256 GB |

- Skip button appears at 5 seconds — those 5 seconds are the ultimate creative gauntlet
- Sound-on environment — voiceover, sound design, and music are essential
- Supports up to 60 fps
- Bumper sequences lift brand recall 34% vs single-exposure
- CTV completion rates average 95%+ (vs 30–40% on mobile)
- 45%+ of YouTube watch time now on CTV — requires HD/4K, 16:9, TV-speaker audio design
- Shorts: repurposed landscape content underperforms 3x on completion rates

### LinkedIn

- MP4 only, 30 fps recommended
- File size: 200 MB (500 MB max)
- Optimal: 1:1 (1080x1080) or 4:5 (1080x1350) for mobile
- Duration by objective: awareness 6–15s, consideration 20–45s, conversion 15–30s
- Under 30 seconds = 200% lift in completion rates
- Video generates 5x more engagement than text posts
- Sound-off mandatory design — "think like a silent film director"
- Thought Leader Ads: 10–20% CTR at $5–8 CPMs
- B2B CPL range: $40–$150

### Google Display

| Format | Resolution | Max File Size |
|--------|-----------|--------------|
| Top size (1.91:1) | 1200x628 | 150 KB per banner |
| 300x250 Medium Rectangle | 300x250 px | 150 KB |
| Responsive Display | 1200x628 + 1200x1200 minimum | 150 KB |

- 300x250 drives ~25% higher CTR than other display formats
- Clean design, fast loading, text <=20% of image, strong visual hierarchy
- Responsive Display: 5 short headlines (30 chars), 1 long headline (90 chars), 5 descriptions (90 chars)

### Google Demand Gen

- Provide video in all three orientations: 16:9, 1:1, 9:16
- Include 3+ images or videos per aspect ratio per ad group
- Videos under 10 seconds won't serve on YouTube In-stream
- Video + image ads = 6% more conversions/dollar vs image-only
- Video + product feed = 33% more conversions at similar CPA
- Daily budget = 15x Target CPA for algorithm learning
- 2–3 week minimum learning period
- Never edit existing ad groups (resets learning) — create new ones

---

## Master Export Workflow

1. Start with 4K master file (3840x2160 or higher)
2. Export platform-specific versions from the master

**Universal settings:**
- Codec: H.264 High Profile, MP4 container, progressive scan, square pixels, fixed frame rate
- Frame rate: 30 fps default (maximum cross-platform compatibility)
- Audio: AAC-LC, 48 kHz, stereo, 256 kbps
- Loudness: -14 LUFS integrated, -1 dBTP true peak
- Color space: Rec. 709 / sRGB (never Rec. 2020, HDR10, or DCI-P3)

**Minimum three exports:**
- 1:1 at 1080x1080 (feed placements)
- 4:5 at 1080x1350 (Meta preferred mobile feed)
- 9:16 at 1080x1920 (Stories, Reels, Shorts, TikTok)
- 16:9 at 1920x1080 (YouTube in-stream, CTV)

Upload at 2x resolution when possible (e.g., 2160x2160 for 1:1) — high-density mobile screens render noticeably sharper.

**Always deliver:**
- Versions WITH and WITHOUT burned-in captions
- Multiple aspect ratios
- Multiple hook variations on the same body
