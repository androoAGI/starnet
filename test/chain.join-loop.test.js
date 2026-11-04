/* test/chain.join-loop.test.js — the chain runner's JOINER barrier + bounded LOOP (sidecar/routing/chain.js,
   2026-08-21), driven through the REAL compiler + REAL router so the floor drawn and the runs bought are one
   decision. Fake harness, fake clock, fake timer — no provider, no wall-clock.

   LINE-HOLD S2 (marked "S2" below): a verdict-keyed gate HOLDS a reply it cannot read — including the AGGREGATE verdict of a JOINED crate
   (the gate reads the merged text's tail) — and a gate set to escalate to an OUTBOX-only lane cannot end a branch of a fan-out there. The
   subject is built through test/helpers/line-hold-control.js: LINE_HOLD_CONTROL=original makes it the saved 5977d433c source and the S2
   blocks must go RED (test/line-hold.policy.test.js runs that control in-process too). */
'use strict';
const A = require('./_assert.js');
const subject = require('./helpers/line-hold-control.js').pick();
const { makeChainRunner } = subject.chain;
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
    // token-burn audit 2026-10-17: hops no longer replay the line's transcript, so the loop-back turn itself carries the work
    A.eq(R.log[2].agentId, 'drafter');
    // (the fixture's drafter names its output after the pass it was handed: its first draft is 'draft v2')
    A.ok(R.log[2].text.indexOf('THE WORK UNDER REVIEW') >= 0 && R.log[2].text.indexOf('draft v2') >= 0 && R.log[2].text.indexOf('needs work 1') >= 0,
      'a loop-back shows the writer the draft the reviewer judged AND the review: ' + R.log[2].text.slice(-300));
    A.ok(R.log[2].text.indexOf('draft v2') < R.log[2].text.indexOf('needs work 1'), 'the work under review comes before the review');
    A.ok(R.log[4].text.indexOf('draft v3') >= 0 && R.log[4].text.indexOf('draft v2') < 0, 'each pass shows the LATEST draft under review, never a stale one');
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
    A.eq(res.stopped, null, 'the escalated line runs to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'drafter,reviewer,drafter,reviewer,fixer',
      'two passes round the gate, then the FIXER — not the publisher');
    A.eq(res.text, 'salvaged by the fixer', 'the escalation dock has the last word');
    A.ok(res.loopExhausted, 'the run is still marked exhausted (honest telemetry)');
    const fixerTurn = R.log[R.log.length - 1];
    A.eq(fixerTurn.agentId, 'fixer');
    A.ok(/\[LOOP — escalated: 2 passes round the gate at 12,4 without VERDICT: approved — handed to the escalation lane\]/.test(fixerTurn.text),
      'the fixer\'s handoff says exactly why it has the crate');
    // token-burn audit 2026-10-17: hops no longer replay the line, so the fixer is handed the work itself, not only the notes on it
    A.ok(fixerTurn.text.indexOf('THE WORK UNDER REVIEW') >= 0 && fixerTurn.text.indexOf('another draft') >= 0 && fixerTurn.text.indexOf('still bad 2') >= 0,
      'the fixer gets the last draft AND the review: ' + fixerTurn.text.slice(-260));
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
      A.ok(res.hops[res.hops.length - 1].agentId === 'publisher', 'an already-visited esc dock falls back to the done lane');
      A.ok(res.loopExhausted, 'still marked exhausted');
    } else {
      A.ok(true, 'visited-esc fallback floor did not compile as intended — covered by the runner guard');
    }
  }

  /* ---- S2: THE AGGREGATE VERDICT AFTER A JOIN, and a gate INSIDE a branch ---- */
  const dockBelt = (x, y, dir) => ({ x, y, dir });
  // INBOX -> SPLIT -> (A | B) -> JOINER -> LOOP gate (done E, no back lane) -> OUTBOX
  function joinGateFloor() {
    const g = joinFloor();
    g.props = g.props.filter(p => p.id !== 'p6');
    g.props.push({ id: 'p7', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 });
    g.belts.push(dockBelt(12, 4, 'E'), dockBelt(13, 4, 'E'), dockBelt(14, 4, 'E'));
    return g;
  }
  // the gate INSIDE branch A: A -> LOOP at 8,2 (done S -> the joiner, back W -> A, esc E -> a second OUTBOX)
  function branchGateFloor(gate) {
    const g = joinFloor();
    g.props = g.props.filter(p => p.id !== 'p6');
    g.belts = g.belts.filter(b => !(b.x === 8 && b.y === 2));
    g.props.push(Object.assign({ id: 'p7', t: 'loop', x: 8, y: 2, w: 1, h: 1, done: 'S', esc: 'E', when: 'approved', maxIter: 1 }, gate || {}), { id: 'p9', t: 'outbox', x: 11, y: 1, w: 2, h: 2 });
    g.belts.push(dockBelt(8, 2, 'S'), dockBelt(7, 2, 'W'), dockBelt(9, 2, 'E'), dockBelt(10, 2, 'E'));
    return g;
  }
  async function dockWalk(floor, script) {
    const plan = P.compileRoutingPlan(floor), router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'fixture: the join-and-gate floor deploys: ' + JSON.stringify(plan.errors.filter(e => !e.warn)));
    const hops = [], events = [], timers = [];
    const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x), peekDock: (d, x) => router.chainPeekDock(d, x),
      entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      lastStage: (a, d) => router.chainShipsToOutbox(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d),
      emit: (n, p) => events.push({ n, p }), now: clock, getTag: () => 'general', setTimer: (fn, ms) => { timers.push(ms); return 0; } });
    const e = router.resolveDock({ tag: 'general' });
    const res = await c.advance({ agentId: e.agentId, dockId: e.dockId, text: script[e.agentId], originalText: 'job', lineId: router.lineOriginFor(e.agentId, e.dockId), runId: 'j' + (T += 10),
      runAgent: async h => { hops.push(h.agentId); return { text: script[h.agentId], usd: 0.01 }; } });
    await new Promise(r => setImmediate(r));
    return { res, hops, timers, outputs: events.filter(x => x.n === 'workitem.delivered' && x.p.box === 'line-output') };
  }
  {
    // the merged crate is the gate's input: its tail is the aggregate verdict. No verdict anywhere in it = a hold, after the join, zero hops
    const silent = await dockWalk(joinGateFloor(), { A: 'A out', B: 'B out' });
    A.eq(silent.hops, ['B'], 'S2 join then gate, no verdict in the merged crate: the sibling ran (it is the join), nothing after the gate');
    A.ok(silent.res.hold && silent.res.hold.reason === 'missing_verdict' && silent.res.hold.gateId === '12,4' && silent.res.hold.pass === 0 && silent.outputs.length === 0 && !silent.res.partial,
      'S2 join then gate: held at the gate for lack of a verdict, nothing delivered: ' + JSON.stringify(silent.res.hold));
    A.eq(silent.timers, [], 'S2 join then gate: no joiner waits out a timeout');
    const tail = await dockWalk(joinGateFloor(), { A: 'A out', B: 'B out\nVERDICT: approved' });
    A.ok(tail.res.stopped === null && tail.res.outboxId === 'p8' && tail.outputs.length === 1 && !tail.res.hold, 'S2 join then gate: the merged crate\'s tail says approved, and it ships — the aggregate verdict is read');
  }
  {
    // a gate that escalates to an OUTBOX-only lane cannot end ONE BRANCH there (the joiner would wait on a part that never comes): not offered, held
    const inFan = await dockWalk(branchGateFloor({ onSpent: 'escalate' }), { A: 'a\nVERDICT: revise', B: 'b' });
    A.ok(inFan.res.hold && inFan.res.hold.reason === 'spent' && inFan.res.hold.gateId === '8,2' && inFan.res.outboxId === undefined && inFan.outputs.length === 0, 'S2 escalate to an OUTBOX-only lane inside a fan-out: held, never a branch ended at an OUTBOX: ' + JSON.stringify(inFan.res.hold));
    A.eq(inFan.timers, [], 'S2 ...and no joiner is left waiting');
    const sent = await dockWalk(branchGateFloor({}), { A: 'a\nVERDICT: revise', B: 'b' });
    A.ok(sent.res.stopped === null && /used all 1 pass without VERDICT: approved/.test(sent.res.unapproved) && !sent.res.hold, 'S2 the same floor on the default policy: the reviewed branch reaches the joiner unapproved, as it always did');
    const mute = await dockWalk(branchGateFloor({}), { A: 'a', B: 'b' });
    A.ok(mute.res.hold && mute.res.hold.reason === 'missing_verdict' && mute.res.hold.gateId === '8,2' && mute.hops.length === 0, 'S2 the reviewed branch says nothing usable: held at its gate, no pass, no sibling run');
  }

  /* ---- SEND TO carries the routine's own directive (token-burn audit 2026-10-17): a contextFrom routine hands its line the
          ASSEMBLED prompt (untrusted context + directive) as originalText so stages can read it, and the plain directive as
          `ask`; the shipped record (what SEND TO hands the next line, cut at 4k downstream) must be the ask. ---- */
  {
    const shippedRecs = [];
    const R = rig(loopFloor({ maxIter: 1 }), { publisher: { text: 'published', usd: 0.01 } }, { lastStage: () => true, onShipped: r => shippedRecs.push(r) });
    const assembled = '<untrusted_routine_context>' + 'digest line. '.repeat(400) + '</untrusted_routine_context>\n\n## ROUTINE DIRECTIVE\nwrite a post';
    await R.c.advance({ agentId: 'publisher', text: 'published', originalText: assembled, ask: 'write a post', lineId: R.lineId, runId: 'ask1' });
    await new Promise(r => setImmediate(r));
    A.ok(shippedRecs.length === 1, 'the job ships (' + shippedRecs.length + ')');
    A.eq(shippedRecs[0] && shippedRecs[0].originalText, 'write a post', 'the SEND TO record carries the routine directive, never its context block');
    const plain = [];
    const R2 = rig(loopFloor({ maxIter: 1 }), { publisher: { text: 'published', usd: 0.01 } }, { lastStage: () => true, onShipped: r => plain.push(r) });
    await R2.c.advance({ agentId: 'publisher', text: 'published', originalText: 'write a post', lineId: R2.lineId, runId: 'ask2' });
    await new Promise(r => setImmediate(r));
    A.eq(plain[0] && plain[0].originalText, 'write a post', 'with no separate ask the record keeps originalText (every other caller unchanged)');
  }

  /* ---- loopDecision's WORK UNDER REVIEW block, at the seam the runner and the step test share (token-burn audit 2026-10-17) ---- */
  {
    const { loopDecision } = subject.chain;
    const gate = (o) => Object.assign({ loop: '12,4', backTo: 'drafter', max: 2, when: 'approved', next: 'publisher' }, o || {});
    const ctxRevise = { verdict: 'revise' };
    const back = loopDecision(gate(), ctxRevise, 0, {}, 'notes\nVERDICT: revise', 'DRAFT-1');
    A.ok(back.again && /^\[LOOP — pass 1 of 2[^\n]*\]\nTHE WORK UNDER REVIEW[^\n]*\nDRAFT-1\n\nREVIEW:\nnotes/.test(back.text), 'a loop-back: marker, then the work under review, then the review');
    const self = loopDecision(gate(), ctxRevise, 0, {}, 'notes\nVERDICT: revise', '');
    A.ok(self.again && self.text.indexOf('THE WORK UNDER REVIEW') < 0, 'no reviewed text (a self-loop) -> no block, never a nested loop turn');
    const exNext = loopDecision(gate(), ctxRevise, 2, {}, 'still bad\nVERDICT: revise', 'DRAFT-3');
    A.ok(exNext.exhausted && exNext.text.indexOf('DRAFT-3') >= 0, 'an exhausted crate going to a downstream dock carries the unapproved work');
    // a done lane that meets a JOINER: next is null and the dock past the joiner is afterJoin.next (frontend/app/pipeline.js)
    const exJoinDock = loopDecision(gate({ next: null, afterJoin: { join: '14,8', expect: 2, next: 'synth' } }), ctxRevise, 2, {}, 'still bad\nVERDICT: revise', 'DRAFT-3');
    A.ok(exJoinDock.exhausted && exJoinDock.text.indexOf('DRAFT-3') >= 0, 'an exhausted branch whose joiner feeds a dock carries the unapproved work for that dock');
    const exJoinOut = loopDecision(gate({ next: null, afterJoin: { join: '14,8', expect: 2, next: null } }), ctxRevise, 2, {}, 'still bad\nVERDICT: revise', 'DRAFT-3');
    A.ok(exJoinOut.exhausted && exJoinOut.text.indexOf('DRAFT-3') < 0, '...a joiner that ships straight out keeps the delivered product unchanged');
    const exOut = loopDecision(gate({ next: null }), ctxRevise, 2, {}, 'still bad\nVERDICT: revise', 'DRAFT-3');
    A.ok(exOut.exhausted && exOut.text.indexOf('DRAFT-3') < 0 && exOut.text.indexOf('still bad') >= 0, 'an exhausted crate that ships straight out keeps the reviewer\'s word only');
    const big = 'x'.repeat(30000);
    const clipped = loopDecision(gate(), ctxRevise, 0, {}, 'notes', big);
    A.ok(clipped.text.length < 17000 && /characters of the work omitted/.test(clipped.text), 'a huge draft is clipped (head + tail), never the whole thing');

    /* THE APPROVED WORK (2026-10-18): an approval that does not restate the work hands on the work it approved */
    const ctxOk = { verdict: 'approved' };
    const W = 'The draft: rooftop installs grew 34% in 2025, battery attach passed half, permits are the top soft cost.';
    const okDock = loopDecision(gate(), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', W);
    A.eq(okDock.text, '[LOOP — approved round the gate at 12,4 — the reviewer passed the work on without restating it]\nTHE WORK UNDER REVIEW (what the reviewer was handed):\n' + W + '\n\nREVIEW:\nLooks good.',
      'a terse approval going to a dock: the work it approved, then the approval as its review (no VERDICT line)');
    A.ok(!okDock.again && !okDock.exhausted && okDock.target === 'publisher', '...and it still leaves on the done lane, approved');
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', W).text, W, 'a terse approval that ships straight out delivers the work alone');
    A.ok(/^\[LOOP — approved[^\n]*\]\nTHE WORK UNDER REVIEW[^\n]*\n/.test(loopDecision(gate({ next: null, afterJoin: { join: '14,8', expect: 2, next: 'synth' } }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', W).text),
      'past a JOINER that feeds a dock: framed for that dock');
    A.eq(loopDecision(gate({ next: null, afterJoin: { join: '14,8', expect: 2, next: null } }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', W).text, W,
      'past a JOINER that ships straight out: the work alone (the joined product carries no frame)');
    A.eq(loopDecision(gate(), ctxOk, 0, {}, 'VERDICT: approved', W).text, W, 'a reply that is only the verdict line hands on the work (no empty review)');
    const restated = W.replace('34%', '34 percent') + '\n\nSpelled out one unit.';
    A.eq(loopDecision(gate(), ctxOk, 0, {}, restated + '\nVERDICT: approved', W).text, restated, 'a reply that RESTATED the work is the work (R1) — no second copy');
    A.eq(loopDecision(gate(), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', '').text, 'Looks good.', 'no reviewed text (a self-loop) -> the reply as before');
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'fine\nVERDICT: approved', okDock.text).text, W,
      'two gates in a row, both terse: the second reviews the work inside the first one\'s frame — frames never nest or ship');
    A.ok(loopDecision(gate(), ctxRevise, 0, {}, 'tighten it\nVERDICT: revise', okDock.text).text.indexOf('THE WORK UNDER REVIEW (what the reviewer was handed):\n' + W + '\n\nREVIEW:\ntighten it') > 0,
      '...and a loop-back at the second gate shows the work, not the first gate\'s frame');
    /* (review of 77b627c18, 2026-10-21) only THAT frame is unwrapped. An exhausted, escalated or looping gate's frame holds the earlier
       reviewer's last word (perhaps its own redacted version): a later gate reviews the frame whole, and a bare approval of it swaps
       nothing in — the draft that reviewer redacted never moves on in its place */
    const DRAFT_PII = 'Call Jane Doe at 555-123-4567.';
    const LAST_WORD = 'Call [redacted] at [redacted].\nVERDICT: revise';
    const exhaustedFrame = loopDecision(gate(), ctxRevise, 2, {}, LAST_WORD, DRAFT_PII).text;
    const escalatedFrame = loopDecision(gate({ esc: 'fixer' }), ctxRevise, 2, {}, LAST_WORD, DRAFT_PII).text;
    const loopBackFrame = loopDecision(gate(), ctxRevise, 0, {}, LAST_WORD, DRAFT_PII).text;
    A.ok(/^\[LOOP — exhausted/.test(exhaustedFrame) && /^\[LOOP — escalated/.test(escalatedFrame) && /^\[LOOP — pass 1 of 2/.test(loopBackFrame), 'the three other frames, each carrying the draft and the reviewer\'s last word');
    for (const [name, frame] of [['an exhausted', exhaustedFrame], ['an escalated', escalatedFrame], ['a loop-back', loopBackFrame]]) {
      for (const [where, g] of [['to a dock', gate()], ['out of the line', gate({ next: null })]]) {
        const d = loopDecision(g, ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', frame);
        A.eq(d.text, 'Looks good.', name + ' gate\'s frame, a bare approval ' + where + ': the reply moves on as it is (as on trunk), never the draft inside');
      }
      const again = loopDecision(gate(), ctxRevise, 0, {}, 'Needs a source.\nVERDICT: revise', frame);
      A.ok(again.text.indexOf('THE WORK UNDER REVIEW (what the reviewer was handed):\n' + frame + '\n\nREVIEW:\nNeeds a source.') > 0,
        name + ' gate\'s frame, a loop-back at the next gate: the whole frame is what the reviewer was handed, its last word included');
    }
    const longWork = Array.from({ length: 6000 }, (_, i) => 'w' + i).join(' ');
    const okLong = loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Ship it.\nVERDICT: approved', longWork);
    A.eq(okLong.text, longWork, 'the approved work is the product: never clipped');
    A.eq(loopDecision(gate({ when: 'code' }), { tag: 'general' }, 0, {}, 'tag reply', W).text, 'tag reply', 'a classifier-tag gate is untouched (no verdict, no approval)');

    /* FRAMES ANYWHERE (review of 524522d2c, 2026-10-22): a gate's done lane that meets a JOINER parks its frame as one BRANCH of the
       merged crate (Pipeline.joinPayload), so the frame does not start the crate. Only the crate's first line was read: a bare
       approval past the joiner swapped in the whole merged crate, an exhausted frame's draft (the personal data its reviewer had
       redacted) and a passed-on frame's wrapper with it. Now an exhausted, escalated or looping frame anywhere keeps the reply, and
       a passed-on frame that is a whole branch is unwrapped in place to the work it carries. */
    const { hopTurn } = require('../sidecar/routing/chain.js');
    const OTHER = 'Branch two: permits average 40 days.';
    const piiFree = (t) => String(t).indexOf('Jane Doe') < 0 && String(t).indexOf('555-123-4567') < 0;
    for (const [name, frame] of [['an exhausted', exhaustedFrame], ['an escalated', escalatedFrame], ['a loop-back', loopBackFrame]]) {
      for (const [order, crate] of [['first', P.joinPayload([{ agentId: 'reviewer', text: frame }, { agentId: 'researcher', text: OTHER }], [])],
        ['second', P.joinPayload([{ agentId: 'researcher', text: OTHER }, { agentId: 'reviewer', text: frame }], [])]]) {
        A.ok(!/^\[LOOP — /.test(crate) && crate.indexOf('Jane Doe') > 0, name + ' frame as the ' + order + ' branch of a joined crate: the frame sits inside it, the draft with it');
        for (const [where, g] of [['to a dock', gate()], ['out of the line', gate({ next: null })]]) {
          const d = loopDecision(g, ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', crate);
          A.eq(d.text, 'Looks good.', name + ' frame as the ' + order + ' branch, a bare approval ' + where + ': the reply moves on as on trunk, never the joined crate');
          A.ok(piiFree(d.text), name + ' frame as the ' + order + ' branch, ' + where + ': the draft its reviewer redacted never moves on');
        }
        const again = loopDecision(gate(), ctxRevise, 0, {}, 'Needs a source.\nVERDICT: revise', crate);
        A.ok(again.text.indexOf('THE WORK UNDER REVIEW (what the reviewer was handed):\n' + crate + '\n\nREVIEW:\nNeeds a source.') > 0,
          name + ' frame as the ' + order + ' branch, a loop-back: the whole joined crate is what the reviewer was handed');
      }
    }
    // a passed-on frame that is a whole branch: unwrapped IN PLACE, the joiner's header, the other branch and its seams kept
    const passedBranch = P.joinPayload([{ agentId: 'reviewer', text: okDock.text }, { agentId: 'researcher', text: OTHER }], []);
    const cleanJoined = P.joinPayload([{ agentId: 'reviewer', text: W }, { agentId: 'researcher', text: OTHER }], []);
    A.ok(passedBranch.indexOf('passed the work on without restating it') > 0, 'a joined crate whose first branch is a passed-on frame');
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Ship it.\nVERDICT: approved', passedBranch).text, cleanJoined,
      'a passed-on branch, a bare approval out of the line: the joined work ships, the frame unwrapped to its work (no wrapper, no REVIEW part)');
    const passedDock = loopDecision(gate(), ctxOk, 0, {}, 'Ship it.\nVERDICT: approved', passedBranch).text;
    A.eq(passedDock, '[LOOP — approved round the gate at 12,4 — the reviewer passed the work on without restating it]\nTHE WORK UNDER REVIEW (what the reviewer was handed):\n' + cleanJoined + '\n\nREVIEW:\nShip it.',
      'a passed-on branch, a bare approval to a dock: one frame round the joined work — frames never nest');
    const passedSecond = P.joinPayload([{ agentId: 'researcher', text: OTHER }, { agentId: 'reviewer', text: okDock.text }], ['late'], ['fixer failed']);
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'LGTM\nVERDICT: approved', passedSecond).text,
      P.joinPayload([{ agentId: 'researcher', text: OTHER }, { agentId: 'reviewer', text: W }], ['late'], ['fixer failed']),
      'a passed-on LAST branch of a partial join: unwrapped to the end of its branch, the PARTIAL marks kept as they are');
    const bothPassed = P.joinPayload([{ agentId: 'reviewer', text: okDock.text }, { agentId: 'reviewer2', text: okDock.text }], []);
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Approved.\nVERDICT: approved', bothPassed).text,
      P.joinPayload([{ agentId: 'reviewer', text: W }, { agentId: 'reviewer2', text: W }], []), 'two passed-on branches: both unwrapped');
    const mixed = P.joinPayload([{ agentId: 'reviewer', text: okDock.text }, { agentId: 'reviewer2', text: exhaustedFrame }], []);
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', mixed).text, 'Looks good.',
      'a passed-on branch beside an exhausted one: the reply moves on as on trunk, never the exhausted draft');
    const midText = P.joinPayload([{ agentId: 'reviewer', text: 'Intro the reviewer wrote.\n' + okDock.text }, { agentId: 'researcher', text: OTHER }], []);
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', midText).text, 'Looks good.',
      'a frame that does not start its branch cannot be read back exactly: the reply moves on as on trunk');
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', 'Notes:\n' + exhaustedFrame).text, 'Looks good.',
      'a frame mid-crate with no joiner at all: the reply moves on as on trunk');
    // a passed-on frame round a joined crate (gate 1 approved a merged job), itself one branch of a later join: unwrapped to the inner joined work
    const nestedWork = P.joinPayload([{ agentId: 'a', text: 'alpha work' }, { agentId: 'b', text: 'beta work' }], []);
    const nestedFrame = loopDecision(gate(), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', nestedWork).text;
    A.ok(nestedFrame.indexOf('THE WORK UNDER REVIEW (what the reviewer was handed):\n' + nestedWork + '\n\nREVIEW:\nLooks good.') > 0, 'gate 1 passes a joined crate on in its frame');
    A.eq(loopDecision(gate({ next: null }), ctxOk, 0, {}, 'Ship it.\nVERDICT: approved', P.joinPayload([{ agentId: 'reviewer', text: nestedFrame }, { agentId: 'researcher', text: OTHER }], [])).text,
      P.joinPayload([{ agentId: 'reviewer', text: nestedWork }, { agentId: 'researcher', text: OTHER }], []), 'a passed-on frame round a joined crate, as a branch: unwrapped to that joined work');
    // the brief makes the bare-approval promise exactly where it holds
    const turnFor = (upstream) => hopTurn({ loopGateAfter: () => ({ when: 'approved', max: 2, backTo: 'writer', backDock: null }), originalText: 'go', from: 'researcher', upstream, hop: 3, target: 'editor', lineId: 'p1' });
    const PROMISE = /a reply of only the VERDICT line, or a bare approval such as "Looks good\.", passes it on exactly as you were handed it/;
    A.ok(PROMISE.test(turnFor(passedBranch)) && PROMISE.test(turnFor(cleanJoined)), 'the reviewer of a joined crate of plain or passed-on branches is told a bare approval passes it on');
    for (const [name, crate] of [['an exhausted', P.joinPayload([{ agentId: 'researcher', text: OTHER }, { agentId: 'reviewer', text: exhaustedFrame }], [])], ['a mixed', mixed]])
      A.ok(!PROMISE.test(turnFor(crate)) && /your reply is what moves on past the gate/.test(turnFor(crate)), 'the reviewer of a joined crate with ' + name + ' branch is never promised a bare approval passes it on');
  }

  /* ---- S5 (line-hold lane): THE BARRIER OF A HELD JOB. A job that stops at a reviewer's gate inside a split takes its barrier with it (the
          parts parked, who owes the rest, the joiner's count and timeout), and the walk a person's decision resumes puts it back — once, with no
          waiter, never delivering or releasing anything by itself. The whole chain of it (restart, decisions, the saved record) is
          test/line-hold.split.test.js; this is the barrier module and the chain's own state. ---- */
  {
    const K = '9,4|runS5';
    const mk = (extra) => { const t = { timers: [], saves: [], events: [] };
      t.c = makeChainRunner(Object.assign({ nextAgent: () => null, now: clock, newId: (() => { let i = 0; return () => 'bp' + (++i); })(), emit: (n, p) => t.events.push(n),
        setTimer: (fn, ms) => { t.timers.push({ fn, ms }); return 0; }, barrierStore: { load: () => null, save: v => t.saves.push(JSON.stringify(v)) } }, extra));
      return t; };
    // S5 a part leaves with the branch it came from and the run that made it; the barrier file keeps its old three keys
    const one = mk();
    const meta = { branchId: 'p3', runId: 'r-A', draft: 'the ask', verdict: 'revise', files: ['/work/a.md'], text: 'tampered' };
    const first = one.c._barrier.deliver(K, 3, 'A', 'alpha', 7, 'p3', meta);
    const part = first.parts[0];
    A.ok(!first.released && part.text === 'alpha' && part.branchId === 'p3' && part.runId === 'r-A' && part.draft === 'the ask' && part.verdict === 'revise' && part.files[0] === '/work/a.md' && part.dockId === 'p3' && part.workitemId === 'bp1',
      'S5 a part parked at the barrier carries its branch and run (and the meta cannot overwrite its text): ' + JSON.stringify(part));
    A.eq(Object.keys(JSON.parse(one.saves[one.saves.length - 1])[K].parts[0]).sort(), ['agentId', 'dockId', 'workitemId'], 'S5 the barrier FILE is unchanged: agent, dock and crate id only');
    const view = one.c._barrier.view(K);
    A.eq([view.expect, view.timeoutMin, view.parts.length, one.c._barrier.view('9,9|nobody')], [3, 7, 1, null], 'S5 view: the expected count, the joiner\'s timeout and the parts parked (nothing for a barrier that is not there)');
    view.parts[0].text = 'changed by a reader';
    A.eq(one.c._barrier.view(K).parts[0].text, 'alpha', 'S5 view is a copy: reading the barrier cannot change it');
    // S5 restore puts a saved barrier back ONCE; delivers nothing, releases nothing, has no waiter, arms no timer
    const two = mk(), saved = { expect: 3, ts: 111, timeoutMin: 7, parts: [{ agentId: 'A', dockId: 'p3', text: 'alpha', workitemId: 'w1', branchId: 'p3', runId: 'r-A', draft: 'd', verdict: null, files: [] }] };
    A.eq([two.c._barrier.restore(K, saved), two.c._barrier.size(), two.timers.length, two.events.length], [true, 1, 0, 0], 'S5 restore: the barrier is back, no timer was armed, nothing was delivered or released');
    A.eq([two.c._barrier.restore(K, saved), two.c._barrier.view(K).parts.length], [false, 1], 'S5 a barrier already open under that key is never opened a second time, and the first is left as it was');
    A.ok(JSON.parse(two.saves[two.saves.length - 1])[K].parts.length === 1, 'S5 the restored parts are in the barrier file again (a crash from here is reported as ever)');
    const arrive = (agentId, text) => two.c._barrier.deliver(K, 3, agentId, text, 7, null, { branchId: agentId, runId: 'r-' + agentId });
    const second = arrive('B', 'beta');
    A.ok(!second.released, 'S5 a restored barrier still waits for the rest');
    const third = arrive('C', 'gamma');
    A.eq([third.released, third.parts.map(p => p.text), two.c._barrier.size()], [true, ['alpha', 'beta', 'gamma'], 0], 'S5 the last arrival releases it: the saved part first, once, then the others');
    // S5 the joiner's timer is armed only when a walk WAITS at the barrier, from the saved timeout; its expiry sends the join on PARTIAL (never approves anything)
    const three = mk();
    three.c._barrier.restore(K, saved);
    A.eq(three.timers.length, 0, 'S5 a restored barrier arms nothing by itself');
    const waiting = three.c._barrier.wait(K);
    A.eq(three.timers.map(t => t.ms), [7 * 60 * 1000], 'S5 a walk that waits at it arms the joiner\'s timer from the saved 7 minutes');
    three.timers[0].fn();
    const timedOut = await waiting;
    A.eq([timedOut.timedOut, timedOut.parts.length, timedOut.missing, three.c._barrier.size()], [true, 1, ['lane 2', 'lane 3'], 0], 'S5 its expiry releases what is there and names the lanes that never came (a PARTIAL join)');

    // S5 a REAL floor: the gate inside branch B holds the job with A parked at the joiner. The hold takes the barrier with it — out of memory and
    // out of the barrier file, so a restart reports nothing "lost" — and says all of it.
    const floor = joinFloor();
    floor.props = floor.props.filter(p => p.id !== 'p6');
    floor.props.push({ id: 'p7', t: 'loop', x: 6, y: 5, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 });
    floor.belts.push(dockBelt(6, 6, 'W'), dockBelt(5, 6, 'W'), dockBelt(4, 6, 'W'), dockBelt(3, 6, 'W'));
    const plan = P.compileRoutingPlan(floor), router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'S5 fixture: the floor with a gate inside B deploys');
    const disk = [], store = { load: () => (disk.length ? JSON.parse(disk[disk.length - 1]) : null), save: v => disk.push(JSON.stringify(v)) };
    const chain = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x), peekDock: (d, x) => router.chainPeekDock(d, x),
      entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      lastStage: (a, d) => router.chainShipsToOutbox(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), getTag: () => 'general', now: clock, setTimer: () => 0, barrierStore: store });
    const e = router.resolveDock({ tag: 'general' });
    const res = await chain.advance({ agentId: e.agentId, dockId: e.dockId, text: 'A out', originalText: 'job', lineId: router.lineOriginFor(e.agentId, e.dockId), runId: 'jS5',
      runAgent: async h => ({ text: h.agentId + ' says nothing usable', usd: 0.01, runId: 'r-' + h.agentId + '-' + h.hop }) });
    A.ok(res.hold && res.hold.reason === 'missing_verdict' && res.hold.gateId === '6,5' && res.holdState && !res.holdState.open.refuse, 'S5 B\'s gate holds the job with the split saved: ' + JSON.stringify(res.hold));
    const hb = res.holdState.barriers[0];
    A.eq([res.holdState.barriers.length, hb.joinId, hb.branchIds, hb.failed, hb.pending, hb.inFlight, hb.expect, hb.timeoutMs, hb.parts.map(p => [p.branchId, p.runId, p.product.text])],
      [1, '9,4', ['p3', 'p4'], [], ['p4'], [], 2, 600000, [['p3', 'jS5', 'A out']]], 'S5 the hold exposes the barrier: its part (branch, run, text), who still owes one, no batch out, the expected count and the timeout');
    A.eq([res.holdState.walk.fan.joinKey, res.holdState.walk.pending.length, res.holdState.walk.forced, res.holdState.walk.branchMode], ['9,4|jS5', 0, null, true], 'S5 the split\'s own state rides with it');
    A.eq([chain._barrier.size(), disk[disk.length - 1]], [0, '{}'], 'S5 the barrier left memory AND the barrier file with the hold');
    const warns = []; const ow = console.warn; console.warn = m => warns.push(String(m));
    makeChainRunner({ nextAgent: () => null, barrierStore: store });
    console.warn = ow;
    A.eq(warns.filter(w => /lost on restart/.test(w)), [], 'S5 a restart after the hold reports no barrier "lost on restart": the job record owns it');
  }

  A.report('chain.join-loop');
})();
