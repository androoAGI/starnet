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

async function dispatch(impl, args, extra) {
  const calls = [];
  const runOnce = async (o) => { calls.push(o); return impl(o, calls.length, calls); };
  const tools = makeOrchestrationTools(Object.assign({ runOnce, roster: () => crew, key: 'k', model: 'm', newId: counter() }, extra));
  const res = await tools.dispatchTool.run(Object.assign({ workers: [{ agentId: 'researcher', prompt: 'find three launch emails' }, { agentId: 'writer', prompt: 'draft ours from them' }] }, args), { agentId: 'lead', emit: () => {} });
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
  {
    const { res, rows, calls, order } = await dispatch((o) => o.agentId === 'researcher' ? refuse(o, { message: CAP, failureCode: 'concurrency_limit', transient: true }) : answers(o));
    results.push(res);
    A.eq(order.filter(a => a === 'researcher').length, 2, '(2) exactly one retry per refused worker (order ' + order.join(',') + ')');
    A.eq(order, ['researcher', 'researcher', 'writer'], '(2) and it is retried before its dependant');
    const w1 = rows[0] || {};
    A.ok(w1.reason === 'refused' && w1.retried === true && w1.status === 'refused' && w1.failureCode === 'concurrency_limit' && w1.transient === true, '(2) refused again, the row says so: ' + JSON.stringify([w1.reason, w1.retried, w1.status, w1.failureCode, w1.transient]));
    A.ok(String(w1.result).startsWith('worker could not start: ' + CAP), '(2) a refusal\'s row keeps its #177 text: ' + w1.result);
    A.ok(/RESEARCHER \(FAILED — Too many agents are working at once \(limit 3\)\.\): it handed on nothing/.test(openingOf(calls[2])), '(2) the dependant is told the refused worker handed on nothing: ' + openingOf(calls[2]).slice(0, 300));
    A.ok(/^dispatched 2 worker\(s\), 1 done, 1 refused$/.test(String(res.summary)), '(2) the summary counts the refusal: ' + res.summary);
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
  for (const reason of ['budget', 'clarifying', 'empty', 'cancelled']) {
    const { res, rows } = await dispatch(() => ({ reason, messages: say(NARRATION), usd: 0 }), { workers: [{ agentId: 'researcher', prompt: 'look into it' }] });
    results.push(res);
    const w1 = rows[0] || {};
    A.ok(w1.status === 'cut_short' && w1.result === NARRATION, 'live: a \'' + reason + '\' worker is cut_short, its text not rewritten: ' + JSON.stringify([w1.status, w1.result]));
    A.eq(res.summary, 'dispatched 1 worker(s), 0 done', 'live: a \'' + reason + '\' worker is not counted failed');
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  A.ok(results.length >= 10 && results.every(r => r && !('isError' in r)), 'no delegation path sets isError (' + results.length + ' results)');
  A.report('dispatch-worker-verdict');
})().catch(error => { A.ok(false, error.stack); A.report('dispatch-worker-verdict'); });
