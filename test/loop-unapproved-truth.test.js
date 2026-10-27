/* test/loop-unapproved-truth.test.js — GitHub #122, the TRUTH half: a review loop (reviewer → back to the maker → … until VERDICT:
   approved, at most N passes) that runs out of passes still sends the work ON down its DONE lane — that is the LOOP card's rule and
   it is unchanged here. What changes is that nothing downstream may treat that work as approved: chain.js marked the job
   `loopExhausted` and nothing read it, so the OUTBOX product, the SEND TO hand-off, SHIPPED and the job record all read it as a
   normal clean delivery. The job now carries `unapproved` (why, in words) through the same seams `partial` rides:
     CHAIN     — out.unapproved; the line-output event and the onShipped record carry it; the flow (DONE lane, OUTBOX) is unchanged;
     SHIPPED   — the receipt refuses it: SHIPPED counts clean work only, and an unapproved job is not (it is still delivered);
     SEND TO   — still handed on (the LOOP sends it on), but the frame the next line reads and its job record say it came unapproved;
     RECORD    — the job record keeps `unapproved`; the route, hub, trigger and station.test_line carry it.
   Fake harness, fake clock — no provider. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { makeChainRunner, loopDecision } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeLineShipments } = require('../sidecar/routing/line-shipments.js');
const { makeHandoffRunner } = require('../sidecar/routing/handoff-runner.js');
const { crewedDocksOnLine } = require('../sidecar/routing/trigger-runner.js');
const LineJobs = require('../sidecar/routing/linejobs.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
const tick = (ms) => new Promise(r => setTimeout(r, ms || 15));
let T = 0; const clock = () => (T += 10);

// INBOX -> drafter -> reviewer -> LOOP gate (VERDICT: approved, 2 passes) -> (done E -> <done prop> | back N -> drafter)
function loopFloor(doneProp) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return geo([{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', maxIter: 2, when: 'approved' },
    doneProp], belts);
}
const NEVER = { drafter: { text: 'another draft', usd: 0.01 }, reviewer: { text: 'still weak\nVERDICT: revise', usd: 0.01 }, publisher: { text: 'published', usd: 0.01 } };
const APPROVES = { drafter: { text: 'another draft', usd: 0.01 }, reviewer: { text: 'good\nVERDICT: approved', usd: 0.01 }, publisher: { text: 'published', usd: 0.01 } };

// dock mode, the partial-join test's rig: the OUTBOX the job lands in is known, so the line-output event can fire
async function dockRun(script) {
  const plan = P.compileRoutingPlan(loopFloor({ id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 })), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'fixture: the loop-to-OUTBOX floor deploys');
  const lineId = router.lineOriginFor('drafter', 'p2');
  const events = [], shipped = [];
  const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x),
    entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: r => { shipped.push(r); }, emit: (n, p) => events.push({ n, p }), now: clock,
    getTag: () => 'general', setTimer: () => 0 });
  const res = await c.advance({ agentId: 'reviewer', dockId: 'p3', text: script.reviewer.text, originalText: 'write a post', lineId, runId: 'run-' + T, streamId: 'sample-s' + T,
    runAgent: async h => script[h.agentId] });
  await new Promise(r => setImmediate(r));
  return { res, outputs: events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output'), shipped };
}
// agent mode with a PUBLISHER on the done lane: the final text is the publisher's, with no LOOP note left in it
async function publisherRun(script) {
  const plan = P.compileRoutingPlan(loopFloor({ id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' })), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'fixture: the loop-to-publisher floor deploys');
  const shipped = [];
  const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepAgent: (a, x) => router.chainStep(a, x), fanSiblings: a => router.fanSiblings(a),
    lineOfAgent: a => router.lineOfAgent(a), getTag: () => 'general', lastStage: a => a === 'publisher', onShipped: r => { shipped.push(r); },
    runAgent: async h => script[h.agentId], emit: () => {}, now: clock, setTimer: () => 0 });
  const res = await c.advance({ agentId: 'reviewer', text: script.reviewer.text, originalText: 'write a post', lineId: P.lineOf(plan, 'drafter'), runId: 'pub-' + T });
  await new Promise(r => setImmediate(r));
  return { res, shipped };
}

(async () => {
  /* ---------- CHAIN: the flow is unchanged, the job says it went on unapproved ---------- */
  {
    const d = loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher' }, { verdict: 'revise' }, 2, {}, 'w\nVERDICT: revise');
    A.ok(d.exhausted && !d.again && d.target === 'publisher', 'loopDecision: still leaves on DONE at max passes (the LOOP card’s rule, unchanged)');
    A.eq(d.why, 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved', 'loopDecision says why in words');
    const ok = loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher' }, { verdict: 'approved' }, 1, {}, 'w\nVERDICT: approved');
    A.ok(!ok.exhausted && !ok.why, 'an approved pass has no why');

    const never = await dockRun(NEVER);
    A.eq(never.res.stopped, null, 'an exhausted loop still runs to its OUTBOX (' + never.res.stopped + ')');
    A.eq(never.res.outboxId, 'p6', '…and lands there');
    A.ok(never.res.loopExhausted === true, 'loopExhausted stays set');
    A.ok(typeof never.res.unapproved === 'string' && /used all 2 passes without VERDICT: approved/.test(never.res.unapproved), 'the job is marked unapproved, in words (' + never.res.unapproved + ')');
    A.eq(never.outputs.length, 1, 'the OUTBOX still gets its product (routing unchanged)');
    A.ok(!!never.res.unapproved && never.outputs[0] && never.outputs[0].p.unapproved === never.res.unapproved, '…and the line-output event says it went on unapproved');
    A.ok(!!never.res.unapproved && never.shipped.length === 1 && never.shipped[0].unapproved === never.res.unapproved && !never.shipped[0].partial, 'SEND TO hears of it as UNAPPROVED (not partial, not clean)');

    const approved = await dockRun(APPROVES);
    A.ok(!approved.res.unapproved && !approved.res.loopExhausted, 'an approved job is not marked');
    A.ok(approved.outputs.length === 1 && !('unapproved' in approved.outputs[0].p), 'its line-output event is unchanged');
    A.ok(approved.shipped.length === 1 && !('unapproved' in approved.shipped[0]), 'its shipment record is unchanged');

    const pub = await publisherRun(NEVER);
    A.eq(pub.res.text, 'published', 'with a publisher on the DONE lane the delivered text carries no LOOP note…');
    A.ok(/used all 2 passes/.test(pub.res.unapproved || ''), '…so the job’s own mark is what says it went on unapproved');
    A.ok(!!pub.res.unapproved && pub.shipped.length === 1 && pub.shipped[0].unapproved === pub.res.unapproved, '…and the shipment record carries it');
  }

  /* ---------- SHIPPED: the receipt counts clean work only ---------- */
  {
    let saved = [];
    const rows = [{ runId: 'e1', agentId: 'reviewer', streamId: 's1', lineId: 'p1', reason: 'done', toolsOk: 1 }];
    const S = makeLineShipments({ now: () => 1000, load: () => saved, save: v => { saved = v; }, runsFor: () => rows });
    const rec = { lineId: 'p1', entryRunId: 'e1', streamId: 's1', outboxId: 'p6', agentId: 'reviewer' };
    A.eq(S.record(Object.assign({ unapproved: 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved' }, rec)), false, 'an unapproved job mints no SHIPPED receipt');
    A.eq(S.snapshot().length, 0, '…SHIPPED stays 0');
    A.eq(S.jobShipped('p1', ['e1']), false, '…and the job reads as not counted');
    A.eq(S.record(rec), true, 'the same job approved is a receipt');
  }

  /* ---------- THE RECORD: linejobs keeps the mark ---------- */
  {
    let st = LineJobs.start({ jobs: [] }, { id: 'job-aaaa1111', line: 'p1', name: 'A', text: 'x', streamId: 's1', at: 1 }).state;
    const fin = LineJobs.finish(st, 'job-aaaa1111', { at: 2, status: 'delivered', usd: 0, output: 'w', runs: [], unapproved: 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved' });
    A.eq(fin.job.status, 'delivered', 'the job is still delivered (it reached the OUTBOX)');
    A.ok(/used all 2 passes/.test(fin.job.unapproved || ''), 'the record keeps unapproved');
    A.ok(/used all 2 passes/.test(LineJobs.summary(fin.job).unapproved || ''), 'the window’s list carries it');
    A.ok(/used all 2 passes/.test((LineJobs.normalizeAll(JSON.parse(JSON.stringify(fin.state))).jobs[0] || {}).unapproved || ''), 'it survives a save and reload');
    const clean = LineJobs.finish(st, 'job-aaaa1111', { at: 2, status: 'delivered', usd: 0, output: 'w', runs: [] });
    A.ok(!('unapproved' in clean.job), 'a clean job’s record is unchanged');
    st = LineJobs.start({ jobs: [] }, { id: 'job-bbbb2222', line: 'p9', name: 'B', text: 'x', streamId: 's2', at: 1, from: { line: 'p1', jobId: 'job-aaaa1111', name: 'A', unapproved: 'the review loop used all 2 passes' } }).state;
    A.ok(/used all 2 passes/.test(((st.jobs[0] || {}).from || {}).unapproved || ''), 'a handed-on job’s record says the work it was handed came unapproved');
  }

  /* ---------- SEND TO: still handed on, said in the frame and on the next line's record ---------- */
  {
    const why = 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved';
    const frame = P.handoffInput({ fromName: 'A', original: 'Write a post.', output: 'the draft', unapproved: why });
    A.ok(frame.indexOf('NOT APPROVED') > 0 && frame.indexOf(why) > 0, 'the frame the next line reads says the work came unapproved');
    const back = P.parseHandoffInput(frame);
    A.ok(back && back.original === 'Write a post.' && back.output === 'the draft', 'and still reads back as the job + what was delivered');
    A.eq(P.handoffInput({ fromName: 'A', original: 'Write a post.', output: 'the draft' }), P.handoffInput({ fromName: 'A', original: 'Write a post.', output: 'the draft', unapproved: '' }), 'a clean hand-off’s frame is byte-identical');

    const d = WM.starterDoc();
    for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 44; r.y2 = 20; }
    const st = WM.create(d), L = [];
    for (let i = 0; i < 2; i++) {
      const r = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 + i * 6 });
      const of = t => r.ids.filter(id => st.propById(id).t === t);
      L.push({ intake: of('intake')[0], bays: of('bay'), outbox: of('outbox')[0] });
      st.setPropLabel(of('intake')[0], String.fromCharCode(65 + i));
    }
    for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
    A.ok(st.setSendTo(L[0].outbox, L[1].intake).ok, 'fixture: A → B');
    const plan = P.compileRoutingPlan(st.projectGeometry());
    const LA = plan.lineOfProp[L[0].intake], LB = plan.lineOfProp[L[1].intake];
    let jobs = { jobs: [] };
    const J = { byStream: s => LineJobs.byStream(jobs, s), latest: l => LineJobs.latest(jobs, l),
      start: r => { const x = LineJobs.start(jobs, r); if (x.job) jobs = x.state; return x.job; },
      finish: (id, r) => { const x = LineJobs.finish(jobs, id, r); if (x.job) jobs = x.state; return x.job; },
      link: (id, to) => { const x = LineJobs.link(jobs, id, to); if (x.job) jobs = x.state; return x.job; },
      again: (id, at) => { const x = LineJobs.again(jobs, id, at); if (x.job) jobs = x.state; return x.job; } };
    const runs = {}, calls = []; let n = 0;
    const R = makeHandoffRunner({ plan: () => plan, jobs: J, emit: () => {}, shipsToOutbox: (a, dock) => !!dock, runsFor: s => runs[s] || [],
      now: () => 1000, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {},
      makeHub: hooks => ({ _internals: { inflight: new Map() }, onInbound(msg) {
        const line = hooks.lineId(); calls.push({ line, msg });
        const dock = crewedDocksOnLine(plan, line).sort(P.propIdCmp)[0], agentId = plan.agentOfDock[dock];
        hooks.onRouted({ agentId, dockId: dock }); hooks.onResolved({ chatId: msg.chatId, agentId, isTask: true, lineId: line, dockId: dock });
        const sid = hooks.streamId();
        return Promise.resolve().then(() => { runs[sid] = [{ runId: 'r' + (++n), agentId, dockId: dock, reason: 'done', usd: 0, streamId: sid, startedAt: 1000 }];
          hooks.send('B OUT'); hooks.onLineOutcome({ agentId, dockId: dock, stopped: null, hops: [] }); });
      } }) });
    J.start({ id: 'job-cccc3333', line: LA, name: 'A', text: 'Write a post.', streamId: 'sample-u1', at: 990 });
    runs['sample-u1'] = [{ runId: 'u1', agentId: 'ag_' + L[0].bays[1], reason: 'done', usd: 0, streamId: 'sample-u1', startedAt: 995 }];
    const q = R.onShipped({ lineId: LA, agentId: 'ag_' + L[0].bays[1], dockId: L[0].bays[1], text: 'the draft', originalText: 'Write a post.', streamId: 'sample-u1', since: 990, unapproved: why });
    A.ok(q.ok && q.toLine === LB, 'an unapproved job is still handed on (the LOOP sends it on) — ' + JSON.stringify(q));
    await tick(40);
    const toB = calls.find(c => c.line === LB);
    A.ok(toB && toB.msg.text.indexOf(why) > 0 && /NOT APPROVED/.test(toB.msg.text), 'LINE B is told the work it was handed came unapproved');
    const yb = jobs.jobs.find(j => j.line === LB);
    A.ok(yb && yb.from && yb.from.unapproved === why, 'B’s record says the work came from A unapproved — ' + JSON.stringify(yb && yb.from));
    A.ok(yb && yb.status === 'delivered' && !yb.unapproved, 'B’s own result is B’s: its own line approved nothing it was not asked to');
  }

  /* ---------- the seams this test cannot run (index.js boots a sidecar): the field is carried, the wording is said ---------- */
  {
    const hub = read('sidecar/channels/hub.js');
    A.ok(/if \(line\.unapproved\) lo\.unapproved = String\(line\.unapproved\);/.test(hub), 'hub: the line outcome carries unapproved');
    const trg = read('sidecar/routing/trigger-runner.js');
    A.ok(/if \(completed && lo && lo\.unapproved\) outcome\.unapproved = String\(lo\.unapproved\)/.test(trg), 'trigger runner: a fire’s outcome says it went on unapproved');
    const idx = readSidecarSource();
    A.ok(/const unapproved = \(sampleLineOutcome && sampleLineOutcome\.unapproved\) \? String\(sampleLineOutcome\.unapproved\) : '';/.test(idx), 'sample route reads unapproved from the line outcome');
    A.ok(/unapproved: completed \? unapproved : ''/.test(idx), 'the job record keeps it');
    A.ok(/\(shipped === false && unapproved\) \? \{ shippedWhy: 'unapproved' \} : shippedWhy \? \{ shippedWhy \} : null/.test(idx), 'the route says why it is not in SHIPPED');
    A.ok(/sample: true \}, unapproved \? \{ unapproved \} : null\)\)/.test(idx) && /shippedWhy \? \{ shippedWhy \} : null, unapproved \? \{ unapproved \} : null/.test(idx), 'the crate and the answer carry it');
    const T = require('../sidecar/routing/triggers.js');
    const tr = T.normalizeTrigger({ id: 'trg_abc12345', kind: 'webhook', lineId: 'p1', name: 'x', lastOutcome: { ok: true, at: 1, runs: 2, unapproved: 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved' } });
    A.ok(tr && tr.lastOutcome && /used all 2 passes/.test(tr.lastOutcome.unapproved || ''), 'a trigger’s last outcome keeps unapproved through its normalizer');
    const tc = T.normalizeTrigger({ id: 'trg_abc12345', kind: 'webhook', lineId: 'p1', name: 'x', lastOutcome: { ok: true, at: 1, runs: 2 } });
    A.ok(tc && tc.lastOutcome && !('unapproved' in tc.lastOutcome), '…and a clean one is unchanged');
    const tool = read('sidecar/tools/builtin/station.js');
    A.ok(/o\.unapproved \|\| \/LOOP — exhausted\/\.test\(said\)/.test(tool), 'station.test_line tells the lead the review loop never approved it');
  }

  /* ---------- THE OUTBOX / WORKFLOWS cards say it (the panels' own functions, sliced and run over stubs — test/rc-final-seams' rig) ---------- */
  {
    const vm = require('node:vm');
    const rd = p => read(p).replace(/\r\n/g, '\n');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const strip = h => String(h).replace(/<[^>]+>/g, '').replace(/&#39;/g, "'");
    const load = (src, headers, globals, extra) => {
      const body = headers.map(h => A.fnBody(src, h)).join('\n'), names = headers.map(h => /function (\w+)\(/.exec(h)[1]);
      const ctx = vm.createContext(Object.assign({ esc, console, JSON, Math, Date, String, Object, Array, Promise, Number, isFinite }, globals));
      return vm.runInContext((extra || '') + '\n' + body + '\n({ ' + names.join(', ') + ' })', ctx);
    };
    const LOOP = "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;";
    const why = 'the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved';
    const panel = rd('frontend/app/workflowpanel.js');
    const tipLine = (/\n  const NOT_SHIPPED_RULE = [^\n]*\n/.exec(panel) || [''])[0];
    const fns = load(panel, ['function jobResultHTML(mine, f)', 'function loopNotes(text)', 'function notShippedNote(mine)'], {
      prop: () => null, nameOf: a => String(a).toUpperCase(), stepText: () => 'reply', stepOut: {}, H: { sampleHTML: () => '', plan: () => ({}) }, WL: () => null,
      S: {}, exampleKept: () => false, notRightHTML: () => '', Pipeline: undefined, runEnd: r => r
    }, LOOP + tipLine);
    const runs = [{ runId: 'r1', agentId: 'publisher', reason: 'done', usd: 0.01 }];
    const card = o => fns.jobResultHTML(Object.assign({ view: { ok: true, usd: 0.01 }, runs, output: 'published', stamp: 1, shipped: true }, o), null);
    const un = card({ unapproved: why, shipped: false, shippedWhy: 'unapproved' });
    A.ok(/✓ DELIVERED/.test(un) && strip(un).indexOf('⚠ The review loop used all 2 passes without VERDICT: approved, so the work went on unapproved.') >= 0,
      'RUN ONE REAL JOB: delivered, and says in the loop note’s own line that nobody approved it — ' + strip(un).slice(0, 220));
    A.ok(/unapproved: not counted in SHIPPED/.test(strip(un)) && /SHIPPED never counts unapproved work/.test(un), '…and why it is not in SHIPPED');
    const noted = card({ unapproved: why, output: '[LOOP — exhausted: 2 passes round the gate at 12,4 without VERDICT: approved — leaving on DONE unapproved]\nthe draft' });
    A.eq((noted.match(/class="wf-warnline"/g) || []).length, 1, 'a result that carries the loop’s own note says it once, not twice');
    const clean = card({});
    A.ok(!/unapproved/i.test(strip(clean)), 'a clean job’s card is unchanged');

    const win = rd('frontend/app/windows/workflows.js');
    const st = { propById: () => null };
    const wf = load(win, ['function resultHTML(l, job)', 'function workOf(text)'], {
      stationOf: () => st, S: { stepOut: {}, prev: {}, fix: null }, ReturnStore: undefined, secs: () => '1s', usd: () => '$0.01', NAME: a => a.toUpperCase(),
      lineWord: () => 'LINE A', ago: () => 'now', styleKept: () => false, runningJob: () => null, fixHTML: () => '', P: () => null, Pipeline: undefined
    }, LOOP);
    const job = o => Object.assign({ id: 'job-aaaa1111', status: 'delivered', text: 'job', output: 'published', usd: 0.01, runs: [{ runId: 'r1', agentId: 'pub', reason: 'done', usd: 0.01 }], notes: [] }, o);
    const wun = strip(wf.resultHTML({ key: 'L', steps: [] }, job({ unapproved: why })));
    A.ok(/✓ DELIVERED/.test(wun) && wun.indexOf('⚠ The review loop used all 2 passes without VERDICT: approved, so the work went on unapproved.') >= 0, 'WORKFLOWS / the OUTBOX: the job record says it went on unapproved');
    A.ok(!/unapproved/i.test(strip(wf.resultHTML({ key: 'L', steps: [] }, job({})))), '…and a clean record says nothing of it');
    const fromUn = strip(wf.resultHTML({ key: 'L', steps: [] }, job({ from: { line: 'p1', jobId: null, name: 'A', unapproved: why }, handedIn: 'the draft' })));
    A.ok(fromUn.indexOf('From LINE A — that line finished its part and sent its result on to this one. On LINE A, the review loop used all 2 passes without VERDICT: approved, so the work went on unapproved.') >= 0,
      'the next line’s job says the work it was handed came unapproved — ' + fromUn.slice(0, 200));
    A.ok(/\(lo\.unapproved \? ' · <span class="trg-warn" data-tip="' \+ esc\(lo\.unapproved\) \+ '">unapproved<\/span>' : ''\)/.test(panel), 'a trigger’s ✓ reached the OUTBOX says unapproved beside it');
    A.ok(/unapproved: response && typeof response\.unapproved === 'string'/.test(rd('frontend/app/build.js')), 'the panel keeps the server’s unapproved mark');
  }

  A.report('loop-unapproved-truth.test');
})();
