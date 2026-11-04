/* test/workflow-panel-review-1012.test.js — the Workflow panel / WORKFLOWS window findings of the 2026-10-12 release review
   (wave 2, agent lane). Each block drives the panel's OWN functions (sliced out of frontend/app/workflowpanel.js and
   frontend/app/windows/workflows.js with A.fnBody and run in a vm against stubs, the way conveyor-choices does) and asserts what
   the Commander reads:
     conveyor-ui-07  SPLIT THE JOB: ADD A BRANCH says the new step takes one more PART (never "a copy of every job"); the split
                     note says only TAKE TURNS swaps the JOINER for a MERGER
     conveyor-ui-08  paintPlain carries no unreachable OUTBOX copy (paintOutbox is the one place it is written)
     conveyor-ui-11  a BAY whose role the inserter does not offer (PLANNER) shows it as a pressed chip, never roleless
     conveyor-ui-12  a line / step NAME's answer is the panel's own line under its field — never the off-panel toast — and a name
                     saved while the panel closes still says why
     conveyor-ui-14  KEEP AS THE EXAMPLE claims the crew learned the style only when the station STORED it
     conveyor-ui-15  a job's steps are named by the step's NAME first, then its role, in the panel and in WORKFLOWS */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const panel = rd('frontend/app/workflowpanel.js'), windowSrc = rd('frontend/app/windows/workflows.js');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the named functions of `src`, run in one vm context over `globals` (each body bounded: a mis-scan fails loudly)
function load(src, headers, globals, extra) {
  if (headers.includes('function resultHTML(l, job)')) {
    const owner = src.match(/^  const jobOutcome = .*;$/m);
    A.ok(!!owner, 'the result view includes its actual typed job-outcome helper');
    extra = (extra || '') + '\n' + owner[0];
    globals = Object.assign({ RunOutcome: require('../frontend/app/runoutcome.js') }, globals);
  }
  const body = headers.map(h => { const b = A.fnBody(src, h); A.ok(b.length > 20 && b.length < 20000, 'sliced ' + h + ' (' + b.length + ' chars)'); return b; }).join('\n');
  const names = headers.map(h => /function (\w+)\(/.exec(h)[1]);
  const ctx = vm.createContext(Object.assign({ esc, console, JSON, Math, Date, String, Object, Array, Promise }, globals));
  return vm.runInContext((extra || '') + '\n' + body + '\n({ ' + names.join(', ') + ' })', ctx);
}
const stubEl = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, value: '', focus() {}, blur() {},
  setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
const body = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });

/* ---------- conveyor-ui-07 / -08: the SPLITTER card says what each mode does ---------- */
{
  function splitter(mode) {
    const b = body();
    const fns = load(panel, ['function paintPlain(body, f, p)', 'function laneName(f, l, arrow)'], {
      H: { junctionInfo: () => ({ cfg: { fanout: mode !== 'turns' }, lanes: [] }), machineDiagram: () => '', lineEdit: true,
        splitModeInfo: () => ({ mode, toCopy: { ok: true }, toDivide: { ok: true }, toTurns: { ok: true } }) },
      editBtn: (op, id, args, label, tip) => '<button data-edit="' + op + '" data-tip="' + esc(tip) + '">' + esc(label) + '</button>',
      branchLabel: () => 'BAY 2', wireEdits() {}, $: () => null, paintFilter() {}, paintOutbox() {}
    });
    fns.paintPlain(b, { order: [], docks: {} }, { id: 's1', t: 'splitter' });
    return b.innerHTML;
  }
  const div = splitter('divide'), copy = splitter('copy'), turns = splitter('turns');
  const tipOf = html => ((/data-edit="addArm" data-tip="([^"]*)"/.exec(html) || [])[1] || '');
  A.ok(/one more step takes one more part of the job/.test(tipOf(div)) && !/copy of every job/.test(tipOf(div)), 'SPLIT THE JOB: ADD A BRANCH says the new step takes one more PART of the job — ' + tipOf(div));
  A.ok(/gets a copy of every job/.test(tipOf(copy)), 'COPY TO EACH: ADD A BRANCH still says the new step gets a copy');
  A.ok(/takes its turn with the others/.test(tipOf(turns)), 'TAKE TURNS: ADD A BRANCH still says it takes its turn');
  const note = html => ((/id="split-note">([^<]*)</.exec(html) || [])[1] || '');
  A.ok(/TAKE TURNS swaps the JOINER or MERGER/.test(note(div)) && /COPY TO EACH and SPLIT THE JOB share the JOINER/.test(note(div)), 'the split note says only TAKE TURNS swaps the junction — ' + note(div));
  const plain = A.fnBody(panel, 'function paintPlain(body, f, p)');
  A.ok(plain.length > 0 && !/outbox: \['OUTBOX'/.test(plain) && !/browse delivered work in the Logbook/.test(plain), 'paintPlain carries no unreachable OUTBOX copy (conveyor-ui-08)');
  const b = body(), fns = load(panel, ['function paintPlain(body, f, p)', 'function laneName(f, l, arrow)'], { H: { junctionInfo: () => null, machineDiagram: () => '' }, paintFilter() {}, paintOutbox() {} });
  fns.paintPlain(b, null, { id: 'x', t: 'gizmo' });
  A.ok(/GIZMO/.test(b.innerHTML) && /Part of the line/.test(b.innerHTML), 'any other machine still gets the plain card');
}

/* ---------- conveyor-ui-11: an off-list role is a pressed chip ---------- */
{
  function bayHTML(role) {
    const b = body();
    const fns = load(panel, ['function paintBay(body, f, p)'], {
      WL: () => ({ starters: () => [] }), H: { roleInfo: () => null, agents: () => [], canSummon: () => false, stepPositionOf: () => 'chain', station: () => ({ setPropRole() {} }), sfx() {}, flashTip() {} },
      contractRows: () => ({ gets: 'x', to: 'y' }), tryInfo: () => ({ html: '', wire() {} }), computeHTML: () => '', addsOnTopHTML: () => '', shapeHTML: () => '',
      agentStatus: () => ({ txt: 'free' }), thumb: () => '', wireEdits() {}, wireLive() {}, S: { drafts: {} }, $: () => stubEl(), $$: () => [], nameOf: x => x, el: {}, paint() {}
    }, "const STEP_ROLES = ['RESEARCHER', 'WRITER', 'REVIEWER', 'ENGINEER', 'TESTER', 'ANALYST', 'SHIPPER', 'GENERALIST'];");
    fns.paintBay(b, null, { id: 'b1', t: 'bay', role, label: '' });
    return b.innerHTML;
  }
  const planner = bayHTML('PLANNER'), writer = bayHTML('WRITER');
  A.ok(/data-role="PLANNER" aria-pressed="true">PLANNER</.test(planner), 'a PLANNER BAY shows PLANNER as its pressed role chip');
  A.eq((planner.match(/aria-pressed="true"/g) || []).length, 1, '…and only that chip is pressed');
  A.ok(!/data-role="PLANNER"/.test(writer) && /data-role="WRITER" aria-pressed="true"/.test(writer), 'a listed role adds no extra chip (the inserter list is unchanged)');
  A.ok(!/PLANNER/.test(A.fnBody(panel, 'function inserterHTML(from, to, f)')), 'the + inserter still never offers PLANNER (it needs a dividing splitter)');
}

/* ---------- conveyor-ui-12: a NAME's answer is said under its field ---------- */
{
  const tips = [], sounds = [];
  const S = { note: null };
  const input = Object.assign(stubEl(), { tagName: 'INPUT', id: 'wf-name', dataset: {}, closest: () => null, parentNode: { insertBefore() {} }, nextSibling: null });
  const el = { querySelectorAll: sel => (String(sel).split(',').map(x => x.trim()).indexOf('input') >= 0 ? [input] : []), querySelector: () => null, insertBefore() {} };
  const H = { sfx: s => sounds.push(s), flashTip: (m, ok) => tips.push([m, ok]) };
  const fns = load(panel, ['function note(t, bad, anchor)', 'function placeNote()', 'function findAnchor(k)', 'function refuse(msg, anchor)', 'function said(msg, bad, anchor)'], {
    S, H, el, $: () => null, $$: q => el.querySelectorAll(q), clearTimeout() {}, setTimeout: () => 0, document: { createElement: () => Object.assign(stubEl(), { classList: { add() {} } }) }
  }, "const NOTE_MS = 9000; let noteTimer = 0; const anchorKey = b => { if (!b || !b.dataset) return ''; if (b.dataset.edit) return 'edit:' + b.dataset.edit; return b.id ? 'id:' + b.id : ''; };");
  fns.said('A line called RESEARCH is already on the floor', true, input);
  A.ok(S.note && S.note.bad === true && S.note.at === 'id:wf-name' && /already on the floor/.test(S.note.t), 'a refused line name is the panel\'s own answer line, keyed to its field — ' + JSON.stringify(S.note));
  A.eq(tips.length, 0, '…never the off-panel toast');
  A.ok(sounds.indexOf('bad') >= 0, '…with the refusal sound');
  A.ok(fns.findAnchor('id:wf-name') === input, 'the answer finds its INPUT again after a repaint (findAnchor reads inputs too)');
  fns.said('line named — LINE RESEARCH', false, input);
  A.ok(S.note && S.note.bad === false && /line named/.test(S.note.t) && tips.length === 0, 'a saved name is said in the panel too');
  S.closing = true; S.note = null;
  fns.said('A line called RESEARCH is already on the floor', true, input);
  A.ok(!S.note && tips.length === 1 && tips[0][1] === false, 'a name refused while the panel closes still says why (the floor tip) — it is never lost');
  const head = A.fnBody(panel, 'function paintHead(f)'), bay = A.fnBody(panel, 'function paintBay(body, f, p)');
  A.ok(/else \{ nameIn\.value = saved; said\(\(res && res\.msg\) \|\| 'name not saved', true, nameIn\); \}/.test(head), 'the line name\'s refusal goes through said() under #wf-name');
  A.ok(/else \{ bayName\.value = savedName; said\(\(r && r\.msg\) \|\| 'name not saved', true, bayName\); \}/.test(bay), 'the step name\'s refusal goes through said() under #wf-bay-name');
  A.ok(!/H\.flashTip\([^;]*name not saved/.test(head + bay), 'no name refusal is a toast any more');
  const close = A.fnBody(panel, 'function close()');
  A.ok(/S\.closing = true;\s*try \{ saveOpenFields\(\); \} finally \{ S\.closing = false; \}/.test(close), 'close() marks the closing save so its answer reaches the floor tip');
}

/* ---------- wave-2 repair (conveyor-ui-12): a NAME's answer stays with ITS part; a refusal outlives a mouse close ---------- */
{
  const anchorKeySrc = A.fnBody(panel, 'const anchorKey = b => {');
  A.ok(anchorKeySrc.length > 40 && anchorKeySrc.length < 1200 && /b\.dataset\.nameFor\) return 'name:' \+ b\.dataset\.nameFor/.test(anchorKeySrc), 'a NAME field is keyed by the part it names, never the shared input id');
  A.ok(/<input id="wf-name" data-name-for="' \+ esc\(intake\.id\) \+ '"/.test(A.fnBody(panel, 'function paintHead(f)')), 'the line name field carries its INBOX');
  A.ok(/<input id="wf-bay-name" data-name-for="' \+ esc\(p\.id\) \+ '"/.test(A.fnBody(panel, 'function paintBay(body, f, p)')), 'the step name field carries its BAY');
  // the panel's own note machinery, with the real anchorKey, over a panel whose fields are swapped as the selection moves
  function rig() {
    const tips = [], placed = [];
    const field = (id, nameFor) => Object.assign(stubEl(), { tagName: 'INPUT', id, dataset: { nameFor }, closest: () => null, parentNode: { insertBefore() { placed.push(nameFor); } }, nextSibling: null });
    const ctx = { S: { note: null, closing: false }, inputs: [], placed, tips };
    const el = { querySelectorAll: sel => (String(sel).split(',').map(x => x.trim()).indexOf('input') >= 0 ? ctx.inputs : []), querySelector: () => null, insertBefore() {}, remove() {} };
    const H = { sfx() {}, flashTip: (m, ok) => tips.push([m, ok]), highlight() {}, pausedMarker() {}, panelShown() {} };
    const fns = load(panel, ['function note(t, bad, anchor)', 'function placeNote()', 'function findAnchor(k)', 'function refuse(msg, anchor)', 'function said(msg, bad, anchor)', 'function close()'], {
      S: ctx.S, H, el, $: () => null, $$: q => el.querySelectorAll(q), clearTimeout() {}, setTimeout: () => 0, clearInterval() {}, saveOpenFields() {}, stopPoll() {}, todayTimer: 0,
      document: { createElement: () => Object.assign(stubEl(), { classList: { add() {} } }) }
    }, 'const NOTE_MS = 9000, NOTE_FRESH_MS = 2000; let noteTimer = 0; ' + anchorKeySrc + ';');
    return Object.assign(ctx, { fns, field });
  }
  // a step named on BAY 1, then BAY 2 picked: the answer never shows under BAY 2's NAME
  let r = rig();
  r.inputs = [r.field('wf-bay-name', 'b1')];
  r.fns.said('step named — Fact checker', false, r.inputs[0]);
  A.ok(r.S.note && r.S.note.at === 'name:b1' && r.placed.join() === 'b1', 'the answer is said under BAY 1\'s NAME — ' + JSON.stringify(r.S.note));
  r.inputs = [r.field('wf-bay-name', 'b2')]; r.placed.length = 0;
  r.fns.placeNote();
  A.eq(r.placed.length, 0, 'after BAY 2 is picked, BAY 1\'s answer is not placed under BAY 2\'s NAME');
  A.ok(!r.S.note && r.tips.length === 0, '…it goes (a saved name needs no echo: the strip shows it)');
  // a refused name, then another line opened: the refusal is said on the floor, never under the other line's name
  r = rig();
  r.inputs = [r.field('wf-name', 'i1')];
  r.fns.said('A line called RESEARCH is already on the floor', true, r.inputs[0]);
  A.ok(r.S.note && r.S.note.bad && r.tips.length === 0, 'a refused line name is the panel\'s answer under LINE A\'s name');
  r.inputs = [r.field('wf-name', 'i2')]; r.placed.length = 0;
  r.fns.placeNote();
  A.ok(r.placed.length === 0 && !r.S.note, 'LINE B\'s card never shows LINE A\'s refusal');
  A.ok(r.tips.length === 1 && /already on the floor/.test(r.tips[0][0]) && r.tips[0][1] === false, '…and the reason is said once on the floor, never lost — ' + JSON.stringify(r.tips));
  // the real mouse close: mousedown on ✕ blurs the field (save refused, said in the panel), THEN the click closes the panel
  r = rig();
  r.inputs = [r.field('wf-name', 'i1')];
  r.fns.said('A line called RESEARCH is already on the floor', true, r.inputs[0]);   // the blur, S.closing still false
  A.ok(r.S.note && r.tips.length === 0, '(the blur) the refusal is said in the panel');
  r.fns.close();                                                                       // the click
  A.ok(r.tips.length === 1 && /already on the floor/.test(r.tips[0][0]) && r.tips[0][1] === false, 'closing right after keeps the reason: the floor tip says it — ' + JSON.stringify(r.tips));
  A.ok(!r.S.note, '…and the panel\'s note goes with the panel');
  r = rig();
  r.inputs = [r.field('wf-name', 'i1')];
  r.fns.said('A line called RESEARCH is already on the floor', true, r.inputs[0]);
  r.S.note.ts -= 5000;   // said 5 s before the close: it had its time on screen
  r.fns.close();
  A.eq(r.tips.length, 0, 'a refusal that had time on screen is not said again when the panel closes');
}

/* ---------- conveyor-ui-14: the crew learned the style only when the station stored it ---------- */
{
  (async () => {
    // the immediate toast says only the step's fact
    const kx = A.fnBody(panel, 'function keepExample(mine)');
    A.ok(kx.length > 0 && !/the crew learns/.test(kx) && /will match this example · UNDO takes it back/.test(kx), 'KEEP AS THE EXAMPLE says only that the step will match it before the station answers');
    /* (wave-2 repair) the first cut of this table locked two wrong answers in: created:false ("already knew") is a record that
       existed — a 👎 on that run, say — gaining the kept flag, so the crew DID learn the style; and 'nothing to learn' is the
       station saying that run's style is ALREADY kept (FeedbackMemory.apply returns null for a kept=true on a record already
       feedbackKept), so it is true and calm, not a failure. The UNDO contract is unchanged: only a stored keep resolves true. */
    const cases = [
      [{ status: 200, j: { ok: true, feedbackMemory: { stored: true, created: true } } }, /^the crew learned this style · UNDO takes it back$/, true, true],
      [{ status: 200, j: { ok: true, feedbackMemory: { stored: true, created: false } } }, /^the crew learned this style · UNDO takes it back$/, true, true],
      [{ status: 200, j: { ok: true, feedbackMemory: { stored: false, reason: 'personalization-paused' } } }, /learning is paused/, false, false],
      [{ status: 200, j: { ok: true, feedbackMemory: { stored: false, reason: 'could not save' } } }, /did not learn the style: could not save/, false, false],
      [{ status: 200, j: { ok: true, feedbackMemory: { stored: false, reason: 'nothing to learn' } } }, /^kept for this step — the crew already keeps this style$/, false, true],
      [{ status: 500, j: { ok: false, error: 'boom' } }, /could not learn the style: boom/, false, false]
    ];
    for (const [reply, said, stored, calm] of cases) {
      const tips = [];
      const ctx = { S: {}, H: { flashTip: (m, ok) => tips.push([m, ok]) }, api: () => Promise.resolve(reply) };
      const fns = load(panel, ['function keepTaste(mine, runId)'], ctx);
      fns.keepTaste({ stamp: 7 }, 'run-7');
      const got = await ctx.S.tasteKept.sent.then(v => v, () => 'threw');
      A.eq(got, stored, 'keep-style ' + JSON.stringify(reply.j) + ' resolves stored=' + stored + ' (only a stored style is taken back by UNDO)');
      A.ok(tips.length === 1 && said.test(tips[0][0]) && tips[0][1] === calm, 'and says ' + said + ' (' + (calm ? 'ok' : 'warning') + ') — ' + JSON.stringify(tips));
      A.ok(stored || !/learned|already knew/.test((tips[0] || [''])[0]), '…never "learned" when nothing was stored');
      A.ok(!/already knew/.test((tips[0] || [''])[0]), '…and never "already knew" (a new approval is learned)');
    }

    /* ---------- conveyor-ui-15: steps go by their NAME ---------- */
    {
      const st = { 'b1': { id: 'b1', t: 'bay', label: 'Fact checker', role: 'REVIEWER' }, 'b0': { id: 'b0', t: 'bay', label: '', role: 'WRITER' } };
      const fns = load(panel, ['function jobResultHTML(mine, f)', 'function loopNotes(text)'], {
        prop: id => st[id] || null, nameOf: a => a.toUpperCase(), stepText: () => 'reply', stepOut: {}, H: { sampleHTML: () => '', plan: () => ({}) }, WL: () => require('../frontend/app/workflowline.js'),
        S: {}, exampleKept: () => false, notRightHTML: () => '', Pipeline: undefined, runEnd: r => 'ran out of turns'
      }, "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;");
      const runs = [{ runId: 'r2', dockId: 'b1', agentId: 'nova', reason: 'max_iters', usd: 0.01 }, { runId: 'r1', dockId: 'b0', agentId: 'ada', reason: 'done', usd: 0.01 }];
      const html = fns.jobResultHTML({ view: { ok: false, usd: 0.02 }, runs, output: 'x', stamp: 1 }, null);
      A.ok(/2 · Fact checker · NOVA/.test(html) && !/REVIEWER · NOVA/.test(html), 'a named step is listed by its NAME in HOW EACH STEP DID IT');
      A.ok(/1 · WRITER · ADA/.test(html), '…an unnamed one by its role, as before');
      A.ok(/The Fact checker step \(NOVA\) ran out of turns/.test(html), 'the problem line names the step the way the strip does');
      /* (org wire AUTO-GATE-1) the SHIPPED note belongs to the ✓ DELIVERED header only: a PROBLEM job never computes it (this stub has
         no notShippedNote — the call above would have thrown), and a delivered job still reads it */
      A.ok(!/wf-job-where|not counted in SHIPPED/.test(html), 'a job that FINISHED WITH A PROBLEM carries no SHIPPED note');
      let nsCalls = 0;
      const okFns = load(panel, ['function jobResultHTML(mine, f)', 'function loopNotes(text)'], {
        prop: id => st[id] || null, nameOf: a => a.toUpperCase(), stepText: () => 'reply', stepOut: {}, H: { sampleHTML: () => '', plan: () => ({}) }, WL: () => require('../frontend/app/workflowline.js'),
        S: {}, exampleKept: () => false, notRightHTML: () => '', Pipeline: undefined, runEnd: r => 'ran out of turns', ReturnStore: undefined,
        notShippedNote: () => { nsCalls++; return ' · <span class="wf-noship">not counted in SHIPPED</span>'; }
      }, "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;");
      const okHtml = okFns.jobResultHTML({ view: { ok: true, usd: 0.02 }, runs: [{ runId: 'r1', dockId: 'b0', agentId: 'ada', reason: 'done', usd: 0.02 }], output: 'x', stamp: 2, shipped: false }, null);
      A.ok(nsCalls === 1 && /✓ DELIVERED[^]*wf-job-where[^]*not counted in SHIPPED/.test(okHtml), 'a DELIVERED job still says it was not counted in SHIPPED (' + nsCalls + ' call)');
      const live =A.fnBody(panel, 'function liveNow(f)');
      A.ok(/w\.p\.label \|\| w\.p\.role \|\| 'STEP'/.test(live) && /q\.p\.label \|\| q\.p\.role \|\| 'STEP'/.test(live), 'the riding job\'s "Now: step n" names it the same way');
      A.ok(/p\.label \|\| p\.role \|\| 'STEP'/.test(A.fnBody(panel, 'function fixCardHTML(x, i, f)')), 'a suggested fix names its step the same way');
    }
    {
      const st = { propById: id => ({ b1: { id: 'b1', t: 'bay', label: 'Fact checker', role: 'REVIEWER' } })[id] || null };
      const fns = load(windowSrc, ['function resultHTML(l, job)', 'function workOf(text)'], {
        stationOf: () => st, S: { stepOut: {}, prev: {}, fix: null }, ReturnStore: undefined, secs: () => '1s', usd: () => '$0.01', NAME: a => a.toUpperCase(),
        lineWord: () => 'LINE A', ago: () => 'now', styleKept: () => false, runningJob: () => null, fixHTML: () => '', P: () => null, Pipeline: undefined
      }, "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;");
      const html = fns.resultHTML({ key: 'L', steps: [] }, { id: 'j1', status: 'problem', text: 'job', output: 'out', usd: 0.01,
        runs: [{ runId: 'r2', dockId: 'b1', agentId: 'nova', reason: 'max_iters', usd: 0.01 }],
        notes: [{ kind: 'fix', role: 'Fact checker', field: 'does', at: 1 }] });
      A.ok(/The Fact checker step \(NOVA\) ran out of turns/.test(html), 'WORKFLOWS names the failing step by its NAME');
      A.ok(/1 · Fact checker · NOVA/.test(html), 'WORKFLOWS lists each step by its NAME');
      const notes = ['function useFix(job, i, back)', 'function keepStyle(job)', 'function putStyleBack(job)'].map(h => A.fnBody(windowSrc, h)).join('\n');
      A.eq((notes.match(/role: p\.label \|\| p\.role \|\| ''/g) || []).length, 3, 'every job note (fix, example, put back) stores the step\'s NAME first');
      const map = A.fnBody(windowSrc, 'function mapHTML(l, workingId)'), step = A.fnBody(windowSrc, 'function stepHTML(l, s)'), setup = A.fnBody(windowSrc, 'function setupHTML(l)'), lv = A.fnBody(windowSrc, 'function liveNow(line)');
      A.ok(/s\.label \|\| s\.role/.test(map) && /s\.label \|\| s\.role/.test(step) && /s\.label \|\| s\.role/.test(setup) && /st\.label \|\| st\.role \|\| 'STEP'/.test(lv), 'the map tip, the opened step, the setup rows and "Now: step n" all say the NAME first');
      A.ok(/p\.label \|\| p\.role \|\| 'STEP'/.test(A.fnBody(windowSrc, 'function fixHTML(job, l)')), 'a suggested change names its step the same way');
    }
    /* ---------- wave-2 repair (conveyor-ui-15 leftovers): the INBOX schedule form, STEP THROUGH, the crew picker, readiness and NOT
       RIGHT? name a step by its NAME too ---------- */
    {
      const WLm = require('../frontend/app/workflowline.js'), P = require('../frontend/app/pipeline.js'), WM = require('../frontend/app/worldmodel.js'), LE = require('../frontend/app/lineedit.js');
      const d = WM.starterDoc();
      for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 44; r.y2 = 44; }
      const st = WM.create(d), bp = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 });
      const bays = bp.ids.filter(id => st.propById(id).t === 'bay');
      st.setPropLabel(bays[0], 'Fact checker');
      const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo), comp = P.lineComponents(geo).find(c => c.props.indexOf(bays[0]) >= 0);
      const flow = WLm.lineFlow(plan, comp, P, geo.props);
      const ready = WLm.readiness(flow, comp, { errors: plan.errors || [], stepName: pid => (st.propById(pid) || {}).label });
      const whats = ready.blocking.map(b => b.what);
      A.ok(whats.indexOf('BAY 1 (Fact checker) needs an agent') >= 0 && whats.some(w => /^BAY 2 \(\w+\) needs an agent$/.test(w)), 'readiness names a named BAY by its NAME, an unnamed one by its role — ' + JSON.stringify(whats));
      A.ok(WLm.readiness(flow, comp, { errors: plan.errors || [] }).blocking.some(b => /^BAY 1 \(RESEARCHER\) needs an agent$/.test(b.what)), '…and a caller with no names keeps the role');
      const head = A.fnBody(panel, 'function paintHead(f)'), cmds = rd('frontend/app/stationcommands.js');
      A.ok(/stepName: pid => \{ const p = prop\(pid\); return p && p\.label; \}/.test(head), 'the panel\'s pill asks readiness with the step names');
      A.ok(/stepName: pid => \{ const p = propOf\(pid\); return p && p\.label; \}/.test(cmds), '…and station.layout with the same facts');
      const trig = A.fnBody(panel, 'function paintTrigger(body, f, p)');
      A.ok(trig.length > 100 && trig.indexOf("const firstName = docks.length ? ((prop(docks[0].propId) || {}).label || docks[0].role) : '';") >= 0
        && trig.indexOf("'<b>' + esc((firstName ? firstName + ' · ' : '') + nameOf(docks[0].agentId)) + '</b> — this line’s first step") >= 0, 'the INBOX schedule form says "fires at" the first step by its NAME');
      A.ok(/Rewrite ' \+ esc\(p\.label \|\| p\.role \|\| nameOf\(h\.agentId\)\) \+ '’s brief/.test(A.fnBody(panel, 'function pausedHTML(s, f)')), 'STEP THROUGH\'s paused card names the step by its NAME');
      // the crew picker: an agent already on a named BAY says that BAY's NAME
      const ag = load(panel, ['function agentStatus(aid, bayId)'], { H: { station: () => ({ props: () => [{ id: 'b9', t: 'bay', agentId: 'nova', role: 'REVIEWER', label: 'Fact checker' }] }), lineOfProp: () => ({ key: 'L' }), lineNameOf: () => 'LINE A' } });
      A.eq(ag.agentStatus('nova', 'b1').txt, 'also on LINE A · Fact checker', 'the crew picker says where else the agent works by that step\'s NAME');
      const ag2 = load(panel, ['function agentStatus(aid, bayId)'], { H: { station: () => ({ props: () => [{ id: 'b9', t: 'bay', agentId: 'nova', role: 'REVIEWER', label: '' }] }), lineOfProp: () => ({ key: 'L' }), lineNameOf: () => 'LINE A' } });
      A.eq(ag2.agentStatus('nova', 'b1').txt, 'also on LINE A REVIEWER bay', '…an unnamed one by its role, as before');
      // NOT RIGHT?: the fix model is given the step's NAME beside its role (both askFixes)
      A.ok(/role: p\.role \|\| '', name: p\.label \|\| ''/.test(A.fnBody(panel, 'function askFixes(mine, complaint)')) && /role: p\.role \|\| '', name: p\.label \|\| ''/.test(A.fnBody(windowSrc, 'function askFixes(job, line, complaint)')), 'NOT RIGHT? sends each step\'s NAME with its role, in the panel and in WORKFLOWS');
    }
    A.report('workflow-panel-review-1012.test');
  })().catch(e => { console.error(e); process.exit(1); });
}
