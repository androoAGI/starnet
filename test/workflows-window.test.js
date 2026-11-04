/* test/workflows-window.test.js — WORK › WORKFLOWS, its own docked window (frontend/app/windows/workflows.js, 2026-09-30 — Andrew: "the
   easiest conveyor system we can possibly put together. It should be clear as day to the user how to use it").

   Run for real against a REAL station model (worldmodel + the layout engine + the routing compiler), the window's own code in a vm:
     1. a fresh one-agent station: NEW WORKFLOW → pick "Research + write" → that one agent does every step → CREATE lays the line on
        the floor (LineEdit.placeBlueprint), crewed, with each step's instructions and the line's name, READY TO RUN — no Build Mode;
     2. a line is READY only by WorkflowLine.readiness over the compiled plan, with the facts the Workflow panel and the lead's
        station.layout use; an unstaffed step makes it NEEDS SETUP;
     3. SEND IT A JOB posts the line, the job and its name to the job route after the plan gate, folds a clean delivery into the
        OUTBOX, and shows the job's server record; a refusal says why and shows no job;
   and source-locked: the WORK menu opens this window (never Build Mode), the OUTBOX opens a job's record here, the station's glass. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../frontend/app/pipeline.js');
const WL = require('../frontend/app/workflowline.js');
const LE = require('../frontend/app/lineedit.js');
const FM = require('../sidecar/feedbackmemory.js');
const WM = require('../frontend/app/worldmodel.js');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const src = rd('frontend/app/windows/workflows.js');
const tick = () => new Promise(r => setTimeout(r, 15));

(async () => {
  const st = WM.create(WM.starterDoc());
  const registered = {}, opened = [], folded = [], fetches = [], busOn = {};
  let replyFor = () => ({ ok: true, jobs: [] });
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Set, Map, encodeURIComponent,
    U: { bus: { on: (n, fn) => { (busOn[n] = busOn[n] || []).push(fn); } } },
    module: { exports: {} }, window: {}, document: { activeElement: null, querySelector: () => null },
    StationUI: { registerWindow: (k, t, fn, o) => { registered[k] = { t, fn, o }; }, openTerm: k => opened.push(k),
      h: { present: [{ id: 'nova', name: 'NOVA' }], sfx() {}, notify() {}, navigateWork: (from, to) => opened.push(from + '>' + to) } },
    App: { station: () => st },
    Pipeline: P, WorkflowLine: WL, LineEdit: LE, WorldModel: WM,
    Build: { nagWhy: c => 'nag:' + c, lineSchematic: () => null, machineStill: () => '',
      lineWords: () => ({ plain: { research_line: 'Research + write', front_desk: 'One agent', revision_loop: 'Draft + review', build_test: 'Build + test' }, purpose: { research_line: 'one agent digs up sources, the next writes the answer' } }) },
    World: { syncPlan: () => Promise.resolve({ errors: [] }), bayLive: () => null },
    ReturnStore: { foldRow: row => { folded.push(row); return true; }, pendingRows: () => [] },
    fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve(replyFor(url, init)).then(r => ({ status: r.__status || 200, json: () => Promise.resolve(r) })); },
  });
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInContext(src, ctx, { filename: 'workflows.js' });
  const WW = ctx.module.exports, S = WW._state;
  A.ok(registered.workflows && registered.workflows.t === 'WORKFLOWS' && registered.workflows.o.className === 'wfw-win', 'it is a station window: StationUI.registerWindow(\'workflows\', \'WORKFLOWS\', …) — the dock raises it from the bottom like every other');

  /* ---------- 1. a fresh one-agent station: a workflow in three clicks, no Build Mode ---------- */
  A.ok(WW._floor().lines.length === 0, 'a fresh station has no workflows (the window opens on "Make your first workflow")');
  WW._pick('research_line');
  A.ok(S.pick && S.pick.bp === 'research_line' && S.pick.name === 'Research + write', 'picking a starter names it the way the Build Library does');
  A.ok(JSON.stringify(S.pick.agents) === '["nova","nova"]', 'one agent does every step — a one-agent station needs no recruiting');
  A.ok(S.pick.briefs.RESEARCHER.does === WL.defaultBrief('RESEARCHER').does && S.pick.briefs.WRITER.does === WL.defaultBrief('WRITER').does, 'each step comes with its instructions written');
  const propsBefore = st.props().length;
  WW._create();
  const f = WW._floor(), line = f.lines[0];
  A.ok(f.lines.length === 1 && st.props().length > propsBefore, 'CREATE lays the line on the floor');
  A.ok(line.name === 'Research + write' && st.propById(line.intakeId).label === 'Research + write', '…named on its INBOX (one name, the shelf\'s)');
  A.ok(line.steps.map(s => s.role + ':' + s.agentId).join() === 'RESEARCHER:nova,WRITER:nova', '…every step crewed by the one agent');
  A.ok(line.steps[0].brief === WL.defaultBrief('RESEARCHER').does && line.steps[1].brief === WL.defaultBrief('WRITER').does, '…with each step\'s instructions');
  A.ok(line.ready.ready && !line.ready.blocking.length, '…and READY TO RUN: the router can run it now (' + JSON.stringify(line.ready.blocking) + ')');
  A.ok(S.view === 'line' && S.line === line.key && S.pick === null, 'the window opens the new workflow, on its job box');
  A.ok(S.msg && /Research \+ write is on your floor/.test(S.msg.text) && !S.msg.bad, '…saying so in the window (a toast would sit over the SEND key)');

  /* ---------- 2. status is the compiled plan's readiness ---------- */
  st.assignPropAgent(line.steps[1].id, '');
  const unready = WW._floor().lines[0];
  A.ok(!unready.ready.ready && unready.ready.blocking.some(b => /BAY 2 \(WRITER\) needs an agent/.test(b.what)), 'an unstaffed step: NEEDS SETUP, and which step needs whom');
  st.assignPropAgent(line.steps[1].id, 'nova');
  A.ok(WW._floor().lines[0].ready.ready, 'crewed again: READY');

  /* ---------- 3. SEND IT A JOB ---------- */
  const job = { id: 'job-0123456789ab', line: line.key, name: line.name, text: 'three facts about the moon', status: 'delivered', runs: [{ runId: 'r2', agentId: 'nova', dockId: line.steps[1].id, reason: 'done', usd: 0.001 }], output: 'The moon…', usd: 0.002, notes: [], startedAt: 1, endedAt: 2 };
  replyFor = (url, init) => {
    if (/\/api\/routing\/sample$/.test(url)) return { ok: true, jobId: job.id, delivered: { runId: 'r2', reason: 'done', streamId: 'sample-1' }, runs: job.runs, replies: ['The moon…'], totalUsd: 0.002 };
    if (/\/api\/line-jobs\/job-/.test(url)) return { ok: true, job };
    return { ok: true, jobs: [Object.assign({}, job, { steps: 1 })] };
  };
  WW._send(WW._floor().lines[0], 'three facts about the moon', null);
  A.ok(S.out && S.out.text === 'three facts about the moon', 'the job goes out at once (the window shows it riding the line)');
  for (let i = 0; i < 8; i++) await tick();
  const post = fetches.find(x => /\/api\/routing\/sample$/.test(x.url));
  A.ok(post && JSON.parse(post.init.body).line === line.key && JSON.parse(post.init.body).text === 'three facts about the moon' && JSON.parse(post.init.body).name === 'Research + write', 'it posts the line, the job and the line\'s name to the job route');
  A.ok(folded.length === 1 && folded[0].runId === 'r2', 'a clean delivery is folded into the OUTBOX');
  A.ok(S.out === null && S.job && S.job.id === job.id && S.job.status === 'delivered', 'the result shown is the job\'s server record');
  // a refusal: nothing went down the line — the window says why and shows no job
  replyFor = url => /\/api\/routing\/sample$/.test(url) ? { __status: 409, ok: false, error: 'a sample job is already riding the line (started 4s ago) — wait for it to deliver.' } : { ok: true, jobs: [] };
  S.job = null;
  WW._send(WW._floor().lines[0], 'again', null);
  for (let i = 0; i < 8; i++) await tick();
  A.ok(S.out === null && S.job === null && S.msg && S.msg.bad && /already riding the line/.test(S.msg.text), 'a refused job says why, and no result is shown');
  // the plan gate: a floor the station refused is never run
  ctx.World.syncPlan = () => Promise.resolve({ errors: [{ code: 'CYCLE' }] });
  fetches.length = 0;
  WW._send(WW._floor().lines[0], 'gated', null);
  for (let i = 0; i < 8; i++) await tick();
  A.ok(!fetches.some(x => /\/api\/routing\/sample$/.test(x.url)) && S.msg && /nag:CYCLE/.test(S.msg.text), 'a floor with a blocking problem is not sent — the floor\'s own words say why');

  /* ---------- SEND TO (10-11 repair): a job another line HANDED ON is not the Commander's sample ---------- */
  {
    ctx.World.syncPlan = () => Promise.resolve({ errors: [] });
    const handed = { id: 'job-0123456789cd', line: 'p999', name: 'B', text: 'the first job', status: 'running', from: { line: 'p998', jobId: null, name: 'A' }, startedAt: 3, usd: 0, steps: 0 };
    replyFor = url => /\/api\/routing\/sample$/.test(url) ? { ok: true, jobId: job.id, delivered: { runId: 'r2', reason: 'done', streamId: 'sample-1' }, runs: job.runs, replies: ['The moon…'], totalUsd: 0.002 }
      : /\/api\/line-jobs\/job-/.test(url) ? { ok: true, job } : { ok: true, jobs: [handed] };
    S.jobs = [handed]; S.job = null; S.msg = null; fetches.length = 0;
    WW._send(WW._floor().lines[0], 'while B works', null);
    A.ok(S.out && S.out.text === 'while B works', 'a hand-off running on another line never blocks sending a job (it holds no sample lock)');
    for (let i = 0; i < 8; i++) await tick();
    A.ok(fetches.some(x => /\/api\/routing\/sample$/.test(x.url)), '…the job is posted');
    // its delivered result reaches TO REVIEW from THE job the crate names — even when a newer record already sits on that line
    const delivered = { id: 'job-0123456789ef', line: line.key, name: 'B', text: 'the first job', handedIn: 'what A said', status: 'delivered', from: { line: 'p998', jobId: null, name: 'A' },
      runs: [{ runId: 'rh1', agentId: 'nova', reason: 'done', usd: 0.001 }], usd: 0.001, startedAt: 5, endedAt: 9, streamId: 'handoff-1', notes: [], output: 'B did it' };
    const newer = Object.assign({}, delivered, { id: 'job-0123456789aa', status: 'running', runs: [] });
    replyFor = url => url.endsWith('/api/line-jobs/' + delivered.id) ? { ok: true, job: delivered } : /\/api\/line-jobs\//.test(url) ? { ok: true, job: newer } : { ok: true, jobs: [newer] };
    folded.length = 0;
    (busOn['workitem.placed'] || []).forEach(fn => fn({ kind: 'handoff', workitemId: 'w1', lineId: line.key, jobId: delivered.id }));
    (busOn['workitem.delivered'] || []).forEach(fn => fn({ workitemId: 'w1', finalQueueId: 'outbox' }));
    await new Promise(r => setTimeout(r, 750));
    A.ok(folded.length === 1 && folded[0].runId === 'rh1' && folded[0].title === 'the first job', 'a delivered hand-off is folded into TO REVIEW from its own record, titled by the job as it first arrived — ' + JSON.stringify(folded));
    S.jobs = []; S.out = null;
  }

  /* ---------- a REFUSED hand-off says "not sent on" once (wave 2 review, conveyor-backend-09): the card's first line says it was
     not sent on, so the reason follows bare — never "not sent on: automation is stopped (E-STOP) — nothing was sent on" after it ---------- */
  {
    const refused = { id: 'job-0123456789bb', line: line.key, name: 'B', text: 'the first job', status: 'failed', error: 'not sent on: automation is stopped (E-STOP)',
      from: { line: 'p998', jobId: null, name: 'A' }, runs: [], usd: 0, startedAt: 5, endedAt: 5, repeats: 3, notes: [], output: '' };
    const html = WW._resultHTML(line, refused), plain = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
    A.ok(plain.includes('LINE A tried to send its result on to this line — it was not sent on, so nothing ran here.'), 'the card says once that it was not sent on — ' + plain.slice(0, 240));
    A.ok(plain.includes('Automation is stopped (E-STOP). (3 hand-offs from LINE A were refused like this'), '…then the bare reason, and how many were refused like this');
    A.eq((plain.match(/not sent on/gi) || []).length, 1, '"not sent on" appears once on the card, not three times');
    const old = WW._resultHTML(line, Object.assign({}, refused, { error: 'not sent on: automation is stopped (E-STOP) — nothing was sent on', repeats: 1 })).replace(/<[^>]+>/g, ' ');
    A.ok(old.includes('Automation is stopped (E-STOP) — nothing was sent on.') && (old.match(/not sent on/gi) || []).length === 1, 'an older record keeps its own words, without the repeated prefix');
  }

  /* ---------- every reason the card shows opens as a sentence (wave 2 repair): the stored reasons are bare clauses ("the station hit an
     internal fault and stopped this job", "the hand-off could not start (hub down)"); the card opened its paragraph in lowercase under
     ■ STOPPED / ✕ IT DIDN'T RUN. A fault-stopped sample job read "You stopped this job." — a stop the Commander never made. ---------- */
  {
    const plainOf = j => WW._resultHTML(line, j).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
    const base = { id: 'job-0123456789cc', line: line.key, name: 'B', text: 'the first job', runs: [], usd: 0, startedAt: 5, endedAt: 9, notes: [], output: '' };
    const fault = plainOf(Object.assign({}, base, { status: 'stopped', error: 'the station hit an internal fault and stopped this job', from: { line: 'p998', jobId: null, name: 'A' } }));
    A.ok(fault.includes('The station hit an internal fault and stopped this job. What already ran is counted.'), 'a fault-stopped hand-off opens with a capital — ' + fault.slice(0, 260));
    const sampleFault = plainOf(Object.assign({}, base, { status: 'stopped', error: 'the station hit an internal fault and stopped this job' }));
    A.ok(sampleFault.includes('The station hit an internal fault and stopped this job. What already ran is counted.') && !/You stopped this job/.test(sampleFault), 'a fault-stopped job of the line\'s own never says "You stopped this job" — ' + sampleFault.slice(0, 260));
    const mine = plainOf(Object.assign({}, base, { status: 'stopped', error: 'you stopped this job' }));
    A.ok(mine.includes('You stopped this job. What already ran is counted.'), 'the Commander\'s own stop keeps its words');
    const bare = plainOf(Object.assign({}, base, { status: 'stopped' }));
    A.ok(bare.includes('You stopped this job. What already ran is counted.'), 'an older stopped record with no reason reads as before');
    const threw = plainOf(Object.assign({}, base, { status: 'failed', error: 'the hand-off could not start (hub down)', from: { line: 'p998', jobId: null, name: 'A' } }));
    A.ok(threw.includes('The hand-off could not start (hub down).'), 'a dispatch failure opens with a capital and ends as a sentence — ' + threw.slice(0, 260));
    const none = plainOf(Object.assign({}, base, { status: 'failed', error: '' }));
    A.ok(none.includes('Nothing ran.'), 'no reason still reads "Nothing ran."');
  }

  /* ---------- NEEDS CHANGES → USE THIS / PUT IT BACK: each field's note keeps its OWN before and after ---------- */
  {
    const step = WW._floor().lines[0].steps[1], dockId = step.id, wasDoes = st.propById(dockId).brief || '', wasHands = st.propById(dockId).hands || '';
    const noteBodies = () => fetches.filter(x => /\/note$/.test(x.url)).map(x => JSON.parse(x.init.body));
    replyFor = () => ({ ok: true, job });
    S.job = job;
    // a fix that changes only the hand-off
    S.fix = { jobId: job.id, open: true, state: 'done', fixes: [{ dockId, hands: 'Pass only the final draft.', why: 'shorter hand-off', was: wasDoes, wasHands }] };
    fetches.length = 0; WW._useFix(job, 0, false); WW._useFix(job, 0, true);
    for (let i = 0; i < 4; i++) await tick();
    const hb = noteBodies();
    A.ok(hb.length === 2 && hb.every(n => n.field === 'hands'), 'a hand-off fix and its put-back are both noted on the hand-off: ' + JSON.stringify(hb.map(n => n.field)));
    A.ok(hb[1] && hb[1].kind === 'putback' && hb[1].text === wasHands && hb[1].was === 'Pass only the final draft.', 'putting a hand-off back records the OLD HAND-OFF, never the old instructions: ' + JSON.stringify(hb[1]));
    A.ok((st.propById(dockId).hands || '') === wasHands, 'and the hand-off is back as it was');
    // a fix that changes both: one note per field
    S.fix = { jobId: job.id, open: true, state: 'done', fixes: [{ dockId, does: 'Two facts, one line each.', hands: 'Pass the facts only.', why: 'tighter', was: wasDoes, wasHands }] };
    fetches.length = 0; WW._useFix(job, 0, false);
    for (let i = 0; i < 4; i++) await tick();
    const both = noteBodies();
    A.ok(both.length === 2 && both.some(n => n.field === 'does' && n.text === 'Two facts, one line each.' && n.was === wasDoes) && both.some(n => n.field === 'hands' && n.text === 'Pass the facts only.' && n.was === wasHands), 'a fix that changes both is noted for both: ' + JSON.stringify(both.map(n => [n.field, n.text])));
    WW._useFix(job, 0, true); S.fix = null; S.job = null;
    // a style kept in the Workflow panel (★ KEEP AS THE EXAMPLE notes no job): STYLE KEPT · PUT IT BACK takes the example out
    const plain = st.propById(dockId).brief || '';
    st.setPropBrief(dockId, WW._exampleBrief(plain, job.output));
    const noNotes = Object.assign({}, job, { notes: [] });
    A.ok(WW._styleKept(noNotes), 'fixture: the window reads the panel-kept example as STYLE KEPT');
    WW._putStyleBack(noNotes);
    A.ok((st.propById(dockId).brief || '') === plain && !WW._styleKept(noNotes), 'PUT IT BACK takes the panel-kept example out (it silently did nothing): ' + JSON.stringify((st.propById(dockId).brief || '').slice(-80)));
    for (let i = 0; i < 4; i++) await tick();
    // DESIGN ANCHOR (2026-10-11): KEEP THIS STYLE also makes the approval the Commander's station-wide taste (the sidecar reads the
    // delivered run's real files / palette / fonts / image args), and PUT IT BACK takes that back too
    const keepPosts = () => fetches.filter(x => /\/api\/taste\/keep-style$/.test(x.url)).map(x => JSON.parse(x.init.body));
    fetches.length = 0;
    WW._keepStyle(job);
    for (let i = 0; i < 4; i++) await tick();
    A.ok(WW._styleKept(job), 'fixture: the style is kept on the step');
    A.eq(keepPosts(), [{ runId: 'r2' }], 'KEEP THIS STYLE posts the DELIVERED run (runs[0]) to the station taste');
    WW._putStyleBack(job);
    for (let i = 0; i < 4; i++) await tick();
    A.eq(keepPosts(), [{ runId: 'r2' }, { runId: 'r2', undo: true }], 'PUT IT BACK takes the station-wide approval back too');
    A.ok((st.propById(dockId).brief || '') === plain, 'and the step is as it was');
  }

  /* ---------- slow style reference capture: PUT IT BACK must win after KEEP THIS STYLE ---------- */
  {
    let memory = [], release, writes = [];
    const delayed = new Promise(resolve => { release = resolve; });
    replyFor = async (url, init) => {
      if (!/\/api\/taste\/keep-style$/.test(url)) return { ok: true };
      const b = JSON.parse(init.body);
      if (!b.undo) await delayed; // the real keep route awaits captureTasteRef before entering notebookStore.update
      const r = b.undo ? FM.unkeep(memory, b.runId) : FM.apply(memory, { runId: b.runId, kept: true, verdict: 'great', directive: 'design the landing page' }, { now: 1 });
      if (r) memory = r.list;
      writes.push(b.undo ? 'undo' : 'keep');
      return { ok: true, feedbackMemory: b.undo ? undefined : { stored: true } };
    };
    const posts = () => fetches.filter(x => /\/api\/taste\/keep-style$/.test(x.url)).map(x => JSON.parse(x.init.body));
    fetches.length = 0;
    WW._keepStyle(job); WW._putStyleBack(job);
    await tick();
    A.ok(!WW._styleKept(job), 'PUT IT BACK restores the step immediately while reference capture is pending');
    A.eq(posts(), [{ runId: 'r2' }], 'the withdrawal waits for the pending keep instead of overtaking it');
    // A separate run is independent, and a view change cannot cancel this run's pending undo.
    S.job = null; S.view = 'list';
    const other = Object.assign({}, job, { runs: [{ runId: 'other-run', dockId: job.runs[0].dockId }] });
    WW._putStyleBack(other); await tick();
    A.ok(posts().some(p => p.runId === 'other-run' && p.undo), 'a pending write on one run never blocks another run');
    release(); for (let i = 0; i < 4; i++) await tick();
    A.eq(writes.filter((_, i) => i > 0), ['keep', 'undo'], 'the same run commits keep before undo even after changing views');
    A.ok(!memory.some(r => r.sourceRunId === 'r2' && r.feedbackKept), 'the crew no longer remembers a style the Commander put back');

    // KEEP / PUT BACK / KEEP while the first capture is pending: the LAST click wins, not merely the first pair.
    memory = []; writes = []; fetches.length = 0;
    let finishFirst; const first = new Promise(resolve => { finishFirst = resolve; }); let seen = 0;
    replyFor = async (url, init) => {
      if (!/\/api\/taste\/keep-style$/.test(url)) return { ok: true };
      const b = JSON.parse(init.body); if (++seen === 1) await first;
      const r = b.undo ? FM.unkeep(memory, b.runId) : FM.apply(memory, { runId: b.runId, kept: true, verdict: 'great', directive: 'design the landing page' }, { now: 1 });
      if (r) memory = r.list; writes.push(b.undo ? 'undo' : 'keep');
      return { ok: true };
    };
    WW._keepStyle(job); WW._putStyleBack(job); WW._keepStyle(job); await tick();
    A.eq(posts(), [{ runId: 'r2' }], 'rapid keep/undo/keep sends only the first request while it is unsettled');
    finishFirst(); for (let i = 0; i < 4; i++) await tick();
    A.eq(writes, ['keep', 'undo', 'keep'], 'all repeated style changes commit in user order');
    A.ok(WW._styleKept(job) && memory.some(r => r.sourceRunId === 'r2' && r.feedbackKept), 'the last KEEP THIS STYLE agrees on the step and in crew memory');

    // A failed keep does not poison the queue: undo is still necessary when the response was lost after persistence.
    fetches.length = 0; let n = 0;
    replyFor = (url) => /\/api\/taste\/keep-style$/.test(url) && ++n === 1 ? Promise.reject(new Error('response lost')) : { ok: true };
    WW._keepStyle(job); WW._putStyleBack(job); for (let i = 0; i < 4; i++) await tick();
    A.eq(posts(), [{ runId: 'r2' }, { runId: 'r2', undo: true }], 'a failed keep response still lets the requested withdrawal reach the station');
    replyFor = () => ({ ok: true });
  }

  /* ---------- source locks ---------- */
  const html = rd('frontend/index.html'), app = rd('frontend/app/app.js'), build = rd('frontend/app/build.js'), outbox = rd('frontend/app/windows/outbox.js');
  const css = rd('frontend/css/workflows-window.css'), glass = rd('frontend/app/glass-demo.js'), sc = rd('frontend/app/stationcommands.js');
  A.ok(/<button class="bb" id="bb-automate" data-family="automate"/.test(html) && /\{ id: 'workflows', k: 'workflows', label: 'WORKFLOWS'/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8')) && !/bbWorkflows\.onclick/.test(app), 'WORK › AUTOMATE › WORKFLOWS opens this window through the dock (never Build Mode)');
  A.ok(html.indexOf('app/windows/workflows.js') > html.indexOf('app/stationui.js') && /css\/workflows-window\.css/.test(html), 'it loads after the window manager, with its stylesheet');
  A.ok(/function editLine\(propId\) \{[\s\S]{0,400}openFlowCard\(propId\)/.test(build) && /lineWords: \(\) => \(\{ plain: LINE_PLAIN, purpose: LINE_PURPOSE \}\)/.test(build), 'EDIT WORKFLOW opens the full editor on this line; the window speaks the shelf\'s own words');
  A.ok(/class="consent-btn ob-wf" hidden>OPEN IN WORKFLOWS<\/button>/.test(outbox) && /WorkflowsWindow\.openJob\(resolvedJob\.id, 'deliverables'\)/.test(outbox), 'DELIVERABLES › TO REVIEW opens the exact durable job proved beside its provenance');
  A.ok(/const work = w\.classList\.contains\('wfw-win'\);/.test(glass) && /work \? available \* \.8/.test(glass), 'it opens tall enough for the job and its result');
  // the window's status reads the panel's facts — the ones station.layout gives the lead (stationcommands.js describeLayout)
  A.ok(/hasCompute = \(aid, pid\) => [^\n]*bayObjects\(aid, pid\)[^\n]*'computer'/.test(src) && /toolsAt = \(aid, pid\) => [^\n]*bayObjects\(aid, pid\)/.test(sc) && /hasCompute = \(aid, pid\) => !!aid && toolsAt\(aid, pid\)\.indexOf\('computer'\) >= 0/.test(sc),
    'the window and station.layout read compute the same way: PER BAY (bayObjects(agent, bay) has a computer)');
  for (const fact of [/errors: plan\.errors \|\| \[\]/, /isCrew/, /briefOf/]) A.ok(fact.test(src) && fact.test(sc), 'the window and station.layout read the same readiness fact: ' + fact);
  A.ok(/labelOf = code => \(B\(\) && B\(\)\.nagWhy\) \? B\(\)\.nagWhy\(code\) : code/.test(src), '…and the floor\'s own nag copy');
  // KEEP THIS STYLE writes the panel's own example block, so the panel and the window both see it
  const panel = rd('frontend/app/workflowpanel.js');
  A.ok(WW.EX_HEAD === (panel.match(/const EX_HEAD = '([^']+)';/) || [])[1], 'KEEP THIS STYLE uses the Workflow panel\'s exact example block');
  // station UI laws: hover tips are the station tooltip (data-tip), keys are the current glass, no native popups
  A.ok(!/\stitle="/.test(src) && !/window\.(alert|confirm|prompt)\(/.test(src) && !/<select/.test(src) && !/key-input/.test(src), 'no OS tooltip, no native dialog, no native select, no old CRT field');
  A.ok(/\.term\.wfw-win \.bb \{[\s\S]{0,400}min-height: 36px;[\s\S]{0,200}border-radius: 8px;/.test(css) && /--refit-glass: linear-gradient\(125deg/.test(css), 'its keys are the Build Library / Workflow panel glass key (36px, 8px), on the panel\'s own glass tokens');
  A.ok(/\.term\.wfw-win \.bb:hover::before, \.term\.wfw-win \.bb:hover::after \{ content: none; \}/.test(css), 'never the old pip-boy [ ] hover brackets');

  /* ---------- M28 (2026-10-12): a hand-off end is named the way the floor names its line ---------- */
  {
    // job records carry from/sentTo as { line, jobId, name } (handoff-runner) — an UNNAMED sending line has name '', never a lineId
    const placed = LE.placeBlueprint(st, 'research_line', { x: 6, y: 12 });
    A.ok(placed.ok, 'fixture: an unnamed second line');
    const iid = placed.ids.find(id => st.propById(id).t === 'intake');
    const key = (P.lineComponents(st.projectGeometry()).find(c => c.intakes.includes(iid)) || {}).key, letter = st.lineLetter(iid);
    A.ok(key && /^[A-Z]+$/.test(letter) && !st.propById(iid).label, 'fixture: the line has no name, only its letter');
    A.eq(WW._lineWord({ line: key, jobId: 'j1', name: '' }), 'LINE ' + letter, 'an unnamed sending line reads LINE ' + letter + ', as its floor plate does — never "another line"');
    // ONE line-naming rule (conveyor-final merge, decision a — the floor lane's): a line still on the floor is named by the floor's
    // CURRENT name (worldmodel lineName); the name a job recorded is used only once that line is gone from the floor
    A.eq(WW._lineWord({ line: key, jobId: 'j1', name: 'Research' }), 'LINE ' + letter, 'a line still on the floor reads its CURRENT floor name (LINE ' + letter + '), never the stale name the job recorded');
    A.eq(WW._lineWord({ line: 'p-gone', jobId: 'j1', name: 'Research' }), 'LINE RESEARCH', 'a line no longer on the floor reads the name its job recorded');
    A.eq(WW._lineWord({ line: 'p-gone', jobId: 'j1', name: '' }), 'another line', 'a line no longer on the floor, with no recorded name, is "another line"');
    A.ok(st.setPropLabel(iid, 'Digest').ok === true, 'fixture: the line is renamed on the floor');
    A.eq(WW._lineWord({ line: key, jobId: 'j1', name: 'Research' }), 'LINE DIGEST', 'a renamed line reads its new floor name, never the name the job recorded');
  }

  /* ---------- org P15 (2026-10-14): the line page says how it starts, and opens the one place starts are made ---------- */
  {
    const l0 = WW._floor().lines.find(x => x.key === line.key);
    const entry = WL.entryDocksOf(l0.flow)[0];
    A.ok(!!entry, 'fixture: the line has an entry step');
    A.eq(WW._startsText(l0), null, 'no start facts read yet: nothing claimed (the line says checking…)');
    const job = { id: 'r1', name: 'Morning', agentId: 'nova', dockId: entry, runsLine: true, scheduleDisplay: 'every 6h', enabled: true };
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: false, jobs: [] }, lt: { triggers: [] }, chans: {} });
    A.eq(WW._startsText(l0), 'by hand only', 'nothing automatic: by hand only');
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: false, jobs: [job] }, chans: {},
      lt: { triggers: [{ id: 't1', lineId: l0.key, kind: 'folder', enabled: true, blockedBy: null, config: { path: 'C:/in' } }] } });
    A.eq(WW._startsText(l0), 'by hand · every 6h · when a file lands in C:/in', 'a schedule and a folder trigger, composed by WorkflowLine.lineStarts');
    ctx.World.startFacts = () => ({ cron: { enabled: false, halted: false, jobs: [job] }, lt: { triggers: [] }, chans: {} });
    A.eq(WW._startsText(l0), 'by hand · every 6h (scheduling is off)', 'a schedule saved while scheduling is off is said as off, never as a start');
    // an E-STOP is named as the E-STOP, never as the scheduling switch
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: true, jobs: [job] }, lt: { triggers: [] }, chans: {} });
    A.eq(WW._startsText(l0), 'by hand · every 6h (stopped by E-STOP)', 'a schedule the E-STOP holds says stopped by E-STOP');
    // a fact whose endpoint never answered is unknown: never 'by hand only'
    ctx.World.startFacts = () => ({ cron: null, lt: { triggers: [] }, chans: {} });
    A.eq(WW._startsText(l0), 'by hand · schedules could not be read', 'unread schedules are said unread, never as by hand only');
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: false, jobs: [job] }, lt: null, chans: null });
    A.eq(WW._startsText(l0), 'by hand · every 6h · channels and folder/webhook triggers could not be read', 'a known start still shows beside the facts that were not read');
    /* (org wire AUTO-P15-1) a start the server HOLDS is a start, held, with the server's reason — never 'by hand only' beside the panel's
       paused trigger; and another line's SEND TO into this one is a start (the panel's ✓ FED, BUILD's FED BY) */
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: true, jobs: [] }, chans: {},
      lt: { triggers: [{ id: 't2', lineId: l0.key, kind: 'folder', enabled: true, blockedBy: 'automation is stopped (E-STOP) — resume it and this trigger fires again', config: { path: 'C:/in' } }] } });
    A.eq(WW._startsText(l0), 'by hand · when a file lands in C:/in (waiting: automation is stopped (E-STOP) — resume it and this trigger fires again)', 'a folder trigger the E-STOP holds is said as held, with the server\'s reason');
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: false, jobs: [] }, lt: { triggers: [] },
      chans: { telegram: { configured: true, connected: false, agentId: st.propById(entry).agentId, agentName: 'Nova' } } });
    const chanSaid = WW._startsText(l0);
    A.ok(/^by hand · when a Telegram message arrives \(not connected\)$/.test(chanSaid), 'a channel that answers as the first step but is not connected is a held start: ' + chanSaid);
    const digestOut = st.props().find(p => p.t === 'outbox' && P.lineComponents(st.projectGeometry()).some(c => c.intakes.includes(iidOf('Digest')) && (c.outboxes || []).includes(p.id)));
    function iidOf(label) { const p = st.props().find(x => x.t === 'intake' && x.label === label); return p && p.id; }
    A.ok(!!digestOut && st.setSendTo(digestOut.id, l0.intakeId).ok === true, 'fixture: LINE DIGEST sends its finished work to this line');
    ctx.World.startFacts = () => ({ cron: { enabled: true, halted: false, jobs: [] }, lt: { triggers: [] }, chans: {} });
    const fedL = WW._floor().lines.find(x => x.key === line.key);
    A.eq(WW._startsText(fedL), 'by hand · when LINE DIGEST sends its finished work', 'a line fed by another line\'s SEND TO says so, never by hand only');
    A.ok(st.setSendTo(digestOut.id, null).ok === true, 'fixture: the SEND TO is taken back');
    A.eq(WW._startsText(WW._floor().lines.find(x => x.key === line.key)), 'by hand only', '…and without it the line is by hand only again');
    // (org wire AUTO-P15-2) a feed poll that came back with NOTHING answered never leaves STARTS on 'checking…' forever
    ctx.World.startFacts = () => null;
    const polledWas = S.startsPolled;
    S.startsPolled = false;
    A.eq(WW._startsText(l0), null, 'before any read has finished: checking…');
    S.startsPolled = true;
    A.eq(WW._startsText(l0), 'by hand · schedules, channels and folder/webhook triggers could not be read', 'a read that came back empty says what could not be read');
    S.startsPolled = polledWas;
    // org P16's RUN BY reads the same entry the INBOX form's schedule fires at
    const sl = WW.startLines().find(x => x.key === l0.key);
    A.ok(sl && sl.dockId === entry && sl.agentId === 'nova', 'startLines: the line\'s first routed step and its agent (SCHEDULES › RUN BY)');
    // the page: STARTS sits between Send it a job and Last jobs; its key opens EDIT WORKFLOW at 'Or start it automatically'
    A.ok(/\+ '<\/section>' \+ startsHTML\(l\) \+ '<section class="wfw-sec"><h3>Last jobs<\/h3>'/.test(src), 'STARTS: sits between the job box and LAST JOBS');
    A.ok(/data-act="automatic" data-tip="[^"]+">⊕ MAKE IT AUTOMATIC<\/button>/.test(src) && /data-act="automatic" data-tip="[^"]+">⊕ CHANGE STARTS<\/button>/.test(src)
      && /const started = !!t && t\.split\(' · '\)\.slice\(1\)\.some\(p => !\/could not be read\$\/\.test\(p\)\);/.test(src) && /B\(\)\.editLine\(l\.intakeId\)\)\) return;\s*\n\s*if \(typeof WorkflowPanel !== 'undefined' && WorkflowPanel\.revealStarts\)/.test(src), '⊕ MAKE IT AUTOMATIC opens the editor on the INBOX and reveals its starts');
    const panelSrc = rd('frontend/app/workflowpanel.js');
    A.ok(/<section class="wf-sec" id="wf-starts"><h3>Or start it automatically<\/h3>/.test(panelSrc) && /selectFromFloor, revealStarts, showTest,/.test(panelSrc), 'the panel names that section and exports revealStarts');
    // (live walk 10-14) the section lands BELOW the pinned line map (sticky at top:0), never under it
    const WP = require('../frontend/app/workflowpanel.js');
    A.eq(WP._startsScrollBy(400, 68, 183, 1), 400 - 68 - 183 - 8, 'a pinned map: the section heading lands just below the map\'s bottom edge');
    A.eq(WP._startsScrollBy(400, 68, 0, 1), 332, 'no pinned map (a stacked diagram or a short panel): the section lands at the scroll\'s top');
    A.eq(WP._startsScrollBy(468, 68, 183, 1.15), (468 - 68 - 183 - 8) / 1.15, 'visual px are divided by uiZoom exactly once');
    A.ok(/const pinned = !!\(map && typeof getComputedStyle === 'function' && getComputedStyle\(map\)\.position === 'sticky'\);/.test(panelSrc)
      && /sc\.scrollTop \+= startsScrollBy\(sec\.getBoundingClientRect\(\)\.top, sc\.getBoundingClientRect\(\)\.top, pinned \? map\.getBoundingClientRect\(\)\.height : 0, z\);/.test(panelSrc),
      'scrollToStarts subtracts the map\'s height only while the map is actually sticky');
    A.ok(A.fnBody(src, 'function jobRows(l)').includes('No recorded jobs on this line yet.'), 'empty LAST JOBS names the absence of recorded jobs without excluding automatic entries');
    // Automatic entries use the shared durable job book and belong in LAST JOBS too.
    const trSrc = rd('sidecar/routing/trigger-runner.js');
    A.ok(/lineRunner\.open\(\{ line: t\.lineId, entry: 'trigger'/.test(trSrc) && /lineRunner\.settle\(job,/.test(trSrc), 'folder and webhook triggers open and settle the shared line job');
  }

  /* ---------- org P14 (2026-10-14; final round): a delivered job waiting for its rating is rated right here, and the view a floor OUTBOX
     click opens never links on to DELIVERABLES (Andrew 10-03: "the outbox … should never link back to deliverables") ---------- */
  {
    const dj = { id: 'job-0123456789dd', line: line.key, name: line.name, text: 'three facts about the moon', status: 'delivered', runs: [{ runId: 'rp14', agentId: 'nova', reason: 'done', usd: 0.001 }], output: 'The moon…', usd: 0.001, notes: [], startedAt: 1, endedAt: 2 };
    const was = ctx.ReturnStore.pendingRows;
    ctx.ReturnStore.pendingRows = () => [{ runId: 'rp14', agentId: 'nova', title: 'three facts about the moon' }];
    const waiting = WW._resultHTML(line, dj), plain = waiting.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    A.ok(!/data-act="toreview"/.test(waiting) && !/DELIVERABLES/.test(plain) && !/in the OUTBOX/.test(plain), 'a job still in TO REVIEW carries no door on to DELIVERABLES (the OUTBOX\'s own page) and never says "in the OUTBOX": ' + plain.slice(0, 160));
    A.ok(/<div class="wfw-rate" data-rate-for="rp14"><\/div>/.test(waiting), '…and carries the rate host TO REVIEW mounts (Chat.awayRate) for its run');
    ctx.ReturnStore.pendingRows = () => [];
    const rated = WW._resultHTML(line, dj);
    A.ok(!/TO REVIEW/.test(rated) && !/wfw-rate/.test(rated), 'a job already rated (no pending row) says nothing about TO REVIEW and offers no rating');
    ctx.ReturnStore.pendingRows = was;
    A.ok(/Chat\.awayRate\(host, rw, clear\)/.test(src) && /ReturnStore\.resolve\(rw\.runId, 'workflows'\)/.test(src), 'rating here resolves the same crate TO REVIEW holds (the windows/outbox.js path), naming itself so ReturnStore repaints TO REVIEW');
    A.ok(/\brefresh\b/.test(src.slice(src.lastIndexOf('return {'))) && /const refresh = runIds => \{\s*if \(!alive\(\)\) return;/.test(src), 'WORKFLOWS exports refresh (ReturnStore\'s nudge when its run is rated in TO REVIEW or COMMS), a no-op while closed (returnstore-rate-sync runs it: only the shown run\'s rating repaints)');
    A.ok(!/toreview/.test(src) && !/waiting in DELIVERABLES/.test(src), 'no TO REVIEW door and no handler for one anywhere in WORKFLOWS');
    A.ok(src.includes('The result comes back here, lands in this line’s OUTBOX and is also filed in DELIVERABLES.'), 'the send helper says the result lands in this line\'s OUTBOX and is also filed in DELIVERABLES (one wording with the panel, g7 D7)');
  }

  /* ---------- org P17 (2026-10-14): WORKFLOWS and the Workflow panel use ONE word set for the same line ---------- */
  {
    const panelSrc = rd('frontend/app/workflowpanel.js'), buildSrc = rd('frontend/app/build.js');
    A.ok(src.includes('<span class="wfw-st ok">✓ DELIVERED</span>') && src.includes('<b class="ok">✓ DELIVERED</b>') && !src.includes('✓ DONE'), 'a finished job reads ✓ DELIVERED in LAST JOBS and on its result (the panel\'s ✓ DONE is its close key)');
    A.ok(src.includes('>▶ SEND A JOB</button>') && panelSrc.includes("'▶ SEND A JOB')") && panelSrc.includes('id="wf-sendnow" hidden>▶ SEND A JOB</button>'), '▶ SEND A JOB in both editors');
    A.ok(panelSrc.includes(": '▶ SEND A REAL JOB') + '</button>'") && panelSrc.includes("['real', 'SEND A REAL JOB',") && panelSrc.includes('real agents, real cost, and the result lands') && !/costs a run'/.test(panelSrc + buildSrc), 'TEST\'s key reads ▶ SEND A REAL JOB like the FINISH and COMMS cards; its cost is the help sentence above it (org D4 polish)');
    A.ok(src.includes('>↻ SEND IT AGAIN</button>') && panelSrc.includes('id="wf-nr-again">↻ SEND IT AGAIN</button>') && !/RUN THE SAME JOB AGAIN</.test(src + panelSrc), '↻ SEND IT AGAIN after a fix, in both');
    A.ok(panelSrc.includes('<span>✎ NEEDS CHANGES</span>') && panelSrc.includes("'SUGGEST CHANGES'") && panelSrc.includes('★ KEEP THIS STYLE</button>'), 'the panel says ✎ NEEDS CHANGES · SUGGEST CHANGES · ★ KEEP THIS STYLE, as WORKFLOWS does');
    A.ok(src.includes("'\">GIVE ' + esc(String(a.name || a.id).toUpperCase()) + ' EVERY STEP</button>'") && buildSrc.includes("'>GIVE '+esc(String(agentLabelFor(firstAid)).toUpperCase())+' EVERY STEP</button>'") && !src.includes('DOES EVERY STEP') && !buildSrc.includes('DOES EVERY STEP') && src.includes(' A DESK</button>') && buildSrc.includes(">⊕ GIVE '+esc(") && panelSrc.includes('id="wf-pc">⊕ GIVE \' + esc(') && src.includes('">⊕ GIVE \' + esc(NAME('), 'GIVE <NAME> EVERY STEP (an action, never a status beside a picker that names someone else) and GIVE <NAME> A DESK in WORKFLOWS, BUILD and the panel');
    A.ok(buildSrc.includes("▸ FINISH ${lname ? esc(lname.toUpperCase()) : 'SETUP'}") && !buildSrc.includes("'FINISH THE LINE'"), 'the FINISH card reads FINISH <LINE NAME>, or FINISH SETUP unnamed (org D4/D5: never FINISH SETUP · NAME, which wrapped)');
    A.ok(!/Choose a workflow/.test(rd('frontend/app/windows/loops.js')) && /Choose a kind of loop/.test(rd('frontend/app/windows/loops.js')), 'GOAL LOOPS asks for a kind of loop, never "a workflow"');
  }

  /* ---------- org P18 (2026-10-14): NEW WORKFLOW leads with the Commander's FOR YOUR GOAL line when it is not one of the four ---------- */
  {
    const S0 = { pick: S.pick, drafting: S.drafting };
    S.pick = null; S.drafting = null;
    const tilesOf = html => (html.match(/data-starter="([a-z_]+)"/g) || []).map(m => m.slice(14, -1));
    ctx.Build.goalLine = () => null;
    A.eq(tilesOf(WW._newHTML(WW._floor())).join(), 'research_line,revision_loop,front_desk,build_test', 'no goal read: the four starters');
    ctx.Build.goalLine = () => ({ id: 'mission_control', why: 'a crew plans it and checks it', quote: 'ship my app every week' });
    const led = WW._newHTML(WW._floor());
    A.eq(tilesOf(led).join(), 'mission_control,research_line,revision_loop,front_desk,build_test', 'a goal line off the four leads them');
    const goalTile = (/<button type="button" class="wfw-tile wfw-goal"[^>]*>[\s\S]*?<\/button>/.exec(led) || [''])[0];
    A.ok(/data-tip="“ship my app every week” — a crew plans it and checks it/.test(goalTile) && /<span class="wfw-tstat">\d+ steps?( · reviewed| · side by side)?<\/span>/.test(goalTile), '…its tip quotes their words, its one small line is the step count like every tile and CONVEYORS › LINES (no sentence under the tile): ' + goalTile.slice(0, 200));
    A.ok(!/<span class="wfw-tstat">[^<]{40,}/.test(led), 'every tile keeps one short stat line');
    A.ok(/<div class="wfw-tgroup wfw-goalhd"[^>]*>FOR YOUR GOAL <span class="wfw-goalq">“ship my app every week”<\/span><\/div><button type="button" class="wfw-tile wfw-goal"/.test(led) && /wfw-goal"[\s\S]*?<\/button><div class="wfw-tgroup">COMMON WORKFLOWS<\/div>/.test(led), 'the goal tile sits under the shelf\'s gold FOR YOUR GOAL heading, the four under COMMON WORKFLOWS (org D2 polish)');
    // (org g7 D2, final round) the shelf claims a goal only by NAMING it — never a match for the empty 'What should it make?' box
    A.ok(/FOR YOUR GOAL <span class="wfw-goalq">“ship my app every week”<\/span>/.test(led) && /<textarea id="wfw-describe"[^>]*><\/textarea>/.test(led), 'with the box still empty, the heading names the goal it matched: the Commander\'s own words');
    ctx.Build.goalLine = () => ({ id: 'mission_control', why: 'w', quote: '  ' });
    A.ok(!/FOR YOUR GOAL/.test(WW._newHTML(WW._floor())) && tilesOf(WW._newHTML(WW._floor())).length === 4, 'a goal with no words to name shows no goal shelf at all');
    A.ok(/' · side by side'/.test(src), 'a SPLITTER line says its steps work side by side');
    A.ok(/\.wfw-tile\.wfw-goal \{ grid-column: 1 \/ -1; \}/.test(rd('frontend/css/workflows-window.css')), 'the goal tile takes a row of its own, so the four starters under it stay a whole grid');
    ctx.Build.goalLine = () => ({ id: 'research_line', why: 'w', quote: 'q' });
    A.eq(tilesOf(WW._newHTML(WW._floor())).join(), 'research_line,revision_loop,front_desk,build_test', 'a goal line that IS one of the four is not shown twice');
    ctx.Build.goalLine = () => ({ id: 'no_such_line', why: 'w', quote: 'q' });
    A.eq(tilesOf(WW._newHTML(WW._floor())).length, 4, 'an unknown goal id adds nothing');
    A.ok(/More ready-made workflows are in the Build Library ›/.test(WW._newHTML(WW._floor())), 'the More ready-made workflows link stays, in the SET IT UP note\'s word (org D5 polish)');
    A.ok(/picks one of 20 ready-made workflows/.test(WW._newHTML(WW._floor())), 'SET IT UP FOR ME says it chooses from the whole shelf, in this page\'s word (workflows, org D11)');
    delete ctx.Build.goalLine;
    S.pick = S0.pick; S.drafting = S0.drafting;
    const buildSrc = rd('frontend/app/build.js');
    A.ok(/goalLine: \(\) => \{ const g = goalLine\(\); return g \? \{ id: g\.bp\.id, why: g\.why, quote: g\.quote \} : null; \},/.test(buildSrc), 'Build exposes the shelf\'s own FOR YOUR GOAL pick');
  }

  /* ---------- night-leak 10-15: a closed window lets go of its body (module state held the last closed WORKFLOWS window) ---------- */
  {
    const o = registered.workflows.o;
    A.ok(typeof o.onClose === 'function', 'the window registers a close teardown');
    const el = { isConnected: true, innerHTML: '', querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
    registered.workflows.fn(el);
    A.ok(WW._body() === el, 'an open window is the module body');
    o.onClose(el);
    A.ok(WW._body() === null, 'closing it drops the body: nothing in the module reaches the closed window');
    WW.refresh(); WW.refresh(['x']);
    A.ok(WW._body() === null, 'a refresh after close repaints nothing');
  }

  A.report('workflows-window.test');
})().catch(e => { console.error(e); process.exit(1); });
