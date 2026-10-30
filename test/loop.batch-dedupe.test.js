/* node test/loop.batch-dedupe.test.js — one turn, one effect per distinct call; every call id unique.

   Audit probes (2026-09-22): (1) two identical channel_send calls in one turn BOTH sent; (2) two calls sharing one
   id both ran, and providers/provider.js repairToolPairs later relabelled the second call's real result
   "[interrupted — ... Reissue it if it is still needed.]" — an invitation to repeat a write that already happened.
   This pins: exact duplicates (name + canonical args) run once and vanish from the recorded turn, reused ids are
   made unique BEFORE the turn is persisted or dispatched, and the transcript needs no repair afterwards.
   Scripted provider, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { repairToolPairs } = require('../sidecar/providers/provider.js');

const priceOf = () => ({ in: 1, out: 2 });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const ANY = { type: 'object', properties: {} };

function scripted(turns, inspect) {
  let calls = 0;
  return {
    async *stream(req) {
      const index = calls++;
      if (inspect) inspect(req, index);
      const turn = turns[index] || [{ type: 'done', finishReason: 'stop' }];
      for (const ev of turn) yield ev;
    },
    priceOf, contextLimit: () => 8000, callCount: () => calls
  };
}
// One turn issuing every [id, name, rawArgs] together, then a plain answer.
function batch(specs) {
  const t = [];
  specs.forEach(([id, name, raw], i) => {
    t.push({ type: 'tool_start', index: i, id, name });
    t.push({ type: 'tool_args', index: i, chunk: raw });
  });
  t.push({ type: 'done', finishReason: 'tool_calls' });
  return [t, [{ type: 'text', delta: 'Done.' }, { type: 'done', finishReason: 'stop' }]];
}
function pairedTranscript(messages) {
  const open = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const ids = m.tool_calls.map(tc => tc.id);
      if (new Set(ids).size !== ids.length) return false;
      for (const id of ids) open.set(id, (open.get(id) || 0) + 1);
    }
    if (m.role === 'tool') {
      if (!open.get(m.tool_call_id)) return false;
      open.set(m.tool_call_id, open.get(m.tool_call_id) - 1);
    }
  }
  return Array.from(open.values()).every(n => n === 0);
}
async function run(turns, o) {
  o = o || {};
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const requests = [];
  const provider = scripted(turns, (req) => requests.push(req.messages.map(m => JSON.parse(JSON.stringify(m)))));
  const ran = [];
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'channel_send', schema: ANY, run: async (a) => { ran.push(['channel_send', a]); return 'sent to ' + a.channel; } });
  reg.register({ impact: 'none', name: 'fs_write', schema: ANY, run: async (a) => { ran.push(['fs_write', a]); return 'wrote ' + a.path; } });
  reg.register({ impact: 'none', name: 'fs_read', schema: ANY, run: async (a) => { ran.push(['fs_read', a]); return 'contents of ' + a.path; } });
  for (const n of ['browser.press', 'browser.scroll', 'terminal.write', 'computer.use']) reg.register({ impact: 'none', name: n, schema: ANY, run: async (a) => { ran.push([n, a]); return n + ' ok'; } });
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r',
    tools: [], limits: { maxIters: 5, grace: false, verifyOnStop: false },
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), parallelSafe: o.parallelSafe
  });
  return { res, seq, ran, messages, requests };
}

(async () => {
  // ---- 1. THE AUDIT PROBE: two identical sends in one turn -> sent ONCE; key order cannot hide the duplicate ----
  {
    const { res, seq, ran, messages, requests } = await run(batch([
      ['s1', 'channel_send', '{"channel":"ops","text":"deploy finished"}'],
      ['s2', 'channel_send', '{"text":"deploy finished","channel":"ops"}']
    ]));
    A.eq(ran.length, 1, 'two identical channel_send calls in one turn send exactly once');
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
    A.eq(asst.tool_calls.map(tc => tc.id), ['s1'], 'the duplicate is dropped from the recorded assistant turn');
    A.eq(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['s1'], 'exactly one result, paired to the kept call');
    A.eq(seq.filter(e => e.name === 'agent.tool_call').length, 1, 'telemetry announces one dispatch, not two');
    A.ok(pairedTranscript(requests[1]), 'the next model request is provider-valid');
    A.ok(repairToolPairs(requests[1]) === requests[1], 'repairToolPairs finds nothing to repair (identity return)');
    A.eq(res.reason, 'done', 'the run completes');
  }

  // ---- 2. same id, DIFFERENT args -> both run, the later gets a unique id, both results pair correctly ----
  {
    const { ran, messages, requests, seq } = await run(batch([
      ['dup', 'fs_write', '{"path":"a.txt","content":"A"}'],
      ['dup', 'fs_write', '{"path":"b.txt","content":"B"}']
    ]));
    A.eq(ran.map(r => r[1].path), ['a.txt', 'b.txt'], 'both distinct writes run, once each');
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
    const ids = asst.tool_calls.map(tc => tc.id);
    A.eq(ids, ['dup', 'dup_2'], 'the later call is given a unique id before the turn is persisted');
    const results = messages.filter(m => m.role === 'tool');
    A.eq(results.map(m => m.tool_call_id), ['dup', 'dup_2'], 'each result carries its own call\'s id');
    A.eq(results.map(m => m.content), ['wrote a.txt', 'wrote b.txt'], 'and each id is paired with ITS OWN real result');
    A.eq(seq.filter(e => e.name === 'agent.tool_result').map(e => e.payload.callId), ['dup', 'dup_2'], 'telemetry uses the same unique ids');
    A.ok(pairedTranscript(requests[1]), 'the next model request is provider-valid');
    const repaired = repairToolPairs(requests[1]);
    A.ok(repaired === requests[1], 'repairToolPairs finds nothing to repair');
    A.ok(!JSON.stringify(repaired).includes('[interrupted'), 'no real result is relabelled "interrupted — reissue it"');
  }

  // ---- 2b. a reused id on a call that needed REPAIR: the repaired event names the id the transcript carries ----
  {
    const { ran, messages, seq } = await run(batch([
      ['dup', 'fs_write', '{"path":"a.txt","content":"A"}'],
      ['dup', 'fs_write', '{"path":"b.txt","content":"B"']
    ]));
    A.eq(ran.map(r => r[1].path), ['a.txt', 'b.txt'], 'both run (the second after a structural repair)');
    const rep = seq.filter(e => e.name === 'tool.args.repaired');
    const persisted = messages.find(m => m.role === 'assistant' && m.tool_calls).tool_calls.map(tc => tc.id);
    A.eq(rep.map(e => e.payload.callId), ['dup_2'], 'tool.args.repaired names the unique id, not the reused one');
    A.ok(persisted.indexOf(rep[0] && rep[0].payload.callId) >= 0, 'and that id is the one persisted in the assistant turn');
  }

  // ---- 3. same id AND same args -> one dispatch (duplicate wins over re-id) ----
  {
    const { ran, messages } = await run(batch([
      ['x', 'fs_write', '{"path":"a.txt","content":"A"}'],
      ['x', 'fs_write', '{"path":"a.txt","content":"A"}']
    ]));
    A.eq(ran.length, 1, 'an exact duplicate sharing the id runs once');
    A.ok(pairedTranscript(messages), 'transcript valid');
  }

  // ---- 4. only EXACT duplicates are dropped ----
  {
    const { ran } = await run(batch([
      ['r1', 'fs_read', '{"path":"a.txt"}'],
      ['r2', 'fs_read', '{"path":"a.txt","limit":5}'],
      ['r3', 'fs_write', '{"path":"a.txt"}']
    ]));
    A.eq(ran.length, 3, 'different args or a different tool are never merged');
  }

  // ---- 5. unparseable args are never merged (their values are unknown), and never run ----
  {
    const { ran, messages } = await run(batch([
      ['p1', 'fs_write', 'not json @@'],
      ['p2', 'fs_write', 'also not json @@']
    ]));
    A.eq(ran.length, 0, 'broken calls do not run');
    A.eq(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['p1', 'p2'], 'each broken call still gets its own error result');
  }

  // ---- 6. the parallel path gets the same dedupe (two identical reads in a parallel-safe batch) ----
  {
    const { ran, messages } = await run(batch([
      ['r1', 'fs_read', '{"path":"a.txt"}'],
      ['r2', 'fs_read', '{"path":"a.txt"}'],
      ['r3', 'fs_read', '{"path":"b.txt"}']
    ]), { parallelSafe: (n) => n === 'fs_read' });
    A.eq(ran.map(r => r[1].path), ['a.txt', 'b.txt'], 'parallel batch: the identical read runs once, the distinct one runs');
    A.ok(pairedTranscript(messages), 'parallel batch: transcript valid');
  }

  // ---- 7. the pure seam: a minted id avoids every id already in the transcript ----
  {
    const prior = [{ role: 'assistant', content: '', tool_calls: [{ id: 'dup_2', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] }];
    const calls = [
      { id: 'dup', name: 'fs_write', args: { path: 'a' }, argsRaw: '{"path":"a"}', parseError: null },
      { id: 'dup', name: 'fs_write', args: { path: 'b' }, argsRaw: '{"path":"b"}', parseError: null },
      { id: 'dup', name: 'fs_write', args: { path: 'c' }, argsRaw: '{"path":"c"}', parseError: null }
    ];
    _internals.normalizeBatch(calls, prior);
    A.eq(calls.map(c => c.id), ['dup', 'dup_3', 'dup_4'], 'minted ids skip an id an earlier turn already used');
    const clean = [{ id: 'a', name: 't', args: {}, argsRaw: '{}', parseError: null }, { id: 'b', name: 't', args: { k: 1 }, argsRaw: '{"k":1}', parseError: null }];
    _internals.normalizeBatch(clean, []);
    A.eq(clean.map(c => c.id), ['a', 'b'], 'a well-formed batch is untouched');
  }

  // ---- 8. the kept call's result TELLS the model its identical copies were merged ----
  {
    const { messages } = await run(batch([
      ['s1', 'channel_send', '{"channel":"ops","text":"hi"}'],
      ['s2', 'channel_send', '{"channel":"ops","text":"hi"}'],
      ['s3', 'channel_send', '{"channel":"ops","text":"hi"}']
    ]));
    const r = messages.filter(m => m.role === 'tool');
    A.eq(r.length, 1, 'three identical sends: one result');
    A.ok(r[0].content.indexOf('sent to ops') === 0, 'the real result comes first');
    A.ok(/3 times in one turn; it ran ONCE/.test(r[0].content) && /2 identical copies were not dispatched/.test(r[0].content), 'and it says the 2 copies were not dispatched');
    const { messages: m2 } = await run(batch([['a1', 'fs_read', '{"path":"a.txt"}'], ['a2', 'fs_read', '{"path":"b.txt"}']]));
    A.ok(m2.filter(m => m.role === 'tool').every(m => m.content.indexOf('harness note') < 0), 'no note when nothing was merged');
  }

  // ---- 9. INPUT EVENTS are never merged: each identical press/scroll/write/key IS the intent ----
  {
    const { ran, messages } = await run(batch([
      ['k1', 'browser.press', '{"key":"ArrowDown"}'],
      ['k2', 'browser.press', '{"key":"ArrowDown"}'],
      ['k3', 'browser.scroll', '{"dy":400}'],
      ['k4', 'browser.scroll', '{"dy":400}'],
      ['k5', 'terminal.write', '{"data":"y"}'],
      ['k6', 'terminal.write', '{"data":"y"}'],
      ['k7', 'computer.use', '{"action":"key","text":"Tab"}'],
      ['k8', 'computer.use', '{"action":"key","text":"Tab"}']
    ]));
    A.eq(ran.length, 8, 'two identical presses, scrolls, terminal writes and desktop keys all run twice');
    A.eq(messages.filter(m => m.role === 'tool').length, 8, 'each has its own result');
    A.ok(messages.filter(m => m.role === 'tool').every(m => m.content.indexOf('harness note') < 0), 'and none claims a merge');
    A.ok(pairedTranscript(messages), 'transcript valid');
    // the pure seam: wire-form names are exempt too, and the return value maps kept id -> copies dropped
    const calls = [
      { id: 'w1', name: 'browser_scroll', args: { dy: 1 }, parseError: null }, { id: 'w2', name: 'browser_scroll', args: { dy: 1 }, parseError: null },
      { id: 'c1', name: 'channel_send', args: { t: 1 }, parseError: null }, { id: 'c2', name: 'channel_send', args: { t: 1 }, parseError: null }
    ];
    const dropped = _internals.dropDuplicateCalls(calls);
    A.eq(calls.map(c => c.id), ['w1', 'w2', 'c1'], 'wire-form input tool kept twice; the send merged');
    A.eq(Array.from(dropped.entries()), [['c1', 1]], 'dropDuplicateCalls reports which kept call absorbed how many copies');
  }

  A.report('loop.batch-dedupe.test');
})().catch(e => { console.log('FAIL: loop.batch-dedupe.test threw -- ' + (e && e.stack || e)); process.exit(1); });
