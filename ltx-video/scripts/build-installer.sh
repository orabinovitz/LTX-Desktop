#!/usr/bin/env bash
# build-installer.sh
# Master build script for creating the LTX Desktop installer.
# Works on macOS natively and can be used on Windows via Git Bash.
#
# Usage:
#   bash scripts/build-installer.sh [options]
#
# Options:
#   --platform mac|win   Target platform (auto-detected if omitted)
#   --skip-python        Use existing python-embed/ directory
#   --skip-npm           Skip npm install
#   --clean              Remove build artifacts before starting
#   --unpack             Build unpacked app only (faster, no installer/dmg)

set -euo pipefail

# ============================================================
# Parse arguments
# ============================================================
SKIP_PYTHON=false
SKIP_NPM=false
CLEAN=false
UNPACK=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-python) SKIP_PYTHON=true ;;
    --skip-npm)    SKIP_NPM=true ;;
    --clean)       CLEAN=true ;;
    --unpack)      UNPACK=true ;;
    --platform)
      PLATFORM="$2"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--platform mac|win] [--skip-python] [--skip-npm] [--clean] [--unpack]"
      exit 1
      ;;
  esac
  shift
done

# Auto-detect platform if not specified
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin)          PLATFORM="mac" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="win" ;;
    Linux)           PLATFORM="linux" ;;
    *)               echo "ERROR: Could not detect platform. Use --platform mac|win"; exit 1 ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_EMBED_DIR="$PROJECT_DIR/python-embed"
RELEASE_DIR="$PROJECT_DIR/release"

cd "$PROJECT_DIR"

cat << 'BANNER'

  _   _______  __  ____            _    _
 | | |_   _\ \/ / |  _ \  ___  ___| | _| |_ ___  _ __
 | |   | |  \  /  | | | |/ _ \/ __| |/ / __/ _ \| '_ \
 | |___| |  /  \  | |_| |  __/\__ \   <| || (_) | |_) |
 |_____|_| /_/\_\ |____/ \___||___/_|\_\\__\___/| .__/
                                                 |_|
  Installer Build Script

BANNER

echo "Platform: $PLATFORM"
echo ""

# ============================================================
# Step 0: Clean if requested
# ============================================================
if [ "$CLEAN" = true ]; then
  echo "Cleaning previous build artifacts..."
  rm -rf "$PYTHON_EMBED_DIR" "$RELEASE_DIR" dist dist-electron
  echo "Clean complete."
  echo ""
fi

# ============================================================
# Step 1: Prepare Python environment
# ============================================================
if [ "$SKIP_PYTHON" = false ]; then
  echo "[1/4] Preparing Python environment..."

  if [ -d "$PYTHON_EMBED_DIR" ]; then
    echo "  Python environment already exists. Use --clean to rebuild."
  else
    case "$PLATFORM" in
      mac|linux)
        bash "$SCRIPT_DIR/prepare-python.sh"
        ;;
      win)
        powershell.exe -ExecutionPolicy Bypass -File "$SCRIPT_DIR/prepare-python.ps1"
        ;;
    esac
  fi
else
  echo "[1/4] Skipping Python preparation (using existing)..."
fi

# Verify Python environment exists
if [ ! -d "$PYTHON_EMBED_DIR" ]; then
  echo "ERROR: Python environment not found at $PYTHON_EMBED_DIR"
  echo "Run without --skip-python to create it."
  exit 1
fi
echo ""

# ============================================================
# Step 2: Install npm dependencies
# ============================================================
if [ "$SKIP_NPM" = false ]; then
  echo "[2/4] Installing npm dependencies..."
  npm install
else
  echo "[2/4] Skipping npm install..."
fi
echo ""

# ============================================================
# Step 3: Build frontend and Electron
# ============================================================
echo "[3/4] Building frontend and Electron app..."
npm run build:frontend
echo ""

# ============================================================
# Step 4: Build with electron-builder
# ============================================================
BUILDER_ARGS=""
case "$PLATFORM" in
  mac)   BUILDER_ARGS="--mac" ;;
  win)   BUILDER_ARGS="--win" ;;
  linux) BUILDER_ARGS="--linux" ;;
esac

if [ "$UNPACK" = true ]; then
  echo "[4/4] Building unpacked app (fast mode)..."
  npx electron-builder $BUILDER_ARGS --dir
else
  echo "[4/4] Building installer..."
  npx electron-builder $BUILDER_ARGS
fi
echo ""

# ============================================================
# Summary
# ============================================================
echo "========================================"
echo "  Build Complete!"
echo "========================================"

if [ "$UNPACK" = true ]; then
  case "$PLATFORM" in
    mac)
      echo ""
      echo "Unpacked app ready!"
      echo "Run: open \"$RELEASE_DIR/mac-arm64/LTX Desktop.app\""
      ;;
    win)
      echo ""
      echo "Unpacked app ready!"
      echo "Run: $RELEASE_DIR/win-unpacked/LTX Desktop.exe"
      ;;
  esac
else
  echo ""
  echo "Output: $RELEASE_DIR/"
  ls -1 "$RELEASE_DIR/" 2>/dev/null | head -10
fi

echo ""
echo "Note: AI models (~150GB) will be downloaded on first run."
