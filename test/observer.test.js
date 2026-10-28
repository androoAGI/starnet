/* node test/observer.test.js — the terminal's live feed (sidecar/observer.js), no sockets.

   Locks: which run events a watcher receives and in what SHAPE (tool args/results clipped to a line, a question's
   card kept whole, tokens only when non-empty, unknown events never sent) · redact() runs over every view · the tee
   runs the run's own sink FIRST and unchanged, and does nothing else while nobody watches · the SSE handler's wire
   (headers, retry, ready frame, live frames, eviction on close). Part of test:fast. */
'use strict';
const A = require('./_assert.js');
const { EventEmitter } = require('events');
const { makeObserver, observerView, serveObserver, lastUserText, CLIP } = require('../sidecar/observer.js');

// ---- views ---------------------------------------------------------------------------------------
{
  const ctx = { runId: 'r1', agentId: 'astra', streamId: 'cli-astra', surface: 'interactive', trigger: 'directive', lineId: '', dockId: '', prompt: () => 'fix the login redirect' };
  const start = observerView('agent.run.start', { agentId: 'astra', runId: 'r1', trigger: 'directive', model: 'm/x' }, ctx);
  A.eq([start.runId, start.agentId, start.model, start.streamId, start.surface, start.prompt], ['r1', 'astra', 'm/x', 'cli-astra', 'interactive', 'fix the login redirect'], 'run.start carries the run, the conversation, the surface and the asking prompt');
  A.eq([start.projectRoot, observerView('agent.run.start', { agentId: 'astra', runId: 'r2' }, Object.assign({}, ctx, { projectRoot: 'C:\\Code\\App' })).projectRoot], ['', 'C:\\Code\\App'], 'run.start says the trusted project the run works in (\'\' = the agent\'s own workspace), so a terminal opens the files it writes where they are');
  const worker = observerView('agent.run.start', { agentId: 'scout', runId: 'w1' }, Object.assign({}, ctx, { runId: 'w1', agentId: 'scout', parentRunId: 'r1', delegatedBy: 'astra' }));
  A.eq([worker.parentRunId, worker.delegatedBy, 'parentRunId' in start], ['r1', 'astra', false], 'a delegated worker\'s run.start names the lead run and agent that sent it (the FLOOR\'s handoff); a run nobody sent carries neither');
  A.eq(observerView('agent.token', { runId: 'r1', agentId: 'astra', delta: '' }, ctx), null, 'an empty token delta is never sent');
  A.eq(observerView('agent.token', { runId: 'r1', agentId: 'astra', delta: 'Hi' }, ctx).delta, 'Hi', 'a token delta is sent as streamed');
  const long = 'x'.repeat(5000);
  const call = observerView('agent.tool_call', { runId: 'r1', agentId: 'astra', callId: 'c1', name: 'fs.edit', argsSummary: long, args: { secret: 1 } }, ctx);
  A.eq(call.argsSummary.length, CLIP.argsSummary, 'tool arguments are clipped to one line');
  A.ok(!('args' in call), 'raw tool arguments are never copied');
  const res = observerView('agent.tool_result', { runId: 'r1', agentId: 'astra', callId: 'c1', ok: true, ms: 12, summary: long }, ctx);
  A.eq([res.ok, res.ms, res.summary.length], [true, 12, CLIP.summary], 'a tool result is outcome + a clipped line');
  const ask = observerView('permission.prompt', { promptId: 'p1', agentId: 'astra', tool: 'brief.ask', scope: 'read', argsSummary: JSON.stringify({ question: 'q', sample: 'y'.repeat(2400) }) }, ctx);
  A.ok(!!JSON.parse(ask.argsSummary).question, 'a question card stays parseable JSON (not clipped mid-string)');
  A.eq(ask.runId, 'r1', 'an ask names the run that holds its answer slot even when the payload does not');
  const perm = observerView('permission.prompt', { promptId: 'p2', agentId: 'astra', tool: 'fs.edit', scope: 'write', argsSummary: long }, ctx);
  A.eq(perm.argsSummary.length, CLIP.argsSummary, 'an approval summary is clipped');
  const resp = observerView('permission.response', { promptId: 'p2', decision: 'once', via: 'terminal' }, ctx);
  A.eq([resp.promptId, resp.decision, resp.via, resp.runId], ['p2', 'once', 'terminal', 'r1'], 'a settled ask names who answered');
  A.eq(observerView('crew.summon.request', {}, ctx), null, 'events outside the policy are never sent');
  A.eq(observerView('agent.run.end', { runId: 'r1', agentId: 'astra', reason: 'done', turns: 2, usd: 0.01 }, ctx).reason, 'done', 'run.end carries its reason');
}

// ---- lastUserText -------------------------------------------------------------------------------
A.eq(lastUserText([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), 'c', 'the last user turn');
A.eq(lastUserText([{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }]), 'one two', 'text parts are joined');
A.eq(lastUserText(null), '', 'no messages → empty');

// ---- tee + publish ------------------------------------------------------------------------------
function fakeRes() {
  const r = new EventEmitter();
  r.frames = []; r.headers = null;
  r.writeHead = (code, h) => { r.code = code; r.headers = h; };
  r.write = (s) => { r.frames.push(s); return true; };
  r.end = () => { r.ended = true; };
  r.destroy = () => {};
  return r;
}
{
  const scrubbed = [];
  const ob = makeObserver({ redact: (v) => { scrubbed.push(v); return Object.assign({}, v, { redacted: true }); }, epoch: 't' });
  const order = [];
  const emit = ob.tee((name) => order.push('run:' + name), { runId: 'r9', agentId: 'cypher' });
  emit('agent.token', { runId: 'r9', agentId: 'cypher', delta: 'hi' });
  A.eq(order, ['run:agent.token'], "the run's own sink still runs while nobody watches");
  A.eq(scrubbed.length, 0, 'nothing is built for the feed while nobody watches');
  const res = fakeRes();
  ob.hub.add(res);
  emit('agent.tool_call', { runId: 'r9', agentId: 'cypher', callId: 'c', name: 'shell', argsSummary: 'npm test' });
  A.eq(order.length, 2, 'the run sink ran first');
  const frame = res.frames.find(f => f.indexOf('agent.tool_call') >= 0) || '';
  const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
  A.eq([data.name, data.payload.name, data.payload.argsSummary, data.payload.redacted], ['agent.tool_call', 'shell', 'npm test', true], 'a watcher receives the redacted view');
  let threw = false;
  const bad = ob.tee(() => { throw new Error('sink down'); }, {});
  try { bad('agent.token', { delta: 'x' }); } catch (_) { threw = true; }
  A.ok(threw, "a failing run sink still fails the way it did before (the tee never swallows the run's own error)");
  A.eq(ob.publish('nope', {}, {}), 0, 'publishing an event outside the policy reaches nobody');
}

// ---- the SSE handler -------------------------------------------------------------------------------
{
  const ob = makeObserver({ epoch: 'wire' });
  const req = new EventEmitter(); req.headers = {}; req.url = '/api/observe';
  const res = fakeRes();
  serveObserver(ob.hub, req, res, { keepaliveMs: 60000 });
  A.eq(res.code, 200, 'the feed answers 200');
  A.ok(/text\/event-stream/.test(res.headers['Content-Type']), 'as an event stream');
  A.ok(res.frames[0].indexOf('retry:') === 0, 'with a reconnect hint first');
  A.ok(res.frames.some(f => f.indexOf('"stream":"ready"') >= 0), 'then a ready frame');
  A.eq(ob.size(), 1, 'the watcher is registered');
  ob.publish('agent.run.start', { runId: 'r', agentId: 'a', trigger: 'directive', model: 'm' }, {});
  A.ok(res.frames.some(f => f.indexOf('agent.run.start') >= 0), 'a live event reaches the watcher');
  req.emit('close');
  A.eq(ob.size(), 0, 'a closed watcher is dropped');
}

A.report('observer.test');
