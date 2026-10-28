/* node test/routing.steptest.test.js — the conveyor STEP-THROUGH TEST engine (sidecar/routing/steptest.js),
   driven through the REAL compiler + REAL router (the same reads the executor takes) with a fake runDock,
   a fake clock and an in-memory store. No provider, no wall-clock, no sockets.

   Locks: pause every / none / an edge list; the paused handoff text; an owner edit stamped edited:true (and
   told to the receiving run); rerun (appends, same input, CURRENT brief); rewind (drops later hops, their
   money stays spent); a verdict LOOP revise -> back -> approved with pass counting; the LINE BUDGET over the
   whole session (re-runs included) ending in 'stopped'; single (try-this-step) with a preview; the next dock
   resolved at CONTINUE time from the current plan; the restart round-trip (paused stays paused, running comes
   back failed and can be re-run); one active session per station. */
'use strict';
const A = require('./_assert.js');
const { makeStepTest, normPause } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

const belt = (x, y, dir) => ({ x, y, dir });
let T = 1000; const clock = () => (T += 10);

// INBOX -> research -> writer -> OUTBOX (the sample e2e's two-stage floor)
function twoDock(briefs) {
  const b = briefs || {};
  return {
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research', brief: b.research },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer', brief: b.writer },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  };
}
// INBOX -> research -> editor -> writer -> OUTBOX (a bay ADDED between research and writer)
function threeDock() {
  return {
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research' },
            { id: 'b3', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'editor' },
            { id: 'b2', t: 'bay', x: 10, y: 0, w: 1, h: 1, agentId: 'writer' },
            { id: 'o', t: 'outbox', x: 13, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E'), belt(11, 0, 'E'), belt(12, 0, 'E')]
  };
}
// INBOX -> drafter -> reviewer -> LOOP gate -> (done E -> publisher -> OUTBOX | back N -> drafter)  (chain.join-loop's floor + an OUTBOX)
function loopFloor(gateCfg) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W'), belt(17, 4, 'E'), belt(18, 4, 'E')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return {
    props: [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
            { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
            { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
            Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E' }, gateCfg || {}),
            { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' },
            { id: 'p7', t: 'outbox', x: 19, y: 4, w: 1, h: 1 }],
    belts
  };
}

function memStore() { let v = null; return { load: () => (v ? JSON.parse(v) : null), save: x => { v = JSON.stringify(x); }, raw: () => v }; }

function rig(floor, script, opts) {
  opts = opts || {};
  const router = opts.router || makeRouter();
  const plan = P.compileRoutingPlan(floor);
  if (opts.limits) plan.lineLimits = Object.fromEntries((plan.lines || []).map(l => [l.lineId, opts.limits]));
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('plan refused: ' + JSON.stringify(plan.errors));
  const calls = [];
  const runDock = async (h) => {
    calls.push(h);
    if (opts.gate) await opts.gate(h);
    const r = script[h.agentId];
    return Object.assign({ runId: 'run' + calls.length, tools: 1 }, typeof r === 'function' ? r(h, calls) : (r || { text: h.agentId + ' output', usd: 0.01 }));
  };
  const store = opts.store || memStore();
  const mk = () => makeStepTest({
    runDock, store, now: clock, getTag: () => 'general', label: a => a.toUpperCase(),
    plan: {
      get: () => router.getPlan(),
      step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      entryDock: (line, text) => { const a = router.resolveTarget({ tag: 'general', text, lineId: line }); return a && router.lineOriginFor(a) === line ? a : null; },
      lineOf: a => router.lineOfAgent(a), stageBrief: a => router.stageBrief(a),
      loopGateAfter: (a, l) => router.loopGateAfter(a, l), lineLimits: l => router.lineLimits(l),
      shipsToOutbox: a => router.chainShipsToOutbox(a)
    }
  });
  const st = mk();
  const lineId = P.lineOf(plan, plan.bays[0].agentId);
  return { st, mk, router, plan, calls, store, lineId };
}
const settle = async (R, id) => { for (let i = 0; i < 50; i++) { await R.st.settled(id); const s = R.st.get(id).session; if (s.state !== 'running') return s; } return R.st.get(id).session; };

(async () => {
  /* Whole-line testing refuses parallel topology BEFORE launching; an individual BAY remains testable. */
  {
    const WM = require('../frontend/app/worldmodel.js'), LE = require('../frontend/app/lineedit.js');
    const station = WM.create(); station.projectGeometry();
    station.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 100, y2: 60 } });
    A.ok(LE.placeBlueprint(station, 'parallel_crew', { x: 50, y: 20 }).ok, 'place real parallel template');
    for (const b of station.props().filter(p => p.t === 'bay')) station.assignPropAgent(b.id, 'crew' + b.id);
    let floor = station.projectGeometry(), rr = rig(floor, {});
    A.eq(P.stepTestRefusal(rr.plan, rr.lineId), null, 'TAKE TURNS remains step-testable');
    const merger = station.props().find(p => p.t === 'merger'); station.swapJoinerMerger(merger.id);
    floor = station.projectGeometry(); rr = rig(floor, {});
    A.ok(/parallel/.test(P.stepTestRefusal(rr.plan, rr.lineId)), 'compiled COPY topology reports its limitation');
    const refused = rr.st.start({ line: rr.lineId, text: 'test all branches', pause: 'none' });
    A.ok(!refused.ok && /SEND A REAL JOB/.test(refused.error), 'whole-line test points to the existing action (SEND A REAL JOB, org P17)');
    A.eq(rr.calls.length, 0, 'no paid stage starts before refusing parallel step-through');
    A.eq(rr.st.get().session, null, 'a refusal creates no session');
    const legacy = JSON.parse(JSON.stringify(rr.plan)); for (const l of legacy.lines) delete l.stepTestBarrier;
    rr.router.setPlan(legacy);
    A.ok(!rr.st.start({ line: rr.lineId, text: 'legacy saved plan', pause: 'none' }).ok, 'persisted plans without the new marker refuse too');
    A.eq(rr.calls.length, 0, 'legacy-plan refusal also spends nothing');
    const one = rr.st.start({ line: rr.lineId, text: 'test one branch', startAt: rr.plan.bays[0].agentId, single: true });
    A.ok(one.ok, 'TRY THIS STEP is still available on a parallel line');
    await settle(rr, one.session.id);
    A.eq(rr.calls.length, 1, 'single-step test runs exactly one BAY');
    const sibling = LE.placeBlueprint(station, 'parallel_crew', { x: 80, y: 40 });
    A.ok(sibling.ok, 'place separate TAKE TURNS line beside the parallel line');
    const siblingBays = sibling.ids.map(id => station.propById(id)).filter(p => p.t === 'bay');
    for (let i = 0; i < siblingBays.length; i++) station.assignPropAgent(siblingBays[i].id, i ? 'sibling' + i : rr.plan.bays[0].agentId);
    const together = P.compileRoutingPlan(station.projectGeometry());
    const siblingLine = together.lineOfProp[siblingBays[0].id];
    A.eq(P.stepTestRefusal(together, siblingLine), null, 'sharing an agent with a parallel line does not disable TAKE TURNS');
    for (const l of together.lines) delete l.stepTestBarrier;
    A.ok(P.stepTestRefusal(together, rr.lineId), 'saved-plan topology still finds its own parallel branch');
    A.eq(P.stepTestRefusal(together, siblingLine), null, 'saved-plan topology never borrows another line through its shared agent');
    station.swapJoinerMerger(merger.id);
    A.eq(P.stepTestRefusal(P.compileRoutingPlan(station.projectGeometry()), rr.lineId), null, 'changing back to TAKE TURNS removes the limitation');
    A.eq(P.stepTestRefusal(rr.plan, 'other-line'), null, 'another line is not blocked');
  }

  /* ---- pause rule normalization ---- */
  A.eq(normPause(undefined), 'every', 'default pause rule is every');
  A.eq(normPause(['a>b', 'a>b', 'b>outbox']), ['a>b', 'b>outbox'], 'an edge list is deduped');
  A.eq(normPause('sometimes'), null, 'an unknown word is refused');
  A.eq(normPause(['a-b']), null, 'a malformed edge is refused');

  /* ---- PAUSE EVERY: start -> paused after research, with the exact handoff text and a PREVIEW of the next dock ---- */
  {
    const R = rig(twoDock({ writer: 'Press style.' }), { research: { text: 'findings A', usd: 0.1 }, writer: (h) => ({ text: 'final from: ' + h.text.slice(0, 20), usd: 0.2 }) });
    const r0 = R.st.start({ line: R.lineId, text: 'research sleep' });
    A.ok(r0.ok, 'start answers ok: ' + r0.error);
    A.eq(r0.session.state, 'running', 'the session starts running (the route answers at once; the panel polls)');
    A.eq(r0.session.running.agentId, 'research', 'the ENTRY dock (router.resolveTarget scoped to the line) is working');
    const again = R.st.start({ line: R.lineId, text: 'second' });
    A.eq(again.ok, false, 'ONE active session per station: a second start is refused');
    A.ok(/already running/.test(again.error), 'the refusal says why: ' + again.error);
    let s = await settle(R, r0.session.id);
    A.eq(s.state, 'paused', 'pause:every pauses after the first dock');
    A.eq(R.calls[0].entry, true, 'the entry dock runs as stage one (its brief rides its SYSTEM context in runDock)');
    A.eq(R.calls[0].text, 'research sleep', 'the entry dock is handed the job itself');
    A.eq(s.hops.length, 1);
    A.eq(s.hops[0].output, 'findings A', 'the hop records exactly what the agent replied');
    A.eq(s.hops[0].pass, 1); A.eq(s.hops[0].agentLabel, 'RESEARCH'); A.eq(s.hops[0].sent, null, 'nothing has been sent onward yet');
    A.eq(s.paused.afterHop, 0);
    A.eq(s.paused.text, 'findings A', 'the paused text is the exact handoff the executor would send');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'writer', back: false }, 'the preview names the next dock from the current plan');
    A.eq(s.totalUsd, 0.1); A.eq(s.limits.maxUsdPerMessage, 2, 'the default line budget applies'); A.eq(s.limits.spent, 0.1);
    A.ok(!('_w' in s) && !('_job' in s.hops[0]), 'internals never leave the engine');
    A.eq(R.st.get().session.id, s.id, 'GET with no id answers the active session');

    /* ---- CONTINUE WITH AN EDIT: edited:true on the hop, the receiver is told, the handoff turn carries the owner's words ---- */
    const c1 = R.st.continue(s.id, { text: 'findings A — plus my note' });
    A.ok(c1.ok, 'continue answers ok');
    s = await settle(R, s.id);
    A.eq(s.hops[0].edited, true, 'the owner-edited handoff is stamped edited:true');
    A.eq(s.hops[0].sent, 'findings A — plus my note', 'sent is the text actually handed on');
    A.eq(R.calls[1].edited, true, 'the receiving run is told its input was edited (run-row stamp)');
    A.eq(R.calls[1].entry, false);
    A.ok(/PIPELINE HANDOFF/.test(R.calls[1].text) && R.calls[1].text.indexOf('findings A — plus my note') >= 0, 'the handoff turn (Pipeline.handoffPrompt) carries the edited text');
    A.ok(R.calls[1].text.indexOf('The original request was:\nresearch sleep') >= 0, 'and the original request');
    A.ok(R.calls[1].text.indexOf('YOUR STANDING BRIEF FOR THIS STATION:\nPress style.') >= 0, 'and the RECEIVING dock\'s standing brief');
    A.eq(s.hops[1].input, 'findings A — plus my note', 'the next hop\'s input is the post-edit text');
    A.eq(s.state, 'paused', 'paused again after the writer');
    A.eq(s.paused.next, { kind: 'outbox' }, 'the writer ships to the OUTBOX');

    /* ---- RERUN: same input, CURRENT brief, appended with rerun:true; its cost counts ---- */
    R.plan.dockBays.find(b => b.agentId === 'writer').brief = 'Tabloid style.';
    R.router.setPlan(R.plan);
    A.ok(R.st.rerun(s.id).ok, 'rerun answers ok');
    s = await settle(R, s.id);
    A.eq(s.hops.length, 3, 'the re-run appends a hop');
    A.eq(s.hops[2].rerun, true); A.eq(s.hops[2].pass, 1, 'a re-run keeps the pass number');
    A.eq(s.hops[2].input, s.hops[1].input, 'on the SAME input');
    A.ok(R.calls[2].text.indexOf('Tabloid style.') >= 0 && R.calls[2].text.indexOf('Press style.') < 0, 'with the dock\'s CURRENT brief');
    A.eq(R.calls[2].edited, true, 'a re-run of an edited handoff still says so');
    A.eq(s.totalUsd, 0.5, 'every run counts: 0.1 + 0.2 + 0.2');

    /* ---- REWIND to hop 1: drops hops >= 1, re-runs writer on its original input; the dropped money stays spent ---- */
    const rw = R.st.rewind(s.id, { hop: 1 });
    A.ok(rw.ok, 'rewind answers ok');
    A.eq(rw.session.hops.length, 1, 'hops >= 1 dropped');
    A.eq(rw.session.droppedUsd, 0.4, 'the dropped hops\' cost is recorded');
    s = await settle(R, s.id);
    A.eq(s.hops.length, 2); A.eq(s.hops[1].agentId, 'writer'); A.eq(s.hops[1].rerun, false);
    A.eq(s.hops[1].input, 'findings A — plus my note', 'the rewound hop re-runs on that hop\'s original input');
    A.eq(s.hops[0].usd, 0.1, 'earlier hops and their cost stay');
    A.eq(s.totalUsd, 0.7, 'dropped hops stay counted in the session spend (0.1 + 0.2 + 0.2 dropped + 0.2 new)');
    A.eq(R.st.rewind(s.id, { hop: 9 }).ok, false, 'rewind to a hop that never ran is refused');

    /* ---- continue to the OUTBOX: done, final = what shipped ---- */
    R.st.continue(s.id, {});
    s = await settle(R, s.id);
    A.eq(s.state, 'done', 'continuing past the last dock finishes the test');
    A.eq(s.final, s.hops[1].output, 'final is what reached the OUTBOX');
    A.eq(s.hops[1].edited, false, 'an unedited continue is not stamped edited');
    A.eq(R.st.continue(s.id, {}).ok, false, 'continue on a finished test is refused');
    A.eq(R.st.stop(s.id).ok, false, 'stop on a finished test is refused');
  }

  /* ---- PAUSE NONE: runs to the end without stopping ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go', pause: 'none' });
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'done', 'pause:none runs to the OUTBOX');
    A.eq(s.hops.map(h => h.agentId), ['research', 'writer']);
    A.eq(s.final, 'writer output'); A.eq(s.hops[0].sent, 'research output');
  }

  /* ---- PAUSE ON AN EDGE LIST: only the listed edge stops ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go', pause: ['writer>outbox'] });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'paused', 'pauses on the listed edge');
    A.eq(s.hops.length, 2, 'research>writer was not listed, so it ran straight through');
    A.eq(s.paused.next, { kind: 'outbox' });
    A.ok(R.st.pause(s.id, { pause: 'every' }).ok, 'the pause rule can change mid-test');
    A.eq(R.st.pause(s.id, { pause: 'bogus' }).ok, false, 'a bad rule is refused');
    A.ok(R.st.stop(s.id).ok, 'stop while paused');
    s = R.st.get(s.id).session;
    A.eq(s.state, 'stopped'); A.eq(s.error, null, 'an owner stop is not an error'); A.eq(s.paused, null);
    A.ok(R.st.start({ line: R.lineId, text: 'next' }).ok, 'a stopped test frees the station for a new one');
  }

  /* ---- THE NEXT DOCK IS RESOLVED AT CONTINUE TIME: a bay added while paused receives the crate ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.paused.next.agentId, 'writer', 'preview before the edit: writer');
    const p3 = P.compileRoutingPlan(threeDock());
    A.ok(R.router.setPlan(p3).ok, 'the floor re-posts with an editor bay added');
    A.eq(P.lineOf(p3, 'research'), R.lineId, 'fixture: the line keeps its id (its oldest machine is unchanged)');
    // (sweep 2026-09-25) the paused VIEW re-previews on read: it names the new bay before CONTINUE, not the old next dock
    const fresh = R.st.get(s.id).session;
    A.eq(fresh.paused.next.agentId, 'editor', 'a GET while paused previews the NEW next dock from the current plan');
    A.eq(fresh.paused.text, s.paused.text, 'the paused handoff text itself is untouched');
    A.eq(fresh.updatedAt, s.updatedAt, 'a preview refresh is not an edit (updatedAt unchanged, so the panel keeps the owner\'s draft)');
    R.st.continue(s.id, {});
    s = await settle(R, s.id);
    A.eq(s.hops[1].agentId, 'editor', 'the crate rode into the NEW bay (resolved from the current plan)');
    A.eq(s.paused.next.agentId, 'writer');
  }

  /* ---- VERDICT LOOP: reviewer says revise -> back to drafter (pass 2) -> reviewer approves -> publisher ---- */
  {
    let reviews = 0;
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      drafter: (h) => ({ text: 'draft ' + (/LOOP — pass/.test(h.text) ? 'v2' : 'v1'), usd: 0.01 }),
      reviewer: () => ({ text: 'notes\nVERDICT: ' + (++reviews === 1 ? 'revise' : 'approved'), usd: 0.01 }),
      publisher: { text: 'published', usd: 0.01 }
    });
    const r = R.st.start({ line: R.lineId, text: 'write a post' });
    A.ok(r.ok, 'loop floor starts: ' + r.error);
    let s = await settle(R, r.session.id);
    A.eq(s.hops[0].agentId, 'drafter');
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[1].agentId, 'reviewer');
    A.ok(/VERDICT: approved/.test(R.calls[1].text), 'the reviewer is told to end with the VERDICT line (verdict brief via hopTurn)');
    A.eq(s.hops[1].verdict, 'revise', 'the hop records the parsed verdict');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'drafter', back: true }, 'the preview says the crate goes BACK round the gate');
    A.ok(/^\[LOOP — pass 1 of 3 round the gate at /.test(s.paused.text), 'the paused text carries the executor\'s loop marker: ' + s.paused.text.slice(0, 60));
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[2].agentId, 'drafter'); A.eq(s.hops[2].pass, 2, 'the drafter is on pass 2');
    A.eq(s.hops[2].output, 'draft v2');
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[3].agentId, 'reviewer'); A.eq(s.hops[3].pass, 2); A.eq(s.hops[3].verdict, 'approved');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'publisher', back: false }, 'approved -> the done lane');
    R.st.pause(s.id, { pause: 'none' });
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.state, 'done'); A.eq(s.final, 'published', 'the publisher shipped to the OUTBOX');
    A.eq(s.hops.map(h => h.agentId + ':' + h.pass), ['drafter:1', 'reviewer:1', 'drafter:2', 'reviewer:2', 'publisher:1']);
  }

  /* ---- A TERSE APPROVAL (2026-10-18) — the executor's own decision (chain.js loopDecision): the next dock is handed the work the
          reviewer approved, with the approval as its review; a gate that ships straight out ships the work, never "Looks good." ---- */
  {
    const DRAFT = 'Rooftop installs grew 34% in 2025; battery attach passed half; permits are the top soft cost.';
    const script = { drafter: { text: DRAFT, usd: 0.01 }, reviewer: { text: 'Looks good.\nVERDICT: approved', usd: 0.01 } };
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }), script);
    let s = await settle(R, R.st.start({ line: R.lineId, text: 'write a post' }).session.id);
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.paused.next, { kind: 'agent', agentId: 'publisher', back: false }, 'terse approval: the crate takes the done lane');
    A.ok(s.paused.text.indexOf(DRAFT) >= 0 && /\nREVIEW:\nLooks good\.$/.test(s.paused.text) && !/VERDICT/.test(s.paused.text),
      'terse approval: the handoff the owner sees carries the approved work, then the approval (' + JSON.stringify(s.paused.text.slice(0, 80)) + ')');
    const f = loopFloor({ maxIter: 3, when: 'approved' });
    f.props = f.props.filter(p => p.id !== 'p7').map(p => p.id === 'p6' ? { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 } : p);
    f.belts = f.belts.filter(b => b.x < 17);
    const R2 = rig(f, script);
    const s2 = await settle(R2, R2.st.start({ line: R2.lineId, text: 'write a post', pause: 'none' }).session.id);
    A.eq(s2.state, 'done', 'terse approval to the OUTBOX: the test finishes (' + s2.error + ')');
    A.eq(s2.final, DRAFT, 'terse approval to the OUTBOX: the step test ships the approved work');
  }

  /* ---- LINE BUDGET over the WHOLE session: re-runs count; the refusal ends in 'stopped' with an honest error ---- */
  {
    const R = rig(twoDock(), { research: { text: 'r', usd: 0.4 }, writer: { text: 'w', usd: 0.4 } }, { limits: { maxUsdPerMessage: 1 } });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.limits.maxUsdPerMessage, 1, 'the line\'s own LINE BUDGET applies');
    R.st.rerun(s.id); s = await settle(R, s.id);
    R.st.rerun(s.id); s = await settle(R, s.id);
    A.eq(s.totalUsd, 1.2, 'three runs spent $1.20 (the cap is enforced pre-run, within one run\'s spend)');
    const rr = R.st.rerun(s.id);
    A.ok(rr.ok, 'the verb is accepted — the executor refuses honestly');
    s = await settle(R, s.id);
    A.eq(s.state, 'stopped', 'over budget -> stopped');
    A.ok(/reached its \$1\.00 limit/.test(s.error) && /re-runs included/.test(s.error), 'an honest error: ' + s.error);
    A.eq(s.hops.length, 3, 'nothing ran past the cap');
  }

  /* ---- (quick win 28) every step is handed what is LEFT of the line budget as its own $ ceiling ----
     The pre-run check alone let one own-key step spend far past the LINE BUDGET (the executor passes ceilingUsd on every
     hop since QA 2026-10-02; the step test never did). */
  {
    const R = rig(twoDock(), { research: { text: 'r', usd: 0.4 }, writer: { text: 'w', usd: 0.4 } }, { limits: { maxUsdPerMessage: 1 } });
    const r = R.st.start({ line: R.lineId, text: 'go', pause: 'none' });
    await settle(R, r.session.id);
    A.ok(R.calls.length >= 2, 'fixture: two steps ran');
    A.eq(R.calls[0].ceilingUsd, 1, 'the first step may spend the whole line budget');
    A.ok(Math.abs(R.calls[1].ceilingUsd - 0.6) < 1e-9, 'the second step only what is left of it (' + R.calls[1].ceilingUsd + ')');
  }
  /* ...and the HOST passes it on to the run, and treats a CANCELLED run as stopped, never as a finished step ---- */
  {
    const { sidecarTopLevelFunction } = require('./helpers/source.js');
    const body = sidecarTopLevelFunction('stepTestRunDock');
    A.ok(body.length > 500, 'fixture: stepTestRunDock is sliced');
    A.ok(/ceilingUsd: h\.ceilingUsd/.test(body), 'stepTestRunDock hands the step\'s ceiling to runOnce (lower-only $ cap)');
    A.ok(/p\.reason === 'cancelled'/.test(body) && /st\.stopped \? 'stopped by you'/.test(body), 'a cancelled step run is reported as stopped, never handed on as its half answer');
  }
  /* ...and every line hop's runOnce names its lineId ONCE: a second `lineId` key in the same object literal silently overrode
     the first (the hub's hop, the scheduled seam's hop and Run Now's hop each carried two) — quick win 28 ---- */
  {
    const { readSidecarSource, sidecarSourceFiles, sidecarTopLevelFunction } = require('./helpers/source.js');
    // the object literal opened at `open` ('{'), skipping strings and comments
    const literalAt = (text, open) => {
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        const ch = text[i], nx = text[i + 1];
        if (ch === '/' && nx === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
        if (ch === '/' && nx === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === ch) break; } continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
      }
      return '';
    };
    const hopRunOnce = (text, anchor) => {
      const at = text.indexOf(anchor);
      const call = at < 0 ? -1 : text.indexOf('await runOnce({', at);
      return call < 0 ? '' : literalAt(text, call + 'await runOnce('.length);
    };
    // a KEY is `lineId` right after `{` or `,` (comments between them stripped first); `h.lineId` / `: lineId ||` are values
    const lineIdKeys = (lit) => (lit.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').match(/[{,]\s*lineId\s*[:,}]/g) || []).length;
    const hub = sidecarSourceFiles().find(f => f.rel === 'sidecar/channels/hub.js').text;
    const sites = {
      'the channel hub\'s line hop': hopRunOnce(hub, 'runAgent: async function (h) {'),
      'the scheduled seam\'s line hop': hopRunOnce(readSidecarSource(), 'advanceChain: (o) => chainRunner.advance({'),
      'Run Now\'s line hop': hopRunOnce(sidecarTopLevelFunction('handleCronRun'), 'runAgent: async (h) => {')
    };
    for (const name of Object.keys(sites)) {
      A.ok(sites[name].length > 200, name + ': its runOnce options are sliced');
      A.eq(lineIdKeys(sites[name]), 1, name + ' names lineId exactly once');
    }
  }

  /* ---- a failing dock -> failed with an honest error; RE-RUN recovers ---- */
  {
    let n = 0;
    const R = rig(twoDock(), { research: () => (++n === 1 ? { text: '', error: 'provider 500' } : { text: 'ok now', usd: 0.01 }) });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'failed'); A.ok(/RESEARCH failed: provider 500/.test(s.error), 'failed says why: ' + s.error);
    A.eq(s.hops[0].error, s.error, 'the failed hop carries its error');
    A.ok(R.st.rerun(s.id).ok, 'a failed step can be re-run');
    s = await settle(R, s.id);
    A.eq(s.state, 'paused'); A.eq(s.hops[1].output, 'ok now'); A.eq(s.error, null);
  }

  /* ---- SINGLE (try this step): one dock, then done, with the next dock only previewed ---- */
  {
    const R = rig(twoDock({ writer: 'Press style.' }), { writer: { text: 'polished', usd: 0.05 } });
    const r = R.st.start({ line: R.lineId, text: 'raw findings', startAt: 'writer', single: true, original: 'research sleep' });
    A.ok(r.ok, 'try-this-step starts at a later dock: ' + r.error);
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'done'); A.eq(s.hops.length, 1); A.eq(s.hops[0].agentId, 'writer');
    A.eq(R.calls[0].entry, false, 'a later dock is handed the text as a handoff');
    A.ok(R.calls[0].text.indexOf('The upstream stage (research) produced:\nraw findings') >= 0, 'from its real upstream dock');
    A.ok(R.calls[0].text.indexOf('The original request was:\nresearch sleep') >= 0, 'with the (additive) original request');
    A.eq(s.paused, null); A.eq(s.final, null, 'nothing reached the OUTBOX');
    A.eq(s.preview, { afterHop: 0, text: 'polished', next: { kind: 'outbox' } }, 'the next step is PREVIEWED only');
    A.eq(R.st.start({ line: R.lineId, text: 'x', startAt: 'nobody' }).ok, false, 'startAt must crew a dock on the line');
    A.eq(R.st.start({ line: 'nope', text: 'x' }).ok, false, 'an unknown line is refused');
    A.eq(R.st.start({ line: R.lineId, text: '' }).ok, false, 'an empty job is refused');
    A.eq(R.st.start({ line: R.lineId, text: 'x'.repeat(4001) }).ok, false, 'a job over 4000 chars is refused');
  }

  /* ---- RESTART ROUND-TRIP: paused stays paused and continues; running comes back failed and re-runs ---- */
  {
    const store = memStore();
    const R = rig(twoDock(), {}, { store });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'paused');
    const st2 = R.mk();   // a fresh engine over the same store = a sidecar restart
    const back = st2.get(s.id).session;
    A.eq(back.state, 'paused', 'a paused session comes back paused');
    A.eq(back.paused, s.paused, 'with the same handoff and preview');
    st2.continue(s.id, { text: 'edited after restart' });
    await st2.settled(s.id);
    const s2 = st2.get(s.id).session;
    A.eq(s2.hops[1].agentId, 'writer', 'and continues after the restart');
    A.eq(s2.hops[0].edited, true);

    // a session caught RUNNING when the process died
    // the first writer run never returns: that process "died" — only the restarted engine's re-run completes
    let writers = 0; const never = new Promise(() => {});
    const store3 = memStore();
    const R3 = rig(twoDock(), {}, { store: store3, gate: (h) => (h.agentId === 'writer' && ++writers === 1 ? never : null) });
    const r3 = R3.st.start({ line: R3.lineId, text: 'go' });
    let s3 = await settle(R3, r3.session.id);
    R3.st.continue(s3.id, {});
    A.eq(R3.st.get(s3.id).session.state, 'running', 'the writer is mid-run');
    const st4 = R3.mk();   // restart while running
    const dead = st4.get(s3.id).session;
    A.eq(dead.state, 'failed', 'a session that was RUNNING comes back failed');
    A.ok(/restarted while WRITER was working/.test(dead.error), 'with an honest error: ' + dead.error);
    A.eq(dead.running, null);
    A.ok(st4.rerun(s3.id).ok, 'the lost step can be re-run');
    await st4.settled(s3.id);
    const again = st4.get(s3.id).session;
    A.eq(again.hops[again.hops.length - 1].agentId, 'writer', 'the re-run runs the dock that was lost');
    A.eq(again.state, 'paused');
  }

  /* ---- STOP while running: aborts the run, the hop's spend is still recorded ---- */
  {
    let release; const hold = new Promise(res => { release = res; });
    const R = rig(twoDock(), { research: (h) => ({ text: h.signal.aborted ? 'partial' : 'full', usd: 0.03 }) }, { gate: () => hold });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const st = R.st.stop(r.session.id);
    A.eq(st.session.state, 'stopped', 'stop answers stopped at once');
    A.eq(R.calls[0].signal.aborted, true, 'the in-flight run was aborted');
    A.eq(R.st.rerun(r.session.id).ok, false, 'a stopped step still winding down cannot be re-run yet');
    release();
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'stopped'); A.eq(s.hops.length, 1); A.eq(s.totalUsd, 0.03, 'the aborted run\'s spend is recorded');
    A.ok(/stopped by you/.test(s.hops[0].error), 'the hop says it was stopped');
  }

  /* ---- E-STOP: the engine's inflight map is halt.js-shaped ---- */
  {
    let release; const hold = new Promise(res => { release = res; });
    const R = rig(twoDock(), {}, { gate: () => hold });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const { killAll } = require('../sidecar/halt.js');
    A.eq(killAll(null, R.st.inflight), 1, 'E-STOP reaches the step-test run');
    release();
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'stopped'); A.ok(/E-STOP/.test(s.error), 'says E-STOP: ' + s.error);
  }

  /* ---- THE STATION'S OWN FAULT (wave 2 repair, conveyor-backend-08's sibling): the process-fault containment marks the step-test run
     faulted before it kills it, so the test says the station hit a fault — never an E-STOP nobody pressed ---- */
  {
    let release; const hold = new Promise(res => { release = res; });
    const R = rig(twoDock(), {}, { gate: () => hold });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const { killAll, markFaulted } = require('../sidecar/halt.js');
    markFaulted(R.st.inflight);
    A.eq(killAll(null, R.st.inflight), 1, 'fault: the containment reaches the step-test run');
    release();
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'stopped', 'fault: the test is stopped');
    A.ok(/internal fault/.test(s.error) && !/E-STOP/.test(s.error), 'fault: says the station hit a fault, not E-STOP: ' + s.error);
    A.ok(/internal fault/.test(s.hops[0].error || ''), 'fault: the step\'s own error says it too: ' + s.hops[0].error);
  }

  /* ---- (sweep 2026-09-25) the owner reads display names, never raw agent ids ---- */
  {
    const noOut = twoDock();
    noOut.props = noOut.props.filter(p => p.t !== 'outbox');
    noOut.belts = noOut.belts.filter(b => b.x < 8);
    const R = rig(noOut, {}, { });
    const r = R.st.start({ line: R.lineId, text: 'go', pause: 'none' });
    A.ok(r.ok, 'a line with no OUTBOX still starts: ' + r.error);
    const s = await settle(R, r.session.id);
    A.ok(/the belt from WRITER does not reach the OUTBOX/.test(s.ended || ''), 'the dead end names the agent by its label, not its id: ' + s.ended);
    A.ok(!/the belt from writer /.test(s.ended || ''), 'the raw id is not what the owner reads');
  }

  /* ---- X3 (2026-09-27 audit): a tool the consent gate REFUSED in a step is recorded on the hop (never a clean checkmark) ---- */
  {
    const R = rig(twoDock({}), { research: { text: 'please grant approval for fs.write', usd: 0.01, denied: ['fs.write', 42, 'fs.write2'] }, writer: { text: 'ok', usd: 0.01 } });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const s = await settle(R, r.session.id);
    A.eq(s.hops[0].denied, ['fs.write', 'fs.write2'], 'the refused tools ride the hop (strings only)');
    const R2 = rig(twoDock({}), { research: { text: 'fine', usd: 0.01 }, writer: { text: 'ok', usd: 0.01 } });
    const s2 = await settle(R2, R2.st.start({ line: R2.lineId, text: 'go' }).session.id);
    A.eq(s2.hops[0].denied, [], 'a clean step records none');
  }

  /* ---- TWO REVIEW LOOPS IN A ROW (wave 2 review, conveyor-backend-02): drafter ▸ factcheck ▸ LOOP1 ▸ style ▸ LOOP2 ▸ publisher ▸
     OUTBOX, both back lanes to the drafter (chain-audit-1010's floor). LOOP2 says revise; on the re-run LOOP1 approves and used to
     lower the ONE looping flag while LOOP2's pass was still open, so the visited style read as a loop-back and STEP THROUGH stopped
     "before style" on a line RUN ONE REAL JOB finishes. A gate closes only its own pass (chain.js openLoops, 2026-10-10). ---- */
  {
    const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
      belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
    for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
    belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
    belts.push(belt(17, 4, 'E'), belt(18, 4, 'E'), belt(19, 4, 'E'), belt(20, 4, 'E'), belt(21, 4, 'E'));
    belts.push(belt(19, 3, 'N'), belt(19, 2, 'N'), belt(19, 1, 'N'), belt(19, 0, 'W'));
    for (let x = 18; x >= 5; x--) belts.push(belt(x, 0, 'W'));
    belts.push(belt(4, 0, 'S'), belt(4, 1, 'S'), belt(4, 2, 'S'), belt(24, 4, 'E'));
    const floor = { props: [
      { id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
      { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
      { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'factcheck' },
      { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'style' },
      { id: 'p7', t: 'loop', x: 19, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'p8', t: 'bay', x: 22, y: 3, w: 2, h: 2, agentId: 'publisher' },
      { id: 'p9', t: 'outbox', x: 25, y: 4, w: 1, h: 1 }], belts };
    let styleN = 0;
    const R = rig(floor, {
      factcheck: () => ({ text: 'facts ok\nVERDICT: approved', usd: 0.01 }),
      style: () => ({ text: (++styleN === 1) ? 'tone off\nVERDICT: revise' : 'good\nVERDICT: approved', usd: 0.01 })
    });
    A.eq(R.plan.errors.filter(e => !e.warn).length, 0, 'two gates: the floor compiles');
    const r = R.st.start({ line: R.lineId, text: 'write X', pause: 'none' });
    A.ok(r.ok, 'two gates: STEP THROUGH starts (' + r.error + ')');
    const s = await settle(R, r.session.id);
    A.eq(s.hops.map(h => h.agentId).join(' > '), 'drafter > factcheck > style > drafter > factcheck > style > publisher', 'two gates: the outer gate sends it round once, then on to the publisher');
    A.eq(s.state, 'done', 'two gates: the test finishes (' + s.error + ')');
    A.ok(s.final != null && !s.error, 'two gates: the publisher\'s work reaches the OUTBOX');
    // a fresh session on a one-gate line (openLoops starts empty) still goes round once and out
    const R2 = rig(loopFloor({ maxIter: 3, when: 'approved' }), { reviewer: (h, calls) => ({ text: calls.filter(c => c.agentId === 'reviewer').length === 1 ? 'x\nVERDICT: revise' : 'y\nVERDICT: approved', usd: 0.01 }) });
    const s2 = await settle(R2, R2.st.start({ line: R2.lineId, text: 'go', pause: 'none' }).session.id);
    A.eq(s2.hops.map(h => h.agentId).join(' > '), 'drafter > reviewer > drafter > reviewer > publisher', 'one gate: unchanged');
    A.eq(s2.state, 'done', 'one gate: finishes');
  }

  /* ---- A SESSION SAVED BEFORE THE GATES WERE TRACKED (wave 2 repair of conveyor-backend-02): the old engine persisted only the
     single W.looping flag, never W.openLoops. A STEP THROUGH paused mid-pass in a loop whose body is two steps long (drafter ▸
     editor ▸ reviewer ▸ LOOP back to drafter ▸ publisher) used to write openLoops = {} on the first CONTINUE after the update, and
     the next hop read "no gate open": editor → reviewer stopped as "the line loops back to reviewer" on a line the old engine
     finished. A legacy session keeps its old flag until a gate decides. A rewind onto a step saved before the update walks the
     same way. ---- */
  {
    const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
      belt(15, 4, 'E'), belt(16, 4, 'E'), belt(17, 4, 'E'), belt(18, 4, 'E'), belt(19, 4, 'E'), belt(17, 3, 'N'), belt(17, 2, 'N'), belt(17, 1, 'W'),
      belt(22, 4, 'E'), belt(23, 4, 'E')];
    for (let x = 16; x >= 6; x--) belts.push(belt(x, 1, 'W'));
    belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
    const floor = { props: [
      { id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
      { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
      { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'editor' },
      { id: 'p4', t: 'bay', x: 13, y: 3, w: 2, h: 2, agentId: 'reviewer' },
      { id: 'p5', t: 'loop', x: 17, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'p6', t: 'bay', x: 20, y: 3, w: 2, h: 2, agentId: 'publisher' },
      { id: 'p7', t: 'outbox', x: 24, y: 4, w: 1, h: 1 }], belts };
    let revN = 0;
    const R = rig(floor, { reviewer: () => ({ text: (++revN === 1) ? 'meh\nVERDICT: revise' : 'ok\nVERDICT: approved', usd: 0.01 }) });
    A.eq(R.plan.errors.filter(e => !e.warn).length, 0, 'legacy: the two-step loop body compiles');
    // strip what the old engine never wrote, then boot a fresh engine over the same store (= the update's restart)
    const toLegacy = () => {
      const raw = JSON.parse(R.store.raw());
      for (const x of raw) { if (x._w) delete x._w.openLoops; for (const h of x.hops || []) if (h._before) delete h._before.openLoops; if (x._pending && x._pending.before) delete x._pending.before.openLoops; }
      R.store.save(raw);
    };
    const id = R.st.start({ line: R.lineId, text: 'write X', pause: 'every' }).session.id;
    let st = R.st, s = null, upgraded = false;
    const walk = async () => {
      for (let i = 0; i < 30; i++) {
        await st.settled(id); s = st.get(id).session;
        if (s.state !== 'paused') return;
        if (!upgraded && s.hops.length === 4 && s.hops[3].agentId === 'drafter') {
          upgraded = true; toLegacy(); st = R.mk();
          const w = st._sessions()[0]._w;
          A.eq(w.openLoops, undefined, 'legacy: the reloaded session has no openLoops');
          A.eq(w.looping, true, 'legacy: and is paused inside the loop pass');
        }
        st.continue(id, {});
      }
    };
    await walk();
    A.ok(upgraded, 'legacy: the session was paused after the drafter\'s second pass and reloaded');
    A.eq(s.hops.map(h => h.agentId).join(' > '), 'drafter > editor > reviewer > drafter > editor > reviewer > publisher', 'legacy: the pass walks on through the editor and the reviewer');
    A.eq(s.state, 'done', 'legacy: the test finishes (' + s.error + ')');
    // rewind onto the drafter's second pass (a step whose saved walk predates the update) and walk it again
    A.ok(st.rewind(id, { hop: 3 }).ok, 'legacy: rewind onto a pre-update step');
    await walk();
    A.eq(s.hops.map(h => h.agentId).join(' > '), 'drafter > editor > reviewer > drafter > editor > reviewer > publisher', 'legacy rewind: the same walk');
    A.eq(s.state, 'done', 'legacy rewind: finishes (' + s.error + ')');
  }

  A.report('routing.steptest');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
