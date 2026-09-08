'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bridge = require('../frontend/world-next/bridge.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const copy = v => JSON.parse(JSON.stringify(v));
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const event = (name, extra = {}) => ({ name, payload: { agentId: 'agent', runId: 'lead', ...extra } });
function fixture(options = {}) {
  let document = { schema: 'starnet.save', version: 5, updatedAt: 1, agent: { id: 'agent', name: 'NOVA', docs: { identity: 'Saved identity' } },
    station: WorldModel.defaultDoc(), agents: [], workstreams: [{ id: 'kept', history: ['real previous work'] }],
    stationStats: { ratingSyncAt: 123 }, extension: { future: 'must survive' }, prov: 'openrouter' };
  const calls = [], sources = [];
  let live = { runs: [], prompts: [], summons: [], queues: [] };
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; }
    push(value, id = '') { if (this.onmessage) this.onmessage({ data: JSON.stringify(value), lastEventId: id }); }
  }
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const path = new URL(url).pathname;
    if (options.override) { const value = await options.override(path, init); if (value) return value; }
    if (path === '/api/runtime/agent') return reply({ ok: true, model: 'world-proof', provider: 'openrouter', configured: true,
      agents: [{ agentId: 'agent', name: 'NOVA', model: 'world-proof', provider: 'openrouter' }] });
    if (path === '/api/save' && init.method === 'GET') return reply({ save: copy(document), degraded: options.degraded || undefined });
    if (path === '/api/save') { document = JSON.parse(init.body); return reply({ ok: true, updatedAt: document.updatedAt }); }
    if (path === '/api/toolsets') return reply({ authority: { profile: 'trusted-project' }, toolsets: [{ id: 'files', available: false }] });
    if (path === '/api/state/snapshot') return reply(copy(live));
    if (path === '/api/cancel') return new Response('ok');
    if (path === '/api/routing') return reply({ ok: true });
    if (path.startsWith('/api/consent')) return reply({ ok: true });
    throw new Error('Unexpected request ' + url);
  };
  const bridge = new Bridge({ token: 'test-launch-token', fetch, EventSource: Source, WorldModel: options.WorldModel || WorldModel, Pipeline,
    pageUrl: 'http://127.0.0.1:8795/world-next/index.html', clock: () => 1000 });
  return { bridge, calls, sources, get document() { return document; }, changeDoc: fn => fn(document), setLive: data => { live = data; } };
}
function stream(events, options = {}) {
  const data = Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + (options.noFinalNewline ? '' : '\n'));
  return new Response(new ReadableStream({ start(controller) {
    // Byte-by-byte delivery exercises boundaries inside JSON, newlines, and multibyte Unicode.
    for (let i = 0; i < data.length; i++) controller.enqueue(data.subarray(i, i + 1));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('bootstrap uses root API routes, scoped auth, SSE query, and isolated snapshots', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  let seen; f.bridge.subscribe(s => { seen = s; });
  assert.equal(seen.connection.status, 'idle');
  await f.bridge.start();
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].url, 'http://127.0.0.1:8795/api/channels/events?token=test-launch-token');
  for (const c of f.calls) { assert.equal(c.headers['X-StarNet-Token'], 'test-launch-token'); assert.equal(c.redirect, 'error'); }
  assert.equal(f.bridge.snapshot().capabilities.agent.status, 'loaded');
  seen.station.order.push('bad'); assert.ok(!f.bridge.snapshot().station.order.includes('bad'));
  assert.ok(!JSON.stringify(f.bridge.snapshot()).includes('test-launch-token'));
});
test('missing bootstrap fails truthfully and cross-origin token exfiltration is rejected', async () => {
  const b = new Bridge({ fetch: () => { throw new Error('must not fetch'); } });
  await assert.rejects(b.start(), /authentication bootstrap/);
  assert.equal(b.snapshot().connection.status, 'error'); b.dispose();
  assert.throws(() => new Bridge({ pageUrl: 'http://localhost/', baseUrl: 'https://untrusted.example', token: 'secret' }), /loopback/);
});
test('save preserves newest non-station fields and verifies accepted write', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); await f.bridge.start();
  f.changeDoc(doc => { doc.extension.newField = true; doc.workstreams.push({ id: 'new-thread' }); doc.updatedAt = 9999; });
  const next = f.bridge.snapshot().station; next.meta.name = 'Fresh station';
  const receipt = await f.bridge.saveStation(next);
  assert.equal(receipt.ok, true); assert.equal(f.document.updatedAt, 10000);
  assert.equal(f.document.extension.newField, true); assert.equal(f.document.workstreams.length, 2);
  assert.equal(f.document.stationStats.ratingSyncAt, 123); assert.equal(f.document.schema, 'starnet.save');
  assert.equal(f.document.doc, undefined); assert.equal(f.bridge.snapshot().save.status, 'saved');
  assert.equal(receipt.stationSaved, true); assert.equal(receipt.routingSaved, true);
  const saveIndex = f.calls.findIndex(c => new URL(c.url).pathname === '/api/save' && c.method === 'POST');
  const routingIndex = f.calls.findIndex(c => new URL(c.url).pathname === '/api/routing');
  assert.ok(routingIndex > saveIndex + 1, 'routing follows the save readback');
  assert.deepEqual(JSON.parse(f.calls[routingIndex].body), Pipeline.compileRoutingPlan(WorldModel.deserialize(next).projectGeometry()));
});
test('routing refusal is a partial success with station saved and exact server refusal retained', async t => {
  const f = fixture({ override: path => path === '/api/routing' ? reply({ ok: false, error: 'unwired source', caps: true }, 422) : null });
  t.after(() => f.bridge.dispose()); await f.bridge.start();
  const next = f.bridge.snapshot().station; next.meta.name = 'saved locally';
  const receipt = await f.bridge.saveStation(next);
  assert.equal(receipt.ok, false); assert.equal(receipt.stationSaved, true); assert.equal(receipt.routingError, 'unwired source');
  assert.equal(f.document.station.meta.name, 'saved locally'); assert.equal(f.bridge.snapshot().save.status, 'partial');
  assert.equal(f.bridge.snapshot().routing.receipt.caps, true);
});
test('public JSON requests cannot escape API origin or replace authentication', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  await f.bridge.request('/api/consent/answer', { method: 'POST', body: JSON.stringify({ answer: 'yes' }), headers: { 'X-StarNet-Token': 'bad' } });
  assert.equal(f.calls[0].headers['X-StarNet-Token'], 'test-launch-token');
  assert.deepEqual(JSON.parse(f.calls[0].body), { answer: 'yes' });
  await assert.rejects(f.bridge.request('https://example.com/api/save'), /sidecar/);
  await assert.rejects(f.bridge.request('/api/../../secret'), /sidecar/);
  await assert.rejects(f.bridge.request('/api/save', { method: 'GET', body: {} }), /GET/);
});
test('conflicting station edit never posts a save', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); await f.bridge.start();
  const next = f.bridge.snapshot().station; next.meta.name = 'mine';
  f.changeDoc(doc => { doc.station.meta.name = 'someone else'; });
  await assert.rejects(f.bridge.saveStation(next), /another client/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('stale and degraded server receipts never report saved', async t => {
  for (const degraded of [false, true]) {
    const f = fixture({ degraded, override: (path, init) => path === '/api/save' && init.method === 'POST' ? reply({ ok: false, stale: true }) : null });
    t.after(() => f.bridge.dispose()); await f.bridge.start();
    await assert.rejects(f.bridge.saveStation(f.bridge.snapshot().station), degraded ? /read-only/ : /stale/);
    assert.equal(f.bridge.snapshot().save.status, 'error');
  }
});
test('serialized saves use accepted baseline and caller mutation cannot alter pending write', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); await f.bridge.start();
  const first = f.bridge.snapshot().station, second = copy(first); first.meta.name = 'first'; second.meta.name = 'second';
  const a = f.bridge.saveStation(first), b = f.bridge.saveStation(second); second.meta.name = 'mutated';
  await Promise.all([a, b]); assert.equal(f.document.station.meta.name, 'second');
});
test('NDJSON handles Unicode, child runs, tool narration, terminal partial line and next-turn history', async t => {
  let count = 0;
  const f = fixture({ override: path => path === '/api/run' ? stream(count++ ? [
    event('agent.run.start'), event('agent.token', { delta: 'Followup' }), event('agent.run.end', { reason: 'done' })
  ] : [event('agent.run.start'), event('agent.token', { delta: 'I will write.' }), event('agent.tool_call', { callId: 'call', name: 'fs.write' }),
    event('agent.run.start', { runId: 'child', agentId: 'worker' }), event('agent.token', { runId: 'child', agentId: 'worker', delta: 'irrelevant' }),
    event('agent.run.end', { runId: 'child', agentId: 'worker', reason: 'done' }), event('agent.token', { delta: 'Saved café 🌱.' }),
    event('agent.run.end', { reason: 'done' })], { noFinalNewline: true }) : null });
  t.after(() => f.bridge.dispose()); await f.bridge.start();
  const result = await f.bridge.send('agent', 'Run the world proof');
  assert.deepEqual(result, { runId: 'lead', text: 'Saved café 🌱.', reason: 'done' });
  assert.equal(f.bridge.snapshot().conversations.agent.status, 'complete');
  await f.bridge.send('agent', 'Continue');
  const bodies = f.calls.filter(c => new URL(c.url).pathname === '/api/run').map(c => JSON.parse(c.body));
  assert.deepEqual(bodies[1].messages.map(m => m.content), ['Run the world proof', 'Saved café 🌱.', 'Continue']);
  assert.equal(bodies[0].system, 'Saved identity'); assert.equal(bodies[0].key, undefined);
  assert.equal(bodies[0].streamId, bodies[1].streamId);
});
test('unconfirmed EOF is error/unknown, never completion', async t => {
  const f = fixture({ override: path => path === '/api/run' ? stream([event('agent.run.start'), event('agent.token', { delta: 'partial' })]) : null });
  t.after(() => f.bridge.dispose()); await f.bridge.start();
  await assert.rejects(f.bridge.send('agent', 'Do work'), /confirmed outcome/);
  const s = f.bridge.snapshot(); assert.equal(s.conversations.agent.status, 'error'); assert.equal(s.runs[0].status, 'unknown');
});
test('malformed stream and unverified save are surfaced as errors', async t => {
  let written = false;
  const f = fixture({ override: (path, init) => {
    if (path === '/api/run') return new Response('{not json}\n');
    if (path === '/api/save' && init.method === 'POST') { written = true; return reply({ ok: true }); }
    return null;
  } });
  t.after(() => f.bridge.dispose()); await f.bridge.start();
  await assert.rejects(f.bridge.send('agent', 'Do work'), /Invalid run event/);
  const doc = f.bridge.snapshot().station; doc.meta.name = 'never persisted';
  await assert.rejects(f.bridge.saveStation(doc), /could not be verified/);
  assert.equal(written, true); assert.equal(f.bridge.snapshot().save.status, 'error');
});
test('save ownership mismatch cannot redirect a write to another agent', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); await f.bridge.start();
  f.changeDoc(doc => { doc.agentId = 'other-agent'; });
  await assert.rejects(f.bridge.saveStation(f.bridge.snapshot().station), /valid saved agent/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('SSE duplicates, disconnect, snapshot reconciliation and cancellation stay truthful', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); await f.bridge.start();
  const source = f.sources[0]; source.push(event('agent.run.start'), 'epoch:1'); source.push(event('agent.run.start'), 'epoch:1');
  assert.equal(f.bridge.snapshot().events.length, 1); assert.equal(f.bridge.snapshot().runs[0].status, 'working');
  await f.bridge.stopRun('lead'); assert.equal(f.bridge.snapshot().runs[0].status, 'working');
  assert.equal(f.bridge.snapshot().runs[0].cancelRequested, true);
  source.onerror(); assert.equal(f.bridge.snapshot().runs[0].status, 'unknown');
  await f.bridge._reconcile(); const r = f.bridge.snapshot().runs[0]; assert.equal(r.status, 'ended'); assert.equal(r.reason, 'outcome-unavailable');
});
test('empty assigned bay does not widen capabilities station-wide', async t => {
  const model = { deserialize: doc => ({ doc: () => ({ props: [{ t: 'files' }] }), capForProp: t => t,
    agentRoomId: () => 'assigned-empty-room', bayObjects: () => [] }) };
  const f = fixture({ WorldModel: model }); t.after(() => f.bridge.dispose()); await f.bridge.start();
  assert.deepEqual(f.bridge.snapshot().capabilities.agent.placement, { known: true, placed: [], stationPlaced: [{ objectType: 'files' }] });
  const capRequest = f.calls.find(c => c.url.includes('/api/toolsets')); assert.equal(new URL(capRequest.url).searchParams.get('placed'), '');
});
test('permission methods require explicit caller action and disposal closes resources', async () => {
  const f = fixture(); await f.bridge.start();
  f.sources[0].push(event('permission.prompt', { promptId: 'p', tool: 'fs.write', scope: 'local' }));
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
  await f.bridge.acknowledgePrompt('lead', 'p'); await f.bridge.respondPermission('lead', 'p', 'once');
  await assert.rejects(f.bridge.respondPermission('lead', 'p', 'invented'), /Invalid permission/);
  f.bridge.dispose(); assert.equal(f.sources[0].closed, true); assert.equal(f.bridge.snapshot().connection.status, 'disconnected');
  await assert.rejects(f.bridge.send('agent', 'hello'), /disposed/);
});
test('real control payloads inherit only their enclosing attended run id and consent settles by receipt', async t => {
  let feed, promptReady;
  const seenPrompt = new Promise(resolve => { promptReady = resolve; });
  const encoder = new TextEncoder();
  const f = fixture({ override: (path, init) => {
    if (path === '/api/run') return new Response(new ReadableStream({ start(controller) {
      feed = controller;
      const rows = [event('agent.run.start'), event('agent.run.start', { runId: 'child', agentId: 'worker' }),
        { name: 'permission.prompt', payload: { agentId: 'agent', promptId: 'question', tool: 'brief.ask', scope: 'read',
          argsSummary: JSON.stringify({ question: 'Which folder?', options: ['A', 'B'], mode: 'choice' }) } },
        { name: 'crew.summon.request', payload: { agentId: 'agent', requestId: 'summon', name: 'Researcher' } }];
      controller.enqueue(encoder.encode(rows.map(JSON.stringify).join('\n') + '\n'));
    } }));
    if (path === '/api/consent/answer') return reply({ ok: false });
    return null;
  } });
  t.after(() => f.bridge.dispose()); await f.bridge.start();
  f.bridge.subscribe(s => { if (s.prompts.length && s.summons.length) promptReady(s); });
  const run = f.bridge.send('agent', 'Organize this');
  const state = await seenPrompt;
  assert.equal(state.prompts[0].runId, 'lead'); assert.equal(state.summons[0].runId, 'lead');
  assert.equal(state.conversations.agent.status, 'waiting');
  assert.equal(state.runs.find(r => r.runId === 'lead').status, 'waiting');
  await f.bridge.answerPrompt('lead', 'question', 'A');
  assert.equal(f.bridge.snapshot().prompts.length, 1, 'a refused answer cannot remove the waiting prompt');
  await f.bridge.respondPermission('lead', 'question', 'deny');
  assert.equal(f.bridge.snapshot().prompts.length, 0);
  feed.enqueue(encoder.encode(JSON.stringify(event('agent.run.end', { reason: 'cancelled' })) + '\n')); feed.close();
  assert.equal((await run).reason, 'cancelled');
});
test('durable transcript and history readers retain wire records without inventing live activity', async t => {
  const turns = [{ streamId: 'saved_session', agentId: 'agent', role: 'assistant', content: 'Saved answer', ts: 10, sourceRunId: 'old-run' },
    { streamId: 'saved_session', agentId: 'agent', role: 'tool', content: 'Written', ts: 11, toolCallId: 'call1' }];
  const f = fixture({ override: path => path === '/api/transcript' ? reply({ stream: 'saved_session', turns }) :
    path === '/api/runs' ? reply({ runs: [{ runId: 'old-run', reason: 'done' }], nextCursor: 'older', snapshotAt: 500 }) : null });
  t.after(() => f.bridge.dispose());
  assert.deepEqual((await f.bridge.readTranscript('saved_session', { agentId: 'agent', limit: 42 })).turns, turns);
  assert.equal((await f.bridge.listRuns({ agentId: '*', through: 500 })).nextCursor, 'older');
  assert.equal((await f.bridge.savedSessions()).workstreams[0].id, 'kept');
  assert.deepEqual(f.bridge.snapshot().runs, []); assert.deepEqual(f.bridge.snapshot().conversations, {});
  await assert.rejects(f.bridge.readTranscript('../escaped'), /Invalid conversation/);
});
