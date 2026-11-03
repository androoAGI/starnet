/* node test/ctx-gauge-memo.test.js — the CONTEXT gauge's 1 s read is O(1) while nothing changed (idle CPU piece 3, 2026-10-20).

   THE COST. The station tick (1 Hz, forever) reads Chat.contextRef(), which rebuilt historyWindow from scratch: a
   JSON.stringify + TextEncoder per message for the byte cap, again per message for the token fit, again for the calibrated
   refit — three or four whole-conversation serializations every second on a chat that had not moved.

   GENUINE (executed): chat.js's real history-window block (HISTORY_CAP … contextRef) runs in a vm against the real
   CtxGauge, with a JSON whose stringify counts its calls; Harness is a stub with a real-shaped contextState. Then the real
   occupancy block of harness.js proves contextRevision moves on every reading write. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CtxGauge = require('../frontend/app/ctxgauge.js');
const TurnMerge = require('../frontend/app/turnmerge.js');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/chat.js'), 'utf8');
const from = chatSrc.indexOf('  const HISTORY_CAP = HistoryFit.HISTORY_CAP;');
const to = chatSrc.indexOf('  function persistPartial(', from);
A.ok(from > 0 && to > from, 'fixture: the history-window block is locatable in chat.js');

let stringifies = 0, clock = 5000000, model = 'model-a', rev = 0;
const limits = { 'model-a': 200000, 'model-b': 32000 };
const countingJSON = { stringify: (...a) => { stringifies++; return JSON.stringify(...a); }, parse: JSON.parse };
const ctx = vm.createContext({
  JSON: countingJSON, CtxGauge, TurnMerge, stationModes: { window: 'legacy' }, TextEncoder, Math, Number, String, Array, Object,
  Date: { now: () => clock },
  activeWs: null,
  Harness: {
    getModel: () => model,
    contextLimitOf: m => limits[m] || 0,
    contextRevision: () => rev,
    // a settled, measured conversation: the calibrated refit path runs (the costliest one)
    contextState: (aid, sid, msgs) => ({ model, limit: limits[model], used: 40000 + CtxGauge.estimateMessages(msgs || []), measured: true })
  }
});
// Load the real shared fitter in this realm so its JSON work is measured along with Chat's memo.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend/app/historyfit.js'), 'utf8'), ctx, { filename: 'historyfit.js' });
vm.runInContext(chatSrc.slice(from, to) + '\nthis.contextRef = contextRef; this.historyWindow = historyWindow;', ctx, { filename: 'chat.js#history-window' });

const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(40), ts: 1000 + i });
const ws = { id: 'ws1', agentId: 'agent', history: Array.from({ length: 40 }, (_, i) => msg(i)) };
ctx.activeWs = ws;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// one read, measured
stringifies = 0;
const first = ctx.contextRef();
const oneCall = stringifies;
A.ok(oneCall >= 80, 'fixture: one fresh read serializes the conversation several times (' + oneCall + ' stringify calls for 40 messages)');
// ten more ticks with nothing changed
stringifies = 0;
for (let i = 0; i < 10; i++) { clock += 1000; ctx.contextRef(); }
A.eq(stringifies, 0, 'ten 1 s ticks on an unchanged chat serialize nothing (was ' + (oneCall * 10) + ' stringify calls)');
A.ok(ctx.contextRef() === first, 'the unchanged read is the same answer object');
A.ok(same(first.messages, ctx.historyWindow(ws)), 'and it equals a fresh historyWindow');

// every input that can move the answer forces a recompute, and the answer is then exactly a fresh one
function forces(label, change) {
  change();
  stringifies = 0;
  const ref = ctx.contextRef();
  A.ok(stringifies > 0, label + ': recomputed');
  A.ok(same(ref.messages, ctx.historyWindow(ws)) && ref.streamId === ws.id && ref.agentId === (ws.agentId || 'agent'), label + ': equals a fresh historyWindow');
  stringifies = 0; ctx.contextRef();
  A.eq(stringifies, 0, label + ': and is memoized again');
  return ref;
}
forces('a new message', () => { ws.history.push(msg(40)); });
forces('a reply streaming into the last message', () => { ws.history[ws.history.length - 1].content += ' more streamed text'; });
forces('a popped message', () => { ws.history.pop(); });
forces('a spliced-in turn (same last message)', () => { ws.history.splice(5, 0, msg(99)); });
forces('a replaced history array', () => { ws.history = ws.history.slice(); });
forces('a context reading (contextRevision)', () => { rev++; });
const switched = forces('a model switch', () => { model = 'model-b'; });
A.ok(switched.messages.length < first.messages.length, 'the 32K model fits fewer turns: the memo did not hide a real change');
forces('the catalog limit moving', () => { limits['model-b'] = 64000; });
forces('another agent on the conversation', () => { ws.agentId = 'copy'; });
forces('the 15 s ceiling', () => { clock += 16000; });
// fix round (2026-10-20): a backward wall-clock step leaves the ceiling unmeasurable, so it re-derives (it held the memo until the clock caught up)
forces('a backward wall-clock step', () => { clock -= 300000; });
const other = { id: 'ws2', agentId: 'agent', history: [msg(1), msg(2)] };
ctx.activeWs = other;
stringifies = 0;
const o = ctx.contextRef();
A.ok(stringifies > 0 && o.streamId === 'ws2' && o.messages.length === 2, 'another conversation on screen reads its own window');
ctx.activeWs = null;
A.eq(ctx.contextRef(), null, 'no conversation on screen: nothing to measure');

// an older harness without contextRevision: no memo, today's behaviour
ctx.activeWs = ws; delete ctx.Harness.contextRevision;
stringifies = 0; ctx.contextRef(); const a = stringifies; ctx.contextRef();
A.eq(stringifies, a * 2, 'without Harness.contextRevision every read recomputes (no stale gauge on a mismatched build)');

/* ---- harness.js: contextRevision moves on every reading write (the ctx-conversation-scope idiom) ---- */
const hSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/harness.js'), 'utf8');
const hFrom = hSrc.indexOf('  let contextByKey = {};');
const hTo = hSrc.indexOf('\n  // Desktop (Tauri) build:', hFrom);
A.ok(hFrom > 0 && hTo > hFrom, 'fixture: the harness occupancy block is locatable');
A.ok(/contextRevision: \(\) => contextRev/.test(hSrc), 'Harness exports contextRevision()');
const store = new Map();
const h = vm.runInNewContext(hSrc.slice(hFrom, hTo) + '\n({ registerRun, foldContextCost, endContextRun, rev: () => contextRev });', {
  CtxGauge, console: { warn() {}, log() {} }, getModel: () => 'model-a', contextLimitOf: () => 200000,
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
}, { filename: 'harness.js#occupancy' });
let r0 = h.rev();
h.registerRun('run1', 'agent', 'ws1', [{ role: 'user', content: 'hi' }]);
A.ok(h.rev() > r0, 'registerRun bumps contextRevision'); r0 = h.rev();
h.foldContextCost({ runId: 'run1', agentId: 'agent', model: 'model-a', tokensIn: 15000 });
A.ok(h.rev() > r0, 'foldContextCost (a reading + the learned overhead) bumps contextRevision'); r0 = h.rev();
h.endContextRun({ runId: 'run1' });
A.ok(h.rev() > r0, 'endContextRun (the reading leaves live mode) bumps contextRevision'); r0 = h.rev();
h.foldContextCost({ runId: 'x', agentId: 'agent', model: 'model-a', tokensIn: 0 });
A.eq(h.rev(), r0, 'a cost event that writes nothing leaves it alone');
for (const [label, re] of [['setModel', /if \(\(m \|\| ''\) !== prev\) \{ contextByKey = \{\}; runConv = \{\}; contextRev\+\+; \}/], ['resetTotals', /overheadByModel = Object\.create\(null\); contextRev\+\+;/]]) {
  A.ok(re.test(hSrc), label + ' (which clears the readings) bumps contextRevision');
}

A.report('ctx-gauge-memo.test');
