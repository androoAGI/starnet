/* test/routing.handoff.test.js — SEND TO at run time (2026-10-10): the chain's onShipped hook, the handoff runner, the job records.

   Locks, on a REAL station compiled by the REAL compiler (the hub is a fake: it stands in for the target line's run):
     ONSHIPPED  — chain.js tells the host exactly when a job LEFT ITS LINE CLEAN at a stage that ships to the OUTBOX: never for a
                  direct order, a refused line, a failed stage or a stage that does not ship; a throwing / rejecting hook never
                  touches the reply.
     THE RUNNER — a job finished on LINE A whose OUTBOX sends to LINE B starts LINE B's OWN job: the hub is scoped to B (its lineId
                  hook answers B — so B's INBOX picks the dock and B's budget governs), the input carries the job as it arrived,
                  what A delivered and A's files; the crate is workitem.placed kind:'handoff' from A's OUTBOX to B's INBOX; B's
                  record says from:A, A's record says sentTo:B. A → B → C rides on (lineage); a circle, a 4th hand-off, E-STOP,
                  an uncrewed target, a target over its day cap, a sending job that did not finish clean, a SEND TO changed
                  while waiting and a burst past MAX_PENDING are each refused AND said on the target line's job record.
     THE RECORD — linejobs keeps from / sentTo through normalize, finish and the window's summary. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');
const LineJobs = require('../sidecar/routing/linejobs.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeHandoffRunner, MAX_PENDING, MAX_DEPTH } = require('../sidecar/routing/handoff-runner.js');
const { crewedDocksOnLine } = require('../sidecar/routing/trigger-runner.js');

const tick = (ms) => new Promise(r => setTimeout(r, ms || 15));

function station(n) {
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 44; r.y2 = 8 + n * 6; }
  const st = WM.create(d);
  const L = [];
  for (let i = 0; i < n; i++) {
    const r = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 + i * 6 });
    if (!r.ok) throw new Error('placeBlueprint ' + JSON.stringify(r));
    const of = t => r.ids.filter(id => st.propById(id).t === t);
    L.push({ intake: of('intake')[0], bays: of('bay'), outbox: of('outbox')[0] });
    st.setPropLabel(of('intake')[0], String.fromCharCode(65 + i));
  }
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  return { st, L };
}

(async () => {
  /* ---------- ONSHIPPED (chain.js) ---------- */
  {
    const fired = [];
    const mk = (extra) => makeChainRunner(Object.assign({
      nextAgent: a => ({ researcher: 'writer' })[a] || null,
      runAgent: async ({ agentId }) => ({ text: agentId + ' work', usd: 0.01 }),
      lastStage: a => a === 'writer', onShipped: r => { fired.push(r); }, now: () => 0
    }, extra || {}));
    const c = mk();
    const res = await c.advance({ agentId: 'researcher', text: 'notes', originalText: 'the job', lineId: 'L1', entryUsd: 0.02, streamId: 'sample-1', since: 5, runId: 'entry-proof' });
    A.eq(res.stopped, null, 'the line ran to its end');
    A.eq(fired[0].entryRunId, 'entry-proof', 'shipment callback carries exact entry-run identity');
    A.eq(fired.length, 1, 'onShipped fired once for a job that left its line clean at the OUTBOX stage');
    A.ok(fired[0] && fired[0].lineId === 'L1' && fired[0].agentId === 'writer' && fired[0].text === 'writer work' && fired[0].originalText === 'the job' && fired[0].streamId === 'sample-1' && fired[0].since === 5 && Math.abs(fired[0].usd - 0.03) < 1e-9, '…with the line, the producer, the answer, the job as it arrived, its stream and its whole spend — ' + JSON.stringify(fired[0]));
    fired.length = 0;
    await c.advance({ agentId: 'researcher', text: 'notes', originalText: 'the job' });
    A.eq(fired.length, 0, 'a DIRECT ORDER (no lineId) never ships anywhere');
    await mk({ lastStage: () => false }).advance({ agentId: 'researcher', text: 'notes', lineId: 'L1' });
    A.eq(fired.length, 0, 'a last stage whose lane does not ship to an OUTBOX sends nothing on');
    await mk({ runAgent: async () => ({ error: 'provider exploded' }) }).advance({ agentId: 'researcher', text: 'notes', lineId: 'L1' });
    A.eq(fired.length, 0, 'a failed stage (the line stopped) sends nothing on');
    await mk({ lineOfAgent: () => 'L9' }).advance({ agentId: 'writer', text: 'w', lineId: 'L1' });
    A.eq(fired.length, 0, 'a line that REFUSED the work (another line\'s job) sends nothing on');
    const boom = await mk({ onShipped: () => { throw new Error('host bug'); } }).advance({ agentId: 'researcher', text: 'notes', lineId: 'L1' });
    A.ok(boom.text === 'writer work' && boom.stopped === null, 'a throwing onShipped never touches the reply');
    const rej = await mk({ onShipped: () => Promise.reject(new Error('later')) }).advance({ agentId: 'researcher', text: 'notes', lineId: 'L1' });
    A.ok(rej.text === 'writer work', '…nor does a rejecting one (and the rejection is noted, never unhandled)');
    await tick();
  }

  /* ---------- ONSHIPPED names the OUTBOX the job landed in (2026-10-11 repair) ----------
     A line with two OUTBOXes (a SORTING OFFICE, each BAY belted to its own OUTBOX), only one sending: the chain's own terminal walk
     (Pipeline.chainStepDock ctx.reach) says which OUTBOX each job reached, and the runner hands on only from the sending one. */
  {
    const d = WM.starterDoc();
    for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 60; r.y2 = 44; }
    const st2 = WM.create(d);
    const so = LE.placeBlueprint(st2, 'sorting_office', { x: 8, y: 4 });
    const sb = so.ids.filter(id => st2.propById(id).t === 'bay');
    const [o1, o2] = so.ids.filter(id => st2.propById(id).t === 'outbox');
    const rb = LE.placeBlueprint(st2, 'research_line', { x: 8, y: 24 });
    const bIn = rb.ids.find(id => st2.propById(id).t === 'intake');
    for (const p of st2.props()) if (p.t === 'bay' && !p.agentId) st2.assignPropAgent(p.id, 'ag_' + p.id);
    st2.setSendTo(o1, bIn);
    const pl = P.compileRoutingPlan(st2.projectGeometry()), la = pl.lineOfProp[sb[0]];
    const got = [];
    const chain = makeChainRunner({
      nextAgent: () => null, runAgent: async () => ({ text: 'x', usd: 0 }), now: () => 0,
      stepDock: (dock, ctx) => P.chainStepDock(pl, dock, ctx), entryDockOf: () => null,
      lastStage: (a, dock) => { const r = P.dockLayer(pl).dockChains[dock]; return !!(r && r.outbox && !r.deadEnd); },
      onShipped: r => { got.push(r); }
    });
    for (const dock of sb) await chain.advance({ agentId: pl.agentOfDock[dock], dockId: dock, text: 'done', originalText: 'job', lineId: la });
    A.eq(got.map(r => [r.dockId, r.outboxId]), [[sb[0], o1], [sb[1], o2]], 'onShipped says which OUTBOX each job landed in');
    const sent = [];
    const R0 = makeHandoffRunner({ makeHub: () => ({ onInbound: () => new Promise(() => {}) }), plan: () => pl, jobs: {}, now: () => 1, newId: () => 'z' + sent.length + 'abcdef0123456789',
      emit: () => {}, runsFor: () => [], warn: () => {} });
    for (const r of got) sent.push(R0.onShipped(r));
    A.ok(sent[0].ok && sent[0].toLine === pl.lineOfProp[bIn], 'the job that landed in the SENDING OUTBOX is handed on — ' + JSON.stringify(sent[0]));
    A.eq(sent[1].code, 'none', 'the job that landed in the OTHER OUTBOX is not (it was, before: every job on a line with one sender rode on)');
    await tick();
  }

  /* ---------- THE RUNNER ---------- */
  const { st, L } = station(5);
  const [a, b, c, dd, e] = L;
  A.ok(st.setSendTo(a.outbox, b.intake).ok && st.setSendTo(b.outbox, c.intake).ok, 'A → B → C');
  let plan = P.compileRoutingPlan(st.projectGeometry());
  const lineOf = id => plan.lineOfProp[id];
  const LA = lineOf(a.intake), LB = lineOf(b.intake), LC = lineOf(c.intake), LD = lineOf(dd.intake), LEE = lineOf(e.intake);
  A.ok(plan.sendTo && plan.sendTo[a.outbox] && plan.sendTo[a.outbox].toLine === LB, 'the plan carries A → B');

  let jobs = { jobs: [] };
  const J = {
    byStream: s => LineJobs.byStream(jobs, s),
    start: r => { const x = LineJobs.start(jobs, r); if (x.job) jobs = x.state; return x.job; },
    finish: (id, r) => { const x = LineJobs.finish(jobs, id, r); if (x.job) jobs = x.state; return x.job; },
    link: (id, to) => { const x = LineJobs.link(jobs, id, to); if (x.job) jobs = x.state; return x.job; },
    latest: line => LineJobs.latest(jobs, line),
    again: (id, at) => { const x = LineJobs.again(jobs, id, at); if (x.job) jobs = x.state; return x.job; }
  };
  const runsByStream = {}, emitted = [], hubCalls = [], hooksSeen = [];
  let halted = false, cap = {}, hang = null, R = null, n = 0, clock = 1000;
  // the fake hub stands in for the target line's run: its ONE resolution walks only that line's doors (hooks.lineId), a clean
  // run is recorded on the hand-off's own stream, the line's answer is "sent", and — as chain.js would — the target line's
  // clean exit is reported back through onShipped, so A → B → C rides on
  function fakeHub(hooks) {
    hooksSeen.push(hooks);
    return {
      _internals: { inflight: new Map() },
      onInbound(msg) {
        const line = hooks.lineId();
        hubCalls.push({ line, msg });
        const docks = crewedDocksOnLine(plan, line).sort(P.propIdCmp), dock = docks[0];
        const agentId = dock ? plan.agentOfDock[dock] : 'trg_fallback';
        const routed = hooks.onRouted(dock ? { agentId, dockId: dock } : null);
        hooks.onResolved({ chatId: msg.chatId, agentId, isTask: true, lineId: routed ? line : null, dockId: dock });
        const sid = hooks.streamId();
        if (hang) return hang;
        return Promise.resolve().then(() => {
          runsByStream[sid] = [{ runId: 'r' + (++n), agentId, dockId: dock, reason: 'done', usd: 0.01, streamId: sid, startedAt: clock }];
          const last = plan.lines.find(l => l.lineId === line).propIds.filter(id => plan.agentOfDock[id]).sort(P.propIdCmp).pop();
          hooks.send('OUTPUT OF ' + line);
          hooks.onLineOutcome({ agentId: plan.agentOfDock[last], dockId: last, stopped: null, hops: [] });
          R.onShipped({ lineId: line, agentId: plan.agentOfDock[last], dockId: last, text: 'OUTPUT OF ' + line, originalText: msg.text, streamId: sid, since: clock });
        });
      }
    };
  }
  R = makeHandoffRunner({
    makeHub: fakeHub, plan: () => plan, jobs: J, emit: (nm, p) => emitted.push({ nm, p }),
    shipsToOutbox: (agentId, dockId) => !!dockId, dayCap: line => cap[line] || { cap: null, spent: 0 }, halted: () => halted,
    runsFor: sid => runsByStream[sid] || [], now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {}
  });

  // the job on LINE A, as the sample route keeps it
  const xs = 'sample-aaaa1111';
  J.start({ id: 'job-aaaa1111', line: LA, name: 'A', text: 'Find three facts about Mars.', streamId: xs, at: clock });
  runsByStream[xs] = [{ runId: 'x1', agentId: 'ag_' + a.bays[0], reason: 'done', usd: 0.01, streamId: xs, startedAt: clock, artifacts: [{ kind: 'file', path: 'C:/work/mars.md' }] },
    { runId: 'x2', agentId: 'ag_' + a.bays[1], reason: 'done', usd: 0.02, streamId: xs, startedAt: clock + 1 }];
  const lastA = a.bays[1];
  clock += 5;   // the job ships AFTER its runs started (the run read-back stops at the ship time)
  const q = R.onShipped({ lineId: LA, agentId: 'ag_' + lastA, dockId: lastA, text: 'Mars has two moons.', originalText: 'Find three facts about Mars.', streamId: xs, since: clock - 5 });
  A.ok(q.ok && q.toLine === LB && q.queued === 1, 'a clean job on A is queued for B — ' + JSON.stringify(q));
  await tick(40);
  // the sending route finishes its own record after the hand-off went out: the link survives
  J.finish('job-aaaa1111', { at: clock, status: 'delivered', usd: 0.03, output: 'Mars has two moons.', runs: [] });
  const xa = LineJobs.get(jobs, 'job-aaaa1111');
  const yb = jobs.jobs.find(j => j.line === LB), zc = jobs.jobs.find(j => j.line === LC);
  A.ok(yb && yb.status === 'delivered' && yb.output === 'OUTPUT OF ' + LB, 'LINE B ran its own job and delivered — ' + JSON.stringify(yb && { status: yb.status, error: yb.error }));
  A.eq(yb && yb.from, { line: LA, jobId: 'job-aaaa1111', name: 'A' }, 'B’s record says where it came from');
  A.eq(xa.sentTo, { line: LB, jobId: yb && yb.id, name: 'B' }, 'A’s record says where it went — and A’s own output stays A’s');
  A.eq(xa.output, 'Mars has two moons.', '…A’s result is still A’s');
  A.ok(yb && yb.text === 'Find three facts about Mars.' && yb.handedIn === 'Mars has two moons.', 'B’s record keeps the job as it first arrived and what A handed in APART (never a 2000-char cut of the frame) — ' + JSON.stringify(yb && { text: yb.text, handedIn: yb.handedIn }));
  const toB = hubCalls.find(h => h.line === LB);
  A.ok(toB && /^\[HAND-OFF — LINE A finished its part/.test(toB.msg.text) && /Find three facts about Mars\./.test(toB.msg.text) && /Mars has two moons\./.test(toB.msg.text) && /- C:\/work\/mars\.md/.test(toB.msg.text), 'B was handed the job as it arrived, what A delivered and A’s file');
  A.ok(hooksSeen.some(h => h.lineId() === LB), 'the hub is scoped to LINE B (its INBOX picks the dock; its budget governs)');
  const placed = emitted.find(x => x.nm === 'workitem.placed' && x.p.lineId === LB);
  A.ok(placed && placed.p.kind === 'handoff' && placed.p.fromLine === LA && placed.p.fromOutbox === a.outbox && placed.p.toIntake === b.intake, 'the crate rides from A’s OUTBOX into B’s INBOX — ' + JSON.stringify(placed && placed.p));
  A.ok(emitted.some(x => x.nm === 'workitem.delivered' && x.p.finalQueueId === 'outbox' && x.p.workitemId === (placed && placed.p.workitemId)), '…and lands in B’s OUTBOX');
  A.ok(zc && zc.status === 'delivered' && zc.from && zc.from.line === LB && zc.from.jobId === yb.id, 'B sends on to C: C’s job came from B’s');
  // A → B → C: C is handed the job AS IT FIRST ARRIVED and what B delivered — never B's whole frame nested as "the job"
  const toC = hubCalls.find(h => h.line === LC), cin = toC && P.parseHandoffInput(toC.msg.text);
  A.ok(cin && cin.fromName === 'B' && cin.original === 'Find three facts about Mars.' && cin.output === 'OUTPUT OF ' + LB && (toC.msg.text.match(/\[HAND-OFF/g) || []).length === 1, 'C’s input: one frame, the first job, B’s output — ' + JSON.stringify(cin));
  A.ok(zc.text === 'Find three facts about Mars.' && zc.handedIn === 'OUTPUT OF ' + LB, '…and C’s record says the same');
  A.eq(LineJobs.get(jobs, yb.id).sentTo && LineJobs.get(jobs, yb.id).sentTo.line, LC, '…and B’s record says it went on to C');
  A.ok(!jobs.jobs.some(j => j.line === LD), 'C sends nowhere: the ride stops at C');

  // a CIRCLE: the plan is re-posted mid-run with C → A (the compiler would warn SEND_TO_LOOP; the run time stands on its own)
  plan = JSON.parse(JSON.stringify(plan));
  plan.sendTo[c.outbox] = { intakeId: a.intake, fromLine: LC, toLine: LA };
  const zStream = zc.streamId;
  const circ = R.onShipped({ lineId: LC, agentId: 'ag_' + c.bays[1], dockId: c.bays[1], text: 'C out', originalText: 'x', streamId: zStream, since: clock });
  A.ok(!circ.ok && /round in a circle/.test(circ.error) && /LINE A/.test(circ.error), 'C → A after A → B → C is refused: a circle — ' + JSON.stringify(circ));
  const circRec = jobs.jobs.find(j => j.id === circ.jobId);
  A.ok(circRec && circRec.line === LA && circRec.status === 'failed' && /not sent on: .*circle/.test(circRec.error) && circRec.from.line === LC, '…and said on LINE A as a job that was not sent on, from C');
  delete plan.sendTo[c.outbox];

  // a 4th hand-off: A → B → C → D → E
  plan.sendTo[c.outbox] = { intakeId: dd.intake, fromLine: LC, toLine: LD };
  plan.sendTo[dd.outbox] = { intakeId: e.intake, fromLine: LD, toLine: LEE };
  const before = jobs.jobs.length;
  R.onShipped({ lineId: LC, agentId: 'ag_' + c.bays[1], dockId: c.bays[1], text: 'C out', originalText: 'x', streamId: zStream, since: clock });
  await tick(40);
  const dRec = jobs.jobs.slice(before).find(j => j.line === LD), eRec = jobs.jobs.slice(before).find(j => j.line === LEE);
  A.ok(dRec && dRec.status === 'delivered', 'the 3rd hand-off (C → D) runs');
  A.ok(eRec && eRec.status === 'failed' && new RegExp('at most ' + MAX_DEPTH + ' lines').test(eRec.error), 'the 4th (D → E) is refused: a job crosses at most ' + MAX_DEPTH + ' lines — ' + JSON.stringify(eRec && eRec.error));
  delete plan.sendTo[c.outbox]; delete plan.sendTo[dd.outbox];

  const fresh = (sid, line, dock, reason) => { runsByStream[sid] = [{ runId: 'f' + (++n), agentId: 'ag_' + dock, reason: reason || 'done', usd: 0, streamId: sid, startedAt: clock }]; return { lineId: line, agentId: 'ag_' + dock, dockId: dock, text: 'out', originalText: 'job', streamId: sid, since: clock }; };
  const refusedOnB = () => jobs.jobs.filter(j => j.line === LB && j.status === 'failed').map(j => j.error);
  // E-STOP
  halted = true;
  const callsBefore = hubCalls.length;
  J.start({ id: 'job-eeee5555', line: LA, name: 'A', text: 'A job E-STOP catches', streamId: 'sample-es', at: clock });
  const es = R.onShipped(fresh('sample-es', LA, lastA));
  A.ok(!es.ok && /E-STOP/.test(es.error) && hubCalls.length === callsBefore, 'E-STOP: nothing is sent on, nothing runs');
  // (wave 2 review, conveyor-backend-09) the reason is bare: the record's 'not sent on: ' and every sender surface already say it
  A.eq(es.error, 'automation is stopped (E-STOP)', 'E-STOP: the reason never repeats "nothing was sent on"');
  A.eq(LineJobs.get(jobs, es.jobId).error, 'not sent on: automation is stopped (E-STOP)', 'E-STOP: the target record says "not sent on" once');
  const esA = LineJobs.get(jobs, 'job-eeee5555');
  A.ok(esA.sentTo && esA.sentTo.line === LB && /E-STOP/.test(esA.sentTo.refused || ''), 'the sending job says it was NOT sent on, and why (a plain sentTo reads as "SENT ON TO LINE B") — ' + JSON.stringify(esA.sentTo));
  const es2 = R.onShipped(fresh('sample-es2', LA, lastA));
  A.ok(es2.jobId === es.jobId && LineJobs.get(jobs, es.jobId).repeats === 2, 'a STANDING refusal (same line, same reason, back to back) is counted on ONE record, not a new one per job');
  halted = false;
  // the target over its day cap
  cap[LB] = { cap: 1, spent: 1 };
  const dc = R.onShipped(fresh('sample-dc', LA, lastA));
  A.ok(!dc.ok && /LINE B reached its \$1\.00 daily limit/.test(dc.error), 'the TARGET line’s own daily cap refuses it — ' + dc.error);
  delete cap[LB];
  // a sending job that did not finish clean (a step ended max_iters with some text — the chain read it as an answer)
  R.onShipped(fresh('sample-mi', LA, lastA, 'max_iters'));
  await tick(30);
  A.ok(refusedOnB().some(x => /did not finish cleanly \(a step ended “max_iters”\)/.test(x)), 'a sending job with a step that did not end done is not sent on');
  /* (runtime repair 2026-10-12) a PARTIAL joined job — a COPY branch the host refused before it ran, so it wrote NO run row and every
     row that exists ended done — is not sent on either: the chain marks it (rec.partial) and the next line says why */
  const hubBeforePartial = hubCalls.length;
  const pr = R.onShipped(Object.assign(fresh('sample-pj', LA, lastA), { partial: 'crew0 failed' }));
  A.ok(!pr.ok && /did not finish cleanly \(its joiner sent on without every branch: crew0 failed\)/.test(pr.error) && hubCalls.length === hubBeforePartial,
    'a partial joined job is refused at once, nothing runs on the next line — ' + JSON.stringify(pr));
  A.ok(refusedOnB().some(x => /joiner sent on without every branch: crew0 failed/.test(x)), '…and the next line\'s record says why');
  // an uncrewed target
  const unplan = plan;
  for (const id of b.bays) st.assignPropAgent(id, '');
  st.setSendTo(b.outbox, null);
  plan = P.compileRoutingPlan(st.projectGeometry());
  const un = R.onShipped(fresh('sample-un', LA, lastA));
  A.ok(!un.ok && /routes work to no crewed dock/.test(un.error), 'a target line with no crew is refused — ' + un.error);
  for (const id of b.bays) st.assignPropAgent(id, 'ag_' + id);
  plan = unplan;
  // a burst: one in flight + MAX_PENDING waiting, the rest refused; E-STOP drops the waiting ones
  hang = new Promise(() => {});
  const burst = [];
  // (each sending job keeps its own record, as the sample route's does — so E-STOP's drop can be read back on it)
  for (let i = 0; i < MAX_PENDING + 3; i++) J.start({ id: 'job-burst' + i + 'aaaa', line: LA, name: 'A', text: 'burst ' + i, streamId: 'sample-b' + i, at: clock });
  for (let i = 0; i < MAX_PENDING + 3; i++) burst.push(R.onShipped(fresh('sample-b' + i, LA, lastA)));
  await tick();
  A.eq(burst.filter(x => x.ok).length, MAX_PENDING + 1, 'a burst admits one in flight + ' + MAX_PENDING + ' waiting');
  A.ok(burst.slice(MAX_PENDING + 1).every(x => !x.ok && /hand-offs waiting/.test(x.error)), 'the rest are refused (and said on LINE B)');
  A.ok(burst.slice(MAX_PENDING + 1).every(x => x.jobId === burst[MAX_PENDING + 1].jobId) && LineJobs.get(jobs, burst[MAX_PENDING + 1].jobId).repeats === burst.length - (MAX_PENDING + 1), '…on ONE record counting them all — ' + JSON.stringify(burst.slice(MAX_PENDING + 1).map(x => [x.jobId, (LineJobs.get(jobs, x.jobId) || {}).repeats])));
  A.ok(R.status().lines.some(l => l.line === LB && l.running && l.queued === MAX_PENDING), 'status: B running with ' + MAX_PENDING + ' waiting');
  A.ok(R.inflights().length >= 1, 'E-STOP can reach the target line’s hub');
  A.eq(R.haltAll(), MAX_PENDING, 'E-STOP drops every waiting hand-off');
  /* (fix-runtime 24) …and SAYS so on both lines: the dropped jobs never vanish. LINE B's newest record is ONE failed "not sent on"
     record counting every dropped hand-off; every dropped sending job reads NOT sent on — E-STOP (never "delivered" with no word) */
  const esB = jobs.jobs.filter(j => j.line === LB).pop();
  A.eq(esB && esB.error, 'not sent on: automation is stopped (E-STOP)', 'E-STOP drop: the default reason is bare too');
  A.ok(esB && esB.status === 'failed' && /^not sent on: .*E-STOP/.test(esB.error) && esB.repeats === MAX_PENDING, 'E-STOP: LINE B gets one failed record for the dropped hand-offs, counting all ' + MAX_PENDING + ' — ' + JSON.stringify(esB && { status: esB.status, error: esB.error, repeats: esB.repeats }));
  const dropped = [];
  for (let i = 1; i <= MAX_PENDING; i++) dropped.push(LineJobs.get(jobs, 'job-burst' + i + 'aaaa'));
  A.ok(dropped.every(j => j && j.sentTo && j.sentTo.line === LB && /E-STOP/.test(j.sentTo.refused || '')), 'every dropped sending job says NOT sent on — E-STOP — ' + JSON.stringify(dropped.map(j => j && j.sentTo)));
  A.ok(LineJobs.get(jobs, 'job-burst0aaaa').sentTo && !LineJobs.get(jobs, 'job-burst0aaaa').sentTo.refused, '…the one already running was sent on (its own record says STOPPED when E-STOP kills it)');
  A.ok(R.status().refused.filter(x => /E-STOP/.test(x.error)).length >= MAX_PENDING, 'the status read lists the dropped hand-offs as refused');
  A.ok(R.status().lines.some(l => l.line === LB && l.queued === 0), '…and nothing waits any more');
  hang = null;
  // a SEND TO changed while a hand-off waited — dispatch re-reads the plan
  const R2 = makeHandoffRunner({ makeHub: () => ({ onInbound: () => new Promise(() => {}) }), plan: () => plan, jobs: J, runsFor: sid => runsByStream[sid] || [],
    now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789' });
  R2.onShipped(fresh('sample-c1', LA, lastA));
  const waiting = R2.onShipped(fresh('sample-c2', LA, lastA));
  A.ok(waiting.ok && waiting.queued === 2, 'a second hand-off waits behind the first');
  await tick();
  const was = plan; plan = JSON.parse(JSON.stringify(plan)); delete plan.sendTo[a.outbox];
  const pend = R2._internals.live.get(LB);
  const res = await R2._internals.dispatch(pend.queue.shift(), pend);
  A.ok(res && !res.ok && /SEND TO changed/.test(res.error), 'a hand-off whose SEND TO changed while it waited is dropped with the reason');
  plan = was;
  /* (fix-runtime 54) THE TARGET LINE WAS DELETED while a hand-off waited (DELETE LINE prunes A's pointer and re-posts the plan):
     refused with the TRUE reason — the line is gone, never "the SEND TO changed" — and the record lands on the SENDER only: a
     failed record keyed by B's dead lineId would sit in line-jobs.json where no window ever shows it */
  {
    const R7 = makeHandoffRunner({ makeHub: () => ({ onInbound: () => new Promise(() => {}) }), plan: () => plan, jobs: J, runsFor: sid => runsByStream[sid] || [],
      now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    J.start({ id: 'job-gone0001', line: LA, name: 'A', text: 'first', streamId: 'sample-g1', at: clock });
    J.start({ id: 'job-gone0002', line: LA, name: 'A', text: 'waits for B', streamId: 'sample-g2', at: clock });
    R7.onShipped(fresh('sample-g1', LA, lastA));
    A.ok(R7.onShipped(fresh('sample-g2', LA, lastA)).queued === 2, 'a hand-off waits for LINE B');
    await tick();
    const keep = plan, onB = jobs.jobs.filter(j => j.line === LB).length;
    plan = JSON.parse(JSON.stringify(plan)); plan.lines = plan.lines.filter(l => l.lineId !== LB); delete plan.sendTo[a.outbox];
    const pg = R7._internals.live.get(LB);
    const gone = await R7._internals.dispatch(pg.queue.shift(), pg);
    A.ok(gone && !gone.ok && /no longer on the floor/.test(gone.error) && !/SEND TO changed/.test(gone.error), 'a hand-off whose TARGET line was deleted says so — ' + JSON.stringify(gone));
    const g2 = LineJobs.get(jobs, 'job-gone0002');
    A.ok(g2.sentTo && g2.sentTo.line === LB && g2.sentTo.jobId === null && /no longer on the floor/.test(g2.sentTo.refused || ''), '…the sending job reads NOT sent on, with why, and no job to open — ' + JSON.stringify(g2.sentTo));
    A.eq(jobs.jobs.filter(j => j.line === LB).length, onB, '…and NO record is written on the dead line');
    // the target line still stands but was REBUILT (its oldest machine went, so its key moved): the pointer follows the INBOX, the
    // waiting hand-off's line key is dead — refused as rebuilt, never "the SEND TO changed", never a record on the dead key
    plan = JSON.parse(JSON.stringify(keep));
    const reb = plan.lines.find(l => l.lineId === LB); reb.lineId = 'p_rebuilt'; plan.sendTo[a.outbox].toLine = 'p_rebuilt';
    J.start({ id: 'job-gone0003', line: LA, name: 'A', text: 'waits again', streamId: 'sample-g3', at: clock });
    pg.queue.push({ rec: { lineId: LA, dockId: lastA, streamId: 'sample-g3' }, fromLine: LA, toLine: LB, fromOutbox: a.outbox, toIntake: b.intake, fromName: 'A', toName: 'B',
      fromJobId: 'job-gone0003', lines: [LA], depth: 1, at: clock, files: [], input: '', original: 'waits again', output: 'x' });
    const rb = await R7._internals.dispatch(pg.queue.shift(), pg);
    A.ok(rb && !rb.ok && /rebuilt/.test(rb.error) && /LINE B/.test(rb.error), 'a target line rebuilt while the hand-off waited says so — ' + JSON.stringify(rb));
    A.ok(/rebuilt/.test((LineJobs.get(jobs, 'job-gone0003').sentTo || {}).refused || '') && jobs.jobs.filter(j => j.line === LB).length === onB && !jobs.jobs.some(j => j.line === 'p_rebuilt'), '…said on the sender, with no record on the dead key (nor on the new one: nothing ran there)');
    plan = keep;
  }
  A.ok(R.onShipped({ lineId: LC, agentId: 'x', dockId: c.bays[1], text: 'x', streamId: 's' }).code === 'none', 'a line that sends nowhere: nothing (the common case)');
  A.eq(R.onShipped({ agentId: 'x', text: 'x' }).code, 'none', 'no line: nothing');

  /* FILE POINTERS KEEP THE PRODUCER'S ROOT: the receiving line may use a different project or private workspace.
     The stub hub only captures the transport frame; no provider behavior or live-app completion is claimed here. */
  {
    const handed = [], warnings = [];
    const sourceRuns = [
      { agentId: 'project-agent', projectRoot: '/projects/source', reason: 'done', startedAt: 10,
        artifacts: [{ path: 'result.md' }, { path: 'result.md' }, { path: '/shared/absolute.md' }] },
      { agentId: 'private-agent', reason: 'done', startedAt: 10, artifacts: [{ path: 'result.md' }] },
      { agentId: 'windows-agent', projectRoot: 'D:\\project', reason: 'done', startedAt: 10,
        artifacts: [{ path: 'notes\\result.md' }, { path: 'C:/already/absolute.md' }, { path: '\\\\server\\share\\result.md' }] },
      { agentId: 'unknown-agent', reason: 'done', startedAt: 10, artifacts: [{ path: 'missing-root.md' }] },
      // (run-paths review) one base rule for every reader of a finished run's file: a name that climbs out of its base is omitted
      { agentId: 'climbing-agent', projectRoot: '/projects/source', reason: 'done', startedAt: 10, artifacts: [{ path: '../neighbour/secret.md' }] }
    ];
    const runner = makeHandoffRunner({
      makeHub: () => ({ onInbound(msg) { handed.push(msg.text); return Promise.resolve(); } }),
      plan: () => plan, jobs: {}, now: () => 20, newId: () => 'artifactpaths1234',
      runsFor: sid => sid === 'source-files' ? sourceRuns : [],
      workspaceOf: aid => aid === 'private-agent' ? '/workspaces/private-agent' : null,
      warn: msg => warnings.push(msg)
    });
    const sent = runner.onShipped({ lineId: LA, dockId: lastA, text: 'work product', originalText: 'make files',
      streamId: 'source-files', since: 0 });
    A.ok(sent.ok, 'file-bearing work is queued through the public handoff path');
    await tick(30);
    const paths = (handed[0] || '').split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
    A.eq(paths, ['/projects/source/result.md', '/shared/absolute.md', '/workspaces/private-agent/result.md',
      'D:\\project\\notes\\result.md', 'C:/already/absolute.md', '\\\\server\\share\\result.md'],
      'handoff files resolve per producing run, dedupe exact pointers, and preserve absolute POSIX/Windows/UNC paths');
    A.ok(warnings.some(msg => /leaves its source folder: \.\.\/neighbour\/secret\.md/.test(msg)) && !(handed[0] || '').includes('neighbour'),
      'a produced name that climbs out of its run\'s base is omitted and said (run-paths producedPath), never resolved next door');
    A.ok(warnings.some(msg => /unknown source folder: missing-root\.md/.test(msg))
      && !(handed[0] || '').includes('missing-root.md'),
      'an unknown origin is reported, never fabricated from the sidecar or receiving working directory');
  }

  /* THE SENDING JOB'S RUNS STOP AT ITS SHIP TIME: a channel chat's stream carries the NEXT message's runs too — a later run that
     ended cancelled must not refuse this job, and its files must not ride in this job's hand-off */
  {
    const calls = [];
    const R5 = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound(msg) {
        calls.push(msg.text);
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        const sid = hooks.streamId();
        runsByStream[sid] = [{ runId: 'q' + (++n), agentId, dockId: docks[0], reason: 'done', usd: 0, streamId: sid, startedAt: clock }];
        const last = plan.lines.find(l => l.lineId === hooks.lineId()).propIds.filter(id => plan.agentOfDock[id]).sort(P.propIdCmp).pop();
        hooks.send('B OUT'); hooks.onLineOutcome({ agentId: plan.agentOfDock[last], dockId: last, stopped: null });
        return Promise.resolve();
      } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    clock = 5000;
    runsByStream['chat-1'] = [{ runId: 'm1', agentId: 'ag_' + lastA, reason: 'done', usd: 0, streamId: 'chat-1', startedAt: 4990, artifacts: [{ kind: 'file', path: 'C:/w/msg1.md' }] }];
    const s1 = R5.onShipped({ lineId: LA, agentId: 'ag_' + lastA, dockId: lastA, text: 'msg1 out', originalText: 'msg1', streamId: 'chat-1', since: 4990 });
    // …the chat's next message runs on the same stream before the hand-off dispatches, ends cancelled, writes a file
    runsByStream['chat-1'].push({ runId: 'm2', agentId: 'ag_' + lastA, reason: 'cancelled', usd: 0, streamId: 'chat-1', startedAt: 5010, artifacts: [{ kind: 'file', path: 'C:/w/msg2.md' }] });
    await tick(30);
    const sent1 = calls[calls.length - 1] || '';
    A.ok(s1.ok && /msg1 out/.test(sent1) && /C:\/w\/msg1\.md/.test(sent1) && !/msg2\.md/.test(sent1), 'msg1 is handed on with ITS file only, not refused by msg2’s cancelled run — ' + JSON.stringify(sent1.slice(-160)));
  }

  /* E-STOP KILLS A RUNNING HAND-OFF: its record says STOPPED (the Commander stopped it), never "a step did not finish cleanly" */
  {
    let release = null;
    const R6 = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        const sid = hooks.streamId();
        return new Promise(res => { release = () => { runsByStream[sid] = [{ runId: 'k' + (++n), agentId, dockId: docks[0], reason: 'cancelled', usd: 0.004, streamId: sid, startedAt: clock }]; res(); }; });
      } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, halted: () => halted, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    const s6 = R6.onShipped(fresh('sample-stop', LA, lastA));
    await tick();
    A.ok(s6.ok && typeof release === 'function', 'the hand-off is running on LINE B');
    halted = true; release(); await tick(30); halted = false;
    const rec6 = jobs.jobs.filter(j => j.line === LB).pop();
    A.ok(rec6 && rec6.status === 'stopped' && /E-STOP/.test(rec6.error), 'E-STOP: the hand-off’s record is STOPPED — ' + JSON.stringify(rec6 && { status: rec6.status, error: rec6.error }));
  }

  /* THE STATION'S OWN FAULT (wave 2 review, conveyor-backend-08): a process-fault containment quiesced the station while LINE B ran a
     handed-on job — its record says the station's fault stopped it, never an E-STOP the Commander did not press; and a hand-off refused
     while the station is quiesced says the same */
  {
    let release = null, stop = false;
    const R7 = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        const sid = hooks.streamId();
        return new Promise(res => { release = () => { runsByStream[sid] = [{ runId: 'q' + (++n), agentId, dockId: docks[0], reason: 'cancelled', usd: 0.002, streamId: sid, startedAt: clock }]; res(); }; });
      } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, halted: () => stop, faulted: () => stop, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    const s7 = R7.onShipped(fresh('sample-fault', LA, lastA));
    await tick();
    A.ok(s7.ok && typeof release === 'function', 'fault: the hand-off is running on LINE B');
    stop = true; release(); await tick(30);
    const rec7 = jobs.jobs.filter(j => j.line === LB).pop();
    A.ok(rec7 && rec7.status === 'stopped' && /internal fault/.test(rec7.error) && !/E-STOP/.test(rec7.error), 'fault: the record says the station stopped it, not E-STOP — ' + JSON.stringify(rec7 && { status: rec7.status, error: rec7.error }));
    const f2 = R7.onShipped(fresh('sample-fault2', LA, lastA));
    A.ok(!f2.ok && /internal fault/.test(f2.error) && !/E-STOP/.test(f2.error), 'fault: a hand-off refused meanwhile says the fault, not E-STOP — ' + f2.error);
    stop = false;
  }

  /* A DISPATCH THAT THROWS is said, never a console line only (wave 2 review, conveyor-backend-11): the target record it already started
     says why instead of staying "running" */
  {
    const R9 = makeHandoffRunner({ makeHub: () => { throw new Error('hub down'); }, plan: () => plan, jobs: J, shipsToOutbox: () => true,
      runsFor: sid => runsByStream[sid] || [], now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    const onB9 = jobs.jobs.filter(j => j.line === LB).length;
    const s9 = R9.onShipped(fresh('sample-hubdown', LA, lastA));
    await tick(30);
    const rec9 = jobs.jobs.filter(j => j.line === LB).pop();
    A.ok(s9.ok && rec9 && rec9.status === 'failed' && rec9.error === 'the hand-off could not start (hub down)', 'a dispatch that threw finishes its record with why — ' + JSON.stringify(rec9 && { status: rec9.status, error: rec9.error }));
    A.eq(jobs.jobs.filter(j => j.line === LB).length, onB9 + 1, '…on the ONE record it started (never a second refusal record, never one left "running")');
    const after9 = R9.onShipped(fresh('sample-hubdown2', LA, lastA));
    A.ok(after9.ok, 'the line is not wedged: the next hand-off is admitted');
    await tick(30);
    // (wave 2 repair) …and the SENDING job is told: it read "Sent on to LINE B — that line works on this result next" for a hand-off
    // that never started. A throw before the target line was entered is NOT sent on, with why, linked to the record that says so
    J.start({ id: 'job-hubdown3', line: LA, name: 'A', text: 'a job whose hand-off could not start', streamId: 'sample-hubdown3', at: clock });
    R9.onShipped(fresh('sample-hubdown3', LA, lastA));
    await tick(30);
    const rec9b = jobs.jobs.filter(j => j.line === LB).pop(), snd9 = jobs.jobs.find(j => j.id === 'job-hubdown3');
    A.ok(rec9b && rec9b.error === 'the hand-off could not start (hub down)', 'the target record says why');
    A.ok(snd9 && snd9.sentTo && snd9.sentTo.refused === 'the hand-off could not start (hub down)' && snd9.sentTo.jobId === rec9b.id,
      'the sending job reads NOT sent on, with why, linked to that record — ' + JSON.stringify(snd9 && snd9.sentTo));
  }

  /* A DISPATCH THAT BREAKS AFTER THE TARGET LINE WAS ENTERED (wave 2 repair): the work did reach LINE B, so the record says it broke
     after it started — never "could not start" — and the sending job keeps its plain link to that record (it WAS sent on) */
  {
    const RE = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        return Promise.resolve();
      } }), emit: (nm) => { if (nm === 'workitem.placed') throw new Error('bus down'); },
      plan: () => plan, jobs: J, shipsToOutbox: () => true, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    J.start({ id: 'job-busdown1', line: LA, name: 'A', text: 'a job whose hand-off broke after it started', streamId: 'sample-busdown1', at: clock });
    RE.onShipped(fresh('sample-busdown1', LA, lastA));
    await tick(30);
    const recE = jobs.jobs.filter(j => j.line === LB).pop(), sndE = jobs.jobs.find(j => j.id === 'job-busdown1');
    A.ok(recE && recE.status === 'failed' && recE.error === 'the hand-off broke after it started (bus down)', 'entered, then broke: said as such — ' + JSON.stringify(recE && { status: recE.status, error: recE.error }));
    A.ok(sndE && sndE.sentTo && !sndE.sentTo.refused && sndE.sentTo.jobId === recE.id, 'the sending job keeps its link to the record that says what happened — ' + JSON.stringify(sndE && sndE.sentTo));
  }

  /* THE HUB'S STOP NOTICE IS NOT THE JOB'S OUTPUT (wave 2 repair, conveyor-backend-08): a killed hub run tells its chat it was stopped
     ("⏹ Stopped — E-STOP was pressed in the station…", or the fault's own words) through the same send hook the job's replies use. The
     STOPPED card showed that notice under "What came out" and offered NEEDS CHANGES against it. Once the station is stopped, nothing
     more is this job's output (the sample route's rule); what was said before the stop stays. */
  {
    for (const fault of [false, true]) {
      let release = null, stop = false;
      const RN = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
          const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
          hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
          const sid = hooks.streamId();
          hooks.send('the first part of the answer');
          return new Promise(res => { release = () => {
            runsByStream[sid] = [{ runId: 'nt' + (++n), agentId, dockId: docks[0], reason: 'cancelled', usd: 0.001, streamId: sid, startedAt: clock }];
            hooks.send(fault ? '⏹ Stopped — the station hit an internal fault and stopped this run. This message got no reply and nothing further will run for it.'
              : '⏹ Stopped — E-STOP was pressed in the station. This message got no reply and nothing further will run for it.');
            res();
          }; });
        } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, halted: () => stop, faulted: () => stop && fault, runsFor: sid => runsByStream[sid] || [], now: () => clock,
        newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
      const sN = RN.onShipped(fresh('sample-notice-' + fault, LA, lastA));
      await tick();
      A.ok(sN.ok && typeof release === 'function', (fault ? 'fault' : 'E-STOP') + ' notice: the hand-off is running on LINE B');
      stop = true; release(); await tick(30); stop = false;
      const recN = jobs.jobs.filter(j => j.line === LB).pop();
      A.ok(recN && recN.status === 'stopped', (fault ? 'fault' : 'E-STOP') + ' notice: the record is STOPPED');
      A.ok(!/⏹|E-STOP|Stopped —/.test(recN.output || ''), (fault ? 'fault' : 'E-STOP') + ' notice: the hub\'s stop notice is not the job\'s output — ' + JSON.stringify(recN.output));
      A.ok(/the first part of the answer/.test(recN.output || ''), (fault ? 'fault' : 'E-STOP') + ' notice: what was said before the stop stays');
    }
  }

  /* THE STATION IS QUITTING (wave 2 repair, conveyor-backend-03): the graceful shutdown drains the waiting hand-offs, but a hub-driven
     job on another line can still finish inside the shutdown window (runs are booked for up to ~3 s before exit) — its onShipped used
     to queue a NEW hand-off behind the running one, and process.exit dropped it with no record on either line. haltAll(why,
     { close: true }) closes admission too: every later hand-off goes through the refusal path with the same reason. */
  {
    let release = null;
    const RQ = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        const sid = hooks.streamId();
        return new Promise(res => { release = () => {
          runsByStream[sid] = [{ runId: 'qt' + (++n), agentId, dockId: docks[0], reason: 'done', usd: 0.001, streamId: sid, startedAt: clock }];
          hooks.onLineOutcome({ agentId, dockId: docks[0], stopped: null, hops: [] });
          res();
        }; });
      } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    J.start({ id: 'job-quit0001', line: LA, name: 'A', text: 'running when the station quit', streamId: 'sample-quit1', at: clock });
    const q1 = RQ.onShipped(fresh('sample-quit1', LA, lastA));
    await tick();
    A.ok(q1.ok && typeof release === 'function', 'quit: one hand-off is running on LINE B');
    const why = 'the station stopped before this hand-off ran — send the job again';
    A.eq(RQ.haltAll(why, { close: true }), 0, 'quit: nothing was waiting yet');
    J.start({ id: 'job-quit0002', line: LA, name: 'A', text: 'finished while the station was quitting', streamId: 'sample-quit2', at: clock });
    const q2 = RQ.onShipped(fresh('sample-quit2', LA, lastA));
    A.ok(!q2.ok && q2.error === why, 'quit: a job that ships after the quit began is refused with the quit reason, never queued — ' + JSON.stringify(q2));
    A.eq((RQ.status().lines.find(x => x.line === LB) || {}).queued, 0, 'quit: nothing waits in memory to vanish at exit');
    const snd = jobs.jobs.find(j => j.id === 'job-quit0002');
    A.ok(snd && snd.sentTo && snd.sentTo.refused === why, 'quit: the sending job reads NOT sent on, with why — ' + JSON.stringify(snd && snd.sentTo));
    const onB = jobs.jobs.filter(j => j.line === LB && j.status === 'failed').pop();
    A.ok(onB && onB.error === 'not sent on: ' + why, 'quit: LINE B has the refusal on record');
    release(); await tick(30);
    const ran = jobs.jobs.find(j => j.line === LB && j.from && j.from.jobId === 'job-quit0001');
    A.ok(ran && ran.status === 'delivered', 'quit: the one already running finishes on its own record — ' + JSON.stringify(ran && { status: ran.status, error: ran.error }));
    // an E-STOP drain (no close) never closes admission: after RESUME the next hand-off goes
    const RO = makeHandoffRunner({ makeHub: () => ({ onInbound: () => new Promise(() => {}) }), plan: () => plan, jobs: J, shipsToOutbox: () => true,
      runsFor: sid => runsByStream[sid] || [], now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    RO.haltAll();
    A.ok(RO.onShipped(fresh('sample-after-estop', LA, lastA)).ok, 'an E-STOP drain alone leaves admission open');
    // the host's graceful shutdown is what closes it (sidecar/index.js gracefulShutdown — never require it: it boots a sidecar)
    const shut = A.fnBody(readSidecarSource(), 'function gracefulShutdown(signal)');
    A.ok(/handoffRunner\.haltAll\('the station stopped before this hand-off ran — send the job again', \{ close: true \}\)/.test(shut), 'gracefulShutdown drains AND closes SEND TO admission');
  }

  /* THE CAP WON THE RACE: the hand-off passed its dispatch preflight, then LINE B's own work reached the day limit before the entry
     ran — runOnceCore refuses before any run row exists and the hub replies with the reason. The record says that reason, never
     the bare "no step ran" (the trigger runner's pattern: the hub's ⚠ reply is the only witness when no run was recorded) */
  {
    const capWords = 'The line reached its $1.00 daily limit — raise its LINE BUDGET or try again tomorrow.';
    const R8 = makeHandoffRunner({ makeHub: (hooks) => ({ onInbound() {
        const docks = crewedDocksOnLine(plan, hooks.lineId()).sort(P.propIdCmp), agentId = plan.agentOfDock[docks[0]];
        hooks.onRouted({ agentId, dockId: docks[0] }); hooks.onResolved({ agentId, lineId: hooks.lineId(), dockId: docks[0] });
        hooks.send('⚠ ' + capWords);
        return Promise.resolve();
      } }), plan: () => plan, jobs: J, shipsToOutbox: () => true, runsFor: sid => runsByStream[sid] || [], now: () => clock,
      newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {} });
    const s8 = R8.onShipped(fresh('sample-cap-race', LA, lastA));
    await tick(30);
    const rec8 = jobs.jobs.filter(j => j.line === LB).pop();
    A.ok(s8.ok && rec8 && rec8.status === 'failed' && rec8.error === capWords, 'a hand-off the day cap refused at the run says the cap, not "no step ran" — ' + JSON.stringify(rec8 && { status: rec8.status, error: rec8.error }));
  }
}
)().then(() => {
  /* ---------- THE RECORD (linejobs) ---------- */
  let s = { jobs: [] };
  s = LineJobs.start(s, { id: 'job-bbbb2222', line: 'p20', text: 'handed on', streamId: 'handoff-1', at: 5, from: { line: 'p10', jobId: 'job-aaaa1111', name: 'RESEARCH', junk: 1 } }).state;
  A.eq(LineJobs.get(s, 'job-bbbb2222').from, { line: 'p10', jobId: 'job-aaaa1111', name: 'RESEARCH' }, 'from is kept (and only its own fields)');
  s = LineJobs.link(s, 'job-bbbb2222', { line: 'p30', jobId: 'nope', name: 'X'.repeat(80) }).state;
  A.eq(LineJobs.get(s, 'job-bbbb2222').sentTo, { line: 'p30', jobId: null, name: 'X'.repeat(48) }, 'sentTo: a bad job id is null, the name bounded');
  s = LineJobs.finish(s, 'job-bbbb2222', { at: 9, status: 'delivered', output: 'ok', runs: [] }).state;
  const g = LineJobs.get(s, 'job-bbbb2222');
  A.ok(g.status === 'delivered' && g.sentTo && g.sentTo.line === 'p30' && g.from.line === 'p10', 'finish keeps both ends');
  const back = LineJobs.normalizeAll(JSON.parse(JSON.stringify(s)));
  A.ok(back.jobs[0].from.jobId === 'job-aaaa1111' && back.jobs[0].sentTo.line === 'p30', 'both survive a save + reload');
  const sum = LineJobs.list(s, {})[0];
  A.ok(sum.from && sum.from.name === 'RESEARCH' && sum.sentTo && sum.sentTo.line === 'p30', 'the window’s list carries both');
  A.eq(LineJobs.byStream(s, 'handoff-1').id, 'job-bbbb2222', 'byStream finds the job a stream belongs to');
  A.eq(LineJobs.normJob({ id: 'job-cccc3333', line: 'p1', from: { line: 'bad line!' } }).from, null, 'a junk end is null');
  const rj = LineJobs.normJob({ id: 'job-dddd4444', line: 'p1', text: 'the job', handedIn: 'y'.repeat(20000), from: { line: 'p2' }, sentTo: { line: 'p3', refused: 'E-STOP' }, repeats: 3 });
  A.ok(rj.handedIn.length === LineJobs.MAX_OUTPUT && rj.sentTo.refused === 'E-STOP' && rj.repeats === 3, 'handedIn (bounded like an output), sentTo.refused and repeats are kept');
  const plain = LineJobs.normJob({ id: 'job-dddd4445', line: 'p1', handedIn: 'x', sentTo: { line: 'p3' } });
  A.ok(!('handedIn' in plain) && !('repeats' in plain) && !('refused' in plain.sentTo), '…and absent where they do not apply (a job with no `from` keeps no handedIn)');
  A.report('routing.handoff.test');
}).catch(err => { console.log('FAIL: threw ' + (err && err.stack || err)); process.exit(1); });
