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
      return { reason: 'cancelled', text: 'half of an analys' };
    }
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    return { reason: 'done', text: o.agentId + ' says hi' };   // what runOnce returns: a stage hands on its terminal text
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
        return end ? Object.assign({ text: 'half of an analys' }, end) : undefined;   // no end at all: runOnce returned nothing either
      }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
      return { reason: 'done', text: o.agentId + ' says hi' };
    };
    const chain2 = { stopNote: chain.stopNote, advance: async (o) => { const keep = hops.length; const out = await chain.advance(o); seen.push(...hops.splice(keep)); return out; } };
    const sends2 = [];
    const hub2 = makeChannelHub({ runOnce: runOnce2, store: fakeStore(), send: (c, t) => { sends2.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain: chain2 });
    await hub2.onInbound(dm('analyse our suppliers'));
    const a2 = seen.find(h => h.agentId === 'analyst');
    A.ok(a2 && said.test(String(a2.r.error || '')), why + ': the hop returns its outcome as an error (got ' + JSON.stringify(a2 && a2.r) + ')');
    // (line-job-runner, typed stops) and names it as a stage that did not finish — the code chain.js stops the line with
    A.ok(a2 && a2.r.stopCode === 'stage_incomplete', why + ': the hop\'s stop is stage_incomplete, never a failure (got ' + JSON.stringify(a2 && a2.r.stopCode) + ')');
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
      return { reason: 'done', text: o.agentId + ' says hi' };
    };
    const hub3 = makeChannelHub({ runOnce: runOnce3, store: fakeStore(), send: () => Promise.resolve({ ok: true, messageId: 'm1' }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain: chain3 });
    await hub3.onInbound(dm('analyse our suppliers'));
    A.ok(seen.length === 2 && seen.every(h => h.r.error === null), 'a hop whose run succeeded hands on with no error (got ' + JSON.stringify(seen.map(h => h.r.error)) + ')');
  }

  /* THE HOST'S HOP RUNNERS ARE PROFILES OF THE ONE HOP EXECUTOR (line-job-runner): the routine's scheduled seam, Run Now and the
     step-through test run their hops through sidecar/routing/line-runner.js, the executor the hub's hop above runs through. Each is
     driven here through its production profile, with a fake runOnce at the transport edge (it emits, and returns what runOnce returns).
     A STOPPED hop and a hop that ended without succeeding stop the line; and (review 4.2) a DELEGATED WORKER'S error or STOP, forwarded
     onto the hop's emit under the WORKER's runId (orchestration.js FORWARD), is never the hop's: the hop that ended clean hands on. */
  {
    const { makeLineRunner, profiles } = require('../sidecar/routing/line-runner.js');
    const routine = { config: () => ({ key: 'k', model: 'm' }), system: () => 'S', station: () => null };
    const kinds = {
      'the scheduled seam': profiles.schedule(routine), 'Run Now': profiles.manual(routine),
      'the step-through test': profiles.steptest({ config: () => ({ model: 'm', key: 'k' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {} })
    };
    const hop = (p, script) => makeLineRunner({ runOnce: async (o) => script(o.emit, o.runId) }).hopRunner(p)({ agentId: 'writer', text: 'hand-off' });
    for (const where of Object.keys(kinds)) {
      const p = kinds[where];
      const clean = await hop(p, (emit, id) => {
        emit('agent.run.start', { agentId: 'writer', runId: id });
        emit('agent.run.start', { agentId: 'researcher', runId: 'worker-1' });
        emit('agent.run.error', { agentId: 'researcher', runId: 'worker-1', message: 'rate limited by the provider (429)', failureCode: 'rate_limit' });
        emit('agent.run.end', { agentId: 'researcher', runId: 'worker-1', reason: 'error', outcome: 'failed', failureCode: 'rate_limit', turns: 1, usd: 0.001 });
        emit('agent.run.start', { agentId: 'researcher', runId: 'worker-2' });
        emit('agent.run.end', { agentId: 'researcher', runId: 'worker-2', reason: 'cancelled', outcome: 'stopped', turns: 1, usd: 0 });
        emit('agent.token', { agentId: 'writer', runId: id, delta: 'the finished answer' });
        emit('agent.run.end', { agentId: 'writer', runId: id, reason: 'done', outcome: 'succeeded', turns: 2, usd: 0.01 });
        return { reason: 'done', outcome: 'succeeded', text: 'the finished answer' };
      });
      A.ok(clean.error === null && clean.stopped === false && clean.text === 'the finished answer', where + ': a worker\'s forwarded error or STOP is never the hop\'s — the hop that ended clean hands its answer on (got ' + JSON.stringify(clean) + ')');
      // the hop's OWN error and its own STOP still stop the line
      const own = await hop(p, (emit, id) => {
        emit('agent.run.error', { agentId: 'writer', runId: id, message: 'the hop itself failed' });
        emit('agent.run.end', { agentId: 'writer', runId: id, reason: 'error', turns: 1, usd: 0 });
        return { reason: 'error', outcome: 'failed', failureCode: 'run_failure', text: '' };
      });
      A.eq(own.error, 'the hop itself failed', where + ': the hop\'s own error still stops the line');
      const stop = await hop(p, (emit, id) => {
        emit('agent.token', { agentId: 'writer', runId: id, delta: 'half' });
        emit('agent.run.end', { agentId: 'writer', runId: id, reason: 'cancelled', turns: 1, usd: 0 });
        return { reason: 'cancelled', outcome: 'stopped', text: 'half' };
      });
      A.ok(stop.error === 'stopped by you' && stop.stopped === true && stop.stopCode === 'stopped', where + ': the hop\'s own STOP still stops the line, said as a stop (got ' + JSON.stringify(stop) + ')');
      A.eq(own.stopCode, 'stage_failed', where + ': the hop\'s own error is a failed stage');
      // a hop that ended WITHOUT SUCCEEDING is no finished stage: its partial text never hands on
      for (const [why, end, said] of [
        ['a provider-cut reply', { reason: 'done', finishReason: 'length' }, /the reply was cut short/],
        ['a spending limit', { reason: 'budget' }, /hit a spending limit/],
        ['the step limit', { reason: 'max_iters' }, /reached the step limit/]
      ]) {
        const r = await hop(p, (emit, id) => {
          emit('agent.token', { agentId: 'writer', runId: id, delta: 'half of an analys' });
          emit('agent.run.end', Object.assign({ agentId: 'writer', runId: id, turns: 1, usd: 0 }, end));
          return Object.assign({ text: 'half of an analys' }, end);
        });
        A.ok(said.test(String(r.error || '')), where + ', ' + why + ': the hop returns its outcome as an error (got ' + JSON.stringify(r.error) + ')');
        A.ok(r.stopCode === 'stage_incomplete' && r.text === '', where + ', ' + why + ': a stage that did not finish, handing on nothing (got ' + JSON.stringify({ stopCode: r.stopCode, text: r.text }) + ')');
      }
    }
    /* a stop nobody made (the station's fault containment: the profile says it was no STOP of yours) is the FAULT, and a profile with no
       words of its own never says "stopped by you" for it (the step test's profile has none; the routine's say the fault themselves) */
    const faulted = await hop(profiles.steptest({ config: () => ({ model: 'm', key: 'k' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {}, stoppedByYou: () => false }), (emit, id) => {
      emit('agent.run.end', { agentId: 'writer', runId: id, reason: 'cancelled', turns: 1, usd: 0 });
      return { reason: 'cancelled', outcome: 'stopped', text: 'half' };
    });
    A.ok(faulted.stopCode === 'station_fault' && faulted.stopped === false && faulted.error === 'the station hit an internal fault and stopped this run',
      'the step-through test: a run the fault containment stopped is the station\'s fault, never "stopped by you" (got ' + JSON.stringify(faulted) + ')');
  }

  A.report('line-hop-stop.test');
})().catch(e => { console.error(e); process.exit(1); });
