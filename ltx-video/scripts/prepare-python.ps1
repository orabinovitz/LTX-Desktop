# prepare-python.ps1
# Downloads embedded Python and installs all dependencies for distribution

param(
    [string]$PythonVersion = "3.11.9",
    [string]$OutputDir = "python-embed"
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  LTX Video - Python Environment Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$OutputPath = Join-Path $ProjectDir $OutputDir
$TempDir = Join-Path $env:TEMP "ltx-python-build"

# Python embed URL
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

Write-Host "`nStep 1: Preparing directories..." -ForegroundColor Yellow

# Clean and create directories
if (Test-Path $OutputPath) {
    Write-Host "Removing existing python-embed directory..."
    Remove-Item -Recurse -Force $OutputPath
}

if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

Write-Host "`nStep 2: Downloading Python $PythonVersion embeddable..." -ForegroundColor Yellow

$PythonZip = Join-Path $TempDir "python-embed.zip"
Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip -UseBasicParsing
Write-Host "Downloaded Python embeddable package"

Write-Host "`nStep 3: Extracting Python..." -ForegroundColor Yellow

Expand-Archive -Path $PythonZip -DestinationPath $OutputPath -Force
Write-Host "Extracted to $OutputPath"

Write-Host "`nStep 4: Enabling pip in embedded Python..." -ForegroundColor Yellow

# Modify python311._pth to enable site-packages
$PthFile = Get-ChildItem -Path $OutputPath -Filter "python*._pth" | Select-Object -First 1
if ($PthFile) {
    $PthContent = Get-Content $PthFile.FullName
    # Uncomment import site
    $PthContent = $PthContent -replace "^#import site", "import site"
    # Add Lib\site-packages
    $PthContent += "`nLib\site-packages"
    Set-Content -Path $PthFile.FullName -Value $PthContent
    Write-Host "Modified $($PthFile.Name) to enable pip and site-packages"
}

Write-Host "`nStep 5: Installing pip..." -ForegroundColor Yellow

$GetPipPath = Join-Path $TempDir "get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath -UseBasicParsing

$PythonExe = Join-Path $OutputPath "python.exe"
& $PythonExe $GetPipPath --no-warn-script-location
Write-Host "pip installed successfully"

Write-Host "`nStep 6: Installing PyTorch nightly with CUDA 12.8..." -ForegroundColor Yellow

# Install PyTorch nightly with CUDA 12.8 support (required for RTX 5090/Blackwell GPUs - nightly has best performance)
& $PythonExe -m pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128 --no-warn-script-location
Write-Host "PyTorch nightly with CUDA 12.8 installed"

Write-Host "`nStep 7: Installing backend dependencies..." -ForegroundColor Yellow

$BackendDir = Join-Path $ProjectDir "backend"
$VenvSitePackages = Join-Path $BackendDir ".venv\Lib\site-packages"
$EmbedSitePackages = Join-Path $OutputPath "Lib\site-packages"

# Install common dependencies from PyPI
$CommonDeps = @(
    "fastapi>=0.111.0",
    "uvicorn[standard]>=0.30.0",
    "websockets>=12.0",
    "python-multipart>=0.0.9",
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
    "sageattention>=1.0.0",
    "triton-windows",
    "av"
)

foreach ($dep in $CommonDeps) {
    Write-Host "Installing $dep..."
    & $PythonExe -m pip install $dep --no-warn-script-location --quiet
}

# Install diffusers from main branch (needed for Flux2KleinPipeline)
Write-Host "Installing diffusers from main branch (for Flux2KleinPipeline)..."
& $PythonExe -m pip install git+https://github.com/huggingface/diffusers.git --no-warn-script-location --quiet

# Copy ltx-core and ltx-pipelines from existing venv (these are from private repo)
if (Test-Path $VenvSitePackages) {
    Write-Host "Copying ltx-core and ltx-pipelines from existing venv..."
    $PackagesToCopy = @("ltx_core", "ltx_pipelines", "ltx_core-*.dist-info", "ltx_pipelines-*.dist-info")
    foreach ($pkg in $PackagesToCopy) {
        $source = Get-ChildItem -Path $VenvSitePackages -Filter $pkg -ErrorAction SilentlyContinue
        if ($source) {
            Copy-Item -Path $source.FullName -Destination $EmbedSitePackages -Recurse -Force
            Write-Host "  Copied: $($source.Name)"
        }
    }
} else {
    Write-Host "WARNING: Existing venv not found at $VenvSitePackages" -ForegroundColor Yellow
    Write-Host "ltx-core and ltx-pipelines must be installed manually" -ForegroundColor Yellow
}

# Step 7b: Copy Python headers and libs (required for Triton/SageAttention JIT compilation)
Write-Host "`nStep 7b: Copying Python development files for Triton..." -ForegroundColor Yellow

$SystemPython = "$env:LOCALAPPDATA\Programs\Python\Python311"
if (Test-Path $SystemPython) {
    # Copy Include folder (Python.h and other headers)
    $IncludeSrc = Join-Path $SystemPython "Include"
    $IncludeDst = Join-Path $OutputPath "Include"
    if (Test-Path $IncludeSrc) {
        Copy-Item -Path $IncludeSrc -Destination $IncludeDst -Recurse -Force
        Write-Host "  Copied Include folder (Python headers)"
    }
    
    # Copy libs folder (python311.lib for linking)
    $LibsSrc = Join-Path $SystemPython "libs"
    $LibsDst = Join-Path $OutputPath "libs"
    if (Test-Path $LibsSrc) {
        Copy-Item -Path $LibsSrc -Destination $LibsDst -Recurse -Force
        Write-Host "  Copied libs folder (Python libraries)"
    }
} else {
    Write-Host "WARNING: System Python 3.11 not found at $SystemPython" -ForegroundColor Yellow
    Write-Host "SageAttention/Triton JIT compilation may not work" -ForegroundColor Yellow
}

Write-Host "`nStep 8: Cleaning up unnecessary files..." -ForegroundColor Yellow

# Remove pip cache to save space (check multiple possible locations)
$PipCachePaths = @(
    (Join-Path $OutputPath "Lib\site-packages\pip\_vendor\cachecontrol\caches"),
    (Join-Path $OutputPath "Lib\site-packages\pip\cache"),
    (Join-Path $OutputPath "Scripts\pip*cache*")
)
foreach ($cachePath in $PipCachePaths) {
    if (Test-Path $cachePath) {
        Remove-Item -Recurse -Force $cachePath -ErrorAction SilentlyContinue
        Write-Host "  Removed cache: $cachePath"
    }
}
# Also remove .dist-info for pip itself to save space
Get-ChildItem -Path (Join-Path $OutputPath "Lib\site-packages") -Directory -Filter "pip-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Remove __pycache__ directories
Get-ChildItem -Path $OutputPath -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

# Remove .pyc files at top level
Get-ChildItem -Path $OutputPath -Filter "*.pyc" | Remove-Item -Force

# Clean up temp directory
Remove-Item -Recurse -Force $TempDir

Write-Host "`nStep 9: Verifying installation..." -ForegroundColor Yellow

$TestScript = @"
import sys
print(f'Python: {sys.version}')
try:
    import torch
    print(f'PyTorch: {torch.__version__}')
    print(f'CUDA available: {torch.cuda.is_available()}')
except ImportError as e:
    print(f'PyTorch import failed: {e}')
try:
    import fastapi
    print(f'FastAPI: {fastapi.__version__}')
except ImportError as e:
    print(f'FastAPI import failed: {e}')
try:
    import diffusers
    print(f'Diffusers: {diffusers.__version__}')
except ImportError as e:
    print(f'Diffusers import failed: {e}')
"@

$TestScript | & $PythonExe -

# Calculate size
$Size = (Get-ChildItem -Path $OutputPath -Recurse | Measure-Object -Property Length -Sum).Sum
$SizeGB = [math]::Round($Size / 1GB, 2)

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Python environment ready!" -ForegroundColor Green
Write-Host "  Location: $OutputPath" -ForegroundColor Green
Write-Host "  Size: $SizeGB GB" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
