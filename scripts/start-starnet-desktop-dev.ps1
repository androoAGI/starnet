#Requires -Version 5.1
<#
.SYNOPSIS
  Prepare and launch StarNet desktop dev (Tauri) from this repo.

.DESCRIPTION
  Runs preflight checks, self-remediation (deps, voice bundle, toolchain, port/workspace
  conflicts), then npm run desktop:dev. Use -BrowserOnly for sidecar-only (http://127.0.0.1:8787).

.PARAMETER Repair
  Force remediation steps (npm install, voice-deps staging) even when paths look present.

.PARAMETER BrowserOnly
  Start npm start (browser UI) instead of the Tauri desktop shell.

.PARAMETER SkipConflictKill
  Do not stop existing sidecar / port 8787 listeners (may hit WORKSPACE_BUSY).

.PARAMETER RestartDesktop
  Also stop an existing skynet-desktop.exe from this repo before launching.

.PARAMETER PreflightOnly
  Run checks and remediation only; do not start npm (useful for testing the script).

.EXAMPLE
  .\scripts\start-starnet-desktop-dev.ps1

.EXAMPLE
  .\scripts\start-starnet-desktop-dev.ps1 -Repair
#>
[CmdletBinding()]
param(
    [switch] $Repair,
    [switch] $BrowserOnly,
    [switch] $SkipConflictKill,
    [switch] $RestartDesktop,
    [switch] $PreflightOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) {
    Write-Host ("`n==> " + $Message) -ForegroundColor Cyan
}

function Write-Ok([string] $Message) {
    Write-Host ("    OK: " + $Message) -ForegroundColor Green
}

function Write-WarnMsg([string] $Message) {
    Write-Host ("    WARN: " + $Message) -ForegroundColor Yellow
}

function Write-ErrMsg([string] $Message) {
    Write-Host ("    ERROR: " + $Message) -ForegroundColor Red
}

function Refresh-PathEnv {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($machine, $user) -join ';'
}

function Get-RepoRoot {
    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    return $root
}

function Test-CommandExists([string] $Name) {
    return [bool] (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Find-MsvcLinkExe {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe"
    )
    foreach ($pattern in $candidates) {
        $hit = Get-Item -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Invoke-RemediateRust {
    if (Test-CommandExists 'rustc') {
        Write-Ok ("rustc " + (rustc --version 2>$null))
        return
    }
    Write-WarnMsg 'Rust toolchain not on PATH.'
    if (Test-CommandExists 'winget') {
        Write-Step 'Installing Rust via winget (Rustlang.Rustup)...'
        winget install Rustlang.Rustup --accept-package-agreements --accept-source-agreements
        Refresh-PathEnv
    }
    if (-not (Test-CommandExists 'rustc')) {
        throw 'Rust is still missing. Open a new terminal after rustup install, or install from https://rustup.rs'
    }
    Write-Ok ("rustc " + (rustc --version))
}

function Invoke-RemediateMsvc {
    $link = Find-MsvcLinkExe
    if ($link) {
        Write-Ok ("MSVC linker: $link")
        return
    }
    Write-WarnMsg 'MSVC link.exe not found (cargo/Tauri will fail without C++ Build Tools).'
    $installer = Join-Path $env:USERPROFILE 'Downloads\vs_BuildTools.exe'
    if (Test-Path -LiteralPath $installer) {
        Write-Step 'Opening Visual Studio Build Tools installer - select Desktop development with C++, then re-run this script.'
        Start-Process -FilePath $installer
    }
    else {
        Write-ErrMsg 'Download "Build Tools for Visual Studio" and install the C++ workload: https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }
    throw 'Install C++ Build Tools, then re-run this script.'
}

function Invoke-RemediateNpmDeps([string] $Root) {
    Push-Location -LiteralPath $Root
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
            Write-Step 'node_modules missing - running npm install...'
            npm install
            return
        }
        if ($Repair) {
            Write-Step 'Repair: refreshing npm install...'
            npm install
        }
        else {
            Write-Ok 'node_modules present'
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-RemediateVoiceDeps([string] $Root) {
    $voiceModules = Join-Path $Root 'src-tauri\voice-deps\node_modules'
    $needsStage = $Repair -or -not (Test-Path -LiteralPath $voiceModules)
    if (-not $needsStage) {
        Write-Ok 'voice-deps staged'
        return
    }
    Write-Step 'Staging voice-deps for Tauri (required for desktop:dev; omitted from npm script)...'
    Push-Location -LiteralPath $Root
    try {
        & node (Join-Path $Root 'scripts\stage-voice-deps.mjs') --target win-x64
        if ($LASTEXITCODE -ne 0) { throw "stage-voice-deps exited with code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
    Write-Ok 'voice-deps staged'
}

function Get-Port8787ListenerPids {
    $pids = @()
    $lines = netstat -ano | Select-String 'LISTENING' | Select-String ':8787\s'
    foreach ($line in $lines) {
        if ($line -match '\s(\d+)\s*$') {
            $pids += [int] $Matches[1]
        }
    }
    return ($pids | Sort-Object -Unique)
}

function Stop-StarNetConflicts([string] $Root) {
    if ($SkipConflictKill) {
        Write-WarnMsg 'Skipping conflict cleanup (-SkipConflictKill).'
        return
    }

    $rootNorm = $Root.ToLowerInvariant()

    if ($RestartDesktop) {
        Get-Process -Name 'skynet-desktop' -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = $_.Path
            if ($exe -and $exe.ToLowerInvariant().Contains($rootNorm)) {
                Write-Step "Stopping prior desktop dev: PID $($_.Id)"
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }

    foreach ($listenerPid in (Get-Port8787ListenerPids)) {
        try {
            $proc = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Step "Stopping process on port 8787: $($proc.ProcessName) (PID $listenerPid)"
                Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-WarnMsg "Could not stop PID $listenerPid : $_"
        }
    }

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return }
        $cmdLower = $cmd.ToLowerInvariant()
        if ($cmdLower.Contains('sidecar\index.js') -and $cmdLower.Contains($rootNorm)) {
            Write-Step "Stopping repo sidecar node PID $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    Start-Sleep -Seconds 2
    $still = Get-Port8787ListenerPids
    if ($still.Count -gt 0) {
        Write-WarnMsg ("Port 8787 still in use by PID(s): " + ($still -join ', ') + '. Close StarNet manually or re-run with -RestartDesktop.')
    }
    else {
        Write-Ok 'Port 8787 free for desktop sidecar'
    }
}

# --- main ---
Refresh-PathEnv
$Root = Get-RepoRoot
Set-Location -LiteralPath $Root

Write-Host ''
Write-Host 'StarNet desktop dev launcher' -ForegroundColor White
Write-Host ("Repo: " + $Root) -ForegroundColor DarkGray

Write-Step 'Preflight: Node.js'
if (-not (Test-CommandExists 'node')) { throw 'Node.js 18+ is required. Install from https://nodejs.org and re-run.' }
Write-Ok ("node " + (node --version))
if (-not (Test-CommandExists 'npm')) { throw 'npm not found on PATH.' }
Write-Ok ("npm " + (npm --version))

Invoke-RemediateNpmDeps -Root $Root

if (-not $BrowserOnly) {
    Invoke-RemediateRust
    Invoke-RemediateMsvc
    Invoke-RemediateVoiceDeps -Root $Root
}

Stop-StarNetConflicts -Root $Root

if ($PreflightOnly) {
    Write-Ok 'Preflight complete (-PreflightOnly; no launch).'
    exit 0
}

if ($BrowserOnly) {
    Write-Step 'Starting browser sidecar (npm start) at http://127.0.0.1:8787'
    Write-WarnMsg 'Do not run this while desktop:dev is open (WORKSPACE_BUSY).'
    npm start
}
else {
    Write-Step 'Starting desktop dev (npm run desktop:dev)...'
    Write-Host '    Keep this window open while using StarNet.' -ForegroundColor DarkGray
    npm run desktop:dev
}
