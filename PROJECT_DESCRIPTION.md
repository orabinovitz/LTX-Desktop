# LTX Desktop

A fully local, open-source video generation studio + non-linear video editor built on the LTX-2 diffusion model by Lightricks.

**Repo:** `https://github.com/Lightricks/ltx-desktop.git`
**Local path:** `~/Projects/ltx-desktop/ltx-video/`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Desktop Shell | Electron 31 |
| Build | Vite 5 + electron-builder |
| Backend | Python 3.12+ / FastAPI + Uvicorn |
| AI/ML | PyTorch, LTX-2, Diffusers, Transformers, PEFT |
| Image Gen | Flux (via diffusers) |
| Video Export | Native FFmpeg compositing |
| Package Mgmt | npm (frontend), uv (backend) |

## Architecture

```
┌──────────────────────────────────────────────┐
│            ELECTRON MAIN PROCESS             │
│  main.ts → spawns Python backend + window    │
└──────────┬─────────────────┬─────────────────┘
           │ IPC             │ spawns
           ▼                 ▼
┌────────────────────┐  ┌─────────────────────┐
│   REACT FRONTEND   │  │   PYTHON BACKEND    │
│   (BrowserWindow)  │  │   FastAPI :8000     │
│   Vite :5173 (dev) │◄─►  LTX-2 + PyTorch   │
└────────────────────┘  └─────────────────────┘
```

- **Frontend → Backend**: HTTP fetch for generation, models, settings, health
- **Frontend → Electron**: IPC for file dialogs, GPU checks, log retrieval, export

## Project Structure

```
ltx-video/
├── electron/               # Electron main process
│   ├── main.ts             # Entry point - starts backend, creates window
│   ├── preload.ts          # IPC bridge (electronAPI)
│   ├── python-backend.ts   # Python process lifecycle
│   ├── ipc/                # IPC handlers (app, file, log)
│   └── export/             # FFmpeg export (compositing, audio, filters)
├── src/                    # React frontend
│   ├── App.tsx             # Main app (routing, settings sync)
│   ├── views/
│   │   ├── Home.tsx        # Project list & creation
│   │   ├── GenSpace.tsx    # Text-to-video / Image-to-video generation
│   │   ├── VideoEditor.tsx # Full NLE editor
│   │   └── editor/         # Editor sub-components & hooks
│   ├── contexts/
│   │   └── ProjectContext.tsx  # Central state (projects, assets, timeline)
│   ├── hooks/
│   │   ├── use-backend.ts     # Backend health polling
│   │   └── use-generation.ts  # Generation orchestration
│   └── types/project.ts       # TypeScript types
├── backend/                # Python FastAPI backend
│   ├── ltx2_server.py      # Composition root (logging, config, uvicorn)
│   ├── app_handler.py      # DI root (wires all handlers + services)
│   ├── _routes/            # API endpoints (thin routing layer)
│   ├── handlers/           # Business logic & state transitions
│   ├── services/           # Side-effect boundaries (GPU, IO, network)
│   │   ├── fast_video_pipeline/   # LTX-2 distilled (8 steps)
│   │   ├── pro_video_pipeline/    # LTX-2 full (20 steps)
│   │   ├── image_generation_pipeline/  # Flux image gen
│   │   └── interfaces.py         # Protocol definitions
│   ├── state/              # AppState dataclasses
│   └── tests/              # Integration tests with fake services
├── scripts/                # Build automation (mac/win)
├── package.json            # Node dependencies
└── pyproject.toml          # Python dependencies
```

## Core Features

### Gen Space (Video Generation)
- **Text-to-Video (T2V)**: Generate video from text prompts
- **Image-to-Video (I2V)**: Animate still images into video
- **Two quality modes**:
  - **Fast (Distilled)**: 8 inference steps, quick results
  - **Pro (Full)**: 20 steps, higher quality
- **Resolution**: 720p native or 1080p via 2x upsampler
- **Prompt Enhancement**: Optional Gemini API integration for better prompts
- **IC-LoRA**: Image conditioning via custom LoRA models

### Video Editor (Full NLE)
- **Multi-track timeline**: 3 video (V1-V3), 2 audio (A1-A2), subtitle tracks
- **Clip operations**: trim, speed (0.25x-4x), reverse, opacity
- **Color correction**: brightness, contrast, saturation, temperature, tint, exposure, highlights, shadows
- **LUT presets**: Cinematic, Vintage, B&W, Cool, Warm, Muted, Vivid
- **Effects**: blur, sharpen, glow, vignette, grain (with masks)
- **Transitions**: dissolve, fade-to-black/white, wipes
- **Text overlays**: custom fonts, positions, shadows, backgrounds
- **Subtitle editor**: SRT import/export, per-subtitle styling
- **Letterbox**: adjustment layer support
- **Undo/redo**: full history for all operations
- **Keyboard shortcuts**: 60+ shortcuts, 3 presets (Lightricks, Premiere, Final Cut)
- **Take management**: multiple versions per asset, switch between takes
- **Regeneration**: re-run generation from editor, save new takes
- **Gap generation**: auto-fill timeline gaps with AI-generated clips
- **Export**: native FFmpeg compositing (H.264, H.265, ProRes)

## Backend Architecture

### State Management
- Central `AppState` with union types for generation state machine
- `RLock`-based concurrency (lock → validate → unlock → heavy work → lock → mutate)
- All services defined as Protocols (dependency inversion)
- Tests use fake implementations, no mocks/patches

### Key Handlers
| Handler | Responsibility |
|---------|---------------|
| `VideoGenerationHandler` | Video generation orchestration |
| `ImageGenerationHandler` | Flux image generation |
| `PipelinesHandler` | LTX-2 pipeline instantiation |
| `DownloadHandler` | Model download from HuggingFace |
| `TextHandler` | Text encoding & caching |
| `IcLoraHandler` | Image conditioning LoRA |
| `SettingsHandler` | App settings persistence |

### Model Files (from HuggingFace)
- `checkpoint` - main LTX-2 weights (required)
- `distilled_lora` - LoRA for fast mode
- `upsampler` - 2x upscaling model (for 1080p)
- `text_encoder` - T5-based (local or API)
- `flux` - Flux image generation model

## Running Locally

```bash
cd ~/Projects/ltx-desktop/ltx-video

# Frontend
npm install

# Backend
cd backend && uv sync && cd ..

# Dev mode (hot reload)
npm run electron:dev
```

## Build Installers

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:fast   # Skip Python setup, use existing venv
```

## Notable Patterns

1. **State Machine via Union Types** - `GenerationState = Running | Complete | Error | Cancelled` (exhaustive matching)
2. **Centralized DI** - `AppHandler` owns all state, wires all dependencies
3. **Lazy Service Imports** - Heavy modules (PyTorch, CUDA) imported only at runtime
4. **Native FFmpeg Export** - No canvas rendering, builds FFmpeg filter graphs
5. **localStorage Persistence** - All project state stored in browser, JSON serialized with migrations
6. **SageAttention** - Optional GPU attention optimization (Windows/Linux)
