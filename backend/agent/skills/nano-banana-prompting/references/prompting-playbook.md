# Nano Banana 2 Prompting Playbook

Validated prompts, hardware reference tables, and consistency techniques for
Nano Banana 2 image generation.

---

## Camera Body → Visual DNA

| Camera Body | Visual Signature | Best For |
|---|---|---|
| Sony A7III | Precise depth-of-field compression, clean detail | Portraits, products, controlled studio look |
| Hasselblad X2D | Medium-format tonal range, rich gradation, expansive dynamic range | Fashion, fine art, high-end editorial |
| Canon 5D Mark IV | Photojournalistic realism, neutral rendering | Documentary, street, editorial |
| Fujifilm X-T5 / X100V | Authentic Fujifilm color science, pleasing skin tones | Lifestyle, travel, natural light portraits |
| GoPro Hero | Immersive wide-angle distortion, action feel, barrel distortion | Action, POV, extreme sports, immersive |
| "Cheap disposable camera" | Raw, harsh on-camera flash, vignetting, soft focus, nostalgic grain | Retro, candid party shots, 90s aesthetic |
| Leica M11 | Clinical sharpness with organic rendering, subtle vignetting | Street photography, luxury editorial |
| Phase One IQ4 | Ultra-high-resolution medium format, extreme tonal separation | Architecture, landscape, museum-quality stills |
| Polaroid SX-70 | Instant film softness, warm color cast, white border frame | Nostalgic, personal, lo-fi aesthetic |

---

## Focal Length → Emotional Effect

| Focal Length | Spatial Effect | Emotional Register |
|---|---|---|
| 14–24mm | Extreme wide, heavy barrel distortion at edges, exaggerated depth | Disorientation, immersion, vulnerability, epic scale |
| 24–35mm | Wide with natural perspective, expansive environment visible | Context, world-building, environmental portrait, journey |
| 40–50mm | Closest to human vision, neutral perspective | Transparency, documentary truth, naturalism |
| 85mm | Portrait compression begins, soft background separation | Intimacy, beauty, gentle isolation |
| 100–135mm | Strong background compression, subject pops from environment | Voyeurism, clinical observation, dramatic isolation |
| 200mm+ | Extreme compression, flattened planes, stacked elements | Surveillance, claustrophobia, telephoto abstraction |
| Anamorphic 40mm | Widescreen 2.39:1 feel, oval bokeh, horizontal flares | Cinematic epic, sci-fi, period drama, blockbuster |

---

## Film Stock → Aesthetic

| Film Stock | Color Character | Grain | Best For |
|---|---|---|---|
| Kodak Portra 400 | Warm skin tones, pastel palette, lifted shadows | Fine organic | Portraits, weddings, lifestyle, fashion |
| Kodak Portra 160 | Subtler warmth than 400, lower contrast | Very fine | Studio portraits, beauty, still life |
| Kodak Ektar 100 | Vivid color, high saturation, deep blacks | Ultra fine | Landscape, travel, product |
| Kodak Tri-X 400 | Black and white, rich midtones, deep blacks | Classic medium | Street, documentary, noir, editorial |
| Fujifilm Velvia 50 | Extreme saturation, vivid greens and blues, high contrast | Ultra fine | Landscapes, nature, architecture |
| Fujifilm Superia 400 | Green shift in shadows, muted warm highlights | Medium | Everyday nostalgia, casual snapshots |
| Fujifilm Pro 400H | Soft pastel tones, clean highlights, slight cyan cast | Fine | Fashion, editorial, dreamy portraiture |
| Ilford HP5 Plus 400 | Black and white, softer contrast than Tri-X, open shadows | Classic medium | Documentary, art photography |
| CineStill 800T | Tungsten-balanced, halation around highlights, cinema color | Noticeable | Night photography, neon, urban, cinematic |

**Era shorthand (works as standalone style instruction):**
- "1960s Kodachrome slide film" — saturated, contrasty, warm reds
- "1970s faded color print" — desaturated, yellow-shifted, soft
- "1980s color film, slightly grainy" — moderate saturation, warm, textured
- "90s disposable camera, harsh flash, candid framing" — blown highlights, hard shadows, party aesthetic
- "Early 2000s digital camera" — slightly oversaturated, cool white balance, early DSLR look

---

## Lighting Setups → Prompt Language

| Lighting Setup | Prompt Language |
|---|---|
| Rembrandt | "Dramatic side-lighting with triangle of light on the shadowed cheek" |
| Butterfly/Paramount | "Overhead frontal light creating a butterfly shadow beneath the nose, glamorous" |
| Split lighting | "Light hitting exactly half the face, the other half in complete shadow" |
| Rim/backlight | "Strong backlight creating rim light on hair and shoulders, face in relative shadow" |
| Chiaroscuro | "Stark contrast between bright highlights and deep shadows, dramatic interplay of light and dark" |
| Three-point softbox | "Soft diffused key light from 45 degrees, fill light at half intensity opposite, backlight for separation" |
| High-key | "Bright, even illumination with minimal shadows, white or light background, airy" |
| Low-key | "Predominantly dark frame with selective highlights picking out key details" |
| Golden hour | "Golden hour warm sunlight, long shadows, amber tones, soft directional light" |
| Practical lighting | "Lit by a single desk lamp" or "neon signs casting colored light on wet pavement" |
| Window light | "Soft natural window light from camera-left, gentle falloff across the face" |

**Color grading shorthand:**
- "Cinematic teal-and-orange color grading" — the blockbuster look
- "Muted desaturated neutrals" — indie drama, arthouse
- "Wes Anderson color palette" — pastels, symmetry, storybook warmth
- "Blade Runner 2049 lighting" — neon amber, holographic teal, atmospheric haze
- "Ozark color grade" — cold blue-grey, oppressive, desaturated

---

## Validated Example Prompts

### Cinematic Car Shot

```
A cinematic wide shot of a matte-black Porsche 911 drifting through
rain-slicked Tokyo backstreets at 2 AM. Neon kanji signs bleed
reflections across the wet asphalt. Shot on anamorphic 40mm lens,
f/2.0, with natural motion blur on the wheels.
```

### Collectible Action Figure

```
Create a 1/7 scale collectible figurine of the character in the
uploaded photo, placed on a computer desk in a realistic environment.
The figurine stands on a round transparent acrylic base with no text.
Behind it, the computer screen shows a 3D modeling viewport of this
exact figurine. Next to the screen, a premium collectible packaging
box printed with original artwork of the character. Photorealistic
rendering, soft ambient desk lighting.
```

### Product Photography

```
Hero product image of a matte-black wireless headphone on a polished
obsidian surface. Camera: 85mm macro lens, f/2.8, 45-degree product
angle. Lighting: single soft key light from upper-left, deep shadows
on the right. Subtle reflection in the obsidian surface. Color palette:
muted desaturated neutrals. Negative space on the right for ad copy
overlay. No text, no props. 4K output.
```

### Magazine Cover with Text

```
A high-fashion magazine cover for a publication called "DRIFT." The
cover features a female model in a structured black trenchcoat against
wind and rain, shot from a low angle. The masthead "DRIFT" is in bold
condensed white sans-serif at the top. Below the model: "THE STORM
ISSUE" in smaller caps. Left sidebar headlines: "Berlin After Dark —
12 Pages" and "Why Minimalism Won." Bottom: issue date "March 2026"
and barcode.
```

### Portrait with Film Stock

```
Capture a close-up portrait of an elderly fisherman mending nets at
dawn. Deep weathered face, salt-and-pepper stubble, sun-creased eyes
looking down at his work. Shot on Hasselblad X2D with 100mm lens,
f/2.8. Kodak Portra 400 film stock. Soft golden hour sidelight from
camera-right, cool blue fill from the overcast sky on the shadow side.
Shallow depth of field with fishing nets softly blurred in the
foreground.
```

### Environment Establishing Shot

```
A wide establishing shot of a rain-soaked cyberpunk alleyway at night.
Towering apartment blocks with laundry lines overhead, holographic
advertisements flickering on building facades, steam rising from
grated vents in the street. CineStill 800T film stock aesthetic with
halation around neon lights. 24mm lens, f/4, deep focus. Teal and
magenta color palette with warm pockets of orange street food vendor
light.
```

---

## Multi-Reference Image Roles

When passing multiple images via `image_urls`, assign each a role in the prompt:

| Role | What It Controls | Prompt Pattern |
|---|---|---|
| Identity/character | Face, body, distinctive features | "Use the first image as the character reference" |
| Pose/composition | Body position, framing, camera angle | "Match the pose from the second image" |
| Style/aesthetic | Color palette, rendering style, artistic treatment | "Apply the visual style of the third image" |
| Lighting/atmosphere | Light direction, mood, time of day | "Match the lighting atmosphere from the fourth image" |
| Environment/background | Location, architecture, setting | "Place the character in the environment from the fifth image" |

**Example compositing prompt:**
"Using the first uploaded image as the character (keep her face, hair, and outfit
identical), place her in the environment from the second image. Match the warm
golden-hour lighting from the third image. She is sitting on the steps reading
a book, relaxed posture, looking down."

---

## Character Consistency Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Face changes between shots | Using late-generation images as references | Always reference the original anchor image, not derivatives |
| Clothing color drifts | Vocabulary inconsistency across prompts | Use identical descriptors — exact same words in every prompt |
| Character unrecognizable in wide shots | Small face area, model deprioritizes identity | Add a signature accessory (specific earring, hat, tattoo) as a high-salience anchor |
| Hair/eye color shifts subtly | Ambiguous descriptors ("dark hair") | Be maximally specific: "jet-black straight hair reaching mid-back" |
| Two characters merging | Too many similar-looking characters | Differentiate with contrasting visual elements (color, build, accessories) |
| Expression inconsistent | Expression not specified per shot | State the expression explicitly in every prompt — don't assume carryover |

**The identity tag technique:** Give each character a unique tag (e.g., `<Luna-Ki>`)
and place it in the first 10 words of every prompt. Pair with a fixed one-line
descriptor that never changes:

```
<Luna-Ki>, round eyes, freckled cheeks, teal bob, yellow hoodie,
small silver star earring — sitting at a café table, sipping espresso,
morning sunlight from a large window to her left. Shot on Fujifilm
X-T5, 56mm f/1.2. Soft natural light, warm tones.
```

Every subsequent prompt for this character must repeat `<Luna-Ki>` and the same
descriptor verbatim before the new scene description.

---

## Text Rendering Quick Reference

| Rule | Detail |
|---|---|
| Wrap text in quotes | `"Happy Birthday"` not `Happy Birthday` |
| Specify font style | "bold sans-serif," "elegant script," "condensed uppercase" |
| Specify placement | "centered at top," "bottom-right corner," "across the middle" |
| Word limit per element | 3–5 words per individual text block for best reliability |
| Total word limit | Under 400 words total for 99%+ accuracy |
| Suppress all text | Include "no text" or "no words" — but NEVER use this if you want any text |
| Multiple text elements | Describe each separately with its own placement and style |
