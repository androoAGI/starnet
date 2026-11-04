/* node test/chat-stopped-retry.test.js — EL-3 lock for PU-14 stopped-run recovery.

   chat.js is browser/DOM flow and is not directly require-able. As with chat-runmeta.test.js,
   this locks the exact behavioral seam in source: a deliberate stop must preserve truthful partial
   output, expose the existing one-turn retry action immediately and after reload, and discard the
   whole replaced attempt before re-running the already-present user turn. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

// The deliberate-stop branch owns the recovery offer. Network errors use their classified action;
// a Commander stop is not an error and must use the plain existing Try again action.
const stoppedBranch = /if\s*\(stopped\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{/.exec(src);
A.ok(stoppedBranch, 'chat.js has a distinct deliberate-stop branch');
A.ok(/offerTryAgain\s*\(\s*\)/.test(stoppedBranch[1]), 'RUN STOPPED renders a reachable Try again action');

// Partial prose is real and remains visible, but the record is tagged so retry/reload can distinguish
// it from a completed assistant turn without inventing backend state.
A.ok(/markStoppedTurn\s*\(\s*ws\s*,\s*acc\s*\)/.test(stoppedBranch[1]),
  'the thrown-abort stop truthfully marks its partial assistant turn');
A.ok(!/if\s*\(\s*acc\.trim\(\)\s*\)\s*markStoppedTurn/.test(stoppedBranch[1]),
  'even a zero-token stop writes a durable stopped marker for reload recovery');

// A normal completed stream envelope can also report endReason != done (max_iters, budget,
// cancellation, refusal). Those cards render RUN STOPPED too and need the same recovery seam.
// 'clarifying' is excluded: a Task Brief question is a clean decision turn, never a stopped run.
const envelopeStop = /if\s*\(endReason\s*&&\s*endReason\s*!==\s*'done'\s*&&\s*endReason\s*!==\s*'clarifying'\s*&&\s*!taskQuestion\)\s*\{([\s\S]*?)\n\s*\}\s*else\s+if\s*\(chipOc === 'cut_short'\)/.exec(src);   // review 9: the cut branch is the cut_short outcome's
A.ok(envelopeStop, 'chat.js has a normal-envelope RUN STOPPED branch');
A.ok(/markStoppedTurn\s*\(\s*ws\s*,\s*replyText\s*\)/.test(envelopeStop[1]),
  'normal-envelope RUN STOPPED marks its partial/empty tail for exact retry');
A.ok(/offerTryAgain\s*\(\s*\)/.test(envelopeStop[1]),
  'normal-envelope RUN STOPPED renders the same reachable Try again action');

// Existing /retry semantics: drop the failed/stopped assistant tail, find the existing user turn,
// and call send(..., {retry:true}) so there is exactly one new run and no duplicate user row.
const retryFn = /function\s+retryLast\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(src);
A.ok(retryFn, 'retryLast exists');
// The WHOLE failed attempt goes, not just its ⚠ row: a run that streamed several replies left them after the user
// turn, the retry request ended on an assistant message, and current Claude models reject that as prefill (400).
{
  const vm = require('node:vm');
  const body = /function\s+retryLast\s*\(\s*\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(src)[0];
  const sent = [];
  const history = [
    { role: 'user', content: 'earlier request', sourceRunId: 'r0' },
    { role: 'assistant', content: 'earlier answer', sourceRunId: 'r0' },
    { role: 'user', content: 'write Etsy listings', sourceRunId: 'r1' },
    { role: 'assistant', content: 'Good pivot — pure drafting.', sourceRunId: 'r1' },
    { role: 'assistant', content: 'The tool needs the required objective field.', sourceRunId: 'r1' },
    { role: 'assistant', content: 'The gate needs brief_proceed to succeed first.', sourceRunId: 'r1' },
    { role: 'assistant', content: '⚠ Something went wrong on that turn — try again.', error: true }
  ];
  const ctx = { activeWs: { runIds: ['r1'], history }, isBusy: () => false, localLine: () => {}, load: () => {}, afterHydration: () => false, send: (text, opts) => sent.push({ text, opts, tail: history[history.length - 1].role }) };
  vm.createContext(ctx); vm.runInContext(body + '; retryLast();', ctx);
  A.eq(sent.length, 1, 'retry sends exactly once');
  A.eq(sent[0].text, 'write Etsy listings', 'retry re-runs the last user turn');
  A.eq(sent[0].tail, 'user', 'the retried history ends on the user turn, never on an assistant message (prefill 400)');
  A.eq(history.length, 3, 'every row of the failed attempt is dropped; the earlier exchange is kept');
  A.eq(history[1].content, 'earlier answer', 'earlier assistant replies before the retried turn survive');
  const stoppedCtx = { activeWs: { runIds: ['s'], history: [{ role: 'user', content: 'go', sourceRunId: 's' }, { role: 'assistant', content: 'partial', stopped: true }] }, isBusy: () => false, localLine: () => {}, load: () => {}, afterHydration: () => false, send: () => {} };
  vm.createContext(stoppedCtx); vm.runInContext(body + '; retryLast();', stoppedCtx);
  A.eq(stoppedCtx.activeWs.history.length, 1, 'retryLast discards a stopped partial assistant tail before re-running');
  // …but load() re-syncs from the server transcript and can put the replaced replies back before send() builds the
  // request (re-proven live 2026-09-28: /retry still sent [user, assistant] and got the prefill 400). The WIRE is cut too.
  const cut = A.fnBody(src, 'function endOnUserTurn(');
  A.ok(cut, 'endOnUserTurn exists');
  const wctx = { HistoryFit: require('../frontend/app/historyfit.js') }; vm.createContext(wctx); vm.runInContext(cut + '; this.f = endOnUserTurn;', wctx);
  const wire = wctx.f([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }, { role: 'assistant', content: 'e' }]);
  A.eq(wire.map(m => m.content).join(''), 'abc', 'the retry wire ends on the last user turn');
  A.eq(wctx.f([{ role: 'assistant', content: 'x' }]).length, 1, 'no user turn -> untouched');
  const send = A.fnBody(src, 'async function send(text, opts) {');
  A.ok(send.indexOf('const plan = HistoryFit.sendPlan(') > send.indexOf('await ensureHistoryReady(') && /messages:\s*plan\.messages/.test(send), 'send() uses its shared plan after the history re-sync');
  const retryPlan = wctx.HistoryFit.sendPlan([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { retry: true, historyRead: {}, model: { limit: 0, window: 'legacy' } });
  A.eq(retryPlan.messages.map(m => m.content), ['a'], 'the production plan drops a reloaded failed attempt before posting the retry');
}
A.ok(/send\s*\(\s*text\s*,\s*\{\s*retry:\s*true\s*,\s*retryUserRunId:/.test(retryFn[1]),
  'Try again uses the existing no-duplicate retry send path');

// Reload/switch reconstructs the same recovery affordance from durable history once the stream is idle.
A.ok(/lastReal\s*&&\s*lastReal\.role\s*===\s*'assistant'\s*&&\s*\(lastReal\.error\s*\|\|\s*lastReal\.stopped\)\s*&&\s*!isBusy\(\)[\s\S]{0,120}?offerTryAgain\s*\(\s*\)/.test(src),
  'a stopped trailing turn restores Try again after reload without offering it while busy');
const renderStart = src.indexOf('function renderHistory');
const stoppedMarker = src.indexOf('m.stopped', renderStart);
const assistantRow = src.indexOf("const r = row('agent'", renderStart);
A.ok(stoppedMarker > renderStart && stoppedMarker < assistantRow,
  'renderHistory recognizes a zero-token stopped marker before skipping empty assistant prose');

// The shared action itself remains guarded by retryLast's disabled-state rule. The two guards were SPLIT so
// each can say why nothing happened (a silently-inert command reads as a broken app) — what must hold is that
// both still return BEFORE any send, which is what "inert" actually means here.
A.ok(/function\s+retryLast[\s\S]*?if\s*\(\s*!activeWs\s*\)\s*return[\s\S]*?if\s*\(\s*isBusy\(\)\s*\)\s*return/.test(src),
  'Try again is inert without an active idle stream (both guards return before any send)');
{
  const guards = /function\s+retryLast\s*\(\s*\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(src);
  const body = guards ? guards[1] : '';
  const firstSend = body.indexOf('send(text');
  const busyGuard = body.indexOf('if (isBusy())');
  A.ok(firstSend > 0 && busyGuard > 0 && busyGuard < firstSend, 'the busy guard precedes the retry send');
}

// The run reference stays on the original user turn across repeated retries.
{
  const vm = require('node:vm');
  const body = /function\s+retryLast\s*\(\s*\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(src)[0];
  const sent = [];
  const context = { activeWs: { runIds: ['latest-attempt'], history: [
    { role: 'user', content: 'same request', sourceRunId: 'original-user-run' },
    { role: 'assistant', content: 'failed', error: true }
  ] }, isBusy: () => false, localLine: () => {}, load: () => {}, afterHydration: () => false, send: (text, opts) => sent.push({ text, opts }) };
  vm.createContext(context); vm.runInContext(body + '; retryLast();', context);
  A.eq(sent[0].opts.retryUserRunId, 'original-user-run', 'retry references the original user run, not the latest retry attempt');
  delete context.activeWs.history[0].sourceRunId;
  vm.runInContext('retryLast();', context);
  A.eq(sent[1].opts.retryUserRunId, 'latest-attempt', 'legacy local history falls back to its confirmed last run');
}
A.report('chat-stopped-retry.test');
