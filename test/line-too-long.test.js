/* test/line-too-long.test.js — A LINE LONGER THAN ITS STAGE CEILING SAYS SO BEFORE A JOB IS PAID FOR (2026-10-09 P0).

   A real user lost days chaining work through long lines: the chain executor (sidecar/routing/chain.js preHopRefusal) stops a
   job once it would run more than maxHops + 1 stages ("the line is longer than 6 stages"), but nothing on the floor or in the
   Workflow panel said so until a paid run reached that stage. Locked here:
     THE FINDING   — compileRoutingPlan warns LINE_TOO_LONG on a line one job could run past its ceiling on, anchored on the
                     INBOX whose LINE BUDGET is in force, carrying the numbers (stages, maxHops). Never a blocker.
     THE NUMBERS   — counted the way the executor spends hops: a FAN-OUT split runs every branch (each counts), a FILTER /
                     turn-taking split takes one way (the longest counts), a LOOP's passes back round are off the ceiling.
     THE BUDGET    — a LINE BUDGET "max stages after the first" that fits clears it; one too low raises it; the default stays 6.
     THE RUNTIME   — on the same floors the REAL chain runner stops a job exactly when the compile said it would.
     THE STOP NOTE — the executor's stop says where the ceiling is raised.
     ONE COUNT (line-job-runner I6, 2026-11-03) — the count was written in four places (the executor's pre-hop guard, LINE_TOO_LONG,
                     lineStages, the Workflow panel's words; the floor's plate and hover card made two more). It is Pipeline.stageCeiling /
                     overStageCeiling now, and on compiled floors (straight, fan-out, loop, escalation) through the real router, chain AND
                     step-through test the executor stops with stop.code 'hop_limit' exactly when the compiler raises LINE_TOO_LONG.
                     Fails before the lane (0b8441064): no stage count exists to read, the readers do their own arithmetic, and no stop
                     carries a code. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { sidecarSourceFiles } = require('./helpers/source.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');
const { makeChainRunner, preHopRefusal, MAX_HOPS } = require('../sidecar/routing/chain.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');

A.eq(MAX_HOPS, 6, 'the default stage ceiling stays 6 stages after the first');

function bigStation(w, h) {
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = w || 60; r.y2 = h || 30; }
  return WM.create(d);
}
const crewAll = st => { for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id); };
const planOf = st => P.compileRoutingPlan(st.projectGeometry());
const tooLong = plan => plan.errors.filter(e => e.code === 'LINE_TOO_LONG');
const one = (st, t) => st.props().filter(p => p.t === t).map(p => p.id);
// a straight line of n steps, built from panel edits: INBOX → n BAYs → OUTBOX
function straight(n) {
  const st = bigStation(8 + 4 * n + 8, 16);
  const r0 = LE.run(st, null, 'newLine', { role: 'WRITER' }, { near: { x: 6, y: 6 } });
  if (!r0.ok) throw new Error('newLine ' + JSON.stringify(r0));
  for (let i = 1; i < n; i++) {
    const bays = st.props().filter(p => p.t === 'bay');
    const last = bays[bays.length - 1].id;
    const r = LE.run(st, last, 'appendStep', { after: last, role: 'WRITER' }, {});
    if (!r.ok) throw new Error('appendStep ' + i + ' ' + JSON.stringify(r));
  }
  crewAll(st);
  return st;
}
function stamped(bpId) {
  const st = bigStation(60, 30);
  const r = LE.placeBlueprint(st, bpId, { x: 20, y: 10 });
  if (!r.ok) throw new Error('placeBlueprint ' + bpId + ' ' + JSON.stringify(r));
  crewAll(st);
  return st;
}

/* ---------- THE FINDING: a straight line of 8 steps runs past the default ceiling (1 + 6) ---------- */
{
  const st7 = straight(7);
  A.eq(tooLong(planOf(st7)).length, 0, 'seven steps fit the default ceiling (the first stage + 6 more): no finding');
  const st = straight(8);
  const plan = planOf(st);
  const f = tooLong(plan);
  A.eq(f.length, 1, 'eight steps in a row: ONE LINE_TOO_LONG finding — ' + JSON.stringify(plan.errors.map(e => e.code)));
  const [I] = one(st, 'intake');
  A.ok(f[0] && f[0].propId === I, '…anchored on the line\'s INBOX, where its LINE BUDGET is raised');
  A.ok(f[0] && f[0].stages === 8 && f[0].maxHops === 6, '…carrying the numbers: 8 stages against 6 after the first — ' + JSON.stringify(f[0]));
  A.ok(f[0] && f[0].warn === true && f[0].lineId === plan.lineOfProp[I], '…a WARNING (never a blocker) naming the line');
  A.ok(P.ok ? P.ok(plan) !== false : true, 'the plan is still deployable — the stages that do run are real work');
  A.eq(plan.errors.filter(e => !e.warn).map(e => e.code), [], 'no blocking error rides along');

  /* THE BUDGET: raising "max stages after the first" to fit clears it; the $ caps already set are kept by the caller */
  const h0 = plan.hash;
  A.ok(st.setPropLimits(I, { maxHops: 7 }).ok, 'the INBOX takes a LINE BUDGET of 7 stages after the first');
  const p2 = planOf(st);
  A.eq(tooLong(p2).length, 0, '…and the line fits: the finding clears');
  A.eq(p2.hash, h0, 'a budget is policy, not topology: the plan hash does not move');
  A.ok(st.setPropLimits(I, { maxHops: 3 }).ok, 'a budget of 3 after the first');
  const f3 = tooLong(planOf(st));
  A.ok(f3.length === 1 && f3[0].maxHops === 3 && f3[0].stages === 8, 'a budget set too low raises it, with the budget\'s own number — ' + JSON.stringify(f3[0]));
}

/* ---------- THE NUMBERS: fan-out branches all count, one-way junctions count their longest way, loop passes do not ---------- */
{
  // DEEP DIVE: INBOX → SPLITTER (copy) → 3 RESEARCHERS → JOINER → ANALYST → WRITER → REVIEWER ⟲ LOOP → OUTBOX
  // one job runs 3 + 3 = 6 stages (the review loop's passes back are off the ceiling)
  const st = stamped('deep_dive');
  const [I] = one(st, 'intake');
  A.eq(tooLong(planOf(st)).length, 0, 'deep dive (6 stages) fits the default ceiling');
  st.setPropLimits(I, { maxHops: 5 });
  A.eq(tooLong(planOf(st)).length, 0, '…and a budget of 5 after the first (6 stages) — exactly enough');
  st.setPropLimits(I, { maxHops: 4 });
  const f = tooLong(planOf(st));
  A.ok(f.length === 1 && f[0].stages === 6, 'with 4 after the first it is too long: EVERY copy branch counts (3 + 3 = 6, not the longest path 4) — ' + JSON.stringify(f[0]));
}
{
  // TRIAGE DESK: a FILTER sends a job ONE way — the longest way is what must fit
  const st = stamped('triage_desk');
  const [I] = one(st, 'intake');
  st.setPropLimits(I, { maxHops: 0 });
  A.eq(tooLong(planOf(st)).length, 0, 'a FILTER\'s branches are one way, not a sum: triage desk runs ONE stage per job, so even 0 after the first fits');
}
{
  // REVISION LOOP: WRITER → REVIEWER ⟲ — two stages; going round again is not a new stage on the ceiling
  const st = stamped('revision_loop');
  const [I] = one(st, 'intake');
  st.setPropLimits(I, { maxHops: 1 });
  A.eq(tooLong(planOf(st)).length, 0, 'a review loop counts its first pass only: 2 stages fit 1 after the first');
}
{
  // the LINE BUDGET in force on a line with two INBOXes is the oldest one that carries limits — the finding sits there
  const st = stamped('two_doors');
  const ins = one(st, 'intake');
  A.eq(ins.length, 2, 'two doors has two INBOXes');
  // two doors is ONE stage long, so 0 after the first fits: a second step makes it two, so a budget of 0 really trips
  const [B] = one(st, 'bay');
  const add = LE.run(st, B, 'appendStep', { after: B, role: 'WRITER' }, {});
  A.ok(add && add.ok, 'a second step after the shared BAY — ' + JSON.stringify(add && (add.error || add.msg)));
  crewAll(st);
  A.eq(tooLong(planOf(st)).length, 0, 'two stages fit the default ceiling: no finding before any budget');
  st.setPropLimits(ins[1], { maxHops: 0 });
  const f = tooLong(planOf(st));
  A.ok(f.length === 1 && f[0].propId === ins[1] && f[0].maxHops === 0 && f[0].stages === 2, 'a finding on a two-door line sits on the INBOX whose budget is in force — ' + JSON.stringify(f));
  st.setPropLimits(ins[0], { maxHops: 6 });
  A.eq(tooLong(planOf(st)).length, 0, '…and the OLDER INBOX that carries limits speaks first: its 6 after the first fits');
}

/* ---------- THE WORKFLOW PANEL READS IT (WorkflowLine): while the line is being built, and with the one fix ---------- */
{
  global.Pipeline = P;
  const WL = require('../frontend/app/workflowline.js');
  const st = straight(8);
  for (const p of st.props()) if (p.t === 'bay') st.assignPropAgent(p.id, '');   // uncrewed: the compile cannot run it yet…
  const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo);
  A.eq(tooLong(plan).length, 0, 'an UNCREWED line routes nothing yet, so the real plan has no stages to count');
  const comp = P.lineComponents(geo).find(c => c.intakes.length);
  const f = WL.lineFlow(plan, comp, P, geo.props);
  const [I] = one(st, 'intake');
  A.ok(f.tooLong && f.tooLong.stages === 8 && f.tooLong.maxHops === 6 && f.tooLong.propId === I, '…but the panel\'s flow reads the stand-in-crew compile: TOO LONG while the line is being built — ' + JSON.stringify(f.tooLong));
  const r = WL.readiness(f, comp, { errors: plan.errors, hasCompute: () => true, labelOf: c => c });
  const item = r.blocking.find(b => b.code === 'LINE_TOO_LONG');
  A.ok(!!item && item.propId === I && /the longest way runs 8 stages, the LINE BUDGET allows 7/.test(item.what), 'readiness names it (not READY TO RUN) with the numbers: ' + (item && item.what));
  A.eq(WL.tooLongFix(f.tooLong), 7, 'the one fix: 7 stages after the first');
  A.eq(WL.tooLongFix({ stages: 26, maxHops: 6 }), null, 'past the ceiling (24 after the first) no budget fits…');
  A.ok(/shorten the line/.test(WL.tooLongText({ stages: 26, maxHops: 24 })), '…and the words say to shorten the line');
  crewAll(st); st.setPropLimits(I, { maxHops: 7, maxUsdPerMessage: 3 });
  const g2 = st.projectGeometry(), p2 = P.compileRoutingPlan(g2), f2 = WL.lineFlow(p2, P.lineComponents(g2).find(c => c.intakes.length), P, g2.props);
  A.eq(f2.tooLong, null, 'with the budget raised the panel says nothing more');
  A.eq(st.propById(I).limits.maxUsdPerMessage, 3, '(the $ per message set beside it stays)');
}
{
  // the panel and the floor say it (source locks: the DOM is driven live in the lane's proof)
  const fs = require('fs'), path = require('path');
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', f), 'utf8');
  const panel = read('app/workflowpanel.js'), build = read('app/build.js'), world = read('app/world.js'), css = read('css/workflow-panel.css');
  A.ok(/id="wf-toolong"/.test(panel) && /function paintTooLong\(f\)/.test(panel) && /paintTooLong\(f\);/.test(panel), 'the panel header has a TOO LONG row, painted on every header paint');
  A.ok(/setPropLimits\(p\.id, Object\.assign\(\{\}, cur, \{ maxHops: to \}\)\)/.test(panel) && /▲ ALLOW ' \+ tl\.stages \+ ' STAGES/.test(panel), '…whose one key raises THIS INBOX\'s max stages to fit through the LINE BUDGET setter, keeping its $ limits');
  A.ok(/LINE_TOO_LONG: 'TOO LONG — RAISE THE LINE BUDGET'/.test(build) && /LINE_TOO_LONG: 'TOO LONG — RAISE THE LINE BUDGET'/.test(world), 'the floor names the fix, in REFIT and in the live world');
  A.ok(/LINE_TOO_LONG: 'Too long — /.test(build) && /function findingWhy\(e\)/.test(build) && /esc\(findingWhy\(e\)\)/.test(build), 'the hover card says it in full, with this line\'s own numbers');
  A.ok(/\.wf-toolong/.test(css) && /\.wf-note/.test(css), 'styled in the panel\'s own sheet');
  A.ok(/r\.blocking\.slice\(1\)\.filter\(h => h\.code !== 'LINE_TOO_LONG'\)/.test(panel), '…and said once: the header\'s hint chips leave it to its row');
}

/* ---------- ONE COUNT: Pipeline.stageCeiling is the stage count, and every reader reads it (line-job-runner I6) ---------- */
{
  const has = typeof P.stageCeiling === 'function' && typeof P.overStageCeiling === 'function' && typeof P.hopsToFit === 'function';
  A.ok(has, 'Pipeline carries THE stage count: stageCeiling, overStageCeiling, hopsToFit');
  if (has) {
    A.ok(P.stageCeiling(6) === 7 && P.stageCeiling(0) === 1 && P.stageCeiling(24) === 25, 'a budget of N after the first allows N + 1 stages (6 → 7, 0 → 1, the hard ceiling 24 → 25)');
    A.ok(P.stageCeiling(undefined) === P.stageCeiling(P.LINE_LIMIT_DEFAULTS.maxHops) && P.stageCeiling('junk') === 7, 'no budget (or junk) is the default\'s ceiling');
    A.ok(P.overStageCeiling(8, 6) && !P.overStageCeiling(7, 6) && P.overStageCeiling(2, 0) && !P.overStageCeiling(1, 0), 'over the ceiling: 8 stages on a budget of 6, never 7; 2 on a budget of 0, never 1');
    A.ok(P.hopsToFit(8) === 7 && P.hopsToFit(1) === 0 && P.hopsToFit(0) === 0 && !P.overStageCeiling(8, P.hopsToFit(8)), 'the budget a job needs is the one that fits it exactly');
  }
  /* THE READERS: none counts on its own — no arithmetic on a LINE BUDGET's stages anywhere they live, and each calls the one count */
  const sidecar = rel => (sidecarSourceFiles().find(f => f.rel.replace(/\\/g, '/') === rel) || {}).text || '';
  const front = rel => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', rel), 'utf8');
  const fnIn = (src, head) => { const at = src.indexOf(head); if (at < 0) return ''; const end = src.indexOf('\n  }\n', at); return src.slice(at, end < 0 ? at + 3000 : end); };
  const readers = { 'sidecar/routing/chain.js': sidecar('sidecar/routing/chain.js'), 'sidecar/routing/steptest.js': sidecar('sidecar/routing/steptest.js'),
    'frontend/app/pipeline.js': front('pipeline.js'), 'frontend/app/workflowline.js': front('workflowline.js'), 'frontend/app/workflowpanel.js': front('workflowpanel.js'), 'frontend/app/build.js': front('build.js') };
  for (const rel of Object.keys(readers)) {
    const src = readers[rel];
    const own = (src.match(/maxHops\s*[+-]\s*\d|\(m \+ 1\)|HOPS_CEILING|stages - 1 <= 24|\(25 stages at most\)/g) || []);
    A.ok(src.length > 0 && own.length === 0, rel + ': counts no stages of its own (found ' + JSON.stringify(own) + ')');
  }
  const chainSrc = readers['sidecar/routing/chain.js'], stepSrc = readers['sidecar/routing/steptest.js'], pipe = readers['frontend/app/pipeline.js'];
  A.ok(/function preHopStop\(g\) \{[\s\S]*?Pipeline\.overStageCeiling\(g\.hop - g\.loopHops \+ 1, g\.lim\.maxHops\)/.test(chainSrc), 'the executor\'s pre-hop guard (chain.js preHopStop) stops by Pipeline.overStageCeiling');
  A.ok(/\bpreHopStop\b/.test(stepSrc) && !/\.maxHops\b/.test(stepSrc), 'the step-through test stops by the same guard, and reads no ceiling of its own');
  A.ok(/if \(overStageCeiling\(stages, maxHops\)\) errors\.push\(\{ code: 'LINE_TOO_LONG'/.test(pipe), 'LINE_TOO_LONG warns by overStageCeiling');
  A.ok(/return \{ stages, worst, max: stageCeiling\(maxHops\), maxHops \};/.test(fnIn(pipe, 'function lineStages(plan, lineId)')), 'lineStages names the ceiling by stageCeiling');
  A.ok(/PL\.stageCeiling\(m\)/.test(fnIn(readers['frontend/app/workflowline.js'], 'function tooLongNumbers(tl)')) && /W\.tooLongNumbers\(tl\)/.test(readers['frontend/app/workflowpanel.js']),
    'the Workflow panel\'s TOO LONG words read it (WorkflowLine.tooLongNumbers over Pipeline.stageCeiling)');
  const build = readers['frontend/app/build.js'];
  A.ok(/Pipeline\.stageCeiling\(budget\)/.test(fnIn(build, 'function lineStagesOf(rec, rest)')) && /Pipeline\.overStageCeiling\(rec\.stages, budget\)/.test(build) && /WorkflowLine\.tooLongNumbers\(e\)/.test(fnIn(build, 'function findingWhy(e)')),
    'the floor\'s n/max plate and its hover card read it too');
}

/* ---------- THE RUNTIME AGREES: the real chain runner stops exactly where the compile said ---------- */
const reply = (agentId, revise) => agentId + ' says: done.\nVERDICT: ' + (revise && revise(agentId) ? 'revise' : 'approved');
async function runLine(st, maxHops, revise) {
  const [I] = one(st, 'intake');
  if (maxHops != null) st.setPropLimits(I, { maxHops });
  const plan = planOf(st);
  const router = makeRouter();
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('plan refused ' + JSON.stringify(plan.errors));
  const entry = P.resolveDock(plan, { tag: 'general' });
  const lineId = P.lineOfDock(plan, entry.dockId);
  const ran = [entry.agentId];
  const c = makeChainRunner({
    nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx), fanSiblings: a => router.fanSiblings(a),
    stepDock: (d, ctx) => router.chainStepDock(d, ctx), fanSiblingsDock: d => router.fanSiblingsDock(d), entryDockOf: a => router.entryDockOf(a),
    lineOfAgent: (a, d) => router.lineOfAgent(a, d), lineLimits: id => router.lineLimits(id), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d),
    runAgent: async ({ agentId }) => { ran.push(agentId); return { text: reply(agentId, revise), usd: 0 }; },
    now: () => 0, setTimer: () => 0
  });
  const res = await c.advance({ agentId: entry.agentId, dockId: entry.dockId, text: reply(entry.agentId, revise), originalText: 'the job', lineId, runId: 'r1' });
  return { res, ran, plan };
}
// …and so does the step-through test, its walk over the same router (index.js getStepTest's plan seams), run with no pause
async function stepLine(st, maxHops, revise) {
  const [I] = one(st, 'intake');
  if (maxHops != null) st.setPropLimits(I, { maxHops });
  const plan = planOf(st);
  const router = makeRouter();
  if (!router.setPlan(plan).ok) throw new Error('plan refused ' + JSON.stringify(plan.errors));
  const ran = [];
  const t = makeStepTest({
    runDock: async (h) => { ran.push(h.agentId); return { text: reply(h.agentId, revise), usd: 0, runId: 'r' + ran.length }; },
    now: () => 0, getTag: () => 'general',
    plan: {
      get: () => router.getPlan(), step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      stepDock: (d, ctx) => router.chainStepDock(d, ctx), peekDock: (d, ctx) => router.chainPeekDock(d, ctx), dockRef: (ref, line) => router.dockRef(ref, line),
      entryDock: (line, text) => { const r = router.resolveDock({ tag: 'general', text, lineId: line }); return (r && router.lineOriginFor(r.agentId, r.dockId) === line) ? r : null; },
      lineOf: (a, d) => router.lineOfAgent(a, d), stageBrief: (a, d) => router.stageBrief(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d),
      lastStage: (a, d) => router.chainShipsToOutbox(a, d), lineLimits: l => router.lineLimits(l), shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d)
    }
  });
  const entry = P.resolveDock(plan, { tag: 'general' });
  const started = t.start({ line: P.lineOfDock(plan, entry.dockId), text: 'the job', pause: 'none' });
  if (!started.ok) throw new Error('step test refused: ' + started.error);
  let s = null;
  for (let i = 0; i < 100; i++) { await t.settled(started.session.id); s = t.get(started.session.id).session; if (s.state !== 'running') break; }
  return { s, ran, plan };
}
const reviewerOf = st => { const p = st.props().find(q => q.t === 'bay' && q.role === 'REVIEWER'); return p ? (id => id === 'ag_' + p.id) : null; };
(async () => {
  // [label, floor, budget, the reviewer always sends the work back (the longest way: every pass, then the escalation lane), steppable]
  for (const [label, mk, hops, revising, steppable] of [['8 steps, default', () => straight(8), null, false, true], ['8 steps, budget 7', () => straight(8), 7, false, true],
    ['7 steps, default', () => straight(7), null, false, true],
    ['deep dive, budget 4', () => stamped('deep_dive'), 4, false, false], ['deep dive, budget 5', () => stamped('deep_dive'), 5, false, false], ['deep dive, default', () => stamped('deep_dive'), null, false, false],
    ['review loop, budget 0', () => stamped('revision_loop'), 0, false, true], ['review loop going round, budget 1', () => stamped('revision_loop'), 1, true, true],
    ['escalation lane, budget 1', () => stamped('fire_escape'), 1, true, true], ['escalation lane, budget 2', () => stamped('fire_escape'), 2, true, true]]) {
    const st0 = mk();
    const { res, ran, plan } = await runLine(st0, hops, revising ? reviewerOf(st0) : null);
    const warned = tooLong(plan).length > 0, stoppedForLength = /longer than/.test(String(res.stopped || ''));
    A.eq(stoppedForLength, warned, label + ': the runner stops for length ⟺ the compile warned (stopped: ' + res.stopped + '; ran ' + ran.length + ' stages)');
    A.eq(!!(res.stop && res.stop.code === 'hop_limit'), warned, label + ': the runner\'s stop is hop_limit ⟺ the compile warned LINE_TOO_LONG (stop: ' + JSON.stringify(res.stop) + ')');
    if (!warned) A.eq(res.stopped, null, label + ': a line that fits runs to its end');
    if (!steppable) continue;
    const st1 = mk();
    const t = await stepLine(st1, hops, revising ? reviewerOf(st1) : null);
    A.eq(!!(t.s && t.s.stop && t.s.stop.code === 'hop_limit'), warned, label + ' (step test): it stops with hop_limit ⟺ the compile warned (state ' + (t.s && t.s.state) + ', stop ' + JSON.stringify(t.s && t.s.stop) + '; ran ' + t.ran.length + ')');
    if (!warned) A.ok(t.s && t.s.state === 'done' && t.s.stop == null && !!t.s.final, label + ' (step test): a line that fits reaches its OUTBOX (' + JSON.stringify(t.s && { state: t.s.state, error: t.s.error }) + ')');
    else A.eq(t.ran.length, ran.length, label + ' (step test): it pays for exactly the stages the chain did, then stops');
  }

  /* ---------- THE STOP NOTE names where the ceiling is raised ---------- */
  const why = preHopRefusal({ visited: {}, target: 'x', loopHop: true, hop: 7, loopHops: 0, lim: { maxHops: 6, maxUsd: 2 }, spent: 0, text: 'something' });
  A.ok(/longer than 6 stages/.test(why), 'the stop keeps its number: ' + why);
  A.ok(/raise max stages in the INBOX.s LINE BUDGET/.test(why), '…and says where to fix it: ' + why);

  A.report('line-too-long.test');
})().catch(e => { console.error(e); process.exit(1); });
