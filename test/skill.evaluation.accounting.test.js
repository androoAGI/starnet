'use strict';
const { readSidecarSource } = require('./helpers/source');
const assert = require('node:assert/strict');
const { makeAgentLoopCaseRunner } = require('../sidecar/skill-evaluation-runner.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const { makeEvaluationAccounting } = require('../sidecar/skill-evaluation-accounting.js');
const fs = require('node:fs');
const path = require('node:path');
const usage = { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.01 } };
const text = { type: 'text', delta: '{"answer":42}' };
const done = { type: 'done', finishReason: 'stop' };
const task = { id: 'accounting', prompt: 'Return only JSON {"answer":42}.' };
async function execute(stream, signal, options = {}) {
  let result, count = 0;
  const provider = { async *stream(request) { count++; assert.equal(request.preStreamRetries, 0); yield* stream(request, count); }, contextLimit: () => 8000 };
  const runner = makeAgentLoopCaseRunner({ provider, model: 'scripted/accounting', runIdPrefix: 'stream-accounting', clock: { now: () => 1 },
    cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), limits: { maxIters: 2, grace: false, continueGuard: false, emptyRetry: false },
    ...options, beforeRun: options.beforeRun || (async () => true), onRun: async row => { result = row.result; if (options.onRun) await options.onRun(row); } });
  const observation = await runner({ task, skill: null, phase: 'after', signal });
  return { result, count, observation };
}
// A two-turn tool loop (read, then answer) on a model nothing can price, wired through the host's real
// evaluation accounting and ledger, as index.js wires it.
async function evaluateUnpriced(unmetered, script, signal) {
  const pending = new Map(), rows = [], marked = [], receipts = [];
  const io = { readAll: () => rows.slice(), unsettled: () => [...pending.values()], beginRun: r => { receipts.push(r.runId); pending.set(r.runId, r); }, finishRun: e => pending.delete(e.runId), append: e => rows.push(e) };
  const ledger = makeLedger({ io, clock: { now: () => 1 } });
  const accounting = makeEvaluationAccounting({ ledger: Object.assign({}, ledger, { markUnsettled: runId => { marked.push(runId); return ledger.markUnsettled(runId); } }),
    agentId: 'owner', provider: unmetered ? 'ollama' : 'custom', model: 'local/unpriced', unmetered });
  let count = 0, result, error = null, observation;
  const provider = { async *stream() { count++; yield* script(count); }, contextLimit: () => 8000 };
  const runner = makeAgentLoopCaseRunner({ provider, model: 'local/unpriced', runIdPrefix: 'unpriced-' + (unmetered ? 'free' : 'metered'), clock: { now: () => 1 },
    cost: makeCostEngine({ priceOf: () => null }), unmetered, limits: { maxIters: 3, grace: false, continueGuard: false, emptyRetry: false },
    beforeRun: accounting.beforeRun, onStream: accounting.onStream, onRun: async row => { result = row.result; return accounting.onRun(row); } });
  const unpricedTask = { id: 'unpriced', prompt: 'Read input.json, then return only JSON {"answer":42}.', fixtures: { 'input.json': '{"answer":42}' } };
  try { observation = await runner({ task: unpricedTask, skill: null, phase: 'after', signal }); } catch (e) { error = e; }
  const strict = makeBudget({ ledger, caps: { day: 1 }, clock: { now: () => 1 } });
  return { count, result, error, observation, marked, rows, receipts, ledger, admission: strict.check(null, 'owner', 0) };
}
async function* readThenAnswer(attempt) {
  const freeUsage = { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 4 } };   // Ollama: tokens, no price
  if (attempt === 1) {
    yield { type: 'tool_start', index: 0, id: 'read', name: 'fs_read' };
    yield { type: 'tool_args', index: 0, chunk: '{"path":"input.json"}' };
    yield freeUsage; yield { type: 'done', finishReason: 'tool_calls' };
  } else { yield text; yield freeUsage; yield done; }
}
async function main() {
  // UNMETERED (Ollama, OAuth subscriptions): a complete attempt nothing could price is known $0, as runOnce books it.
  const free = await evaluateUnpriced(true, readThenAnswer);
  assert.equal(free.error, null, 'an unmetered evaluation run settles: ' + (free.error && free.error.message));
  assert.equal(free.count, 2, 'the tool loop second turn on an unmetered provider is not refused');
  assert.equal(free.result.reason, 'done');
  assert.equal(free.result.accountingIncomplete, false);
  assert.deepEqual(free.observation.value, { answer: 42 });
  assert.deepEqual(free.marked, [], 'a free local call never leaves an unsettled spend receipt');
  assert.equal(free.rows.length, 1); assert.equal(free.rows[0].unmetered, true); assert.equal(free.rows[0].usd, 0);
  assert.equal(free.ledger.health().complete, true);
  assert.equal(free.admission, null, 'paid dispatch under a strict cap is not blocked by a free evaluation');
  assert.deepEqual(free.receipts, [], 'an unmetered run leaves no dispatch receipt, as runOnce skips it');
  // An unfinished attempt on an unmetered provider is still known $0: nothing is billed per call there.
  const freeBroken = await evaluateUnpriced(true, async function* () { yield text; throw new Error('connection reset after partial output'); });
  assert.equal(freeBroken.error, null, 'a failed free call is not unknown spend: ' + (freeBroken.error && freeBroken.error.message));
  assert.notEqual(freeBroken.observation.reason, 'done');
  assert.deepEqual(freeBroken.marked, []); assert.equal(freeBroken.ledger.unsettledRuns().length, 0);
  assert.deepEqual(freeBroken.receipts, []);
  assert.equal(freeBroken.rows.length, 1); assert.equal(freeBroken.rows[0].unmetered, true); assert.equal(freeBroken.rows[0].usd, 0);
  assert.equal(freeBroken.admission, null, 'a failed free evaluation never blocks paid runs under a strict cap');
  // A cold local model aborted mid-stream (the 120 s evaluation timer, or the dialog closed) is still $0.
  const stop = new AbortController();
  const freeAborted = await evaluateUnpriced(true, async function* () { yield text; stop.abort(); yield { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 4 } }; yield done; }, stop.signal);
  assert.equal(freeAborted.error, null, 'an aborted free evaluation settles: ' + (freeAborted.error && freeAborted.error.message));
  assert.equal(freeAborted.observation.reason, 'cancelled');
  assert.deepEqual(freeAborted.marked, []); assert.equal(freeAborted.ledger.unsettledRuns().length, 0);
  assert.equal(freeAborted.ledger.health().readError, null);
  assert.equal(freeAborted.rows.length, 1); assert.equal(freeAborted.rows[0].unmetered, true); assert.equal(freeAborted.rows[0].usd, 0);
  assert.equal(freeAborted.admission, null, 'an aborted free evaluation never blocks paid runs under a strict cap');
  // METERED but unpriced usage stays unknown: no second paid attempt, receipt left for the Commander to settle.
  const meteredUnpriced = await evaluateUnpriced(false, readThenAnswer);
  assert.equal(meteredUnpriced.count, 1, 'unknown metered spend refuses the next paid attempt');
  assert.match(String(meteredUnpriced.error && meteredUnpriced.error.message), /incomplete/);
  assert.ok(meteredUnpriced.marked.length > 0); assert.equal(meteredUnpriced.ledger.unsettledRuns().length, 1);
  assert.equal(meteredUnpriced.rows.length, 0);
  assert.equal(meteredUnpriced.admission.code, 'spend_history_unavailable');
  // The host must pass the provider's unmetered flag to the runner too, or the second free turn is refused again.
  const host = readSidecarSource();
  const wiring = host.slice(host.indexOf('async function handleSkillCandidateAction'));
  assert.match(wiring.slice(0, wiring.indexOf('/* -------')), /makeAgentLoopCaseRunner\(\{[^}]*\bunmetered\b/, 'the evaluation runner receives unmetered');
  const good = await execute(async function* () { yield text; yield usage; yield done; });
  assert.equal(good.result.reason, 'done');
  assert.equal(good.result.accountingIncomplete, false);
  assert.equal(good.result.accountingStreams.complete, 1);
  const missing = await execute(async function* () { yield text; yield done; });
  assert.equal(missing.result.reason, 'done');
  assert.equal(missing.result.accountingIncomplete, true, 'a clean answer without usage cannot settle as zero');
  const emptyUsage = await execute(async function* () { yield text; yield { type: 'usage', usage: {} }; yield done; });
  assert.equal(emptyUsage.result.accountingIncomplete, true);
  const invalidFinal = await execute(async function* () { yield text; yield usage; yield { type: 'usage', usage: {} }; yield done; });
  assert.equal(invalidFinal.result.accountingIncomplete, true, 'earlier valid usage cannot authorize a malformed final snapshot');
  const shared = makeBudget({ ledger: makeLedger(), caps: { day: 0.005 }, clock: { now: () => 1 } });
  let concurrentAdmission;
  await execute(async function* () {
    yield usage;
    concurrentAdmission = shared.check('another-run', 'another-agent', 0);
    yield text; yield done;
  }, undefined, { onStream: ({ runId, spentUsd }) => shared.noteLive(runId, spentUsd) });
  assert.equal(concurrentAdmission.scope, 'day', 'observed usage blocks concurrent paid entry before the current stream ends');
  const broken = await execute(async function* () { yield text; throw new Error('invalid request after partial output'); });
  assert.equal(broken.result.accountingIncomplete, true);
  assert.equal(broken.result.accountingStreams.uncertain[0].errored, true);
  const controller = new AbortController();
  const cancelled = await execute(async function* () { yield text; controller.abort(); yield usage; yield done; }, controller.signal);
  assert.equal(cancelled.result.accountingIncomplete, true);
  assert.equal(cancelled.result.accountingStreams.uncertain[0].aborted, true);
  const retry = await execute(async function* (_, attempt) {
    yield text;
    if (attempt === 1) { const error = new Error('temporary connection reset'); error.code = 'ECONNRESET'; throw error; }
    yield usage; yield done;
  });
  assert.equal(retry.count, 1, 'unknown spend prevents the loop from dispatching another paid retry');
  assert.equal(retry.result.reason, 'policy-denied');
  assert.equal(retry.result.accountingIncomplete, true, 'unknown first-attempt spend stays unsettled');
  assert.ok(retry.result.accountingStreams.uncertain.some(row => row.attempt === 1 && !row.usageObserved));
  const length = await execute(async function* (_, attempt) { yield text; yield usage; yield { type: 'done', finishReason: attempt === 1 ? 'length' : 'stop' }; });
  assert.equal(length.result.accountingIncomplete, false, 'output length stop with complete usage is accounted');
  const entries = [], observed = [];
  const capped = await execute(async function* () {
    yield { type: 'tool_start', index: 0, id: 'read', name: 'fs_read' };
    yield { type: 'tool_args', index: 0, chunk: '{"path":"input.json"}' };
    yield usage; yield { type: 'done', finishReason: 'tool_calls' };
  }, undefined, {
    beforeStream: async ({ spentUsd }) => { entries.push(spentUsd); return spentUsd < 0.005; },
    onStream: async row => { observed.push(row); }
  });
  assert.deepEqual(entries, [0, 0.01], 'spending guard sees reconciled cost before each actual provider entry');
  assert.equal(capped.count, 1, 'policy stops the second tool-loop call');
  assert.equal(capped.result.reason, 'policy-denied');
  assert.equal(capped.result.accountingIncomplete, false, 'known charge is still safe to settle');
  assert.equal(capped.result.usd, 0.01);
  assert.equal(observed[0].spentUsd, 0.01);
  // A METERED, priced run cancelled BETWEEN provider calls (the evaluation timer fired during a tool step): every
  // attempt finished and was priced, so its spend is known. It is booked, not left as an unsettled receipt.
  {
    const pending = new Map(), rows = [], marked = [];
    const io = { readAll: () => rows.slice(), unsettled: () => [...pending.values()], beginRun: r => pending.set(r.runId, r), finishRun: e => pending.delete(e.runId), append: e => rows.push(e) };
    const ledger = makeLedger({ io, clock: { now: () => 1 } });
    const accounting = makeEvaluationAccounting({ ledger: Object.assign({}, ledger, { markUnsettled: runId => { marked.push(runId); return ledger.markUnsettled(runId); } }),
      agentId: 'owner', provider: 'openrouter', model: 'scripted/accounting' });
    const stop = new AbortController();
    let count = 0, result, error = null;
    const provider = { async *stream() { count++; yield { type: 'tool_start', index: 0, id: 'read', name: 'fs_read' }; yield { type: 'tool_args', index: 0, chunk: '{"path":"input.json"}' }; yield usage; yield { type: 'done', finishReason: 'tool_calls' }; }, contextLimit: () => 8000 };
    const runner = makeAgentLoopCaseRunner({ provider, model: 'scripted/accounting', runIdPrefix: 'between-calls', clock: { now: () => 1 },
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), limits: { maxIters: 3, grace: false, continueGuard: false, emptyRetry: false },
      emit: (name) => { if (name === 'agent.tool_result') stop.abort(); },
      beforeRun: accounting.beforeRun, onStream: accounting.onStream, onRun: async row => { result = row.result; return accounting.onRun(row); } });
    try { await runner({ task: { id: 'between', prompt: 'Read input.json.', fixtures: { 'input.json': '{}' } }, skill: null, phase: 'after', signal: stop.signal }); } catch (e) { error = e; }
    assert.equal(count, 1, 'the cancel lands before a second provider call');
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.accountingIncomplete, false, 'the one finished, priced attempt is fully accounted');
    assert.equal(error, null, 'a known charge settles on cancel: ' + (error && error.message));
    assert.deepEqual(marked, [], 'no unsettled receipt is left for a charge the runner priced');
    assert.equal(ledger.unsettledRuns().length, 0);
    assert.equal(rows.length, 1); assert.equal(rows[0].usd, 0.01);
    assert.equal(ledger.health().complete, true);
  }
  // EVALUATION LIMITS ARE SIZED, NOT FIXED (skills-eval-06): a fixed 120 s clock and $0.08 per run stopped every
  // evaluation on a slow reasoning model or a premium-priced one. The wall clock grows with the suite and each run
  // gets the Commander's per-run cap.
  {
    const { evaluationLimits } = require('../sidecar/skill-evaluation-runner.js');
    assert.equal(typeof evaluationLimits, 'function', 'the runner exports its sizing rule');
    const two = evaluationLimits({ cases: 2, runCapUsd: 1 });
    assert.equal(two.runs, 4, 'every case runs once without and once with the proposal');
    assert.ok(two.wallClockMs >= 4 * 90000, 'four ~15 s x 6-call runs fit the clock (' + two.wallClockMs + ' ms)');
    assert.equal(two.perRunUsd, 1, 'a run gets the Commander\'s per-run cap');
    assert.equal(two.totalUsd, 4, 'the whole evaluation is bounded by runs x that cap');
    assert.equal(evaluationLimits({ cases: 12, runCapUsd: 1 }).wallClockMs, 20 * 60000, 'the clock never passes 20 minutes');
    assert.equal(evaluationLimits({ cases: 1 }).wallClockMs, 180000);
    assert.equal(evaluationLimits({}).perRunUsd, 0.08, 'no host cap keeps the old per-run default');
    assert.equal(evaluationLimits({ cases: 2, runCapUsd: -1 }).perRunUsd, 0.08, 'a nonsense cap is ignored');
    // A premium model: each provider call costs $0.10. Under the old fixed $0.08 a tool step plus the answer was
    // refused mid-run; under the Commander's $1 run cap the run finishes and books both calls.
    const premium = { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.10 } };
    const script = (_request, n) => n === 1
      ? (async function* () { yield { type: 'tool_start', index: 0, id: 'read', name: 'fs_read' }; yield { type: 'tool_args', index: 0, chunk: '{"path":"input.json"}' }; yield premium; yield { type: 'done', finishReason: 'tool_calls' }; })()
      : (async function* () { yield text; yield premium; yield done; })();
    const runPremium = async limits => {
      let result;
      const provider = { async *stream(request) { yield* script(request, ++runPremium.count); }, contextLimit: () => 8000 };
      runPremium.count = 0;
      const runner = makeAgentLoopCaseRunner({ provider, model: 'scripted/premium', runIdPrefix: 'premium', clock: { now: () => 1 },
        cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), limits: Object.assign({ maxIters: 3, grace: false, continueGuard: false, emptyRetry: false }, limits),
        beforeRun: async () => true, onRun: async row => { result = row.result; } });
      const observation = await runner({ task: { id: 'premium', prompt: 'Read input.json, then return only JSON {"answer":42}.', fixtures: { 'input.json': '{"answer":42}' } }, skill: null, phase: 'after' });
      return { observation, result };
    };
    assert.equal((await runPremium({ maxCostUsd: 0.08 })).observation.reason, 'budget', 'the old fixed cap stops the premium run after its first call');
    const sized = await runPremium({ maxCostUsd: evaluationLimits({ cases: 2, runCapUsd: 1 }).perRunUsd });
    assert.equal(sized.observation.reason, 'done', 'the sized cap lets the premium run finish');
    assert.ok(Math.abs(sized.result.usd - 0.20) < 1e-9 && sized.result.accountingIncomplete === false, 'both calls are booked as known spend');
  }
  // The runner owns the skill-eval- namespace: a host prefix that already carries it is not doubled in the run ids
  // SPENDING LIMITS and the ledger show (skills-eval-20).
  {
    const ids = [];
    const provider = { async *stream() { yield text; yield usage; yield done; }, contextLimit: () => 8000 };
    for (const runIdPrefix of ['skill-eval-3f2a', '3f2a']) {
      const runner = makeAgentLoopCaseRunner({ provider, model: 'scripted/accounting', runIdPrefix, clock: { now: () => 1 },
        cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), limits: { maxIters: 2, grace: false, continueGuard: false, emptyRetry: false },
        beforeRun: async row => { ids.push(row.runId); return true; } });
      await runner({ task, skill: null, phase: 'before' });
    }
    assert.ok(ids.every(id => /^skill-eval-3f2a-1-before-[a-f0-9]{12}$/.test(id)), 'one skill-eval- namespace per run id: ' + ids.join(', '));
  }
  // Unmetered (Ollama/subscription): token-only usage has no price, and that is $0, not unknown spend. The tool
  // loop's next call proceeds; a metered provider with the same unpriced usage still refuses it.
  const unpricedUsage = { type: 'usage', usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 } };
  const toolTurn = async function* (_, attempt) {
    if (attempt === 1) { yield { type: 'tool_start', index: 0, id: 'read', name: 'fs_read' }; yield { type: 'tool_args', index: 0, chunk: '{"path":"input.json"}' }; yield unpricedUsage; yield { type: 'done', finishReason: 'tool_calls' }; return; }
    yield text; yield unpricedUsage; yield done;
  };
  const unpriced = { cost: makeCostEngine({ priceOf: () => null }) };
  const local = await execute(toolTurn, undefined, { ...unpriced, beforeRun: async () => ({ ok: true, unmetered: true }) });
  assert.equal(local.count, 2, 'unmetered unpriced usage does not refuse the next tool-loop call');
  assert.notEqual(local.result.reason, 'policy-denied', 'no spending refusal on an unmetered provider');
  assert.equal(local.result.accountingIncomplete, false, 'an unmetered run settles at $0, never unknown');
  const meteredUnpricedLoop = await execute(toolTurn, undefined, unpriced);
  assert.equal(meteredUnpricedLoop.count, 1, 'metered unpriced usage still refuses another paid attempt');
  assert.equal(meteredUnpricedLoop.result.reason, 'policy-denied');
  assert.equal(meteredUnpricedLoop.result.accountingIncomplete, true, 'metered unpriced usage stays unsettled');
  // The accounting's own callbacks, wired as the run host wires them, under a strict station cap.
  for (const unmetered of [true, false]) {
    const pending = new Map(), rows = [];
    const io = { readAll: () => rows.slice(), unsettled: () => [...pending.values()], beginRun: r => pending.set(r.runId, r), finishRun: e => pending.delete(e.runId), append: e => rows.push(e) };
    const ledger = makeLedger({ io, clock: { now: () => 1 } }), strict = makeBudget({ ledger, caps: { day: 5 }, clock: { now: () => 1 } });
    const accounting = makeEvaluationAccounting({ ledger, budget: strict, agentId: 'owner', provider: unmetered ? 'ollama' : 'custom', model: 'scripted/accounting', unmetered });
    let thrown = null;
    try { await execute(toolTurn, undefined, { ...unpriced, beforeRun: accounting.beforeRun, onStream: accounting.onStream, onRun: accounting.onRun }); }
    catch (error) { thrown = error; }
    if (unmetered) {
      assert.equal(thrown, null, 'an unmetered case settles instead of throwing');
      assert.equal(ledger.health().complete, true, 'no unsettled receipt from an unmetered evaluation');
      assert.equal(strict.check('another-run', 'another-agent', 0), null, 'station spend stays governable');
      assert.equal(accounting.canContinue(), true, 'later cases can still run');
    } else {
      assert.match(String(thrown && thrown.message), /incomplete/, 'metered unpriced spend still fails closed');
      assert.equal(ledger.health().readError, 'UNSETTLED_SPEND');
    }
  }
  console.log('skill.evaluation.accounting: unmetered $0 (host flag and dispatch admission), metered unpriced, real loop usage, empty usage, partial throw, cancellation, known-spend cancel between calls, sized limits, run-id namespace, retry uncertainty and billed length stop PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
