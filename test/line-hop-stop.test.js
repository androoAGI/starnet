/* test/line-hop-stop.test.js — STOP on one step of a running line stops the LINE (sweep 2026-10-02).

   The desk screen / HUD STOP now reaches a line's hop runs (they gained stop handles). A stopped run keeps the text it had already
   written and ends 'cancelled' with no error, and the hop runners (channel hub, scheduled routine, Run-Now) handed that back as a
   finished answer: routing/chain.js passed the half-written reply to the NEXT stage, which kept spending. A hop that ended
   cancelled now returns an error, so the chain stops there and keeps the last good answer. Drives the real makeChannelHub.

   THE HOP'S OWN OUTCOME (typed-outcomes, review 4.1): a STOP was one of several ways a hop ends without finishing and without an
   agent.run.error. A reply the provider cut ('done' + finishReason 'length'), a spending limit, the step limit and a run that never
   reported its end each handed their partial text on as a finished stage (chain.js marked the hop delivered and the OUTBOX shipped
   it). Every hop runner now returns routing/line-fire.js hopError — the hop's raised error, its STOP, or its own end read through
   RunOutcome — so the line stops there too. Fails before review 4.1: the cut, budget and no-end hops returned error null. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => undefined };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = text => ({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

(async () => {
  const hops = [];
  const runOnce = async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
    if (o.agentId === 'analyst') {   // stopped mid-answer
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half of an analys' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 1, usd: 0.01 });
      return;
    }
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
  };
  // the chain contract (routing/chain.js): a hop with an error stops the line; only a clean hop hands on
  const chain = {
    stopNote: r => (r && r.stopped ? '\n\n⚠ the work line stopped early — ' + r.stopped + '.' : ''),
    advance: async (o) => {
      const out = { hops: [], text: o.text, agentId: o.agentId, stopped: null };
      for (const agentId of ['analyst', 'editor']) {
        const r = await o.runAgent({ agentId, text: out.text, signal: o.signal });
        hops.push({ agentId, r });
        if (r.error || !String(r.text || '').trim()) { out.stopped = agentId + (r.error ? ' failed: ' + r.error : ' returned nothing'); return out; }
        out.hops.push({ agentId }); out.text = r.text; out.agentId = agentId;
      }
      return out;
    }
  };
  const sends = [];
  const hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); },
    secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain });
  await hub.onInbound(dm('analyse our suppliers'));
  const analyst = hops.find(h => h.agentId === 'analyst');
  A.ok(analyst && analyst.r.error === 'stopped by you', 'a hop that ended cancelled reports it was stopped: ' + JSON.stringify(analyst && analyst.r));
  A.ok(!hops.some(h => h.agentId === 'editor'), 'the next stage never runs on the half-written answer');
  A.ok(sends.length === 1 && /stopped early — analyst failed: stopped by you/.test(sends[0]), 'the reply says the line stopped there: ' + JSON.stringify(sends));

  // a hop that ended WITHOUT SUCCEEDING (no agent.run.error, no STOP) stops the line too: its partial text is never a finished stage
  for (const [why, end, said] of [
    ['a provider-cut reply', { reason: 'done', finishReason: 'length' }, /the reply was cut short/],
    ['a spending limit', { reason: 'budget' }, /hit a spending limit/],
    ['the step limit', { reason: 'max_iters' }, /reached the step limit/],
    ['no end at all', null, /never reported how it ended/]
  ]) {
    const seen = [];
    const runOnce2 = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (o.agentId === 'analyst') {
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half of an analys' });
        if (end) o.emit('agent.run.end', Object.assign({ agentId: o.agentId, runId: o.runId, turns: 1, usd: 0 }, end));
        return;
      }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const chain2 = { stopNote: chain.stopNote, advance: async (o) => { const keep = hops.length; const out = await chain.advance(o); seen.push(...hops.splice(keep)); return out; } };
    const sends2 = [];
    const hub2 = makeChannelHub({ runOnce: runOnce2, store: fakeStore(), send: (c, t) => { sends2.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain: chain2 });
    await hub2.onInbound(dm('analyse our suppliers'));
    const a2 = seen.find(h => h.agentId === 'analyst');
    A.ok(a2 && said.test(String(a2.r.error || '')), why + ': the hop returns its outcome as an error (got ' + JSON.stringify(a2 && a2.r) + ')');
    A.ok(!seen.some(h => h.agentId === 'editor'), why + ': the next stage never runs on the partial answer');
  }
  // a hop that SUCCEEDED still hands on (the control)
  {
    const seen = [];
    const chain3 = { stopNote: chain.stopNote, advance: async (o) => { const keep = hops.length; const out = await chain.advance(o); seen.push(...hops.splice(keep)); return out; } };
    const runOnce3 = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub3 = makeChannelHub({ runOnce: runOnce3, store: fakeStore(), send: () => Promise.resolve({ ok: true, messageId: 'm1' }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain: chain3 });
    await hub3.onInbound(dm('analyse our suppliers'));
    A.ok(seen.length === 2 && seen.every(h => h.r.error === null), 'a hop whose run succeeded hands on with no error (got ' + JSON.stringify(seen.map(h => h.r.error)) + ')');
  }

  // the scheduled routine's and Run-Now's hop runners carry the same rule
  // the host's two runners wherever they live (the hub's own copy is the one driven above)
  const idx = readSidecarSource({ except: ['sidecar/channels/hub.js'] });
  A.eq((idx.match(/if \(name === 'agent\.run\.end' && hopLead && p\.reason === 'cancelled'\) hs\.stopped = true;/g) || []).length, 2, 'both index.js hop runners notice a stopped hop (the hop\'s own STOP, never a worker\'s: review 4.2, driven below)');
  // (worded by hopStoppedSaid: "stopped by you", or the station's fault when the process-fault quiesce stopped it) — through hopError,
  // which also reads the hop's OWN end: a cut, limited or endless hop is an error as well
  A.eq((idx.match(/error: hopError\(hs, hs\.stopped \? hopStoppedSaid\(\) : ''\)/g) || []).length, 2, '…and return it as an error, so the chain stops');
  A.eq((idx.match(/const hopLead = !p\.runId \|\| String\(p\.runId\) === String\(hopRunId\);/g) || []).length, 2, 'both index.js hop runners settle on the HOP\'s own run (never a delegated worker\'s)');
  A.eq((idx.match(/if \(name === 'agent\.run\.end' && hopLead\) hs\.end = p;/g) || []).length, 2, '…and keep the hop\'s own end for hopError');
  // the step-through test's own dock runner reads the step's outcome the same way
  A.ok(/const stepErr = hopError\(\{ errMsg: st\.err, stopped: st\.stopped, end: st\.end \}, 'stopped by you'\);/.test(idx) && /const done = !stepErr && /.test(idx),
    'the step-through test delivers a step only when its own run succeeded (hopError), never on partial text');

  /* A DELEGATED WORKER'S ERROR OR STOP IS NEVER THE HOP'S OWN (review 4.2). team.dispatch / team.spawn forward a worker's
     agent.run.error and agent.run.end onto the hop's emit under the WORKER's runId (orchestration.js FORWARD). The hub's hop sink
     settles on the hop's own run (hopLead); the host's three sinks — the routine's scheduled seam, Run Now and the step-through
     test — took the worker's error (a provider 429 the hop recovered from) or its STOP as the hop's, so chain.js stopped the line
     with "<hop> failed: <the worker's error>" and dropped the hop's finished answer. Each sink is sliced from the sidecar and
     driven: a worker that failed and one that was stopped, then the hop's own clean end. Fails before review 4.2: all three
     returned the worker's 429 as the hop's error. */
  {
    const { hopError } = require('../sidecar/routing/line-fire.js');
    // the `const <name> = (name, payload) => { … };` that follows `from` (naive brace match: these sinks hold no brace in a string)
    const sinkAfter = (src, from) => {
      const arrow = src.indexOf('= (name, payload) => {', from);
      const open = src.indexOf('{', arrow);
      let depth = 0, i = open;
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      return src.slice(src.lastIndexOf('const ', arrow), i + 1) + ';';
    };
    // (channel-delivery-ledger: each sink keeps its reply in a ReplyAssembler, sidecar/reply-assembler.js, declared between its
    // state and the sink; the state no longer holds the text, so the slice runs from the state to the sink's end)
    const { makeReplyAssembler } = require('../sidecar/reply-assembler.js');
    const HS = "const hs = { errMsg: null, usd: 0, end: null };";
    const ST = "const st = { err: null, usd: 0, calls: {}, denied: [], end: null };";
    const sinkFrom = (src, at) => { const code = sinkAfter(src, at); const head = src.slice(at, src.lastIndexOf('const ', src.indexOf('= (name, payload) => {', at))); return head + code; };
    const sinks = [];
    for (let at = idx.indexOf(HS); at >= 0; at = idx.indexOf(HS, at + 1)) sinks.push({ where: sinks.length ? 'Run Now' : 'the scheduled seam', code: sinkFrom(idx, at) });
    const stAt = idx.indexOf(ST);
    if (stAt >= 0) sinks.push({ where: 'the step-through test', code: sinkFrom(idx, stAt) });
    A.eq(sinks.length, 3, 'fixture: the routine seam\'s, Run Now\'s and the step test\'s hop sinks are sliced from the sidecar');
    const build = s => new Function('hopRunId', 'runId', 'runTeeView', 'cronEmitNotify', 'emit', 'redact', 'makeReplyAssembler', s.code
      + '\nconst fold = typeof hs !== "undefined" ? hs : st;\nconst said = typeof hopAssembler !== "undefined" ? hopAssembler : assembler;'
      + '\nreturn { fold, text: () => said.text(), sink: typeof hopSink === "function" ? hopSink : sink };');
    const noop = () => null, same = x => x;
    const errOf = f => hopError({ errMsg: f.errMsg || f.err, stopped: f.stopped, end: f.end }, 'stopped by you');
    for (const s of sinks) {
      // a worker the hop delegated to failed (a provider 429) and another was stopped; the hop recovered and ended clean
      const { fold, sink, text } = build(s)('hop-1', 'hop-1', noop, noop, noop, same, makeReplyAssembler);
      sink('agent.run.start', { agentId: 'writer', runId: 'hop-1' });
      sink('agent.run.start', { agentId: 'researcher', runId: 'worker-1' });
      sink('agent.run.error', { agentId: 'researcher', runId: 'worker-1', message: 'rate limited by the provider (429)', failureCode: 'rate_limit' });
      sink('agent.run.end', { agentId: 'researcher', runId: 'worker-1', reason: 'error', outcome: 'failed', failureCode: 'rate_limit', turns: 1, usd: 0.001 });
      sink('agent.run.start', { agentId: 'researcher', runId: 'worker-2' });
      sink('agent.run.end', { agentId: 'researcher', runId: 'worker-2', reason: 'cancelled', outcome: 'stopped', turns: 1, usd: 0 });
      sink('agent.token', { agentId: 'writer', runId: 'hop-1', delta: 'the finished answer' });
      sink('agent.run.end', { agentId: 'writer', runId: 'hop-1', reason: 'done', outcome: 'succeeded', turns: 2, usd: 0.01 });
      A.ok(errOf(fold) === null && text() === 'the finished answer', s.where + ': a worker\'s forwarded error or STOP is never the hop\'s — the hop that ended clean hands its answer on (got ' + JSON.stringify({ err: errOf(fold), buf: text() }) + ')');
      // the hop's OWN error and its own STOP still stop the line
      const own = build(s)('hop-2', 'hop-2', noop, noop, noop, same, makeReplyAssembler);
      own.sink('agent.run.error', { agentId: 'writer', runId: 'hop-2', message: 'the hop itself failed' });
      own.sink('agent.run.end', { agentId: 'writer', runId: 'hop-2', reason: 'error', turns: 1, usd: 0 });
      A.eq(errOf(own.fold), 'the hop itself failed', s.where + ': the hop\'s own error still stops the line');
      const stop = build(s)('hop-3', 'hop-3', noop, noop, noop, same, makeReplyAssembler);
      stop.sink('agent.token', { agentId: 'writer', runId: 'hop-3', delta: 'half' });
      stop.sink('agent.run.end', { agentId: 'writer', runId: 'hop-3', reason: 'cancelled', turns: 1, usd: 0 });
      A.ok(stop.fold.stopped === true && errOf(stop.fold) === 'stopped by you', s.where + ': the hop\'s own STOP still stops the line');
    }
  }

  A.report('line-hop-stop.test');
})().catch(e => { console.error(e); process.exit(1); });
