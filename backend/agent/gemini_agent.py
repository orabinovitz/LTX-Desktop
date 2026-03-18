"""Gemini function-calling agent for the LTX Desktop agentic editor.

Orchestrates a multi-turn conversation with Gemini 3 Flash, feeding
timeline context and tool definitions so the model can plan and execute
video-editing operations.  Backend tools (e.g. ``get_video_metadata``)
are resolved inline; frontend tools are returned to the React app for
execution.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
import uuid
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from agent.tool_knowledge_base import (
    build_category_catalog,
    build_workflow_recipes,
    classify_intent,
    filter_categories_for_view,
    get_tools_for_categories,
    get_tools_for_categories_and_view,
)
from agent.tool_registry import TOOLS_BY_NAME, tools_to_gemini_declarations
from agent.types import (
    DESTRUCTIVE_TOOLS,
    MEMORY_WRITE_TOOLS,
    AgentExecuteRequest,
    AgentExecuteResponse,
    ExecutionTarget,
    TimelineState,
    ToolCall,
    ToolResult,
    VideoMetadata,
)
from agent import brain as brain_module
from agent import project_memory
from agent import video_analyzer
from agent.scene_decomposer import decompose_to_scenes
from services.http_client.http_client import HTTPClient, HttpConnectionError, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MAX_TURNS = 20
"""Hard ceiling on agentic loop iterations to prevent runaway calls."""

_GEMINI_MODEL = "gemini-3.1-pro-preview"
_FALLBACK_MODEL = "gemini-3-flash-preview"


_ROLE_MAP: dict[str, str] = {"user": "user", "agent": "model", "assistant": "model", "model": "model"}

_backend_tool_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="backend-tool")

SYSTEM_PROMPT = """\
You are a senior video editor with years of professional editing experience, \
integrated into the LTX Desktop NLE. You think like an editor — you \
understand pacing, shot selection, continuity, and storytelling.

## Your Mindset
- Think about what makes a good edit, not just what the user literally said.
- If the user says "make a short video from these clips", that means: \
select the best moments, trim each shot to its essential action, arrange \
them with good pacing, and close all gaps.
- Take editorial initiative. If a shot has dead air before the action, \
trim it. If there are gaps between clips, close them.
- Explain your editorial reasoning briefly so the user understands \
your choices.

## Workflow
1. Timeline state is already in your context. Call `get_timeline_state` \
only when you need updated clip IDs after splits, because split \
operations create new clip IDs.
2. Check Project Memory in your context for existing scripts, research, \
or decisions relevant to the current request.
3. If a project brain is in your context, use `query_project_brain` \
to find clips relevant to the request before loading metadata — this \
avoids expensive metadata calls for irrelevant clips.
4. Call `get_video_metadata` only for clips you actually plan to use.
5. Plan your edit strategy. Think about the final result, not just \
individual operations.
6. If the timeline has existing clips worth preserving, duplicate first.
7. Execute edits in logical order. After trims/deletes, close gaps.
8. When you produce creative outputs (scripts, shot lists), save them \
to project memory. When the user expresses creative preferences, \
record them with `add_memory_note`.
9. Summarize what you did and why — then stop. Trust tool results.

## Project Brain
Your context includes a Project Brain — a high-level index of all \
content in this project organized by topic. It tells you what clips \
exist and what they contain without loading detailed metadata upfront.

When asked to create an edit on a specific topic:
1. Read the brain summary to understand available content.
2. Use `query_project_brain` to find relevant clips.
3. Call `get_video_metadata` for the specific clips you plan to use.
4. Use `get_transcript_segment` to verify what's said in a range.
5. If a long video has not been decomposed, use `decompose_video` first.

Be selective — a professional editor picks the strongest 3-5 moments \
that build a narrative arc (hook, body, closure), not every clip that \
mentions the topic.

### Sub-clip Assets
Some assets are sub-clips with `parentAssetId`, `sourceIn`, and \
`sourceOut` fields — virtual clips from longer videos. When you add \
a sub-clip via `add_clip_to_timeline`, the system sets trim points \
automatically. The `topics` field tells you what each sub-clip covers.

## Content Generation

You can generate new content using AI:

### Text-to-Video (T2V)
`generate_video(mode='text_to_video', prompt=...)` — write detailed \
prompts describing scene, camera movement, lighting, and action.

### Image-to-Video (I2V)
First `generate_image(prompt=...)`, then animate with \
`generate_video(mode='image_to_video', image_asset_id=<id>, prompt=...)`. \
The I2V prompt describes motion, not the static scene.

### Audio-to-Video (A2V)
`generate_video(mode='audio_to_video', audio_asset_id=<id>, prompt=...)`

### Text-to-Image (T2I)
- **Nano Banana 2** (default): Higher quality, supports editing/references. \
Use `generate_image(prompt=...)`. Resolution: '1K', '2K', '4K'. \
Pass aspect_ratio='16:9' for standard video unless user requests otherwise.
- **Z-Image Turbo**: Fast. `generate_image(prompt=..., model='z-image-turbo')`. \
Resolution: '1080p', '1440p', '2048p'.

### Image Editing with Nano Banana 2
Pass source asset IDs in `image_urls` to edit or composite images: \
`generate_image(prompt='desired result', image_urls=['id-1', 'id-2'])`. \
The prompt should describe the DESIRED RESULT, not the source images.

### Retake
`retake_section(video_asset_id=..., start_time=..., duration=..., prompt=...)` \
regenerates a portion of an existing video.

### Multi-step Generation
1. `generate_image(prompt=<subject>)` → asset_id
2. `generate_video(mode='image_to_video', image_asset_id=<id>, prompt=<motion>)` → video_id
3. `add_clip_to_timeline(asset_id=<video_id>, track_index=0, start_time=...)`

Generation takes 20-120 seconds; the tool blocks until complete.

### Generation Prompts
Write prompts like a cinematographer — describe the SCENE (environment, \
lighting), ACTION (movement, gestures), and CAMERA (angle, movement, \
focal length) with specificity.

## Editing Rules

### Gaps and Continuity
After any trim, delete, or split operation, close gaps between clips \
on the same track by using `move_clip` to slide subsequent clips left \
or using `ripple=true` on delete operations. A professional edit has \
no unintentional dead space — the timeline should be tight and \
continuous.

### Smart Trimming
When trimming for a compilation or short edit:
- Use video metadata (scenes, importance scores) to find the best moments.
- Trim from both ends — remove dead air at the start, excess at the end.
- Aim for punchy, well-paced cuts. A 30-second raw clip might need \
only its best 5-8 seconds.
- Match the energy: fast cuts for action, longer holds for emotional beats.

### Transitions
Use hard cuts by default. Dissolves belong only at major section breaks \
(time jumps, location changes, emotional shifts) because overusing them \
weakens their impact.

### Timeline Safety
- Use `create_timeline` for a fresh start. Use `duplicate_timeline` \
only when preserving existing work before destructive changes.

### Linked Clips
Linked clips share operations automatically — calling an operation on \
ONE clip in a linked group applies it to all siblings. Operate on a \
single clip from each linked group and let the linking propagate.

## Scene-Based Editing (Smart Cuts)
Video metadata provides scene boundaries in source-media time. \
To convert to timeline time: \
`timeline_time = clip.startTime + (scene_time - clip.trimStart) / clip.speed`

Workflow for content-based cuts (e.g. "remove the part where X happens"):
1. Read video metadata scenes for the clip.
2. Find scene(s) matching the user's request.
3. Convert scene times to timeline times.
4. `split_clip` at entry and exit points.
5. Call `get_timeline_state` to get new clip IDs (splits create new IDs).
6. `delete_clip` the unwanted section with `ripple=true`.

### Editorial Blade Cuts
Use `split_clip` to create cut points that improve pacing within \
continuous footage. This lets you remove filler, reorder phrases, \
and tighten the rhythm. Place a segment, split at the desired points, \
delete weak sections with `ripple=true`.

## Pacing by Format
Adapt your approach to the format:
- **Social media**: Fast, punchy cuts every 3-8s. Total 30-60s.
- **Trailer / Promo**: Build momentum — start slower, accelerate. 60-120s.
- **Documentary**: Let moments breathe. Longer holds for emotion.
- **Cinematic**: Slow, deliberate pacing. Atmosphere over density.

## Edit Structure
**Hook**: The single most compelling statement on the topic — a specific \
claim, surprising detail, or bold assertion delivered with energy. Start \
the source_in at the exact moment the speaker begins the key phrase. \
Use transcript timestamps precisely.

**Body**: Arranged for narrative flow, strongest points first. Each \
segment should contain the speaker actively making a point.

**Closure**: A conclusive, forward-looking statement. The viewer should \
feel the edit is complete.

For interview content, the strongest quotes are typically 15-30s into a \
response where the speaker has warmed up. The last take of a repeated \
answer usually has the best delivery. Re-order quotes for narrative impact.

## Track & Clip Management
- Add/delete tracks: `add_track` / `delete_track`
- Track state: `set_track_state` (mute, lock, solo)
- Clip properties: volume, opacity, color correction
- Link/unlink clips for synchronized editing
- Subtitles: `add_subtitle`
- Export: `export_timeline`
- Undo/redo: `undo` / `redo`

## Project Memory
You have access to the project's persistent memory — a shared context \
store that persists across sessions. When starting creative work or \
multi-step edits, check project memory for existing context. Save \
significant creative outputs (scripts, shot lists, research) to memory \
so future agents can build on them.

Available memory tools:
- `save_to_project_memory` — save a new document
- `update_project_memory` — update an existing document by ID
- `read_project_memory` — read a document's full content by ID
- `list_project_memory` — list all documents
- `add_memory_note` — record a preference or decision
- `update_project_context` — update the master project summary

## Response Style
- Be concise and professional. Brief editorial reasoning, then action.
- For creative outputs (scripts, visual guides), match the detail level \
the task requires.
- After edits, give a short summary and finish immediately.
- If the request is ambiguous, ask one clarifying question.
- Use seconds for all time references so tools can parse them.
- The formatting in these instructions is for organizational clarity. \
Match your response format to the user's request.
"""

# ---------------------------------------------------------------------------
# Conditional instruction modules — loaded based on task classification
# ---------------------------------------------------------------------------

_LONG_FORM_EDITING_INSTRUCTIONS = """\
## Long-Form Content Editing (Raw Footage to Short Cut)

When creating a short edit from a long video on a specific topic:

### Step 1: Read the full transcript
Call `get_full_transcript(asset_id)` for all dialogue with precise \
timestamps — this is faster and more reliable than guessing time ranges.

### Step 2: Find the best material
Scan the transcript for the strongest quotes on the requested topic. \
For each candidate, note the exact start_time and end_time.

Select 3-6 segments that form a tight narrative:
- **Hook** (2-5s): The most compelling sentence — a specific claim, \
surprising detail, or bold assertion with energy and clarity.
- **Body** (20-35s): Concrete details, specific information, strongest quotes.
- **Closure** (3-8s): A conclusive, forward-looking statement on a \
complete sentence.

### Step 3: Extract segments to timeline
Use `add_clip_to_timeline` with `source_in` and `source_out` set to \
the exact transcript timestamps. Use at least 3 separate segments — \
a single clip from a long video is insufficient for a short social cut.

### Step 4: Arrange for narrative flow
Hook first, core content in the middle, closure at the end. Arrange \
for impact rather than chronological order from the source.

### Step 5: Tighten and polish
Close all gaps between segments. Use `split_clip` to remove pauses, \
filler words, or weak moments within segments. Use `trim_clip` to \
fine-tune in/out points.

### Step 6: Review
Reconstruct the edit transcript and call `review_edit_quality`. If \
scores are below threshold, revise up to 2 times before delivering \
the best version with improvement notes.

### Key principles for long-form editing:
- Extract specific segments using source_in/source_out rather than \
placing the entire raw video on the timeline and trimming afterward.
- Verify content with `get_transcript_segment` before adding each \
segment to confirm the speaker is discussing the requested topic.
- For interview footage, prioritize segments with high energy and \
importance scores (>= 0.7). The speaker should be actively making \
a point, not pausing or between takes.
- Start and end each segment on complete sentences.
- For social media cuts, include only the subject's answers — the \
viewer does not need to hear the questions.
- Total duration should match the user's requested length (±5s).
"""

_BULK_OPERATIONS_INSTRUCTIONS = """\
## Bulk Operations

When performing an operation on all items matching a criteria:
1. Call `get_project_assets` to see the full list.
2. Identify all matching items before starting operations.
3. Use `batch_delete_assets` for multi-asset deletion (single call \
with all matching IDs) because individual deletes are slow.
4. After operations, call `get_project_assets` again to verify the \
count — tool responses include `remaining_asset_count`.
5. If matching items remain, continue until the count reaches zero.
Verify completion via the asset list before reporting success.
"""

GENERAL_CONTEXT_PROMPT = """\
You are an AI assistant integrated into LTX Desktop, a professional \
video editing application. You are executing a task as part of a \
larger workflow managed by an orchestrator.

## Project Memory
You have access to the project's persistent memory — a shared context \
store that persists across sessions and is available to all agents.

When starting creative work or multi-step tasks, check project memory \
(provided in your context) for existing scripts, research, storyboards, \
or user preferences that previous agents created.

When you produce scripts, shot lists, visual guides, or other significant \
creative outputs, save them to project memory using `save_to_project_memory` \
with an appropriate type and descriptive title — this ensures future \
agents can build on your work.

When the user expresses preferences about creative direction, record \
them with `add_memory_note` so future tasks respect those decisions.

Available memory tools:
- `save_to_project_memory` — save a new document
- `update_project_memory` — update an existing document by ID
- `read_project_memory` — read a document's full content by ID
- `list_project_memory` — list all documents (with optional type filter)
- `add_memory_note` — append a preference/decision to the memory log
- `update_project_context` — update the master project context summary

## Content Generation
You can generate new content using AI:
- **Text-to-Video**: `generate_video(mode='text_to_video', prompt=...)`
- **Image-to-Video**: First `generate_image(prompt=...)`, then \
`generate_video(mode='image_to_video', image_asset_id=<id>, prompt=...)`
- **Audio-to-Video**: `generate_video(mode='audio_to_video', audio_asset_id=<id>, prompt=...)`
- **Text-to-Image**: `generate_image(prompt=...)` (Nano Banana 2 default) \
or `generate_image(prompt=..., model='z-image-turbo')` for fast generation
- **Image Editing**: Pass source asset IDs in `image_urls` parameter of \
`generate_image` to edit or composite images

Write generation prompts like a cinematographer — describe the scene, \
action, camera angle, and lighting with specificity. "A golden retriever \
running through autumn leaves in a park, golden hour lighting, handheld \
camera" beats "a dog running."

## Response Style
When responding directly to the user, be concise and professional. \
For creative outputs (scripts, visual guides, shot lists), match the \
detail level the task requires — creative work benefits from specificity \
and depth. Summarize what you accomplished at the end.

The formatting in these instructions is for organizational clarity. \
Match your response format to what is appropriate for the task — brief \
prose for simple tasks, structured output when the task requires it.
"""


_EDITING_MODE_APPENDIX = """\
## PROFESSIONAL EDITING: How to Think Like an Editor

You are not a clip-placement machine. You are an editor. Every cut you make has a reason. \
Every duration you choose creates a feeling. If you place 10 clips at the same duration, \
you have failed -- that is not editing, that is a slideshow.

### Pacing Comes From CONTRAST

Pacing is NOT about making clips short or long. It is about the RELATIONSHIP between \
adjacent shot durations. A 3-second clip feels fast only after a 10-second shot. Five \
3-second clips in a row feel robotic and monotonous. Three clips at 4s-4s-4s is worse \
than 2s-6s-3s even though the average is similar.

**HARD RULES:**
- Adjacent clips MUST differ in duration by at least 30%.
  - If clip A is 4s, clip B CANNOT be 3-5s. It must be under 3s or over 5s.
- NEVER place more than 2 clips in a row within 1s of each other's duration.
- NEVER alternate in a predictable pattern (short-long-short-long is a failure mode).
- Plan your rhythm curve BEFORE placing clips. Think: establish (medium) → build (shorter) \
→ breathe (longer) → climax (short burst) → resolve (medium-long).

### Shot Duration by Content Type

Use video metadata (shot_type, importance scores) to determine duration:

| Content | Duration | Reason |
|---------|----------|--------|
| Wide/establishing/aerial | 5-10s | Viewer needs time to absorb the environment |
| Medium shot (main action) | 3-6s | The standard building block of any edit |
| Close-up / detail | 2-4s | Punchy, adds emphasis, then move on |
| Reaction / cutaway | 1-3s | Brief punctuation between main shots |
| Action / high-energy | 1.5-3s | Rapid, kinetic energy |
| Emotional / contemplative | 6-12s | Let the moment breathe |

If metadata gives you shot_type, use it. If not, estimate from the scene description.

### MANDATORY: Plan Before You Place

Before placing ANY clips on the timeline, you MUST:
1. Analyze ALL clips with get_video_metadata to understand their content.
2. Write a shot list: which clips in what order, with planned duration for each.
3. Apply the rhythm curve: start medium → accelerate → breathe → climax → resolve.
4. Verify no two adjacent durations are within 30% of each other.
5. ONLY THEN start placing and trimming clips.

Output your planned shot list briefly in your response like:
"Shot plan: wide cat (6s) → close-up paw (2.5s) → medium jump (4s) → wide landing (7s) → \
close face (3s) → action chase (2s) → wide resolution (8s)"

### Structure for Compilation Edits

When editing a set of clips into a cohesive sequence:

**Opening (first 1-2 clips):** Establish the world. Use your strongest wide or \
visually-striking shot. Hold it 5-10 seconds so the viewer knows where they are.

**Build (middle clips):** Alternate between medium shots and close-ups/details. \
Gradually shorten durations as energy builds. This is where variety matters most -- \
no two clips should feel the same length.

**Breath (midpoint):** After 4-6 rapid cuts, drop in one longer hold (6-10s) to let \
the viewer reset. This contrast makes the fast sections feel faster.

**Climax (near the end):** The fastest cuts of the entire edit. 1.5-3s each. \
The most dynamic or impactful moments.

**Resolution (final clip):** Return to a longer, calmer shot (5-10s). This is the \
emotional landing. The edit should feel COMPLETE, not like it ran out of clips.

### Trimming (EVERY clip gets trimmed)

1. NEVER leave a clip at its original full length. That is raw footage, not an edit.
2. For EACH clip, call get_video_metadata and find the strongest scene (importance > 0.7).
3. Calculate trim deltas to keep ONLY the best segment at the duration from your shot plan.
4. If a clip has dead air, action starting late, or a slow tail -- trim aggressively.
5. After trimming, close ALL gaps. A professional edit has no dead space.

### Cut Motivation (Murch's Rule of Six)

Every cut must satisfy at least one of these (in priority order):
1. **Emotion** -- does the cut feel right at this moment?
2. **Story** -- does the next shot add new information?
3. **Rhythm** -- does the cut land on the beat?
4. **Eye trace** -- is the viewer's attention carried across the cut?

NEVER cut just because "it's been N seconds." If a shot is still compelling, let it play.

### After ALL edits, call review_edit_quality to score the edit.
If score < 7, identify and tighten the weakest clips, then re-review. \
Check specifically: are any adjacent clips within 30% duration of each other? \
Is the rhythm curve monotonous? Does the edit have a clear open-build-breathe-climax-resolve?
"""

_IMAGE_GENERATION_APPENDIX = """\
## Image Generation: Model Selection

**Nano Banana 2 (default):**
- Higher quality, supports editing/compositing with reference images
- Resolution: '1K' (default), '2K', '4K' (higher cost at 2K/4K)
- **Aspect ratio: ALWAYS pass aspect_ratio='16:9'** unless the user explicitly requests a different ratio. \
This ensures all images match the standard 1920x1080 video frame.
- Use for: hero shots, character close-ups, detailed scenes, image editing
- Pass image_urls (asset IDs) when you need to combine or edit existing images

**Z-Image Turbo:**
- Faster generation, text-to-image only (no editing support)
- Resolution: '1080p', '1440p', '2048p'
- Use for: quick thumbnails, placeholder images, high volume generation

**Image editing workflow:**
1. Generate or identify source images (characters, backgrounds, objects)
2. Use get_project_assets() to get their asset IDs
3. Call generate_image(prompt=<desired result>, image_urls=[<asset-id-1>, <asset-id-2>])
4. The prompt should describe the DESIRED RESULT, not the source images

**Character reference workflow (when establishing new characters):**
When the project has a Visual Identity Bible or style guide in memory and the user \
asks to work on character visuals/looks/design:
1. Check project memory for existing character reference sheets
2. If none exist, generate CHARACTER REFERENCE SHEETS — not standalone images:
   - Use a turnaround/reference sheet prompt format showing the character from \
multiple angles against a neutral or contextual background
   - Include the character's fixed identity tag (one-line descriptor) in the prompt
   - Give each character one signature accessory for downstream recognition
   - Lock vocabulary: use identical descriptors across all subsequent prompts
3. Save each reference sheet to project memory with type "character_sheet"
4. Use the reference sheet asset_id in image_urls for ALL subsequent images \
of that character — always reference the ORIGINAL sheet, never derivatives

**Character consistency across existing shots:**
- Use the character's reference sheet asset_id in image_urls for every generation
- Describe the same character details (clothing, hair, features) in every prompt
- Always reference the ORIGINAL anchor image, never the 5th+ derivative (errors compound)
- Use identical vocabulary across prompts — switching "emerald eyes" to "green eyes" causes drift

**NB2 prompting best practices (critical for quality):**
- NB2 is an LLM-backbone model. Write full natural-language sentences, NOT keyword lists.
  Bad: "cool car, neon, city, night, rain, 8k, cinematic, masterpiece"
  Good: "A matte-black sports car drifting through rain-slicked Tokyo backstreets at 2 AM, \
neon kanji signs bleeding reflections across the wet asphalt."
- Name real camera hardware for photorealism: "Shot on Sony A7III, 85mm f/1.8" or \
"Kodak Portra 400 film stock" — each triggers distinct, learned visual DNA.
- Be specific about lighting: "Soft key light from the upper left with warm rim light \
separating the subject from a dark background" beats "cinematic lighting."
- For editing, always describe both the change AND what to preserve: "Change the background \
to a modern office. Keep the person's pose, clothing, and expression identical."
- Iterate at 1K resolution, finalize winners at 2K or 4K.
"""

_GENERATION_MODE_APPENDIX = """\
## Video Generation: Model and Duration Selection

When generating videos, choose model and duration intelligently:

**Model selection:**
- Use **pro** for: cinematic shots, complex motion, detailed scenes, high-quality short clips (max 10s)
- Use **fast** for: simple content, landscapes, talking heads, any video > 10 seconds

**Duration selection (pick the CLOSEST valid value):**
- pro model: 6, 8, or 10 seconds only
- fast model: 6, 8, 10, 12, 14, 16, 18, or 20 seconds

**Guidelines:**
- Quick action/reaction shot: 6s (pro)
- Standard scene: 8-10s (pro for quality, fast if simple)
- Extended scene or monologue: 12-16s (fast only)
- Long continuous shot: 18-20s (fast only)
- If user says "long" or "extended": use fast, 16-20s
- If user says "cinematic" or "high quality": use pro, 8-10s
- If user doesn't specify: default to fast, 8s
- NEVER use duration=5. The minimum valid duration is 6.

**Multi-shot sequences (dialogue, shot-reverse-shot):**
- NEVER generate all shots at the same duration. Vary EVERY shot based on its content.
- Short reaction or brief response: 6s
- Medium line of dialogue: 8-10s
- Long monologue or speech: 14-20s (use fast model)
- Cutaway or establishing shot: 6s
- Pattern example for a dialogue scene:
  Character A speaks (8s) → Character B responds briefly (6s) →
  Character A long monologue (16s, fast) → B reaction (6s) → B responds (10s)
- Match duration to the content described in the prompt for each individual shot.
- Think like a film editor: pacing comes from contrast between short and long shots.
"""

# ---------------------------------------------------------------------------
# Rate limiting — sliding window on Gemini API calls
# ---------------------------------------------------------------------------

_RATE_LIMIT_WINDOW_SECONDS = 60.0
_RATE_LIMIT_MAX_CALLS = 30

_rate_limit_timestamps: deque[float] = deque()
_rate_limit_lock = threading.Lock()


def _check_rate_limit() -> None:
    """Raise if too many Gemini calls have been made in the current window."""
    with _rate_limit_lock:
        now = time.monotonic()
        cutoff = now - _RATE_LIMIT_WINDOW_SECONDS
        while _rate_limit_timestamps and _rate_limit_timestamps[0] < cutoff:
            _rate_limit_timestamps.popleft()
        if len(_rate_limit_timestamps) >= _RATE_LIMIT_MAX_CALLS:
            logger.warning("Agent rate limit exceeded (%d calls in %.0fs)", _RATE_LIMIT_MAX_CALLS, _RATE_LIMIT_WINDOW_SECONDS)
            raise RuntimeError(
                f"Rate limit exceeded: maximum {_RATE_LIMIT_MAX_CALLS} agent calls "
                f"per {int(_RATE_LIMIT_WINDOW_SECONDS)}s. Please wait a moment."
            )
        _rate_limit_timestamps.append(now)


# ---------------------------------------------------------------------------
# Session storage
# ---------------------------------------------------------------------------

_MAX_SESSIONS = 50
_SESSION_TTL_SECONDS = 1800  # 30 minutes
_MAX_HISTORY_TURNS = 20
"""Keep at most this many conversation entries (user/model/function).

When the history exceeds this, the oldest entries (after the first user
message which contains timeline context) are dropped to bound memory."""

@dataclass
class _SessionData:
    contents: list[dict[str, Any]]
    scoped_categories: list[str]
    view_context: str
    last_access: float
    project_id: str | None = None


_sessions: OrderedDict[str, _SessionData] = OrderedDict()
"""Maps session IDs to session data."""


def _evict_stale_sessions() -> None:
    """Remove sessions older than TTL and enforce max session count."""
    now = time.monotonic()
    stale = [
        sid for sid, sd in _sessions.items()
        if now - sd.last_access > _SESSION_TTL_SECONDS
    ]
    for sid in stale:
        del _sessions[sid]
    while len(_sessions) > _MAX_SESSIONS:
        evicted_id, _ = _sessions.popitem(last=False)
        logger.info("Evicted oldest session %s (at capacity)", evicted_id[:8])


def _get_session(session_id: str) -> _SessionData | None:
    """Get session data, updating access time. Returns None if not found."""
    if session_id not in _sessions:
        return None
    sd = _sessions[session_id]
    sd.last_access = time.monotonic()
    _sessions.move_to_end(session_id)
    return sd


def _truncate_history(contents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trim conversation history to bound memory, keeping the first user
    message (which carries timeline/brain context) and the most recent turns."""
    if len(contents) <= _MAX_HISTORY_TURNS:
        return contents
    # Always keep the first message (initial context) + last N-1 turns
    return [contents[0]] + contents[-((_MAX_HISTORY_TURNS) - 1):]


def _set_session(
    session_id: str,
    contents: list[dict[str, Any]],
    *,
    scoped_categories: list[str] | None = None,
    view_context: str | None = None,
    project_id: str | None = None,
) -> None:
    """Create or update a session."""
    existing = _sessions.get(session_id)
    cats = scoped_categories or (existing.scoped_categories if existing else [])
    vc = view_context or (existing.view_context if existing else "editor")
    pid = project_id or (existing.project_id if existing else None)
    _sessions[session_id] = _SessionData(
        contents=_truncate_history(contents),
        scoped_categories=cats,
        view_context=vc,
        last_access=time.monotonic(),
        project_id=pid,
    )


def create_session(
    *,
    scoped_categories: list[str] | None = None,
    view_context: str = "editor",
    project_id: str | None = None,
) -> str:
    """Create a new conversation session and return its UUID."""
    _evict_stale_sessions()
    session_id = uuid.uuid4().hex
    _set_session(
        session_id, [],
        scoped_categories=scoped_categories or [],
        project_id=project_id,
        view_context=view_context,
    )
    logger.info("Created agent session %s (total: %d)", session_id, len(_sessions))
    return session_id


# ---------------------------------------------------------------------------
# Public entry-points
# ---------------------------------------------------------------------------


def execute_prompt(
    request: AgentExecuteRequest,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> tuple[str, AgentExecuteResponse]:
    """Start or continue an agentic loop for the given user prompt.

    If ``request.session_id`` references an existing session the new user
    message is appended to the full Gemini conversation history (which
    includes all prior function calls and results).  Otherwise a fresh
    session is created.

    Returns ``(session_id, response)`` where *response* may contain
    frontend tool calls that the caller must execute and feed back via
    :func:`continue_with_results`.
    """
    # Classify intent to scope tools for this request, filtered by view
    view_ctx = request.view_context.value if request.view_context else "editor"
    scoped_categories = classify_intent(request.prompt)
    scoped_categories = filter_categories_for_view(scoped_categories, view_ctx)
    scoped_tools = get_tools_for_categories_and_view(scoped_categories, view_ctx)
    logger.info(
        "[agent] intent classification (view=%s): %s → %d tools from %s",
        view_ctx,
        request.prompt[:80],
        len(scoped_tools),
        scoped_categories,
    )

    # Reuse existing session when available so full Gemini history
    # (including function calls / results) is preserved.
    existing = (
        request.session_id
        and _get_session(request.session_id) is not None
    )
    if existing:
        session_id = request.session_id  # type: ignore[assignment]
        logger.info("Reusing existing session %s", session_id)
        sd = _get_session(session_id)
        if sd is not None:
            sd.scoped_categories = scoped_categories
            sd.view_context = view_ctx
            if request.project_id:
                sd.project_id = request.project_id
    else:
        session_id = create_session(
            scoped_categories=scoped_categories,
            view_context=view_ctx,
            project_id=request.project_id,
        )

    # -- Build context text from timeline state --------------------------
    context_parts: list[str] = []

    if request.timeline_state is not None:
        context_parts.append(_format_timeline_context(request.timeline_state))

        # Attach video metadata for every asset already on the timeline
        seen_assets: set[str] = set()
        for clip in request.timeline_state.clips:
            if not clip.asset_id or clip.asset_id in seen_assets:
                continue
            seen_assets.add(clip.asset_id)
            meta = video_analyzer.get_metadata(clip.asset_id)
            if meta is not None:
                context_parts.append(_format_video_metadata(meta))

    # Inject project brain summary — schedule async build if none exists yet.
    # Skip auto-rebuild for suppressed projects (user explicitly cleared the brain).
    if request.project_id:
        project_brain = brain_module.get_brain(request.project_id)
        if project_brain is None and not brain_module.is_suppressed(request.project_id):
            all_meta = video_analyzer.get_all_complete_metadata()
            if all_meta and gemini_api_key:
                logger.info(
                    "No brain for project %s — scheduling background build from %d analyses",
                    request.project_id[:8], len(all_meta),
                )
                brain_module.schedule_brain_build(
                    request.project_id, all_meta, gemini_api_key, http_client,
                )
        if project_brain is not None:
            context_parts.append(brain_module.format_brain_for_agent(project_brain))

    # Inject project memory context only when relevant (creative work,
    # memory-related keywords, or the project already has stored memory).
    if request.project_id:
        should_inject_memory = (
            "memory" in scoped_categories
            or project_memory.has_memory(request.project_id)
        )
        if should_inject_memory:
            memory_ctx = project_memory.format_memory_for_agent(request.project_id)
            if memory_ctx:
                context_parts.append(memory_ctx)

    # Inject assets/view context from GenSpace or other non-editor views
    if request.assets_context:
        context_parts.append(_format_assets_context(request.assets_context))

    # -- Build the user message ------------------------------------------
    user_text_parts: list[str] = []
    if view_ctx != "editor":
        view_label = {"genspace": "Gen Space (asset gallery)", "playground": "Playground (standalone generation)"}.get(view_ctx, view_ctx)
        if view_ctx == "genspace":
            user_text_parts.append(
                f"## Active View\nYou are currently in the **{view_label}** view. "
                "Generation and asset tools work here. If the user's request requires "
                "timeline or editing operations (create_timeline, add_clip_to_timeline, "
                "trim_clip, etc.), call switch_view('video-editor') FIRST, then proceed "
                "with the editing tools in the next step."
            )
        else:
            user_text_parts.append(
                f"## Active View\nYou are assisting in the **{view_label}** view. "
                "Focus on generation."
            )
    if context_parts:
        user_text_parts.append(
            "## Current View Context\n" + "\n\n".join(context_parts)
        )
    user_text_parts.append(f"## User Request\n{request.prompt}")

    user_message: dict[str, Any] = {
        "role": "user",
        "parts": [{"text": "\n\n".join(user_text_parts)}],
    }

    if existing:
        sd = _get_session(session_id)
        if sd is not None:
            sd.contents.append(user_message)
    else:
        contents: list[dict[str, Any]] = []
        for msg in request.conversation_history:
            gemini_role = _ROLE_MAP.get(msg.role, "user")
            contents.append({"role": gemini_role, "parts": [{"text": msg.content}]})
        contents.append(user_message)
        _set_session(session_id, contents, scoped_categories=scoped_categories)

    logger.info(
        "[agent] session=%s | execute_prompt: %.120s",
        session_id[:8],
        request.prompt,
    )

    t0 = time.monotonic()
    response = _call_gemini(session_id, gemini_api_key, http_client, project_id=request.project_id)
    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s | execute_prompt completed in %.1fs (done=%s, tools=%d)",
        session_id[:8],
        elapsed,
        response.done,
        len(response.tool_calls),
    )
    return session_id, response


def continue_with_results(
    session_id: str,
    tool_results: list[ToolResult],
    gemini_api_key: str,
    http_client: HTTPClient,
    updated_context: str | None = None,
) -> AgentExecuteResponse:
    """Feed frontend tool-execution results back and continue the loop.

    Raises ``KeyError`` if the session does not exist.
    """
    sd = _get_session(session_id)
    if sd is None:
        raise KeyError(f"Unknown session: {session_id}")

    function_response_parts: list[dict[str, Any]] = []
    for tr in tool_results:
        payload: dict[str, Any] = (
            {"result": tr.result} if tr.success else {"error": tr.error or "unknown error"}
        )
        fn_name = tr.tool_name or tr.call_id or "unknown"
        function_response_parts.append(
            {"functionResponse": {"name": fn_name, "response": payload}}
        )

    sd.contents.append(
        {"role": "function", "parts": function_response_parts}
    )

    if updated_context:
        sd.contents.append(
            {"role": "user", "parts": [{"text": updated_context}]}
        )

    result_summary = [
        f"{tr.tool_name}:{'ok' if tr.success else 'FAIL'}"
        for tr in tool_results
    ]
    logger.info(
        "[agent] session=%s | continue_with_results: %s",
        session_id[:8],
        result_summary,
    )

    t0 = time.monotonic()
    response = _call_gemini(session_id, gemini_api_key, http_client, project_id=sd.project_id)
    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s | continue completed in %.1fs (done=%s, tools=%d)",
        session_id[:8],
        elapsed,
        response.done,
        len(response.tool_calls),
    )
    return response


# ---------------------------------------------------------------------------
# Core Gemini caller + agentic loop
# ---------------------------------------------------------------------------


def _call_gemini(
    session_id: str,
    api_key: str,
    http_client: HTTPClient,
    _depth: int = 0,
    project_id: str | None = None,
) -> AgentExecuteResponse:
    """Make a single Gemini generateContent call and process the result.

    If only backend tools are requested, they are executed inline and the
    results are fed back (recursive call).  Frontend tool calls are returned
    to the caller.  Recursion is capped at ``_MAX_TURNS``.
    """
    _check_rate_limit()

    if _depth >= _MAX_TURNS:
        logger.warning(
            "Session %s hit max turns (%d) — forcing completion",
            session_id,
            _MAX_TURNS,
        )
        return AgentExecuteResponse(
            message="I've reached the maximum number of steps. Here's what I've done so far.",
            done=True,
        )

    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_GEMINI_MODEL}:generateContent"
    )

    sd = _get_session(session_id)
    if sd is None:
        return AgentExecuteResponse(
            message="Session expired or not found.",
            done=True,
        )

    num_messages = len(sd.contents)
    logger.info(
        "[agent] session=%s turn=%d | calling %s | %d messages",
        session_id[:8],
        _depth,
        _GEMINI_MODEL,
        num_messages,
    )

    # Use scoped tools when available, fall back to all tools
    view_ctx = sd.view_context if sd.view_context else "editor"
    scoped_tools = (
        get_tools_for_categories_and_view(sd.scoped_categories, view_ctx)
        if sd.scoped_categories
        else None
    )
    tool_declarations = tools_to_gemini_declarations(scoped_tools)

    # Build dynamic system prompt with category catalog
    dynamic_prompt = SYSTEM_PROMPT
    if sd.scoped_categories:
        catalog = build_category_catalog(sd.scoped_categories)
        recipes = build_workflow_recipes(sd.scoped_categories)
        dynamic_prompt = SYSTEM_PROMPT + "\n\n" + catalog
        if recipes:
            dynamic_prompt += "\n\n" + recipes
        if "clip_editing" in sd.scoped_categories:
            dynamic_prompt += "\n\n" + _EDITING_MODE_APPENDIX
        if "generation" in sd.scoped_categories:
            dynamic_prompt += "\n\n" + _IMAGE_GENERATION_APPENDIX
            dynamic_prompt += "\n\n" + _GENERATION_MODE_APPENDIX
        if "analysis" in sd.scoped_categories or "review" in sd.scoped_categories:
            dynamic_prompt += "\n\n" + _LONG_FORM_EDITING_INSTRUCTIONS
        if "asset_mgmt" in sd.scoped_categories:
            dynamic_prompt += "\n\n" + _BULK_OPERATIONS_INSTRUCTIONS

    payload: dict[str, Any] = {
        "contents": sd.contents,
        "systemInstruction": {"parts": [{"text": dynamic_prompt}]},
        "tools": [{"functionDeclarations": tool_declarations}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 16384},
    }

    # -- HTTP call with retry on 503 / connection errors ------------------
    t0 = time.monotonic()
    response = None
    _MAX_RETRIES = 3
    for _attempt in range(_MAX_RETRIES):
        try:
            response = http_client.post(
                gemini_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=300,
            )
            if response.status_code != 503:
                break
            wait = min(1 * (2 ** _attempt) + random.random(), 10)
            logger.warning(
                "[agent] session=%s | Gemini returned 503, retrying in %.1fs (attempt %d/%d)",
                session_id[:8], wait, _attempt + 1, _MAX_RETRIES,
            )
            time.sleep(wait)
        except HttpTimeoutError:
            elapsed = time.monotonic() - t0
            logger.error("[agent] session=%s | Gemini timed out after %.1fs", session_id[:8], elapsed, exc_info=True)
            return AgentExecuteResponse(
                message="The AI service timed out. Please try again.",
                done=True,
            )
        except HttpConnectionError:
            if _attempt < _MAX_RETRIES - 1:
                wait = min(2 * (2 ** _attempt) + random.random(), 15)
                logger.warning(
                    "[agent] session=%s | Gemini connection error, retrying in %.1fs (attempt %d/%d)",
                    session_id[:8], wait, _attempt + 1, _MAX_RETRIES,
                )
                time.sleep(wait)
                continue
            elapsed = time.monotonic() - t0
            logger.error("[agent] session=%s | Gemini connection failed after %d attempts (%.1fs)", session_id[:8], _MAX_RETRIES, elapsed, exc_info=True)
            return AgentExecuteResponse(
                message="Failed to reach the AI service. Please check your connection and try again.",
                done=True,
            )
        except Exception:
            elapsed = time.monotonic() - t0
            logger.error("[agent] session=%s | Gemini request failed after %.1fs", session_id[:8], elapsed, exc_info=True)
            return AgentExecuteResponse(
                message="Failed to reach the AI service. Please check your connection and try again.",
                done=True,
            )

    if response is None:
        return AgentExecuteResponse(
            message="Failed to reach the AI service after retries.",
            done=True,
        )

    # -- Fallback to Flash if Pro is still returning 503 ------------------
    if response.status_code == 503 and _GEMINI_MODEL != _FALLBACK_MODEL:
        fallback_url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{_FALLBACK_MODEL}:generateContent"
        )
        logger.warning(
            "[agent] session=%s | %s exhausted 503 retries, falling back to %s",
            session_id[:8], _GEMINI_MODEL, _FALLBACK_MODEL,
        )
        try:
            response = http_client.post(
                fallback_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=300,
            )
        except HttpTimeoutError:
            logger.error("[agent] session=%s | Fallback model also timed out", session_id[:8], exc_info=True)
            return AgentExecuteResponse(
                message="The AI service timed out on both primary and fallback models.",
                done=True,
            )
        except Exception:
            logger.error("[agent] session=%s | Fallback model request failed", session_id[:8], exc_info=True)
            return AgentExecuteResponse(
                message="Failed to reach the AI service.",
                done=True,
            )

    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s turn=%d | Gemini responded HTTP %d in %.1fs (~%.1fKB)",
        session_id[:8],
        _depth,
        response.status_code,
        elapsed,
        len(response.text) / 1024,
    )

    if response.status_code != 200:
        logger.error(
            "[agent] session=%s | Gemini error body: %s",
            session_id[:8],
            response.text[:500],
        )
        return AgentExecuteResponse(
            message=f"AI service returned an error (HTTP {response.status_code}). Please try again.",
            done=True,
        )

    # -- Parse response --------------------------------------------------
    try:
        body = response.json()
        parts: list[dict[str, Any]] = body["candidates"][0]["content"]["parts"]  # type: ignore[index]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error(
            "[agent] session=%s | malformed Gemini response: %s — body: %s",
            session_id[:8],
            exc,
            response.text[:300],
        )
        return AgentExecuteResponse(
            message="Received an unexpected response from the AI service.",
            done=True,
        )

    # Append the model turn to history and truncate if oversized
    sd_model = _get_session(session_id)
    if sd_model is not None:
        sd_model.contents.append({"role": "model", "parts": parts})
        sd_model.contents = _truncate_history(sd_model.contents)

    # -- Separate text from function calls --------------------------------
    text_fragments: list[str] = []
    frontend_tool_calls: list[ToolCall] = []
    backend_tool_calls: list[ToolCall] = []

    for part in parts:
        if "text" in part:
            text_fragments.append(part["text"])
        elif "functionCall" in part:
            fc = part["functionCall"]
            tool_name: str = fc.get("name", "")
            arguments: dict[str, Any] = fc.get("args", {})

            tool_def = TOOLS_BY_NAME.get(tool_name)
            if tool_def is None:
                logger.warning(
                    "Session %s: Gemini called unknown tool '%s' — skipping",
                    session_id,
                    tool_name,
                )
                continue

            tc = ToolCall(
                tool_name=tool_name,
                arguments=arguments,
                call_id=tool_name,
            )

            if tool_def.execution_target == ExecutionTarget.BACKEND:
                backend_tool_calls.append(tc)
            else:
                frontend_tool_calls.append(tc)

    combined_text = "\n".join(text_fragments).strip()

    tool_names_fe = [tc.tool_name for tc in frontend_tool_calls]
    tool_names_be = [tc.tool_name for tc in backend_tool_calls]
    logger.info(
        "[agent] session=%s turn=%d | parsed: text=%d chars, frontend_tools=%s, backend_tools=%s",
        session_id[:8],
        _depth,
        len(combined_text),
        tool_names_fe or "none",
        tool_names_be or "none",
    )

    # -- No tool calls at all → we're done --------------------------------
    if not frontend_tool_calls and not backend_tool_calls:
        logger.info("[agent] session=%s | done (text-only response)", session_id[:8])
        return AgentExecuteResponse(
            message=combined_text,
            done=True,
        )

    # -- Execute backend tools inline (parallel when multiple) ------------
    if backend_tool_calls:
        if len(backend_tool_calls) == 1:
            backend_results = [
                _execute_backend_tool(backend_tool_calls[0], api_key=api_key, http_client=http_client, session_id=session_id, project_id=project_id)
            ]
        else:
            backend_results = list(_backend_tool_pool.map(
                lambda tc: _execute_backend_tool(tc, api_key=api_key, http_client=http_client, session_id=session_id, project_id=project_id),
                backend_tool_calls,
            ))

        # Feed results back into conversation
        fn_response_parts: list[dict[str, Any]] = []
        for tr in backend_results:
            payload_inner: dict[str, Any] = (
                {"result": tr.result}
                if tr.success
                else {"error": tr.error or "unknown error"}
            )
            fn_response_parts.append(
                {"functionResponse": {"name": tr.call_id, "response": payload_inner}}
            )

        sd_be = _get_session(session_id)
        if sd_be is not None:
            sd_be.contents.append(
                {"role": "function", "parts": fn_response_parts}
            )

    had_memory_writes = any(tc.tool_name in MEMORY_WRITE_TOOLS for tc in backend_tool_calls)

    # -- If there are frontend tool calls, return them to the caller ------
    if frontend_tool_calls:
        has_destructive = any(tc.tool_name in DESTRUCTIVE_TOOLS for tc in frontend_tool_calls)
        logger.info(
            "[agent] session=%s turn=%d | returning %d frontend tool(s) to UI: %s (destructive=%s)",
            session_id[:8],
            _depth,
            len(frontend_tool_calls),
            [tc.tool_name for tc in frontend_tool_calls],
            has_destructive,
        )
        return AgentExecuteResponse(
            plan=combined_text,
            tool_calls=frontend_tool_calls,
            message=combined_text,
            done=False,
            memory_updated=had_memory_writes,
            requires_confirmation=has_destructive,
        )

    # -- Only backend tools were called — recurse to continue the loop ----
    child = _call_gemini(session_id, api_key, http_client, _depth=_depth + 1, project_id=project_id)
    if had_memory_writes and not child.memory_updated:
        child.memory_updated = True
    return child


# ---------------------------------------------------------------------------
# Backend tool executor
# ---------------------------------------------------------------------------


def _execute_backend_tool(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
    session_id: str,
    project_id: str | None = None,
) -> ToolResult:
    """Execute a backend-side tool and return the result."""
    logger.info("Executing backend tool: %s(%s)", tool_call.tool_name, tool_call.arguments)

    def _review_quality(tc: ToolCall) -> ToolResult:
        return _handle_review_edit_quality(tc, api_key=api_key, http_client=http_client)

    def _review_structure(tc: ToolCall) -> ToolResult:
        return _handle_review_edit_structure(tc, api_key=api_key, http_client=http_client)

    def _memory_tool(tc: ToolCall) -> ToolResult:
        return _handle_memory_tool(tc, project_id=project_id)

    handlers: dict[str, Any] = {
        "get_video_metadata": _handle_get_video_metadata,
        "query_project_brain": _handle_query_brain,
        "get_transcript_segment": _handle_get_transcript_segment,
        "decompose_video": _handle_decompose_video,
        "suggest_prompt": _handle_suggest_prompt,
        "get_full_transcript": _handle_get_full_transcript,
        "review_edit_quality": _review_quality,
        "review_edit_structure": _review_structure,
        "save_to_project_memory": _memory_tool,
        "update_project_memory": _memory_tool,
        "read_project_memory": _memory_tool,
        "list_project_memory": _memory_tool,
        "add_memory_note": _memory_tool,
        "update_project_context": _memory_tool,
    }

    try:
        handler = handlers.get(tool_call.tool_name)
        if handler is None:
            return ToolResult(
                call_id=tool_call.call_id,
                success=False,
                error=f"Unknown backend tool: {tool_call.tool_name}",
            )
        return handler(tool_call)
    except Exception as exc:
        logger.error(
            "[agent] session=%s | Backend tool '%s' raised an exception",
            session_id[:8], tool_call.tool_name, exc_info=True,
        )
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=str(exc),
        )


def _handle_get_video_metadata(tool_call: ToolCall) -> ToolResult:
    """Handle the ``get_video_metadata`` backend tool."""
    asset_id = tool_call.arguments.get("asset_id", "")
    if not asset_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: asset_id",
        )

    meta = video_analyzer.get_metadata(asset_id)
    if meta is None:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"No metadata available for asset '{asset_id}'. "
            "The video may not have been analyzed yet.",
        )

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result=meta.model_dump(mode="json"),
    )


def _handle_query_brain(tool_call: ToolCall) -> ToolResult:
    """Handle the ``query_project_brain`` backend tool."""
    query = tool_call.arguments.get("query", "")
    if not query:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: query",
        )

    # Search across all project brains (we don't know project_id in the tool call)
    all_results: list[dict] = []
    for project_id in brain_module.get_all_project_ids():
        results = brain_module.query_brain(project_id, query)
        for clip in results:
            entry = clip.model_dump(mode="json")
            # Include source_in/source_out for topic segments so the
            # agent can use them directly with add_clip_to_timeline
            if clip.is_topic_segment and clip.source_in is not None:
                entry["source_time_range"] = {
                    "source_in": clip.source_in,
                    "source_out": clip.source_out,
                }
            all_results.append(entry)

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "query": query,
            "matches": all_results[:20],
            "total_matches": len(all_results),
        },
    )


def _handle_get_transcript_segment(tool_call: ToolCall) -> ToolResult:
    """Handle the ``get_transcript_segment`` backend tool."""
    asset_id = tool_call.arguments.get("asset_id", "")
    start_time = float(tool_call.arguments.get("start_time", 0))
    end_time = float(tool_call.arguments.get("end_time", 0))

    if not asset_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: asset_id",
        )

    meta = video_analyzer.get_metadata(asset_id)
    if meta is None:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"No metadata for asset '{asset_id}'.",
        )

    lines = []
    for dl in meta.dialogue:
        if dl.end_time > start_time and dl.start_time < end_time:
            speaker = f"[{dl.speaker}] " if dl.speaker else ""
            lines.append(f"{dl.start_time:.1f}s: {speaker}{dl.text}")

    transcript = "\n".join(lines) if lines else "(no dialogue in this range)"

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "asset_id": asset_id,
            "start_time": start_time,
            "end_time": end_time,
            "transcript": transcript,
            "line_count": len(lines),
        },
    )


def _handle_decompose_video(tool_call: ToolCall) -> ToolResult:
    """Handle the ``decompose_video`` backend tool."""
    asset_id = tool_call.arguments.get("asset_id", "")
    if not asset_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: asset_id",
        )

    meta = video_analyzer.get_metadata(asset_id)
    if meta is None:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"No metadata for asset '{asset_id}'. Analyze the video first.",
        )

    if not meta.scenes:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Video has no detected scenes to decompose.",
        )

    subclip_defs = decompose_to_scenes(meta)
    subclips = [
        {
            "parent_asset_id": sc.parent_asset_id,
            "source_in": sc.source_in,
            "source_out": sc.source_out,
            "title": sc.title,
            "description": sc.description,
            "transcript": sc.transcript,
            "topics": sc.topics,
        }
        for sc in subclip_defs
    ]

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "asset_id": asset_id,
            "subclips": subclips,
            "count": len(subclips),
        },
    )


def _handle_suggest_prompt(tool_call: ToolCall) -> ToolResult:
    """Handle the ``suggest_prompt`` backend tool."""
    before_prompt = tool_call.arguments.get("before_prompt", "")
    after_prompt = tool_call.arguments.get("after_prompt", "")
    mode = tool_call.arguments.get("mode", "text_to_video")
    duration = tool_call.arguments.get("duration")

    suggestion_parts: list[str] = []
    if before_prompt:
        suggestion_parts.append(f"Previous clip: {before_prompt}")
    if after_prompt:
        suggestion_parts.append(f"Next clip: {after_prompt}")
    suggestion_parts.append(f"Mode: {mode}")
    if duration:
        suggestion_parts.append(f"Target duration: {duration}s")

    suggested = (
        f"A smooth transition scene connecting "
        f"{'the previous and next clips' if before_prompt and after_prompt else 'to the surrounding content'}. "
        f"{'Based on: ' + before_prompt[:100] if before_prompt else 'Creative establishing shot'}."
    )

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "suggested_prompt": suggested,
            "context": " | ".join(suggestion_parts),
        },
    )


def _build_sentences(dialogue: list[Any], max_gap: float = 2.0) -> list[dict[str, Any]]:
    """Merge consecutive dialogue lines into sentences based on punctuation and gaps."""
    if not dialogue:
        return []

    sentences: list[dict[str, Any]] = []
    current = {
        "start": dialogue[0].start_time,
        "end": dialogue[0].end_time,
        "text": dialogue[0].text,
    }

    for dl in dialogue[1:]:
        gap = dl.start_time - current["end"]
        ends_sentence = current["text"].rstrip().endswith((".", "!", "?"))

        if gap > max_gap or ends_sentence:
            if len(current["text"].split()) >= 3:
                sentences.append(current)
            current = {"start": dl.start_time, "end": dl.end_time, "text": dl.text}
        else:
            current["end"] = dl.end_time
            current["text"] += " " + dl.text

    if len(current["text"].split()) >= 3:
        sentences.append(current)

    return sentences


def _handle_get_full_transcript(tool_call: ToolCall) -> ToolResult:
    """Return the complete dialogue transcript with sentence boundaries."""
    asset_id = tool_call.arguments.get("asset_id", "")
    if not asset_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: asset_id",
        )

    meta = video_analyzer.get_metadata(asset_id)
    if meta is None:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"No metadata for asset '{asset_id}'. The video may not have been analyzed yet.",
        )

    sentences = _build_sentences(meta.dialogue)

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "asset_id": asset_id,
            "total_duration": meta.duration,
            "line_count": len(sentences),
            "sentences": [
                {
                    "index": i,
                    "start": round(s["start"], 1),
                    "end": round(s["end"], 1),
                    "duration": round(s["end"] - s["start"], 1),
                    "text": s["text"],
                }
                for i, s in enumerate(sentences)
            ],
        },
    )


def _gemini_review_call(
    prompt: str,
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
    label: str,
    max_output_tokens: int = 4096,
) -> ToolResult:
    """Shared helper for Gemini-based review tool calls (quality + structure)."""
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_GEMINI_MODEL}:generateContent"
    )
    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
        },
    }

    t0 = time.monotonic()
    try:
        resp = http_client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
            json_payload=payload,
            timeout=60,
        )
        if resp.status_code != 200:
            return ToolResult(
                call_id=tool_call.call_id,
                success=False,
                error=f"Gemini {label} API error: {resp.status_code}",
            )

        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        result = json.loads(text)
        logger.info("%s completed in %.1fs", label, time.monotonic() - t0)

        return ToolResult(
            call_id=tool_call.call_id,
            success=True,
            result=result,
        )
    except Exception as exc:
        logger.error("%s failed after %.1fs (call_id=%s)", label, time.monotonic() - t0, tool_call.call_id, exc_info=True)
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"{label} failed: {exc}",
        )


def _handle_review_edit_quality(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
) -> ToolResult:
    """Evaluate edit quality by analyzing the transcript text with Gemini."""
    topic = tool_call.arguments.get("topic", "")
    edit_transcript = tool_call.arguments.get("edit_transcript", "")
    target_duration = tool_call.arguments.get("target_duration", 45)

    if not edit_transcript:
        return ToolResult(call_id=tool_call.call_id, success=False, error="Missing required argument: edit_transcript")
    if not api_key or not http_client:
        return ToolResult(call_id=tool_call.call_id, success=False, error="No active Gemini API key available for review.")

    prompt = (
        "You are a professional video editor reviewing a short-form edit. "
        "Score each dimension 1-10 and provide specific feedback.\n\n"
        f"TOPIC: {topic or 'General'}\n"
        f"TARGET DURATION: {target_duration}s\n\n"
        f"EDIT TRANSCRIPT:\n{edit_transcript}\n\n"
        "Score these dimensions:\n"
        "- hook_quality: Does the first sentence grab attention? No filler, no questions.\n"
        "- pacing_quality: Are segments tight? No dead air, no unnecessary repetition.\n"
        "- content_relevance: Is every sentence on-topic and informative?\n"
        "- closure_quality: Does the edit end on a complete, conclusive thought?\n"
        "- sentence_completeness: Are all sentences complete? No mid-word cuts, no fragments.\n"
        "- overall_score: Weighted average (hook 30%, pacing 20%, content 20%, closure 15%, sentences 15%).\n\n"
        "Return ONLY valid JSON:\n"
        '{"hook_quality": N, "pacing_quality": N, "content_relevance": N, '
        '"closure_quality": N, "sentence_completeness": N, "overall_score": N, '
        '"feedback": ["specific issue 1", "specific issue 2", ...]}'
    )
    return _gemini_review_call(prompt, tool_call, api_key=api_key, http_client=http_client, label="review_edit_quality", max_output_tokens=4096)


def _handle_review_edit_structure(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
) -> ToolResult:
    """Analyze the narrative structure of a timeline edit with Gemini."""
    edit_transcript = tool_call.arguments.get("edit_transcript", "")
    topic = tool_call.arguments.get("topic", "")

    if not edit_transcript:
        return ToolResult(call_id=tool_call.call_id, success=False, error="Missing required argument: edit_transcript")
    if not api_key or not http_client:
        return ToolResult(call_id=tool_call.call_id, success=False, error="No active Gemini API key available for review.")

    prompt = (
        "You are a professional editor analyzing the narrative structure of a short-form edit.\n\n"
        f"TOPIC: {topic or 'General'}\n\n"
        f"EDIT TRANSCRIPT:\n{edit_transcript}\n\n"
        "Analyze the structure and score each dimension 1-10:\n"
        "- narrative_arc: Does it have setup → development → resolution?\n"
        "- opening_effectiveness: Does the first sentence work as a standalone hook?\n"
        "- topic_coherence: Does every sentence serve the topic?\n"
        "- transition_quality: Do segments flow logically?\n"
        "- closure_strength: Does the final sentence feel conclusive?\n"
        "- sentence_integrity: Are all sentences complete (no fragments)?\n"
        "- information_density: Is there filler or repetition?\n"
        "- structure_score: Overall weighted score.\n\n"
        "Also provide:\n"
        "- story_summary: 1-2 sentence summary of the edit\n"
        "- segment_analysis: Array of {role, text, issues} for each segment\n"
        "- recommendations: Array of 3-5 specific improvements\n\n"
        "Return ONLY valid JSON."
    )
    return _gemini_review_call(prompt, tool_call, api_key=api_key, http_client=http_client, label="review_edit_structure", max_output_tokens=8192)


# ---------------------------------------------------------------------------
# Context formatters
# ---------------------------------------------------------------------------


def _format_assets_context(ctx: dict[str, object]) -> str:
    """Format the GenSpace assets/view context for the LLM user message."""
    lines: list[str] = []

    gen_mode = ctx.get("generationMode", "unknown")
    prompt_bar = ctx.get("promptBarText", "")
    selected_id = ctx.get("selectedAssetId")
    active_bin = ctx.get("activeBin", "all")
    visible = ctx.get("visibleAssets", [])

    lines.append(f"**Generation mode**: {gen_mode}")
    if prompt_bar:
        lines.append(f"**Prompt bar**: \"{prompt_bar}\"")
    if selected_id:
        lines.append(f"**Selected asset**: {selected_id}")
    if active_bin and active_bin != "all":
        lines.append(f"**Active bin**: {active_bin}")

    if isinstance(visible, list) and visible:
        # Group assets by bin for better comprehension
        by_bin: dict[str, list[dict[str, object]]] = {}
        for asset in visible:
            if not isinstance(asset, dict):
                continue
            bin_name = str(asset.get("bin") or "Unorganized")
            by_bin.setdefault(bin_name, []).append(asset)

        total = sum(len(v) for v in by_bin.values())
        lines.append(f"**Assets** ({total}, most recent first, archived excluded):")

        for bin_name, assets in by_bin.items():
            if len(by_bin) > 1:
                lines.append(f"  [{bin_name}]")
            for asset in assets:
                a_id = asset.get("id", "?")
                a_type = asset.get("type", "?")
                a_name = asset.get("name")
                a_tags = asset.get("tags", [])
                a_prompt = asset.get("prompt", "")
                parts = [f"{a_id}: {a_type}"]
                if a_name:
                    parts.append(f'name="{a_name}"')
                if a_tags:
                    parts.append(f"tags=[{', '.join(str(t) for t in a_tags)}]")
                prompt_preview = a_prompt[:80] if a_prompt else "(no prompt)"
                parts.append(f'prompt="{prompt_preview}"')
                indent = "    " if len(by_bin) > 1 else "  "
                lines.append(f"{indent}- {', '.join(parts)}")
    else:
        lines.append("**Assets**: (none)")

    return "\n".join(lines)


def _format_timeline_context(state: TimelineState) -> str:
    """Format a TimelineState into a human-readable string for the LLM."""
    lines: list[str] = [
        f"**Timeline**: {state.track_count} tracks, "
        f"total duration {state.total_duration:.2f}s, "
        f"playhead at {state.playhead_time:.2f}s",
    ]

    if not state.clips:
        lines.append("  (no clips on timeline)")
        return "\n".join(lines)

    lines.append(f"  {len(state.clips)} clip(s):")
    for clip in state.clips:
        linked_str = ""
        if clip.linked_clip_ids:
            linked_str = f"  linked={clip.linked_clip_ids}"
        lines.append(
            f"  - clip_id={clip.id}  asset={clip.asset_id}  "
            f"type={clip.type}  track={clip.track_index}  "
            f"start={clip.start_time:.2f}s  dur={clip.duration:.2f}s  "
            f"trim_start={clip.trim_start:.2f}  trim_end={clip.trim_end:.2f}  "
            f"speed={clip.speed:.2f}x{linked_str}"
        )

    return "\n".join(lines)


def _format_video_metadata(meta: VideoMetadata) -> str:
    """Format VideoMetadata into a human-readable string for the LLM."""
    lines: list[str] = [
        f"**Video Metadata for asset {meta.asset_id}**:",
        f"  duration={meta.duration:.2f}s  "
        f"resolution={meta.resolution[0]}x{meta.resolution[1]}  "
        f"fps={meta.fps:.1f}  status={meta.analysis_status.value}",
    ]

    if meta.summary:
        lines.append(f"  Summary: {meta.summary}")

    if meta.scenes:
        lines.append(f"  {len(meta.scenes)} scene(s):")
        for i, scene in enumerate(meta.scenes, 1):
            lines.append(
                f"    Scene {i}: {scene.start_time:.2f}s–{scene.end_time:.2f}s  "
                f"importance={scene.importance:.2f}  shot={scene.shot_type}  "
                f"desc=\"{scene.description}\""
            )
            if scene.actions:
                lines.append(f"      actions: {', '.join(scene.actions)}")

    if meta.dialogue:
        lines.append(f"  {len(meta.dialogue)} dialogue line(s):")
        for dl in meta.dialogue:
            speaker = f"[{dl.speaker}] " if dl.speaker else ""
            lines.append(
                f"    {dl.start_time:.2f}s–{dl.end_time:.2f}s: "
                f"{speaker}\"{dl.text}\""
            )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Project memory tool handlers
# ---------------------------------------------------------------------------


def _handle_memory_tool(
    tool_call: ToolCall,
    *,
    project_id: str | None,
) -> ToolResult:
    """Dispatch memory tool calls to the project_memory module."""
    if not project_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="No project_id available — memory tools require an active project.",
        )

    name = tool_call.tool_name
    args = tool_call.arguments

    try:
        if name == "save_to_project_memory":
            title = args.get("title", "")
            doc_type_str = args.get("type", "notes")
            content = args.get("content", "")
            if not title or not content:
                return ToolResult(call_id=tool_call.call_id, success=False, error="title and content are required")
            from agent.types import MemoryDocumentType
            type_map = {t.value: t for t in MemoryDocumentType}
            doc_type = type_map.get(doc_type_str, MemoryDocumentType.NOTES)
            tags_raw = args.get("tags", [])
            tags = tags_raw if isinstance(tags_raw, list) else []
            meta = project_memory.write_document(
                project_id=project_id,
                title=title,
                doc_type=doc_type,
                content=content,
                description=args.get("description", ""),
                tags=tags,
                created_by=f"agent",
            )
            return ToolResult(call_id=tool_call.call_id, result=meta.model_dump(mode="json"))

        if name == "update_project_memory":
            doc_id = args.get("document_id", "")
            if not doc_id:
                return ToolResult(call_id=tool_call.call_id, success=False, error="document_id is required")
            tags_raw = args.get("tags")
            tags = tags_raw if isinstance(tags_raw, list) else None
            meta = project_memory.update_document(
                project_id=project_id,
                doc_id=doc_id,
                content=args.get("content"),
                title=args.get("title"),
                description=args.get("description"),
                tags=tags,
            )
            if meta is None:
                return ToolResult(call_id=tool_call.call_id, success=False, error=f"Document '{doc_id}' not found")
            return ToolResult(call_id=tool_call.call_id, result=meta.model_dump(mode="json"))

        if name == "read_project_memory":
            doc_id = args.get("document_id", "")
            if not doc_id:
                return ToolResult(call_id=tool_call.call_id, success=False, error="document_id is required")
            doc = project_memory.read_document(project_id, doc_id)
            if doc is None:
                return ToolResult(call_id=tool_call.call_id, success=False, error=f"Document '{doc_id}' not found")
            return ToolResult(call_id=tool_call.call_id, result={"title": doc.meta.title, "type": doc.meta.type, "content": doc.content, "version": doc.meta.version})

        if name == "list_project_memory":
            from agent.types import MemoryDocumentType
            type_filter_str = args.get("type_filter")
            doc_type_filter = None
            if type_filter_str:
                type_map = {t.value: t for t in MemoryDocumentType}
                doc_type_filter = type_map.get(type_filter_str)
            docs = project_memory.list_documents(project_id, doc_type=doc_type_filter)
            return ToolResult(call_id=tool_call.call_id, result=[d.model_dump(mode="json") for d in docs])

        if name == "add_memory_note":
            note = args.get("note", "")
            if not note:
                return ToolResult(call_id=tool_call.call_id, success=False, error="note is required")
            project_memory.append_memory_entry(project_id, note)
            return ToolResult(call_id=tool_call.call_id, result="Memory note saved.")

        if name == "update_project_context":
            content = args.get("content", "")
            if not content:
                return ToolResult(call_id=tool_call.call_id, success=False, error="content is required")
            project_memory.update_context(project_id, content)
            return ToolResult(call_id=tool_call.call_id, result="Project context updated.")

        return ToolResult(call_id=tool_call.call_id, success=False, error=f"Unknown memory tool: {name}")

    except ValueError as e:
        return ToolResult(call_id=tool_call.call_id, success=False, error=str(e))
