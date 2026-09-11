#!/usr/bin/env node
// Disposable hosted Windows VM only: historical public installer -> private candidate.
// This proves reinstall continuity, independently of automatic updater delivery.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { populatedFixture, continuityProjection, stableJson } from '../lib/update-continuity.mjs';
const { bootToken } = createRequire(import.meta.url)('../../test/_httpToken.js');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('This destructive fixture is restricted to a disposable GitHub-hosted Windows VM.');
}
const required = name => { const value = process.env[name]; if (!value) throw new Error('Missing ' + name); return value; };
const candidate = required('INSTALLER');
const baseline = required('BASELINE_INSTALLER');
const expected = required('CANDIDATE_SOURCE');
const baselineVersion = required('BASELINE_VERSION');
const automatic = process.env.PROOF_AUTOMATIC_UPDATE === 'true';
const targetVersion = automatic ? required('TARGET_VERSION') : null;
const exe = required('EXE');
const profile = path.join(required('APPDATA'), 'ai.skynet.harness');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = { schema: 'starnet.public-upgrade-continuity.v1', at: new Date().toISOString(), mode: 'manual-nsis-reinstall', candidateSource: expected, baselineVersion, baselineInstallerSha256: sha(baseline), candidateInstallerSha256: sha(candidate), checks: {}, outcome: 'FAIL' };
if (automatic) receipt.mode = 'public-in-app-updater';
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
  const snap = await evalJS(cdp, `(async()=>{
    const original=window.fetch, writes=[];
    window.fetch=async function(input,options){
      const r=await original.call(this,input,options);
      if(String(input).includes('/api/save')&&options?.method==='POST')writes.push({status:r.status,body:await r.clone().text()});
      return r;
    };
    try {
      App.persist();let drained=await CloudSave.flushForUpdate();const drains=[drained];
      // Public 0.11.1 can queue another boot-time save while its first successful write settles.
      // A clean health receipt plus HTTP success is not enough: drain that newer document too.
      // Never retry through a failed write, and never proceed without an affirmative final drain.
      for(let n=0;!drained.ok&&n<10;n++){
        const h=CloudSave.health();
        if(h.degraded||h.consecutiveFailures||writes.some(w=>w.status!==200||JSON.parse(w.body).ok!==true))break;
        await new Promise(r=>setTimeout(r,100));
        drained=await CloudSave.flushForUpdate();drains.push(drained);
      }
      const r=await fetch('/api/save?agent=agent');if(!r.ok)throw Error('Save read failed');
      return {drained,drains,writes,health:CloudSave.health(),local:JSON.parse(localStorage.getItem('starnet.save')||'null'),durable:(await r.json()).save,sentinel:JSON.parse(localStorage.getItem('starnet.canary.continuity')||'null')};
    }finally{window.fetch=original;}
  })()`);
  if (!snap.drained.ok) { receipt.failedSnapshot = snap; throw new Error('Save drain not confirmed; see failedSnapshot responses'); }
  (receipt.saveDrains ||= []).push({drains:snap.drains,writes:snap.writes,health:snap.health});
  return snap;
}
function fixtureState(state) {
  const out = structuredClone(state);
  for (const key of ['local', 'durable']) {
    const save = out[key];
    // This fixture supplies identity documents, not a hand-written systemPrompt. The app recomposes
    // that derived prompt on boot using the new harness instructions; the underlying docs still compare.
    if (typeof save?.agent?.docs?.identity !== 'string') throw new Error('Fixture identity documents missing');
    delete save.agent.systemPrompt;
    for (const agent of save.agents || []) {
      // The public fixture omitted personaId. Current roster hydration explicitly records its existing
      // default as "composed". Permit exactly this additive default, not an arbitrary persona change.
      if (agent.personaId === 'composed') delete agent.personaId;
    }
  }
  return out;
}
async function installFromPublicUpdater() {
  const priorPid = Number(ps("@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $env:PROOF_EXE})[0].ProcessId"));
  if (!priorPid) throw new Error('Could not identify old installed process');
  await evalJS(cdp, "StationUI.openTerm('updates')");
  await sleep(500);
  const checked = await evalJS(cdp, "(()=>{const b=document.getElementById('up-check');if(!b)return false;b.click();return true;})()");
  if (!checked) throw new Error('Update Center CHECK NOW button missing');
  let available;
  for (let n = 0; n < 60; n++) {
    available = await evalJS(cdp, 'Updates.snapshot()');
    if (available.phase === 'error') throw new Error('Public update check failed: ' + available.error);
    if (available.phase === 'available' && available.update?.version === targetVersion) break;
    await sleep(1000);
  }
  if (available?.phase !== 'available' || available.update?.version !== targetVersion) throw new Error('Expected public update did not become available');
  receipt.publicUpdate = { currentVersion: available.currentVersion, targetVersion: available.update.version };
  receipt.checks.publicUpdateAvailable = true;
  await sleep(250);
  const clicked = await evalJS(cdp, "(()=>{const b=document.getElementById('up-install');if(!b||b.disabled)return false;b.click();return true;})()");
  if (!clicked) throw new Error('Update Center INSTALL UPDATE button missing or disabled');
  // Do not run the candidate installer or manually relaunch: this branch must prove
  // the released app consumed the real public feed and restarted itself.
  let observed;
  for (let n = 0; n < 100; n++) {
    await sleep(3000);
    observed = JSON.parse(ps(`$apps=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $env:PROOF_EXE})
$setup=@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '(?i)starnet.*setup|^Au_$' -or $_.MainWindowTitle -like '*StarNet*Setup*'})
@{version=(Get-Item $env:PROOF_EXE).VersionInfo.ProductVersion;appPids=@($apps | ForEach-Object {$_.ProcessId});installerPids=@($setup | ForEach-Object {$_.Id})}|ConvertTo-Json -Compress`));
    if (String(observed.version).split('.').slice(0,3).join('.') === targetVersion && observed.appPids.length === 1 && observed.appPids[0] !== priorPid && observed.installerPids.length === 0) break;
    try {
      if (observed.appPids.includes(priorPid) && cdp.ws.readyState === 1) {
        const state = await evalJS(cdp, 'Updates.snapshot()');
        if (state.error || state.phase === 'error') throw new Error('In-app update failed: ' + state.error);
      }
    } catch (error) { if (String(error.message).startsWith('In-app update failed:')) throw error; }
  }
  if (String(observed?.version).split('.').slice(0,3).join('.') !== targetVersion || observed.appPids.length !== 1 || observed.appPids[0] === priorPid || observed.installerPids.length !== 0) throw new Error('Public update did not complete and automatically restart: ' + JSON.stringify(observed));
  receipt.automaticRestart = { oldPid: priorPid, ...observed };
  receipt.checks.installerExitedAndAppRestarted = true;
  // NSIS relaunch intentionally need not inherit a test-only WebView debugging flag.
  // First prove the automatic process has a real window and its own healthy target
  // sidecar. Only then perform a normal inspection restart with CDP enabled.
  let automaticHealth;
  for (let n = 0; n < 60; n++) {
    const live = JSON.parse(ps(`$app=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $env:PROOF_EXE})[0]
$window=Get-Process -Id $app.ProcessId
$node=@(Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq $app.ProcessId -and $_.ExecutablePath -eq (Join-Path (Split-Path $env:PROOF_EXE) 'node.exe')})
$ports=@($node | ForEach-Object {Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue} | Where-Object {$_.LocalAddress -eq '127.0.0.1'})
@{pid=$app.ProcessId;responding=$window.Responding;window=$window.MainWindowHandle.ToInt64();title=$window.MainWindowTitle;ports=@($ports | ForEach-Object {$_.LocalPort})}|ConvertTo-Json -Compress`));
    if (live.pid === observed.appPids[0] && live.responding && live.window && live.title === 'StarNet' && live.ports.length === 1) {
      const base = 'http://127.0.0.1:' + live.ports[0];
      const token = await bootToken(base, base);
      const response = await fetch(base + '/api/version', { headers: { Origin: base, 'X-StarNet-Token': token } });
      const version = await response.json();
      if (response.ok && version.app === targetVersion && version.buildSha === expected) { automaticHealth = { ...live, version: version.app, source: version.buildSha }; break; }
    }
    await sleep(1000);
  }
  if (!automaticHealth) throw new Error('Automatically restarted target never exposed its window and healthy exact-source sidecar');
  receipt.automaticHealth = automaticHealth;
  receipt.checks.automaticRestartHealthy = true;
  cdp?.ws.close(); cdp = null;
  ps(`$p=Get-Process -Id ${automaticHealth.pid}
if(-not $p.CloseMainWindow()){throw 'Could not request normal inspection close'}
for($i=0;$i -lt 60;$i++){if(-not(Get-Process -Id $p.Id -ErrorAction SilentlyContinue)){break};Start-Sleep -Milliseconds 500}
if(Get-Process -Id $p.Id -ErrorAction SilentlyContinue){throw 'Updated app did not close normally for inspection'}`);
  await launch(true);
  receipt.inspectionRestart = 'Normal close after automatic window/API proof; relaunched with temporary CDP for preservation inspection.';
  await evalJS(cdp, "Updates.check(true, 'public-canary-after')");
  const after = await evalJS(cdp, 'Updates.snapshot()');
  if (after.currentVersion !== targetVersion || after.update) throw new Error('Restarted app still offers an update or reports the wrong version');
  receipt.checks.currentVersionHasNoPendingUpdate = true;
  await evalJS(cdp, "StationUI.closeTerm('updates')");
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
  if (automatic) await installFromPublicUpdater();
  else { install(candidate); await launch(true); }
  receipt.afterBuild = await evalJS(cdp, "__TAURI__.core.invoke('starnet_build_info')");
  if (receipt.afterBuild.sha !== expected || receipt.afterBuild.dirty) throw new Error('Candidate identity mismatch');
  if (receipt.beforeBuild.sha === receipt.afterBuild.sha) throw new Error('Installer did not replace the public source build');
  receipt.checks.exactCandidateInstalled = true;
  const after = await snapshot();
  receipt.afterState = continuityProjection(after);
  if (!await evalJS(cdp, "__TAURI__.core.invoke('harness_has_provider_key',{provider:'openrouter'})")) throw new Error('Synthetic key did not survive candidate install');
  receipt.expectedMigrationFields = ['local/durable.agent.systemPrompt (regenerated from preserved identity documents)', 'local/durable.agents[].personaId (missing/composed default for this fixture)'];
  const projection = stableJson(fixtureState(continuityProjection(before)));
  if (projection !== stableJson(fixtureState(continuityProjection(after)))) throw new Error('State changed across public-to-candidate reinstall');
  receipt.checks.statePreservedAcrossInstall = true;
  if (process.env.PROOF_STATIC_LEVEL === 'true') {
    await evalJS(cdp, "StationUI.openTerm('settings','appearance')");
    await sleep(250);
    receipt.staticDefault = await evalJS(cdp, "({value:document.querySelector('#set-static')?.value,multiplier:World.crt.staticLevel})");
    if (receipt.staticDefault.value !== '100' || receipt.staticDefault.multiplier !== 1) throw new Error('Historical station did not retain the default CRT appearance');
    receipt.staticLevels = [];
    for (const value of [0, 200, 45]) {
      const observed = await evalJS(cdp, `(()=>{const input=document.querySelector('#set-static');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return {value:input.value,multiplier:World.crt.staticLevel,saved:JSON.parse(localStorage.getItem('starnet.station.v1')).settings.staticLevel};})()`);
      if (observed.saved !== value || observed.multiplier !== value / 100) throw new Error('Installed static setting did not apply and save');
      receipt.staticLevels.push(observed);
    }
    await evalJS(cdp, "StationUI.closeTerm('settings')");
    receipt.checks.staticLevelAppliesAndSaves = true;
  }
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
  if (projection !== stableJson(fixtureState(receipt.restartedState))) throw new Error('State changed across candidate restart');
  if (!await evalJS(cdp, "__TAURI__.core.invoke('harness_has_provider_key',{provider:'openrouter'})")) throw new Error('Synthetic key did not survive candidate restart');
  receipt.syntheticKeyPresentAcrossInstallAndRestart = true;
  receipt.checks.statePreservedAcrossRestart = true;
  if (process.env.PROOF_STATIC_LEVEL === 'true') {
    await evalJS(cdp, "StationUI.openTerm('settings','appearance')");
    await sleep(250);
    receipt.staticRestarted = await evalJS(cdp, "({value:document.querySelector('#set-static')?.value,multiplier:World.crt.staticLevel,saved:JSON.parse(localStorage.getItem('starnet.station.v1')).settings.staticLevel})");
    if (receipt.staticRestarted.value !== '45' || receipt.staticRestarted.multiplier !== .45 || receipt.staticRestarted.saved !== 45) throw new Error('Installed static setting did not survive normal restart');
    await evalJS(cdp, "StationUI.closeTerm('settings')");
    receipt.checks.staticLevelSurvivesRestart = true;
  }
  // Run the normal installed-WebView smoke against these exact signed executable bytes.
  receipt.installedSmokeLog = execFileSync(process.execPath, ['scripts/qa/installed-smoke.mjs'], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, STARNET_SMOKE_CDP_PORT: '19373', STARNET_SMOKE_EXPECTED_HEAD: expected, STARNET_SMOKE_ARTIFACT: exe }
  });
  receipt.checks.installedSmoke = true;
  receipt.projectionSha256 = createHash('sha256').update(projection).digest('hex');
  receipt.installedExeSha256 = sha(exe);
  receipt.outcome = 'PASS';
} catch (error) { receipt.error = String(error.stack || error); }
finally { try { stop(); } finally { fs.writeFileSync('public-upgrade-continuity.json', JSON.stringify(receipt, null, 2) + '\n'); } }
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = receipt.outcome === 'PASS' ? 0 : 1;
