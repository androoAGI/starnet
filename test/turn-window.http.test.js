'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const { PageModel } = require('./helpers/page-model.js');
const UserText = require('../frontend/app/usertext.js');
const requests = [], words = m => UserText.flatten(m && m.content, UserText.OPENAI);
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'WINDOW_RESPONSE_' + requests.length }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fx = SidecarFixture.create({ prefix: 'turn-window-http-', env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const root = path.join(fx.workspace, 'transcript-history-v2'), at = Date.now(), sourceRun = 'window-recovery-source';
  const quick = Object.create(fs); quick.fsyncSync = () => {};
  const io = makeSegmentedTranscriptIo({ fs: quick, path, root, segmentBytes: 16384, schedule() {} });
  for (let n = 0; n < 1400; n++) io.appendDurable({ streamId: 'cold', agentId: 'agent', role: n % 2 ? 'assistant' : 'user',
    content: (n === 1398 ? 'LATE_CANONICAL_OWNER' : n === 1399 ? 'LATE_CANONICAL_ANSWER' : 'OLD_ROW_' + n), ts: at - 5000 + n,
    turnId: 'window_seed_' + String(Math.floor(n / 2)).padStart(6, '0'), kind: 'turn', directive: n % 2 === 0 });
  io.appendDurable({ streamId: 'recovery', agentId: 'agent', role: 'user', content: 'RECOVERY_CHECKPOINT_OWNER', ts: at - 1000,
    turnId: 'window_recovery_turn_001', sourceRunId: sourceRun, kind: 'turn', directive: true });
  io.close();
  const closed = fs.readdirSync(root).filter(name => /^segment-\d+\.jsonl$/.test(name)).sort()[0];
  const arm = path.join(fx.workspace, 'window-read-fault.arm'), bootArm = path.join(fx.workspace, 'window-boot-fault.arm'), preload = path.join(fx.profile, 'window-read-fault.cjs');
  fs.writeFileSync(preload, 'const fs=require("node:fs"),path=require("node:path"),read=fs.readFileSync,mkdir=fs.mkdirSync;let fired=false;fs.mkdirSync=function(file,...args){if(!fired&&path.resolve(String(file))===' + JSON.stringify(path.resolve(root)) + '&&fs.existsSync(' + JSON.stringify(bootArm) + ')){fired=true;throw Object.assign(Error("fixture window degraded initialization"),{code:"EIO"});}return mkdir.call(this,file,...args);};fs.readFileSync=function(file,...args){if(path.basename(String(file))===' + JSON.stringify(closed) + '&&fs.existsSync(' + JSON.stringify(arm) + ')){const e=Error("fixture closed transcript unavailable");e.code="EIO";throw e;}return read.call(this,file,...args);};\n');
  fx.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  fs.mkdirSync(path.join(fx.workspace, 'agent'), { recursive: true }); fs.writeFileSync(path.join(fx.workspace, 'agent', 'read.txt'), 'checkpoint tool result');
  const journal = makeRunJournal({ dir: path.join(fx.workspace, '.run-journal') });
  journal.begin({ runId: sourceRun, agentId: 'agent', streamId: 'recovery', turnId: 'window_recovery_turn_001', directiveTitle: 'RECOVERY_CHECKPOINT_OWNER',
    trigger: 'directive', model: 'test/model', userTitle: 'RECOVERY_CHECKPOINT_OWNER', startedAt: at - 1000 });
  journal.checkpoint(sourceRun, { phase: 'initial', turn: 0, messages: [{ role: 'user', content: 'RECOVERY_CHECKPOINT_OWNER' }] });
  journal.checkpoint(sourceRun, { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'read-window', type: 'function', function: { name: 'fs_read', arguments: '{"path":"read.txt"}' } }] }] });
  journal.toolIntent(sourceRun, { callId: 'read-window', name: 'fs.read', argsRaw: '{"path":"read.txt"}', mutating: false, boundaryModel: 'prepared-dispatch-v1' });
  journal.toolDispatch(sourceRun, { callId: 'read-window', name: 'fs.read', mutating: false });
  let serial = 0;
  async function run(text, extra) {
    const before = requests.length, now = Date.now();
    const response = await fx.json('POST', '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent',
      streamId: 'cold', turnId: 'window_http_' + String(++serial).padStart(6, '0'), turnAt: now, clientNow: now, windowTokens: 92800,
      isTask: false, messages: [{ role: 'user', content: text }] }, extra));
    const events = response.status === 200 ? String(response.text).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { response, events, requests: requests.slice(before), end: events.filter(e => e.name === 'agent.run.end' && !e.payload.parentRunId).at(-1)?.payload };
  }
  const contains = (result, text) => result.requests.some(r => r.messages.some(m => words(m).includes(text)));
  try {
    await fx.start();
    const caps = await fx.json('GET', '/api/turn-identity');
    A.eq([caps.body.v, caps.body.caps.window, caps.body.caps.windowRequired], [2, 'shadow', true], 'fresh GET advertises default required shadow window');
    const degraded = await run('DEGRADED_NEW_OWNER', { windowFrom: 'station' });
    A.eq([degraded.response.status, degraded.end?.outcome], [200, 'succeeded'], 'required newest-only request completes on vouched canonical history');
    A.ok(contains(degraded, 'LATE_CANONICAL_ANSWER') && contains(degraded, 'DEGRADED_NEW_OWNER'), 'actual provider receives late durable history and the new input');
    const normal = await run('NORMAL_POST_OWNER', { messages: [{ role: 'assistant', content: 'POSTED_COMPAT_WINDOW' }, { role: 'user', content: 'NORMAL_POST_OWNER' }] });
    A.ok(contains(normal, 'POSTED_COMPAT_WINDOW') && !contains(normal, 'LATE_CANONICAL_ANSWER'), 'shadow compares but retains a full posted window');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'id' });
    const id = await run('ID_NEW_OWNER', { messages: [{ role: 'assistant', content: 'POSTED_IGNORED_WINDOW' }, { role: 'user', content: 'ID_NEW_OWNER' }] });
    A.ok(contains(id, 'LATE_CANONICAL_ANSWER') && !contains(id, 'POSTED_IGNORED_WINDOW'), 'forced ID uses canonical history at the real provider boundary');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'legacy' });
    const legacy = await run('LEGACY_REQUIRED_OWNER', { windowFrom: 'station' });
    A.ok(legacy.end?.outcome === 'succeeded' && contains(legacy, 'LATE_CANONICAL_ANSWER'), 'mode flip to legacy retains required complete H1.2 seed');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'shadow' });
    fs.writeFileSync(arm, 'armed');
    const refused = await run('MUST_NOT_REACH_PROVIDER', { windowFrom: 'station' });
    A.eq([refused.response.status, refused.requests.length, refused.events.length], [503, 0, 0], 'unvouched newest-only request refuses before run start and provider work');
    const snapshot = await fx.json('GET', '/api/state/snapshot');
    A.eq(snapshot.body.runs.filter(r => r.streamId === 'cold').length, 0, 'required-history refusal leaves no live run');
    const compat = await run('FAULT_FULL_OWNER', { windowFrom: 'station', messages: [{ role: 'assistant', content: 'FULL_WINDOW_DURING_FAULT' }, { role: 'user', content: 'FAULT_FULL_OWNER' }] });
    A.ok(compat.end?.outcome === 'succeeded' && contains(compat, 'FULL_WINDOW_DURING_FAULT'), 'a full compatibility window can proceed through the real strict-read fault');
    const recoveries = await fx.json('GET', '/api/run-recoveries');
    const recovery = recoveries.body.recoveries.find(r => r.runId === sourceRun);
    A.ok(recovery?.canAutoContinue, 'fixture has an actual recoverable checkpoint');
    const prepared = await fx.json('POST', '/api/run-recoveries/continue', { runId: sourceRun, agentId: 'agent', recoveryToken: recovery?.recoveryToken, continuationId: 'window-cont-001', mode: 'automatic' });
    A.eq(prepared.status, 200, 'actual continuation is prepared');
    const held = new PageModel({ streamId: 'recovery', now: () => Date.now(), rng: () => 0.2, read: async () => { throw Error('page read unavailable'); } });
    held.historyLoads.set(held.ws, { promise: Promise.resolve(false), retryable: false, serverFailed: false });
    let heldError; try { await held.prepare('', { recovery: true }); } catch (error) { heldError = error; }
    A.eq(heldError?.code, 'HISTORY_UNAVAILABLE', 'actual lifted recovery wait refuses instead of using degraded caps');
    const resumed = await run('UNUSED_PAGE_RECOVERY_WORDS', { streamId: 'recovery', windowFrom: 'station', messages: [],
      recovery: { sourceRunId: sourceRun, continuationId: 'window-cont-001', continuationToken: prepared.body.continuationToken } });
    A.eq([resumed.response.status, resumed.end?.outcome], [200, 'succeeded'], 'page refusal leaves continuation consumable; recovery bypasses required-window preflight');
    A.ok(contains(resumed, 'RECOVERY_CHECKPOINT_OWNER') && !contains(resumed, 'LATE_CANONICAL_ANSWER'), 'recovery retains its own paired checkpoint rather than another window');
    fs.unlinkSync(arm);
    const after = await run('AFTER_READ_FAULT_OWNER', { windowFrom: 'station' });
    A.eq([after.response.status, after.end?.outcome], [200, 'succeeded'], 'same-agent admission and canonical reads recover after fault removal');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'id' });
    const retryId = 'window_retry_original_001', retryAt = Date.now();
    const original = await run('RETRY_ORIGINAL_OWNER', { streamId: 'retry', turnId: retryId, turnAt: retryAt, clientNow: retryAt });
    const originalStart = original.events.find(e => e.name === 'agent.run.start')?.payload;
    A.ok(originalStart?.directiveRowId > 0 && originalStart.turnId === retryId, 'retry fixture has an actual durably named original directive');
    const originalReply = original.events.filter(e => e.name === 'agent.token').map(e => e.payload.delta || '').join('');
    await run('RETRY_LATER_OWNER', { streamId: 'retry' });
    const retried = await run('RETRY_ORIGINAL_OWNER', { streamId: 'retry', turnId: retryId, retryOf: retryId, turnRowId: originalStart.directiveRowId,
      turnAt: retryAt, clientNow: Date.now(), messages: [{ role: 'user', content: 'RETRY_LATER_OWNER' }, { role: 'assistant', content: originalReply }, { role: 'user', content: 'RETRY_ORIGINAL_OWNER' }] });
    const retryStart = retried.events.find(e => e.name === 'agent.run.start')?.payload;
    A.eq([retried.end?.outcome, retryStart?.directiveRowId], ['succeeded', originalStart.directiveRowId], 'forced-ID real retry reuses the proved directive');
    A.ok(contains(retried, 'RETRY_ORIGINAL_OWNER') && !contains(retried, 'RETRY_LATER_OWNER') && !contains(retried, originalReply), 'retry canonical window cuts before the original directive and excludes the replaced/later attempt');
    await fx.stop(); fs.writeFileSync(bootArm, 'armed'); await fx.start();
    A.ok(fx.output().includes('fixture window degraded initialization'), 'the actual transcript initialization fault fired');
    const degradedBoot = await run('DEGRADED_BOOT_MUST_REFUSE', { windowFrom: 'station' });
    A.eq([degradedBoot.response.status, degradedBoot.requests.length, degradedBoot.events.length], [503, 0, 0], 'degraded initialization cannot vouch a required newest-only window');
    const degradedCompat = await run('DEGRADED_COMPAT_OWNER', { messages: [{ role: 'assistant', content: 'DEGRADED_POSTED_HISTORY' }, { role: 'user', content: 'DEGRADED_COMPAT_OWNER' }] });
    A.ok(degradedCompat.end?.outcome === 'succeeded' && contains(degradedCompat, 'DEGRADED_POSTED_HISTORY'), 'degraded initialization preserves a full posted compatibility window');
    await fx.stop(); fs.unlinkSync(bootArm); await fx.start();
    const healedBoot = await run('HEALED_BOOT_OWNER', { windowFrom: 'station' });
    A.eq([healedBoot.response.status, healedBoot.end?.outcome], [200, 'succeeded'], 'healthy restart restores required-window admission after degraded boot');
  } finally { await fx.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  A.report('turn-window.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
