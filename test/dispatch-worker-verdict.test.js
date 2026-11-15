/* node test/dispatch-worker-verdict.test.js — DELEGATION ROWS SAY WHAT HAPPENED (ops-1115 T5, W1).

   A worker that started and then failed (a rate limit, a sign-in, a spend cap, a step limit) came back as a row with no
   cause: markWorkerOutcome copied failureCode only for refusals. A later worker in a sequential dispatch was handed
   nothing about it (earlierHandoff kept only 'done' and 'timeout' rows) and built on missing input. A worker refused at
   a full gate was retried only after every wave, so the worker that depended on it ran first. The summary said "K done".
   Locked here with makeOrchestrationTools and the run host's own receipt function (sidecar/run-table.js refuseRun):
     1. a started-then-failed worker's row: status 'failed', its failureCode, transient flag and a one-sentence why;
        the summary counts it; the next worker is told it FAILED and is handed none of its text;
     2. a sequential transient refusal is retried at once, before the worker after it, and at most once;
     3. a failed row's text says UNFINISHED and keeps the worker's narration; the Commander's delivery keeps the narration.
   Liveness: an all-ok dispatch keeps its rows (plus status) and summary; cut_short and timeout hand-off blocks are
   unchanged; a parallel refusal is still retried at the end; no path sets isError; team.spawn and team.resume rows carry
   the same fields.
   Completion (wave 4), red at 2ac09529b:
     4. a stop is never a failure: a worker that ended cancelled (its own run stopped, its dispatch stopped, stopped while queued, a
        host stop on a clone: parent cancelled or the liveness check) reads status 'stopped', counted apart ("1 stopped"), with
        words that say what stopped it, and its dependant is told it STOPPED;
     2. (review N1) a sequential inline retry refused again keeps the end-of-dispatch retry (the later window); the last worker
        keeps the base's single end retry;
     5. (review N3) an error with no transient flag leaves transient unknown (omitted), never false;
     6. a background clone that started and failed keeps its failureCode on the ledger (and so the subagent_stop hook's code);
     7. (review N4, a lock) the UNFINISHED ledger text where it lands: team.subagents, subagent_stop child_summary, the card's tip.
   Red at 45e7ee302 (and 8e09831f6). DISPATCH_VERDICT_CONTROL=<tree root> runs the same cases against another tree. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.DISPATCH_VERDICT_CONTROL ? path.resolve(process.env.DISPATCH_VERDICT_CONTROL) : path.join(__dirname, '..');
const { refuseRun } = require(path.join(ROOT, 'sidecar/run-table.js'));
const { makeOrchestrationTools } = require(path.join(ROOT, 'sidecar/tools/builtin/orchestration.js'));
const { makeSubagentManager } = require(path.join(ROOT, 'sidecar/subagents.js'));

const crew = new Map([['researcher', { system: 'R', name: 'RESEARCHER', model: 'm' }], ['writer', { system: 'W', name: 'WRITER', model: 'm' }]]);
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const say = t => [{ role: 'assistant', content: t }];
const CAP = 'Too many agents are working at once (limit 3). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.';
const RATE = 'Rate limited by the provider: slow down and try again in 20 seconds.';
const NARRATION = 'I checked alpha and beta so far';

// the run host's refusal: one balanced receipt on the run's own emit, then nothing (runOnceCore `refuse(...); return;`)
const refuse = (o, r) => { refuseRun(o.emit, { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' }, r); return undefined; };
// a run that started, worked, and then failed on its provider: the loop emits its error and ends 'error' (loop.js end('error'))
const failsAfterStart = (o) => {
  o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
  o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: RATE, failureCode: 'rate_limit', transient: true });
  o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', failureCode: 'rate_limit' });
  return { reason: 'error', failureCode: 'rate_limit', messages: say(NARRATION), usd: 0.01, toolsOk: 2 };
};
const answers = (o) => ({ reason: 'done', messages: say('out:' + o.agentId), usd: 0 });
const openingOf = o => { const m = (o && o.messages) || []; const last = m[m.length - 1]; return last ? String(last.content) : ''; };

async function dispatch(impl, args, extra, ctxExtra) {
  const calls = [];
  const runOnce = async (o) => { calls.push(o); return impl(o, calls.length, calls); };
  const tools = makeOrchestrationTools(Object.assign({ runOnce, roster: () => crew, key: 'k', model: 'm', newId: counter() }, extra));
  const res = await tools.dispatchTool.run(Object.assign({ workers: [{ agentId: 'researcher', prompt: 'find three launch emails' }, { agentId: 'writer', prompt: 'draft ours from them' }] }, args), Object.assign({ agentId: 'lead', emit: () => {} }, ctxExtra));
  let rows = [];
  try { rows = JSON.parse(res.content); } catch (_) { rows = []; }
  return { res, rows, calls, order: calls.map(o => o.agentId) };
}

(async () => {
  const results = [];

  // ---- 1. a started-then-failed worker: its cause, the summary's count, and the next worker is told ------------------------
  {
    const { res, rows, calls, order } = await dispatch((o) => o.agentId === 'researcher' ? failsAfterStart(o) : answers(o));
    results.push(res);
    const w1 = rows[0] || {};
    A.eq([w1.status, w1.failureCode, w1.transient], ['failed', 'rate_limit', true], '(1) the failed worker\'s row names its status, code and transient flag');
    A.ok(typeof w1.why === 'string' && w1.why.startsWith('Rate limited by the provider') && w1.why.length <= 200, '(1) and one sentence of why: ' + w1.why);
    A.ok(/^dispatched 2 worker\(s\), 1 done, 1 failed/.test(String(res.summary)), '(1) the summary keeps its prefix and counts the failure: ' + res.summary);
    A.eq(order, ['researcher', 'writer'], '(1) a worker that started work is never auto-retried');
    const opening = openingOf(calls[1]);
    A.ok(/— RESEARCHER \(FAILED — Rate limited by the provider[^)]*\): it handed on nothing; do not assume its output exists\./.test(opening), '(1) the next worker is told the earlier one FAILED and why: ' + opening.slice(0, 400));
    A.ok(opening.indexOf(NARRATION) < 0, '(1) and is handed none of its text');
    A.eq((rows[1] || {}).status, 'done', '(1) the worker after it ran and is done');
  }

  // ---- 1b + 3. the result's own failureCode (no receipt), and a failed row's text: UNFINISHED, narration kept ---------------
  {
    const envelopes = [];
    const { res, rows } = await dispatch(() => ({ reason: 'error', failureCode: 'quota_exhausted', messages: say(NARRATION), usd: 0 }),
      { workers: [{ agentId: 'researcher', prompt: 'look into it' }] },
      { runRecord: () => ({ agentId: 'researcher' }), finalizeDispatchDelivery: async (runId, env) => { envelopes.push(env); } });
    results.push(res);
    const row = rows[0] || {};
    A.eq([row.status, row.failureCode], ['failed', 'quota_exhausted'], '(1b) the code the run returned rides the row with no receipt');
    A.eq(row.why, 'failed (quota_exhausted)', '(1b) with the outcome line as its why');
    A.ok(String(row.result).startsWith('UNFINISHED (failed (quota_exhausted)). Last message before it stopped: '), '(3) a failed row\'s text says UNFINISHED and why: ' + row.result);
    A.ok(String(row.result).indexOf(NARRATION) > 0, '(3) and still carries the narration');
    A.ok(envelopes.length === 1 && envelopes[0].text === NARRATION, '(3) the Commander\'s delivery keeps the worker\'s own words: ' + JSON.stringify(envelopes));
  }

  // ---- 2. a sequential transient refusal is retried at once, before its dependant ------------------------------------------
  {
    const { res, rows, calls, order } = await dispatch((o, n) => (o.agentId === 'researcher' && n === 1) ? refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }) : answers(o));
    results.push(res);
    A.eq(order, ['researcher', 'researcher', 'writer'], '(2) the refused worker is retried before the worker after it');
    A.ok(openingOf(calls[2]).indexOf('out:researcher') >= 0, '(2) and the dependant is handed the retry\'s work');
    A.eq([(rows[0] || {}).status, (rows[1] || {}).status], ['done', 'done'], '(2) both rows are done');
    A.eq(res.summary, 'dispatched 2 worker(s), 2 done', '(2) the summary of a dispatch that ended clean');
  }
  // completion (wave 4, review N1): an inline retry that meets the same full gate keeps the end-of-dispatch retry the base gave it,
  // so a gate that stays full while the inline retry runs no longer costs the worker its later free-slot chance
  {
    const { res, rows, calls, order } = await dispatch((o) => o.agentId === 'researcher' ? refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }) : answers(o));
    results.push(res);
    A.eq(order, ['researcher', 'researcher', 'writer', 'researcher'], '(2) refused again inline, it is retried before its dependant and once more at the end (order ' + order.join(',') + ')');
    const w1 = rows[0] || {};
    A.ok(w1.reason === 'refused' && w1.retried === true && w1.status === 'refused' && w1.failureCode === 'concurrency_limit' && w1.transient === true, '(2) refused again, the row says so: ' + JSON.stringify([w1.reason, w1.retried, w1.status, w1.failureCode, w1.transient]));
    A.ok(String(w1.result).startsWith('worker could not start: ' + CAP), '(2) a refusal\'s row keeps its #177 text: ' + w1.result);
    A.ok(/RESEARCHER \(FAILED — Too many agents are working at once \(limit 3\)\.\): it handed on nothing/.test(openingOf(calls[2])), '(2) the dependant is told the refused worker handed on nothing: ' + openingOf(calls[2]).slice(0, 300));
    A.ok(/^dispatched 2 worker\(s\), 1 done, 1 refused$/.test(String(res.summary)), '(2) the summary counts the refusal: ' + res.summary);
  }
  {
    // the gate is full for the first try and the inline retry, and has room by the end of the dispatch: the worker runs
    const { res, rows, order } = await dispatch((o, n) => (o.agentId === 'researcher' && n <= 2) ? refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }) : answers(o));
    results.push(res);
    A.eq(order, ['researcher', 'researcher', 'writer', 'researcher'], '(2-N1) the later window is kept after a second refusal');
    A.ok((rows[0] || {}).status === 'done' && (rows[0] || {}).result === 'out:researcher', '(2-N1) and the worker that got its free slot at the end is done: ' + JSON.stringify(rows[0]));
    A.eq(res.summary, 'dispatched 2 worker(s), 2 done', '(2-N1) the summary of a dispatch whose refused worker ran at the end');
  }
  {
    // the last (here, the only) worker has no dependant: it keeps the base's one end-of-dispatch retry (delegation-refusal-177 pins 2 calls)
    const { res, rows, order } = await dispatch((o) => refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }), { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    A.eq(order, ['researcher', 'researcher'], '(2) a lone refused worker is retried exactly once');
    A.ok((rows[0] || {}).retried === true && (rows[0] || {}).status === 'refused', '(2) and, refused again, says so');
  }
  {
    // a refusal that will come back the same is never retried, inline or at the end
    const { order } = await dispatch((o) => o.agentId === 'researcher' ? refuse(o, { message: 'Sign in again.', failureCode: 'auth', transient: false }) : answers(o));
    A.eq(order, ['researcher', 'writer'], '(2) a non-transient refusal is not retried (order ' + order.join(',') + ')');
  }

  // ---- LIVENESS: an all-ok dispatch, cut_short and timeout hand-offs, the parallel retry pass ----------------------------------
  {
    const { res, rows, calls } = await dispatch(answers);
    results.push(res);
    A.eq(res.summary, 'dispatched 2 worker(s), 2 done', 'live: an all-ok dispatch keeps its summary');
    const BASE_KEYS = ['agentId', 'reason', 'result', 'structuredResult', 'validation', 'repairRunId', 'usd', 'runId', 'model', 'reasoningEffort', 'toolsOk', 'durationMs', 'tokens'];
    A.eq(rows.map(r => Object.keys(r).filter(k => k !== 'status')), [BASE_KEYS, BASE_KEYS], 'live: its rows keep their fields, adding only status');
    A.eq(rows.map(r => [r.status, r.reason, r.result]), [['done', 'done', 'out:researcher'], ['done', 'done', 'out:writer']], 'live: status done, text unchanged');
    A.ok(/— RESEARCHER:\nout:researcher/.test(openingOf(calls[1])) && openingOf(calls[1]).indexOf('FAILED') < 0, 'live: a clean hand-off is unmarked');
  }
  {
    const { rows, calls } = await dispatch((o, n) => n === 1 ? { reason: 'done', finishReason: 'length', messages: say('half an answ'), usd: 0 } : answers(o));
    const op = openingOf(calls[1]);
    A.ok(/— RESEARCHER \(UNFINISHED — the reply was cut short\):\nhalf an answ/.test(op) && op.indexOf('FAILED') < 0, 'live: a cut worker\'s hand-off block is unchanged: ' + op.slice(0, 300));
    A.ok((rows[0] || {}).status === 'cut_short' && (rows[0] || {}).result === 'half an answ', 'live: its row is cut_short, its text not rewritten');
  }
  // fix round 1 (review): a limit, a spend cap, a question, an empty reply or a stop is never FAILED (the family law: away-briefing
  // review 8.1, linewatch review 9.3). A bounded worker hits WORKER_MAX_ITERS by design: its row is cut_short, its text is its own, the
  // summary counts no failure, and its dependant is still told it handed on nothing (that block keys on usability, not status).
  {
    const { res, rows, calls } = await dispatch((o, n) => n === 1 ? { reason: 'max_iters', messages: say(NARRATION), usd: 0, toolsOk: 3 } : answers(o));
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'cut_short' && w1.result === NARRATION, 'live: a step-limit worker is cut_short, its text not rewritten: ' + JSON.stringify([w1.status, w1.result]));
    A.ok(typeof w1.why === 'string' && w1.why.length > 0 && !('failureCode' in w1), 'live: and it says why, with no failure code: ' + JSON.stringify([w1.why, w1.failureCode]));
    A.ok(/^dispatched 2 worker\(s\), 1 done$/.test(String(res.summary)) && String(res.summary).indexOf('failed') < 0, 'live: the summary counts no failure for a limit: ' + res.summary);
    const op = openingOf(calls[1]);
    A.ok(op.indexOf('— RESEARCHER (FAILED — ' + w1.why + '): it handed on nothing') >= 0 && op.indexOf(NARRATION) < 0, 'live: its dependant is still told it handed on nothing: ' + op.slice(0, 300));
  }
  for (const reason of ['budget', 'clarifying', 'empty']) {
    const { res, rows } = await dispatch(() => ({ reason, messages: say(NARRATION), usd: 0 }), { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'cut_short' && w1.result === NARRATION, 'live: a \'' + reason + '\' worker is cut_short, its text not rewritten: ' + JSON.stringify([w1.status, w1.result]));
    A.eq(res.summary, 'dispatched 1 worker(s), 0 done', 'live: a \'' + reason + '\' worker is not counted failed');
  }

  // ---- 4. completion (wave 4): A STOP IS NEVER A FAILURE. A worker that ended cancelled reads status 'stopped' (never 'failed'), its text
  // is its own, the summary counts it apart, its why says what stopped it when that is known, and its dependant is told it STOPPED --------
  {
    // stopped with no cause the host can name (its own run was stopped from outside the dispatch)
    const { res, rows } = await dispatch(() => ({ reason: 'cancelled', messages: say(NARRATION), usd: 0 }), { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'stopped' && w1.result === NARRATION, '(4) a stopped worker reads stopped, its text not rewritten: ' + JSON.stringify([w1.status, w1.result]));
    A.eq(w1.why, 'stopped before it finished', '(4) with the stop\'s own words');
    A.eq(res.summary, 'dispatched 1 worker(s), 0 done, 1 stopped', '(4) the summary counts the stop apart, never failed');
  }
  {
    // the lead's run (the dispatch call's signal) was stopped while the worker ran
    const lead = new AbortController();
    const { res, rows } = await dispatch(() => { lead.abort(); return { reason: 'cancelled', messages: say(NARRATION), usd: 0 }; },
      { workers: [{ agentId: 'researcher', prompt: 'look into it' }] }, {}, { signal: lead.signal });
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'stopped' && w1.why === 'the dispatch that started it was stopped, so it stopped too' && w1.result === NARRATION,
      '(4) a worker its lead\'s stop ended says so: ' + JSON.stringify([w1.status, w1.why, w1.result]));
    A.ok(String(res.summary).indexOf('failed') < 0 && /, 1 stopped$/.test(String(res.summary)), '(4) and is never counted failed: ' + res.summary);
  }
  {
    // stopped while it waited for its turn in its session (the host's receipt: an end 'cancelled' with no error); never retried
    const { res, rows, calls, order } = await dispatch((o) => o.agentId === 'researcher' ? refuse(o, { reason: 'cancelled' }) : answers(o));
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.reason === 'cancelled' && w1.status === 'stopped' && /stopped while it waited for its turn/.test(w1.why), '(4) a worker stopped while queued reads stopped and says so: ' + JSON.stringify([w1.reason, w1.status, w1.why]));
    A.eq(order, ['researcher', 'writer'], '(4) a stop is never retried');
    const op = openingOf(calls[1]);
    A.ok(/— RESEARCHER \(STOPPED — [^)]*stopped while it waited for its turn[^)]*\): it handed on nothing/.test(op) && op.indexOf('FAILED') < 0, '(4) its dependant is told it STOPPED, never FAILED: ' + op.slice(0, 300));
    A.eq(res.summary, 'dispatched 2 worker(s), 1 done, 1 stopped', '(4) the summary counts it stopped');
  }

  // ---- 5. completion (wave 4, review N3): an error that carries no transient flag leaves transient unknown (omitted), never false ------
  {
    const { res, rows } = await dispatch((o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: 'The provider had a server error.', failureCode: 'server_error' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', failureCode: 'server_error' });
      return { reason: 'error', messages: say(NARRATION), usd: 0, toolsOk: 1 };
    }, { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'failed' && w1.failureCode === 'server_error' && !('transient' in w1), '(5) transient unknown is omitted: ' + JSON.stringify([w1.status, w1.failureCode, w1.transient]));
  }
  {
    const { rows } = await dispatch((o) => {
      o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: 'Sign in again.', failureCode: 'auth', transient: false });
      return { reason: 'error', messages: say(NARRATION), usd: 0, toolsOk: 1 };
    }, { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    A.ok((rows[0] || {}).transient === false, '(5) a known transient:false still rides the row: ' + JSON.stringify(rows[0]));
  }
  {
    const { res, rows } = await dispatch(() => ({ reason: 'error', messages: say(NARRATION), usd: 0 }), { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    A.ok((rows[0] || {}).status === 'failed' && String((rows[0] || {}).result).startsWith('UNFINISHED ('), 'live: an error is still failed and says UNFINISHED: ' + JSON.stringify(rows[0]));
    A.eq(res.summary, 'dispatched 1 worker(s), 0 done, 1 failed', 'live: and is counted failed');
  }
  {
    const slow = (o) => new Promise(resolve => {
      const sig = o.signal;
      const settle = () => resolve({ reason: 'cancelled', messages: say('partial draft'), usd: 0 });
      if (sig && sig.aborted) return settle();
      if (sig) sig.addEventListener('abort', settle, { once: true });
    });
    const { res, rows, calls } = await dispatch((o, n) => n === 1 ? slow(o) : answers(o), {}, { dispatchTimeoutMs: 60 });
    results.push(res);
    const op = openingOf(calls[1]);
    A.ok(/— RESEARCHER \(UNFINISHED — ran out of time\):\npartial draft/.test(op), 'live: a timed-out worker\'s hand-off block is unchanged: ' + op.slice(0, 300));
    A.ok((rows[0] || {}).reason === 'timeout' && (rows[0] || {}).status === 'timeout' && /^partial draft\n\n\[STOPPED/.test(String((rows[0] || {}).result)), 'live: a timeout row keeps its text: ' + JSON.stringify(rows[0]));
    A.ok(/^dispatched 2 worker\(s\), 1 done, 1 out of time$/.test(String(res.summary)), 'live: the timeout note stays: ' + res.summary);
  }
  {
    const { res, rows, order } = await dispatch((o, n) => (o.agentId === 'researcher' && n === 1) ? refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }) : answers(o), { parallel: true });
    results.push(res);
    A.eq(order, ['researcher', 'writer', 'researcher'], 'live: a parallel refusal is still retried at the end, after its wave');
    A.ok((rows[0] || {}).reason === 'done' && (rows[0] || {}).status === 'done', 'live: and the retry\'s work is its row');
  }
  {
    const { res, order } = await dispatch((o) => o.agentId === 'researcher' ? refuse(o, { message: 'The model "m" does not support tool calls.', failureCode: 'model_no_tools' }) : answers(o));
    results.push(res);
    A.eq(order, ['researcher', 'writer'], 'live: a refusal that will come back the same is not retried');
  }

  // ---- LIVENESS: team.spawn and team.resume rows carry the same fields --------------------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-verdict-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const spawnCalls = [];
    const { spawnTool } = makeOrchestrationTools({ runOnce: async o => { spawnCalls.push(o); return failsAfterStart(o); }, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const spawned = await spawnTool.run({ tasks: [{ prompt: 'summarize the notes' }] }, { agentId: 'lead', emit: () => {} });
    results.push(spawned);
    const srow = (JSON.parse(spawned.content) || [])[0] || {};
    A.eq([srow.status, srow.failureCode, srow.transient], ['failed', 'rate_limit', true], 'team.spawn: a failed clone\'s row names its status, code and transient flag');
    A.ok(String(srow.why).startsWith('Rate limited by the provider'), 'team.spawn: and its why: ' + srow.why);
    A.ok(String(srow.result).startsWith('UNFINISHED (Rate limited by the provider') && String(srow.result).indexOf(NARRATION) > 0, 'team.spawn: its text says UNFINISHED and keeps the narration: ' + srow.result);
    A.ok(String(spawned.summary).startsWith('spawned 1 subagent(s), 0 done'), 'team.spawn: its summary is unchanged: ' + spawned.summary);

    const okSpawn = await makeOrchestrationTools({ runOnce: async o => answers(o), roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents })
      .spawnTool.run({ tasks: [{ prompt: 'summarize the other notes' }] }, { agentId: 'lead', emit: () => {} });
    results.push(okSpawn);
    const okRow = (JSON.parse(okSpawn.content) || [])[0] || {};
    A.ok(okRow.status === 'done' && !('why' in okRow) && !('failureCode' in okRow) && okRow.result.startsWith('out:'), 'team.spawn: a clean clone\'s row adds only status: ' + JSON.stringify(okRow));

    // a background worker, then a resumed generation that starts and fails
    const bg = makeOrchestrationTools({ runOnce: async o => failsAfterStart(o), roster: () => crew, key: 'k', model: 'm', newId: counter(), subagents });
    const started = await bg.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'look into it' }], background: true }, { agentId: 'lead', runId: 'lead1', emit: () => {} });
    results.push(started);
    for (let i = 0; i < 8; i++) await tick();
    const rec = subagents.list({ agentId: 'researcher' })[0] || {};
    A.ok(rec.status === 'error' && rec.failureCode === 'rate_limit' && String(rec.result).startsWith('UNFINISHED (Rate limited'), 'background dispatch: the ledger record keeps the cause: ' + JSON.stringify([rec.status, rec.failureCode, String(rec.result).slice(0, 60)]));
    const resumed = await bg.resumeTool.run({ id: rec.id }, { agentId: 'lead', runId: 'lead2', emit: () => {} });
    results.push(resumed);
    for (let i = 0; i < 8; i++) await tick();
    const again = subagents.get(rec.id) || {};
    A.ok(again.generation > rec.generation && again.status === 'error' && again.failureCode === 'rate_limit' && String(again.result).startsWith('UNFINISHED (Rate limited by the provider') && String(again.result).indexOf(NARRATION) > 0,
      'team.resume: a resumed generation that failed keeps its status, code and cause: ' + JSON.stringify([again.generation, again.status, again.failureCode, String(again.result).slice(0, 80)]));

    // ---- 4. completion (wave 4): a clone the HOST stopped reads stopped, never failed, with the host's words ----------------------
    const waitsForStop = o => new Promise(resolve => {
      const end = () => resolve({ reason: 'cancelled', messages: say('half done'), usd: 0 });
      if (o.signal && o.signal.aborted) return end();
      if (o.signal) o.signal.addEventListener('abort', end, { once: true });
    });
    {
      const stopTools = makeOrchestrationTools({ runOnce: waitsForStop, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
      const pending = stopTools.spawnTool.run({ tasks: [{ prompt: 'summarize the stopped notes' }] }, { agentId: 'lead', runId: 'leadStop', emit: () => {} });
      for (let i = 0; i < 4; i++) await tick();
      subagents.cancelChildren('leadStop');
      const stoppedSpawn = await pending;
      results.push(stoppedSpawn);
      const row = (JSON.parse(stoppedSpawn.content) || [])[0] || {};
      A.ok(row.reason === 'cancelled' && row.status === 'stopped' && row.why === 'the run that started it was cancelled, so the host stopped it too',
        '(4) team.spawn: a clone its parent\'s cancel stopped reads stopped with the host\'s words: ' + JSON.stringify([row.reason, row.status, row.why]));
      A.ok(/^half done\n\n\[STOPPED/.test(String(row.result)), '(4) team.spawn: its text is the host-stop text, never UNFINISHED: ' + row.result);
    }
    {
      let T = 5000;
      const stallMgr = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'stall.json'), clock: { now: () => T }, emit: () => {}, newId: counter(), stallMs: 1000 });
      const stallTools = makeOrchestrationTools({ runOnce: waitsForStop, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents: stallMgr });
      const pending = stallTools.spawnTool.run({ tasks: [{ prompt: 'summarize the slow notes' }] }, { agentId: 'lead', runId: 'leadStall', emit: () => {} });
      for (let i = 0; i < 4; i++) await tick();
      T += 60000;
      stallMgr.checkStalls();
      const stalledSpawn = await pending;
      results.push(stalledSpawn);
      const row = (JSON.parse(stalledSpawn.content) || [])[0] || {};
      A.ok(row.reason === 'stalled' && row.status === 'stopped' && /^the host stopped it: it made no progress/.test(String(row.why)),
        '(4) team.spawn: a clone the liveness check stopped reads stopped, never failed: ' + JSON.stringify([row.reason, row.status, row.why]));
    }

    // ---- 6. completion (wave 4): a background clone that started and then failed keeps its cause on the ledger (failureCode) -----------
    // ---- 7. and the UNFINISHED ledger text reads sensibly where it lands: team.subagents, the subagent_stop hook, the card's hover tip ----
    {
      const hookCalls = [];
      const hooked = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'hooked.json'), clock: { now: () => 2000 }, emit: () => {}, newId: counter(),
        hooks: { invoke: (name, payload) => { hookCalls.push({ name, payload }); } } });
      const bgTools = makeOrchestrationTools({ runOnce: async o => failsAfterStart(o), roster: () => crew, key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents: hooked });
      const bgSpawn = await bgTools.spawnTool.run({ tasks: [{ prompt: 'summarize the notes later' }], background: true }, { agentId: 'lead', runId: 'leadBg', emit: () => {} });
      results.push(bgSpawn);
      for (let i = 0; i < 8; i++) await tick();
      const clone = hooked.list({ leadId: 'lead' }).find(r => String(r.agentId).startsWith('sub-')) || {};
      A.ok(clone.status === 'error' && clone.failureCode === 'rate_limit', '(6) a background clone that started and failed keeps its code on the ledger: ' + JSON.stringify([clone.status, clone.failureCode]));
      const cloneStop = hookCalls.find(c => c.name === 'subagent_stop' && c.payload.extra.subagent_id === clone.id);
      A.ok(!!cloneStop && cloneStop.payload.extra.child_failure_code === 'rate_limit' && cloneStop.payload.extra.child_outcome === 'failed',
        '(6) the subagent_stop hook names the clone\'s real cause, never run_failure: ' + JSON.stringify(cloneStop && [cloneStop.payload.extra.child_outcome, cloneStop.payload.extra.child_failure_code]));

      await bgTools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'look into it later' }], background: true }, { agentId: 'lead', runId: 'leadBg2', emit: () => {} });
      for (let i = 0; i < 8; i++) await tick();
      const worker = hooked.list({ agentId: 'researcher' })[0] || {};
      // team.subagents: the lead reads the cause first, then the worker's last words
      const listed = await bgTools.subagentsTool.run({ id: worker.id }, { agentId: 'lead', emit: () => {} });
      const seen = JSON.parse(String(listed.content).split('\n')[0] || '{}');
      A.ok(String(seen.result).startsWith('UNFINISHED (Rate limited by the provider') && String(seen.result).indexOf(NARRATION) > 0 && seen.failureCode === 'rate_limit',
        '(7) team.subagents: the lead reads the cause, then the worker\'s last words: ' + String(seen.result).slice(0, 120));
      // the subagent_stop hook: child_summary opens with the cause; child_outcome / child_failure_code agree with it
      const stop = hookCalls.find(c => c.name === 'subagent_stop' && c.payload.extra.subagent_id === worker.id);
      A.ok(!!stop && String(stop.payload.extra.child_summary).startsWith('UNFINISHED (Rate limited by the provider') && stop.payload.extra.child_outcome === 'failed' && stop.payload.extra.child_failure_code === 'rate_limit',
        '(7) subagent_stop: child_summary opens with the cause, beside its outcome and code: ' + JSON.stringify(stop && [String(stop.payload.extra.child_summary).slice(0, 60), stop.payload.extra.child_outcome, stop.payload.extra.child_failure_code]));
      // the DELEGATED card's hover tip: /api/overseer hands an error worker's ledger result as `failure` (sidecar/index.js, as sliced here)
      const Delegated = require(path.join(ROOT, 'frontend/app/delegated.js'));
      const asOverseer = Object.assign({}, worker, (worker.status === 'refused' || (worker.status === 'error' && (worker.reason === 'error' || worker.reason === 'refused'))) ? { failure: String(worker.result || '').slice(0, 400) } : {});
      const tip = Delegated.tipOf(asOverseer);
      A.ok(tip.startsWith('UNFINISHED (Rate limited by the provider: slow down and try again in 20 seconds.)') && tip.length <= 200,
        '(7) the delegated card\'s tip opens with the cause (it showed the worker\'s narration as the reason before): ' + tip);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  A.ok(results.length >= 10 && results.every(r => r && !('isError' in r)), 'no delegation path sets isError (' + results.length + ' results)');
  A.report('dispatch-worker-verdict');
})().catch(error => { A.ok(false, error.stack); A.report('dispatch-worker-verdict'); });
