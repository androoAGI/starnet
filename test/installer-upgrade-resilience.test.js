#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const hooks = fs.readFileSync(path.join(ROOT, 'src-tauri', 'installer', 'hooks.nsh'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-train.yml'), 'utf8');
const proof = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'windows-published-upgrade-proof.ps1'), 'utf8');

const guiInit = hooks.indexOf('Function StarNetManualUpgradeInit');
const preinstall = hooks.indexOf('!macro NSIS_HOOK_PREINSTALL');
A.ok(guiInit >= 0 && guiInit < preinstall, 'manual-upgrade detection runs before Tauri reaches the install section');
A.ok(hooks.includes('!define MUI_CUSTOMFUNCTION_GUIINIT StarNetManualUpgradeInit'), 'manual upgrade composes with Tauri Modern UI GUI initialization');
A.ok(hooks.includes('GetDLLVersion "$EXEPATH"'), 'manual upgrade reads the candidate executable version instead of duplicating a release pin');
A.ok(hooks.includes('${VersionCompare} "$R3" "$R9" $R2'), 'manual upgrade uses the preloaded NSIS version comparison against installed truth');
A.ok((hooks.match(/ReadRegStr \$R1 HK(?:CU|LM).*"InstallLocation"/g) || []).length === 2,
  'manual upgrade reads the authoritative install location from both supported registry contexts');
A.ok(hooks.includes('StrCpy $R1 $R1 -1 1') && hooks.includes('StrCpy $INSTDIR $R1'),
  'manual upgrade removes registry quotes and restores the exact previous install directory');
A.ok(hooks.includes('StrCpy $CMDLINE "$CMDLINE /UPDATE /P /R"'), 'strict manual upgrades become passive in-place updates with relaunch');
A.ok(hooks.includes('Call .onInit'), 'Tauri reparses the augmented update command before rendering pages');
A.ok(hooks.includes('!macro NSIS_HOOK_PREUNINSTALL'), 'new uninstallers own active-process cleanup');
A.ok((hooks.match(/!insertmacro STARNET_STOP_INSTALL_PROCESSES/g) || []).length === 2,
  'install and uninstall share one exact process-cleanup implementation');

const shellKill = hooks.indexOf('Get-Process -Name skynet-desktop');
const nodeKill = hooks.indexOf('Get-Process -Name node');
A.ok(shellKill >= 0 && nodeKill > shellKill, 'guardian-owning shell stops before its bundled sidecar');
A.ok(hooks.includes("Where-Object Path -eq $\\'$INSTDIR\\skynet-desktop.exe$\\'"), 'shell kill is confined to the exact install path');
A.ok(hooks.includes("Where-Object Path -eq $\\'$INSTDIR\\node.exe$\\'"), 'node kill is confined to the exact bundled runtime path');

A.ok(proof.includes("Select-Object -First 2"), 'release proof requires latest and N-1 published sources');
A.ok(proof.includes('$releaseResponse = Invoke-RestMethod') && proof.includes('$releases = @($releaseResponse)'),
  'release proof normalizes the PowerShell 7 top-level JSON array before filtering published sources');
const processCountLines = proof.split(/\r?\n/).filter(line => line.includes('Get-ExactProcesses') && line.includes('.Count'));
A.ok(processCountLines.length === 3 && processCountLines.every(line => line.includes('@(Get-ExactProcesses')),
  'release proof array-wraps zero-process results before StrictMode Count checks');
A.ok(proof.includes('Wait-ForExactProcessesStopped -Paths @($app,$node)') && proof.includes('alive after ${Seconds}s'),
  'active-process uninstall gets a bounded settle window and still fails with exact survivor evidence');
A.ok(proof.includes('Wait-ForPathRemoved -Path $app') && proof.includes('left a file behind after ${Seconds}s'),
  'asynchronous NSIS cleanup gets a bounded settle window and still fails with exact leftover evidence');
A.ok(proof.includes('Remove-Item -LiteralPath $oldUninstaller -Force'), 'release proof fault-injects the reported missing-old-uninstaller failure');
A.ok(proof.includes('Start-Process -FilePath $app'), 'release proof launches the old installed shell');
A.ok(proof.includes('Wait-ForExactProcess -Path $node'), 'release proof observes the old bundled sidecar running');
A.ok(proof.includes('Start-Process -FilePath $candidate -PassThru'), 'release proof drives the no-flags manual installer path');
A.ok(proof.includes('changed protected user state'), 'release proof fails if protected state changes');
A.ok(proof.includes('active-process uninstall'), 'release proof exercises the candidate uninstaller while processes are active');
A.ok(proof.includes('refusing to mutate a path outside RUNNER_TEMP'), 'destructive CI cleanup is bounded to runner temp');
A.ok(proof.includes('without a verifiable InstallLocation'), 'registry cleanup refuses an installation it cannot prove belongs to the CI sandbox');

const workflowStep = workflow.indexOf('Prove published Windows upgrades survive a broken old uninstaller');
const stageDraft = workflow.indexOf('stage-draft:');
A.ok(workflowStep >= 0 && stageDraft > workflowStep, 'published-version upgrade proof blocks the train before draft staging');
A.ok(workflow.includes('windows-published-upgrade-proof-${{ matrix.target }}'), 'release train retains the upgrade receipt');
A.ok(workflow.includes('PROOF_HARNESS_COMMIT: ${{ github.workflow_sha }}') &&
  workflow.includes('git show "$($env:PROOF_HARNESS_COMMIT):scripts/ci/windows-published-upgrade-proof.ps1"'),
  'recovery dispatch pins its upgrade harness to the exact workflow commit');
A.ok(workflow.includes("Join-Path $env:RUNNER_TEMP 'windows-published-upgrade-proof.ps1'") &&
  proof.includes('proofHarness = [ordered]@{') && proof.includes('Get-FileHash -LiteralPath $PSCommandPath'),
  'harness repair stays outside the immutable app checkout and records its executed bytes');
A.ok(workflow.includes("!cancelled() && needs.build.result == 'success' && needs.notarize-macos.result == 'success'"),
  'Intel installed acceptance runs only when both build and notarization prerequisites succeeded');

if (process.platform === 'win32') {
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts', 'ci', 'windows-published-upgrade-proof.ps1').replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|% Message;exit 1}`
  ], { encoding: 'utf8' });
  A.eq(ps.status, 0, 'Windows upgrade proof parses as PowerShell: ' + String(ps.stderr || ps.stdout));
  const cleanup = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'fixtures', 'windows-upgrade-cleanup.ps1')
  ], { encoding: 'utf8', timeout: 20000 });
  A.eq(cleanup.status, 0, 'disposable upgrade cleanup survives a transient lock and rejects persistent locks/unsafe paths: ' + String(cleanup.stderr || cleanup.stdout));
}

A.report('installer-upgrade-resilience.test');
