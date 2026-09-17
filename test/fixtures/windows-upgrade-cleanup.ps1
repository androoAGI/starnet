$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts/ci/windows-published-upgrade-proof.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Upgrade harness does not parse' }
foreach ($name in @('Assert-UnderTemp', 'Remove-SafeTree')) {
  $definition = $ast.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class UpgradeCleanupLease : IDisposable {
    private readonly FileStream stream;
    private readonly Thread releaser;
    public UpgradeCleanupLease(string path, int milliseconds) {
        stream = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        if (milliseconds >= 0) {
            releaser = new Thread(() => { Thread.Sleep(milliseconds); stream.Dispose(); });
            releaser.IsBackground = true;
            releaser.Start();
        }
    }
    public void Dispose() { if (releaser != null) releaser.Join(); stream.Dispose(); }
}
'@

$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$tempRoot = [IO.Path]::GetFullPath((Join-Path $systemTemp ('starnet-cleanup-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($systemTemp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped temporary directory' }
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  $transient = Join-Path $tempRoot 'transient'
  New-Item -ItemType Directory -Path $transient | Out-Null
  $file = Join-Path $transient 'sprite.png'
  [IO.File]::WriteAllText($file, 'disposable test fixture')
  $lease = New-Object UpgradeCleanupLease($file, 1500)
  try { Remove-SafeTree $transient -Seconds 5 } finally { $lease.Dispose() }
  if (Test-Path -LiteralPath $transient) { throw 'Transient lock cleanup left files behind' }

  $persistent = Join-Path $tempRoot 'persistent'
  New-Item -ItemType Directory -Path $persistent | Out-Null
  $file = Join-Path $persistent 'sprite.png'
  [IO.File]::WriteAllText($file, 'a persistent lock must fail')
  $lease = New-Object UpgradeCleanupLease($file, -1)
  $failed = $false
  try { try { Remove-SafeTree $persistent -Seconds 0 } catch { $failed = $true } } finally { $lease.Dispose() }
  if (-not $failed) { throw 'Persistent file lock was silently accepted' }
  Remove-SafeTree $persistent

  $rejected = $false
  try { Remove-SafeTree $systemTemp } catch { $rejected = $true }
  if (-not $rejected) { throw 'Cleanup accepted a path outside its disposable root' }
  Write-Output 'PASS: transient lock settles; persistent lock fails; outside-root cleanup is rejected.'
} finally {
  foreach ($child in @('transient', 'persistent')) { Remove-SafeTree (Join-Path $tempRoot $child) }
  # All recursive removal is confined by Assert-UnderTemp; this removes only the empty fixture root.
  Remove-Item -LiteralPath $tempRoot -Force
}
