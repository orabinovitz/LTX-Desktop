# prepare-python.ps1
# Downloads embedded Python and installs all dependencies for distribution.
#
# Dependencies are read from uv.lock (via `uv export`) — pyproject.toml is the
# single source of truth. No hardcoded dependency lists.
#
# Prerequisites:
#   - uv must be installed (https://docs.astral.sh/uv/)
#   - Dev venv must exist (run `uv sync` in backend/ first) — needed for
#     ltx-core and ltx-pipelines which come from a private git repo.

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
$BackendDir = Join-Path $ProjectDir "backend"
$OutputPath = Join-Path $ProjectDir $OutputDir
$TempDir = Join-Path $env:TEMP "ltx-python-build"
$VenvSitePackages = Join-Path $BackendDir ".venv\Lib\site-packages"

# Python embed URL
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

# PyTorch CUDA index (must match the index in pyproject.toml)
$PyTorchIndex = "https://download.pytorch.org/whl/cu128"

# ============================================================
# Step 1: Verify prerequisites
# ============================================================
Write-Host "`nStep 1: Verifying prerequisites..." -ForegroundColor Yellow

# Check uv is available
$UvExe = Get-Command uv -ErrorAction SilentlyContinue
if (-not $UvExe) {
    # Fall back to uv in the dev venv
    $VenvUv = Join-Path $BackendDir ".venv\Scripts\uv.exe"
    if (Test-Path $VenvUv) {
        $UvExe = $VenvUv
    } else {
        Write-Host "ERROR: uv not found. Install it: https://docs.astral.sh/uv/" -ForegroundColor Red
        exit 1
    }
}
Write-Host "uv: $UvExe" -ForegroundColor Green

# Check dev venv exists (needed for ltx-core/ltx-pipelines)
if (-not (Test-Path $VenvSitePackages)) {
    Write-Host "ERROR: Dev venv not found at $VenvSitePackages" -ForegroundColor Red
    Write-Host "Run 'uv sync' in the backend/ directory first." -ForegroundColor Red
    exit 1
}
Write-Host "Dev venv: OK" -ForegroundColor Green

# ============================================================
# Step 2: Generate requirements.txt from uv.lock
# ============================================================
Write-Host "`nStep 2: Generating requirements.txt from uv.lock..." -ForegroundColor Yellow

$RequirementsFile = Join-Path $BackendDir "requirements-dist.txt"

# Export pinned deps, excluding:
#   - The project itself (--no-emit-project)
#   - ltx-core/ltx-pipelines (copied from venv, private repo)
#   - No hashes (simpler, embedded Python doesn't need them)
& uv export --frozen --no-hashes --no-editable --no-emit-project `
    --no-emit-package ltx-core --no-emit-package ltx-pipelines `
    --no-header --no-annotate `
    --project $BackendDir `
    > $RequirementsFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: uv export failed!" -ForegroundColor Red
    exit 1
}

$DepCount = (Get-Content $RequirementsFile | Where-Object { $_ -match "^\S" }).Count
Write-Host "Exported $DepCount dependencies from uv.lock" -ForegroundColor Green

# ============================================================
# Step 3: Prepare directories
# ============================================================
Write-Host "`nStep 3: Preparing directories..." -ForegroundColor Yellow

if (Test-Path $OutputPath) {
    Write-Host "Removing existing python-embed directory..."
    Remove-Item -Recurse -Force $OutputPath
}

if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

# ============================================================
# Step 4: Download and extract embedded Python
# ============================================================
Write-Host "`nStep 4: Downloading Python $PythonVersion embeddable..." -ForegroundColor Yellow

$PythonZip = Join-Path $TempDir "python-embed.zip"
Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip -UseBasicParsing
Write-Host "Downloaded Python embeddable package"

Expand-Archive -Path $PythonZip -DestinationPath $OutputPath -Force
Write-Host "Extracted to $OutputPath"

# ============================================================
# Step 5: Enable pip in embedded Python
# ============================================================
Write-Host "`nStep 5: Enabling pip in embedded Python..." -ForegroundColor Yellow

$PthFile = Get-ChildItem -Path $OutputPath -Filter "python*._pth" | Select-Object -First 1
if ($PthFile) {
    $PthContent = Get-Content $PthFile.FullName
    $PthContent = $PthContent -replace "^#import site", "import site"
    $PthContent += "`nLib\site-packages"
    Set-Content -Path $PthFile.FullName -Value $PthContent
    Write-Host "Modified $($PthFile.Name) to enable pip and site-packages"
}

$GetPipPath = Join-Path $TempDir "get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath -UseBasicParsing

$PythonExe = Join-Path $OutputPath "python.exe"
& $PythonExe $GetPipPath --no-warn-script-location
Write-Host "pip installed" -ForegroundColor Green

# ============================================================
# Step 6: Install all dependencies from requirements.txt
# ============================================================
Write-Host "`nStep 6: Installing dependencies from requirements.txt..." -ForegroundColor Yellow

# --extra-index-url provides the PyTorch CUDA builds (torch+cu128)
& $PythonExe -m pip install -r $RequirementsFile `
    --extra-index-url $PyTorchIndex `
    --no-warn-script-location --quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pip install failed!" -ForegroundColor Red
    exit 1
}
Write-Host "All dependencies installed" -ForegroundColor Green

# ============================================================
# Step 7: Copy ltx-core and ltx-pipelines from dev venv
# ============================================================
Write-Host "`nStep 7: Copying ltx-core and ltx-pipelines from dev venv..." -ForegroundColor Yellow

$EmbedSitePackages = Join-Path $OutputPath "Lib\site-packages"
$PackagesToCopy = @("ltx_core", "ltx_pipelines", "ltx_core-*.dist-info", "ltx_pipelines-*.dist-info")

foreach ($pkg in $PackagesToCopy) {
    $source = Get-ChildItem -Path $VenvSitePackages -Filter $pkg -ErrorAction SilentlyContinue
    if ($source) {
        Copy-Item -Path $source.FullName -Destination $EmbedSitePackages -Recurse -Force
        Write-Host "  Copied: $($source.Name)"
    }
}

# ============================================================
# Step 8: Copy Python headers for Triton/SageAttention JIT
# ============================================================
Write-Host "`nStep 8: Copying Python development files for Triton JIT..." -ForegroundColor Yellow

$SystemPython = "$env:LOCALAPPDATA\Programs\Python\Python311"
if (Test-Path $SystemPython) {
    $IncludeSrc = Join-Path $SystemPython "Include"
    $IncludeDst = Join-Path $OutputPath "Include"
    if (Test-Path $IncludeSrc) {
        Copy-Item -Path $IncludeSrc -Destination $IncludeDst -Recurse -Force
        Write-Host "  Copied Include folder (Python headers)"
    }

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

# ============================================================
# Step 9: Clean up
# ============================================================
Write-Host "`nStep 9: Cleaning up..." -ForegroundColor Yellow

# Remove pip cache
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
Get-ChildItem -Path (Join-Path $OutputPath "Lib\site-packages") -Directory -Filter "pip-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Remove __pycache__ and .pyc
Get-ChildItem -Path $OutputPath -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem -Path $OutputPath -Filter "*.pyc" | Remove-Item -Force

# Clean up temp directory and generated requirements file
Remove-Item -Recurse -Force $TempDir
Remove-Item -Force $RequirementsFile -ErrorAction SilentlyContinue

# ============================================================
# Step 10: Verify
# ============================================================
Write-Host "`nStep 10: Verifying installation..." -ForegroundColor Yellow

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
try:
    from ltx_pipelines import distilled
    print(f'ltx-pipelines: OK')
except ImportError as e:
    print(f'ltx-pipelines: FAILED - {e}')
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
