/* node test/line-hold.approve-shown.test.js — THE JOB BOX SHOWS WHAT APPROVE CARRIES ON (line-hold lane; invariant approve-releases-what-the-card-shows).

   APPROVE says it is "the work goes on exactly as it is shown here". The card printed the walk's `lastHanded` — the draft the reviewing dock
   was HANDED — under "The work under review", but the walk releases something else when the gate's back lane re-enters the reviewing dock
   itself (the reviewer IS the writer: its own reply, without its VERDICT line) and when the crate is a JOINER's merge (the merged crate,
   not what the branches were handed). A person approved the original request or a plan while the reviewer's reply, or every branch's
   merged text, went down the line and to the OUTBOX. The card also did not show the files that ride with the work or the parts of the other
   branches parked at the join, which APPROVE merges in and sends on.

   The family, through the real thing (the real router, chain, runner and store, a restart in between, the window's own code in a vm over a
   real station model): for every shape of hold the text under "The work under review" in the real card is the text the APPROVE decision
   delivers, or hands to the next stage —
       a plain gate to the OUTBOX · a plain gate with a stage after it · a gate that loops back into its own dock (its reply with and
       without a VERDICT line) · a gate right after a joiner · a gate inside a branch with a sibling parked at the join · a draft that is empty
   — and the card lists the files the record says the work carries and the parked sibling parts. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const WL = require('../frontend/app/workflowline.js');
const LE = require('../frontend/app/lineedit.js');
const WM = require('../frontend/app/worldmodel.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const LineVerdict = require('../frontend/app/line-verdict.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, AFTER } = require('./helpers/line-hold-rig.js');

const belt = (x, y, dir) => ({ x, y, dir });
// INBOX -> SPLIT -> (A | B) -> JOINER -> D -> OUTBOX (the split test's floor); A is the entry dock
function splitFloor() {
  return { props: [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 }, { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
    { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' }, { id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 }, { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' },
    { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }],
  belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'), belt(8, 0, 'S'), belt(8, 1, 'S'),
    belt(8, 2, 'S'), belt(8, 3, 'S'), belt(8, 4, 'E'), belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'), belt(8, 5, 'E'), belt(9, 5, 'N'), belt(9, 4, 'E'),
    belt(10, 4, 'E'), belt(11, 4, 'E'), belt(14, 4, 'E')] };
}
// a gate on A's lane that loops back into A (a self-loop); A is the entry branch
function F1() { const g = splitFloor(); g.props.push({ id: 'p7', t: 'loop', x: 8, y: 2, w: 1, h: 1, done: 'S', when: 'approved', maxIter: 2 }); g.belts.push(belt(7, 2, 'W')); return g; }
// a gate on B's lane that loops back into B; A (the entry) parks at the joiner first
function F2() { const g = splitFloor(); g.props.push({ id: 'p7', t: 'loop', x: 6, y: 5, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 });
  g.belts.push(belt(6, 6, 'W'), belt(5, 6, 'W'), belt(4, 6, 'W'), belt(3, 6, 'W')); return g; }
// a gate right after the joiner, done lane to the OUTBOX
function F3() { const g = splitFloor(); g.props = g.props.filter(p => p.id !== 'p6' && p.id !== 'p8');
  g.props.push({ id: 'p7', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 });
  g.belts = g.belts.filter(b => !(b.x === 14 && b.y === 4)); g.belts.push(belt(12, 4, 'E'), belt(13, 4, 'E'), belt(14, 4, 'E')); return g; }
const SPLIT = { entry: { agentId: 'A', dockId: 'p3' }, agents: ['A', 'B', 'D'] };

// the WORKFLOWS window's own code over a real station model (the way line-hold.ui.test.js runs it); only fetch is faked
function windowOf() {
  const st = WM.create(WM.starterDoc());
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Set, Map, encodeURIComponent,
    U: { bus: { on() {} } }, module: { exports: {} }, window: {}, document: { activeElement: null, querySelector: () => null },
    StationUI: { registerWindow() {}, openTerm() {}, h: { present: [{ id: 'nova', name: 'NOVA' }], sfx() {}, notify() {}, navigateWork() {} } },
    App: { station: () => st }, Pipeline: P, WorkflowLine: WL, LineEdit: LE, WorldModel: WM, RunOutcome, LineVerdict,
    Build: { nagWhy: c => 'nag:' + c, lineSchematic: () => null, machineStill: () => '', lineWords: () => ({ plain: { research_line: 'R' }, purpose: { research_line: 'x' } }) },
    World: { syncPlan: () => Promise.resolve({ errors: [] }), bayLive: () => null }, ReturnStore: { foldRow() { return true; }, pendingRows: () => [] },
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, jobs: [] }) })
  });
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend/app/windows/workflows.js'), 'utf8'), ctx, { filename: 'workflows.js' });
  const WW = ctx.module.exports; WW._pick('research_line'); WW._create();
  return { WW, line: WW._floor().lines[0] };
}
const { WW, line } = windowOf();
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, '\'').replace(/&amp;/g, '&');
const cardOf = job => WW._resultHTML(line, Object.assign({}, JSON.parse(JSON.stringify(job)), { line: line.key }));
const shownOf = html => { const m = /The work under review<\/div><div[^>]*data-md-src="([^"]*)"/.exec(html); return m ? unesc(m[1]) : null; };
const partsOf = html => { const m = /wfw-held-parts[^>]*>(.*?)<\/details>/.exec(html.replace(/\n/g, ' ')); return m ? m[1] : null; };

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';
let restarts = 0;

/* One shape of hold, end to end: hold it, read the card, restart the station, APPROVE, and say what was delivered or handed on.
   o: { label, rig (makeRig options), reply (every other stage's answer), replies (the reviewer's / entry's), mutate (edit the saved job before the restart),
        next (the agent the approved work is handed to; none = it is delivered to the OUTBOX) } */
async function shape(o) {
  await allocated(async env => {
    const rig = makeRig(o.rig).wire(env.host);
    if (o.reply) rig.reply = o.reply;
    const ran = await rig.run({ replies: o.replies });
    rig.settle(ran.job, ran.line);
    const id = ran.job.id;
    A.ok(ran.line.held && !ran.line.holdFailed && J.get(env.host.jobs(), id).status === 'held', o.label + ': the job is parked as a hold: ' + (ran.line.holdFailed || ''));
    if (o.mutate) { const v = env.raw(env.jobFile); o.mutate(v.jobs.find(j => j.id === id)); env.write(env.jobFile, v); }
    const host2 = env.loadHost(), job = J.get(host2.jobs(), id), c0 = job.continuation;
    const html = cardOf(job), shown = shownOf(html);
    A.ok(shown !== null, o.label + ': the card has a work under review');
    // a restarted station (a new chain and runner over the saved file) carries the decision
    restarts++;
    const rig2 = makeRig(Object.assign({}, o.rig, { idBase: 100000 * restarts, clockBase: 1000 + 1000000 * restarts })).wire(host2);
    if (o.reply) rig2.reply = o.reply;
    const r = rig2.owner(host2).resume(id, { action: 'approve', token: 'tok-1', revision: c0.revision, note: '' });
    A.eq([r.code, r.ok], [202, true], o.label + ': APPROVE is carried on');
    await r.done;
    const end = J.get(host2.jobs(), id);
    A.eq([end.status, end.outcome], ['delivered', 'delivered'], o.label + ': and the job delivered');
    if (o.next) {
      // the handoff prompt names the original request first; what the upstream stage produced is what follows "produced:"
      const prompt = (rig2.seen.filter(s => s.agentId === o.next).pop() || { prompt: '' }).prompt, handed = (/produced:\n([\s\S]*)$/.exec(prompt) || [0, prompt])[1];
      A.ok(shown.length > 0 && handed.includes(shown), o.label + ': the text the card shows (' + JSON.stringify(shown.slice(0, 60)) + ') is what ' + o.next + ' was handed upstream; it was handed ' + JSON.stringify(handed.slice(0, 260)));
      A.ok(!/VERDICT: ?(blocked|revise|approved)/i.test(shown), o.label + ': and no VERDICT line is shown as the work');
    } else {
      A.eq(end.output, shown, o.label + ': the text the card shows is the text APPROVE delivered, byte for byte');
    }
    if (o.after) o.after({ html, shown, c0, job, end, rig2 });
    rig.dispose(); rig2.dispose();
  });
}

(async () => {
  const section = async (label, fn) => { try { await fn(); } catch (e) { A.ok(false, label + ' threw: ' + (e && e.message) + (e && e.stack ? ' @ ' + String(e.stack).split('\n')[1].trim() : '')); } };

  await section('a plain gate to the OUTBOX', () => shape({ label: 'a plain gate to the OUTBOX', rig: {}, replies: [REVISE, BLOCKED],
    after: x => A.eq(x.shown, 'another draft', 'a plain gate: the draft the reviewer was handed is the work (the control — it never differed)') }));

  await section('a plain gate with a stage after it', () => shape({ label: 'a plain gate with a stage after it', rig: { wiring: AFTER }, replies: [REVISE, BLOCKED], next: 'publisher',
    reply: x => x.agentId === 'publisher' ? 'PUBLISHED' : 'another draft' }));

  await section('a gate that loops back into its own dock, a reply with no VERDICT line', () => shape({ label: 'a self-loop gate (no verdict line)', rig: Object.assign({ floor: F1() }, SPLIT),
    replies: ['A: my finished essay about the moon.\n(no verdict line)'], reply: x => x.agentId + ' out', next: 'D',
    after: x => A.eq(x.shown, 'A: my finished essay about the moon.\n(no verdict line)', 'the work is the reviewer\'s own reply, not the request it was handed') }));

  await section('a gate that loops back into its own dock, a blocked verdict', () => shape({ label: 'a self-loop gate (VERDICT: blocked)', rig: Object.assign({ floor: F1() }, SPLIT),
    replies: ['My essay about the moon.\nVERDICT: blocked'], reply: x => x.agentId + ' out', next: 'D',
    after: x => A.eq(x.shown, 'My essay about the moon.', 'the reply without its VERDICT line is the work') }));

  await section('a gate right after a joiner', () => shape({ label: 'a gate after a joiner', rig: Object.assign({ floor: F3() }, { entry: SPLIT.entry, agents: ['A', 'B'] }),
    replies: ['A wrote this paragraph'], reply: x => x.agentId === 'B' ? 'B drafted this paragraph' : x.agentId + ' out',
    after: x => A.ok(/^JOINED OUTPUT/.test(x.shown) && x.shown.includes('A wrote this paragraph') && x.shown.includes('B drafted this paragraph'), 'the work is the merged crate of every branch') }));

  await section('a gate inside a branch with a sibling parked at the join', () => shape({ label: 'a gate in a branch, a sibling parked', rig: Object.assign({ floor: F2() }, SPLIT),
    replies: ['A out'], reply: x => ({ B: 'B draft', D: 'D final' })[x.agentId] || x.agentId + ' out', next: 'D',
    after: x => {
      A.eq(x.shown, 'B draft', 'the work is the branch that stopped');
      const parts = partsOf(x.html);
      A.ok(parts && parts.includes('A out'), 'the card lists the part of the sibling parked at the join, which APPROVE merges in: ' + String(parts).slice(0, 200));
      const prompt = x.rig2.seen.filter(s => s.agentId === 'D').pop().prompt;
      A.ok(prompt.includes('A out') && prompt.includes('B draft'), 'and both parts are what the stage past the join was handed');
    } }));

  await section('an empty draft', () => shape({ label: 'an empty draft', rig: {}, replies: [REVISE, 'Reworked it myself: here is the finished post.\nVERDICT: blocked'],
    mutate: j => { j.continuation.walk.lastHanded = ''; j.continuation.walk.product.draft = ''; },
    after: x => A.eq(x.shown, 'Reworked it myself: here is the finished post.', 'with no draft the reviewer\'s reply (without its VERDICT line) is what goes on, so it is what is shown') }));

  await section('the files the work carries', () => allocated(async env => {
    const rig = makeRig({ files: true }).wire(env.host);
    const ran = await rig.run({ replies: [REVISE, BLOCKED] });
    rig.settle(ran.job, ran.line);
    const job = J.get(env.host.jobs(), ran.job.id), html = cardOf(job);
    const names = job.continuation.files.map(f => f.path.split(/[\\/]/).pop());
    A.ok(names.length >= 1, 'the held work carries files with receipts: ' + names.join(', '));
    A.ok(/wfw-held-files/.test(html) && names.every(n => html.includes(n)), 'the card lists every file the record says the work carries (they go on with it): ' + names.join(', '));
    const none = cardOf(J.get(env.host.jobs(), ran.job.id) && Object.assign({}, job, { continuation: Object.assign({}, job.continuation, { files: [] }) }));
    A.ok(!/wfw-held-files/.test(none), 'control: a job that carries none lists none');
    rig.dispose();
  }));

  A.report('line-hold.approve-shown');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.approve-shown'); });
