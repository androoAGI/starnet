/* node test/window-step.test.js: THE WINDOW MOVES IN STEPS (cost lane W2.6; STARNET_WINDOW_STEP, off by default).

   THE COST. A desk chat sends a bounded window of the conversation: the newest 120 rows, cut further to the token budget
   (frontend/app/historyfit.js). Past either line the window starts one exchange later on every send, so the first history
   row of a request is never the first history row of the request before it, and the provider's prompt cache (a prefix
   match) reads none of the history: every message of a long chat pays to write the whole window again (measured by the
   cost audit: +33.7k tokens on a warm slid send).

   THE FIX. With the switch on, the station starts the window at a MARK of the canonical rows (historyfit.js stepStart, the
   one resolver; sidecar/turn-window.js apply). This file holds the ON state:
     1. stepStart: the hard bounds still hold, the row window never holds fewer rows than the sliding one, a budget-bound
        window keeps at least two thirds of what the budget holds, and the start moves a handful of times in 200 sends;
     2. the window seam: a posted page window keeps the page's own rows from the mark on, the station's rows go in front,
        and shadow, ID and required windows open on the same row;
     3. the measurement the lane reports: prefix-stable bytes per send and rows in view over a 200-row chat, off and on;
     4. the earlier-conversation note is the same bytes between two steps, and every row out of view is in the part it renders;
     5. the page's budget for the next send is measured against what was sent (run start windowStep, harness.js, fitModel).
   The OFF state (byte-identical to the 0.15.2 candidate) and the invariant that is red there: window-step.invariant.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), vm = require('node:vm');
const Fit = require('../frontend/app/historyfit.js');
const Gauge = require('../frontend/app/ctxgauge.js');
const Window = require('../sidecar/turn-window.js');
const View = require('../sidecar/turn-view.js');
const Earlier = require('../sidecar/earlier-conversation.js');
const { makeChat, dialogue, wire, sharedBytes, totalBytes, ask, reply } = require('./helpers/window-step-chat.js');

const CAP = Fit.HISTORY_CAP, STEP = Fit.WINDOW_STEP;
A.eq([CAP, STEP], [120, 40], 'the row cap is the page\'s 120 and a step is 40 rows');
const tokensOf = rows => rows.reduce((n, row) => n + Fit.contextEstimateMessages([row]), 0);
const slidingStart = (rows, budget) => {
  let kept = Fit.fitHistoryBytes(rows.slice(-CAP), Fit.HISTORY_WIRE_MAX_BYTES);
  if (Number.isFinite(budget)) kept = Fit.fitHistoryTokens(kept, budget);
  return rows.length - kept.length;
};

/* ---------- 1. the resolver ---------- */
{
  const rows = Array.from({ length: 401 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? reply(i >> 1) : ask(i >> 1) }));
  const expectMoves = { none: 8, 60000: 16, 52000: 30, 30000: 18, 8000: 100 };
  for (const budget of [undefined, 60000, 52000, 30000, 8000, 2500]) {
    const name = budget === undefined ? 'no token budget' : 'budget ' + budget;
    let last = 0, moves = 0, bounded = true, never = true, kept = true, marks = true, monotone = true, rowSpan = [Infinity, 0];
    for (let n = 1; n <= rows.length; n += 2) {
      const now = rows.slice(0, n), start = Fit.stepStart(now, { budget }), sliding = slidingStart(now, budget), window = now.slice(start);
      if (window.length > 1 && Number.isFinite(budget) && tokensOf(window) > budget) bounded = false;
      const rowBound = sliding === Math.max(0, n - CAP), held = n - sliding;
      if (rowBound && start > sliding) never = false;                                         // never fewer rows than the sliding window
      if (!rowBound && (start < sliding || window.length < held - Math.floor(held / 3))) kept = false;   // the budget forces fewer: at most a third given up
      if (start !== sliding && start % 10 !== 0 && start % 4 !== 0) marks = false;
      if (start < last) monotone = false;
      if (start !== last) moves++;
      last = start;
      if (n > CAP + STEP) { rowSpan[0] = Math.min(rowSpan[0], window.length); rowSpan[1] = Math.max(rowSpan[1], window.length); }
    }
    A.ok(bounded, name + ': the stepped window never passes the token budget');
    A.ok(never, name + ': while the sliding window is whole (row-bound), the stepped window never holds fewer rows');
    A.ok(kept, name + ': where the budget cuts the sliding window too, at least two thirds of the rows it holds stay in view');
    A.ok(marks && monotone, name + ': the start is a mark (or the sliding start when no mark fits) and never moves back');
    if (budget === undefined) A.eq(rowSpan, [CAP + 1, CAP + STEP - 1], 'past the cap the row window holds 121 to 159 rows');
    const limit = expectMoves[budget === undefined ? 'none' : budget];
    if (limit) A.ok(moves <= limit, name + ': the start moves ' + moves + ' times in 201 sends (at most ' + limit + ')');
    else A.ok(moves > 150, name + ': a budget of a few rows has no mark to hold: the window slides as before (' + moves + ' moves)');
  }
  // a full 119-row budget window keeps at least 80 rows; the start is a 40-row mark
  const full = rows.slice(0, 301), budget119 = tokensOf(full.slice(-119)) + 1;
  const s = Fit.stepStart(full, { budget: budget119 });
  A.ok(s % 40 === 0 && full.length - s >= 80 && full.length - s <= 119, 'a budget that holds 119 rows steps on the 40-row marks and keeps at least 80 (' + (full.length - s) + ')');
  // a holder that has only the newest part names the same marks through `base`
  for (const n of [181, 245, 333]) {
    const whole = Fit.stepStart(rows.slice(0, n), {}), base = whole - 7;
    A.eq(base + Fit.stepStart(rows.slice(base, n), { base }), whole, 'rows that begin at ordinal ' + base + ' name the same mark as the whole stream (n ' + n + ')');
  }
  // the wire byte cap is a hard bound too
  const fat = Array.from({ length: 141 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'b'.repeat(12000) + i }));
  const fs0 = Fit.stepStart(fat, {}), bytes = Fit.utf8Bytes(JSON.stringify(fat.slice(fs0)));
  A.ok(bytes <= Fit.HISTORY_WIRE_MAX_BYTES && fs0 >= slidingStart(fat), 'a window the byte cap cuts stays inside the byte cap (' + bytes + ' bytes from row ' + fs0 + ')');
  A.eq([Fit.stepStart([], {}), Fit.stepStart(null, {}), Fit.stepStart(rows.slice(0, 1), { budget: 1 })], [0, 0, 0], 'an empty list and a lone directive start at 0');
}

/* ---------- 2. the window seam ---------- */
const chat = makeChat();
const identities = [];
const make = step => Window.make({ transcriptStore: chat.store, turnDual: chat.dual, failNote: () => {}, limitOf: () => 128000, compactAt: 0.65,
  noteIdentity: (run, value) => identities.push({ run, value }), windowStep: step });
const on = make(() => true), off = make(undefined);
const AMPLE = 92800;
const contents = messages => dialogue(messages).map(m => m.content);
const sends = [];   // per send: what each state sent
for (let k = 0; k < 100; k++) {
  const n = 2 * k + 1, posted = chat.posted(k, AMPLE), canon = chat.canonical(k);
  const start = Fit.stepStart(canon, { budget: AMPLE });
  chat.setMode('shadow');
  const offCtx = chat.context(k), offOut = off.apply(posted, chat.request(k, AMPLE), offCtx);
  const ctx = chat.context(k), out = on.apply(posted, chat.request(k, AMPLE), ctx);
  if (k < 60) {
    if (out !== posted || ctx.step) A.ok(false, 'send ' + k + ': a chat inside the row cap is posted as it was, with nothing to tell the page');
  } else {
    A.eq(contents(out), canon.slice(start).map(r => r.content), 'send ' + k + ': the posted window opens on the mark (row ' + start + ') and runs to the new directive');
    const mine = dialogue(posted);
    A.ok(mine.every(row => out.includes(row)), 'send ' + k + ': every row the page posted rides as the page\'s own object');
    A.ok(out[View.ROW_IDS] === undefined && out[0] === posted[0], 'send ' + k + ': it is a plain posted window (no station row ids), the system row first');
    const added = dialogue(out).slice(0, dialogue(out).length - mine.length);
    A.eq([ctx.step && ctx.step.rows, ctx.step && ctx.step.delta], [added.length, Gauge.estimateMessages(added)],
      'send ' + k + ': the run start tells the page the rows and dialogue tokens the step put in front');
    A.eq(identities.at(-1).value.windowRowIds.count, dialogue(out).length - 1, 'send ' + k + ': the run identity records every durable row of the stepped window');
    // ID mode and a required window open on the same row, from the station's own rows
    chat.setMode('id');
    const idCtx = chat.context(k), idOut = on.apply(posted, chat.request(k, AMPLE), idCtx);
    A.eq(contents(idOut), contents(out), 'send ' + k + ': ID mode sends the same rows as shadow');
    A.ok(Array.isArray(idOut[View.ROW_IDS]), 'send ' + k + ': the station\'s own window keeps its row ids');
    chat.setMode('shadow');
    const need = on.apply([chat.newest(k)], chat.request(k, AMPLE, { windowFrom: 'station' }), chat.context(k));
    A.eq(contents(need), contents(out), 'send ' + k + ': a required (newest-only) window sends the same rows');
  }
  sends.push({ k, n, start, off: wire(offOut), on: wire(out), offRows: dialogue(offOut).length, onRows: dialogue(out).length, offOut, out });
  chat.finish(k);
}

/* ---------- 3. the measurement: a 200-row chat, off and on ---------- */
function measure(key, rowsKey) {
  const past = sends.filter(s => s.n > CAP), shares = [];
  for (const s of past) { const prev = sends[s.k - 1]; shares.push(sharedBytes(prev[key], s[key]) / totalBytes(s[key])); }
  const rows = past.map(s => s[rowsKey]);
  return { sends: past.length, mean: shares.reduce((a, b) => a + b, 0) / shares.length, min: Math.min(...shares),
    rewrites: shares.filter(x => x < 0.5).length, rowsMin: Math.min(...rows), rowsMax: Math.max(...rows),
    bytes: past.reduce((n, s) => n + totalBytes(s[key]), 0), fresh: past.reduce((n, s) => n + totalBytes(s[key]) - sharedBytes(sends[s.k - 1][key], s[key]), 0) };
}
const mOff = measure('off', 'offRows'), mOn = measure('on', 'onRows');
const pct = x => (100 * x).toFixed(1) + '%';
console.log('[window-step] 200-row chat, sends past the 120-row cap: ' + mOff.sends);
console.log('[window-step]   OFF prefix-stable bytes per send: mean ' + pct(mOff.mean) + ', min ' + pct(mOff.min) + ', sends rewritten ' + mOff.rewrites + '/' + mOff.sends + '; rows in view ' + mOff.rowsMin + '-' + mOff.rowsMax + '; history bytes not in the previous send ' + mOff.fresh + ' of ' + mOff.bytes);
console.log('[window-step]   ON  prefix-stable bytes per send: mean ' + pct(mOn.mean) + ', min ' + pct(mOn.min) + ', sends rewritten ' + mOn.rewrites + '/' + mOn.sends + '; rows in view ' + mOn.rowsMin + '-' + mOn.rowsMax + '; history bytes not in the previous send ' + mOn.fresh + ' of ' + mOn.bytes);
A.ok(mOff.mean < 0.02 && mOff.rewrites === mOff.sends, 'off: past the cap every send rewrites the whole history (mean stable share ' + pct(mOff.mean) + ')');
A.ok(mOn.mean > 0.93 && mOn.rewrites === 1, 'on: one send in the 40 past the cap rewrites the history, the rest open on the previous send\'s bytes (mean stable share ' + pct(mOn.mean) + ')');
A.eq([mOff.rowsMin, mOff.rowsMax], [CAP, CAP], 'off: the window holds 120 rows past the cap');
A.eq([mOn.rowsMin, mOn.rowsMax], [CAP + 1, CAP + STEP - 1], 'on: the window holds 121 to 159 rows past the cap, never fewer than off');
A.ok(sends.every(s => s.onRows >= s.offRows), 'on: no send shows fewer rows than the sliding window does at the same point');
A.ok(mOn.fresh * 8 < mOff.fresh, 'on: the history bytes a send does not share with the one before it fall by more than 8x (' + mOff.fresh + ' -> ' + mOn.fresh + ')');
for (const s of sends.filter(s => s.n > CAP + 2 && s.start === sends[s.k - 1].start)) {
  const prev = sends[s.k - 1].on;
  if (JSON.stringify(s.on.slice(0, prev.length)) !== JSON.stringify(prev)) A.ok(false, 'send ' + s.k + ': between two steps the history opens with exactly the previous send\'s history');
}
A.ok(true, 'between two steps every send opens with exactly the previous send\'s history bytes');

/* ---------- 4. the earlier-conversation note ---------- */
{
  // the note as index.js runOnceCore renders it: the window before the new directive, placed in the stream's canonical rows
  const rowsOf = k => chat.store.view('model-replay', chat.streamId, { limit: 3000, shape: 'pairs', rows: true }).filter(r => r.rowId <= 2 * k);
  const noteOf = (messages, k) => {
    const convo = dialogue(messages), rows = rowsOf(k), cut = Earlier.align(rows, convo.slice(0, -1), t => t).cut;
    const earlier = cut > 0 ? Earlier.render(rows.slice(0, cut), { windowTokens: 200000, searchTool: 'recall_conversation', ownerVoice: true }) : null;
    return { cut, note: earlier ? earlier.note : '', rows };
  };
  let offChanges = 0, onChanges = 0, onSteps = 0, covered = true, placed = true, last = null;
  for (const s of sends.filter(s => s.n > CAP)) {
    const a = noteOf(s.offOut, s.k), b = noteOf(s.out, s.k);
    if (b.cut !== s.start || a.cut !== s.n - CAP) placed = false;                      // the note covers exactly the rows before the window
    if (!b.rows.slice(0, b.cut).every((r, i) => r.content === chat.page[i].content)) covered = false;
    if (last) {
      if (a.note !== last.a.note) offChanges++;
      if (b.note !== last.b.note) onChanges++;
      if (s.start !== last.start) onSteps++;
    }
    last = { a, b, start: s.start };
  }
  A.ok(placed && covered, 'every row the window leaves out is in the part the earlier note renders (and the transcript recall_conversation searches)');
  A.eq([onChanges, onSteps], [1, 1], 'on: the earlier note changes only at a step (once in the 39 sends after the first past the cap)');
  A.eq(offChanges, 39, 'off: the earlier note is different bytes on every send past the cap');
  const within = sends.filter(s => s.start === 40 && s.k > 81);
  A.ok(within.length > 10 && new Set(within.map(s => noteOf(s.out, s.k).note)).size === 1 && noteOf(within[0].out, within[0].k).note.includes('recall_conversation'),
    'between two steps the note is byte-identical and still names the conversation search');
}

/* ---------- a stream longer than the canonical rows' limit: the note's oldest end moves in steps too ---------- */
{
  const LIMIT = 3000, all = Array.from({ length: 3400 }, (_, i) => ({ streamId: 'big', rowId: 5000 + i, role: i % 2 ? 'assistant' : 'user',
    content: (i % 2 ? 'answer ' : 'question ') + i + ' ' + 'w'.repeat(i % 2 ? 300 : 90) }));
  const windowRow = 5000 + 3040;   // the row the stepped window opens on: the same for every send below
  const render = rows => Earlier.render(rows, { windowTokens: 200000, searchTool: 'recall_conversation', ownerVoice: true }).note;
  let plainChanges = 0, markChanges = 0, markMoves = 0, last = null, sends = 0, inside = true;
  for (let n = 3100; n <= 3400; n += 2) {   // each send the stream is two rows longer, and the host reads its newest 3000
    const rows = all.slice(0, n).slice(-LIMIT), cut = rows.findIndex(r => r.rowId === windowRow), front = Earlier.frontMark(rows, LIMIT);
    if (!(front >= 0 && front < cut && rows[front].rowId % Earlier.FRONT_STEP === 0 && front < Earlier.FRONT_STEP)) inside = false;
    const now = { plain: render(rows.slice(0, cut)), marked: render(rows.slice(front, cut)), mark: rows[front].rowId };
    if (last) { sends++; if (now.plain !== last.plain) plainChanges++; if (now.marked !== last.marked) markChanges++; if (now.mark !== last.mark) markMoves++; }
    last = now;
  }
  A.ok(inside, 'the front mark is the first row at a multiple of ' + Earlier.FRONT_STEP + ' durable ids, within that many rows of the front');
  A.eq([plainChanges, sends], [150, 150], 'rendered from the list\'s front, the note of a stream past the limit is different bytes on every send');
  A.eq([markChanges, markMoves], [1, 1], 'rendered from the front mark, it changes only when the front passes a mark (once in 150 sends)');
  A.eq([Earlier.frontMark(all.slice(0, 2999), LIMIT), Earlier.frontMark(all.slice(0, 3000).map(r => ({ role: r.role, content: r.content })), LIMIT), Earlier.frontMark(null, LIMIT), Earlier.frontMark(all, 0)],
    [0, 0, 0, 0], 'a list under its limit, or one with no durable ids, is rendered from its front as before');
  A.eq(Earlier.frontMark(all.slice(120, 3120), LIMIT), 0, 'a front that sits on a mark is the mark (ids from 5120 on: 5120 is a multiple of 512)');
}

/* ---------- a budget that cuts the window: the posted rows before the mark are left out ---------- */
{
  const tight = makeChat({ streamId: 't' });
  const w = Window.make({ transcriptStore: tight.store, turnDual: tight.dual, failNote: () => {}, limitOf: () => 128000, compactAt: 0.65, noteIdentity: () => {}, windowStep: () => true });
  const BUDGET = 30000;
  let moves = 0, last = -1, trimmed = 0, ok = true, fewest = Infinity;
  for (let k = 0; k < 120; k++) {
    const posted = tight.posted(k, BUDGET), canon = tight.canonical(k), ctx = tight.context(k);
    const out = w.apply(posted, tight.request(k, BUDGET), ctx), mine = dialogue(posted), sent = dialogue(out);
    const start = canon.length - sent.length, held = canon.length - slidingStart(canon, BUDGET);
    if (start !== Fit.stepStart(canon, { budget: BUDGET })) ok = false;                 // the mark, by the station's ruler over its own rows
    if (!sent.slice(-Math.min(sent.length, mine.length)).every(row => mine.includes(row))) ok = false;   // the page's own rows wherever it posted them
    if (sent.length > 1 && tokensOf(canon.slice(start)) > BUDGET) ok = false;
    if (sent.length < mine.length) trimmed++;
    if (sent.length !== mine.length ? !(ctx.step && ctx.step.rows === sent.length - mine.length && ctx.step.delta === Gauge.estimateMessages(sent) - Gauge.estimateMessages(mine)) : !!ctx.step) ok = false;
    if (sent.length < held - Math.floor(held / 3)) ok = false;
    if (k > 60) { if (start !== last) moves++; fewest = Math.min(fewest, sent.length); }
    last = start;
    tight.finish(k);
  }
  A.ok(ok, 'a budget-cut window: the rows from the mark on (the page\'s own wherever it posted them), inside the budget, at most a third of what the budget holds left out, and the page told the difference');
  A.ok(trimmed > 40 && moves <= 7 && fewest >= 50, 'it moves ' + moves + ' times in 59 sends instead of 59 (rows in view never under ' + fewest + ')');
}

/* ---------- a window nothing places rides as posted ---------- */
{
  const k = 100, posted = chat.posted(k, AMPLE);
  const bare = posted.map(m => m.role === 'system' ? m : { role: m.role, content: m.content, turnId: m.turnId, turnAt: m.turnAt });
  const ctx = chat.context(k);
  A.ok(on.apply(bare, chat.request(k, AMPLE), ctx) === bare && !ctx.step, 'a posted window that names no durable row is not stepped: the same array, nothing told');
  const branch = [posted[0], { role: 'assistant', content: 'BRANCH', streamId: 'other', rowId: 7 }].concat(posted.slice(1)), bctx = chat.context(k);
  A.ok(on.apply(branch, chat.request(k, AMPLE), bctx) === branch && !bctx.step, 'a branch copy keeps the posted page window');
  chat.setMode('legacy');
  const lctx = chat.context(k);
  A.ok(on.apply(posted, chat.request(k, AMPLE), lctx) === posted && !lctx.step, 'the legacy window mode is not stepped');
  chat.setMode('shadow');
  const ineligible = chat.context(k);
  A.ok(on.apply(posted, chat.request(k, AMPLE, { windowCaller: undefined }), ineligible) === posted && !ineligible.step, 'a caller that is not the desk is not stepped');
}

/* ---------- 5. the page measures its next budget against what was sent ---------- */
{
  const harness = fs.readFileSync(require.resolve('../frontend/app/harness.js'), 'utf8');
  const region = (from, to) => { const a = harness.indexOf(from), b = harness.indexOf(to, a); if (a < 0 || b <= a) throw Error('harness.js region not found: ' + from); return harness.slice(a, b); };
  const occupancy = region('  let contextByKey = {};', '\n  // Desktop (Tauri) build:');
  const readSide = region('  function contextState(agentId, streamId, messages) {', '\n  function normalizeModel(');
  const pageOf = () => { const shelf = new Map(); return vm.runInNewContext(occupancy + '\n' + readSide +
    '\n({ registerRun, foldContextCost, endContextRun, contextState, peek: () => contextByKey, overheads: () => overheadByModel });',
    { CtxGauge: Gauge, console: { warn() {}, log() {} }, getModel: () => 'model-a', contextLimitOf: () => 200000, runWindowOf: () => 0,
      localStorage: { getItem: key => (shelf.has(key) ? shelf.get(key) : null), setItem: (key, v) => { shelf.set(key, String(v)); }, removeItem: key => { shelf.delete(key); } } }); };
  const history = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? reply(i) : ask(i) }));
  const grown = history.concat([{ role: 'assistant', content: reply(900) }, { role: 'user', content: ask(901) }]);
  const S = 25000, sent = Gauge.estimateMessages(history), model = { limit: 200000, runWindow: 200000, compactAt: 0.65, selected: 'model-a', window: 'legacy' };
  const budgetAfter = (delta, tell) => {
    const page = pageOf();
    page.registerRun('r1', 'agent', 'ws', history, tell ? { rows: delta > 0 ? 39 : -19, delta } : undefined);
    page.foldContextCost({ agentId: 'agent', runId: 'r1', model: 'model-a', tokensIn: S + sent + delta });   // the provider measured what the station sent
    page.endContextRun({ runId: 'r1' });
    const state = page.contextState('agent', 'ws', Fit.fitModel(grown, model).messages);
    return { budget: Fit.fitModel(grown, Object.assign({}, model, { state })).budget, state, page };
  };
  const plain = budgetAfter(0, false);
  for (const delta of [6100, -4300]) {
    const told = budgetAfter(delta, true), untold = budgetAfter(delta, false);
    A.eq(told.state.stepDelta, delta, 'the state carries the dialogue the step ' + (delta > 0 ? 'added' : 'left out') + ' (' + delta + ')');
    A.eq(told.budget, plain.budget, 'told of the step, the next budget is the one of a window sent as posted');
    A.eq(untold.budget, Math.min(plain.budget - delta, Math.floor(200000 * 0.65)), 'untold, the step would read as ' + (delta > 0 ? 'a larger' : 'a smaller') + ' overhead: a budget ' + Math.abs(delta) + ' tokens ' + (delta > 0 ? 'too small' : 'past the fold line'));
    A.eq(Object.values(told.page.overheads())[0].overhead, Object.values(plain.page.overheads())[0].overhead, 'the model\'s learned overhead is the same too');
  }
  A.eq(Object.keys(plain.page.peek()['agent' + String.fromCharCode(0) + 'ws']).sort(), ['baseline', 'live', 'model', 'runId', 'sentEstimate', 'used'],
    'a run that names no step leaves the reading exactly as before');
  A.ok(!('stepDelta' in plain.state), 'and its state carries no step');
}
A.report('window-step');
