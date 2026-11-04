/* test/chain-audit-1010.test.js — chain-runner bugs the 2026-10-10 conveyor audit proved, pinned through the REAL compiler +
   router where a floor exists (fake harness, no provider):
     1. two review LOOP gates in a row: the outer gate's re-run used to stop at "the line loops back to style" — the inner gate
        letting work out lowered the loop pass the outer gate still had open;
     2. E-STOP / STOP while a JOINER waits: advance sat out the joiner's whole timeout (default 10 min) holding locks.
   LINE-HOLD S2 adds the two places a reviewer that says nothing usable meets these shapes (marked "S2"): the SECOND of two gates in a row, and
   the reviewer on one branch of a COPY section. Both HOLD at their own gate now (they used to read as 'revise'). The subject is built through
   test/helpers/line-hold-control.js: LINE_HOLD_CONTROL=original makes it the saved 5977d433c source and the S2 blocks must go RED there. */
'use strict';
const A = require('./_assert.js');
const { makeChainRunner } = require('./helpers/line-hold-control.js').pick().chain;
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');
const belt = (x, y, dir) => ({ x, y, dir });

(async () => {
  /* ---- 1. drafter ▸ factcheck ▸ LOOP ▸ style ▸ LOOP ▸ publisher, both back lanes to the drafter ---- */
  {
    const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
      belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
    for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
    belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
    belts.push(belt(17, 4, 'E'), belt(18, 4, 'E'), belt(19, 4, 'E'), belt(20, 4, 'E'), belt(21, 4, 'E'));
    belts.push(belt(19, 3, 'N'), belt(19, 2, 'N'), belt(19, 1, 'N'), belt(19, 0, 'W'));
    for (let x = 18; x >= 5; x--) belts.push(belt(x, 0, 'W'));
    belts.push(belt(4, 0, 'S'), belt(4, 1, 'S'), belt(4, 2, 'S'));
    const geo = { props: [
      { id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
      { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
      { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'factcheck' },
      { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'style' },
      { id: 'p7', t: 'loop', x: 19, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'p8', t: 'bay', x: 22, y: 3, w: 2, h: 2, agentId: 'publisher' }], belts };
    const plan = P.compileRoutingPlan(geo);
    A.eq(plan.errors.length, 0, 'the two-gate floor compiles clean');
    const router = makeRouter(); A.ok(router.setPlan(plan).ok, 'and deploys');
    let styleN = 0; const ran = [];
    const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepAgent: (a, x) => router.chainStep(a, x),
      stepDock: (d, x) => router.chainStepDock(d, x), entryDockOf: a => router.entryDockOf(a), fanSiblings: a => router.fanSiblings(a),
      fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d) });
    const out = await c.advance({ agentId: 'drafter', text: 'draft v1', originalText: 'write X', lineId: router.lineOfAgent('drafter'),
      runAgent: async (h) => { ran.push(h.agentId);
        if (h.agentId === 'factcheck') return { text: 'facts ok\nVERDICT: approved' };
        if (h.agentId === 'style') return { text: (++styleN === 1) ? 'tone off\nVERDICT: revise' : 'good\nVERDICT: approved' };
        return { text: h.agentId + ' out' }; } });
    A.eq(ran.join(' > '), 'factcheck > style > drafter > factcheck > style > publisher', 'the outer gate sends it round once, then on to the publisher');
    A.eq(out.stopped, null, 'the line runs to its end (' + out.stopped + ')');
    A.eq(out.agentId, 'publisher', 'the publisher has the last word');

    // S2: the OUTER gate's reviewer lapses on its second turn. The first gate's passes and the outer gate's one pass back stand; the job HOLDS
    // at the outer gate (its own id, the pass it was on) and never reaches the publisher — it no longer reads as 'revise' and goes round again
    let styleM = 0; const ranM = [];
    const out2 = await c.advance({ agentId: 'drafter', text: 'draft v1', originalText: 'write X', lineId: router.lineOfAgent('drafter'),
      runAgent: async (h) => { ranM.push(h.agentId);
        if (h.agentId === 'factcheck') return { text: 'facts ok\nVERDICT: approved' };
        if (h.agentId === 'style') return { text: (++styleM === 1) ? 'tone off\nVERDICT: revise' : 'reads well to me' };
        return { text: h.agentId + ' out' }; } });
    A.eq(ranM.join(' > '), 'factcheck > style > drafter > factcheck > style', 'S2 two gates: the outer reviewer lapses — what was bought stands, nothing after');
    A.ok(out2.hold && out2.hold.reason === 'missing_verdict' && out2.hold.gateId === '19,4' && out2.hold.pass === 1 && out2.stop && out2.stop.code === 'blocked', 'S2 two gates: held at the OUTER gate on its second pass: ' + JSON.stringify(out2.hold));
    A.ok(!ranM.includes('publisher') && !out2.unapproved, 'S2 two gates: the publisher never ran, nothing is marked "went on"');
  }

  /* ---- 2. a stop while the joiner waits settles at once ---- */
  {
    let fire = null; const ran = [];
    const r = makeChainRunner({
      nextAgent: () => null,
      stepAgent: (a, ctx) => ctx.fromTile ? { agentId: 'D' } : (a === 'B' ? null : (a === 'D' ? null : { join: '5,5', expect: 3, timeoutMin: 10, next: 'D' })),
      fanSiblings: (a) => ['A', 'B', 'C'].filter(x => x !== a),
      setTimer: (fn) => { fire = fn; return 0; }
    });
    const ac = new AbortController();
    const p = r.advance({ agentId: 'A', text: 'A-out', originalText: 'q', lineId: 'L1', signal: ac.signal,
      runAgent: async (h) => { ran.push(h.agentId); return { text: h.agentId + '-out', usd: 0.1 }; } });
    await new Promise(res => setTimeout(res, 30));
    A.ok(typeof fire === 'function', 'the joiner is waiting on its timeout');
    ac.abort();
    const settled = await Promise.race([p.then(() => true), new Promise(res => setTimeout(() => res(false), 200))]);
    A.ok(settled, 'STOP ends the wait at once — it no longer sits out the joiner timeout');
    const out = await p;
    A.eq(out.stopped, 'stopped', 'and says it was stopped');
    A.eq(r._barrier.size(), 0, 'the parked barrier is dropped');
  }

  /* ---- 3. the compiler + line editor: real starters, real edits ---- */
  const WM = require('../frontend/app/worldmodel.js'), LE = require('../frontend/app/lineedit.js');
  const crew = s => { for (const b of s.props().filter(p => p.t === 'bay')) if (!b.agentId) s.assignPropAgent(b.id, 'a_' + b.id); };
  const runnerFor = (router, timers) => makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), lineOfAgent: (a, d) => router.lineOfAgent(a, d), stepAgent: (a, c) => router.chainStep(a, c),
    stepDock: (d, c) => router.chainStepDock(d, c), fanSiblingsDock: d => router.fanSiblingsDock(d), entryDockOf: a => router.entryDockOf(a), getTag: () => 'general',
    setTimer: (fn, ms) => { timers.push(ms); setImmediate(fn); return 0; } });

  // 3a. a TAKE TURNS split never copies because a COPY section sits after its MERGER
  {
    const s = WM.create(), z = s.rooms()[0].rects[0];
    s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
    const near = { x: 35, y: 12 };
    A.ok(LE.placeBlueprint(s, 'load_balancer', near).ok, 'LOAD BALANCER placed');
    const M = s.props().find(p => p.t === 'merger'), O = s.props().find(p => p.t === 'outbox');
    A.ok(LE.run(s, M.id, 'insertStep', { from: M.id, to: O.id, role: 'WRITER' }, { near }).ok, 'a WRITER after its MERGER');
    const E = s.props().find(p => p.role === 'WRITER');
    let r = LE.run(s, E.id, 'addBranch', { around: E.id, mode: 'copy', n: 2 }, { near });
    if (!r.ok) r = LE.run(s, E.id, 'addBranch', { around: E.id, mode: 'copy', n: 2 }, { near, tidy: true });
    A.ok(r.ok, 'a COPY section round that WRITER');
    crew(s);
    const plan = P.compileRoutingPlan(s.projectGeometry());
    const splits = Object.keys(plan.junctions).filter(k => plan.junctions[k].kind === 'split');
    const turns = splits.filter(k => P.rejoinOf(plan, k).lanes.every(l => l.kind === 'merge')), copies = splits.filter(k => P.rejoinOf(plan, k).lanes.every(l => l.kind === 'join'));
    A.ok(turns.length === 1 && !plan.junctions[turns[0]].fanout, 'the balancer still takes turns — the JOINER past its MERGER is not its own');
    A.ok(copies.length === 1 && plan.junctions[copies[0]].fanout === true, 'the later section still copies');
    const router = makeRouter(); router.setPlan(plan);
    const e = router.resolveDock({ tag: 'general' }), timers = [];
    const res = await runnerFor(router, timers).advance({ agentId: e.agentId, dockId: e.dockId, text: 'entry out', lineId: router.lineOriginFor(e.agentId, e.dockId), runAgent: async c => ({ text: 'out ' + c.dockId }) });
    A.eq(res.stopped, null, 'a job runs the whole line (' + res.stopped + ')');
    A.ok(/JOINED OUTPUT — 2 of 2/.test(res.text), 'through the COPY section and its joiner');
    A.eq(timers.length, 0, 'no joiner waits out a timeout');
  }

  // 3b. a review loop on one branch of a COPY split: the reviewed work reaches the JOINER
  {
    const s = WM.create(WM.starterDoc());
    A.ok(LE.placeBlueprint(s, 'second_opinion', { x: 8, y: 5 }).ok, 'SECOND OPINION placed');
    crew(s);
    const b = s.props().filter(p => p.t === 'bay')[1];
    A.ok(LE.run(s, b.id, 'addLoop', { around: b.id, max: 2 }, { near: { x: 8, y: 5 } }).ok, 'a review loop on one branch');
    crew(s);
    const plan = P.compileRoutingPlan(s.projectGeometry());
    A.eq(plan.errors.length, 0, 'compiles clean');
    const router = makeRouter(); router.setPlan(plan);
    const timers = [];
    // enter at the reviewed branch's own dock so its loop is on the walk
    const e = router.resolveDock({ tag: 'general' });
    const out = await runnerFor(router, timers).advance({ agentId: e.agentId, dockId: e.dockId, text: 'entry out', lineId: router.lineOriginFor(e.agentId, e.dockId),
      runAgent: async c => ({ text: 'out of ' + c.agentId + (/REVIEWER/.test((s.propById(c.dockId) || {}).role || '') ? '\nVERDICT: approved' : '') }) });
    A.eq(out.stopped, null, 'the line runs to its end (' + out.stopped + ')');
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(out.text) && !/PARTIAL/.test(out.text), 'both branches — the reviewed one included — reach the joiner');
    A.eq(timers.length, 0, 'the joiner never times out waiting for the reviewed branch');
  }

  // 3d. (token-burn audit 2026-10-18) the same branch loop RUNS OUT of passes on a floor whose JOINER ships straight to the OUTBOX:
  //     the joined product is what it always was (the exhausted branch's reviewer word, marked unapproved) — no draft is added to
  //     a delivered answer. (A dock PAST the joiner gets the draft: pinned at the loopDecision seam in chain.join-loop.)
  {
    const s = WM.create(WM.starterDoc());
    A.ok(LE.placeBlueprint(s, 'second_opinion', { x: 8, y: 5 }).ok, 'SECOND OPINION placed (3d)');
    crew(s);
    const b = s.props().filter(p => p.t === 'bay')[1];
    A.ok(LE.run(s, b.id, 'addLoop', { around: b.id, max: 2 }, { near: { x: 8, y: 5 } }).ok, 'a review loop on one branch (3d)');
    crew(s);
    const plan = P.compileRoutingPlan(s.projectGeometry());
    A.eq(plan.errors.length, 0, 'compiles clean (3d)');
    const router = makeRouter(); router.setPlan(plan);
    const timers = [];
    const e = router.resolveDock({ tag: 'general' });
    const out = await runnerFor(router, timers).advance({ agentId: e.agentId, dockId: e.dockId, text: 'entry out', lineId: router.lineOriginFor(e.agentId, e.dockId),
      runAgent: async c => ({ text: /REVIEWER/.test((s.propById(c.dockId) || {}).role || '') ? 'needs more sources\nVERDICT: revise' : 'DRAFT by ' + c.dockId }) });
    A.eq(out.stopped, null, 'the exhausted line still runs to its end (' + out.stopped + ')');
    A.ok(out.loopExhausted && out.unapproved, 'and is marked unapproved (GitHub #122)');
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(out.text), 'both branches reach the joiner (3d)');
    A.ok(/leaving on DONE unapproved\]\nneeds more sources/.test(out.text) && !/THE WORK UNDER REVIEW/.test(out.text),
      'JOINER→OUTBOX: the delivered product keeps the reviewer\'s word, unchanged from before: ' + out.text.slice(0, 300));
  }

  // 3e. (S2) the same branch loop, the reviewer on the branch says nothing usable: the job HOLDS at that gate — no paid pass, the joiner is never
  //     left to time out for a part that will not come, and nothing is joined or delivered
  {
    const s = WM.create(WM.starterDoc());
    A.ok(LE.placeBlueprint(s, 'second_opinion', { x: 8, y: 5 }).ok, 'SECOND OPINION placed (3e)');
    crew(s);
    const b = s.props().filter(p => p.t === 'bay')[1];
    A.ok(LE.run(s, b.id, 'addLoop', { around: b.id, max: 2 }, { near: { x: 8, y: 5 } }).ok, 'a review loop on one branch (3e)');
    crew(s);
    const plan = P.compileRoutingPlan(s.projectGeometry());
    const router = makeRouter(); router.setPlan(plan);
    const timers = [], ran = [];
    const e = router.resolveDock({ tag: 'general' });
    const out = await runnerFor(router, timers).advance({ agentId: e.agentId, dockId: e.dockId, text: 'entry out', lineId: router.lineOriginFor(e.agentId, e.dockId),
      runAgent: async c => { ran.push(c.dockId); return { text: 'DRAFT by ' + c.dockId + (/REVIEWER/.test((s.propById(c.dockId) || {}).role || '') ? ' — reads fine' : '') }; } });
    A.ok(out.hold && out.hold.reason === 'missing_verdict' && out.stop && out.stop.code === 'blocked' && out.stopped === out.blocked, 'S2 branch reviewer says nothing usable: the job holds at its gate: ' + JSON.stringify(out.hold));
    A.ok(!out.loopExhausted && !out.unapproved && !/JOINED OUTPUT/.test(out.text) && timers.length === 0, 'S2 ...nothing joined or delivered, no pass back, no joiner left waiting');
  }

  // 3c. no COPY branch round a step a review loop sends work back to
  {
    const s = WM.create(WM.starterDoc());
    A.ok(LE.placeBlueprint(s, 'revision_loop', { x: 8, y: 5 }).ok, 'REVISION LOOP placed');
    const W = s.props().find(p => p.t === 'bay' && p.role === 'WRITER');
    const chk = LE.check(s, W.id, 'addBranch', { around: W.id, mode: 'copy', n: 2 });
    A.ok(!chk.ok && chk.error === 'HAS_LOOP', 'refused, naming the loop (' + JSON.stringify(chk.error) + ')');
  }

  /* ---- 4. SEND TO still fires from a line that ends at a JOINER, on every new branch path (parallel, divided, a failed
     branch): onShipped needs the OUTBOX the job landed in (ctx.reach), and the peek that found the joiner must carry it ---- */
  {
    const s = WM.create(), z = s.rooms()[0].rects[0];
    s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
    let ok = null;
    for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = s.stampBlueprint('parallel_crew', x, y); if (r.ok) ok = r; }
    A.ok(!!ok, 'PARALLEL CREW stamped');
    const intake = s.props().find(p => p.t === 'intake'), split = s.props().find(p => p.t === 'splitter'), merger = s.props().find(p => p.t === 'merger'), outbox = s.props().find(p => p.t === 'outbox');
    A.ok(LE.run(s, intake.id, 'insertStep', { from: intake.id, to: split.id, role: 'PLANNER' }, { near: { x: split.x, y: split.y } }).ok, 'a PLANNER before the splitter');
    A.ok(s.swapJoinerMerger(merger.id).ok && s.setSplitDivide(split.id, true).ok, 'its MERGER is a JOINER and the splitter divides');
    s.props().filter(p => p.t === 'bay').forEach((b, i) => s.assignPropAgent(b.id, b.role === 'PLANNER' ? 'planner' : 'c' + i));
    const plan = P.compileRoutingPlan(s.projectGeometry());
    A.eq(plan.errors.filter(e => !e.warn).length, 0, 'compiles');
    const router = makeRouter(); router.setPlan(plan);
    const planner = s.props().find(p => p.role === 'PLANNER'), lineId = router.lineOfAgent('planner', planner.id);
    // the precondition that lets the LAST-stage check below fail: lastStage IS wired here, and every divided branch's lane
    // ships to the OUTBOX — so a branch turn built by hopTurn would carry "You are the LAST stage" (the 2026-10-10 live bug)
    for (const b of s.props().filter(p => p.t === 'bay' && p.role !== 'PLANNER')) A.ok(router.chainShipsToOutbox(b.agentId, b.id), 'every divided branch lane ships to the OUTBOX (so the next check can fail): ' + b.agentId);
    const run = async (opts) => {
      const shipped = [], turns = [];
      const c = makeChainRunner(Object.assign({ nextAgent: (a, x) => router.chainNext(a, x), stepAgent: (a, x) => router.chainStep(a, x),
        stepDock: (d, x) => router.chainStepDock(d, x), entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d),
        lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: r => shipped.push(r),
        setTimer: () => 0 }, opts.peek ? { peekDock: (d, x) => router.chainPeekDock(d, x) } : {}));
      const res = await c.advance({ agentId: 'planner', dockId: planner.id, text: opts.text, originalText: 'do X', lineId,
        runAgent: async h => { turns.push({ agentId: h.agentId, text: h.text }); return opts.fail && h.agentId === opts.fail ? { error: 'down' } : { text: h.agentId + ' did it' }; } });
      await new Promise(r => setImmediate(r));
      return { res, shipped, turns };
    };
    for (const [name, opts] of [['parallel + divided', { peek: true, text: 'PART 1: a\nPART 2: b\nPART 3: c' }], ['one after another + divided', { peek: false, text: 'PART 1: a\nPART 2: b\nPART 3: c' }],
      ['parallel, one branch failing', { peek: true, text: 'PART 1: a\nPART 2: b\nPART 3: c', fail: 'c2' }], ['one after another, last branch failing', { peek: false, text: 'PART 1: a\nPART 2: b\nPART 3: c', fail: 'c2' }]]) {
      const { res, shipped, turns } = await run(opts);
      const branchTurns = turns.filter(t => /^c\d$/.test(t.agentId));
      A.eq(branchTurns.length, 3, name + ': three branch turns ran');
      A.ok(branchTurns.every(t => /YOUR PART \(\d of 3\)/.test(t.text)), name + ': each branch is handed its own part');
      A.ok(branchTurns.every(t => !/You are the LAST stage/.test(t.text)), name + ': no branch is told it is the LAST stage, though its lane ships (live 2026-10-10: that made each do the whole job)');
      A.eq(res.stopped, null, name + ': the line ends clean (' + res.stopped + ')');
      A.eq(res.outboxId, outbox.id, name + ': it names the OUTBOX the joined job landed in');
      A.ok(shipped.length === 1 && shipped[0].outboxId === outbox.id, name + ': SEND TO is told it shipped');
      if (opts.fail) A.ok(/1 branch failed and sent nothing/.test(res.text), name + ': the failed branch really failed, and is named');
    }
  }

  /* ---- 5. what comes AFTER a JOINER decides the OUTBOX (runtime audit 2026-10-12): PLANNER ▸ COPY split ▸ 3 crew ▸ JOINER ▸
     TAKE TURNS splitter ▸ OUTBOX A | OUTBOX B. The parallel batch took the merged job's OUTBOX from the NON-ADVANCING peek
     (and from its 'general' walk), so every job landed in OUTBOX A: B's SEND TO, receipts and line-output never fired, and a
     FILTER after the joiner never routed by the merged job. The merged job now walks on from the joiner's exit like any job. ---- */
  {
    // opts.crew = how many of the 3 crew bays get an agent (an unbound bay's branch never launches: an EVEN width with 2);
    // opts.entry = the SECOND OPINION blueprint instead: INBOX ▸ COPY split ▸ 2 crew ▸ JOINER, the entry fan-out path
    const floorAfterJoin = (junction, opts) => {
      opts = opts || {};
      const s = WM.create(), z = s.rooms()[0].rects[0];
      s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
      let ok = null;
      for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = s.stampBlueprint(opts.entry ? 'second_opinion' : 'parallel_crew', x, y); if (r.ok) ok = r; }
      if (opts.entry) {
        A.ok(!!ok && s.props().some(p => p.t === 'joiner'), junction + ': SECOND OPINION stamped with its JOINER');
        s.props().filter(p => p.t === 'bay').forEach((b, i) => s.assignPropAgent(b.id, 'c' + i));
      } else {
        const intake = s.props().find(p => p.t === 'intake'), split = s.props().find(p => p.t === 'splitter'), merger = s.props().find(p => p.t === 'merger');
        A.ok(!!ok && LE.run(s, intake.id, 'insertStep', { from: intake.id, to: split.id, role: 'PLANNER' }, { near: { x: split.x, y: split.y } }).ok && s.swapJoinerMerger(merger.id).ok, junction + ': PARALLEL CREW with a PLANNER and a JOINER');
        let n = 0;
        s.props().filter(p => p.t === 'bay').forEach((b, i) => { if (b.role === 'PLANNER') s.assignPropAgent(b.id, 'planner'); else if (n++ < (opts.crew || 3)) s.assignPropAgent(b.id, 'c' + i); });
      }
      // the second exit is drawn by hand past the joiner (ring-rule geometry): the junction on the joiner's exit belt, a lane down to OUTBOX B
      const geo = s.projectGeometry(); delete geo.links;
      for (const b of geo.belts) if (b.d && !b.dir) b.dir = b.d;
      const J = geo.props.find(p => p.t === 'joiner'), outA = geo.props.find(p => p.t === 'outbox');
      const beltAt = (x, y) => geo.belts.find(b => b.x === x && b.y === y);
      const used = (x, y) => !!beltAt(x, y) || geo.props.some(p => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
      const lane = [[J.x + 1, J.y + 1, 'S'], [J.x + 1, J.y + 2, 'S'], [J.x + 1, J.y + 3, 'S'], [J.x + 1, J.y + 4, 'E'], [J.x + 2, J.y + 4, 'E']];
      const box = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => [J.x + 3 + dx, J.y + 4 + dy]);
      A.ok(beltAt(J.x + 1, J.y) && beltAt(J.x + 1, J.y).dir === 'E' && lane.concat(box).every(([x, y]) => !used(x, y)), junction + ': the joiner exits east onto free floor');
      geo.props.push(junction === 'filter' ? { id: 'pj2', t: 'filter', x: J.x + 1, y: J.y, w: 1, h: 1, routes: { code: 'S' }, def: 'E' } : { id: 'pj2', t: 'splitter', x: J.x + 1, y: J.y, w: 1, h: 1 });
      geo.props.push({ id: 'pob2', t: 'outbox', x: J.x + 3, y: J.y + 4, w: 2, h: 2 });
      for (const [x, y, dir] of lane) geo.belts.push({ x, y, dir });
      const plan = P.compileRoutingPlan(geo);
      A.eq(plan.errors.filter(e => !e.warn).length, 0, junction + ': compiles');
      const j2 = plan.junctions[(J.x + 1) + ',' + J.y] || {};
      A.ok(j2.kind === junction.replace('turns', 'split') && !j2.fanout, junction + ': the junction after the joiner is a ' + (junction === 'filter' ? 'FILTER' : 'TAKE TURNS splitter'));
      return { plan, planner: geo.props.find(p => p.agentId === 'planner'), outA: outA.id };
    };
    // tagged: true = every crew writes CODE; a function (agentId, isEntryRun) -> its text, for floors where only SOME branches carry the tag
    const jobs = async (f, peek, tagged) => {
      const router = makeRouter(); router.setPlan(f.plan);
      const textOf = typeof tagged === 'function' ? tagged : a => (tagged ? 'CODE ' : '') + a + ' did it';
      const shipped = [], outputs = [];
      for (let i = 0; i < 4; i++) {
        const c = makeChainRunner(Object.assign({ nextAgent: (a, x) => router.chainNext(a, x), stepAgent: (a, x) => router.chainStep(a, x),
          stepDock: (d, x) => router.chainStepDock(d, x), entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d),
          lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: r => shipped.push(r.outboxId),
          getTag: t => /CODE/.test(String(t)) ? 'code' : 'general', setTimer: () => 0,
          emit: (n, p) => { if (n === 'workitem.delivered' && p.box === 'line-output') outputs.push(p.outboxId); } }, peek ? { peekDock: (d, x) => router.chainPeekDock(d, x) } : {}));
        // the entry fan-out (SECOND OPINION): the INBOX names ONE crew — the same resolver the hub asks — and it has run already
        const entry = f.planner ? { agentId: 'planner', dockId: f.planner.id, text: 'plan' } : router.resolveDock({ tag: 'general' });
        const lineId = f.planner ? router.lineOfAgent('planner', f.planner.id) : router.lineOriginFor(entry.agentId, entry.dockId);
        const res = await c.advance({ agentId: entry.agentId, dockId: entry.dockId, text: f.planner ? 'plan' : textOf(entry.agentId, true), originalText: 'do X', lineId, runId: 'job' + i,
          runAgent: async h => ({ text: textOf(h.agentId, false) }) });
        A.eq(res.stopped, null, 'the line ends clean (' + res.stopped + ')');
      }
      await new Promise(r => setImmediate(r));
      return { shipped: shipped.join(' '), outputs: outputs.join(' ') };
    };
    const turns = floorAfterJoin('turns');
    const alternate = [turns.outA, 'pob2', turns.outA, 'pob2'].join(' ');
    for (const peek of [true, false]) {
      const r = await jobs(turns, peek, false);
      A.eq(r.shipped, alternate, (peek ? 'parallel' : 'one after another') + ': TAKE TURNS after the joiner alternates the OUTBOX SEND TO is told about');
      A.eq(r.outputs, alternate, (peek ? 'parallel' : 'one after another') + ': and the floor\'s line-output names the same OUTBOXes');
    }
    const filter = floorAfterJoin('filter');
    for (const peek of [true, false]) {
      const r = await jobs(filter, peek, true);
      A.eq(r.shipped, 'pob2 pob2 pob2 pob2', (peek ? 'parallel' : 'one after another') + ': a FILTER after the joiner routes by the merged job (code → OUTBOX B)');
    }
    /* EVEN widths, the entry fan-out, a tag on SOME branches (runtime repair 2026-10-12). Three crews hid the one-after-another
       bug: every ARRIVING branch's walk went on past the joiner with the advancing pick — 3 moves of a 2-exit TAKE TURNS splitter
       alternate by parity; 2 moves stick on one OUTBOX — and the release then shipped where the LAST branch's walk ended, by
       that branch's tag, not the merged job's. The merged job alone walks on from the joiner, once, by its own tag. */
    const turns2 = floorAfterJoin('turns', { crew: 2 });
    const alternate2 = [turns2.outA, 'pob2', turns2.outA, 'pob2'].join(' ');
    for (const peek of [true, false]) {
      const r = await jobs(turns2, peek, false);
      A.eq(r.shipped, alternate2, (peek ? 'parallel' : 'one after another') + ', 2 branches: TAKE TURNS after the joiner alternates the OUTBOX');
      A.eq(r.outputs, alternate2, (peek ? 'parallel' : 'one after another') + ', 2 branches: and line-output names the same OUTBOXes');
    }
    for (const peek of [true, false]) {
      // only c1 writes CODE, and it is never the last to arrive one after another — the merged job still contains CODE
      const r = await jobs(filter, peek, a => (a === 'c1' ? 'CODE ' : '') + a + ' did it');
      A.eq(r.shipped, 'pob2 pob2 pob2 pob2', (peek ? 'parallel' : 'one after another') + ': a FILTER after the joiner reads the merged job when only one branch wrote CODE');
    }
    const so = floorAfterJoin('turns', { entry: true });
    for (const peek of [true, false]) {
      const r = await jobs(so, peek, false);
      const want = [so.outA, 'pob2', so.outA, 'pob2'].join(' ');
      A.eq(r.shipped, want, 'SECOND OPINION' + (peek ? '' : ' (no peek)') + ': TAKE TURNS after the joiner alternates the OUTBOX');
      A.eq(r.outputs, want, 'SECOND OPINION' + (peek ? '' : ' (no peek)') + ': and line-output names the same OUTBOXes');
    }
    const soF = floorAfterJoin('filter', { entry: true });
    for (const peek of [true, false]) {
      // only the crew the INBOX named (the entry run) writes CODE; its sibling runs after it and arrives last without it
      const r = await jobs(soF, peek, (a, isEntry) => (isEntry ? 'CODE ' : '') + a + ' did it');
      A.eq(r.shipped, 'pob2 pob2 pob2 pob2', 'SECOND OPINION' + (peek ? '' : ' (no peek)') + ': a FILTER after the joiner reads the merged job (code → OUTBOX B), not the last branch');
      A.eq(r.outputs, 'pob2 pob2 pob2 pob2', 'SECOND OPINION' + (peek ? '' : ' (no peek)') + ': and line-output names OUTBOX B');
    }
  }

  /* ---- 6. a COPY split inside a review loop's pass (wave 2 review, conveyor-backend-01): INBOX ▸ drafter ▸ COPY split ▸
     [factcheck] + [style] ▸ JOINER ▸ editor ▸ LOOP (back lane to the drafter) ▸ OUTBOX. The parallel batch ignored the loop pass:
     on the second pass it found factcheck already visited and stopped with "the line loops back to …", where the one-after-another
     walk (no peek) honours the pass and finishes. Both must run the second review, and the pass's hops count off the ceiling. ---- */
  {
    const s = WM.create(), z = s.rooms()[0].rects[0];
    s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 50, y2: z.y1 + 40 } });
    const near = { x: z.x2 + 10, y: z.y1 + 6 };
    const nl = LE.run(s, null, 'newLine', { role: 'WRITER' }, { near });
    A.ok(nl.ok, 'a one-step line (' + JSON.stringify(nl.error || '') + ')');
    const drafter = s.props().find(p => p.t === 'bay' && p.role === 'WRITER');
    let r = LE.run(s, drafter.id, 'addLoop', { around: drafter.id, max: 3 }, { near });
    if (!r.ok) r = LE.run(s, drafter.id, 'addLoop', { around: drafter.id, max: 3 }, { near, tidy: true });
    A.ok(r.ok, 'a review loop round the drafter (' + JSON.stringify(r.error || '') + ')');
    const editor = s.props().find(p => p.t === 'bay' && p.role === 'REVIEWER');
    r = LE.run(s, drafter.id, 'addBranch', { from: drafter.id, to: editor.id, mode: 'copy', n: 2 }, { near });
    if (!r.ok) r = LE.run(s, drafter.id, 'addBranch', { from: drafter.id, to: editor.id, mode: 'copy', n: 2 }, { near, tidy: true });
    A.ok(r.ok, 'a COPY section between the drafter and the editor (' + JSON.stringify(r.error || '') + ')');
    const branches = s.props().filter(p => p.t === 'bay' && p.id !== drafter.id && p.id !== editor.id);
    A.eq(branches.length, 2, 'two branch steps');
    s.assignPropAgent(drafter.id, 'drafter'); s.assignPropAgent(editor.id, 'editor');
    s.assignPropAgent(branches[0].id, 'factcheck'); s.assignPropAgent(branches[1].id, 'style');
    const plan = P.compileRoutingPlan(s.projectGeometry());
    A.eq(plan.errors.filter(e => !e.warn).length, 0, 'the looped COPY floor compiles (' + JSON.stringify(plan.errors) + ')');
    const router = makeRouter(); A.ok(router.setPlan(plan).ok, 'and deploys');
    const lineId = router.lineOfAgent('drafter', drafter.id);
    for (const peek of [true, false]) {
      let editorN = 0; const ran = [];
      const c = makeChainRunner(Object.assign({ nextAgent: (a, x) => router.chainNext(a, x), stepAgent: (a, x) => router.chainStep(a, x),
        stepDock: (d, x) => router.chainStepDock(d, x), entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d),
        lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d), setTimer: () => 0 },
        peek ? { peekDock: (d, x) => router.chainPeekDock(d, x) } : {}));
      const out = await c.advance({ agentId: 'drafter', dockId: drafter.id, text: 'draft v1', originalText: 'write X', lineId,
        runAgent: async h => { ran.push(h.agentId);
          if (h.agentId === 'editor') return { text: (++editorN === 1) ? 'needs work\nVERDICT: revise' : 'good\nVERDICT: approved' };
          return { text: h.agentId + ' out' }; } });
      const order = ran.map(a => (a === 'factcheck' || a === 'style') ? 'branch' : a).join(' > ');
      const label = peek ? 'parallel' : 'one after another';
      A.eq(out.stopped, null, label + ': the second review pass runs through the COPY section (' + out.stopped + ')');
      A.eq(order, 'branch > branch > editor > drafter > branch > branch > editor', label + ': drafter, both branches, editor — twice');
      A.eq(out.agentId, 'editor', label + ': the editor has the last word');
      // (2026-10-18) the editor approved without restating the work ("good"), so what leaves on DONE is the work it approved — the
      // joined branches it was handed — never the bare approval, and never the VERDICT line (R1)
      const shippedText = String(out.text);
      A.ok(/^JOINED OUTPUT — 2 of 2 branches delivered/.test(shippedText) && /factcheck out/.test(shippedText) && /style out/.test(shippedText) && !/VERDICT/.test(shippedText),
        label + ': the approved work leaves on DONE (' + JSON.stringify(shippedText.slice(0, 60)) + ')');
    }
  }

  A.report('chain-audit-1010');
})();
