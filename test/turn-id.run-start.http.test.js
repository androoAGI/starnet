'use strict';
/* node test/turn-id.run-start.http.test.js — the lead's ONE agent.run.start names its turn (turn identity, commit 3).

   Real sidecar + real POST /api/run against a scripted mock provider. A session run that names a turnId and carries a run
   notice (the endpoint its body named was not used) dispatches one crew worker. Proves:
     1. exactly ONE agent.run.start for the lead's runId, carrying streamId, turnId, the directive row it wrote
        (directiveRowId) and the run notice in `notices` together: the turn fields join the same start the LINE WATCH merge
        builds, never a second start
     2. a forwarded worker start (another runId) never carries the lead's turnId or directive row
     3. a run that names no turnId echoes its own ('r' + runId); a malformed turnId is dropped, not echoed
     4. the run record names the turn and the directive row (runStore.noteIdentity, read by GET /api/runs) */
const A = require('./_assert.js');
const http = require('node:http');
const { once } = require('node:events');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const TurnKinds = require('../frontend/app/turnkinds.js');

const WORKER_MARK = 'TURN-ID-WORKER-MARK';
function sse(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish || 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const call = (res, id, name, args) => sse(res, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const sys = msgs.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    const results = msgs.filter(m => m && m.role === 'tool').map(m => m.tool_call_id);
    const tools = (Array.isArray(body.tools) ? body.tools : []).map(t => t && t.function && t.function.name);
    if (sys.indexOf(WORKER_MARK) >= 0) return sse(res, { content: 'Worker: the outline is ready.' });
    const lead = msgs.filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    if (/DISPATCH/.test(lead) && tools.indexOf('team_dispatch') >= 0) {
      if (tools.indexOf('brief_proceed') >= 0 && results.indexOf('bp_1') < 0) return call(res, 'bp_1', 'brief_proceed', { objective: 'have the worker outline the report', deliverable: 'an outline', assumptions: ['the worker is on the roster'] });
      if (results.indexOf('td_1') < 0) return call(res, 'td_1', 'team_dispatch', { workers: [{ agentId: 'worker-1', prompt: 'outline the report' }] });
    }
    return sse(res, { content: 'Lead: done.' });
  });
});

(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const orBase = 'http://127.0.0.1:' + mock.address().port + '/api/v1';
  const fx = SidecarFixture.create({ prefix: 'turn-id-start-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-turn-start-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-turn-start-fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const parse = t => String(t || '').split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  async function run(body) {
    const r = await fx.json('POST', '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', agentId: 'agent', isTask: true }, body));
    return { status: r.status, events: typeof r.body === 'string' ? parse(r.body) : [], text: r.text };
  }
  try {
    await fx.start();
    A.eq((await fx.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Lead', model: 'test/model', provider: 'openrouter' },
      { agentId: 'worker-1', name: 'Worker', system: WORKER_MARK + ' you are a worker.', model: 'test/model', provider: 'openrouter' }
    ] })).status, 200, 'fixture: roster saved');

    // 1 + 2. a lead with a turn, a run notice and one worker
    const T = TurnKinds.mintTurnId(() => 0.37);
    const r = await run({ streamId: 'turn-start', turnId: T, turnAt: Date.now(), clientNow: Date.now(), baseUrl: orBase + '/named', messages: [{ role: 'user', content: 'DISPATCH: have the worker outline the report' }] });
    A.eq(r.status, 200, 'fixture: the run streams');
    const starts = r.events.filter(e => e.name === 'agent.run.start');
    const leadId = (starts[0] && starts[0].payload.runId) || '';
    const leadStarts = starts.filter(e => e.payload && e.payload.runId === leadId);
    A.eq(leadStarts.length, 1, 'ONE agent.run.start for the lead');
    const p = (leadStarts[0] || {}).payload || {};
    A.eq([p.streamId, p.turnId], ['turn-start', T], 'it names the stream and the turn');
    A.ok(Number.isSafeInteger(p.directiveRowId) && p.directiveRowId > 0, 'and the directive row it wrote: ' + p.directiveRowId);
    A.ok(Array.isArray(p.notices) && p.notices.some(n => /the endpoint this run named was not used/.test(n)), 'and the run notice, in the same start: ' + JSON.stringify(p.notices));
    const workerStarts = starts.filter(e => e.payload && e.payload.runId && e.payload.runId !== leadId);
    A.ok(workerStarts.length >= 1, 'fixture: a forwarded worker start rode the lead\'s stream (' + workerStarts.length + ')');
    // (a guard: it holds on the parent too, where no start carried any turn field)
    A.ok(workerStarts.every(e => e.payload.turnId !== T && (e.payload.directiveRowId === undefined || e.payload.directiveRowId !== p.directiveRowId)), 'a forwarded worker start carries neither the lead\'s turnId nor its directive row: ' + JSON.stringify(workerStarts.map(e => [e.payload.turnId, e.payload.directiveRowId])));
    A.ok(r.events.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'td_1' && e.payload.ok), 'fixture: the dispatch ran');

    // 3. no turnId: the run's own; a malformed one is dropped
    const own = await run({ streamId: 'turn-start-2', messages: [{ role: 'user', content: 'what is on my plate' }] });
    const ownStart = (own.events.find(e => e.name === 'agent.run.start') || {}).payload || {};
    A.eq(ownStart.turnId, TurnKinds.runTurnId(ownStart.runId), 'a run that names no turn echoes its own (\'r\' + runId)');
    const bad = await run({ streamId: 'turn-start-2', turnId: 'no spaces allowed!', messages: [{ role: 'user', content: 'and tomorrow' }] });
    const badStart = (bad.events.find(e => e.name === 'agent.run.start') || {}).payload || {};
    A.eq(badStart.turnId, TurnKinds.runTurnId(badStart.runId), 'a malformed turnId is dropped: the run answers under its own id');

    // 4. the run record names the turn and the directive row
    const rows = ((await fx.json('GET', '/api/runs?agent=agent&runId=' + leadId)).body || {}).runs || [];
    const rec = rows.find(x => x.runId === leadId) || {};
    A.eq([rec.turnId, rec.directiveRowId], [T, p.directiveRowId], 'the lead\'s run record names its turn and directive row');
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    try { await fx.dispose(); } catch (_) {}
    mock.close();
  }
  A.report('turn-id.run-start.http');
})();
