'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { makeWorkspaceOwner } = require('../sidecar/workspace-owner.js');
const modulePath = require.resolve('../sidecar/workspace-owner.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-election-'));
const children = [];
const childSource = `
const fs=require('node:fs'),path=require('node:path');
const {makeWorkspaceOwner}=require(process.argv[1]);
const root=process.argv[2],stage=process.argv[3];
const proxy=Object.create(fs);
if(stage==='ticket')proxy.linkSync=(...a)=>{fs.linkSync(...a);process.exit(91)};
if(stage==='pending')proxy.writeSync=(...a)=>{fs.writeSync(...a);process.exit(91)};
if(stage==='primary')proxy.linkSync=(f,to)=>{fs.linkSync(f,to);if(to.endsWith('.starnet-workspace-owner.json'))process.exit(91)};
if(stage==='readback')proxy.readFileSync=(f,...a)=>{const v=fs.readFileSync(f,...a);if(f.endsWith('.starnet-workspace-owner.json'))process.exit(91);return v};
const owner=makeWorkspaceOwner({fs:proxy,path,now:Date.now});
const go=()=>{const r=owner.acquire(root);process.stdout.write(JSON.stringify({ok:r.ok,code:r.code,pid:process.pid})+'\\n');if(r.ok){if(stage==='held')process.exit(91);setInterval(()=>{},1000)}};
if(stage==='race'){process.stdout.write('ready\\n');const t=setInterval(()=>{if(fs.existsSync(path.join(root,'go'))){clearInterval(t);go()}},5)}else go();
`;
(async () => {
  // Exact original stale-read interleaving: reentrant A must be refused while
  // B holds its generation, instead of both returning ownership.
  const interleave = path.join(sandbox, 'interleave'); fs.mkdirSync(interleave);
  const primary = path.join(interleave, '.starnet-workspace-owner.json');
  fs.writeFileSync(primary, JSON.stringify({ version: 1, pid: 101, nonce: 'dead', startedAt: 1 }));
  const deps = { fs, path, now: () => 100, pidAlive: pid => pid !== 101 };
  const a = makeWorkspaceOwner({ ...deps, pid: 201, nonce: () => 'a' });
  const proxy = Object.create(fs); let first, triggered = false;
  proxy.readFileSync = (file, ...args) => {
    const raw = fs.readFileSync(file, ...args);
    if (file === primary && !triggered) { triggered = true; first = a.acquire(interleave); }
    return raw;
  };
  const b = makeWorkspaceOwner({ ...deps, fs: proxy, pid: 202, nonce: () => 'b' });
  assert.equal(b.acquire(interleave).ok, true);
  assert.equal(first.ok, false); assert.equal(first.code, 'WORKSPACE_BUSY');
  b.release();

  for (const stage of ['pending', 'ticket', 'primary', 'readback', 'held']) {
    const root = path.join(sandbox, stage); fs.mkdirSync(root);
    const child = spawnSync(process.execPath, ['-e', childSource, modulePath, root, stage], { windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 91, stage + ': child crashed at injected boundary');
    const owner = makeWorkspaceOwner({ fs, path, now: Date.now });
    const result = owner.acquire(root);
    assert.equal(result.ok, true, stage + ': dead process recovery succeeds');
    owner.release();
  }

  const race = path.join(sandbox, 'race'); fs.mkdirSync(race);
  fs.writeFileSync(path.join(race, '.starnet-workspace-owner.json'), JSON.stringify({ version: 1, pid: 2147483647, nonce: 'stale', startedAt: 1 }));
  const records = [];
  for (let i = 0; i < 8; i++) {
    const child = spawn(process.execPath, ['-e', childSource, modulePath, race, 'race'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const row = { ready: false, result: null, buffer: '' }; records.push(row);
    child.stdout.on('data', chunk => {
      row.buffer += chunk;
      let nl;
      while ((nl = row.buffer.indexOf('\n')) >= 0) {
        const line = row.buffer.slice(0, nl); row.buffer = row.buffer.slice(nl + 1);
        if (line === 'ready') row.ready = true; else row.result = JSON.parse(line);
      }
    });
  }
  async function waitFor(check) {
    const until = Date.now() + 15000;
    while (!check()) { if (Date.now() > until) throw new Error('race child timeout'); await new Promise(r => setTimeout(r, 10)); }
  }
  await waitFor(() => records.every(row => row.ready));
  fs.writeFileSync(path.join(race, 'go'), '');
  await waitFor(() => records.every(row => row.result));
  assert.equal(records.filter(row => row.result.ok).length, 1, 'exactly one of eight simultaneous stale reclaimers owns the workspace');
  assert.ok(records.filter(row => !row.result.ok).every(row => row.result.code === 'WORKSPACE_BUSY'));
  console.log('workspace-owner-election: PASS (original interleaving, five real process crash boundaries, eight-process stale recovery)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGKILL');
  })));
  fs.rmSync(sandbox, { recursive: true, force: true });
});
