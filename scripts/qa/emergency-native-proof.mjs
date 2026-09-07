#!/usr/bin/env node
// Standalone installed-WebView2 acceptance. NEVER run on an owner's workstation.
// See emergency-native-proof.md. No deployment, installer execution, or runtime source edits.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { CDP, evalJS, sleep } from '../lib/cdp.mjs';

const args = {};
if (process.argv.includes('--help')) {
  console.log('Hosted Windows only: --exe PATH --out EMPTY_DIR --expected-exe-sha256 HASH --expected-build-sha SHA [--install-dir DIR] [--workspace DIR] [--seed-workspace DIR]');
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(/^--[a-z][a-z0-9-]*$/.test(process.argv[i]) && process.argv[i + 1], 'arguments require --name value');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
assert.equal(process.platform, 'win32', 'Windows required');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Refusing an owner workstation: GitHub Actions required');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Refusing self-hosted/owner profiles: disposable GitHub-hosted VM required');
assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA, 'runner paths required');
assert.ok(args.exe && args.out && /^[0-9a-f]{64}$/i.test(args['expected-exe-sha256'] || '') && /^[0-9a-f]{40}$/i.test(args['expected-build-sha'] || ''), '--exe, --out, full --expected-exe-sha256 and full --expected-build-sha required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = fs.realpathSync(args.exe), install = fs.realpathSync(args['install-dir'] || path.dirname(exe));
const out = path.resolve(args.out), runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
const within = (child, parent) => { const rel = path.relative(parent, child); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
assert.ok(within(exe, install), 'exe must be inside install-dir');
assert.ok(within(out, runnerTemp), 'output must be a new directory under RUNNER_TEMP');
assert.ok(!fs.existsSync(out), 'refusing to overwrite an existing receipt directory');
const workspace = path.resolve(args.workspace || path.join(process.env.APPDATA, 'ai.skynet.harness/workspaces'));
assert.equal(workspace.toLowerCase(), path.resolve(process.env.APPDATA, 'ai.skynet.harness/workspaces').toLowerCase(), 'workspace must be the native shell app-data workspace');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exeHash = hash(fs.readFileSync(exe));
assert.equal(exeHash, args['expected-exe-sha256'].toLowerCase(), 'installer executable identity mismatch');
const scriptHash = hash(fs.readFileSync(path.join(install, 'frontend/app/emergency-control.js')));
fs.mkdirSync(out, { recursive: true });
assert.ok(within(fs.realpathSync(out), runnerTemp), 'output junction escaped RUNNER_TEMP');
// Only initialize a completely empty disposable station; never overwrite an existing save.
if (!fs.existsSync(path.join(workspace, 'agent.save.json'))) {
  assert.ok(!fs.existsSync(workspace) || fs.readdirSync(workspace).length === 0, 'existing nonempty station requires prior T0 onboarding');
  const seed = fs.realpathSync(args['seed-workspace'] || path.join(root, 'dev/fixtures/seed-workspace'));
  fs.mkdirSync(workspace, { recursive: true });
  for (const name of ['agent.save.json', 'agent.roster.json']) fs.copyFileSync(path.join(seed, name), path.join(workspace, name), fs.constants.COPYFILE_EXCL);
}

const receipt = { schema: 'starnet.emergency-native-proof.v1', result: 'FAIL', startedAt: new Date().toISOString(), executable: { path: exe, sha256: exeHash }, scriptSha256: scriptHash, phases: [], note: 'Disposable hosted VM; real installed EXE/CDP/API/disk. No model-execution or customer-recovery claim.' };
const network = [];
const trace = entry => { const row = { at: new Date().toISOString(), phase, ...entry }; network.push(row); fs.appendFileSync(path.join(out, 'network.jsonl'), JSON.stringify(row) + '\n'); };
let phase = 'setup', child, cdp, launches = 0;
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(250); }
  throw new Error('Timed out: ' + label);
}
async function port() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
}
async function stopOwned() {
  if (cdp) { cdp.ws.close(); cdp = null; }
  if (child && child.exitCode === null && child.signalCode === null) {
    // Own PID and its descendants only. A forced restart avoids the app's intentional Quit/E-STOP path.
    spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned executable exit', 15000);
  }
  child = null;
}
async function launch() {
  const debugPort = await port(); ++launches;
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(SKYNET|STARNET)_/.test(name)) delete env[name];
  // Nonfunctional fixture credential only; no real provider keys or model calls are needed.
  Object.assign(env, { SKYNET_OPENROUTER_KEY: 'sk-or-v1-native-proof-not-a-real-key', SKYNET_DEFAULT_MODEL: 'anthropic/claude-haiku-4.5', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort, WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview-profile') });
  child = spawn(exe, [], { cwd: install, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', e => fs.appendFileSync(path.join(out, 'process.log'), String(e) + '\n'));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => fs.appendFileSync(path.join(out, 'process.log'), d));
  const target = await until(async () => {
    assert.equal(child.exitCode, null, 'new executable exited (close any prior T0 app before running)');
    try {
      const r = await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(1000) });
      return (await r.json()).find(t => t.type === 'page' && /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|app:\/\/localhost)(\/|$)/.test(t.url));
    } catch (_) { return null; }
  }, 'owned native WebView2 target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  cdp = new CDP(ws);
  const requests = new Set(), scripts = [];
  cdp.on('Network.requestWillBeSent', p => {
    const route = new URL(p.request.url).pathname;
    if (route === '/api/halt' || route === '/api/halt/resume') {
      requests.add(p.requestId);
      trace({ kind: 'request', id: p.requestId, method: p.request.method, path: route, body: p.request.postData || null });
    }
  });
  cdp.on('Network.responseReceived', p => { if (requests.has(p.requestId)) trace({ kind: 'response', id: p.requestId, status: p.response.status }); });
  cdp.on('Network.loadingFinished', p => {
    if (requests.has(p.requestId)) cdp.send('Network.getResponseBody', { requestId: p.requestId }).then(r => trace({ kind: 'body', id: p.requestId, body: JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body) })).catch(e => trace({ kind: 'body-error', id: p.requestId, error: String(e) }));
  });
  cdp.on('Debugger.scriptParsed', p => { if (/\/emergency-control\.js(?:\?|$)/.test(p.url)) scripts.push(p); });
  await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Debugger.enable');
  const loaded = await until(() => scripts[0], 'embedded recovery script executed');
  const source = await cdp.send('Debugger.getScriptSource', { scriptId: loaded.scriptId });
  assert.equal(hash(source.scriptSource), scriptHash, 'WebView2 executed stale/different frontend bytes');
  const native = await evalJS(cdp, 'window.__TAURI__.core.invoke("starnet_build_info")');
  assert.equal(native.executableSha256, exeHash, 'attached to wrong executable');
  if (args['expected-build-sha']) assert.equal(native.sha, args['expected-build-sha'], 'native source SHA mismatch');
  receipt.nativeBuild = native;
  receipt.phases.push({ phase: 'launch-' + launches, origin: new URL(target.url).origin, scriptUrl: loaded.url, scriptSha256: hash(source.scriptSource) });
  await until(() => evalJS(cdp, '!!document.querySelector("#screen-game.active")'), 'seeded native station entered; T0 may need to onboard it first');
}
async function api(route, body) {
  const r = await evalJS(cdp, `(async()=>{const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(body === undefined ? 'GET' : 'POST')},cache:'no-store',headers:{'Content-Type':'application/json','X-StarNet-Token':window.__STARNET_API_TOKEN__},${body === undefined ? '' : 'body:' + JSON.stringify(JSON.stringify(body)) + ','}});return {status:r.status,data:await r.json()};})()`);
  assert.equal(r.status, 200, route + ' failed: ' + JSON.stringify(r.data));
  return r.data;
}
async function click(selector) {
  const p = await evalJS(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.hidden)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
  assert.ok(p, 'control is not visible/enabled: ' + selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
}
async function proveClick(start, route) {
  await until(() => {
    const req = network.slice(start).find(e => e.kind === 'request' && e.method === 'POST' && e.path === route);
    return req && network.some(e => e.id === req.id && e.kind === 'response' && e.status === 200)
      && network.some(e => e.id === req.id && e.kind === 'body');
  }, 'actual button request/response body: ' + route);
}
const read = name => { const f = path.join(workspace, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function protectedState() {
  const names = ['permissions.allow.json', 'permissions.bypass.json', 'cron.armed.json', ...fs.readdirSync(workspace).filter(n => n.endsWith('.workshop.json'))].sort();
  const result = Object.fromEntries(names.map(n => [n, read(n)]));
  result.posture = read('_commander.autonomy.json')?.posture;
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
  result.routines = (read('cron.jobs.json')?.jobs || []).map(j => pick(j, ['id', 'name', 'prompt', 'schedule', 'enabled', 'agentId', 'provider', 'model', 'workdir']));
  result.loops = (read('loops.json')?.loops || []).map(j => pick(j, ['id', 'name', 'objective', 'enabled', 'state', 'agentId', 'provider', 'model', 'gate', 'queueCap', 'workdir', 'perDayUsd', 'perIterationUsd']));
  return canonical(result);
}
async function check(label, halted, baseline) {
  phase = label;
  const state = await until(async () => {
    const s = await api('/api/halt');
    return ['cron', 'nightshift', 'loops'].every(k => s.subsystems[k].halted === halted) && s;
  }, label + ' API halt flags');
  const disk = { cron: read('cron.halt.json')?.halted, nightshift: (read('nightshift.state.json')?.haltedAt || 0) > 0, loops: read('loops.halt.json')?.halted };
  assert.deepEqual(Object.values(disk), [halted, halted, halted], label + ' persisted halt flags');
  if (baseline) assert.equal(protectedState(), baseline, label + ' changed posture, grants, arm intent or job settings');
  const startup = path.join(path.dirname(workspace), 'startup.log');
  assert.ok(fs.existsSync(startup) && fs.readFileSync(startup, 'utf8').toLowerCase().includes('workspaces=' + workspace.toLowerCase()), 'native startup did not prove the inspected workspace');
  fs.copyFileSync(startup, path.join(out, 'startup-' + label + '.log'));
  receipt.phases.push({ phase: label, state, persisted: disk, protectedSha256: hash(protectedState()) });
}
try {
  await launch();
  // Seed nonempty, individually paused jobs behind a real halt; no provider execution occurs.
  await api('/api/halt', {});
  const routine = await api('/api/cron', { name: 'Native recovery proof', prompt: 'Fixture only', schedule: '0 0 1 1 *', agentId: 'agent' });
  await api('/api/cron/update', { id: routine.job.id, patch: { enabled: false } });
  const loop = await api('/api/loops', { name: 'Native recovery proof', objective: 'Fixture only', agentId: 'agent', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' });
  await api('/api/loops/control', { id: loop.loop.id, action: 'pause' });
  await api('/api/cron/arm', { enabled: true });
  await api('/api/halt/resume', { confirm: true });
  await until(() => evalJS(cdp, 'document.querySelector("#automation-stop-toggle b")?.textContent === "STOP AUTOMATION"'), 'initial Stop label');
  const baseline = protectedState();
  await check('baseline', false, baseline);
  phase = 'stop-click';
  const stopTrace = network.length;
  await click('.bb-group[data-group="system"] .bb-grp');
  await click('#automation-stop-toggle');
  await check('stopped', true, baseline);
  await proveClick(stopTrace, '/api/halt');
  await stopOwned(); await launch();
  await check('restarted-stopped', true, baseline);
  await until(() => evalJS(cdp, 'document.querySelector("#automation-resume")?.textContent === "RESUME AUTOMATION" && !document.querySelector("#automation-resume").hidden'), 'native Resume control after restart');
  phase = 'resume-click';
  const resumeTrace = network.length;
  await click('#automation-resume');
  await check('resumed', false, baseline);
  await proveClick(resumeTrace, '/api/halt/resume');
  await stopOwned(); await launch();
  await check('restarted-resumed', false, baseline);
  receipt.result = 'PASS';
} catch (e) { receipt.error = String(e.stack || e); process.exitCode = 1; }
finally {
  if (cdp) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'native-final.png'), Buffer.from(shot.data, 'base64'));
      fs.writeFileSync(path.join(out, 'native-final-dom.txt'), await evalJS(cdp, 'document.body.innerText'));
    } catch (e) { receipt.captureError = String(e); }
  }
  await stopOwned().catch(e => { receipt.result = 'FAIL'; receipt.cleanupError = String(e); process.exitCode = 1; });
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(receipt.result + ' installed emergency recovery: ' + path.join(out, 'receipt.json'));
}
