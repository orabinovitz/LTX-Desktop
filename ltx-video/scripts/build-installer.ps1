# build-installer.ps1
# Master build script for creating the LTX Video Studio installer

param(
    [switch]$SkipPython,
    [switch]$SkipNpm,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

Write-Host @"

  _    _______  __  __     ___     _           ____  _             _ _       
 | |  |_   _\ \/ / | \ \ / (_) __| | ___  ___/ ___|| |_ _   _  __| (_) ___  
 | |    | |  \  /  |  \ V /| |/ _` |/ _ \/ _ \___ \| __| | | |/ _` | |/ _ \ 
 | |___ | |  /  \  |   | | | | (_| |  __/ (_) |__) | |_| |_| | (_| | | (_) |
 |_____|_| /_/\_\ |   |_| |_|\__,_|\___|\___/____/ \__|\__,_|\__,_|_|\___/ 
                                                                            
  Installer Build Script
  
"@ -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PythonEmbedDir = Join-Path $ProjectDir "python-embed"
$ReleaseDir = Join-Path $ProjectDir "release"

Set-Location $ProjectDir

# Clean build if requested
if ($Clean) {
    Write-Host "Cleaning previous build artifacts..." -ForegroundColor Yellow
    
    if (Test-Path $PythonEmbedDir) {
        Remove-Item -Recurse -Force $PythonEmbedDir
    }
    if (Test-Path $ReleaseDir) {
        Remove-Item -Recurse -Force $ReleaseDir
    }
    if (Test-Path "dist") {
        Remove-Item -Recurse -Force "dist"
    }
    if (Test-Path "dist-electron") {
        Remove-Item -Recurse -Force "dist-electron"
    }
    
    Write-Host "Clean complete." -ForegroundColor Green
}

# Step 1: Prepare Python environment
if (-not $SkipPython) {
    Write-Host "`n[1/4] Preparing Python environment..." -ForegroundColor Yellow
    
    if (Test-Path $PythonEmbedDir) {
        Write-Host "Python environment already exists. Use -Clean to rebuild." -ForegroundColor DarkYellow
    } else {
        & "$ScriptDir\prepare-python.ps1"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Failed to prepare Python environment!" -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "`n[1/4] Skipping Python preparation (using existing)..." -ForegroundColor DarkYellow
}

# Verify Python environment exists
if (-not (Test-Path $PythonEmbedDir)) {
    Write-Host "ERROR: Python environment not found at $PythonEmbedDir" -ForegroundColor Red
    Write-Host "Run without -SkipPython to create it." -ForegroundColor Red
    exit 1
}

# Step 2: Install npm dependencies
if (-not $SkipNpm) {
    Write-Host "`n[2/4] Installing npm dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install npm dependencies!" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "`n[2/4] Skipping npm install..." -ForegroundColor DarkYellow
}

# Step 3: Build frontend and electron
Write-Host "`n[3/4] Building frontend and Electron app..." -ForegroundColor Yellow

npm run build:frontend
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build frontend!" -ForegroundColor Red
    exit 1
}

# Step 4: Build installer with electron-builder
Write-Host "`n[4/4] Building installer..." -ForegroundColor Yellow

npx electron-builder --win --config electron-builder.json
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build installer!" -ForegroundColor Red
    exit 1
}

# Summary
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

$Installer = Get-ChildItem -Path $ReleaseDir -Filter "*.exe" | Select-Object -First 1
if ($Installer) {
    $InstallerSize = [math]::Round($Installer.Length / 1MB, 2)
    Write-Host "`nInstaller: $($Installer.Name)" -ForegroundColor Cyan
    Write-Host "Size: $InstallerSize MB" -ForegroundColor Cyan
    Write-Host "Location: $($Installer.FullName)" -ForegroundColor Cyan
}

Write-Host "`nNote: AI models (~150GB) will be downloaded on first run." -ForegroundColor Yellow
Write-Host "Users need an NVIDIA GPU with 12GB+ VRAM for best performance." -ForegroundColor Yellow
