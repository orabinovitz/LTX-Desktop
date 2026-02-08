# LTX Video Studio - Installer Build Guide

This guide explains how to build a distributable installer for LTX Video Studio that includes everything users need to run the application.

## What Gets Bundled

The installer includes:
- **Electron app** (React frontend + Electron shell)
- **Embedded Python 3.11** with all dependencies pre-installed:
  - PyTorch with CUDA 12.1 support
  - FastAPI, Diffusers, Transformers
  - LTX-2 inference packages
  - All other required libraries
- **Backend Python code**

**NOT bundled** (downloaded on first run):
- AI Models (~150GB) - automatically downloaded from Hugging Face

## Prerequisites

Before building, ensure you have:

1. **Node.js 18+** - https://nodejs.org/
2. **PowerShell 5.1+** (comes with Windows 10/11)
3. **Internet connection** (for downloading Python and packages)
4. **~15GB free space** (for Python environment + build artifacts)

## Quick Build

```powershell
cd ltx-video
npm run build:installer
```

This will:
1. Download Python 3.11 embeddable
2. Install all Python dependencies (~10GB)
3. Build the frontend
4. Package everything with electron-builder
5. Create an NSIS installer in the `release/` folder

## Build Options

### Full Build (default)
```powershell
npm run build:installer
```

### Skip Python Setup (if already prepared)
```powershell
npm run build:installer:skip-python
```

### Just Prepare Python Environment
```powershell
npm run prepare:python
```

### Clean Build
```powershell
powershell -File scripts/build-installer.ps1 -Clean
```

## Build Output

After a successful build, you'll find:
```
release/
  └── LTX Video Studio-Setup-1.0.0.exe  (~10GB installer)
```

## Customization

### Application Icon

Place your icon file in `build-resources/icon.ico` before building.

Requirements:
- Windows ICO format
- Multiple sizes: 256x256, 128x128, 64x64, 48x48, 32x32, 16x16

### Installer Options

Edit `electron-builder.json` to customize:
- Product name
- Installation directory
- Shortcuts
- License text

## Distribution Notes

### System Requirements for End Users

Users must have:
- **Windows 10/11 (64-bit)**
- **NVIDIA GPU with 12GB+ VRAM** (RTX 3080 or better recommended)
- **Latest NVIDIA drivers** with CUDA 12.1 support
- **150GB free disk space** for AI models
- **Stable internet** for first-run model download

### First Run Experience

1. User runs installer
2. App installs to Program Files
3. On first launch, setup wizard checks system requirements
4. User can start generating - models download automatically on first generation
5. Subsequent launches are instant

### Model Storage

Models are stored in:
```
%APPDATA%/ltx-video/models/
```

This location persists across app updates.

## Troubleshooting

### "Python not found" during build
Ensure you have internet access. The script downloads Python automatically.

### Build fails with CUDA errors
The build doesn't require a GPU. CUDA packages are pre-built binaries.

### Installer is too large
The ~10GB size is normal due to:
- PyTorch with CUDA (~2.5GB)
- Other ML libraries (~5GB)
- Python runtime (~200MB)
- Electron app (~100MB)

### First-run model download fails
Users can manually download models and place them in the models folder.
See `models/README.md` for instructions.

## Development vs Production

| Aspect | Development | Production |
|--------|-------------|------------|
| Python | System Python / venv | Bundled embed |
| Backend | Local files | In resources |
| Models | Project folder | AppData |
| Hot reload | Yes | No |

## Advanced: Manual Build Steps

If the automated script fails, you can build manually:

```powershell
# 1. Prepare Python environment
./scripts/prepare-python.ps1

# 2. Install npm dependencies
npm install

# 3. Build frontend
npm run build:frontend

# 4. Build installer
npx electron-builder --win --config electron-builder.json
```
