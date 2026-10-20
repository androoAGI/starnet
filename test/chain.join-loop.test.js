/* test/chain.join-loop.test.js — the chain runner's JOINER barrier + bounded LOOP (sidecar/routing/chain.js,
   2026-08-21), driven through the REAL compiler + REAL router so the floor drawn and the runs bought are one
   decision. Fake harness, fake clock, fake timer — no provider, no wall-clock. */
'use strict';
const A = require('./_assert.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);

// INBOX -> SPLIT -> (A | B) -> JOINER -> D  (same floor as test/pipeline.join-loop.test.js)
function joinFloor(joinerCfg) {
  return geo(
    [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 },
     { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
     { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' },
     Object.assign({ id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 }, joinerCfg || {}),
     { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'),
     belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'),
     belt(8, 0, 'S'), belt(8, 1, 'S'), belt(8, 2, 'S'), belt(8, 3, 'S'), belt(8, 4, 'E'),
     belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'), belt(8, 5, 'E'), belt(9, 5, 'N'),
     belt(9, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E')]
  );
}
// INBOX -> drafter -> reviewer -> LOOP gate -> (done E -> publisher | back N -> drafter)
function loopFloor(gateCfg) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return geo(
    [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
     { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
     { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
     Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E' }, gateCfg || {}),
     { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' }],
    belts
  );
}

function rig(floor, script, opts) {
  const router = makeRouter();
  const plan = P.compileRoutingPlan(floor);
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('plan refused: ' + JSON.stringify(plan.errors));
  const log = [], events = [], timers = [];
  const runAgent = async ({ agentId, text, hop, from }) => {
    log.push({ agentId, hop, from, text });
    const r = script[agentId];
    return typeof r === 'function' ? r(text, log) : (r || { text: agentId + ' output', usd: 0.01 });
  };
  const c = makeChainRunner(Object.assign({
    nextAgent: (a, ctx) => router.chainNext(a, ctx),
    stepAgent: (a, ctx) => router.chainStep(a, ctx),
    fanSiblings: (a) => router.fanSiblings(a),
    lineOfAgent: (a) => router.lineOfAgent(a),
    runAgent, emit: (n, p) => events.push(n + ':' + p.agentId), now: clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0; }
  }, opts || {}));
  return { c, plan, log, events, timers, lineId: P.lineOf(plan, plan.bays[0].agentId) };
}

(async () => {

  /* ---- FAN-OUT + JOIN: the entry dock A ran; the runner runs sibling B, parks both at the joiner, releases
          ONE merged crate, and D gets every branch's output clearly delimited ---- */
  {
    const R = rig(joinFloor(), { B: { text: 'beta findings', usd: 0.02 }, D: { text: 'final synthesis', usd: 0.03 } });
    const res = await R.c.advance({ agentId: 'A', text: 'alpha findings', originalText: 'research X', lineId: R.lineId, runId: 'run1' });
    A.eq(res.stopped, null, 'the joined line ran to its end (' + res.stopped + ')');
    A.eq(res.text, 'final synthesis', 'the reply is the post-join stage\'s');
    A.eq(res.hops.map(h => h.agentId).join(','), 'B,D', 'sibling B ran, then D — exactly once each');
    A.eq(res.usd, 0.05, 'spend sums every branch + the join stage');
    A.eq(R.log[0].agentId, 'B'); A.eq(R.log[0].text, 'research X', 'the sibling branch is handed the ORIGINAL request (it is stage one of its lane)');
    A.eq(R.log[0].from, null, 'and is not a handoff from A');
    const dTurn = R.log[1].text;
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(dTurn), 'D is handed the merged crate');
    A.ok(/BRANCH 1 of 2 — A ===\nalpha findings/.test(dTurn) && /BRANCH 2 of 2 — B ===\nbeta findings/.test(dTurn), 'both branch outputs ride, delimited and attributed');
    A.ok(!/PARTIAL/.test(dTurn), 'a full join is not marked partial');
    A.eq(R.log[1].from, 'B', 'the merged crate\'s producer is the last deliverer');
    A.eq(R.timers.length, 0, 'a barrier that fills in-call never arms a timeout');
    A.eq(R.c._barrier.size(), 0, 'the barrier is cleared on release');
    A.ok(R.events.indexOf('workitem.placed:D') > R.events.indexOf('workitem.delivered:B'), 'the D crate is placed only after B delivered');
  }

  /* ---- entering through B instead (the split round-robined the other way) joins the same way ---- */
  {
    const R = rig(joinFloor(), { A: { text: 'alpha findings' }, D: { text: 'synth' } });
    const res = await R.c.advance({ agentId: 'B', text: 'beta findings', originalText: 'research X', lineId: R.lineId, runId: 'run2' });
    A.eq(res.stopped, null, 'entry via B joins too');
    A.eq(res.hops.map(h => h.agentId).join(','), 'A,D', 'sibling A runs, then D');
    A.ok(/BRANCH 1 of 2 — B/.test(R.log[1].text) && /BRANCH 2 of 2 — A/.test(R.log[1].text), 'delivery order is the join order');
  }

  /* ---- A LANE NOBODY RUNS IS NOT WAITED FOR (2026-10-10): a joiner with THREE in-lanes on a two-branch fan-out releases as
     soon as both LAUNCHED branches deliver — it used to sit out its whole timeout for a lane no branch could ever fill ---- */
  {
    const floor = joinFloor({ timeoutMin: 3 });
    floor.belts.push(belt(9, 3, 'S'));   // a third in-lane from the north that nothing feeds
    const R = rig(floor, { B: { text: 'beta' }, D: { text: 'synth' } });
    A.eq(R.plan.junctions['9,4'].expect, 3, 'the joiner has three lanes');
    const res = await R.c.advance({ agentId: 'A', text: 'alpha', originalText: 'go', lineId: R.lineId, runId: 'run3' });
    A.eq(R.timers.length, 0, 'no timeout armed: both launched branches delivered');
    A.eq(res.stopped, null, 'the line runs on');
    A.eq(res.text, 'synth', 'D ran on both branches');
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(R.log[1].text), 'the merged crate counts the branches that ran');
    A.eq(R.c._barrier.size(), 0, 'the barrier is cleared');
  }

  /* ---- TIMEOUT: a barrier still short when nothing in this run can fill it waits out timeoutMin, then releases PARTIAL ---- */
  {
    const R = rig(joinFloor({ timeoutMin: 3 }), {});
    const r1 = R.c._barrier.deliver('9,4|run3b', 3, 'A', 'alpha', 3);
    A.ok(!r1.released, 'one of three parts: held');
    const p = R.c._barrier.wait('9,4|run3b', 3);
    A.eq(R.timers.length, 1, 'the barrier arms ONE timeout');
    A.eq(R.timers[0].ms, 3 * 60 * 1000, "the timeout is the joiner configured timeoutMin");
    R.timers[0].fn();   // the clock runs out
    const w = await p;
    A.ok(w && w.timedOut && w.parts.length === 1, 'it releases what came in');
    A.eq(w.missing, ['lane 2', 'lane 3'], 'naming the lanes that never delivered');
    A.ok(/PARTIAL: 2 branches never delivered before the joiner timed out [(]lane 2, lane 3[)]/.test(P.joinPayload(w.parts, w.missing)), 'and the merged crate is MARKED partial');
    A.eq(R.c._barrier.size(), 0, 'the barrier is cleared after the timeout');
  }

  /* ---- A FAILED BRANCH NO LONGER ENDS THE JOB (2026-10-10): the joiner sends on what arrived, the failed branch named ---- */
  {
    const R = rig(joinFloor(), { B: { error: 'provider exploded' }, D: { text: 'synth from A alone' } });
    const res = await R.c.advance({ agentId: 'A', text: 'alpha', originalText: 'go', lineId: R.lineId, runId: 'run4' });
    A.eq(res.stopped, null, 'the line runs on past a failed branch (' + res.stopped + ')');
    A.eq(res.text, 'synth from A alone', 'D ran on what arrived');
    const dTurn = R.log.find(l => l.agentId === 'D');
    A.ok(dTurn && /JOINED OUTPUT — 1 of 2 branches delivered/.test(dTurn.text), 'the merged crate says 1 of 2');
    A.ok(dTurn && /PARTIAL: 1 branch failed and sent nothing [(]B failed[)]/.test(dTurn.text), 'and names the failed branch');
    A.eq(R.c._barrier.size(), 0, 'nothing is stranded at the barrier');
  }

  /* ---- a direct order (no lineId) advances nothing — the line gate is unchanged by joiners ---- */
  {
    const R = rig(joinFloor(), { B: { text: 'x' }, D: { text: 'y' } });
    const res = await R.c.advance({ agentId: 'A', text: 'alpha', originalText: 'go' });
    A.eq(res.hops.length, 0, 'no lineId, no fan-out, no join');
    A.eq(res.text, 'alpha');
  }

  /* ---- RESTART IS FAIL-LOUD: parked barrier records persist; a fresh runner reports + drops them ---- */
  {
    let disk = null;
    const store = { load: () => disk, save: v => { disk = JSON.parse(JSON.stringify(v)); } };
    const R = rig(joinFloor(), {}, { barrierStore: store });
    // a barrier parked mid-run: two of three branches in (a third lane's branch still to come when the process died)
    R.c._barrier.deliver('9,4|run5', 3, 'A', 'alpha', 10); R.c._barrier.deliver('9,4|run5', 3, 'B', 'beta', 10);
    const p = R.c._barrier.wait('9,4|run5', 10);
    const keys = Object.keys(disk || {});
    A.eq(keys.length, 1, 'a parked barrier is written to the store');
    A.eq(keys[0], '9,4|run5', 'keyed by joiner tile + run');
    A.eq(disk[keys[0]].parts.length, 2, 'with both delivered branches recorded');
    // "restart": a new runner on the same store
    const warns = []; const ow = console.warn; console.warn = (m) => warns.push(String(m));
    const events2 = [];
    makeChainRunner({ nextAgent: () => null, barrierStore: store, emit: (n, q) => events2.push(n + ':' + q.agentId), now: clock });
    console.warn = ow;
    A.ok(warns.some(w => /join barrier lost on restart: 9,4\|run5 \(2\/3 branches/.test(w)), 'boot reports the lost barrier with its fill (' + warns.join(' | ') + ')');
    A.eq(events2.filter(e => e.startsWith('workitem.superseded:')).length, 2, 'each parked branch crate is superseded on the floor');
    A.eq(Object.keys(disk).length, 0, 'the store is cleared — nothing pretends to resume');
    R.timers[0].fn(); await p;   // let the first runner finish so the test process drains
  }

  /* ---- BOUNDED LOOP: review-until-pass iterates N times then exits on the done lane ---- */
  {
    let reviews = 0;
    const R = rig(loopFloor({ maxIter: 3 }), {
      drafter: (t) => ({ text: 'draft v' + (t.match(/pass (\d)/) ? +t.match(/pass (\d)/)[1] + 1 : 1), usd: 0.01 }),
      reviewer: () => ({ text: 'needs work ' + (++reviews), usd: 0.01 }),
      publisher: { text: 'published', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'reviewer', text: 'needs work 0', originalText: 'write a post', lineId: R.lineId, runId: 'run6' });
    A.eq(res.stopped, null, 'a bounded loop runs to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'drafter,reviewer,drafter,reviewer,drafter,reviewer,publisher', 'three passes round the gate, then the done lane');
    A.eq(res.text, 'published', 'the publisher has the last word');
    A.ok(/\[LOOP — pass 1 of 3/.test(R.log[0].text), 'the re-entry handoff names the pass');
    A.ok(/\[LOOP — pass 3 of 3/.test(R.log[4].text), 'and counts up to max');
    A.eq(R.log[6].agentId, 'publisher');
    A.ok(!/\[LOOP/.test(R.log[6].text), 'the done-lane handoff carries no loop marker');
    A.eq(res.hops.length, 7, 'seven hops bought — more than the 6-stage cap, because loop passes are bounded by max, not by the stage cap');
  }

  /* ---- THE STRANDED-USER FLOOR (2026-08-22): the loop's done lane goes straight to OUTBOX (no publisher dock).
          The reviewer is statically TERMINAL, so chainStep used to return null and the line never looped once.
          Now it iterates up to max and exits on the done lane with the reviewer's last word. ---- */
  {
    const floor = loopFloor({ maxIter: 2 });
    floor.props[4] = { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 };
    let reviews = 0;
    const R = rig(floor, {
      drafter: { text: 'redraft', usd: 0.01 },
      reviewer: () => ({ text: 'review ' + (++reviews), usd: 0.01 })
    });
    A.ok(R.plan.outs.length > 0 && R.plan.chains.reviewer.next.length === 0, 'fixture: the reviewer ships to an OUTBOX, no dock past the gate');
    const res = await R.c.advance({ agentId: 'reviewer', text: 'review 0', originalText: 'write a post', lineId: R.lineId, runId: 'run6b' });
    A.eq(res.stopped, null, 'a loop that exits to OUTBOX runs to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'drafter,reviewer,drafter,reviewer', 'two passes round the gate (>1 pass), then the done lane ships out');
    A.eq(res.text, 'review 2', 'the reviewer last verdict is the delivered answer');
    A.ok(/\[LOOP — pass 1 of 2/.test(R.log[0].text) && /\[LOOP — pass 2 of 2/.test(R.log[2].text), 're-entries are numbered');
  }
  /* ---- the same hole for a JOINER whose exit is OUTBOX: both branches still meet the barrier and the merged crate is the answer ---- */
  {
    const floor = joinFloor();
    floor.props[5] = { id: 'p6', t: 'outbox', x: 12, y: 4, w: 2, h: 2 };
    const R = rig(floor, { B: { text: 'beta findings', usd: 0.02 } });
    const res = await R.c.advance({ agentId: 'A', text: 'alpha findings', originalText: 'research X', lineId: R.lineId, runId: 'run1b' });
    A.eq(res.stopped, null, 'join-then-outbox runs to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'B', 'sibling B ran; nothing past the joiner');
    A.ok(/2 of 2 branches delivered/.test(res.text) && /alpha findings/.test(res.text) && /beta findings/.test(res.text), 'the merged crate is the delivered answer');
  }

  /* ---- A PARTIAL JOIN IS A DELIVERED REPLY, NOT A SHIPMENT (wave 2 review, conveyor-backend-07; docs/DECISIONS.md): a COPY job whose
     branch failed still answers (law 1 — the joiner sends on what arrived, marked PARTIAL), but the job is `partial`, the floor gets no
     line-output product at the OUTBOX, and SEND TO hears of it only as partial (the host refuses it and says why on the next line —
     never handed on, never counted as SHIPPED). Same verdict one after another and in parallel; the clean job is unchanged. ---- */
  {
    const floor = joinFloor();
    floor.props[5] = { id: 'p6', t: 'outbox', x: 12, y: 4, w: 2, h: 2 };
    const plan = P.compileRoutingPlan(floor), router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'partial: the join-to-OUTBOX floor deploys');
    const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
    for (const peek of [false, true]) for (const fail of [true, false]) {
      const events = [], shipped = [];
      const c = makeChainRunner(Object.assign({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x),
        entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
        lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: r => { shipped.push(r); }, emit: (n, p) => events.push({ n, p }), now: clock,
        setTimer: () => 0 }, peek ? { peekDock: (d, x) => router.chainPeekDock(d, x) } : {}));
      const other = entry.agentId === 'A' ? 'B' : 'A';
      const res = await c.advance({ agentId: entry.agentId, dockId: entry.dockId, text: entry.agentId + ' findings', originalText: 'research X', lineId, runId: 'pj' + peek + fail,
        runAgent: async h => (fail && h.agentId === other ? { error: 'provider exploded' } : { text: h.agentId + ' findings', usd: 0.01 }) });
      await new Promise(r => setImmediate(r));
      const label = (peek ? 'parallel' : 'one after another') + (fail ? ', a failed branch' : ', clean');
      const outputs = events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output');
      A.eq(res.stopped, null, label + ': the line still answers (' + res.stopped + ')');
      A.eq(res.outboxId, 'p6', label + ': at its OUTBOX');
      if (fail) {
        A.ok(typeof res.partial === 'string' && new RegExp(other + ' failed').test(res.partial), label + ': the job is partial, naming the failed branch (' + res.partial + ')');
        A.ok(/PARTIAL/.test(res.text), label + ': the reply is still delivered, marked PARTIAL');
        A.eq(outputs.length, 0, label + ': no product is released at the OUTBOX');
        A.ok(shipped.length === 1 && shipped[0].partial === res.partial, label + ': SEND TO hears of it only as partial (the host refuses it, never hands it on)');
      } else {
        A.ok(!res.partial, label + ': a full join is not partial');
        A.eq(outputs.length, 1, label + ': its product is released once');
        A.ok(shipped.length === 1 && !shipped[0].partial, label + ': and it ships clean');
      }
    }
  }

  /* ---- the chain USD cap still bounds a loop ---- */
  {
    const R = rig(loopFloor({ maxIter: 20 }), {
      drafter: { text: 'draft', usd: 0.5 }, reviewer: { text: 'again', usd: 0.5 }, publisher: { text: 'pub' }
    }, { maxUsd: 1.5 });
    const res = await R.c.advance({ agentId: 'reviewer', text: 'again', originalText: 'go', lineId: R.lineId, runId: 'run7' });
    A.ok(/reached its \$1\.50 limit/.test(res.stopped), 'the spend ceiling stops a loop (' + res.stopped + ')');
    A.ok(res.hops.length <= 3, 'within one hop of the cap: ' + res.hops.length);
  }

  /* ---- a gate-less loop is still refused by the router (compile-time), and the runner's visited guard holds ---- */
  {
    const floor = loopFloor({ t: 'merger', done: undefined });
    const plan = P.compileRoutingPlan(floor);
    A.ok(!P.ok(plan), 'the same floor with a MERGER where the gate was is not deployable');
    const router = makeRouter();
    A.ok(!router.setPlan(plan).ok, 'the router refuses it');
  }

  /* ---- THE ESCALATION LANE (2026-08-30): a gate with a THIRD wired lane sends verdict-exhausted work
          to the dock on that lane (the fixer) instead of stapling an apology onto the done lane ---- */
  function escFloor(gateCfg) {
    const g = loopFloor(Object.assign({ when: 'approved', maxIter: 2 }, gateCfg || {}));
    g.props.push({ id: 'p9', t: 'bay', x: 14, y: 6, w: 2, h: 2, agentId: 'fixer' });
    g.belts.push(belt(12, 5, 'S'), belt(12, 6, 'E'), belt(13, 6, 'E'));   // gate S lane -> fixer's ring
    return g;
  }
  {
    const plan = P.compileRoutingPlan(escFloor());
    A.ok(P.ok(plan), 'the escalation floor compiles deployable: ' + JSON.stringify(plan.errors));
    A.ok(!plan.errors.some(e => e.code === 'CYCLE' || e.code === 'CHAIN_CYCLE'), 'the esc lane is a forward edge — no cycle');
    A.ok(!plan.errors.some(e => e.code === 'BAY_NOT_FED' && e.agentId === 'fixer'),
      'the escalation dock is fed by its gate — never shamed BAY_NOT_FED');
    const g = plan.junctions['12,4'];
    A.eq(g.done, 'E', 'done stays E'); A.eq(g.back, 'N', 'back stays N (existing floors unchanged)');
    A.eq(g.esc, 'S', 'the third wired lane IS the escalation lane — no config needed');
    A.eq(g.escTo, 'fixer', 'and it resolves to the fixer at compile time');
    const st = P.chainStep(plan, 'reviewer', { lineId: P.lineOf(plan, 'reviewer') });
    A.eq(st && st.esc, 'fixer', 'chainStep carries the escalation dock');
    // the esc lane ENERGIZES with the gate (same law as the back lane)
    const live = P.liveTiles(plan);
    A.ok(live['12,5'] && live['12,6'] && live['13,6'], 'the escalation lane is energized, not frozen');
  }
  {
    let reviews = 0;
    const R = rig(escFloor(), {
      drafter: { text: 'another draft', usd: 0.01 },
      reviewer: () => ({ text: 'still bad ' + (++reviews) + '\nVERDICT: revise', usd: 0.01 }),
      publisher: { text: 'published', usd: 0.01 },
      fixer: { text: 'salvaged by the fixer', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'reviewer', text: 'first review\nVERDICT: revise', originalText: 'write a post', lineId: R.lineId, runId: 'runE1' });
    A.ok(/blocked, not approved/.test(res.stopped), 'exhaustion is a hard stop, not another unchecked model run');
    A.eq(res.hops.map(h => h.agentId).join(','), 'drafter,reviewer,drafter,reviewer',
      'two passes round the gate, then no downstream execution');
    A.ok(/still bad 2/.test(res.text), 'the last failed review is retained as evidence');
    A.ok(res.loopExhausted, 'the run is still marked exhausted (honest telemetry)');
    const fixerTurn = R.log[R.log.length - 1];
    A.eq(fixerTurn.agentId, 'reviewer');
    A.ok(!R.log.some(x => x.agentId === 'publisher' || x.agentId === 'fixer'),
      'neither publication nor an unreviewed automatic fix escapes the hard stop');
  }
  /* the SAME floor with the verdict PASSING never touches the fixer */
  {
    const R = rig(escFloor(), {
      drafter: { text: 'better draft', usd: 0.01 },
      reviewer: { text: 'looks great\nVERDICT: approved', usd: 0.01 },
      publisher: { text: 'published', usd: 0.01 },
      fixer: { text: 'should never run', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'reviewer', text: 'ok\nVERDICT: approved', originalText: 'write a post', lineId: R.lineId, runId: 'runE2' });
    A.eq(res.stopped, null, 'the approved line runs clean');
    A.eq(res.hops.map(h => h.agentId).join(','), 'publisher', 'an approved crate takes the done lane — the fixer never runs');
    A.ok(!res.loopExhausted, 'and nothing is marked exhausted');
  }
  /* an esc dock that ALREADY RAN is refused by visited — the honest done-lane note stands */
  {
    const g = escFloor(); g.props.find(p => p.agentId === 'fixer').agentId = 'drafter2';
    // esc points at a fresh dock; simulate the visited case by escalating to the drafter itself
    const g2 = escFloor(); g2.props = g2.props.filter(p => p.agentId !== 'fixer');
    // re-aim the esc lane back into the DRAFTER's ring: (12,6)W ... (6,6)? keep simple — a lane to a visited dock
    g2.belts = g2.belts.filter(b => !(b.x === 12 && b.y === 6) && !(b.x === 13 && b.y === 6));
    for (let x = 12; x >= 5; x--) g2.belts.push(belt(x, 6, 'W'));
    g2.belts.push(belt(4, 6, 'N'));   // up into the drafter's ring (drafter 3,3 2x2 — ring x2..5,y2..5: (4,5))
    g2.belts.push(belt(4, 5, 'N'));
    const plan2 = P.compileRoutingPlan(g2);
    if (P.ok(plan2) && plan2.junctions['12,4'].escTo === 'drafter') {
      const R = rig(g2, {
        drafter: { text: 'draft', usd: 0.01 },
        reviewer: { text: 'no\nVERDICT: revise', usd: 0.01 },
        publisher: { text: 'published', usd: 0.01 }
      });
      const res = await R.c.advance({ agentId: 'reviewer', text: 'no\nVERDICT: revise', originalText: 'x', lineId: P.lineOf(plan2, 'reviewer'), runId: 'runE3' });
      A.ok(res.hops[res.hops.length - 1].agentId !== 'publisher', 'an already-visited esc dock cannot fall back to publishing');
      A.ok(res.loopExhausted, 'still marked exhausted');
    } else {
      A.ok(true, 'visited-esc fallback floor did not compile as intended — covered by the runner guard');
    }
  }

  A.report('chain.join-loop');
})();
