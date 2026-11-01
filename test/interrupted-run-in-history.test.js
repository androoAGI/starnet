/* node test/interrupted-run-in-history.test.js — a run killed mid-flight appears in run history (2026-09-22).

   runOnceCore records a history row only at run end, so /api/runs never listed a run whose process died. Now the
   boot scan of the run journal gives every unfinished journal whose process is gone ONE row with reason
   'interrupted' (agent, runId, start time, last turn, recovery status), and keeps that single row current as the
   run is resolved or continued. Real isolated sidecar (private temp workspace, fake provider), three boots:
     boot 1: interrupted rows for resumable / needs_review / torn-tail / forensic journals; none for a journal whose
             run already recorded its outcome or reached its transcript-acknowledged finish (that one is retired);
     boot 2: nothing is appended again (exactly one row per run, on disk and served);
             resolving a review converges the row to 'resolved'; continuing a run converges it to 'continued' with the
             continuation's runId + outcome, the continuation's own row carries recoveryOf, the source journal is gone;
     boot 3: still exactly one served row per run and no new disk lines. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootToken } = require('./_httpToken.js');
const { makeRunJournal, DISPATCH_BOUNDARY_MODEL, _internals } = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/run-recovery.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const AGENT = 'hist_agent';

function bootSidecar(port, workspaces, attempts) {
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    // ISOLATION: no inherited STARNET_/SKYNET_/HERMES_ variable may point this sidecar at a real station.
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^(STARNET_|SKYNET_|HERMES_)/i.test(k)) delete env[k];
    Object.assign(env, {
      SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1', CONSENT_TIMEOUT_MS: '1000',
      SKYNET_CLOUD_URL: '', SKYNET_CREDITS_URL: '', SKYNET_EDGE_TTS: '0', SKYNET_LIVE_PRICES: '0',
      LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
    });
    if (!path.resolve(workspaces).startsWith(path.resolve(os.tmpdir())) || port === 8787) throw new Error('refusing a non-isolated sidecar');
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.includes('http://' + HOST + ':' + port)) { settled = true; resolve({ child, port, output: () => out }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(allocatePort().then(next => bootSidecar(next, workspaces, attempts - 1)));
        else reject(new Error('no free sidecar port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 15000);
  });
}

function fakeProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'fixture-model', supported_parameters: ['tools'], context_length: 32000 }] }));
      }
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Continued and finished the summary.' }, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, port: server.address().port, requests })));
}

function seedJournals(ws) {
  const dir = path.join(ws, '.run-journal');
  let tick = 1760000000000;
  const j = makeRunJournal({ dir, clock: { now: () => (tick += 1000) } });
  const base = [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Summarize the notes.' }];
  // resumable: a dispatched READ with no result (automatic continuation is safe)
  j.begin({ runId: 'auto-int', agentId: AGENT, streamId: 'hist-auto', trigger: 'directive', model: 'fixture-model', provider: 'custom', surface: 'interactive', userTitle: 'Summarize the notes.', startedAt: 1760000000000 });
  j.checkpoint('auto-int', { phase: 'initial', turn: 0, messages: base });
  j.checkpointMessages('auto-int', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'Reading the notes.' }] });
  const readCall = { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"notes.txt"}' } }] };
  j.checkpointMessages('auto-int', { phase: 'assistant', turn: 2, messages: [{ role: 'assistant', content: 'Reading the notes.' }, readCall] });
  j.toolIntent('auto-int', { callId: 'read-1', name: 'fs.read', argsRaw: '{"path":"notes.txt"}', mutating: false, boundaryModel: DISPATCH_BOUNDARY_MODEL });
  j.toolDispatch('auto-int', { callId: 'read-1', name: 'fs.read', mutating: false });
  // needs_review: a dispatched mutation with no durable result
  const args = '{"command":"echo once"}';
  j.begin({ runId: 'review-int', agentId: AGENT, streamId: 'hist-review', trigger: 'directive', model: 'fixture-model', userTitle: 'Run the migration.', startedAt: 1760000100000 });
  j.checkpoint('review-int', { phase: 'initial', turn: 0, messages: base });
  j.checkpointMessages('review-int', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'mut-1', type: 'function', function: { name: 'shell_exec', arguments: args } }] }] });
  j.toolIntent('review-int', { callId: 'mut-1', name: 'shell.exec', argsRaw: args, replayFingerprint: Recovery.replayFingerprint('shell.exec', args), mutating: true, boundaryModel: DISPATCH_BOUNDARY_MODEL });
  j.toolDispatch('review-int', { callId: 'mut-1', name: 'shell.exec', mutating: true });
  // resumable with a torn final record (power loss mid-append)
  j.begin({ runId: 'torn-int', agentId: AGENT, streamId: 'hist-torn', trigger: 'directive', model: 'fixture-model', userTitle: 'Draft the email.', startedAt: 1760000200000 });
  j.checkpoint('torn-int', { phase: 'initial', turn: 0, messages: base });
  j.checkpointMessages('torn-int', { phase: 'assistant', turn: 3, messages: [{ role: 'assistant', content: 'Draft in progress.' }] });
  fs.appendFileSync(path.join(dir, _internals.runFileName('torn-int')), '{"v":1,"runId":"torn-int","seq":4,"ts":1,"type":"checkpoint_de', 'utf8');
  // forensic: damage in the middle of the file
  j.begin({ runId: 'forensic-int', agentId: AGENT, streamId: 'hist-forensic', trigger: 'directive', model: 'fixture-model', userTitle: 'Clean the folder.', startedAt: 1760000300000 });
  j.checkpoint('forensic-int', { phase: 'initial', turn: 0, messages: base });
  j.checkpointMessages('forensic-int', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'Looking.' }] });
  const ff = path.join(dir, _internals.runFileName('forensic-int'));
  const lines = fs.readFileSync(ff, 'utf8').trim().split('\n'); lines.splice(2, 0, '{damaged'); fs.writeFileSync(ff, lines.join('\n') + '\n', 'utf8');
  // finished with its transcript acknowledgement, crash before unlink: never "interrupted", retired at boot
  j.begin({ runId: 'finished-run', agentId: AGENT, streamId: 'hist-done', model: 'fixture-model', startedAt: 1760000400000 });
  j.finish('finished-run', { reason: 'done', transcriptAck: true });
  // outcome already recorded (crash between runStore.record and finishAndRetire): its real row stays the only row
  j.begin({ runId: 'ended-run', agentId: AGENT, streamId: 'hist-ended', model: 'fixture-model', startedAt: 1760000500000 });
  j.checkpointMessages('ended-run', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'All done.' }] });
  fs.writeFileSync(path.join(ws, 'runs.jsonl'), JSON.stringify({ runId: 'ended-run', agentId: AGENT, reason: 'done', turns: 1, tokens: 10, usd: 0.01, title: 'Ended', model: 'fixture-model', ts: 1760000501000 }) + '\n', 'utf8');
  return dir;
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-interrupted-history-'));
  fs.mkdirSync(path.join(ws, AGENT), { recursive: true });
  const journalDir = seedJournals(ws);
  const provider = await fakeProvider();
  let booted = null, child = null, port = 0, apiToken = '';
  const base = () => 'http://' + HOST + ':' + port;
  async function boot(p) {
    booted = await bootSidecar(p, ws, 30); child = booted.child; port = booted.port;
    apiToken = await bootToken(base(), base());
  }
  async function request(method, route, body) {
    const headers = { 'Content-Type': 'application/json' }; if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const response = await fetch(base() + route, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch (_) { value = text; }
    return { status: response.status, body: value };
  }
  const runs = async () => ((await request('GET', '/api/runs?agent=*&limit=200')).body.runs || []);
  async function until(fn, ms, label) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + label); await sleep(100); }
  }
  const diskLines = id => fs.readFileSync(path.join(ws, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.runId === id).length;
  const served = (rows, id) => rows.filter(r => r.runId === id);
  const IDS = ['auto-int', 'review-int', 'torn-int', 'forensic-int'];

  try {
    // ---------------- boot 1 ----------------
    await boot(await allocatePort());
    let rows = await until(async () => { const r = await runs(); return IDS.every(id => served(r, id).length) ? r : null; }, 8000, 'interrupted rows');
    const auto = served(rows, 'auto-int')[0];
    A.eq([auto.reason, auto.recoveryStatus, auto.agentId, auto.turns, auto.startedAt], ['interrupted', 'recoverable', AGENT, 2, 1760000000000], 'a resumable interrupted run is listed with agent, runId, start time, last turn and recovery status');
    A.eq([auto.title, auto.streamId, auto.model, auto.provider, auto.surface, auto.spendUnknown, auto.usd, auto.toolsOk], ['Summarize the notes.', 'hist-auto', 'fixture-model', 'custom', 'interactive', true, 0, 0], 'the row carries the journal\'s truth and marks its spend as unknown, never as free work');
    A.ok(auto.endedAt > auto.startedAt && /interrupted/.test(auto.error || ''), 'the row carries the last durable proof of life and a plain interrupted line');
    A.eq(served(rows, 'review-int')[0].recoveryStatus, 'needs_review', 'an interrupted run with an uncertain mutation is listed as needing review');
    A.eq([served(rows, 'torn-int')[0].recoveryStatus, served(rows, 'torn-int')[0].turns], ['recoverable', 3], 'a torn-tail interrupted run is listed as recoverable from its valid prefix');
    A.eq(served(rows, 'forensic-int')[0].recoveryStatus, 'forensic', 'a damaged journal is listed as forensic');
    A.eq(served(rows, 'finished-run').length, 0, 'a transcript-acknowledged finished run is never listed as interrupted');
    // The boot scan retires journals in the background, one per tick, in its own order — the interrupted rows above can
    // be served before it reaches this one. Wait (same bound) for the retirement instead of racing it.
    const finishedRetired = await until(async () => !fs.existsSync(path.join(journalDir, _internals.runFileName('finished-run'))), 8000, 'finished-run retirement').then(() => true, () => false);
    A.ok(finishedRetired, 'the boot scan finished that run\'s interrupted retirement');
    A.eq(served(rows, 'ended-run').map(r => r.reason), ['done'], 'a run whose outcome was already recorded keeps its one real row');
    const recoveries = (await request('GET', '/api/run-recoveries')).body.recoveries;
    const tornRow = recoveries.find(r => r.runId === 'torn-int');
    A.eq([tornRow.damage, tornRow.forensicOnly, tornRow.canAutoContinue], ['torn_tail', false, true], 'the torn-tail run is continuable in-app');
    try { child.kill(); } catch (_) {} await sleep(300);

    // ---------------- boot 2 ----------------
    const before = IDS.map(diskLines);
    A.eq(before, [1, 1, 1, 1], 'boot 1 appended exactly one history line per interrupted run');
    await boot(await allocatePort());
    await request('GET', '/api/run-recoveries');   // the listing also converges history (must be a no-op here)
    await sleep(400);
    rows = await runs();
    A.eq(IDS.map(id => served(rows, id).length), [1, 1, 1, 1], 'a second boot serves exactly one row per interrupted run');
    A.eq(IDS.map(diskLines), [1, 1, 1, 1], 'a second boot appends nothing (idempotent across restarts)');

    // resolve the review -> the ONE row converges to 'resolved'
    const reviewRow = (await request('GET', '/api/run-recoveries')).body.recoveries.find(r => r.runId === 'review-int');
    const resolved = await request('POST', '/api/run-recoveries/resolve', {
      runId: 'review-int', agentId: AGENT, recoveryToken: reviewRow.recoveryToken, resolutionId: 'hist-resolution-1',
      confirmedNoReplay: true, outcomes: [{ callId: 'mut-1', outcome: 'happened' }]
    });
    A.eq(resolved.status, 200, 'the operator resolves the interrupted review');
    rows = await runs();
    A.eq(served(rows, 'review-int').map(r => [r.reason, r.recoveryStatus]), [['interrupted', 'resolved']], 'history shows ONE row for the reviewed run, now resolved');

    // continue the resumable run -> source row 'continued', continuation row linked, source journal retired
    const autoRec = (await request('GET', '/api/run-recoveries')).body.recoveries.find(r => r.runId === 'auto-int');
    const prepared = await request('POST', '/api/run-recoveries/continue', { runId: 'auto-int', agentId: AGENT, recoveryToken: autoRec.recoveryToken, continuationId: 'hist-continuation-1', mode: 'automatic' });
    A.eq(prepared.status, 200, 'the interrupted run is prepared for automatic continuation');
    const response = await fetch(base() + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken },
      body: JSON.stringify({
        model: 'fixture-model', provider: 'custom', baseUrl: 'http://' + HOST + ':' + provider.port + '/v1', system: '', messages: [],
        agentId: AGENT, isTask: true, streamId: 'hist-auto',
        recovery: { sourceRunId: 'auto-int', continuationId: 'hist-continuation-1', continuationToken: prepared.body.continuationToken }
      })
    });
    const events = (await response.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const start = events.find(e => e.name === 'agent.run.start');
    const end = events.find(e => e.name === 'agent.run.end');
    A.ok(start && end && end.payload.reason === 'done', 'the continuation run completes');
    const continuedRunId = start ? start.payload.runId : '';
    rows = await until(async () => { const r = await runs(); const s = served(r, 'auto-int')[0]; return s && s.recoveryStatus === 'continued' ? r : null; }, 5000, 'continued row');
    const src = served(rows, 'auto-int');
    A.eq(src.length, 1, 'history shows ONE row for the interrupted run after its continuation');
    A.eq([src[0].reason, src[0].recoveryStatus, src[0].continuedRunId, src[0].continuedReason], ['interrupted', 'continued', continuedRunId, 'done'], 'the interrupted row now links to its continuation and that continuation\'s outcome');
    A.ok(!src[0].error, 'a continuation that finished the task clears the interrupted error line');
    const cont = served(rows, continuedRunId);
    A.eq(cont.map(r => [r.reason, r.recoveryOf]), [['done', 'auto-int']], 'the continuation\'s own row is the final outcome, linked back by recoveryOf');
    A.ok(!fs.existsSync(path.join(journalDir, _internals.runFileName('auto-int'))), 'the continued source journal is retired');
    A.ok(!(await request('GET', '/api/run-recoveries')).body.recoveries.some(r => r.runId === 'auto-int'), 'the retired source no longer appears as a recovery');
    try { child.kill(); } catch (_) {} await sleep(300);

    // ---------------- boot 3 ----------------
    const disk2 = IDS.map(diskLines);
    await boot(await allocatePort());
    await request('GET', '/api/run-recoveries');
    await sleep(400);
    rows = await runs();
    A.eq(IDS.map(id => served(rows, id).length), [1, 1, 1, 1], 'a third boot still serves exactly one row per interrupted run');
    A.eq(IDS.map(diskLines), disk2, 'a third boot appends nothing');
    A.eq(served(rows, 'auto-int')[0].recoveryStatus, 'continued', 'the settled outcome survives restart');
    A.eq(served(rows, 'review-int')[0].recoveryStatus, 'resolved', 'the resolution survives restart');
  } finally {
    try { if (child) child.kill(); } catch (_) {} try { provider.server.close(); } catch (_) {}
    await sleep(200); try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('interrupted-run-in-history.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
