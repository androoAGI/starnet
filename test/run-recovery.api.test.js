/* Real-host safe-continuation proof: crash after a deterministic mutation, review, resume through a fake
 * OpenAI-compatible provider, attempted replay, second reboot. The counter must remain exactly one and the
 * ordinary host must report its pre-dispatch recovery barrier rather than asking consent or dispatching. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { bootToken } = require('./_httpToken.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/run-recovery.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function bootSidecar(port, workspaces, attempts) {
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1', CONSENT_TIMEOUT_MS: '1000',
        LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
      }), stdio: ['ignore', 'pipe', 'pipe']
    });
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
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 10000);
  });
}

function fakeProvider(argsRaw, browserFixture) {
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
      if (browserFixture) {
        const messages = JSON.stringify(body.messages || []);
        if (/automatic_recovery|read-only call had no durable result/.test(messages)) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Automatic continuation completed from the safe durable checkpoint.' }, finish_reason: 'stop' }] }) + '\n\n');
        } else if (!/this mutating call exactly matches an operator-reviewed call/.test(messages)) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'replay-call', function: { name: 'shell_exec', arguments: argsRaw } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Reviewed continuation completed; the uncertain action was not replayed.' }, finish_reason: 'stop' }] }) + '\n\n');
        }
        return res.end('data: [DONE]\n\n');
      }
      if (requests.length === 1) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'replay-call', function: { name: 'shell_exec', arguments: argsRaw } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
      } else {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Continuation complete; reviewed replay stayed blocked.' }, finish_reason: 'stop' }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, port: server.address().port, requests })));
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-run-recovery-'));
  const browserFixture = process.env.RUN_RECOVERY_BROWSER_FIXTURE === '1';
  const agentId = browserFixture ? 'agent' : 'recovery_agent';
  const browserStream = String(process.env.RUN_RECOVERY_BROWSER_STREAM || 'ws_general');
  const recoveryStream = browserFixture ? browserStream : 'recovery-stream';
  const autoStream = browserFixture ? browserStream : 'auto-stream';
  const agentWs = path.join(ws, agentId);
  fs.mkdirSync(agentWs, { recursive: true });
  const counterPath = path.join(agentWs, 'counter.log');
  fs.writeFileSync(counterPath, 'x', 'utf8'); // the original mutating call happened exactly once before the crash
  const script = "require('fs').appendFileSync(" + JSON.stringify(counterPath) + ",'x')";
  const command = 'node -e "eval(Buffer.from(\'' + Buffer.from(script).toString('base64') + '\',\'base64\').toString())"';
  const argsRaw = JSON.stringify({ command });
  const fingerprint = Recovery.replayFingerprint('shell.exec', argsRaw);
  const journal = makeRunJournal({ dir: path.join(ws, '.run-journal') });
  journal.begin({ runId: 'crashed-run', agentId, streamId: recoveryStream, trigger: 'directive', model: 'fixture-model' });
  journal.checkpoint('crashed-run', { phase: 'initial', turn: 0, messages: [
    { role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Increment the counter exactly once, then finish.' }
  ] });
  journal.checkpoint('crashed-run', { phase: 'assistant', turn: 1, messages: [{
    role: 'assistant', content: '', tool_calls: [{ id: 'original-call', type: 'function', function: { name: 'shell_exec', arguments: argsRaw } }]
  }] });
  journal.toolIntent('crashed-run', { callId: 'original-call', name: 'shell.exec', argsRaw, replayFingerprint: fingerprint, mutating: true });
  journal.begin({ runId: 'unknown-run', agentId, streamId: 'unknown-stream', trigger: 'directive', model: 'fixture-model' });
  journal.checkpoint('unknown-run', { phase: 'assistant', turn: 1, messages: [{
    role: 'assistant', content: '', tool_calls: [{ id: 'unknown-call', type: 'function', function: { name: 'shell_exec', arguments: argsRaw } }]
  }] });
  journal.toolIntent('unknown-run', { callId: 'unknown-call', name: 'shell.exec', argsRaw, replayFingerprint: fingerprint, mutating: true });
  journal.begin({ runId: 'corrupt-run', agentId, streamId: 'corrupt-stream', trigger: 'directive', model: 'fixture-model' });
  journal.checkpoint('corrupt-run', { phase: 'assistant', turn: 1, messages: [{
    role: 'assistant', content: '', tool_calls: [{ id: 'corrupt-call', type: 'function', function: { name: 'shell_exec', arguments: argsRaw } }]
  }] });
  journal.toolIntent('corrupt-run', { callId: 'corrupt-call', name: 'shell.exec', argsRaw, replayFingerprint: fingerprint, mutating: true });
  journal.begin({ runId: 'auto-run', agentId, streamId: autoStream, trigger: 'directive', model: 'fixture-model' });
  journal.checkpoint('auto-run', { phase: 'initial', turn: 0, messages: [
    { role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Safely continue after restart.' }
  ] });
  journal.checkpoint('auto-run', { phase: 'assistant', turn: 1, messages: [{
    role: 'assistant', content: '', tool_calls: [{ id: 'auto-read-call', type: 'function', function: { name: 'fs_read', arguments: '{"path":"counter.log"}' } }]
  }] });
  journal.toolIntent('auto-run', { callId: 'auto-read-call', name: 'fs.read', argsRaw: '{"path":"counter.log"}', mutating: false, boundaryModel: 'prepared-dispatch-v1' });
  journal.toolDispatch('auto-run', { callId: 'auto-read-call', name: 'fs.read', mutating: false });
  // MID-FILE damage stays forensic-only. (A lone torn FINAL record is the ordinary crash signature and stays
  // actionable since 2026-09-22 — proven by the torn-run fixture below.)
  const corruptFile = path.join(ws, '.run-journal', crypto.createHash('sha256').update('corrupt-run').digest('hex') + '.jsonl');
  const corruptLines = fs.readFileSync(corruptFile, 'utf8').trim().split('\n');
  corruptLines.splice(corruptLines.length - 1, 0, '{mid-file-damage');
  fs.writeFileSync(corruptFile, corruptLines.join('\n') + '\n', 'utf8');
  journal.begin({ runId: 'torn-run', agentId, streamId: 'torn-stream', trigger: 'directive', model: 'fixture-model' });
  journal.checkpoint('torn-run', { phase: 'assistant', turn: 1, messages: [{
    role: 'assistant', content: '', tool_calls: [{ id: 'torn-call', type: 'function', function: { name: 'shell_exec', arguments: argsRaw } }]
  }] });
  journal.toolIntent('torn-run', { callId: 'torn-call', name: 'shell.exec', argsRaw, replayFingerprint: fingerprint, mutating: true });
  fs.appendFileSync(path.join(ws, '.run-journal', crypto.createHash('sha256').update('torn-run').digest('hex') + '.jsonl'), '{torn-tail\n', 'utf8');

  const provider = await fakeProvider(argsRaw, browserFixture);
  if (browserFixture) {
    process.env.STARNET_DEFAULT_MODEL = 'fixture-model';
    process.env.STARNET_OPENROUTER_KEY = 'fixture-key';
    process.env.STARNET_OPENROUTER_BASE = 'http://' + HOST + ':' + provider.port + '/v1';
  }
  let booted = await bootSidecar(await allocatePort(), ws, browserFixture ? 0 : 30);
  let child = booted.child, port = booted.port, apiToken = '';
  const base = () => 'http://' + HOST + ':' + port;
  async function refreshToken() { apiToken = await bootToken(base(), base()); }
  await refreshToken();
  async function request(method, route, body) {
    const headers = { 'Content-Type': 'application/json' }; if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const response = await fetch(base() + route, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch (_) { value = text; }
    return { status: response.status, body: value };
  }
  async function streamRun(body) {
    const response = await fetch(base() + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken }, body: JSON.stringify(body)
    });
    if (!response.ok) return { status: response.status, events: [], text: await response.text() };
    const events = []; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    for (;;) {
      const part = await reader.read(); if (part.done) break; buf += decoder.decode(part.value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        let event; try { event = JSON.parse(line); } catch (_) { continue; } events.push(event);
        if (event.name === 'permission.prompt') {
          const start = events.find(x => x.name === 'agent.run.start');
          if (start) await request('POST', '/api/consent', { runId: start.payload.runId, promptId: event.payload.promptId, decision: 'once' });
        }
      }
    }
    return { status: response.status, events };
  }

  try {
    if (browserFixture) {
      console.log('BROWSER_FIXTURE_URL=' + base() + '/');
      await sleep(Math.max(60000, Number(process.env.RUN_RECOVERY_BROWSER_HOLD_MS) || 300000));
      return;
    }
    const listed = await request('GET', '/api/run-recoveries');
    const bounded = await request('GET', '/api/run-recoveries?limit=100');
    A.ok(bounded.status === 200 && bounded.body.recoveries.some(x => x.runId === 'auto-run'), 'bounded COMMS recovery listing reaches the recovery handler');
    const row = listed.body.recoveries.find(x => x.runId === 'crashed-run');
    A.eq(row.status, 'needs_review', 'reboot exposes the crash between mutating intent and durable result');
    const corruptRow = listed.body.recoveries.find(x => x.runId === 'corrupt-run');
    A.ok(corruptRow.forensicOnly && !corruptRow.canResolve && !corruptRow.canContinue, 'corrupt journal is visible but remains forensic-only after prefix repair');
    A.eq(corruptRow.damage, 'corrupt', 'mid-file damage is disclosed as corrupt');
    const tornRow = listed.body.recoveries.find(x => x.runId === 'torn-run');
    A.eq([tornRow.damage, tornRow.forensicOnly, tornRow.canResolve, tornRow.status], ['torn_tail', false, true, 'needs_review'], 'a torn final record keeps its valid prefix actionable: the review can be resolved in-app');
    const tornResolved = await request('POST', '/api/run-recoveries/resolve', {
      runId: 'torn-run', agentId, recoveryToken: tornRow.recoveryToken, resolutionId: 'resolution-torn', confirmedNoReplay: true,
      outcomes: [{ callId: 'torn-call', outcome: 'did_not_happen' }]
    });
    A.eq([tornResolved.status, tornResolved.body.recovery && tornResolved.body.recovery.canContinue], [200, true], 'the torn-tail journal resolves and becomes continuable');
    const autoRow = listed.body.recoveries.find(x => x.runId === 'auto-run');
    A.ok(autoRow.canAutoContinue && autoRow.operationalState === 'recoverable', 'uncertainty-free interrupted run advertises automatic recovery');
    const autoPrepared = await request('POST', '/api/run-recoveries/continue', {
      runId: 'auto-run', agentId, recoveryToken: autoRow.recoveryToken,
      continuationId: 'automatic-fixture', mode: 'automatic'
    });
    A.eq(autoPrepared.status, 200, 'automatic-safe continuation needs no human no-replay judgment');
    A.eq(autoPrepared.body.recovery.continuation.mode, 'automatic', 'API preserves the durable automatic recovery mode');
    const unsafeAuto = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId, recoveryToken: row.recoveryToken,
      continuationId: 'automatic-unsafe', mode: 'automatic'
    });
    A.eq(unsafeAuto.status, 409, 'uncertain mutation cannot enter the automatic recovery API');
    const resolution = await request('POST', '/api/run-recoveries/resolve', {
      runId: 'crashed-run', agentId, recoveryToken: row.recoveryToken, resolutionId: 'resolution-fixture', confirmedNoReplay: true,
      outcomes: [{ callId: 'original-call', outcome: 'happened' }]
    });
    A.eq(resolution.status, 200, 'operator can durably record the verified effect');
    A.eq(resolution.body.recovery.canContinue, true, 'a complete known outcome with replay fingerprint is continuable');
    const unauthorizedContinue = await fetch(base() + '/api/run-recoveries/continue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        runId: 'crashed-run', agentId, recoveryToken: resolution.body.recovery.recoveryToken,
        continuationId: 'continuation-fixture', confirmedSafeContinuation: true
      })
    });
    A.eq(unauthorizedContinue.status, 403, 'unauthenticated continuation preparation is forbidden');
    const wrongOwner = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId: 'another_agent', recoveryToken: resolution.body.recovery.recoveryToken,
      continuationId: 'continuation-fixture', confirmedSafeContinuation: true
    });
    A.eq(wrongOwner.status, 403, 'continuation preparation cannot cross agent ownership');
    const stale = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId, recoveryToken: 'stale-token',
      continuationId: 'continuation-fixture', confirmedSafeContinuation: true
    });
    A.eq(stale.status, 409, 'continuation preparation fails closed on a stale recovery snapshot');
    const noConsent = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId, recoveryToken: resolution.body.recovery.recoveryToken, continuationId: 'continuation-fixture'
    });
    A.eq(noConsent.status, 400, 'continuation preparation requires explicit operator consent');
    const prepared = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId, recoveryToken: resolution.body.recovery.recoveryToken,
      continuationId: 'continuation-fixture', confirmedSafeContinuation: true
    });
    A.eq(prepared.status, 200, 'safe continuation is durably prepared');
    A.ok(prepared.body.canStart && prepared.body.continuationToken, 'preparation returns a one-shot start token');
    const preparedRetry = await request('POST', '/api/run-recoveries/continue', {
      runId: 'crashed-run', agentId, recoveryToken: 'now-stale', continuationId: 'continuation-fixture', confirmedSafeContinuation: true
    });
    A.eq(preparedRetry.status, 200, 'exact preparation retry is idempotent despite its old snapshot token');

    const unknownRow = listed.body.recoveries.find(x => x.runId === 'unknown-run');
    const unknownResolution = await request('POST', '/api/run-recoveries/resolve', {
      runId: 'unknown-run', agentId, recoveryToken: unknownRow.recoveryToken, resolutionId: 'resolution-unknown', confirmedNoReplay: true,
      outcomes: [{ callId: 'unknown-call', outcome: 'unknown' }]
    });
    A.eq(unknownResolution.body.recovery.canContinue, false, 'unknown operator outcome is visibly non-continuable');
    const unknownContinue = await request('POST', '/api/run-recoveries/continue', {
      runId: 'unknown-run', agentId, recoveryToken: unknownResolution.body.recovery.recoveryToken,
      continuationId: 'continuation-unknown', confirmedSafeContinuation: true
    });
    A.eq(unknownContinue.status, 409, 'unknown outcome cannot prepare a continuation in the real API');

    const runBody = {
      model: 'fixture-model', provider: 'custom', baseUrl: 'http://' + HOST + ':' + provider.port + '/v1',
      system: '', messages: [], agentId, isTask: true, streamId: recoveryStream,
      recovery: { sourceRunId: 'crashed-run', continuationId: 'continuation-fixture', continuationToken: prepared.body.continuationToken }
    };
    const continued = await streamRun(runBody);
    A.eq(continued.status, 200, 'the ordinary real run host consumes the prepared continuation');
    A.ok(continued.events.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === 'recovery-replay-blocked'), 'host dispatch blocks the reviewed mutation before registry execution');
    A.ok(!continued.events.some(e => e.name === 'permission.prompt'), 'reviewed replay is blocked before consent is requested');
    A.eq(fs.readFileSync(counterPath, 'utf8'), 'x', 'counter remains exactly one across crash, review, and resume replay attempt');
    A.eq(provider.requests.length, 2, 'provider received recovered checkpoint, then the blocked result continuation turn');
    const firstMessages = provider.requests[0].messages || [];
    A.ok(firstMessages.some(m => m.role === 'tool' && m.tool_call_id === 'original-call'), 'provider history pairs the crashed call with the explicit operator result');
    A.ok(firstMessages.some(m => /operator_resolution/.test(String(m.content || ''))), 'provider receives explicit durable operator-resolution context');

    const retry = await streamRun(runBody);
    A.eq(retry.status, 409, 'retrying a consumed continuation is refused before another run starts');
    A.eq(provider.requests.length, 2, 'a retry makes no additional provider call or side effect');

    const autoContinued = await streamRun({
      model: 'fixture-model', provider: 'custom', baseUrl: 'http://' + HOST + ':' + provider.port + '/v1',
      system: '', messages: [], agentId, isTask: true, streamId: autoStream,
      recovery: {
        sourceRunId: 'auto-run', continuationId: 'automatic-fixture',
        continuationToken: autoPrepared.body.continuationToken
      }
    });
    A.eq(autoContinued.status, 200, 'ordinary run host consumes an automatically prepared safe continuation');
    A.ok(autoContinued.events.some(e => e.name === 'agent.token' && /Continuation complete/.test(String(e.payload && e.payload.delta))), 'automatic continuation reaches a real provider completion');
    A.eq(provider.requests.length, 3, 'automatic continuation performs exactly one new provider request');
    const autoMessages = provider.requests[2].messages || [];
    A.ok(autoMessages.some(m => m.role === 'tool' && m.tool_call_id === 'auto-read-call' && /read-only call had no durable result/.test(String(m.content || ''))), 'automatic provider history pairs the interrupted read with host recovery truth');
    // A settled continuation retires its SOURCE journal (2026-09-22): the continuation's own transcript
    // acknowledgement was durable first, so the source is redundant; history keeps the one linked row.
    const afterAuto = (await request('GET', '/api/run-recoveries')).body.recoveries;
    A.ok(!afterAuto.some(x => x.runId === 'auto-run'), 'automatic continuation settles and retires its source journal');
    A.ok(!fs.existsSync(path.join(ws, '.run-journal', crypto.createHash('sha256').update('auto-run').digest('hex') + '.jsonl')), 'the settled automatic source journal file is gone');
    const autoHistory = (await request('GET', '/api/runs?agent=' + agentId + '&runId=auto-run')).body.runs || [];
    A.eq(autoHistory.map(r => [r.reason, r.recoveryStatus, r.continuedReason]), [['interrupted', 'continued', 'done']], 'run history keeps ONE row for the automatic source, linked to its finished continuation');

    try { child.kill(); } catch (_) {} await sleep(250);
    booted = await bootSidecar(await allocatePort(), ws, 30); child = booted.child; port = booted.port; await refreshToken();
    const rebooted = await request('GET', '/api/run-recoveries');
    A.ok(!rebooted.body.recoveries.some(x => x.runId === 'crashed-run'), 'second reboot: the reviewed source stays retired after its continuation settled');
    const crashedHistory = (await request('GET', '/api/runs?agent=' + agentId + '&runId=crashed-run')).body.runs || [];
    A.eq(crashedHistory.length, 1, 'second reboot: exactly one history row for the reviewed source');
    A.ok(crashedHistory[0] && crashedHistory[0].recoveryStatus === 'continued' && crashedHistory[0].continuedRunId, 'durable history links the recovered run to its continuation run');
    A.eq(fs.readFileSync(counterPath, 'utf8'), 'x', 'second reboot still proves exactly one effect');
    const durableCorrupt = rebooted.body.recoveries.find(x => x.runId === 'corrupt-run');
    A.ok(durableCorrupt.forensicOnly && !durableCorrupt.canResolve && !durableCorrupt.canContinue, 'second reboot cannot promote a repaired corrupt prefix into an in-app action');
    A.ok(!rebooted.body.recoveries.some(x => x.runId === 'auto-run'), 'second reboot: the automatic source stays retired');
    const autoAfterReboot = (await request('GET', '/api/runs?agent=' + agentId + '&runId=auto-run')).body.runs || [];
    A.eq(autoAfterReboot.map(r => r.recoveryStatus), ['continued'], 'second reboot preserves the completed automatic recovery in history');
  } finally {
    try { child.kill(); } catch (_) {} try { provider.server.close(); } catch (_) {}
    await sleep(150); try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('run-recovery.api.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
