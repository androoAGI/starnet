/* node test/line-hold.ui.test.js — THE WORKFLOWS WINDOW LETS A PERSON DECIDE (line-hold lane, S4).

   A job held at a reviewer's gate is no problem and no delivery: WORKFLOWS says it is waiting for you, shows why, the work that was
   under review and what the reviewer said, and offers APPROVE / SEND BACK (with a note) / STOP inside the job box that was already
   there (no new window, tab or panel). The window's own code runs in a vm over a real station model, the way workflows-window.test.js
   does it; only fetch is faked.

     1. what a held job shows: the why, the draft, the reviewer's words, the three keys and the note box — and no SEND IT AGAIN;
        SEND BACK is not offered by a gate with no pass left; a job that is not held shows none of it;
     2. a press posts ONE decision to POST /api/line-jobs/<id>/decision with the checkpoint revision from the job read and a client
        token of its own: pressing again at the same revision is the SAME token (the station answers the saved receipt); another action,
        or another revision, is a new one; SEND BACK carries the note; a press while one is out posts nothing;
     3. the station's answer: 202 follows the job on; a refusal (409) shows its reason and the re-read job (new revision, the refusal on
        its record), the keys come back, and nothing is faked as done;
     4. a decision the station recorded but never carried out (a restart between the two) offers CARRY IT OUT, which posts that very
        decision (its token, its revision, its note);
     5. the window's list says WAITING FOR YOU, not BLOCKED; nothing here posts anywhere else. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../frontend/app/pipeline.js');
const WL = require('../frontend/app/workflowline.js');
const LE = require('../frontend/app/lineedit.js');
const WM = require('../frontend/app/worldmodel.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/windows/workflows.js'), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 15));

(async () => {
  const st = WM.create(WM.starterDoc());
  const fetches = [], registered = {};
  let replyFor = () => ({ ok: true, jobs: [] });
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Set, Map, encodeURIComponent,
    U: { bus: { on() {} } }, module: { exports: {} }, window: {}, document: { activeElement: null, querySelector: () => null },
    StationUI: { registerWindow: (k, t, fn, o) => { registered[k] = { t, fn, o }; }, openTerm() {}, h: { present: [{ id: 'nova', name: 'NOVA' }], sfx() {}, notify() {}, navigateWork() {} } },
    App: { station: () => st }, Pipeline: P, WorkflowLine: WL, LineEdit: LE, WorldModel: WM, RunOutcome,
    Build: { nagWhy: c => 'nag:' + c, lineSchematic: () => null, machineStill: () => '',
      lineWords: () => ({ plain: { research_line: 'Research + write' }, purpose: { research_line: 'one agent digs up sources, the next writes the answer' } }) },
    World: { syncPlan: () => Promise.resolve({ errors: [] }), bayLive: () => null },
    ReturnStore: { foldRow() { return true; }, pendingRows: () => [] },
    fetch: (url, init) => {   // a real fetch rejects when the station cannot be reached; it never throws
      fetches.push({ url, init });
      let r; try { r = replyFor(url, init); } catch (e) { return Promise.reject(e); }
      return Promise.resolve(r).then(x => ({ status: x.__status || 200, json: () => Promise.resolve(x) }));
    }
  });
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInContext(src, ctx, { filename: 'workflows.js' });
  const WW = ctx.module.exports, S = WW._state;
  WW._pick('research_line'); WW._create();
  const line = WW._floor().lines[0];

  const WHY = 'the reviewer at the gate 12,4 answered VERDICT: blocked, so the work is held there — not sent on, not shipped';
  const heldJob = (over, cont) => Object.assign({ id: 'job-0123456789ab', line: line.key, name: line.name, text: 'write a post about the moon', status: 'held', outcome: 'blocked', startedAt: 1, endedAt: null, usd: 0.04, output: '',
    error: WHY, stop: { code: 'blocked', why: WHY }, runs: [{ runId: 'r2', agentId: 'nova', reason: 'done', outcome: 'succeeded', usd: 0.01 }], notes: [],
    continuation: Object.assign({ version: 1, revision: 1, phase: 'held', hold: { gateId: '12,4', reason: 'blocked', why: WHY, pass: 1, allowed: ['approve', 'send_back', 'stop'] },
      walk: { lastHanded: 'THE DRAFT <b>under</b> review', product: { text: 'not safe to publish\nVERDICT: blocked' } }, decisions: [], activeDecision: null }, cont) }, over);
  const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

  /* ---- 1. what a held job shows ---- */
  {
    const h = WW._resultHTML(line, heldJob()), t = text(h);
    A.ok(/WAITING FOR YOU/.test(h) && !/>BLOCKED</.test(h), 'the header says whose move it is, not BLOCKED');
    A.ok(t.includes('Waiting for your decision') && t.includes('The reviewer at the gate 12,4 answered VERDICT: blocked, so the work is held there'), 'it says why the job is held');
    A.ok(h.includes('data-md-src="THE DRAFT &lt;b&gt;under&lt;/b&gt; review"') && t.includes('The work under review'), 'it shows the work under review (escaped, never markup)');
    A.ok(/What the reviewer said/.test(h) && h.includes('not safe to publish'), 'and what the reviewer said');
    A.ok(h.includes('data-decision="approve"') && h.includes('data-decision="send_back"') && h.includes('data-decision="stop"') && h.includes('id="wfw-decide-note"'), 'APPROVE, SEND BACK, STOP and the note box are in the existing job box');
    A.ok(/data-act="again" disabled/.test(h) && !/NEEDS CHANGES/.test(h) && !/KEEP THIS STYLE/.test(h), 'a held job cannot be sent again (the key is off) and has nothing to rate or keep: it delivered nothing');
    const spent = WW._resultHTML(line, heldJob({}, { hold: { gateId: '12,4', reason: 'spent', why: WHY, pass: 3, allowed: ['approve', 'stop'] } }));
    A.ok(!spent.includes('data-decision="send_back"') && /used all its passes/.test(text(spent)) && spent.includes('data-decision="approve"'), 'a gate with no pass left does not offer SEND BACK, and says why');
    const done = WW._resultHTML(line, Object.assign(heldJob(), { status: 'delivered', outcome: 'delivered', endedAt: 2, output: 'The result.', continuation: undefined, stop: null }));
    A.ok(!done.includes('data-decision') && !/WAITING FOR YOU/.test(done) && /SEND IT AGAIN/.test(done), 'a job that is not held shows none of it');
  }

  /* ---- 2. one press, one decision: the token is the checkpoint\'s, the revision the job read\'s ---- */
  const posted = () => fetches.filter(f => /\/decision$/.test(f.url)).map(f => JSON.parse(f.init.body));
  {
    const job = heldJob();
    S.job = job; S.jobs = [job]; S.view = 'line'; S.line = line.key;
    replyFor = url => /\/decision$/.test(url) ? { __status: 202, ok: true, running: true, job: Object.assign({}, job, { status: 'running', outcome: 'running' }) } : /\/api\/line-jobs\?/.test(url) ? { ok: true, jobs: [] } : { ok: true, job };
    WW._decide(job, 'approve');
    A.ok(S.deciding && S.deciding.action === 'approve', 'the press is out to the station (the keys are disabled meanwhile)');
    A.ok(/disabled/.test(WW._resultHTML(line, job).match(/data-decision="approve"[^>]*>/)[0]), '…and the key says so');
    WW._decide(job, 'stop');   // a second press while one is out
    for (let i = 0; i < 6; i++) await tick();
    const first = posted();
    A.eq([first.length, first[0].action, first[0].revision, first[0].note, /^ui-[a-z0-9-]+$/.test(first[0].token)], [1, 'approve', 1, '', true], 'ONE decision was posted, on the revision the job read, with a token of its own');
    A.ok(/\/api\/line-jobs\/job-0123456789ab\/decision$/.test(fetches.find(f => /\/decision$/.test(f.url)).url) && fetches.find(f => /\/decision$/.test(f.url)).init.method === 'POST', 'to POST /api/line-jobs/<id>/decision');
    A.eq([S.deciding, S.job.status], [null, 'running'], 'the 202 follows the job on: the record on screen is the running one');
    WW._decide(job, 'approve');
    for (let i = 0; i < 6; i++) await tick();
    const second = posted();
    A.eq([second.length, second[1].token === first[0].token], [2, true], 'pressing APPROVE again at the same revision is the SAME token — the station answers the saved receipt, it never decides twice');
    S.job = job;
    S.draft['decide:' + job.id] = '  cut the second paragraph  ';
    WW._decide(job, 'send_back');
    for (let i = 0; i < 6; i++) await tick();
    const third = posted()[2];
    A.eq([third.action, third.note, third.token !== first[0].token, third.revision], ['send_back', 'cut the second paragraph', true, 1], 'SEND BACK carries the note, trimmed, under a token of its own');
    A.ok(posted().every(b => b.action !== 'approve' || b.note === ''), 'APPROVE carries no note');
    const moved = heldJob({}, { revision: 3 });
    S.job = moved; fetches.length = 0;
    WW._decide(moved, 'approve');
    for (let i = 0; i < 6; i++) await tick();
    A.eq([posted()[0].revision, posted()[0].token !== first[0].token], [3, true], 'another revision of the hold is a new checkpoint: a new token');
  }

  /* ---- 3. a refusal shows its reason and the job as it now is ---- */
  {
    fetches.length = 0; S.heldMsg = null;
    const job = heldJob(), refusedRec = heldJob({ resumeRefused: { token: 'ui-x', action: 'approve', why: 'E-STOP is engaged', at: 5 } },
      { revision: 3, decisions: [{ token: 'ui-x', revision: 1, fingerprint: 'f', action: 'approve', note: '', at: 5, state: 'refused' }] });
    S.job = job; S.jobs = [job];
    replyFor = url => /\/decision$/.test(url) ? { __status: 409, ok: false, refused: true, error: 'E-STOP is engaged', job: refusedRec } : { ok: true, jobs: [] };
    WW._decide(job, 'approve');
    for (let i = 0; i < 6; i++) await tick();
    A.eq([S.deciding, S.heldMsg && S.heldMsg.bad, S.heldMsg && S.heldMsg.text, S.job.continuation.revision], [null, true, 'E-STOP is engaged', 3], 'the refusal is shown, not faked as done; the record on screen is the re-read one (revision 3)');
    const t = text(WW._resultHTML(line, S.job));
    A.ok(t.includes('Your APPROVE was not carried out: E-STOP is engaged. Nothing was spent; the job is still waiting.'), 'the card says what was not carried out and why: ' + t.slice(0, 400));
    A.ok(WW._resultHTML(line, S.job).includes('data-decision="approve"'), 'and the keys are back — a NEW decision on the new revision is the only way on');
    fetches.length = 0; S.deciding = null;
    replyFor = () => { throw new Error('offline'); };
    WW._decide(S.job, 'stop');
    for (let i = 0; i < 6; i++) await tick();
    A.ok(S.heldMsg && S.heldMsg.bad && /could not be reached/.test(S.heldMsg.text) && S.deciding === null, 'an unreachable station is said, and nothing is claimed');
  }

  /* ---- 4. a decision recorded and never carried out ---- */
  {
    fetches.length = 0; S.heldMsg = null;
    const claimed = heldJob({}, { revision: 2, activeDecision: 'ui-live', decisions: [{ token: 'ui-live', revision: 1, fingerprint: 'f', action: 'send_back', note: 'make it shorter', at: 5, state: 'accepted' }] });
    const h = WW._resultHTML(line, claimed);
    A.ok(/Your SEND BACK was recorded but not carried out yet/.test(text(h)) && h.includes('data-act="decide-apply"') && !h.includes('data-decision="approve"'), 'the card offers to CARRY IT OUT, and no new decision (the checkpoint is claimed)');
    S.job = claimed;
    replyFor = url => /\/decision$/.test(url) ? { __status: 200, ok: true, replayed: true, receipt: { token: 'ui-live', state: 'adopted' }, job: Object.assign({}, claimed, { status: 'running' }) } : { ok: true, jobs: [], job: claimed };
    const c = claimed.continuation, d = c.decisions[0];
    WW._decide(claimed, d.action, { action: d.action, token: d.token, revision: d.revision, note: d.note });
    for (let i = 0; i < 6; i++) await tick();
    A.eq(posted(), [{ action: 'send_back', token: 'ui-live', revision: 1, note: 'make it shorter' }], 'CARRY IT OUT posts that very decision: its token, its revision, its note');
  }

  /* ---- 4b. adopted, never started: the station stopped before the first stage ---- */
  {
    const stuck = heldJob({ status: 'interrupted', outcome: 'interrupted', stop: { code: 'restart', why: 'the station stopped' } }, { phase: 'ready', hold: null, revision: 3, activeDecision: 'ui-adopted',
      decisions: [{ token: 'ui-adopted', revision: 1, fingerprint: 'f', action: 'approve', note: '', at: 5, state: 'adopted' }] });
    const h = WW._resultHTML(line, stuck);
    A.ok(/Your APPROVE was recorded, but the job never started/.test(text(h)) && /Nothing was spent for it/.test(text(h)) && h.includes('data-act="decide-apply"') && !h.includes('data-decision="approve"'), 'an adopted decision whose walk never started offers CARRY IT OUT, and no new decision');
    A.ok(!WW._resultHTML(line, Object.assign({}, stuck, { continuation: Object.assign({}, stuck.continuation, { activeDecision: null, decisions: [Object.assign({}, stuck.continuation.decisions[0], { state: 'complete' })] }) })).includes('decide-apply'), 'a decision that was carried out offers nothing');
  }

  /* ---- 5. the list, and nothing new ---- */
  A.ok(/j\.status === 'held' \? '<span class="wfw-st warn">⏸ WAITING FOR YOU<\/span>'/.test(src), 'the list row says WAITING FOR YOU for a held job (not BLOCKED)');
  A.ok(!/registerWindow\('(held|decisions)/.test(src) && (src.match(/registerWindow\(/g) || []).length === 1, 'no new window: the decision lives in the existing job box');
  A.ok((src.match(/\/decision'/g) || []).length === 1, 'one route posts a decision');
  A.report('line-hold.ui');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.ui'); });
