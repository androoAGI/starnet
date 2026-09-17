param(
  [Parameter(Mandatory = $true)][string]$CandidateInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [string]$Output = "windows-published-upgrade-proof.json",
  [string]$HarnessCommit = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$releaseRepo = 'androoAGI/starnet-releases'
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$proofRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot 'starnet-published-upgrade-proof'))
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet'
$productKey = 'HKCU:\Software\Andrew Sims\StarNet'
$candidate = [IO.Path]::GetFullPath($CandidateInstaller)
$targetVersion = [version]$CandidateVersion
$appDataWorkspaces = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'ai.skynet.harness\workspaces'))

if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
  throw "candidate installer does not exist: $candidate"
}

function Assert-UnderTemp {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to mutate a path outside RUNNER_TEMP: $resolved"
  }
  return $resolved
}

function Remove-SafeTree {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Seconds = 30
  )
  $resolved = Assert-UnderTemp $Path
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  # NSIS may remove the app before its asynchronous uninstaller finishes deleting assets.
  # Retry only this confined disposable tree; a persistent lock still fails the proof.
  while ($true) {
    try {
      if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
      }
      return
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Remove-ProofState {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = [IO.Path]::GetFullPath($Path)
  $prefix = $appDataWorkspaces.TrimEnd('\') + '\.upgrade-proof-'
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to remove non-proof StarNet state: $resolved"
  }
  if (Test-Path -LiteralPath $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Get-ExactProcesses {
  param([Parameter(Mandatory = $true)][string[]]$Paths)
  $wanted = @($Paths | ForEach-Object { [IO.Path]::GetFullPath($_) })
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try {
      $actual = $_.Path
      $null -ne $actual -and ($wanted -contains [IO.Path]::GetFullPath($actual))
    } catch { $false }
  })
}

function Stop-ExactProcesses {
  param([Parameter(Mandatory = $true)][string[]]$Paths)
  Get-ExactProcesses $Paths | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (@(Get-ExactProcesses $Paths).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (@(Get-ExactProcesses $Paths).Count -gt 0) {
    throw "owned StarNet process did not stop: $($Paths -join ', ')"
  }
}

function Wait-ForExactProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Seconds = 90
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-ExactProcesses @($Path)).Count -gt 0) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "process did not start within ${Seconds}s: $Path"
}

function Wait-ForExactProcessesStopped {
  param(
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Seconds = 15
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $remaining = @(Get-ExactProcesses $Paths)
  while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-ExactProcesses $Paths)
  }
  if ($remaining.Count -gt 0) {
    $details = ($remaining | ForEach-Object { "$($_.Id):$($_.Path)" }) -join ', '
    throw "$Label left an owned StarNet process alive after ${Seconds}s: $details"
  }
}

function Wait-ForPathRemoved {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Seconds = 15
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ((Test-Path -LiteralPath $Path) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $Path) {
    throw "$Label left a file behind after ${Seconds}s: $Path"
  }
}

function Reset-ProofInstall {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)
  $root = Assert-UnderTemp $InstallRoot
  Stop-ExactProcesses @((Join-Path $root 'skynet-desktop.exe'), (Join-Path $root 'node.exe'))

  $registered = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
  if ($null -ne $registered) {
    $location = [string]$registered.InstallLocation
    if (-not $location) {
      throw 'refusing to remove a StarNet registry record without a verifiable InstallLocation'
    }
    $resolvedLocation = [IO.Path]::GetFullPath($location.Trim('"'))
    if (-not $resolvedLocation.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "refusing to remove a non-proof StarNet registry record: $resolvedLocation"
    }
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force
  }
  if (Test-Path -LiteralPath $productKey) {
    $productLocation = [string](Get-ItemPropertyValue -LiteralPath $productKey -Name '(default)' -ErrorAction SilentlyContinue)
    if (-not $productLocation -or [IO.Path]::GetFullPath($productLocation).StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $productKey -Recurse -Force
    }
  }
  Remove-SafeTree $root
}

function Wait-Installer {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Seconds = 300
  )
  if (-not $Process.WaitForExit($Seconds * 1000)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "$Label did not exit within ${Seconds}s"
  }
  if ($Process.ExitCode -ne 0) {
    throw "$Label exited $($Process.ExitCode)"
  }
}

Remove-SafeTree $proofRoot
New-Item -ItemType Directory -Path $proofRoot | Out-Null

$headers = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'starnet-published-upgrade-proof'
}
# PowerShell 7 preserves a top-level JSON array as one pipeline object when Invoke-RestMethod
# is called directly inside @(...). Assign first, then array-wrap the value so each release is
# an element instead of one nested Object[] whose tag_name is itself an array.
$releaseResponse = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$releaseRepo/releases?per_page=20"
$releases = @($releaseResponse)
$sources = @($releases | Where-Object {
  if ($_.draft -or $_.prerelease) { return $false }
  try { return ([version]$_.tag_name.TrimStart('v')) -lt $targetVersion } catch { return $false }
} | ForEach-Object {
  $release = $_
  $asset = @($release.assets | Where-Object { $_.name -like 'StarNet_*_x64-setup.exe' }) | Select-Object -First 1
  if ($null -ne $asset) {
    [pscustomobject]@{ tag = [string]$release.tag_name; version = [string]$release.tag_name.TrimStart('v'); asset = $asset }
  }
} | Select-Object -First 2)

if ($sources.Count -ne 2) {
  throw "release-blocking proof requires the two latest published Windows versions older than $CandidateVersion; found $($sources.Count)"
}

$results = @()
try {
  foreach ($source in $sources) {
    $slug = $source.tag.TrimStart('v').Replace('.', '-')
    $scenarioRoot = Assert-UnderTemp (Join-Path $proofRoot $slug)
    $installRoot = Assert-UnderTemp (Join-Path $scenarioRoot 'install')
    $download = Assert-UnderTemp (Join-Path $scenarioRoot $source.asset.name)
    $markerRoot = [IO.Path]::GetFullPath((Join-Path $appDataWorkspaces ".upgrade-proof-$slug"))
    $marker = Join-Path $markerRoot 'sentinel.json'

    Reset-ProofInstall $installRoot
    Remove-ProofState $markerRoot
    New-Item -ItemType Directory -Path $installRoot,$markerRoot | Out-Null
    [IO.File]::WriteAllText($marker, "{`"schema`":`"starnet.upgrade-sentinel.v1`",`"source`":`"$($source.tag)`"}`n")
    $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant()

    Invoke-WebRequest -Headers $headers -Uri $source.asset.browser_download_url -OutFile $download
    $publishedDigest = if ($source.asset.PSObject.Properties.Name -contains 'digest') {
      [string]$source.asset.digest
    } else { '' }
    if ($publishedDigest -match '^sha256:([0-9a-f]{64})$') {
      $downloadHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($downloadHash -ne $Matches[1].ToLowerInvariant()) {
        throw "$($source.tag) installer digest does not match GitHub"
      }
    }

    $oldInstall = Start-Process -FilePath $download -ArgumentList '/S', "/D=$installRoot" -PassThru
    Wait-Installer -Process $oldInstall -Label "$($source.tag) clean install"
    $app = Join-Path $installRoot 'skynet-desktop.exe'
    $node = Join-Path $installRoot 'node.exe'
    $oldUninstaller = Join-Path $installRoot 'uninstall.exe'
    foreach ($required in @($app,$node,$oldUninstaller)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "$($source.tag) install is missing $required" }
    }

    Start-Process -FilePath $app | Out-Null
    Wait-ForExactProcess -Path $app
    Wait-ForExactProcess -Path $node

    # Reproduce the field failure exactly: the registry says StarNet is installed, but the old
    # uninstaller cannot be invoked. The candidate must never depend on that file for an upgrade.
    Remove-Item -LiteralPath $oldUninstaller -Force
    $upgrade = Start-Process -FilePath $candidate -PassThru
    Wait-Installer -Process $upgrade -Label "$($source.tag) -> $CandidateVersion manual upgrade"

    $installedVersion = [string](Get-Item -LiteralPath $app).VersionInfo.ProductVersion
    if ([version]$installedVersion -ne $targetVersion) {
      throw "$($source.tag) upgraded executable is $installedVersion; expected $CandidateVersion"
    }
    if (-not (Test-Path -LiteralPath $oldUninstaller -PathType Leaf)) {
      throw "$($source.tag) -> $CandidateVersion did not recreate uninstall.exe"
    }
    if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $markerHash) {
      throw "$($source.tag) -> $CandidateVersion changed protected user state"
    }
    Wait-ForExactProcess -Path $app
    Wait-ForExactProcess -Path $node

    # The candidate's own uninstaller must now stop the active shell + sidecar cleanly. This
    # proves NSIS_HOOK_PREUNINSTALL for every user who installs this candidate or anything newer.
    $futureUninstall = Start-Process -FilePath $oldUninstaller -ArgumentList '/S' -PassThru
    Wait-Installer -Process $futureUninstall -Label "$CandidateVersion active-process uninstall"
    Wait-ForExactProcessesStopped -Paths @($app,$node) -Label "$CandidateVersion uninstaller"
    Wait-ForPathRemoved -Path $app -Label "$CandidateVersion uninstaller"
    if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $markerHash) {
      throw "$CandidateVersion uninstaller removed or changed user state without consent"
    }

    $results += [ordered]@{
      path = if ($results.Count -eq 0) { 'latest-to-next' } else { 'n-minus-one-to-next' }
      sourceVersion = $source.version
      targetVersion = $CandidateVersion
      oldUninstallerDeleted = $true
      activeShellAndSidecar = $true
      manualInstallerExited = 0
      relaunched = $true
      stateSha256Before = $markerHash
      stateSha256After = $markerHash
      futureUninstallStoppedProcesses = $true
      futureUninstallPreservedState = $true
    }

    Write-Host "::notice::$($source.tag) -> $CandidateVersion upgrade, active-process uninstall and state-preservation assertions passed; cleaning disposable installation."
    Reset-ProofInstall $installRoot
    Remove-ProofState $markerRoot
  }
} finally {
  foreach ($source in $sources) {
    $slug = $source.tag.TrimStart('v').Replace('.', '-')
    $installRoot = Join-Path (Join-Path $proofRoot $slug) 'install'
    try { Reset-ProofInstall $installRoot } catch { Write-Warning $_ }
    try { Remove-ProofState (Join-Path $appDataWorkspaces ".upgrade-proof-$slug") } catch { Write-Warning $_ }
  }
}

$receipt = [ordered]@{
  schema = 'starnet.windows-published-upgrade-proof.v1'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  proofHarness = [ordered]@{
    commit = $HarnessCommit
    sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  candidate = [ordered]@{
    version = $CandidateVersion
    installer = [IO.Path]::GetFileName($candidate)
    sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  scenarios = $results
  ok = $results.Count -eq 2
}
$outputPath = [IO.Path]::GetFullPath($Output)
$receipt | ConvertTo-Json -Depth 6 | Out-File -LiteralPath $outputPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 6
Write-Host "::notice::published Windows upgrade proof passed: $($results.path -join ', ')"
