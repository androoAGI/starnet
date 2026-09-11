#!/usr/bin/env node
// Disposable hosted Windows VM only: historical public installer -> private candidate.
// This proves reinstall continuity, independently of automatic updater delivery.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { populatedFixture, continuityProjection, stableJson } from '../lib/update-continuity.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('This destructive fixture is restricted to a disposable GitHub-hosted Windows VM.');
}
const required = name => { const value = process.env[name]; if (!value) throw new Error('Missing ' + name); return value; };
const candidate = required('INSTALLER');
const baseline = required('BASELINE_INSTALLER');
const expected = required('CANDIDATE_SOURCE');
const baselineVersion = required('BASELINE_VERSION');
const exe = required('EXE');
const profile = path.join(required('APPDATA'), 'ai.skynet.harness');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = { schema: 'starnet.public-upgrade-continuity.v1', at: new Date().toISOString(), mode: 'manual-nsis-reinstall', candidateSource: expected, baselineVersion, baselineInstallerSha256: sha(baseline), candidateInstallerSha256: sha(candidate), checks: {}, outcome: 'FAIL' };
let cdp;
function ps(script, extra = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PROOF_EXE: exe, ...extra }, encoding: 'utf8', timeout: 180000,
  }).trim();
}
function stop() {
  cdp?.ws.close(); cdp = null;
  // The hosted runner owns this entire isolated installation. Never match by process name alone.
  ps(`$ErrorActionPreference='Stop'
$dir=Split-Path $env:PROOF_EXE
$owned=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:PROOF_EXE -or $_.ExecutablePath -eq (Join-Path $dir 'node.exe') })
foreach($p in $owned){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2`);
}
function install(file) {
  stop();
  ps(`$p=Start-Process -FilePath $env:PROOF_INSTALLER -ArgumentList '/S','/UPDATE' -WindowStyle Hidden -Wait -PassThru
if($p.ExitCode -ne 0){throw "Installer failed: $($p.ExitCode)"}`, { PROOF_INSTALLER: file });
}
async function launch(populated = false) {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'lifecycle.json'), JSON.stringify({ version: 1, closeToTray: false }));
  ps(`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=19373'
Start-Process -FilePath $env:PROOF_EXE -WindowStyle Hidden | Out-Null`);
  cdp = await connectCDP(19373);
  for (let n = 0; n < 120; n++) {
    try { if (await evalJS(cdp, "typeof App!=='undefined'&&typeof Save!=='undefined'&&typeof CloudSave!=='undefined'&&typeof WorldModel!=='undefined'&&typeof SharedSpecialties==='object'&&!document.getElementById('bootguard-fatal')" + (populated ? '&&App.crewCount()===2' : ''))) return; } catch {}
    await sleep(500);
  }
  receipt.lastBoot = await evalJS(cdp, "({crew:typeof App==='undefined'?null:App.crewCount(),configured:typeof Harness==='undefined'?null:Harness.configured('openrouter'),pull:typeof CloudSave==='undefined'?null:CloudSave.pullOutcome(),bootFatal:!!document.getElementById('bootguard-fatal')})").catch(() => null);
  throw new Error('Installed application did not initialize');
}
async function snapshot() {
  return evalJS(cdp, `(async()=>{App.persist();const drained=await CloudSave.flushForUpdate();if(!drained.ok)throw Error('Save drain not confirmed');const r=await fetch('/api/save?agent=agent');if(!r.ok)throw Error('Save read failed');return {local:JSON.parse(localStorage.getItem('starnet.save')||'null'),durable:(await r.json()).save,sentinel:JSON.parse(localStorage.getItem('starnet.canary.continuity')||'null')}})()`);
}
try {
  install(baseline); await launch();
  receipt.beforeBuild = await evalJS(cdp, "__TAURI__.core.invoke('starnet_build_info')");
  if (receipt.beforeBuild.version !== baselineVersion) throw new Error('Historical public version mismatch');
  receipt.checks.historicalPublicBoot = true;
  // A fresh hosted profile has no credential, so a populated OpenRouter save correctly
  // opens connection recovery rather than the station. Store a deliberately invalid,
  // synthetic value through the real keychain path; no inference task is submitted.
  await evalJS(cdp, "Harness.setKey('invalid-upgrade-fixture-' + crypto.randomUUID(),'openrouter')");
  const fixture = populatedFixture(randomUUID());
  await evalJS(cdp, `(async()=>{
    await CloudSave.flush({force:true});
    const prior=await fetch('/api/save?agent=agent').then(r=>r.json());
    const save=${JSON.stringify(fixture)};save.version=Save.CURRENT;
    const world=WorldModel.create(WorldModel.starterDoc());world.ensureWorkstation('agent');world.ensureWorkstation('scout');save.station=world.serialize();
    save._saveRevision=Number(prior.save&&prior.save._saveRevision)||0;
    const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(save)});const b=await r.json();if(!r.ok||!b.ok)throw Error('Fixture save refused');
    save._saveRevision=b.revision;save._saveDirty=false;save.updatedAt=b.updatedAt;
    localStorage.setItem('starnet.save',JSON.stringify(save));localStorage.setItem('starnet.canary.continuity',JSON.stringify({nonce:save.agent.canaryNonce}));
  })()`);
  stop(); await launch(true);
  const before = await snapshot();
  receipt.beforeState = continuityProjection(before);
  if (!await evalJS(cdp, "__TAURI__.core.invoke('harness_has_provider_key',{provider:'openrouter'})")) throw new Error('Synthetic key did not survive public restart');
  for (const s of [before.local, before.durable]) {
    if (s?.agents?.length !== 2 || !s.station?.props?.some(p => p.agentId === 'scout') || !s.workstreams?.some(w => w.history?.some(m => m.content === 'preserve-' + fixture.agent.canaryNonce)) || s.usage?.calls !== 2) throw new Error('Public baseline did not retain populated fixture');
  }
  receipt.checks.populatedPublicRestart = true;
  install(candidate); await launch(true);
  receipt.afterBuild = await evalJS(cdp, "__TAURI__.core.invoke('starnet_build_info')");
  if (receipt.afterBuild.sha !== expected || receipt.afterBuild.dirty) throw new Error('Candidate identity mismatch');
  if (receipt.beforeBuild.sha === receipt.afterBuild.sha) throw new Error('Installer did not replace the public source build');
  receipt.checks.exactCandidateInstalled = true;
  const after = await snapshot();
  receipt.afterState = continuityProjection(after);
  if (!await evalJS(cdp, "__TAURI__.core.invoke('harness_has_provider_key',{provider:'openrouter'})")) throw new Error('Synthetic key did not survive candidate install');
  const projection = stableJson(continuityProjection(before));
  if (projection !== stableJson(continuityProjection(after))) throw new Error('State changed across public-to-candidate reinstall');
  receipt.checks.statePreservedAcrossInstall = true;
  // Normal quit and relaunch exercise the candidate's ordinary persisted state path too.
  await evalJS(cdp, '__TAURI__.window.getCurrentWindow().close()').catch(() => {});
  for (let n = 0; n < 90; n++) {
    const alive = ps("@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $env:PROOF_EXE}).Count");
    if (alive === '0') break;
    if (n === 89) throw new Error('Normal candidate quit did not exit');
    await sleep(500);
  }
  cdp?.ws.close(); cdp = null; await launch(true);
  receipt.restartedState = continuityProjection(await snapshot());
  if (projection !== stableJson(receipt.restartedState)) throw new Error('State changed across candidate restart');
  if (!await evalJS(cdp, "__TAURI__.core.invoke('harness_has_provider_key',{provider:'openrouter'})")) throw new Error('Synthetic key did not survive candidate restart');
  receipt.syntheticKeyPresentAcrossInstallAndRestart = true;
  receipt.checks.statePreservedAcrossRestart = true;
  receipt.projectionSha256 = createHash('sha256').update(projection).digest('hex');
  receipt.installedExeSha256 = sha(exe);
  receipt.outcome = 'PASS';
} catch (error) { receipt.error = String(error.stack || error); }
finally { try { stop(); } finally { fs.writeFileSync('public-upgrade-continuity.json', JSON.stringify(receipt, null, 2) + '\n'); } }
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = receipt.outcome === 'PASS' ? 0 : 1;
