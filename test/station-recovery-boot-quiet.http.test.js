/* node test/station-recovery-boot-quiet.http.test.js - a restored station starts nothing by itself (#119).

   A station is built with every boot-time actor a bundle can carry: armed routines with an unsent result, a live and a
   dormant loop, folder and webhook triggers, an http connector, a Signal bot (config only, no token), a queued overseer
   report, workers owed a report, one still running, an interrupted run that can continue safely, and two rated runs
   waiting for a skill review (one inside the 72 h window, one outside it). Every endpoint those actors would reach is a
   local stub in this process: the model provider, the connector, the Signal REST endpoint and the StarNet cloud.

   1. CONTROL: the same station booted as it is (no restore) does reach the stub. Without this, silence proves nothing.
   2. RESTORE: the bundle restored and booted reaches the stub with none of those actors until a person acts.
   3. THE DOCUMENTED EXCEPTIONS (docs/DISASTER_RECOVERY.md): the interrupted run continues only through the page's own
      open-a-conversation calls, and the rating inside 72 h starts its skill review while the older one does not.

   Temp workspaces, temp profiles and a temp USERPROFILE/HOME (the fixture leaves USERPROFILE real on Windows). No real
   provider is ever named: every provider base and key in the child env points at the stub. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Recovery = require('../sidecar/station-recovery.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const loopStore = require('../sidecar/loopjob-store.js');
const LineTriggers = require('../sidecar/routing/triggers.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { makeOverseer } = require('../sidecar/overseer.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const { makeVerdictReview } = require('../sidecar/verdictreview.js');

const sleep = ms => new Promise(res => setTimeout(res, ms));
const HOUR = 60 * 60 * 1000;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-boot-quiet-home-'));
const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-boot-quiet-inbox-'));

// ---- the stub: every request is recorded with the actor it came from
const hits = [];
let phase = 'none';
function classify(url, raw) {
  if (url.startsWith('/cloud')) return 'cloud';
  if (url.startsWith('/mcp')) return 'connector';
  if (url.startsWith('/v1/') || url.startsWith('/v2/')) return 'signal';
  if (/\/models/.test(url)) return 'catalog';
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const text = JSON.stringify(body.messages || []);
  if (/background skill review/.test(text)) return 'skill-review';
  if (/automatic_recovery|read-only call had no durable result/.test(text)) return 'continuation';
  if (/Review the background work/.test(text)) return 'overseer-report';
  if (body.model === 'test/aux-model') return 'aux';
  return 'model-run';
}
const stub = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const kind = classify(req.url, raw);
  hits.push({ phase, kind, method: req.method, url: req.url.slice(0, 120), at: Date.now() });
  if (kind === 'catalog') {
    res.setHeader('Content-Type', 'application/json');
    const row = id => ({ id, context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] });
    return res.end(JSON.stringify({ data: [row('test/model'), row('test/aux-model')] }));
  }
  if (kind === 'signal') { res.setHeader('Content-Type', 'application/json'); return res.end('[]'); }
  if (kind === 'connector' || kind === 'cloud') { res.statusCode = 404; return res.end('{}'); }
  res.setHeader('Content-Type', 'text/event-stream');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ready.' } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});

// the actors a bundle can start; anything else the stub sees is reported, not hidden
const BUNDLE_ACTORS = ['overseer-report', 'signal', 'connector', 'model-run', 'continuation'];
const count = (p, kinds) => hits.filter(h => h.phase === p && (!kinds || kinds.includes(h.kind))).length;
const tally = p => hits.filter(h => h.phase === p).reduce((o, h) => { o[h.kind] = (o[h.kind] || 0) + 1; return o; }, {});

(async () => {
  await new Promise(res => stub.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + stub.address().port;
  const env = {
    SKYNET_OPENROUTER_BASE: base + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', STARNET_AUX_MODEL: 'test/aux-model',
    STARNET_CLOUD_URL: base + '/cloud', LOOP_TICK_MS: '5000', TRIGGER_POLL_MS: '500',
    USERPROFILE: home, HOME: home
  };
  const started = Date.now();
  const source = SidecarFixture.create({ prefix: 'starnet-boot-quiet-source-', env, timeoutMs: 30000 });
  const target = SidecarFixture.create({ prefix: 'starnet-boot-quiet-target-', env, timeoutMs: 30000 });
  let restored = null;
  const ws = source.workspace;
  const at = rel => path.join(ws, rel);
  try {
    // ---- 0. a station with a roster, written by the app itself
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
    seed.doc.generalId = 'general'; seed.doc.activeId = 'home';
    seed.doc.workstreams = [
      { id: 'general', agentId: 'agent', title: null, history: [], kind: 'chat', lane: 'active' },
      { id: 'home', agentId: 'agent', title: 'Launch planning', history: [], kind: 'chat', lane: 'active' }
    ];
    fs.writeFileSync(at('agent.save.json'), JSON.stringify(seed));
    phase = 'prep';
    await source.start();
    const roster = await source.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You coordinate work.' },
      { agentId: 'researcher', name: 'Researcher', role: 'Research', model: 'test/model', provider: 'openrouter', system: 'You research.' }
    ] });
    A.eq(roster.status, 200, 'the roster is saved by the app');
    await source.stop();

    // ---- 1. every boot-time actor, written by its real store writer
    const now = Date.now();
    let loops = loopStore.createLoop([], { id: 'live-loop', name: 'Live loop', objective: 'keep going', agentId: 'agent', model: 'test/model', provider: 'openrouter' }, { now });
    loops = loopStore.createLoop(loops, { id: 'dormant-loop', name: 'Dormant loop', objective: 'wake up', agentId: 'agent', model: 'test/model', provider: 'openrouter' }, { now });
    const loopEnv = loopStore.toEnvelope(loops);
    loopEnv.loops[1] = Object.assign({}, loopEnv.loops[1], { state: 'dormant' });
    fs.writeFileSync(at('loops.json'), JSON.stringify(loopEnv));

    const schedule = cron.parseSchedule('every 1h', now);
    let jobs = cronStore.createJob([], { id: 'sends', name: 'Sends', schedule, prompt: 'Report', agentId: 'agent', deliver: 'local' }, { now });
    jobs = cronStore.markRun(jobs, 'sends', { status: 'ok', runId: 'unsent-run', output: 'unsent result' }, { now });
    fs.writeFileSync(at('cron.jobs.json'), JSON.stringify(cronStore.toEnvelope(jobs)));
    fs.writeFileSync(at('cron.armed.json'), JSON.stringify({ version: 1, armed: true }));

    makeDomainStore({ fs, path, file: at('triggers.json'), version: 1, defaults: () => ({ triggers: [] }),
      normalize: value => LineTriggers.normalizeAll(value), encode: value => ({ triggers: value.triggers }),
      decode: e => (e && Array.isArray(e.triggers)) ? { triggers: e.triggers } : undefined }).save({ triggers: [
      { id: 'trg_folder0001', lineId: 'line1', kind: 'folder', name: 'Inbox', enabled: true, config: { path: inbox, task: 'x' }, createdAt: now, updatedAt: now, fires: 0, recent: [] },
      { id: 'trg_hook00001', lineId: 'line1', kind: 'webhook', name: 'Hook', enabled: true, config: { task: 'x' }, createdAt: now, updatedAt: now, fires: 0, recent: [] }] });

    fs.mkdirSync(at('connectors'), { recursive: true });
    fs.writeFileSync(at('connectors/state.json'), JSON.stringify({ version: 2,
      configs: [{ id: 'stub-mcp', name: 'Stub MCP', transport: 'http', url: base + '/mcp', enabled: true }], oauth: { byId: {}, clients: {} } }));
    fs.mkdirSync(at('channels'), { recursive: true });
    fs.writeFileSync(at('channels/secrets.json'), JSON.stringify({ signal: { enabled: true, endpoint: base, account: '+15550001',
      agentId: 'agent', provider: 'openrouter', model: 'test/model' } }));

    let serial = 0;
    const sessions = () => seed.doc;
    const overseer = makeOverseer({ fs, path, file: at('overseer.json'), now: () => now + (++serial),
      newId: () => 'thread_' + (++serial), sessions, hasAgent: id => id === 'agent' || id === 'researcher' });
    const workers = makeSubagentManager({ fs, pathMod: path, file: at('subagents.json'), clock: { now: () => now + (++serial) }, newId: () => 'worker_' + (++serial) });
    const child = overseer.create({ title: 'Research', agentId: 'researcher', parentStreamId: 'home', requestId: 'create_1' });
    const dispatch = (runner, parentRunId) => workers.start({ leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', streamId: child.id, parentRunId }, runner);
    dispatch(async () => ({ status: 'done', reason: 'done', result: 'Queued findings' }), 'lead-a');
    await sleep(20);
    overseer.collect(workers.list());
    A.eq(overseer.reviews().filter(r => r.status === 'pending').length, 1, 'a report is queued');
    dispatch(async () => ({ status: 'done', reason: 'done', result: 'Owed findings' }), 'lead-b');
    dispatch(() => new Promise(() => {}), 'lead-c');
    await sleep(20);

    const journal = makeRunJournal({ dir: at('.run-journal') });
    journal.begin({ runId: 'interrupted-run', agentId: 'agent', streamId: 'home', trigger: 'directive', model: 'test/model' });
    journal.checkpoint('interrupted-run', { phase: 'initial', turn: 0, messages: [
      { role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Summarize the launch notes.' }] });
    journal.checkpoint('interrupted-run', { phase: 'assistant', turn: 1, messages: [{
      role: 'assistant', content: '', tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'fs_read', arguments: '{"path":"notes.md"}' } }] }] });
    journal.toolIntent('interrupted-run', { callId: 'read-call', name: 'fs.read', argsRaw: '{"path":"notes.md"}', mutating: false, boundaryModel: 'prepared-dispatch-v1' });
    journal.toolDispatch('interrupted-run', { callId: 'read-call', name: 'fs.read', mutating: false });

    let clock = now - 73 * HOUR, rows = null;
    const verdicts = makeVerdictReview({ now: () => clock, ttlMs: 72 * HOUR, onChange: snap => { rows = snap; return true; } });
    const packet = text => ({ agentId: 'agent', model: 'test/model', messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Done: ' + text }] });
    verdicts.stash('old-rated-run', packet('Old work.'));
    verdicts.arm('old-rated-run', 'miss', () => new Promise(() => {}));
    clock = now - HOUR;
    verdicts.stash('fresh-rated-run', packet('Fresh work.'));
    verdicts.arm('fresh-rated-run', 'miss', () => new Promise(() => {}));
    const due = rows.find(r => r.runId === 'fresh-rated-run');
    A.ok(due && due.state === 'held', 'the fresh rating is held for its review');
    due.dueAt = now - 1000;   // its grace has passed: the next boot would start it
    fs.writeFileSync(at('verdict.packets.json'), JSON.stringify({ v: 2, rows }));

    // ---- 2. the bundle, taken before anything boots on these files
    const bundle = Recovery.capture({ workspaceRoot: ws, now, appVersion: '0.0.0-boot-quiet', omitUnavailableCredentialStores: true });
    const inBundle = rel => bundle.files.some(f => f.path === rel);
    for (const rel of ['loops.json', 'cron.jobs.json', 'triggers.json', 'connectors/state.json', 'channels/secrets.json', 'overseer.json', 'subagents.json', 'verdict.packets.json'])
      A.ok(inBundle(rel), 'the bundle carries ' + rel);
    A.ok(bundle.files.some(f => f.path.startsWith('.run-journal/')), 'the bundle carries the interrupted run');

    // ---- 3. CONTROL: the same files booted without a restore
    phase = 'control';
    await source.start();
    await sleep(15000);
    const controlLoops = await source.json('GET', '/api/loops');
    const controlOut = source.output();
    await source.stop();
    const controlCron = cronStore.getJob(cronStore.loadEnvelope(fs.readFileSync(at('cron.jobs.json'), 'utf8')).jobs, 'sends');
    console.log('control boot reached the stub: ' + JSON.stringify(tally('control')));
    console.log('control: loops armed=' + controlLoops.body.armed + ', signal started=' + /signal auto-started/.test(controlOut)
      + ', connectors warming=' + /MCP connector\(s\) warming/.test(controlOut) + ', unsent result now ' + JSON.stringify(cronStore.pendingDeliveries(controlCron).length) + ' pending');
    A.ok(count('control', BUNDLE_ACTORS) > 0, 'control: a boot of these files acts by itself (' + JSON.stringify(tally('control')) + ')');
    A.eq(controlLoops.body.armed, true, 'control: the boot arms the live loop');

    // ---- 4. RESTORE, then boot
    await target.dispose();
    const restoredRoot = target.workspace;
    const receipt = Recovery.restore({ bundle, targetRoot: restoredRoot, browserSink: {}, allowIncomplete: true, nonce: 'boot-quiet' });
    A.eq(receipt.ok, true, 'the bundle restores');
    restored = SidecarFixture.create({ prefix: 'starnet-boot-quiet-boot-', env, timeoutMs: 30000 });
    fs.rmSync(restored.workspace, { recursive: true, force: true });
    restored.workspace = restoredRoot;
    phase = 'restored';
    await restored.start();
    await sleep(15000);
    const quietLoops = await restored.json('GET', '/api/loops');
    const quietOut = restored.output();
    console.log('restored boot, before anyone acts, reached the stub: ' + JSON.stringify(tally('restored')));
    A.eq(count('restored', BUNDLE_ACTORS), 0, 'restored: nothing the bundle carries reaches the stub by itself ('
      + JSON.stringify(hits.filter(h => h.phase === 'restored' && BUNDLE_ACTORS.includes(h.kind))) + ')');
    A.eq(quietLoops.body.armed, false, 'restored: no loop timer is armed');
    A.ok(quietLoops.body.loops.every(l => l.enabled === false), 'restored: both loops read off, the dormant one too');
    A.ok(!/signal auto-started/.test(quietOut), 'restored: the Signal bot does not start');
    A.ok(!/MCP connector\(s\) warming/.test(quietOut), 'restored: no connector warms');
    const quietCron = cronStore.getJob(cronStore.loadEnvelope(fs.readFileSync(path.join(restoredRoot, 'cron.jobs.json'), 'utf8')).jobs, 'sends');
    A.ok(cronStore.deliveriesHeld(quietCron) && cronStore.pendingDeliveries(quietCron).length === 1, 'restored: the unsent result is held, not sent');
    const quietOverseer = await restored.json('GET', '/api/overseer');
    A.eq((quietOverseer.body.reviews || []).filter(r => r.status === 'pending' || r.status === 'reviewing').length, 0, 'restored: no report is queued or running');

    // ---- 5. the documented exceptions
    A.ok(/verdict-triggered review fired run=fresh-rated-run/.test(quietOut), 'exception: the rating inside 72 h starts its skill review');
    A.ok(!/verdict-triggered review fired run=old-rated-run/.test(quietOut), 'and the older rating does not');
    console.log('skill review requests at the stub: ' + count('restored', ['skill-review']) + ', aux requests: ' + count('restored', ['aux']));

    // opening the conversation: the page's own calls (chat.js recoverSafeRun, harness.js prepareAutomaticRecovery)
    phase = 'opened';
    const listed = await restored.json('GET', '/api/run-recoveries?limit=100&streamId=home&agentId=agent');
    const row = ((listed.body && listed.body.recoveries) || []).find(r => r.runId === 'interrupted-run');
    A.ok(row && row.canAutoContinue, 'the interrupted run is listed as safe to continue: ' + JSON.stringify(row || listed.body).slice(0, 300));
    const continuationId = crypto.randomUUID();
    const prepared = await restored.json('POST', '/api/run-recoveries/continue', { runId: row.runId, agentId: row.agentId,
      recoveryToken: row.recoveryToken, continuationId, mode: 'automatic' });
    A.ok(prepared.status === 200 && prepared.body.continuationToken, 'the page prepares the continuation');
    const ran = await restored.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: String(row.userTitle || 'Continue the interrupted task.') }],
      recovery: { sourceRunId: row.runId, continuationId, continuationToken: prepared.body.continuationToken } }) });
    await ran.text();
    A.eq(ran.status, 200, 'the continuation runs');
    A.ok(count('opened', ['continuation', 'model-run']) > 0, 'exception: the interrupted run continues once its conversation is opened (' + JSON.stringify(tally('opened')) + ')');
    console.log('after opening the conversation the stub saw: ' + JSON.stringify(tally('opened')));
  } finally {
    try { if (restored) await restored.dispose(); } catch (_) {}
    try { await source.dispose(); } catch (_) {}
    try { if (!target._disposed) await target.dispose(); } catch (_) {}
    stub.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(inbox, { recursive: true, force: true });
    console.log('every request the stub saw: ' + JSON.stringify(hits.map(h => [h.phase, h.kind, h.method, h.url])));
    console.log('run time ' + Math.round((Date.now() - started) / 1000) + ' s');
  }
  A.report('station-recovery-boot-quiet.http.test');
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
