# LTX Desktop - Installer Build Guide

This guide explains how to build a distributable installer for LTX Desktop that includes everything users need to run the application.

## What Gets Bundled

The installer includes:
- **Electron app** (React frontend + Electron shell)
- **Embedded Python 3.12** with all dependencies pre-installed:
  - PyTorch (CUDA 12.8 on Windows, MPS on macOS)
  - FastAPI, Diffusers, Transformers
  - LTX-2 inference packages
  - All other required libraries
- **Backend Python code**

**NOT bundled** (downloaded on first run):
- AI Models (~150GB) - automatically downloaded from Hugging Face

The embedded Python is **fully isolated** from the target system's Python — it lives inside `{install_dir}/resources/python/` and never modifies system settings.

## Prerequisites

Before building, ensure you have:

1. **Node.js 18+** - https://nodejs.org/
2. **uv** - https://docs.astral.sh/uv/ (Python package manager)
3. **git** - needed for git-based Python packages
4. **Internet connection** (for downloading Python and packages)
5. **~15GB free space** (for Python environment + build artifacts)

### Platform-Specific

- **Windows**: PowerShell 5.1+ (comes with Windows 10/11)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)

## Quick Build

### macOS
```bash
cd ltx-video
npm run build:mac
```

### Windows
```powershell
cd ltx-video
npm run build:win
```

This will:
1. Download a standalone Python 3.12 distribution
2. Install all Python dependencies (~10GB on Windows with CUDA, ~2GB on macOS with MPS)
3. Build the frontend
4. Package everything with electron-builder
5. Create a DMG (macOS) or NSIS installer (Windows) in the `release/` folder

## Build Options

### macOS

```bash
# Full build
npm run build:mac

# Skip Python setup (if already prepared)
npm run build:mac:skip-python

# Just prepare Python environment
npm run prepare:python:mac

# Build with full control
bash scripts/build-installer.sh --platform mac --skip-npm --unpack
```

### Windows

```powershell
# Full build
npm run build:win

# Skip Python setup (if already prepared)
npm run build:win:skip-python

# Just prepare Python environment
npm run prepare:python

# Fast rebuild (unpacked, skip Python + npm)
npm run build:fast

# Clean build
powershell -File scripts/build-installer.ps1 -Clean
```

### Build Script Options

The `build-installer.sh` script accepts:
- `--platform mac|win` — Target platform (auto-detected if omitted)
- `--skip-python` — Use existing `python-embed/` directory
- `--skip-npm` — Skip `npm install`
- `--clean` — Remove build artifacts before starting
- `--unpack` — Build unpacked app only (faster, no installer/DMG)

## Build Output

### macOS
```
release/
  └── LTX Desktop-<version>-arm64.dmg
```

### Windows
```
release/
  └── LTX Desktop-<version>-Setup.exe
```

## System Requirements for End Users

### macOS
- **Apple Silicon Mac** (M1/M2/M3/M4 or later)
- **macOS 13 (Ventura)** or later
- **16GB+ RAM** (unified memory is shared with GPU)
- **150GB free disk space** for AI models
- **Stable internet** for first-run model download

### Windows
- **Windows 10/11 (64-bit)**
- **NVIDIA GPU with 12GB+ VRAM** (RTX 3080 or better recommended)
- **Latest NVIDIA drivers** with CUDA 12.8 support
- **150GB free disk space** for AI models
- **Stable internet** for first-run model download

## Application Icon

Place icon files in `resources/` before building:
- `icon.ico` — Windows (multi-size ICO: 256x256, 128x128, 64x64, 48x48, 32x32, 16x16)
- `icon.png` — macOS (1024x1024 recommended)

## First Run Experience

1. User installs the app (DMG on macOS, installer on Windows)
2. On first launch, setup wizard checks system requirements
3. User can start generating — models download automatically on first generation
4. Subsequent launches are instant

### Model Storage

Models are stored in:
- **macOS**: `~/.ltx-video-studio/models/`
- **Windows**: `%APPDATA%/ltx-video/models/`

This location persists across app updates.

---

## Development Setup

For developers working on the codebase:

### macOS
```bash
cd ltx-video
npm run setup:dev:mac   # Create venv + install Python deps
npm install             # Install Node deps
npm run dev             # Start in dev mode
```

### Windows
```powershell
cd ltx-video
npm run setup:dev       # Create venv + install Python deps
npm install             # Install Node deps
npm run dev             # Start in dev mode
```

### Development vs Production

| Aspect | Development | Production |
|--------|-------------|------------|
| Python | `.venv` in backend/ | Bundled standalone Python |
| Backend | Local files | In app resources |
| Models | Project folder | AppData / ~/.ltx-video-studio |
| Hot reload | Yes | No |
| Isolation | venv | Embedded (fully self-contained) |

---

## Troubleshooting

### "Python not found" during build
Ensure you have internet access. The script downloads Python automatically.

### Build fails with CUDA errors
The build doesn't require a GPU. CUDA packages are pre-built binaries.

### macOS: "App is damaged" or Gatekeeper warning
The app is currently unsigned. Right-click the app and select "Open", or run:
```bash
xattr -dr com.apple.quarantine /Applications/LTX\ Desktop.app
```

### Installer is too large
Expected sizes:
- **Windows**: ~10GB (PyTorch CUDA ~2.5GB + ML libraries ~5GB + Python ~200MB + Electron ~100MB)
- **macOS**: ~2-3GB (PyTorch MPS is much smaller than CUDA variant)

### First-run model download fails
Users can manually download models and place them in the models folder.

## Advanced: Manual Build Steps

### macOS
```bash
# 1. Prepare Python environment
bash scripts/prepare-python.sh

# 2. Install npm dependencies
npm install

# 3. Build frontend
npm run build:frontend

# 4. Build DMG
npx electron-builder --mac

# Or build unpacked app (faster, for testing)
npx electron-builder --mac --dir
```

### Windows
```powershell
# 1. Prepare Python environment
./scripts/prepare-python.ps1

# 2. Install npm dependencies
npm install

# 3. Build frontend
npm run build:frontend

# 4. Build installer
npx electron-builder --win
```
