'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const UserText = require('../frontend/app/usertext.js');
const requests = [], textOf = message => UserText.flatten(message && message.content, UserText.OPENAI);
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); return; }
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ATTEMPT_' + requests.length }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'turn-retract-http-', env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_MAX_CONCURRENT_AGENTS: '1'
  } });
  // Fault the actual strict transcript write before any bytes are written. No product test hook:
  // the real sidecar loads this fixture-owned fs wrapper through Node's standard preload mechanism.
  const preload = path.join(fixture.profile, 'retract-fault.cjs'), arm = path.join(fixture.workspace, 'retract-fault.arm');
  fs.writeFileSync(preload, "const fs=require('node:fs'),path=require('node:path');const write=fs.writeSync;fs.writeSync=function(fd,data,...args){if(Buffer.isBuffer(data)&&data.toString('utf8').includes('\"kind\":\"retract\"')&&fs.existsSync(path.join(process.env.STARNET_WORKSPACES,'retract-fault.arm'))){const e=new Error('fixture retract disk failure');e.code='EIO';throw e;}return write.call(this,fd,data,...args);};\n");
  fixture.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  if (process.env.TURN_RETRACT_INDEX_CONTROL) {
    fixture.entry = path.join(fixture.profile, 'saved-index.cjs');
    const filename = require.resolve('../sidecar/index.js');
    fs.writeFileSync(fixture.entry, 'const fs=require("node:fs"),Module=require("node:module"),path=require("node:path");const file=' + JSON.stringify(filename)
      + ';module.filename=file;module.paths=Module._nodeModulePaths(path.dirname(file));module._compile(fs.readFileSync(' + JSON.stringify(process.env.TURN_RETRACT_INDEX_CONTROL) + ',"utf8"),file);\n');
  }
  const T = 'http_retract_turn_001';
  function disk(stream) {
    const dir = path.join(fixture.workspace, 'transcript-history-v2'), out = [];
    for (const name of fs.readdirSync(dir).filter(name => /^segment-\d+\.jsonl$/.test(name)).sort())
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)) { const row = JSON.parse(line); if (row.streamId === stream) out.push(row); }
    return out;
  }
  async function run(stream, turnId, text, extra) {
    const before = requests.length, at = Date.now();
    const response = await fixture.json('POST', '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent',
      streamId: stream, turnId, turnAt: at, clientNow: at, isTask: false, messages: [{ role: 'user', content: text }] }, extra));
    A.eq(response.status, 200, 'actual run returns its event envelope');
    const events = String(response.body).trim().split('\n').filter(Boolean).map(JSON.parse);
    const start = (events.find(event => event.name === 'agent.run.start' && !event.payload.parentRunId) || {}).payload;
    const end = events.filter(event => event.name === 'agent.run.end' && start && event.payload.runId === start.runId).pop();
    A.ok(!!start && !!end, 'actual run has paired start and terminal identity');
    return { start, end: end && end.payload, events, calls: requests.length - before };
  }
  try {
    await fixture.start();
    A.eq((await fixture.json('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Hero', provider: 'openrouter', model: 'test/model' },
      { agentId: 'other', name: 'Other', provider: 'openrouter', model: 'test/model' }] })).status, 200, 'fixture records both admission-control agents');
    const original = await run('selectors', 'http_selector_original_001', 'SAME_SELECTOR_WORDS');
    const legacy = await run('selectors', undefined, 'SAME_SELECTOR_WORDS', { retryUserRunId: original.start.runId });
    A.eq(legacy.start.directiveRowId, original.start.directiveRowId, 'run-ID-only legacy client still reuses a server-stamped directive');
    const freshTurn = 'http_selector_new_001';
    const modern = await run('selectors', freshTurn, 'SAME_SELECTOR_WORDS', { retryOf: freshTurn, retryUserRunId: original.start.runId });
    A.ok(modern.start.directiveRowId > 0 && modern.start.directiveRowId !== original.start.directiveRowId, 'an absent modern T never borrows same-text U through its legacy runId');
    A.ok(disk('selectors').some(row => row.directive && row.turnId === modern.start.turnId && row.sourceRunId === modern.start.runId), 'the new modern attempt writes its own durable directive');
    A.eq(disk('selectors').filter(row => row.kind === 'retract').length, 0, 'unrelated modern selector never retracts the legacy-named turn');
    const latestDirective = () => disk('selectors').filter(row => row.directive).pop();
    const beforeRetryOnly = latestDirective();
    const onlyRetry = await run('selectors', undefined, 'SAME_SELECTOR_WORDS', { retryOf: 'http_selector_retry_001', retryUserRunId: beforeRetryOnly.sourceRunId });
    A.ok(onlyRetry.start.directiveRowId > 0 && onlyRetry.start.directiveRowId !== beforeRetryOnly.rowId, 'an explicit retryOf alone also prevents legacy fallback');
    const beforeTurnOnly = latestDirective();
    const onlyTurn = await run('selectors', 'http_selector_resend_001', 'SAME_SELECTOR_WORDS', { retryUserRunId: beforeTurnOnly.sourceRunId });
    A.ok(onlyTurn.start.directiveRowId > 0 && onlyTurn.start.directiveRowId !== beforeTurnOnly.rowId, 'an explicit turnId without retryOf also prevents legacy fallback');
    const first = await run('s', T, 'RETRACT_OWNER_ASK');
    A.ok(first.calls > 0, 'original run reaches the provider');
    const cached = disk('s').filter(row => row.turnId === T), oldAnswers = cached.filter(row => row.role === 'assistant').map(row => row.content);
    const conflict = await run('s', T, 'DIFFERENT_OWNER_ASK', { retryOf: T });
    A.ok(conflict.start.turnId !== T, 'conflicting retry is a new turn');
    A.eq(disk('s').filter(row => row.kind === 'retract').length, 0, 'conflicting input never retracts the original');
    const retry = await run('s', T, 'RETRACT_OWNER_ASK', { retryOf: T, turnRowId: first.start.directiveRowId });
    A.eq(retry.start.directiveRowId, first.start.directiveRowId, 'matching retry retains the one original directive');
    A.ok(retry.calls > 0, 'matching retry runs only after its strict retract');
    A.eq(disk('s').filter(row => row.kind === 'retract').map(row => row.reason), ['retry'], 'real late retry writes the typed reason');
    const request = requests.filter(body => body.messages.some(message => textOf(message).includes('RETRACT_OWNER_ASK'))).pop();
    A.ok(oldAnswers.every(answer => !request.messages.some(message => message.role === 'assistant' && textOf(message).includes(answer))), 'prior attempts are absent from actual retry provider context');
    const display = await fixture.json('GET', '/api/transcript?stream=s');
    A.ok(oldAnswers.every(answer => display.body.turns.some(row => row.content === answer)), 'Q8 keeps prior attempt narration on display');
    const undo = await fixture.json('POST', '/api/turn-identity/retract', { streamId: 's', turnId: T });
    A.eq(undo.status, 200, 'actual undo route commits the whole turn');
    await fixture.restart();
    const after = await fixture.json('GET', '/api/transcript?stream=s');
    A.ok(after.body.turns.every(row => row.turnId !== T), 'restart does not restore the undone turn');
    A.ok(after.body.turns.some(row => row.turnId === conflict.start.turnId), 'undo does not hide the conflicting new turn');
    const proof = await fixture.json('POST', '/api/turn-identity/retractions', { streamId: 's', rowIds: cached.map(row => row.rowId) });
    A.eq(proof.status, 200, 'cold endpoint proves the stale cache after restart');
    A.eq(proof.body.retracted, cached.map(row => row.rowId), 'every cached original row has affirmative undo proof');
    A.eq((await fixture.json('POST', '/api/turn-identity/retractions', { streamId: 'other', rowIds: [cached[0].rowId] })).status, 503, 'cross-stream cache authority is refused');
    A.eq((await fixture.json('POST', '/api/turn-identity/retract', { streamId: 'other', rowIds: [cached[0].rowId] })).status, 409, 'cross-stream mutation is refused');
    const F = 'http_failure_turn_001';
    const initial = await run('failure', F, 'FAILURE_OWNER_ASK'), originalFailureRows = disk('failure');
    fs.writeFileSync(arm, 'armed');
    const failed = await run('failure', F, 'FAILURE_OWNER_ASK', { retryOf: F, turnRowId: initial.start.directiveRowId });
    A.eq(failed.calls, 0, 'strict retract persistence failure makes zero provider calls');
    A.eq(failed.start.turnId, F, 'persistence failure does not rekey');
    A.eq(failed.end.failureCode, 'checkpoint_failed', 'the host settles through its existing persistence failure envelope');
    A.eq(failed.end.outcome, 'failed', 'the terminal carries the canonical typed failure');
    A.eq(failed.events.filter(event => event.name === 'agent.run.end' && event.payload.runId === failed.start.runId).length, 1, 'the failed host publishes exactly one terminal');
    A.eq(disk('failure'), originalFailureRows, 'fault before write leaves all original durable bytes unchanged');
    const snapshot = await fixture.json('GET', '/api/state/snapshot');
    A.ok(snapshot.body.runs.every(row => row.runId !== failed.start.runId), 'the actual failure exit releases its live-run registration');
    fs.unlinkSync(arm);
    const next = await run('after-failure', 'http_after_failure_001', 'AFTER_FAILURE_OWNER_ASK');
    A.ok(next.calls > 0 && next.end.reason !== 'error', 'same-agent admission succeeds after the failed retry cleanup');
    const other = await run('other-after-failure', 'http_other_after_failure_001', 'OTHER_AFTER_FAILURE_OWNER_ASK', { agentId: 'other' });
    A.ok(other.calls > 0 && other.end.reason !== 'error', 'another agent enters the one-agent gate, proving no failed-run admission count leaked');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  A.report('retract.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
