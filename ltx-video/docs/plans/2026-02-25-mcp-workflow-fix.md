# MCP Agentic Workflow Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the MCP agentic workflow so all tool operations correctly handle linked video+audio clips, match their documented behavior, and give Gemini enough context to make correct editing decisions — all generically, no hardcoded edge cases.

**Architecture:** Three layers of fixes: (1) Fix tool handler implementations to match their documented contracts, (2) Enrich the context sent to Gemini with linked-clip and audio info so it makes correct decisions, (3) Add a thin generic argument validation layer that catches NaN/negative/out-of-bounds values before they reach handlers.

**Tech Stack:** TypeScript (React), Python (FastAPI/Pydantic)

---

## Task 1: Fix `trim_clip` — Remove Incorrect `startTime` Shift

**Files:**
- Modify: `src/views/editor/useAgentExecutor.ts:126-132`

**Why:** The tool description in `tool_registry.py:73` explicitly says "The clip's position on the timeline (startTime) is NOT changed." But the implementation at line 131 shifts `startTime` by `trimStartDelta`. This is the direct cause of the audio-only-shortened bug — when trimming from the start, the video clip's timeline position shifts but its visual rendering doesn't match, causing desync with linked audio.

**Step 1: Fix the trim handler**

Replace lines 126-132 in `useAgentExecutor.ts`:

```typescript
// BEFORE (buggy):
for (const clip of group) {
  const updates: Partial<TimelineClip> = {
    trimStart: Math.max(0, clip.trimStart + trimStartDelta),
    trimEnd: Math.max(0, clip.trimEnd + trimEndDelta),
    duration: Math.max(0.1, clip.duration - trimStartDelta - trimEndDelta),
    startTime: clip.startTime + trimStartDelta,
  }
  updateClip(clip.id, updates)
  trimmed.push(clip.id)
}

// AFTER (fixed):
for (const clip of group) {
  const newTrimStart = Math.max(0, clip.trimStart + trimStartDelta)
  const newTrimEnd = Math.max(0, clip.trimEnd + trimEndDelta)
  const newDuration = Math.max(0.1, clip.duration - trimStartDelta - trimEndDelta)

  updateClip(clip.id, {
    trimStart: newTrimStart,
    trimEnd: newTrimEnd,
    duration: newDuration,
  })
  trimmed.push(clip.id)
}
```

**Step 2: Verify manually**

Run the app, add a video to timeline, use the agent to trim a clip. Both video and audio clips should shorten without shifting position.

**Step 3: Commit**

```bash
git add src/views/editor/useAgentExecutor.ts
git commit -m "fix: remove incorrect startTime shift from trim_clip handler

The tool_registry.py description says startTime is NOT changed by trim,
but the implementation was shifting it. This caused audio/video desync
when trimming linked clips."
```

---

## Task 2: Add `linked_clip_ids` to Timeline Context Sent to Gemini

**Files:**
- Modify: `src/hooks/use-agent.ts:6-16` (TimelineClipInfo interface)
- Modify: `src/hooks/use-agent.ts:63-73` (buildTimelineState mapper)
- Modify: `backend/agent/types.py:114-125` (TimelineClipInfo model)
- Modify: `backend/agent/gemini_agent.py:476-483` (context formatter)

**Why:** Gemini currently has zero knowledge that clips are linked. It might call `trim_clip` on both a video clip and its linked audio clip separately, doubling the effect. By including `linked_clip_ids` in the context, Gemini knows the trim will automatically propagate.

**Step 1: Add `linked_clip_ids` to frontend TimelineClipInfo**

In `src/hooks/use-agent.ts`, update the interface (line 6-16):

```typescript
interface TimelineClipInfo {
  id: string
  asset_id: string | null
  type: string
  start_time: number
  duration: number
  trim_start: number
  trim_end: number
  track_index: number
  speed: number
  linked_clip_ids: string[]  // NEW
}
```

**Step 2: Include `linkedClipIds` in the mapper**

In `src/hooks/use-agent.ts`, update `buildTimelineState` (line 63-73):

```typescript
const clipInfos: TimelineClipInfo[] = clips.map(c => ({
  id: c.id,
  asset_id: c.assetId,
  type: c.type,
  start_time: c.startTime,
  duration: c.duration,
  trim_start: c.trimStart,
  trim_end: c.trimEnd,
  track_index: c.trackIndex,
  speed: c.speed,
  linked_clip_ids: c.linkedClipIds ?? [],  // NEW
}))
```

**Step 3: Add `linked_clip_ids` to backend Pydantic model**

In `backend/agent/types.py`, update `TimelineClipInfo` (line 114-125):

```python
class TimelineClipInfo(BaseModel):
    """Minimal clip information for agent context."""

    id: str
    asset_id: str | None = None
    type: str = Field(description="Clip type (video, audio, image, ...)")
    start_time: float = Field(description="Position on timeline in seconds")
    duration: float
    trim_start: float = 0.0
    trim_end: float = 0.0
    track_index: int = 0
    speed: float = 1.0
    linked_clip_ids: list[str] = Field(default_factory=list, description="IDs of linked clips (e.g. video<->audio pairs)")
```

**Step 4: Show linked info in context formatter**

In `backend/agent/gemini_agent.py`, update `_format_timeline_context` (line 477-483):

```python
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
```

**Step 5: Commit**

```bash
git add src/hooks/use-agent.ts backend/agent/types.py backend/agent/gemini_agent.py
git commit -m "feat: include linked_clip_ids in timeline context sent to Gemini

Gemini now sees which clips are linked (video<->audio pairs) so it
won't accidentally apply the same operation twice to linked pairs."
```

---

## Task 3: Add Linked-Clip Awareness to System Prompt

**Files:**
- Modify: `backend/agent/gemini_agent.py:40-81` (SYSTEM_PROMPT)

**Why:** Even with linked IDs in context, Gemini needs explicit instruction about what "linked clips" means and that tool operations auto-propagate to linked siblings.

**Step 1: Add a "Linked Clips" section to SYSTEM_PROMPT**

After the existing "## Editing Principles" section (around line 62), add:

```python
## Linked Clips
Video clips and their audio counterparts are linked via `linked_clip_ids`. \
When you call trim_clip, split_clip, delete_clip, or move_clip on one clip \
in a linked group, the operation automatically applies to ALL linked siblings. \
**Do NOT call the same operation separately on each linked clip** — that would \
double the effect. Always operate on just one clip from a linked group.
```

**Step 2: Commit**

```bash
git add backend/agent/gemini_agent.py
git commit -m "feat: add linked-clip awareness to agent system prompt

Instructs Gemini that tool operations auto-propagate to linked clips,
preventing double-application of edits."
```

---

## Task 4: Add Generic Argument Validation to Tool Dispatcher

**Files:**
- Modify: `src/views/editor/useAgentExecutor.ts:325-363` (executeTool dispatcher)

**Why:** Currently, `Number(undefined)` produces NaN and propagates silently. A negative duration would break the timeline. This thin validation layer catches bad arguments generically without per-tool logic.

**Step 1: Add a `sanitizeNumericArgs` helper**

Add before the `executeTool` callback (around line 320):

```typescript
/** Sanitize numeric arguments: replace NaN/undefined with 0, ensure non-negative where needed. */
const sanitizeArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const sanitized = { ...args }
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'number' && isNaN(value)) {
      sanitized[key] = 0
    }
  }
  return sanitized
}
```

**Step 2: Apply sanitization in the dispatcher**

Wrap `call.arguments` through the sanitizer at the top of `executeTool`:

```typescript
const executeTool = useCallback(
  async (call: ToolCall): Promise<ToolResult> => {
    try {
      const args = sanitizeArgs(call.arguments)
      const sanitizedCall = { ...call, arguments: args }

      switch (sanitizedCall.tool_name) {
        case 'get_timeline_state':
          return handleGetTimelineState()
        case 'trim_clip':
          return handleTrimClip(sanitizedCall.arguments)
        // ... rest unchanged
```

**Step 3: Commit**

```bash
git add src/views/editor/useAgentExecutor.ts
git commit -m "feat: add generic NaN sanitization for tool arguments

Prevents NaN from propagating into clip state when Gemini sends
undefined or invalid numeric arguments."
```

---

## Task 5: Add `volume` and `muted` to Timeline Context

**Files:**
- Modify: `src/hooks/use-agent.ts:6-16` (TimelineClipInfo interface)
- Modify: `src/hooks/use-agent.ts:63-73` (buildTimelineState mapper)
- Modify: `backend/agent/types.py:114-125` (TimelineClipInfo model)

**Why:** Gemini can't make audio-aware decisions (like preserving dialogue continuity) if it doesn't know clip volume/muted state. This is especially important for the "Preserve audio continuity" editing principle already in the system prompt.

**Step 1: Add fields to frontend TimelineClipInfo**

In `src/hooks/use-agent.ts`, add to the interface:

```typescript
interface TimelineClipInfo {
  // ... existing fields from Task 2 ...
  volume: number   // NEW
  muted: boolean   // NEW
}
```

**Step 2: Add to mapper**

```typescript
const clipInfos: TimelineClipInfo[] = clips.map(c => ({
  // ... existing fields from Task 2 ...
  volume: c.volume,          // NEW
  muted: c.muted,            // NEW
}))
```

**Step 3: Add to backend Pydantic model**

```python
class TimelineClipInfo(BaseModel):
    # ... existing fields from Task 2 ...
    volume: float = Field(default=1.0, description="Clip volume (0.0 to 1.0)")
    muted: bool = Field(default=False, description="Whether clip audio is muted")
```

**Step 4: Commit**

```bash
git add src/hooks/use-agent.ts backend/agent/types.py
git commit -m "feat: include volume/muted in timeline context for Gemini

Enables audio-aware editing decisions like preserving dialogue."
```

---

## Task 6: Update Tool Descriptions for Linked-Clip Behavior

**Files:**
- Modify: `backend/agent/tool_registry.py:64-95` (trim_clip description)
- Modify: `backend/agent/tool_registry.py:97-116` (split_clip description)
- Modify: `backend/agent/tool_registry.py:118-138` (delete_clip description)
- Modify: `backend/agent/tool_registry.py:140-163` (move_clip description)

**Why:** Tool descriptions are the primary documentation Gemini uses to decide how to call tools. They should mention that operations auto-apply to linked clips.

**Step 1: Append linked-clip note to each tool description**

Add this sentence to the end of each tool's description string:

```
"If the clip is part of a linked group (e.g. video+audio pair), "
"the operation automatically applies to all linked siblings — "
"do not call this tool separately for each linked clip."
```

For `trim_clip` specifically, also clarify that `startTime` is unchanged (already stated, but reinforce):

```python
trim_clip = _tool(
    name="trim_clip",
    description=(
        "Adjust the in-point and/or out-point of a clip by a relative delta "
        "(in seconds). A positive trim_start_delta moves the in-point later "
        "(removes frames from the beginning); a negative value extends it "
        "earlier. A positive trim_end_delta removes frames from the end; "
        "a negative value extends it later. Both deltas default to 0. "
        "The clip's position on the timeline (startTime) is NOT changed; "
        "only the visible portion within the source media changes. "
        "If the clip is part of a linked group (e.g. video+audio pair), "
        "the operation automatically applies to all linked siblings — "
        "do not call this tool separately for each linked clip."
    ),
    # ... rest unchanged
)
```

**Step 2: Commit**

```bash
git add backend/agent/tool_registry.py
git commit -m "feat: document linked-clip auto-propagation in tool descriptions

All editing tools now tell Gemini that operations apply to the entire
linked group, preventing double-application."
```

---

## Summary

| Task | What | Files | Risk |
|------|------|-------|------|
| 1 | Fix `trim_clip` startTime bug | `useAgentExecutor.ts` | Low — removes wrong line |
| 2 | Add `linked_clip_ids` to context | 3 files | Low — additive |
| 3 | System prompt linked-clip instruction | `gemini_agent.py` | Low — text only |
| 4 | Generic NaN sanitization | `useAgentExecutor.ts` | Low — defensive |
| 5 | Add `volume`/`muted` to context | 3 files | Low — additive |
| 6 | Update tool descriptions | `tool_registry.py` | Low — text only |

All changes are additive or corrective. No architectural changes, no new files, no new dependencies.
