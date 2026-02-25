# Agentic Prompt Editor — Design Document

**Date:** 2026-02-25
**Branch:** `feat/agentic-prompt-editor`
**Status:** Approved

## Summary

Add an agentic prompt box to LTX Desktop that lets users control the video editor via natural language. The agent uses Gemini with video understanding to intelligently execute editing operations. Starting with video shortening as the first capability.

## Architecture: Hybrid — Backend LLM + Frontend Executor

```
┌─────────────────────────────────────────────────────────────┐
│                     ELECTRON RENDERER                        │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Prompt Box   │───▶│   Agent Command Executor         │   │
│  │  (Cmd+Space)  │    │   - Receives tool calls from     │   │
│  │  Chat-style   │    │     backend                       │   │
│  │  floating UI  │    │   - Maps to React hook calls     │   │
│  └──────────────┘    │   - Reports results back          │   │
│         │            └──────────────────────────────────┘   │
│         │ user prompt              ▲ tool execution results  │
│         ▼                          │                         │
├─────────────────── IPC / HTTP ───────────────────────────────┤
│                     ELECTRON MAIN (pass-through)             │
├──────────────────────────────────────────────────────────────┤
│                     FASTAPI BACKEND                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Agent Router  (/api/agent/*)                         │   │
│  │                                                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │ Tool        │  │ Gemini      │  │ Video       │  │   │
│  │  │ Registry    │  │ Agent       │  │ Analyzer    │  │   │
│  │  │ - schemas   │  │ - function  │  │ - scenes    │  │   │
│  │  │ - docs      │  │   calling   │  │ - actions   │  │   │
│  │  │ - handlers  │  │ - context   │  │ - dialogue  │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Key decisions:**
- LLM (Gemini) runs in Python backend — handles planning and video analysis
- Tool execution happens in React frontend — direct access to timeline hooks
- Communication via existing FastAPI HTTP + Electron IPC
- MCP-inspired tool system (schemas + docs) but internal protocol, not full MCP JSON-RPC

## Tool Registry

Two-layer design: atomic primitives + composite recipes.

### Atomic Tools (Frontend Execution)

| Tool | Description | Maps to |
|------|-------------|---------|
| `get_timeline_state` | All clips, tracks, playhead, duration | Read from React state |
| `trim_clip` | Adjust clip in/out points | `useClipOperations.trimClip()` |
| `split_clip` | Split clip at timecode | `useClipOperations.splitClipAtPlayhead()` |
| `delete_clip` | Remove clip (optional ripple) | `useClipOperations.deleteClip()` |
| `move_clip` | Reposition clip in timeline | `useClipOperations.moveClip()` |
| `add_clip_to_timeline` | Add asset from bin to timeline | `useClipOperations.addClipToTimeline()` |
| `set_playhead` | Move playhead to timecode | Direct state setter |
| `duplicate_timeline` | Copy current timeline as new version | New function — snapshot clips/tracks |
| `get_project_assets` | List all project assets | Read from React state |

### Resource Tools (Backend Execution)

| Tool | Description |
|------|-------------|
| `get_video_metadata` | Scene descriptions, actions, dialogue, duration for an asset |

### Composite Recipes (Backend Orchestration)

| Tool | Description |
|------|-------------|
| `shorten_video` | Intelligently shorten timeline to target duration |

Recipes call atomic tools internally. Gemini can use either layer.

### Tool Definition Format

```python
{
    "name": "trim_clip",
    "description": "Trim a clip by adjusting its in/out points",
    "parameters": {
        "clip_id": {"type": "string", "description": "ID of clip"},
        "trim_start_delta": {"type": "number", "description": "Seconds to trim from start"},
        "trim_end_delta": {"type": "number", "description": "Seconds to trim from end"},
    },
    "execution_target": "frontend",  # or "backend"
}
```

Tool schemas auto-convert to Gemini function declarations for function calling.

## Video Understanding Pipeline

Runs in background after video import. Non-blocking.

### Analysis Steps

1. **Structural (local, instant):** FFprobe → duration, resolution, FPS, codec
2. **Audio (Gemini):** Dialogue transcription with timecodes, speaker detection
3. **Visual (Gemini Vision):** Scene descriptions, actions at timecodes, shot types, importance ratings

### Metadata Schema

```python
@dataclass
class SceneSegment:
    start_time: float        # seconds
    end_time: float
    description: str         # "A woman walks through a garden"
    actions: list[str]       # ["walking", "looking at flowers"]
    shot_type: str           # "wide", "close-up", "medium"
    importance: float        # 0.0-1.0

@dataclass
class DialogueLine:
    start_time: float
    end_time: float
    speaker: str
    text: str

@dataclass
class VideoMetadata:
    asset_id: str
    duration: float
    resolution: tuple[int, int]
    fps: float
    scenes: list[SceneSegment]
    dialogue: list[DialogueLine]
    summary: str
    analysis_status: str     # "pending" | "analyzing" | "complete" | "failed"
```

### Gemini Video Input

- Gemini 2.0 Flash supports direct video upload (up to ~1hr)
- Full video file uploaded, not just frames
- Provides temporal + audio + visual understanding
- Structured JSON response parsed into VideoMetadata
- Cached alongside project data, reused across sessions

## Agent Execution Loop

### Single Request Flow

```
POST /api/agent/execute
  Input: { prompt, timeline_state, conversation_history }

  1. Build context:
     - Timeline state (clips, tracks, playhead)
     - Video metadata for all assets on timeline
     - Tool definitions as Gemini function declarations
     - System prompt with editing knowledge

  2. Call Gemini with function calling
     → Returns: text explanation + tool calls

  3. Return to frontend:
     { plan: str, tool_calls: ToolCall[] }
```

### Multi-Turn Agentic Loop

1. Gemini analyzes → calls read tools (`get_timeline_state`, `get_video_metadata`)
2. Gets results → plans edit → calls mutation tools (`split_clip`, `delete_clip`, etc.)
3. Gets results → optionally verifies → returns summary (text-only = done)

Max turns: 10. Loop ends on text-only response or limit.

### Safety

- All edits happen on a **duplicated timeline** — original is preserved
- User can undo/compare original vs agent edit
- Agent shows its plan before executing

## Prompt Box UI

```
┌──────────────────────────────────────────────────┐
│  ✦ Agent                                    ✕    │
├──────────────────────────────────────────────────┤
│                                                   │
│  Agent: I'll shorten this to 15s. Here's my      │
│  plan:                                            │
│  - Keep the opening shot (0-3s) — strong hook     │
│  - Keep the main action (12-22s) — key moment     │
│  - Keep the closing (45-48s) — natural ending     │
│  - Remove filler sections                         │
│                                                   │
│  Executing... ████████░░ 6/8 operations           │
│                                                   │
├──────────────────────────────────────────────────┤
│  ▸ Shorten this video to 15 seconds         ⏎    │
└──────────────────────────────────────────────────┘
```

- **Cmd+Space** toggles floating, draggable panel (not modal — timeline stays visible)
- Chat-style conversation with history
- Shows plan before execution
- Progress indicator during tool calls
- Input at bottom, send on Enter
- Close with Escape or X
- Conversation persists within session for follow-ups

## Keyboard Shortcut

Register `agent-prompt` action in the existing keyboard shortcuts system (`src/lib/keyboard-shortcuts.ts`). Default binding: `Cmd+Space` (Mac) / `Ctrl+Space` (Windows/Linux).

## New Files & Modifications

### Backend (new)

- `backend/agent/__init__.py`
- `backend/agent/tool_registry.py` — tool definitions, schema conversion
- `backend/agent/gemini_agent.py` — Gemini function calling loop
- `backend/agent/video_analyzer.py` — video understanding pipeline
- `backend/agent/types.py` — Pydantic models for agent API
- `backend/_routes/agent.py` — FastAPI router `/api/agent/*`
- `backend/handlers/agent_handler.py` — handler class

### Frontend (new)

- `src/views/editor/AgentPromptBox.tsx` — floating prompt UI component
- `src/views/editor/useAgentExecutor.ts` — hook that maps tool calls to clip operations
- `src/hooks/use-agent.ts` — API calls to backend agent endpoints

### Frontend (modified)

- `src/views/VideoEditor.tsx` — mount AgentPromptBox, wire Cmd+Space
- `src/lib/keyboard-shortcuts.ts` — add `agent-prompt` action
- `src/contexts/KeyboardShortcutsContext.tsx` — register new action

### Backend (modified)

- `backend/ltx2_server.py` — include agent router
- `backend/app_handler.py` — add AgentHandler to DI

## MVP Scope

**Phase 1 (this PR):**
- Prompt box UI with Cmd+Space
- Tool registry with atomic timeline tools
- Gemini agent with function calling
- Video analysis pipeline (background, on import)
- "Shorten video to X seconds" as first working task

**Phase 2 (future):**
- More tools: transitions, effects, color correction, subtitle generation
- More recipes: "remove all silence", "create highlight reel", "reorder by topic"
- Conversation memory across sessions
- Streaming responses for faster feedback
- Promote to real MCP server for external client support
