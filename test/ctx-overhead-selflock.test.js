/* node test/ctx-overhead-selflock.test.js — regression guard for THE CTX BAR THAT LOCKS A MODEL OUT FOR GOOD.

   THE DEFECT (user report 2026-11-19: "the CTX bar is full… new sessions don't reset the bar so I'm locked out of
   that particular opus model"). A chat that has never run has no reading of its own, so contextState projects it from
   the harness overhead LEARNED per (agent, model): the first cost reading of a run minus our estimate of what we sent.
   That fit was trusted whatever its size, persisted in localStorage, and replaced only by the NEXT run's fit. One
   oversized first reading (a provider whose reported prompt tokens carry more than the request we built) made every
   new chat on that agent + model project at or past the window, and the composer refuses to send at a 90% projection.
   No send, no run, no recalibration: /new could not escape, because the poison is per model, not per chat, and only a
   full re-WAKE wiped it.

   THE LAW THIS PINS:
     1. an overhead that would take half the window or more is not a per-request constant (the sidecar folds a run at
        ~65% of it): it is never LEARNED, and one already STORED is never projected from;
     2. a projection that rests only on the model-level overhead (basis 'model') never hard-blocks the composer — only
        a reading of THIS conversation (live / measured / its own baseline) or the dialogue itself may.

   Behavioural, not a source lock: runs the REAL occupancy + contextState bodies sliced out of harness.js (the
   ctx-conversation-scope idiom) and the REAL composerContextIssue / contextIssueFor bodies from chat.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CtxGauge = require('../frontend/app/ctxgauge.js');
const HistoryFit = require('../frontend/app/historyfit.js');
const harnessSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');

function region(src, label, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  A.ok(start >= 0, 'source still contains ' + label);
  const end = src.indexOf(endMarker, start);
  A.ok(end > start, label + ' has a locatable end');
  return src.slice(start, end);
}
const occupancy = region(harnessSrc, 'the context-occupancy block', '  let contextByKey = {};', '\n  // Desktop (Tauri) build:');
const readSide = region(harnessSrc, 'contextState', '  function contextState(agentId, streamId, messages) {', '\n  function normalizeModel(');

const SEP = String.fromCharCode(0);
const LIMIT = 200000;
function harness(stored) {
  const store = new Map();
  if (stored) store.set('starnet.ctx.overhead', JSON.stringify(stored));
  const sandbox = {
    CtxGauge,
    console: { warn() {}, log() {} },
    getModel: () => 'opus',
    contextLimitOf: id => (id === 'opus' ? LIMIT : 0),
    runWindowOf: () => 0,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); }
    }
  };
  const api = vm.runInNewContext(occupancy + '\n' + readSide +
    '\n({ registerRun, foldContextCost, endContextRun, contextState, overheads: () => overheadByModel });',
    sandbox, { filename: 'harness.js#selflock' });
  api.store = store;
  return api;
}
const hello = [{ role: 'user', content: 'hello' }];

/* 1. ⛔ THE LOCKOUT, from a calibration already on disk: a stored overhead of 190k against a 200k window. Pre-fix a
      brand-new chat projected ~190k (95%) and the composer refused it. It must read "no projection" instead. */
{
  const h = harness({ ['agent' + SEP + 'opus']: { overhead: 190000 } });
  const s = h.contextState('agent', 'ws_new', hello);
  A.eq(s.projected, false, 'a stored overhead of 95% of the window is not projected from');
  A.eq(s.used, 0, 'so a new chat does not read near-full');
  A.eq(s.measured, false, 'and nothing claims a measurement it does not have');
}

/* 2. the line is half the window: just under it still projects (a real heavy harness), at it does not. */
{
  const under = harness({ ['agent' + SEP + 'opus']: { overhead: LIMIT / 2 - 1 } }).contextState('agent', 'ws', []);
  A.eq(under.projected, true, 'an overhead just under half the window still projects');
  A.eq(under.basis, 'model', 'and says it rests on the model-level overhead');
  const at = harness({ ['agent' + SEP + 'opus']: { overhead: LIMIT / 2 } }).contextState('agent', 'ws', []);
  A.eq(at.projected, false, 'an overhead of half the window or more is never projected');
}

/* 3. an oversized first reading is never LEARNED, and the last good fit is kept. */
{
  const h = harness();
  h.registerRun('r1', 'agent', 'ws_A', hello);
  h.foldContextCost({ agentId: 'agent', runId: 'r1', model: 'opus', tokensIn: 13000 });
  h.endContextRun({ runId: 'r1' });
  const good = h.overheads()['agent' + SEP + 'opus'].overhead;
  A.ok(good > 12000 && good < 13000, 'a normal first reading calibrates (~13k)');
  h.registerRun('r2', 'agent', 'ws_B', hello);
  h.foldContextCost({ agentId: 'agent', runId: 'r2', model: 'opus', tokensIn: 450000 });   // more than the window itself
  h.endContextRun({ runId: 'r2' });
  A.eq(h.overheads()['agent' + SEP + 'opus'].overhead, good, 'an impossible first reading does not replace the good fit');
  A.ok(JSON.parse(h.store.get('starnet.ctx.overhead'))['agent' + SEP + 'opus'].overhead === good, 'nor is it persisted');
  const fresh = h.contextState('agent', 'ws_C', hello);
  A.ok(fresh.projected && fresh.used < 20000, 'a new chat still projects from the good fit, not the poisoned reading');
  // the conversation that produced the reading still shows ITS own measurement: that is a fact about that chat
  A.eq(h.contextState('agent', 'ws_B', hello).used, 450000, 'the chat that measured it keeps its own reading');
}

/* 4. bases: every contextState answer says what it rests on, so readers can tell a model guess from a chat reading. */
{
  const h = harness();
  h.registerRun('r1', 'agent', 'ws_A', hello);
  h.foldContextCost({ agentId: 'agent', runId: 'r1', model: 'opus', tokensIn: 13000 });
  A.eq(h.contextState('agent', 'ws_A', hello).basis, 'live', 'a run in flight is basis live');
  h.endContextRun({ runId: 'r1' });
  A.eq(h.contextState('agent', 'ws_A', hello).basis, 'measured', 'its settled first-turn reading is basis measured');
  A.eq(h.contextState('agent', 'ws_A', hello.concat([{ role: 'assistant', content: 'hi there' }])).basis, 'conversation',
    'grown from its own baseline is basis conversation');
  A.eq(h.contextState('agent', 'ws_new', hello).basis, 'model', 'a new chat projected from the overhead is basis model');
  A.eq(harness().contextState('agent', 'ws', hello).basis, 'none', 'nothing to stand on is basis none');
}

/* 5. ⛔ THE COMPOSER: a model-basis projection never hard-blocks a send (the run it would block is the only thing
      that can correct the calibration). A projection of THIS conversation still does. The dialogue check stays. */
{
  const body = name => { const b = A.fnBody(chatSrc, '  function ' + name + '('); A.ok(b, 'chat.js still defines ' + name + '()'); return b; };
  let STATE = null;
  const fns = new Function('CtxGauge', 'HistoryFit', 'Harness',
    body('contextEstimateMessages') + '\n' + body('contextIssueFor') + '\n' + body('composerContextIssue') + '\n' +
    'function modelFitHistory(h) { return h; }\n' +
    'return { composerContextIssue };')(CtxGauge, HistoryFit, {
      getModel: () => 'opus', contextLimitOf: () => LIMIT, contextState: () => STATE
    });
  const ws = { id: 'ws_new', agentId: 'agent', history: [] };
  STATE = { model: 'opus', limit: LIMIT, used: 190000, measured: false, projected: true, basis: 'model' };
  A.eq(fns.composerContextIssue(ws, 'hello'), null, 'a new chat whose only projection is the model overhead can send');
  STATE = { model: 'opus', limit: LIMIT, used: 190000, measured: false, projected: true, basis: 'conversation' };
  A.ok(fns.composerContextIssue(ws, 'hello'), 'a chat projected from its OWN baseline at 95% is still blocked');
  STATE = { model: 'opus', limit: LIMIT, used: 190000, measured: true, projected: false, basis: 'measured' };
  A.ok(fns.composerContextIssue(ws, 'hello'), 'a measured 95% is still blocked');
  STATE = { model: 'opus', limit: LIMIT, used: 190000, measured: false, projected: true, basis: 'model' };
  A.ok(fns.composerContextIssue(ws, 'Z'.repeat(800000)), 'a giant paste in a new chat is still blocked by the dialogue check');
}

/* 6. the website ships the same panel: the mirror carries both halves. */
{
  const web = f => fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', f), 'utf8');
  A.ok(web('harness.js').indexOf('function plausibleOverhead(') >= 0, 'the website harness.js mirror carries the overhead ceiling');
  A.ok(web('chat.js').indexOf("basis !== 'model'") >= 0, 'the website chat.js mirror carries the composer rule');
}

A.report('ctx-overhead-selflock');
