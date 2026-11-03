/* test/line-stops.invariant.test.js — EVERY LINE STOP HAS ONE CODE AND ONE SENTENCE, on the chain and in the step-through test
   (line-job-runner I2, 2026-11-03).

   THE FAMILY. A work line stops in about fourteen places in sidecar/routing/chain.js and a dozen more in the step-through test
   (sidecar/routing/steptest.js), and every one was a free-text sentence: no code said WHY a job stopped, so each reader (the chat's
   stop note, the routine's fire record, the step test's panel, the sample route's job record) re-read the words. And the words lied
   for the commonest stop of all: a stage that ran out of budget or steps, or whose reply the provider cut, stopped the line as
   "editor failed: hit a spending limit" (probe P2) — a limit said as a failure, the run-outcome family's law broken at the line.

   THE INVARIANT. Through the REAL compiler, router, chain runner and step-through test, every hop run by the ONE hop executor
   (sidecar/routing/line-runner.js, built through its production profile factories, with a fake runOnce at the transport edge):
     • every stop path of the walk ends with a code from RunOutcome.LINE_STOPS, and where the step test has the path it ends with
       THE SAME code;
     • a hop whose own outcome is cut_short, out_of_budget, step_limit, asked, interrupted, or that never reported its end, stops
       with stage_incomplete ('<agent> did not finish: …'), and its partial text never reaches a next stage (no later stage runs or
       is handed it; the line's answer is the last finished stage's);
     • why === routing/line-fire.js lineStop(code, facts).why on every surface that says it: the chain's legacy words (out.stopped),
       the chat's stop note (lineStopNote), the routine's fire record (foldLineIntoFire -> lineFacts, with its stopCode), and the step
       test's session.stop and the words it shows (error / ended);
     • two review loops in a row (670332ae: neither engine stops), a COPY section inside a loop running its second pass (45054e87),
       and the fan-out refusal (1f4c3e40: not_steppable, at START and mid-walk).
   The expected sentences are written out below, never computed by the code under test. It fails before the lane (0b8441064): no stop
   code exists anywhere and a step-limit hop says "editor failed: reached the step limit". Before the lane there was no executor
   module, so a hop then runs as every entry's hop runner did (the streamed text, line-fire.js hopError over the hop's own end) and
   the table still measures the walk. Nothing boots; no clock, no network. */
'use strict';
const A = require('./_assert.js');
const { killAll, markFaulted } = require('../sidecar/halt.js');
const path = require('path');
const { sidecarSourceFiles } = require('./helpers/source.js');
const P = require('../frontend/app/pipeline.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const LineFire = require('../sidecar/routing/line-fire.js');
const Verdict = require('../sidecar/routing/verdict.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');

// a module the lane adds is absent before it; anything else that fails to load is a real failure
function optional(rel) {
  try { return require(path.join(__dirname, '..', rel)); }
  catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).indexOf(path.basename(rel)) >= 0) return null; throw e; }
}
const LineRunner = optional('sidecar/routing/line-runner.js');
const STOPS = Array.isArray(RunOutcome.LINE_STOPS) ? RunOutcome.LINE_STOPS : [];
const lineStopWhy = (code, facts) => (typeof LineFire.lineStop === 'function' ? LineFire.lineStop(code, facts).why : '(no lineStop before the lane)');

const belt = (x, y, dir) => ({ x, y, dir });
let T = 1000; const clock = () => (T += 10);
let N = 0; const newId = () => 'id' + (++N);
const runUuid = () => '00000000-0000-4000-8000-' + String(++N).padStart(12, '0');
const JOB = 'write the supplier brief';
const FAULT = 'the station hit an internal fault and stopped this run';
function memStore(v0) { let v = v0 || null; return { load: () => (v ? JSON.parse(v) : null), save: x => { v = JSON.stringify(x); }, raw: () => v }; }

/* ---- THE FLOORS ---- */
// INBOX -> bays in order -> OUTBOX on one row (routing.steptest's floors). o: { intake, limits, outbox: false }
function row(bays, o) {
  const opt = o || {};
  const props = [Object.assign({ id: opt.intake || 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, opt.limits ? { limits: opt.limits } : {})];
  const belts = [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')];
  let x = 4;
  bays.forEach(([id, agentId], i) => {
    props.push({ id, t: 'bay', x, y: 0, w: 1, h: 1, agentId });
    if (i < bays.length - 1 || opt.outbox !== false) belts.push(belt(x + 1, 0, 'E'), belt(x + 2, 0, 'E'));
    x += 3;
  });
  if (opt.outbox !== false) props.push({ id: 'o', t: 'outbox', x, y: 0, w: 1, h: 1 });
  return { props, belts };
}
const THREE = [['b1', 'research'], ['b3', 'editor'], ['b2', 'writer']];
// INBOX -> drafter -> reviewer -> LOOP gate -> (done -> publisher -> OUTBOX | back -> drafter)
function loopFloor(gateCfg) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W'), belt(17, 4, 'E'), belt(18, 4, 'E')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return { props: [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 }, { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' }, Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E' }, gateCfg || {}),
    { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' }, { id: 'p7', t: 'outbox', x: 19, y: 4, w: 1, h: 1 }], belts };
}
// 670332ae: drafter ▸ factcheck ▸ LOOP ▸ style ▸ LOOP ▸ publisher ▸ OUTBOX, both back lanes to the drafter (chain-audit-1010 §1's floor)
function twoGates() {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  belts.push(belt(17, 4, 'E'), belt(18, 4, 'E'), belt(19, 4, 'E'), belt(20, 4, 'E'), belt(21, 4, 'E'));
  belts.push(belt(19, 3, 'N'), belt(19, 2, 'N'), belt(19, 1, 'N'), belt(19, 0, 'W'));
  for (let x = 18; x >= 5; x--) belts.push(belt(x, 0, 'W'));
  belts.push(belt(4, 0, 'S'), belt(4, 1, 'S'), belt(4, 2, 'S'));
  belts.push(belt(24, 4, 'E'), belt(25, 4, 'E'));
  return { props: [
    { id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 }, { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'factcheck' }, { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
    { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'style' }, { id: 'p7', t: 'loop', x: 19, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
    { id: 'p8', t: 'bay', x: 22, y: 3, w: 2, h: 2, agentId: 'publisher' }, { id: 'p9', t: 'outbox', x: 26, y: 4, w: 1, h: 1 }], belts };
}
// a real station drawn with the line editor (chain-audit-1010 §6): the drafter's bay first, the rest by edits
function edited() {
  const s = WM.create(), z = s.rooms()[0].rects[0];
  s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 50, y2: z.y1 + 40 } });
  const near = { x: z.x2 + 10, y: z.y1 + 6 };
  const nl = LE.run(s, null, 'newLine', { role: 'WRITER' }, { near });
  if (!nl.ok) throw new Error('newLine ' + JSON.stringify(nl));
  const drafter = s.props().find(p => p.t === 'bay' && p.role === 'WRITER');
  const edit = (verb, args) => { let r = LE.run(s, drafter.id, verb, args, { near }); if (!r.ok) r = LE.run(s, drafter.id, verb, args, { near, tidy: true }); if (!r.ok) throw new Error(verb + ' ' + JSON.stringify(r)); };
  return { s, drafter, edit, plan: () => P.compileRoutingPlan(s.projectGeometry()) };
}

/* ---- THE TRANSPORT EDGE: what runOnce emits and returns for each way a stage can end. script[agentId] is a kind, { kind, text, usd }
   or (o, n) -> either, for the agent's n-th run. Every unfinished kind streams PARTIAL text first: it must never reach a next stage. ---- */
const PARTIAL = 'PARTIAL-DRAFT';
const ENDS = {
  ok: { reason: 'done', outcome: 'succeeded' },
  cut_short: { reason: 'done', finishReason: 'length', outcome: 'cut_short' },
  out_of_budget: { reason: 'budget', outcome: 'out_of_budget' },
  step_limit: { reason: 'max_iters', outcome: 'step_limit' },
  asked: { reason: 'clarifying', outcome: 'asked', ret: { reason: 'done', clarifying: true } },   // a Task Brief question returns 'done'
  interrupted: { reason: 'interrupted', outcome: 'interrupted' },
  no_end: null,
  failed: { reason: 'error', outcome: 'failed', failureCode: 'server_error', error: 'the provider answered 500' },
  empty: { reason: 'done', outcome: 'succeeded', empty: true },
  cancelled: { reason: 'cancelled', outcome: 'stopped' }
};
function fakeRunOnce(script, log, hook) {
  const runs = {};
  return async (o) => {
    const a = String(o.agentId), n = (runs[a] = (runs[a] || 0) + 1);
    const handed = o.messages && o.messages.length ? String(o.messages[o.messages.length - 1].content) : '';
    log.push({ agentId: a, text: handed });
    const s = script[a];
    const r0 = typeof s === 'function' ? s(o, n) : s;
    const r = typeof r0 === 'string' ? { kind: r0 } : (r0 || { kind: 'ok' });
    const kind = r.kind || 'ok', end = ENDS[kind], usd = typeof r.usd === 'number' ? r.usd : 0;
    const text = kind === 'ok' ? String(r.text != null ? r.text : a + ' finished work #' + n) : (end && end.empty ? '' : PARTIAL + ' by ' + a);
    if (hook) await hook(a, o, kind, n);
    o.emit('agent.run.start', { agentId: a, runId: o.runId, trigger: o.trigger || 'event', model: o.model });
    if (text) o.emit('agent.token', { agentId: a, runId: o.runId, delta: text });
    if (end && end.error) o.emit('agent.run.error', { agentId: a, runId: o.runId, message: end.error, failureCode: end.failureCode });
    if (!end) return undefined;   // no end at all: runOnce returned nothing either
    const e = { agentId: a, runId: o.runId, reason: end.reason, outcome: end.outcome, turns: 1, usd };
    if (end.finishReason) e.finishReason = end.finishReason;
    if (end.failureCode) e.failureCode = end.failureCode;
    o.emit('agent.run.end', e);
    return Object.assign({ reason: end.reason, outcome: end.outcome, text }, end.finishReason ? { finishReason: end.finishReason } : {},
      end.failureCode ? { failureCode: end.failureCode } : {}, end.ret || {});
  };
}
// before the lane: what each entry's hop runner did (hub.js / index.js) — the streamed text, line-fire.js hopError over its own end
function baseHop(runOnce) {
  return async (h) => {
    let buf = '', end = null, errMsg = null, usd = 0;
    const runId = h.runId || newId();
    try {
      await runOnce({ agentId: h.agentId, runId, signal: h.signal, messages: [{ role: 'user', content: h.text }], emit: (name, p) => {
        if (p && p.runId && p.runId !== runId) return;
        if (name === 'agent.token') buf += p.delta || '';
        else if (name === 'agent.run.error') errMsg = p.message || 'run error';
        else if (name === 'agent.run.end') { end = p; if (typeof p.usd === 'number') usd = Math.max(usd, p.usd); }
      } });
    } catch (e) { errMsg = 'run failed: ' + ((e && e.message) || e); }
    const stopped = !!(end && end.reason === 'cancelled');
    return { text: buf, usd, error: LineFire.hopError({ errMsg, stopped, end }), stopped, runId, tools: 0, denied: [] };
  };
}
/* THE PRODUCTION PROFILES (line-runner.js), built exactly as index.js and the hubs build them: a channel hub's hop, a scheduled
   routine's (whose fault containment is no STOP of yours), and a step-through test's step */
const profile = {
  channel: () => LineRunner.profiles.channel({ channel: 'dev', chatId: 'c1', streamId: 'dev-c1', config: () => ({ key: 'k', model: 'm' }), persona: () => 'P', station: () => null }),
  faulted: () => LineRunner.profiles.schedule({ streamId: 'cron-1', config: () => ({ key: 'k', model: 'm' }), system: () => 'S', station: () => null, routine: {}, stoppedSaid: () => FAULT, stoppedByYou: () => false }),
  steptest: () => LineRunner.profiles.steptest({ config: () => ({ key: 'k', model: 'm' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {} })
};

/* ---- THE ENGINES over one router ---- */
function wire(floor, router) {
  const r = router || makeRouter();
  const plan = P.compileRoutingPlan(floor);
  const set = r.setPlan(plan);
  if (!set.ok) throw new Error('plan refused: ' + JSON.stringify(plan.errors));
  return { router: r, plan };
}
// the chain runner exactly as index.js wires it over the router (the host's SEND TO, clean-job and barrier seams aside)
function chainOver(router, o) {
  const opt = o || {};
  return makeChainRunner({
    nextAgent: (a, ctx) => router.chainNext(a, ctx), lineLimits: l => router.lineLimits(l), poolCap: () => null, daySpend: opt.daySpend,
    stageBrief: (a, d) => router.stageBrief(a, d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    stepAgent: (a, ctx) => router.chainStep(a, ctx), fanSiblings: a => router.fanSiblings(a),
    stepDock: (d, ctx) => router.chainStepDock(d, ctx), peekDock: opt.noPeek ? undefined : (d, ctx) => router.chainPeekDock(d, ctx),
    fanSiblingsDock: d => router.fanSiblingsDock(d), entryDockOf: a => router.entryDockOf(a),
    loopGateAfter: opt.noGateReader ? undefined : (a, l, d) => router.loopGateAfter(a, l, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d),
    emit: () => {}, newId, now: clock, setTimer: () => 0
  });
}
// one job down the chain, its hops through the one executor (lineRunner.runLineJob — the one chain.advance call)
async function runChain(router, script, seed, o) {
  const opt = o || {}, log = [];
  const runOnce = fakeRunOnce(script, log, opt.hook);
  const chain = chainOver(router, opt);
  const out = LineRunner
    ? await LineRunner.makeLineRunner({ runOnce, chain, now: clock, newId }).runLineJob({ seed, profile: profile[opt.profile || 'channel']() })
    : await chain.advance(Object.assign({}, seed, { runAgent: baseHop(runOnce) }));
  return { out, log };
}
// the step-through test exactly as index.js getStepTest wires it, its steps through the one executor's steptest profile
function stepTestOver(router, script, o) {
  const opt = o || {}, log = [];
  const box = {};
  const runOnce = fakeRunOnce(script, log, opt.hook ? (a, ro, kind, n) => opt.hook(a, ro, kind, n, box.st) : null);
  const runDock = opt.runDock || (LineRunner ? LineRunner.makeLineRunner({ runOnce, now: clock, newId }).hopRunner(profile.steptest()) : baseHop(runOnce));
  box.st = makeStepTest({
    runDock, store: opt.store || memStore(), now: clock, newId: () => 'st' + (++N), newRunId: runUuid, getTag: () => 'general',
    label: a => String(a).toUpperCase(), daySpend: opt.daySpend,
    plan: {
      get: () => router.getPlan(),
      step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      stepDock: (d, ctx) => router.chainStepDock(d, ctx), peekDock: (d, ctx) => router.chainPeekDock(d, ctx), dockRef: (ref, line) => router.dockRef(ref, line),
      entryDock: (line, text) => { const r = router.resolveDock({ tag: 'general', text, lineId: line }); return (r && router.lineOriginFor(r.agentId, r.dockId) === line) ? r : null; },
      lineOf: (a, d) => router.lineOfAgent(a, d), stageBrief: (a, d) => router.stageBrief(a, d),
      loopGateAfter: opt.noGateReader ? undefined : (a, l, d) => router.loopGateAfter(a, l, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d),
      lineLimits: l => router.lineLimits(l), shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d)
    }
  });
  return { st: box.st, log };
}
async function settle(st, id) {
  for (let i = 0; i < 80; i++) { await st.settled(id); const s = st.get(id).session; if (s && s.state !== 'running') return s; await new Promise(r => setImmediate(r)); }
  return st.get(id).session;
}
async function stepRun(router, script, line, o) {
  const opt = o || {};
  const t = stepTestOver(router, script, opt);
  const started = t.st.start({ line, text: JOB, pause: opt.pause || 'none' });
  if (!started.ok) return { s: null, refusal: started, log: t.log, st: t.st };
  let s = await settle(t.st, started.session.id);
  if (opt.whilePaused) {
    await opt.whilePaused(s, t.st);
    t.st.continue(started.session.id, {});
    s = await settle(t.st, started.session.id);
  }
  return { s, log: t.log, st: t.st };
}

/* ---- THE SURFACES a stop is said on, each against lineStop(code, facts) and the sentence written out here ---- */
const coded = [];   // [label, chain code, step code] — "both give the same code"
function chainSays(label, out, code, facts, words) {
  const why = lineStopWhy(code, facts);
  A.eq(why, words, label + ': lineStop says ' + code + ' in its one sentence');
  A.ok(!!out.stop && STOPS.indexOf(out.stop.code) >= 0, label + ': the chain names the stop with a RunOutcome.LINE_STOPS code (got ' + JSON.stringify(out.stop) + ', said ' + JSON.stringify(out.stopped) + ')');
  A.eq(out.stop && out.stop.code, code, label + ': the chain stops with ' + code);
  A.eq(out.stop && out.stop.why, words, label + ': …in that sentence');
  A.eq(out.stopped, words, label + ': the legacy words are the same sentence');
  const note = LineFire.lineStopNote(out);
  A.ok(note.indexOf(words) >= 0 || (words === 'stopped' && /was stopped before it finished\.$/.test(note)), label + ': the chat\'s stop note says it (' + JSON.stringify(note) + ')');
  const fire = LineFire.foldLineIntoFire({ buf: 'stage one', usd: 0 }, out, 'stage one');
  A.ok(!!fire.line && fire.line.stopped === words.slice(0, 300) && fire.line.stopCode === code, label + ': the routine\'s fire record keeps the sentence and its code (got ' + JSON.stringify(fire.line) + ')');
}
function stepSays(label, s, code, facts, words, shown) {
  const why = lineStopWhy(code, facts);
  A.eq(why, words, label + ' (step test): lineStop says ' + code + ' in its one sentence');
  A.ok(!!s && !!s.stop && STOPS.indexOf(s.stop.code) >= 0, label + ' (step test): the session ends with a RunOutcome.LINE_STOPS code (got ' + JSON.stringify(s && s.stop) + ', state ' + (s && s.state) + ', error ' + JSON.stringify(s && s.error) + ', ended ' + JSON.stringify(s && s.ended) + ')');
  A.eq(s && s.stop && s.stop.code, code, label + ' (step test): it stops with ' + code);
  A.eq(s && s.stop && s.stop.why, words, label + ' (step test): …in that sentence');
  if (shown) A.ok(String((s && s[shown]) || '').indexOf(words) >= 0, label + ' (step test): the session\'s ' + shown + ' says it (' + JSON.stringify(s && s[shown]) + ')');
}
const neverHandedPartial = (label, log) => A.ok(!log.some(r => r.text.indexOf(PARTIAL) >= 0), label + ': no stage is ever handed a partial answer (' + JSON.stringify(log.map(r => r.agentId)) + ')');

(async () => {
  const base = wire(row(THREE));
  const LINE = P.lineOf(base.plan, 'research');
  A.ok(!!LINE, 'fixture: the three-bay line has an id');
  const seed = (extra) => Object.assign({ agentId: 'research', dockId: 'b1', text: 'research notes', originalText: JOB, lineId: LINE, runId: 'entry-1' }, extra || {});

  /* ---------- the control: a line that runs to its OUTBOX stops nowhere ---------- */
  {
    const { out } = await runChain(base.router, {}, seed());
    A.ok(out.stopped == null && !out.stop && out.outboxId === 'o' && out.agentId === 'writer', 'clean: the chain runs to its OUTBOX with no stop (got ' + JSON.stringify({ stopped: out.stopped, stop: out.stop, outboxId: out.outboxId }) + ')');
    const { s } = await stepRun(base.router, {}, LINE);
    A.ok(!!s && s.state === 'done' && s.stop == null && !!s.final, 'clean: the step test reaches its OUTBOX with no stop (got ' + JSON.stringify(s && { state: s.state, stop: s.stop, error: s.error }) + ')');
  }

  /* ---------- A STAGE THAT DID NOT FINISH (doneMeans): six ways, one code, and its partial text goes nowhere ---------- */
  const UNFINISHED = { cut_short: 'the reply was cut short', out_of_budget: 'hit a spending limit', step_limit: 'reached the step limit',
    asked: 'asked a question', interrupted: 'interrupted when StarNet stopped', no_end: 'its run never reported how it ended' };
  for (const kind of Object.keys(UNFINISHED)) {
    const label = 'a stage that ended ' + kind;
    const { out, log } = await runChain(base.router, { editor: kind }, seed());
    chainSays(label, out, 'stage_incomplete', { agent: 'editor', error: UNFINISHED[kind] }, 'editor did not finish: ' + UNFINISHED[kind]);
    A.ok(!log.some(r => r.agentId === 'writer') && out.text === 'research notes' && out.agentId === 'research', label + ': no later stage runs, and the line\'s answer is the last finished stage\'s (got ' + JSON.stringify({ text: out.text, agentId: out.agentId, ran: log.map(r => r.agentId) }) + ')');
    neverHandedPartial(label, log);
    const st = await stepRun(base.router, { editor: kind }, LINE);
    stepSays(label, st.s, 'stage_incomplete', { agent: 'EDITOR', error: UNFINISHED[kind] }, 'EDITOR did not finish: ' + UNFINISHED[kind], 'error');
    A.ok(!st.log.some(r => r.agentId === 'writer'), label + ' (step test): the next step never runs on the partial answer');
    neverHandedPartial(label + ' (step test)', st.log);
    coded.push([label, out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }

  /* ---------- a stage that failed, one that handed on nothing, one someone stopped, one the station's fault containment stopped ---------- */
  {
    const { out, log } = await runChain(base.router, { editor: 'failed' }, seed());
    chainSays('a failed stage', out, 'stage_failed', { agent: 'editor', error: 'the provider answered 500' }, 'editor failed: the provider answered 500');
    neverHandedPartial('a failed stage', log);
    const st = await stepRun(base.router, { editor: 'failed' }, LINE);
    stepSays('a failed stage', st.s, 'stage_failed', { agent: 'EDITOR', error: 'the provider answered 500' }, 'EDITOR failed: the provider answered 500', 'error');
    coded.push(['a failed stage', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    const { out } = await runChain(base.router, { editor: 'empty' }, seed());
    chainSays('an empty stage', out, 'stage_empty', { agent: 'editor' }, 'editor returned nothing');
    const st = await stepRun(base.router, { editor: 'empty' }, LINE);
    stepSays('an empty stage', st.s, 'stage_empty', { agent: 'EDITOR' }, 'EDITOR returned nothing', 'error');
    coded.push(['an empty stage', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    const { out, log } = await runChain(base.router, { editor: 'cancelled' }, seed());
    chainSays('a stage someone stopped', out, 'stopped', { agent: 'editor' }, 'editor was stopped');
    A.ok(out.halted === true, 'a stage someone stopped: the line is halted (RunOutcome.ofLine reads it)');
    neverHandedPartial('a stage someone stopped', log);
    const st = await stepRun(base.router, { editor: 'cancelled' }, LINE);
    stepSays('a stage someone stopped', st.s, 'stopped', { agent: 'EDITOR' }, 'EDITOR was stopped');
    A.ok(st.s && st.s.state === 'stopped', 'a stage someone stopped (step test): the test is stopped, never failed (got ' + (st.s && st.s.state) + ')');
    coded.push(['a stage someone stopped', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
    // E-STOP on the step: the step test's own kill list (halt.js marks the in-flight step halted and aborts it)
    const estop = await stepRun(base.router, { editor: 'cancelled' }, LINE, { hook: (a, o, kind, n, stt) => { if (a !== 'editor') return; killAll(null, stt.inflight); } });
    stepSays('E-STOP on a step', estop.s, 'stopped', { agent: 'EDITOR' }, 'EDITOR was stopped');
    A.eq(estop.s && estop.s.error, 'E-STOP was pressed — the test stopped mid-run', 'E-STOP on a step (step test): the session still says E-STOP in its own words');
  }
  {
    const { out } = await runChain(base.router, { editor: 'cancelled' }, seed(), { profile: 'faulted' });
    chainSays('the station\'s fault containment', out, 'station_fault', { agent: 'editor', error: FAULT }, 'editor failed: ' + FAULT);
    A.ok(!out.halted, 'the station\'s fault containment: no one stopped the line (it is not halted)');
    const st = await stepRun(base.router, { editor: 'cancelled' }, LINE, { hook: (a, o, kind, n, stt) => { if (a !== 'editor') return; markFaulted(stt.inflight); killAll(null, stt.inflight); } });
    stepSays('the station\'s fault containment', st.s, 'station_fault', { agent: 'EDITOR' }, 'EDITOR failed: ' + FAULT);
    A.eq(st.s && st.s.error, 'the station hit an internal fault — the test stopped mid-run', 'the station\'s fault containment (step test): the session still names the fault in its own words');
    coded.push(['the station\'s fault containment', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    // a STOP between stages (the fire's own abort before the next hop): stopped, halted, nothing more runs
    const ac = new AbortController(); ac.abort();
    const { out, log } = await runChain(base.router, {}, seed({ signal: ac.signal }));
    chainSays('a STOP between stages', out, 'stopped', {}, 'stopped');
    A.ok(out.halted === true && log.length === 0, 'a STOP between stages: halted, and no stage runs');
  }

  /* ---------- the LINE BUDGET: stages, $ per message, $ per day ---------- */
  {
    const lim = wire(row(THREE, { limits: { maxHops: 1 } }));
    const lineId = P.lineOf(lim.plan, 'research');
    const { out } = await runChain(lim.router, {}, seed({ lineId }));
    chainSays('the stage ceiling', out, 'hop_limit', { maxHops: 1 }, 'the line is longer than 1 stages — raise max stages in the INBOX’s LINE BUDGET');
    const st = await stepRun(lim.router, {}, lineId);
    stepSays('the stage ceiling', st.s, 'hop_limit', { maxHops: 1 }, 'the line is longer than 1 stages — raise max stages in the INBOX’s LINE BUDGET', 'error');
    A.ok(st.s && /^the test stopped before WRITER: /.test(String(st.s.error)), 'the stage ceiling (step test): framed where the test stopped (' + JSON.stringify(st.s && st.s.error) + ')');
    coded.push(['the stage ceiling', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    const lim = wire(row(THREE, { limits: { maxUsdPerMessage: 0.03 } }));
    const lineId = P.lineOf(lim.plan, 'research');
    const costs = { research: { kind: 'ok', usd: 0.02 }, editor: { kind: 'ok', usd: 0.02 }, writer: { kind: 'ok', usd: 0.02 } };
    const { out, log } = await runChain(lim.router, costs, seed({ lineId, entryUsd: 0.02 }));
    chainSays('the $ ceiling', out, 'usd_limit', { maxUsd: 0.03 }, 'the line reached its $0.03 limit');
    A.ok(!log.some(r => r.agentId === 'writer'), 'the $ ceiling: the stage past it never runs');
    const st = await stepRun(lim.router, costs, lineId);
    stepSays('the $ ceiling', st.s, 'usd_limit', { maxUsd: 0.03 }, 'the line reached its $0.03 limit', 'error');
    coded.push(['the $ ceiling', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    const lim = wire(row(THREE, { limits: { maxUsdPerDay: 1 } }));
    const lineId = P.lineOf(lim.plan, 'research');
    const daySpend = { spentToday: () => 5, note: () => {} };
    const { out } = await runChain(lim.router, {}, seed({ lineId }), { daySpend });
    chainSays('the daily cap', out, 'day_limit', { maxUsdPerDay: 1 }, 'the line reached its $1.00 daily limit');
    const st = await stepRun(lim.router, {}, lineId, { daySpend });
    stepSays('the daily cap', st.s, 'day_limit', { maxUsdPerDay: 1 }, 'the line reached its $1.00 daily limit', 'error');
    A.ok(st.s && /^the test stopped before RESEARCH ran: /.test(String(st.s.error)) && st.log.length === 0, 'the daily cap (step test): nothing is paid for — it stops before the first step runs (' + JSON.stringify(st.s && st.s.error) + ')');
    coded.push(['the daily cap', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    // an empty crate is never handed on (an entry that produced nothing): the chain's pre-hop guard (the step test's start refuses it)
    const { out, log } = await runChain(base.router, {}, seed({ text: '   ' }));
    chainSays('an empty crate', out, 'stage_empty', { agent: 'research', handOn: true }, 'research produced no output to hand on');
    A.eq(log.length, 0, 'an empty crate: nothing is paid for');
  }

  /* ---------- a reviewer's hold: by the stage's own brief (the gate reader), and at the gate itself ---------- */
  {
    const held = wire(loopFloor({ when: 'approved', maxIter: 3 }));
    const lineId = P.lineOf(held.plan, 'drafter');
    const gate = Object.keys(held.plan.junctions || {}).find(k => held.plan.junctions[k] && held.plan.junctions[k].kind === 'loop');
    const words = 'the reviewer at the gate ' + gate + ' answered VERDICT: blocked, so the work is held there — not sent on, not shipped';
    A.eq(Verdict.heldWhy(gate), words, 'fixture: the hold\'s one wording (verdict.js heldWhy)');
    const script = { reviewer: { kind: 'ok', text: 'The brief cites no sources.\nVERDICT: blocked' } };
    for (const noGateReader of [false, true]) {
      const label = noGateReader ? 'a hold at the gate' : 'a hold by the reviewer\'s brief';
      const { out, log } = await runChain(held.router, script, { agentId: 'drafter', dockId: 'p2', text: 'draft v1', originalText: JOB, lineId, runId: 'e-held' }, { noGateReader });
      chainSays(label, out, 'blocked', { loop: gate }, words);
      A.ok(out.blocked === words && !log.some(r => r.agentId === 'publisher' || (r.agentId === 'drafter')), label + ': the work is held — nothing more is bought (' + JSON.stringify(log.map(r => r.agentId)) + ')');
      const st = await stepRun(held.router, script, lineId, { noGateReader });
      stepSays(label, st.s, 'blocked', { loop: gate }, words, 'ended');
      coded.push([label, out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
    }
  }

  /* ---------- the walk's own refusals: a loop back to a bay that ran, a job that belongs to another line, a dead end ---------- */
  {
    // the plan is re-posted while the editor runs: now the editor hands to the research bay that already ran
    const back = wire(row(THREE));
    const reordered = row([['b3', 'editor'], ['b1', 'research'], ['b2', 'writer']]);
    A.eq(P.lineOf(P.compileRoutingPlan(reordered), 'research'), LINE, 'fixture: the re-posted floor keeps the line');
    const repost = (a) => { if (a === 'editor') back.router.setPlan(P.compileRoutingPlan(reordered)); };
    const { out } = await runChain(back.router, {}, seed(), { hook: repost });
    chainSays('a loop back to a bay that ran', out, 'loops_back', { target: 'research' }, 'the line loops back to research');
    back.router.setPlan(P.compileRoutingPlan(row(THREE)));
    const st = await stepRun(back.router, {}, LINE, { hook: repost });
    stepSays('a loop back to a bay that ran', st.s, 'loops_back', { target: 'research' }, 'the line loops back to research', 'error');
    coded.push(['a loop back to a bay that ran', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    // the floor is re-keyed (its INBOX replaced) while the job is out: the job's line is no longer the bay's
    const other = row(THREE, { intake: 'a0' });   // a line's id is its first prop id: an INBOX that sorts first re-keys it
    A.ok(P.lineOf(P.compileRoutingPlan(other), 'research') !== LINE, 'fixture: a new INBOX is a new line');
    const moved = wire(other);
    const { out } = await runChain(moved.router, {}, seed());
    const words = 'this job started on a different line, so it stopped at research — a line hands its work to another line only by SEND TO (drag its OUTBOX onto that line’s INBOX)';
    chainSays('a job from another line', out, 'wrong_line', { agent: 'research' }, words);
    const live = wire(row(THREE));
    const st = await stepRun(live.router, {}, LINE, { pause: 'every', whilePaused: () => { live.router.setPlan(P.compileRoutingPlan(other)); } });
    stepSays('a job from another line', st.s, 'wrong_line', { agent: 'research' }, words, 'ended');
    coded.push(['a job from another line', out.stop && out.stop.code, st.s && st.s.stop && st.s.stop.code]);
  }
  {
    // a bay whose belt reaches no OUTBOX: the step test ends there, typed; the chain's reply stays as it is — no stop and no OUTBOX
    // named (the job's settle types it no_outbox: the one OUTBOX rule is the next step's, S3)
    const dead = wire(row([['b1', 'research'], ['b2', 'writer']], { outbox: false }));
    const lineId = P.lineOf(dead.plan, 'research');
    const { out } = await runChain(dead.router, {}, seed({ lineId }));
    A.ok(out.stopped == null && !out.stop && !out.outboxId && out.agentId === 'writer', 'a dead end: the chain hands the reply on with no stop and names no OUTBOX (got ' + JSON.stringify({ stopped: out.stopped, stop: out.stop, outboxId: out.outboxId }) + ')');
    const st = await stepRun(dead.router, {}, lineId);
    stepSays('a dead end', st.s, 'no_outbox', { agent: 'WRITER' }, 'the belt from WRITER does not reach the OUTBOX — the line ends at this bay', 'ended');
  }

  /* ---------- 1f4c3e40: the step test cannot carry a fan-out — typed at START and mid-walk; the chain carries it ---------- */
  {
    const station = WM.create(); station.projectGeometry();
    station.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 100, y2: 60 } });
    A.ok(LE.placeBlueprint(station, 'parallel_crew', { x: 50, y: 20 }).ok, 'fixture: the parallel template');
    for (const b of station.props().filter(p => p.t === 'bay')) station.assignPropAgent(b.id, 'crew' + b.id);
    station.swapJoinerMerger(station.props().find(p => p.t === 'merger').id);
    const par = wire(station.projectGeometry());
    const lineId = P.lineOf(par.plan, par.plan.bays[0].agentId);
    const r = await stepRun(par.router, {}, lineId);
    A.ok(!!r.refusal && !r.refusal.ok && !!r.refusal.stop && r.refusal.stop.code === 'not_steppable' && r.refusal.stop.why === r.refusal.error && r.log.length === 0,
      'a COPY line at START: refused, typed not_steppable in the compiled topology\'s words, and nothing is paid for (got ' + JSON.stringify(r.refusal) + ')');
  }
  {
    const e = edited();
    e.edit('appendStep', { after: e.drafter.id, role: 'REVIEWER' });
    const editor = e.s.props().find(p => p.t === 'bay' && p.role === 'REVIEWER');
    e.s.assignPropAgent(e.drafter.id, 'drafter'); e.s.assignPropAgent(editor.id, 'editor');
    const live = wire(e.s.projectGeometry());
    const lineId = live.router.lineOfAgent('drafter', e.drafter.id);
    const st = await stepRun(live.router, {}, lineId, { pause: 'every', whilePaused: () => {
      e.edit('addBranch', { from: e.drafter.id, to: editor.id, mode: 'copy', n: 2 });
      const branches = e.s.props().filter(p => p.t === 'bay' && p.id !== e.drafter.id && p.id !== editor.id);
      branches.forEach((b, i) => e.s.assignPropAgent(b.id, 'crew' + i));
      live.router.setPlan(e.plan());
    } });
    const fan = 'this line fans out into parallel branches here — the step-through test carries one crate at a time, so it stops before the split (use SEND A REAL JOB to prove a fan-out line)';
    stepSays('a fan-out met mid-walk', st.s, 'not_steppable', { barrier: 'fanout' }, fan, 'error');
    A.ok(st.s && st.s.state === 'stopped' && st.log.length === 1, 'a fan-out met mid-walk (step test): it stops before the split, after the one step that ran (' + JSON.stringify(st.log.map(x => x.agentId)) + ')');
    const { out } = await runChain(live.router, {}, { agentId: 'drafter', dockId: e.drafter.id, text: 'draft', originalText: JOB, lineId, runId: 'e-fan' });
    A.ok(out.stopped == null && !out.stop && out.agentId === 'editor', 'a fan-out: the chain carries the same job through the split to its end (got ' + JSON.stringify({ stopped: out.stopped, agentId: out.agentId }) + ')');
  }

  /* ---------- 670332ae: two review loops in a row — neither engine stops on the outer gate's second pass ---------- */
  {
    const two = wire(twoGates());
    const lineId = P.lineOf(two.plan, 'drafter');
    const script = { factcheck: { kind: 'ok', text: 'facts ok\nVERDICT: approved' }, style: (o, n) => ({ kind: 'ok', text: n === 1 ? 'tone off\nVERDICT: revise' : 'good\nVERDICT: approved' }) };
    const { out, log } = await runChain(two.router, script, { agentId: 'drafter', dockId: 'p2', text: 'draft v1', originalText: JOB, lineId, runId: 'e-two' });
    A.ok(out.stopped == null && !out.stop && out.agentId === 'publisher' && out.outboxId === 'p9', 'two gates in a row: the chain runs to its OUTBOX (got ' + JSON.stringify({ stop: out.stop, agentId: out.agentId, outboxId: out.outboxId }) + ')');
    A.eq(log.map(r => r.agentId).join(' > '), 'factcheck > style > drafter > factcheck > style > publisher', 'two gates in a row: the outer gate sends it round once');
    const st = await stepRun(two.router, script, lineId);
    A.ok(!!st.s && st.s.state === 'done' && st.s.stop == null && !!st.s.final, 'two gates in a row (step test): it reaches the OUTBOX too, with no stop (got ' + JSON.stringify(st.s && { state: st.s.state, stop: st.s.stop, error: st.s.error }) + ')');
    coded.push(['two gates in a row', out.stop ? out.stop.code : null, st.s && st.s.stop ? st.s.stop.code : null]);
  }

  /* ---------- 45054e87: a COPY section inside a review loop runs its second pass (parallel and one after another) ---------- */
  {
    const e = edited();
    e.edit('addLoop', { around: e.drafter.id, max: 3 });
    const editor = e.s.props().find(p => p.t === 'bay' && p.role === 'REVIEWER');
    e.edit('addBranch', { from: e.drafter.id, to: editor.id, mode: 'copy', n: 2 });
    const branches = e.s.props().filter(p => p.t === 'bay' && p.id !== e.drafter.id && p.id !== editor.id);
    e.s.assignPropAgent(e.drafter.id, 'drafter'); e.s.assignPropAgent(editor.id, 'editor');
    e.s.assignPropAgent(branches[0].id, 'factcheck'); e.s.assignPropAgent(branches[1].id, 'style');
    const looped = wire(e.s.projectGeometry());
    const lineId = looped.router.lineOfAgent('drafter', e.drafter.id);
    for (const noPeek of [false, true]) {
      const label = 'a COPY section inside a loop (' + (noPeek ? 'one after another' : 'parallel') + ')';
      const script = { editor: (o, n) => ({ kind: 'ok', text: n === 1 ? 'needs work\nVERDICT: revise' : 'good\nVERDICT: approved' }) };
      const { out, log } = await runChain(looped.router, script, { agentId: 'drafter', dockId: e.drafter.id, text: 'draft v1', originalText: JOB, lineId, runId: 'e-copy' }, { noPeek });
      A.ok(out.stopped == null && !out.stop && out.agentId === 'editor', label + ': the second review pass runs through it, no stop (got ' + JSON.stringify({ stop: out.stop, stopped: out.stopped }) + ')');
      A.eq(log.filter(r => r.agentId === 'editor').length, 2, label + ': the editor reviews twice');
    }
  }

  /* ---------- a restart mid-step (the step test's own path) ---------- */
  {
    const store = memStore();
    let release = null;
    const hold = new Promise(r => { release = r; });
    const t1 = stepTestOver(base.router, {}, { store, runDock: async () => { await hold; return { text: 'late', usd: 0 }; } });
    const started = t1.st.start({ line: LINE, text: JOB, pause: 'none' });
    A.ok(started.ok, 'fixture: a step is out when the station stops');
    const t2 = stepTestOver(base.router, {}, { store: memStore(store.raw()) });   // the next boot, from the file the first one left
    const s = t2.st.get(started.session.id).session;
    const words = 'the sidecar restarted while RESEARCH was working on this step — that run died with it and its result was lost';
    stepSays('a restart mid-step', s, 'restart', { agent: 'RESEARCH' }, words, 'error');
    A.ok(s && s.state === 'failed' && /RE-RUN STEP runs RESEARCH again\./.test(String(s.error)), 'a restart mid-step: the session keeps its own way out (' + JSON.stringify(s && s.error) + ')');
    release();
    await t1.st.settled(started.session.id);
  }

  /* ---------- BOTH ENGINES GIVE THE SAME CODE wherever both have the path ---------- */
  for (const [label, chainCode, stepCode] of coded) {
    A.ok(chainCode === stepCode && (chainCode == null || STOPS.indexOf(chainCode) >= 0), label + ': the chain and the step test give the same code (chain ' + chainCode + ', step test ' + stepCode + ')');
  }
  A.ok(coded.length >= 18, 'the table covers every shared stop path (' + coded.length + ' rows)');

  /* ---------- ONE PLACE WRITES THE WORDS: chain.js sets its legacy stop words only beside the typed stop (stopAt) ---------- */
  {
    const src = (sidecarSourceFiles().find(f => f.rel.replace(/\\/g, '/') === 'sidecar/routing/chain.js') || {}).text || '';
    const writes = (src.match(/out\.stopped\s*=(?!=)/g) || []).length;
    A.ok(src.length > 0 && writes === 1 && /const stopAt = \(st, node\) => \{/.test(src), 'chain.js writes a stop\'s words in ONE place, beside its code (stopAt) — ' + writes + ' write(s) of out.stopped');
  }

  A.report('line-stops.invariant.test');
})().catch(e => { console.error(e); process.exit(1); });
