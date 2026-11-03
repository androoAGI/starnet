param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Stub
)
# Runs the published-upgrade proof's own Assert-InstalledIntegrity (taken from the harness by its AST) against a
# disposable install whose skynet-desktop is a stub of the headless verify (install-verify-stub.js): green only for a
# verified install whose zeroed module is named, red for every way the proof could pass without proving that, and the
# module's bytes restored after every case.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts/ci/windows-published-upgrade-proof.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Upgrade harness does not parse' }
$definition = $ast.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Assert-InstalledIntegrity' }, $true)
if ($null -eq $definition) { throw 'Upgrade harness has no Assert-InstalledIntegrity' }
. ([scriptblock]::Create($definition.Extent.Text))

$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $systemTemp ('starnet-integrity-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($systemTemp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped temporary directory' }
$install = Join-Path $fixtureRoot 'install'
$work = Join-Path $fixtureRoot 'work'
New-Item -ItemType Directory -Path $install, $work | Out-Null
try {
  $files = [ordered]@{
    'sidecar/index.js' = "const { makeShellTool } = require('./tools/builtin/shell.js');`n"
    'sidecar/tools/builtin/shell.js' = "module.exports = { makeShellTool() { return 'shell'; } };`n"
    'frontend/app/bootguard.js' = "window.BootGuard = {};`n"
    'node_modules/voice/index.js' = "module.exports = 1;`n"
  }
  $manifest = @()
  foreach ($rel in $files.Keys) {
    $full = Join-Path $install ($rel.Replace('/', '\'))
    New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($full, $files[$rel])
    $manifest += [ordered]@{ path = $rel; size = (Get-Item -LiteralPath $full).Length }
  }
  $manifestPath = Join-Path $fixtureRoot 'stub-manifest.json'
  [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 3))
  $app = Join-Path $install 'skynet-desktop.cmd'
  [IO.File]::WriteAllText($app, "@echo off`r`nset `"STUB_EXE=%~f0`"`r`n`"%STUB_NODE%`" `"%STUB_JS%`" %*`r`nexit /b %ERRORLEVEL%`r`n")
  $env:STUB_NODE = $Node
  $env:STUB_JS = $Stub
  $env:STUB_MANIFEST = $manifestPath

  $shell = Join-Path $install 'sidecar\tools\builtin\shell.js'
  $shellHash = (Get-FileHash -LiteralPath $shell -Algorithm SHA256).Hash
  function Invoke-Case {
    param([string]$Mode = '', [string]$Files = '')
    $env:STUB_MODE = $Mode
    $env:STUB_FILES = $Files
    try {
      $result = Assert-InstalledIntegrity -App $app -InstallRoot $install -WorkRoot $work -Label 'fixture'
      return [pscustomobject]@{ result = $result; error = '' }
    } catch {
      return [pscustomobject]@{ result = $null; error = $_.Exception.Message }
    } finally {
      $env:STUB_MODE = ''
      $env:STUB_FILES = ''
      if ((Get-FileHash -LiteralPath $shell -Algorithm SHA256).Hash -ne $shellHash) { throw "[$Mode] the zeroed module was not restored" }
    }
  }
  function Assert-Red {
    param([string]$Case, $Outcome, [string]$Pattern)
    if ($null -ne $Outcome.result) { throw "$Case passed the installed-integrity proof" }
    if ($Outcome.error -notmatch $Pattern) { throw "$Case failed for another reason: $($Outcome.error)" }
  }

  $healthy = Invoke-Case
  if ($healthy.error) { throw "a verified install whose zeroed module is named failed the proof: $($healthy.error)" }
  $r = $healthy.result
  if ($r.state -ne 'verified' -or $r.files -ne 2391 -or $r.minimumFiles -ne 600) { throw "healthy facts are wrong: $($r | ConvertTo-Json -Depth 4)" }
  $z = $r.zeroedModule
  if ($z.path -ne 'sidecar/tools/builtin/shell.js' -or $z.exitCode -ne 3 -or -not $z.restored -or
      $z.named -notlike 'sidecar/tools/builtin/shell.js is empty (0 of * bytes)') {
    throw "zeroed-module facts are wrong: $($z | ConvertTo-Json -Depth 4)"
  }
  $receipt = [IO.File]::ReadAllText((Join-Path $work 'zeroed-verify.json')) | ConvertFrom-Json
  if ($receipt.state -ne 'damaged' -or @($receipt.findings).Count -ne 1) { throw 'the zeroed run did not leave its damaged receipt in the work folder' }

  Assert-Red 'an install that is not checked' (Invoke-Case -Mode 'not-checked') 'does not verify its install manifest'
  Assert-Red 'a manifest of too few files' (Invoke-Case -Files '12') 'verified only 12 files'
  Assert-Red 'an exe built before the install manifest' (Invoke-Case -Mode 'no-receipt') 'wrote no install-verify receipt'
  Assert-Red 'a verify of another install' (Invoke-Case -Mode 'elsewhere') 'not this install'
  Assert-Red 'a verify blind to the zeroed module' (Invoke-Case -Mode 'blind') 'did not report the zeroed'
  Assert-Red 'a verify naming another file' (Invoke-Case -Mode 'other') 'instead of exactly sidecar/tools/builtin/shell.js'
  $index = Join-Path $install 'sidecar\index.js'
  $indexBytes = [IO.File]::ReadAllBytes($index)
  Remove-Item -LiteralPath $index -Force
  try { Assert-Red 'an upgraded install missing a listed file' (Invoke-Case) 'does not verify its install manifest' }
  finally { [IO.File]::WriteAllBytes($index, $indexBytes) }

  Write-Output 'PASS: a verified install with its zeroed module named passes; not checked, too few files, no receipt, another root, a blind verify, the wrong file and a damaged install all fail; the module is restored every time.'
} finally {
  Remove-Item Env:STUB_NODE, Env:STUB_JS, Env:STUB_MANIFEST, Env:STUB_MODE, Env:STUB_FILES -ErrorAction SilentlyContinue
  # every path below is inside this fixture's own temporary root
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
