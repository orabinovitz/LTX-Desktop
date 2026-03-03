---
name: video-editing-techniques
description: Professional video editing techniques and best practices for cuts, transitions, pacing, and scene construction. Use when building or modifying timeline editing features, AI shot suggestion logic, transition systems, auto-edit algorithms, or any feature that needs to understand how professional editors think about cuts, pacing, and visual storytelling.
---

# Video Editing Techniques

Reference for professional editing principles. Consult when implementing editing features, AI-assisted editing, shot suggestion, auto-cut, or transition logic.

## The Three Fundamental Decisions

Every edit comes down to three choices:

1. **What to show** — which angle, subject, or detail
2. **When to cut** — the precise frame to leave the current shot
3. **What to cut to** — the next shot and why it follows

## Murch's Rule of Six

Walter Murch's priority list for evaluating each cut (highest to lowest):

| Priority | Criterion | Weight |
|----------|-----------|--------|
| 1 | **Emotion** — does the cut feel right? | 51% |
| 2 | **Story** — does it advance the narrative? | 23% |
| 3 | **Rhythm** — does it happen at the right moment? | 10% |
| 4 | **Eye trace** — does it respect where the viewer is looking? | 7% |
| 5 | **Two-dimensional plane** — does it respect screen geography? | 5% |
| 6 | **Three-dimensional space** — does it maintain spatial continuity? | 4% |

Always satisfy higher priorities first. Break lower rules if it serves emotion or story.

## Pacing

Shot duration controls emotional register:

| Mood | Approach |
|------|----------|
| Contemplative, mournful, suspenseful | Hold shots longer (3-10s+) |
| Tense, building | Gradually shorten shot durations |
| Frantic, chaotic, high-energy | Rapid cuts (<1-2s per shot) |
| Climactic impact | Sudden shift from long holds to rapid cuts (or vice versa) |

Pacing is relative — a 3-second shot feels long after a series of 0.5s shots.

## Six Core Cutting Techniques

### 1. Eyeline Match

Cut to the object of a character's attention. The character looks → we cut to what they see.

**Variants:**
- **Literal POV** — the next shot is exactly what the character sees
- **General perspective** — from the character's approximate vantage point
- **Delayed reveal** — hold on the character's reaction before showing the object (builds tension)
- **Withheld reveal** — never show what they see (builds mystery)

**Shot-reverse shot:** Alternating between subject A and subject B at reverse angles (similar framing). The standard pattern for dialogue coverage.

**Inserts:** A detail shot within the scene (a prop, hands, a screen) prompted by a character's glance. Direct, simple visual language.

**Application in AI editing:**
- When suggesting the next shot after a character looks off-screen, prefer shots that match the eyeline direction
- Shot-reverse shot is the default safe pattern for dialogue sequences
- Insert shots break visual monotony — suggest them when a scene stays on the same angle too long

### 2. Cross-Cutting (Parallel Editing)

Alternating between two or more scenes in different locations, usually happening simultaneously.

**Uses:**
- **Ironic juxtaposition** — contrast between parallel actions (e.g., The Godfather baptism sequence: renouncing evil intercut with ordering murders)
- **Multi-front action** — weaving distinct battle/plot threads into one cohesive sequence
- **Building tension** — alternating between a threat and its unaware target
- **Creating parallels** — connecting thematically related but physically separate events

**Application in AI editing:**
- When multiple generated clips share a temporal relationship, suggest interleaving them
- Cross-cutting requires clear visual distinction between locations so the viewer can track where they are
- Each thread should advance on every visit — don't return to a thread with no new information

### 3. Eye Trace

Cut between shots that keep the viewer's focal point in the same region of the frame.

Especially critical for fast-paced sequences where shots are <1-2 seconds. If the subject jumps across the frame between cuts, the viewer loses tracking and the edit feels jarring.

**Application in AI editing:**
- When auto-composing rapid sequences, check that the primary subject's screen position is consistent across adjacent cuts
- Center-framing is the safest default for action sequences (Mad Max approach)
- For slower pacing, eye trace is less critical — the viewer has time to scan

### 4. Split Edits (J-Cut and L-Cut)

Audio and video transition at different times rather than simultaneously.

| Type | Definition | Timeline shape |
|------|-----------|----------------|
| **J-cut** | Audio from the next shot begins *before* we see it | Audio leads, shaped like J |
| **L-cut** | Audio from the current shot continues *after* we've cut away | Audio trails, shaped like L |

**Uses:**
- Smoothing dialogue — hear the next speaker before cutting to them (J-cut)
- Reaction shots — stay on a listener while the speaker continues (L-cut)
- Scene transitions — audio from the next scene bleeds in to ease the change
- Plan sequences — characters describe a plan while we see it executed (L-cut to show the plan)
- Pacing control — decouple audio rhythm from visual rhythm

**Application in AI editing:**
- Default to split edits over hard cuts for dialogue scenes — they feel more natural
- When joining clips with audio, offset the audio transition by 6-24 frames for smoother flow
- J-cuts work well for scene-to-scene transitions (preview what's coming)

### 5. Intellectual Montage

Juxtaposing seemingly unrelated images to create meaning through context (the Kuleshov Effect).

The same neutral shot takes on different meanings depending on what it's intercut with. Meaning is constructed by the viewer, not stated by the filmmaker.

**Uses:**
- Establishing metaphor (character walking into danger intercut with predator imagery)
- Emphasizing scale or stakes (intercut everyday life with a looming threat)
- Creating subtext without dialogue
- Thematic punctuation between scenes

**Application in AI editing:**
- When building montage sequences, the emotional meaning comes from juxtaposition, not individual shots
- Neutral establishing shots (cityscapes, nature, crowds) are versatile montage material
- The viewer will always try to find a connection — be intentional about what's paired

### 6. Cut on Action

Cut during movement so the motion carries across the edit, making it feel seamless.

**Principle:** The out-point of shot A and the in-point of shot B show the same action at roughly the same phase of movement — the brain fills the gap.

**Variants:**
- **Simple action** — a hand reaching, a door opening, turning a head
- **Cut on impact** — cut at the moment of collision (punch, kick, crash) to amplify force
- **Scale shift** — cut from wide to close-up mid-action for dramatic emphasis
- **Match cut** — graphic or motion match between unrelated subjects (bone → spaceship in 2001)

**Application in AI editing:**
- When trimming clips, prefer cutting during movement over static moments
- Cut on impact points for action sequences
- Match cuts require similar motion vectors — detect motion direction when suggesting pairings

## Additional Techniques

### Jump Cut
Cutting between two shots of the same subject with only a slight change in position/time. Intentionally breaks continuity to show time passing, create unease, or add energy. Use sparingly — reads as an error if unintentional.

### Freeze Frame
Stopping motion on a single frame for emphasis. Often used at emotional peaks or story conclusions. Turns a dynamic moment into a still photograph the viewer must sit with.

### Invisible Cut
Hiding the edit point inside camera movement, a whip pan, a dark frame, or a passing object. Creates the illusion of a single continuous take. Requires precise alignment at the cut point.

### Smash Cut
An abrupt, jarring cut between two tonally different scenes (e.g., screaming → silence, chaos → calm). Maximizes contrast for comedic or dramatic effect.

### Montage (Sequence Montage)
A series of shots compressing time or showing parallel development. Distinguished from intellectual montage by being narrative rather than metaphorical — showing a training sequence, passage of time, or preparation.

### Cutaway
Cutting away from the main action to a related detail, then returning. Provides context, covers continuity issues, or indicates what's on a character's mind.

### Match Cut
A graphic or motion match between the end of one shot and the beginning of the next across different scenes. Creates visual poetry and thematic connections.

## Editing Anti-Patterns

| Anti-pattern | Problem | Fix |
|-------------|---------|-----|
| Cutting on static moments | Edits feel abrupt and unmotivated | Cut during movement |
| Same-size jump | Two similar framings back-to-back | Change angle by 30°+ or change shot size |
| Crossing the line (180° rule) | Spatial disorientation | Keep the camera on one side of the action axis |
| Unmotivated cut | No reason to leave the current shot | Every cut needs a purpose (new info, reaction, rhythm) |
| Cutting too early on dialogue | Telegraphs who will speak next | Use L-cuts to stay on the listener |
| Over-cutting | Too many cuts drain impact | Let strong compositions breathe |
| Ignoring audio continuity | Jarring sound changes at cuts | Use room tone, split edits, and audio crossfades |

## Scene Construction Patterns

### Dialogue Scene (Standard Coverage)
1. Establishing shot (wide)
2. Over-the-shoulder A → B (shot-reverse shot with J/L-cuts)
3. Insert/cutaway for emphasis
4. Return to wide for blocking changes or scene exit

### Action Sequence
1. Establish geography with a wide shot
2. Rapid cuts with eye trace consistency
3. Cut on action and impact
4. Vary shot sizes (wide → close → medium) to maintain energy
5. Use brief pauses (a wide shot hold) before the next burst

### Montage / Passage of Time
1. Consistent pacing rhythm (shots of similar duration)
2. Music drives the cut points
3. Each shot adds new visual information
4. End with a shot that re-anchors the narrative

### Suspense Build
1. Long holds to establish normalcy
2. Gradually shorter shots as tension builds
3. Eyeline matches to delayed or withheld reveals
4. Cross-cutting between threat and target
5. Cut timing falls slightly before the viewer expects it

## Quick Reference for AI Shot Suggestion

When suggesting the next shot in a sequence, evaluate candidates by:

1. **Does it advance the story?** (Murch priority 1-2)
2. **Does the pacing match the scene's emotional register?** (priority 3)
3. **Is the primary subject positioned consistently for eye trace?** (priority 4)
4. **Does it maintain screen geography?** (priority 5-6)
5. **Can the transition use a split edit or cut on action?** (smoother feel)
6. **Does it provide new visual information?** (avoid redundancy)

For additional reference material on specific techniques, see [references.md](references.md).
