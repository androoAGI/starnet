'use strict';
// Actual host admission, HTTP replay, restart and exact job cancellation. Only upstream bytes are synthetic.
const A = require('./_assert.js'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'hook-job-fixture';

(async () => {
  const calls = [], held = new Map(), receipts = [];
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = ''; req.on('data', part => { raw += part; });
    req.on('end', () => {
      const body = JSON.parse(raw), users = (body.messages || []).filter(m => m.role === 'user').map(userWords);
      const hop = users.some(text => text.startsWith('PIPELINE HANDOFF'));
      calls.push({ hop, users });
      const answer = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: hop ? 'The line is complete.' : 'The entry work is ready.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      };
      const token = !hop && /hold-[a-z]+/.exec(users.join('\n'));
      if (token) { held.set(token[0], { res, answer }); res.once('close', () => held.delete(token[0])); }
      else answer();
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-hook-jobs-', env: {
    STARNET_DEV: '1', STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_PROVIDER: 'custom', STARNET_DEFAULT_MODEL: MODEL,
    CUSTOM_OPENAI_KEY: 'hook-fixture-key', CUSTOM_OPENAI_BASE_URL: upstreamOrigin + '/v1', STARNET_MAX_ITERS: '8',
    STARNET_BUDGET_PER_DAY: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_LIVE_PRICES: '0',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0'
  } });
  const marker = path.join(fixture.workspace, 'response-fault.json'), ackMarker = path.join(fixture.workspace, 'lose-ack'), boot = path.join(fixture.workspace, 'hook-boot.cjs');
  // Inject a failure at the real response-ledger rename, after the job has been accepted. No product fault switches.
  fs.writeFileSync(boot, "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');\n"
    + "const marker=" + JSON.stringify(marker) + ";const rename=fs.renameSync;fs.renameSync=function(from,to){"
    + "if(path.basename(String(to))==='api-requests.json'&&fs.existsSync(marker)){const m=JSON.parse(fs.readFileSync(marker,'utf8'));"
    + "const id=crypto.createHash('sha256').update('trigger:'+m.triggerId+'\\n'+m.key).digest('hex');"
    + "const rows=JSON.parse(fs.readFileSync(from,'utf8'));if(rows.some(r=>r.id===id&&r.response))throw Object.assign(new Error('fixture response write refusal'),{code:'EIO'});}"
    + "return rename.apply(this,arguments);};\n"
    // Drop only the synthetic delivery's HTTP response, after triggerJson has already received its durable receipt.
    + "const Response=require('node:http').ServerResponse,end=Response.prototype.end;Response.prototype.end=function(){"
    + "if(this.statusCode===202&&this.req&&this.req.headers['idempotency-key']==='lost-ack'&&fs.existsSync(" + JSON.stringify(ackMarker) + ")){"
    + "fs.unlinkSync(" + JSON.stringify(ackMarker) + ");this.destroy();return this;}return end.apply(this,arguments);};\n"
    + "const real=globalThis.fetch;globalThis.fetch=function(url){const u=new URL(String((url&&url.url)||url));return u.origin==="
    + JSON.stringify(upstreamOrigin) + "?real.apply(this,arguments):Promise.reject(new Error('non-fixture upstream refused'));};require("
    + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ');');
  fixture.entry = boot;
  const api = async (method, route, body) => { const r = await fixture.json(method, route, body); assert.equal(r.status, 200, route + ': ' + r.text.slice(0, 300)); return r.body; };
  async function until(probe, name) {
    const deadline = Date.now() + 30000;
    for (;;) { const result = await probe(); if (result) return result; if (Date.now() >= deadline) throw new Error('timeout: ' + name + '\n' + fixture.output().slice(-2500)); await sleep(100); }
  }
  const count = token => calls.filter(call => !call.hop && call.users.join('\n').includes(token)).length;
  const job = async id => (await fixture.json('GET', '/api/line-jobs/' + id)).body.job;
  const settled = id => until(async () => { const row = await job(id); return row && !['running', 'paused'].includes(row.status) ? row : null; }, 'settled job ' + id);
  const hook = async (trigger, key, body, secret) => {
    const result = await fixture.json('POST', '/api/hooks/' + trigger.trigger.id, body,
      { headers: { 'X-StarNet-Hook-Key': secret == null ? trigger.secret : secret, 'Idempotency-Key': key } });
    receipts.push({ key, status: result.status, body: result.body });
    return result;
  };
  try {
    await fixture.start();
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const props = [{ id: 'in', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'writer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer', role: 'WRITER' },
      { id: 'editor', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'editor', role: 'EDITOR' },
      { id: 'out', t: 'outbox', x: 9, y: 0, w: 1, h: 1 }];
    const floor = floorOf({ props, belts: [1, 2, 4, 5, 7, 8].map(x => ({ x, y: 0, dir: 'E' })) }, { equip: ['computer', 'workbench'] });
    const save = await api('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
      _saveClient: 'hook-fixture', agent: { id: 'agent', name: 'Commander agent', createdAt: Date.now() }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    assert.equal(save.ok, true);
    assert.equal((await api('GET', '/api/lineage')).lineage.station.state, 'active', 'the canonical hero save founds the fixture station');
    const roster = await api('POST', '/api/roster', { updatedAt: Date.now(), agents: ['writer', 'editor'].map(agentId => ({ agentId, name: agentId, provider: 'custom', model: MODEL })) });
    assert.equal(roster.ok, true); assert.notEqual(roster.held, true, 'the fixture roster is durable, not held until founding');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.roster.json'), 'utf8')).agents.map(a => [a.agentId, a.provider, a.model]),
      [['writer', 'custom', MODEL], ['editor', 'custom', MODEL]], 'both routed provider pairs survive restart');
    const { plan, hint } = await publishFloor(fixture, floor, { label: 'the two-stage floor' });   // saved after the station is founded, then published as the page does
    const lineId = plan.lines[0].lineId;
    const trigger = await api('POST', '/api/routing/triggers', { kind: 'webhook', lineId, maxPerHour: 60, config: { task: 'Complete this work through the line.' } });
    const denied = await hook(trigger, 'auth', { token: 'never-auth' }, 'wrong-secret');
    A.eq(denied.status, 401, 'wrong hook secret cannot reserve or start work');
    A.eq(count('never-auth'), 0, 'unauthorized delivery makes no upstream call');
    const [one, two] = await Promise.all([hook(trigger, 'duplicate', { token: 'duplicate' }), hook(trigger, 'duplicate', { token: 'duplicate' })]);
    A.eq([one.status, two.status], [202, 202], 'both concurrent deliveries are accepted');
    A.ok(/^job-[a-z0-9]{8,24}$/.test(String(one.body.jobId || '')), 'acceptance names a durable LineJob');
    A.eq([one.body.jobId, one.body.durable], [two.body.jobId, true], 'both receipts name one durable job');
    A.ok(Number.isFinite(Date.parse(one.body.idempotencyExpiresAt)), 'keyed receipt names its retention boundary');
    if (!one.body.jobId) {
      await until(async () => { const r = await api('GET', '/api/routing/triggers'); const t = r.triggers.find(x => x.id === trigger.trigger.id); return t && !t.running && !t.queued; }, 'old-control duplicate fires');
      A.eq(count('duplicate'), 1, 'same keyed delivery admits one actual entry call');
      A.report('line-hook-jobs.e2e'); return;
    }
    const done = await settled(one.body.jobId);
    A.eq([done.outcome, done.runs.length, count('duplicate')], ['delivered', 2, 1], 'one actual two-stage walk backs the shared receipt');
    A.eq((await hook(trigger, 'duplicate', { token: 'changed' })).status, 409, 'changed payload conflicts before new work');
    const savedReceipt = one.body;
    await fixture.restart();
    A.eq((await hook(trigger, 'duplicate', { token: 'duplicate' })).body, savedReceipt, 'completed receipt replays identically after restart');
    A.eq(count('duplicate'), 1, 'restart replay buys no second entry');
    await api('POST', '/api/routing', hint);   // the page publishes its hint again: the restarted station still holds exactly this saved floor

    const live = await hook(trigger, 'live', { token: 'hold-live' });
    assert.equal(live.status, 202, live.text);
    await until(() => held.has('hold-live'), 'live upstream call');
    const queued = await hook(trigger, 'queued', { token: 'queued-delete' });
    assert.equal(queued.status, 202, queued.text);
    const stopQueued = await fixture.json('DELETE', '/api/line-jobs/' + queued.body.jobId);
    A.eq([stopQueued.status, stopQueued.body.job && stopQueued.body.job.outcome], [200, 'stopped'], 'DELETE durably stops the exact waiting job');
    A.eq(count('queued-delete'), 0, 'cancelled queue item buys no provider call');
    const stopLive = await fixture.json('DELETE', '/api/line-jobs/' + live.body.jobId);
    A.ok([200, 202].includes(stopLive.status) && stopLive.body.stopRequested, 'DELETE reaches the actual live owner');
    A.eq((await settled(live.body.jobId)).outcome, 'stopped', 'live job settles stopped instead of delivering');
    await until(() => !held.has('hold-live'), 'upstream abort');
    A.eq(count('hold-live'), 1, 'stopping the live job never retries it');
    A.eq((await fixture.json('DELETE', '/api/line-jobs/' + live.body.jobId)).body.stopRequested, false, 'a finished job has no fresh stop action');

    fs.writeFileSync(ackMarker, 'drop only the acceptance acknowledgement');
    let acknowledgementLost = false;
    try { await hook(trigger, 'lost-ack', { token: 'lost-ack' }); } catch (_) { acknowledgementLost = true; }
    A.ok(acknowledgementLost && !fs.existsSync(ackMarker), 'actual acceptance acknowledgement was dropped at the HTTP transport');
    const ackId = crypto.createHash('sha256').update('trigger:' + trigger.trigger.id + '\nlost-ack').digest('hex');
    const ackRow = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'api-requests.json'), 'utf8')).find(row => row.id === ackId);
    A.ok(ackRow && ackRow.response && ackRow.response.status === 202, 'acceptance was durable before the connection was destroyed');
    const ackRetry = await hook(trigger, 'lost-ack', { token: 'lost-ack' });
    A.eq([ackRetry.status, ackRetry.body.jobId], [202, ackRow && ackRow.runId], 'lost-ack retry returns the exact already-admitted job');
    await settled(ackRetry.body.jobId);
    A.eq(count('lost-ack'), 1, 'lost HTTP acknowledgement never duplicates the actual entry call');

    fs.writeFileSync(marker, JSON.stringify({ triggerId: trigger.trigger.id, key: 'lost-response' }));
    const lost = await hook(trigger, 'lost-response', { token: 'lost-response' });
    A.eq(lost.status, 503, 'post-admission response write failure is explicit');
    fs.unlinkSync(marker);
    const restored = await hook(trigger, 'lost-response', { token: 'lost-response' });
    A.eq(restored.status, 202, 'missing response is recovered from the exact admitted job');
    await settled(restored.body.jobId);
    A.eq(count('lost-response'), 1, 'failed response persistence does not duplicate the walk');

    const interrupted = await hook(trigger, 'restart-live', { token: 'hold-restart' });
    await until(() => held.has('hold-restart'), 'run before restart');
    await fixture.restart();
    const replay = await hook(trigger, 'restart-live', { token: 'hold-restart' });
    A.eq(replay.body.jobId, interrupted.body.jobId, 'restart returns the same unfinished job identity');
    A.eq((await job(replay.body.jobId)).outcome, 'interrupted', 'accepted work lost at restart is not advertised as still running');
    A.eq(count('hold-restart'), 1, 'restart never reruns interrupted paid work');
    await api('POST', '/api/routing', hint);

    const haltLive = await hook(trigger, 'halt-live', { token: 'hold-estop' });
    await until(() => held.has('hold-estop'), 'run before E-STOP');
    const haltQueued = await hook(trigger, 'halt-queued', { token: 'queued-estop' });
    await api('POST', '/api/halt', {});
    A.eq((await settled(haltLive.body.jobId)).outcome, 'stopped', 'E-STOP ends the actual live walk');
    A.eq((await settled(haltQueued.body.jobId)).outcome, 'stopped', 'E-STOP durably stops accepted waiting jobs');
    A.eq(count('queued-estop'), 0, 'E-STOP never starts a waiting job');
    A.eq((await hook(trigger, 'while-halted', { token: 'never-halted' })).status, 409, 'halted station refuses new keyed work');
    A.eq(count('never-halted'), 0, 'halt refusal buys no provider call');
    A.report('line-hook-jobs.e2e');
  } catch (error) {
    // Synthetic-only evidence survives fixture cleanup. Preserve actual request text and durable jobs so a
    // missed hold is diagnosable as routing/admission/provider behavior, not silently retried as timing noise.
    const diagnostic = { receipts, calls, held: Array.from(held.keys()) };
    for (const route of ['/api/routing/triggers', '/api/line-jobs?limit=10', '/api/lineage']) {
      try { const result = await fixture.json('GET', route); diagnostic[route] = { status: result.status, body: result.body }; }
      catch (readError) { diagnostic[route] = { error: readError.message }; }
    }
    try { diagnostic.roster = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.roster.json'), 'utf8')); }
    catch (readError) { diagnostic.roster = { error: readError.message }; }
    console.error('line-hook diagnostic ' + JSON.stringify(diagnostic));
    throw error;
  } finally {
    await fixture.dispose();
    for (const row of held.values()) row.res.destroy();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
