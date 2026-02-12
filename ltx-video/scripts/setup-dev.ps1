# setup-dev.ps1
# Creates a Python virtual environment and installs all backend dependencies for development

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  LTX Desktop - Development Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ProjectDir "backend"
$VenvDir = Join-Path $BackendDir ".venv"

Set-Location $ProjectDir

# Step 1: Find Python 3.11+
Write-Host "`nStep 1: Locating Python 3.11+..." -ForegroundColor Yellow

$PythonExe = $null
$PythonPaths = @(
    "python",
    "python3",
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe")
)

foreach ($p in $PythonPaths) {
    try {
        $version = & $p --version 2>&1
        if ($version -match "Python 3\.(1[1-9]|[2-9]\d)") {
            $PythonExe = $p
            Write-Host "Found: $version at $p" -ForegroundColor Green
            break
        }
    } catch {
        continue
    }
}

if (-not $PythonExe) {
    Write-Host "ERROR: Python 3.11+ not found!" -ForegroundColor Red
    Write-Host "Please install Python 3.11 or later from https://www.python.org/" -ForegroundColor Red
    exit 1
}

# Step 2: Create virtual environment
Write-Host "`nStep 2: Creating virtual environment..." -ForegroundColor Yellow

if (Test-Path $VenvDir) {
    Write-Host "Virtual environment already exists at $VenvDir" -ForegroundColor DarkYellow
    $response = Read-Host "Recreate it? (y/N)"
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "Removing existing venv..."
        Remove-Item -Recurse -Force $VenvDir
    } else {
        Write-Host "Keeping existing venv. Skipping to dependency install..."
    }
}

if (-not (Test-Path $VenvDir)) {
    & $PythonExe -m venv $VenvDir
    Write-Host "Created venv at $VenvDir" -ForegroundColor Green
}

# Activate venv
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "ERROR: venv Python not found at $VenvPython" -ForegroundColor Red
    exit 1
}

# Step 3: Upgrade pip and install uv
Write-Host "`nStep 3: Installing uv package manager..." -ForegroundColor Yellow

& $VenvPython -m pip install --upgrade pip --quiet
& $VenvPython -m pip install uv --quiet
Write-Host "uv installed" -ForegroundColor Green

$VenvUv = Join-Path $VenvDir "Scripts\uv.exe"

# Step 4: Install PyTorch with CUDA
Write-Host "`nStep 4: Installing PyTorch with CUDA 12.8..." -ForegroundColor Yellow

& $VenvUv pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128
Write-Host "PyTorch installed" -ForegroundColor Green

# Step 5: Install backend dependencies from pyproject.toml
Write-Host "`nStep 5: Installing backend dependencies..." -ForegroundColor Yellow

Set-Location $BackendDir

# Install the project in editable mode (this reads pyproject.toml)
# Use uv for speed, but fall back to pip for git dependencies
$CommonDeps = @(
    "fastapi>=0.111.0",
    "uvicorn[standard]>=0.30.0",
    "websockets>=12.0",
    "python-multipart>=0.0.9",
    "pillow>=10.3.0",
    "huggingface-hub>=0.23.0",
    "tqdm>=4.66.0",
    "pynvml>=11.5.0",
    "ftfy>=6.0.0",
    "imageio>=2.37.2",
    "imageio-ffmpeg>=0.6.0",
    "peft>=0.13.2",
    "protobuf>=3.20.0",
    "sentencepiece>=0.1.99",
    "transformers>=4.40.0",
    "accelerate>=0.30.0",
    "safetensors>=0.4.0",
    "einops>=0.7.0",
    "av"
)

& $VenvUv pip install @CommonDeps
Write-Host "Common dependencies installed" -ForegroundColor Green

# Install diffusers from main branch
Write-Host "`nInstalling diffusers from main branch..."
& $VenvPython -m pip install git+https://github.com/huggingface/diffusers.git --quiet
Write-Host "diffusers installed" -ForegroundColor Green

# Install ltx-core and ltx-pipelines from private repo
Write-Host "`nInstalling ltx-core and ltx-pipelines..."
$LtxRepoRev = "d10477aec456c9c70103ee276318c316076c5ec2"
$LtxRepoBase = "https://github.com/LightricksResearch/ltx-2-internal.git"

& $VenvPython -m pip install "ltx-core @ git+${LtxRepoBase}@${LtxRepoRev}#subdirectory=packages/ltx-core" --quiet
& $VenvPython -m pip install "ltx-pipelines @ git+${LtxRepoBase}@${LtxRepoRev}#subdirectory=packages/ltx-pipelines" --quiet
Write-Host "ltx-core and ltx-pipelines installed" -ForegroundColor Green

# Step 6: Optional - Install SageAttention + Triton (Windows)
Write-Host "`nStep 6: Installing SageAttention + Triton (optional)..." -ForegroundColor Yellow

try {
    & $VenvUv pip install triton-windows sageattention 2>$null
    Write-Host "SageAttention + Triton installed" -ForegroundColor Green
} catch {
    Write-Host "SageAttention/Triton install failed (optional - app will still work)" -ForegroundColor DarkYellow
}

# Step 7: Verify installation
Write-Host "`nStep 7: Verifying installation..." -ForegroundColor Yellow

$TestScript = @"
import sys
print(f'Python: {sys.version}')
try:
    import torch
    print(f'PyTorch: {torch.__version__}')
    print(f'CUDA available: {torch.cuda.is_available()}')
    if torch.cuda.is_available():
        print(f'GPU: {torch.cuda.get_device_name(0)}')
except ImportError as e:
    print(f'PyTorch: FAILED - {e}')
try:
    import fastapi
    print(f'FastAPI: {fastapi.__version__}')
except ImportError as e:
    print(f'FastAPI: FAILED - {e}')
try:
    import diffusers
    print(f'Diffusers: {diffusers.__version__}')
except ImportError as e:
    print(f'Diffusers: FAILED - {e}')
try:
    import ltx_core
    print(f'ltx-core: OK')
except ImportError as e:
    print(f'ltx-core: FAILED - {e}')
try:
    import ltx_pipelines
    print(f'ltx-pipelines: OK')
except ImportError as e:
    print(f'ltx-pipelines: FAILED - {e}')
"@

$TestScript | & $VenvPython -

Set-Location $ProjectDir

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Development environment ready!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "`nVenv location: $VenvDir" -ForegroundColor Cyan
Write-Host "Python: $VenvPython" -ForegroundColor Cyan
Write-Host "`nTo start developing:" -ForegroundColor Yellow
Write-Host "  npm install    # install Node dependencies" -ForegroundColor White
Write-Host "  npm run dev    # start the app" -ForegroundColor White
Write-Host "`nThe app will automatically use the venv Python at:" -ForegroundColor Yellow
Write-Host "  $VenvPython" -ForegroundColor White
