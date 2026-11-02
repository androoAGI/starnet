/* node test/workspace-lineage.http.test.js — real host reports and recovers a selected prior station across restart. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const TOKEN = 'workspace-lineage-http-token-32bytes';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
const diesFirst = (proc, output) => new Promise((_, reject) => proc.once('close', code => reject(new Error('sidecar exited before it was up (' + code + '):\n' + output()))));   // a sidecar that dies at boot fails now, with its output, not at the limit
function waitFor(fn, ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now(); const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('sidecar boot timeout'));
      setTimeout(tick, 25);
    }; tick();
  });
}
function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timer = setTimeout(() => reject(new Error('sidecar restart timeout')), ms);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}
function station(name, updatedAt, marker) {
  return {
    version: 1, agentId: 'agent', updatedAt, savedAt: updatedAt,
    doc: {
      schema: 'starnet.save', version: 5, updatedAt,
      agent: { id: 'agent', name },
      station: { rooms: [{ id: marker }], props: [] },
      workstreams: [{ id: 'general', history: [{ role: 'user', content: marker }] }]
    }
  };
}

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lineage-http-'));
  const appData = path.join(sandbox, 'appdata');
  const current = path.join(appData, 'ai.skynet.harness', 'workspaces');
  const legacyA = path.join(appData, 'StarNet', 'workspaces');
  const legacyB = path.join(appData, 'Skynet', 'workspaces');
  fs.mkdirSync(current, { recursive: true }); fs.mkdirSync(legacyA, { recursive: true }); fs.mkdirSync(legacyB, { recursive: true });
  fs.writeFileSync(path.join(current, '.migration-receipt.json'), JSON.stringify({ version: 1, validated: true, files: [] }));
  fs.writeFileSync(path.join(legacyA, 'agent.save.json'), JSON.stringify(station('NOVA', 77, 'private-nova-marker')));
  fs.writeFileSync(path.join(legacyB, 'agent.save.json'), JSON.stringify(station('ORION', 88, 'private-orion-marker')));
  const legacyABytes = fs.readFileSync(path.join(legacyA, 'agent.save.json'));
  const legacyBBytes = fs.readFileSync(path.join(legacyB, 'agent.save.json'));
  const baseEnv = Object.assign({}, process.env, {
    LOCALAPPDATA: appData, APPDATA: appData,
    HOME: sandbox, USERPROFILE: sandbox, HOMEDRIVE: path.parse(sandbox).root.replace(/[\\\/]$/, ''), HOMEPATH: sandbox.slice(path.parse(sandbox).root.length - 1),
    SKYNET_WORKSPACES: current, SKYNET_API_TOKEN: TOKEN,
    SKYNET_LIVE_PRICES: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_CRON: '0',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
  });
  let child = null;
  async function launch() {
    const port = await freePort(); let output = '';
    child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, baseEnv, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    await Promise.race([waitFor(() => output.includes('http://127.0.0.1:' + port), 30000).catch(e => { throw new Error(e.message + ':\n' + output); }), diesFirst(child, () => output)]);
    return { child, port, output: () => output };
  }
  try {
    const first = await launch();
    const r = await fetch('http://127.0.0.1:' + first.port + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': TOKEN } });
    const body = await r.json();
    A.eq(r.status, 200, 'real save route answers');
    A.eq(body.save, null, 'active workspace is definitively empty');
    A.eq(body.lineage && body.lineage.priorInstallEvidence, true, 'host still proves a prior installation');
    A.eq(body.lineage && body.lineage.onboardingAllowed, false, 'host explicitly refuses the genesis inference');
    A.eq(body.lineage.recovery.recoverableCount, 2, 'both valid station generations are disclosed');
    A.eq(body.lineage.recovery.automaticCandidateId, null, 'real host refuses to guess between conflicting stations');
    const selected = body.lineage.recovery.candidates.find(row => row.stationName === 'ORION');
    A.ok(selected && selected.id, 'Commander can identify the desired station without exposing save contents');

    const reportRes = await fetch('http://127.0.0.1:' + first.port + '/api/lineage/report', { headers: { 'X-StarNet-Token': TOKEN } });
    const reportRaw = await reportRes.text();
    const report = JSON.parse(reportRaw);
    A.eq(reportRes.status, 200, 'redacted recovery report downloads through the real authenticated route');
    A.eq(report.schema, 'starnet.workspace-recovery-report', 'report carries the recovery-report schema');
    A.ok(reportRes.headers.get('content-disposition').includes('starnet-recovery-report.json'), 'report supplies a safe download filename');
    A.ok(!reportRaw.includes(sandbox) && !reportRaw.includes('private-orion-marker'), 'report contains neither home path nor save contents');

    const recover = await fetch('http://127.0.0.1:' + first.port + '/api/lineage/recover', {
      method: 'POST', headers: { 'X-StarNet-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: selected.id })
    });
    A.eq(recover.status, 202, 'authenticated selection is accepted for restart-time recovery');
    const exit = await waitExit(first.child, 5000);
    A.eq(exit.code, 75, 'sidecar exits with the guardian restart code after persisting the request');
    A.ok(first.output().includes('shutdown (recovery)'), 'and leaves through the graceful path: its children reaped, its browser closed');

    const second = await launch();
    const recoveredRes = await fetch('http://127.0.0.1:' + second.port + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': TOKEN } });
    const recovered = await recoveredRes.json();
    A.eq(recoveredRes.status, 200, 'restarted sidecar answers from the activated generation');
    A.eq(recovered.save && recovered.save.agent && recovered.save.agent.name, 'ORION', 'next pre-store boot activates exactly the selected station');
    A.eq(recovered.save.station.rooms[0].id, 'private-orion-marker', 'selected station data survives the complete HTTP restart path');
    A.eq(fs.readFileSync(path.join(legacyA, 'agent.save.json')).equals(legacyABytes), true, 'unselected source remains byte-exact');
    A.eq(fs.readFileSync(path.join(legacyB, 'agent.save.json')).equals(legacyBBytes), true, 'selected source remains byte-exact');
    A.ok(fs.readdirSync(path.dirname(current)).some(name => name.startsWith('workspaces.recovery-rollback-')), 'empty current generation is retained as rollback');

    // START FRESH over the real route: the recovered station's save is removed (the "manual reset" a stranded
    // user performs), leftover ledgers remain, legacy roots still exist → the gate fires with nothing chosen.
    // Start fresh takes the request and exits 75; the next boot sets the whole generation aside, acknowledges the legacy
    // roots and allows onboarding — with every legacy source byte-exact.
    try { second.child.kill('SIGKILL'); } catch (_) {}
    await waitExit(second.child, 5000);   // release the owner claim before editing the workspace
    for (const name of fs.readdirSync(current)) if (/^agent\.save\.json/.test(name)) fs.unlinkSync(path.join(current, name));
    try { fs.unlinkSync(path.join(current, '.starnet-workspace-owner.json')); } catch (_) {}
    fs.writeFileSync(path.join(current, 'ledger.jsonl'), '{"event":"leftover"}\n');
    const third = await launch();
    const gated = await (await fetch('http://127.0.0.1:' + third.port + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': TOKEN } })).json();
    A.eq(gated.save, null, 'fixture: the active save is gone again');
    A.eq(gated.lineage.priorInstallEvidence, true, 'fixture: the gate fires on leftovers + legacy roots');
    const fresh = await fetch('http://127.0.0.1:' + third.port + '/api/lineage/start-fresh', {
      method: 'POST', headers: { 'X-StarNet-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{}'
    });
    const freshBody = await fresh.json();
    A.eq(fresh.status, 202, 'START FRESH is accepted over the authenticated route');
    A.eq([freshBody.ok, freshBody.restartRequired, Number(freshBody.requestedAt) > 0], [true, true, true], 'as a request, applied by the next boot');
    const exit3 = await waitExit(third.child, 5000);
    A.eq(exit3.code, 75, 'sidecar exits with the guardian restart code after starting fresh');
    A.ok(fs.existsSync(path.join(current, 'ledger.jsonl')), 'nothing moves while the old sidecar could still hold the generation');
    const fourth = await launch();
    const after = await (await fetch('http://127.0.0.1:' + fourth.port + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': TOKEN } })).json();
    A.eq(after.lineage.priorInstallEvidence, false, 'after START FRESH the next boot finds no gating evidence');
    A.eq(after.lineage.onboardingAllowed, true, 'onboarding is allowed — the user is no longer stranded');
    A.eq(after.lineage.lastFresh && after.lineage.lastFresh.ok, true, 'and the page can read how the request ended');
    const shelf = path.join(path.dirname(current), 'workspace-quarantine');
    const asides = fs.readdirSync(shelf).filter(name => name.startsWith('station-'));
    A.eq(asides.length, 1, 'one generation was set aside');
    A.ok(fs.existsSync(path.join(shelf, asides[0], 'ledger.jsonl')), 'the leftover ledger lives on in the quarantine folder');
    A.eq(fs.existsSync(path.join(current, 'ledger.jsonl')), false, 'and is gone from the live generation');
    A.eq(fs.readFileSync(path.join(legacyA, 'agent.save.json')).equals(legacyABytes), true, 'legacy A remains byte-exact after START FRESH');
    A.eq(fs.readFileSync(path.join(legacyB, 'agent.save.json')).equals(legacyBBytes), true, 'legacy B remains byte-exact after START FRESH');
    A.report('workspace-lineage.http.test');
  } finally {
    if (child) {
      try { child.kill('SIGKILL'); } catch (_) {}
      await new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
