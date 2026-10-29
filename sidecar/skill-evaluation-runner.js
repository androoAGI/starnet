/* Independent behavioral suites and a provider-backed runner over an isolated,
   in-memory workspace. No host files, shell, network tools, or approval bypass. */
'use strict';
const { runAgentLoop: defaultLoop } = require('./loop.js');
const { digestSkill } = require('./skillevaluation.js');
const FileBytes = require('./skills/file-bytes.js');   // a support file is read as its bytes, whatever form it is stored in
const copy = v => JSON.parse(JSON.stringify(v));
function createArtifactWorkflowSuite(skillName) {
  const makeCase = (id, heldOut, rows, expected) => ({
    id, heldOut,
    prompt: 'Prepare a finance report from input.json. Group non-void invoices by account, sum amountCents (including negative credits), and sort account names ascending. Write report.json as {"accounts":[{"account":string,"totalCents":number}],"totalCents":number}. Read the saved report back before finishing. Do not change input.json.',
    fixtures: { 'input.json': JSON.stringify(rows) }, writablePaths: ['report.json'],
    checks: [
      { id: 'accurate-report', kind: 'artifact_json_equal', path: 'report.json', expected },
      { id: 'source-preserved', kind: 'artifact_json_equal', path: 'input.json', expected: rows },
      { id: 'verified-saved-report', kind: 'tool_call', name: 'fs.read', arguments: { path: 'report.json' }, afterLastWriteTo: 'report.json' }
    ]
  });
  return { id: 'artifact-workflow:' + skillName, skillName, version: 1,
    description: 'Accounting transformation, preservation of the source, and observed verification of the saved artifact.',
    cases: [
      makeCase('group-and-exclude-void', false, [
        { account: 'Beta', amountCents: 140, void: false }, { account: 'Alpha', amountCents: 250, void: false },
        { account: 'Beta', amountCents: 60, void: false }, { account: 'Alpha', amountCents: 999, void: true }
      ], { accounts: [{ account: 'Alpha', totalCents: 250 }, { account: 'Beta', totalCents: 200 }], totalCents: 450 }),
      makeCase('credit-and-zero-balance', true, [
        { account: 'Cedar', amountCents: 400, void: false }, { account: 'Cedar', amountCents: -400, void: false },
        { account: 'Aster', amountCents: 310, void: false }, { account: 'Aster', amountCents: -15, void: false },
        { account: 'Birch', amountCents: 900, void: true }
      ], { accounts: [{ account: 'Aster', totalCents: 295 }, { account: 'Cedar', totalCents: 0 }], totalCents: 295 })
    ] };
}
function createTaskHandoffSuite(skillName) {
  return { id: 'task-handoff:' + skillName, skillName, version: 1,
    description: 'Preserve user corrections, scope, and observed task state in a structured continuation handoff.',
    cases: [
      { id: 'correction-and-unverified-work', heldOut: false,
        prompt: 'Return only a JSON handoff with keys objective, destination, verified, nextAction. User first requested a CSV export, then corrected the format to JSON and destination to reports/final.json. The file was written, but no read-back or test occurred. The objective remains exporting active accounts. Use objective="export active accounts"; destination is the current requested path; verified is a boolean; nextAction is "verify saved file" or "deliver verified file" according to observed evidence.',
        checks: [{ id: 'scope-and-proof', kind: 'json_equal', expected: { objective: 'export active accounts', destination: 'reports/final.json', verified: false, nextAction: 'verify saved file' } }] },
      { id: 'successful-check-and-later-pivot', heldOut: true,
        prompt: 'Return only a JSON handoff with keys objective, destination, verified, nextAction. A weekly report at reports/week.json was written and successfully verified. The user then changed the objective to exporting inactive accounts into reports/archive.json; that new file has not been written. Use objective="export inactive accounts"; destination is the latest requested path; verified is a boolean about the CURRENT task; nextAction is "write requested file" or "deliver verified file" according to observed evidence.',
        checks: [{ id: 'do-not-transfer-old-success', kind: 'json_equal', expected: { objective: 'export inactive accounts', destination: 'reports/archive.json', verified: false, nextAction: 'write requested file' } }] }
    ] };
}
/* EVALUATION LIMITS, SIZED TO THE SUITE AND THE COMMANDER'S RUN CAP. A fixed 120 s clock and $0.08 per run stopped
   every evaluation on a slow reasoning model (16 calls at ~15 s each) or a premium-priced one, and the stop left an
   unsettled receipt. Every case runs twice (without and with the proposal). Each run gets the Commander's per-run
   cap (runCapUsd; $0.08 when the host gives none), the whole evaluation is bounded by runs x that cap, and the wall
   clock allows ~90 s per run, never under 2 minutes or over 20. The host sizes its timer, the page's wait, the
   runner's limits.maxCostUsd and the accounting's runCapUsd/maxUsd from this one result. */
function evaluationLimits(options) {
  const o = options || {};
  const runs = Math.max(1, Math.floor(Number(o.cases) || 0)) * 2;
  const cap = Number(o.runCapUsd);
  const perRunUsd = Number.isFinite(cap) && cap > 0 ? cap : 0.08;
  return { runs, perRunUsd, totalUsd: perRunUsd * runs, wallClockMs: Math.min(20 * 60000, Math.max(120000, runs * 90000)) };
}
function makeAgentLoopCaseRunner(options) {
  const o = options || {};
  if (!o.provider || typeof o.provider.stream !== 'function') throw new Error('evaluation provider required');
  const loop = o.runAgentLoop || defaultLoop;
  if (typeof o.runIdPrefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(o.runIdPrefix)) throw new Error('evaluation requires a bounded host runIdPrefix');
  // The runner owns the skill-eval- namespace below; a host prefix that already carries it is not doubled.
  const runIdPrefix = /^skill-eval-[a-zA-Z0-9]/.test(o.runIdPrefix) ? o.runIdPrefix.slice('skill-eval-'.length) : o.runIdPrefix;
  let runSerial = 0;
  const clock = o.clock || { now: () => 0 };
  /* The stored-text scrub for the skill text this runner puts in the system prompt: the host's (o.scrub), else
     prompt-scrub's scrubStored. Never the raw text: a scrub that returns no string stops the case before any spend. */
  const scrubWith = typeof o.scrub === 'function' ? o.scrub : require('./prompt-scrub.js').scrubStored;
  const scrub = (t) => {
    const s = scrubWith(t);
    if (typeof s !== 'string') throw new Error('the skill text could not be scrubbed, so the evaluation did not run');
    return s;
  };
  const tools = [
    { type: 'function', function: { name: 'fs_read', description: 'Read a file in the isolated evaluation workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
    { type: 'function', function: { name: 'fs_write', description: 'Write an allowed output in the isolated evaluation workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }
  ];
  return async function runCase({ task, skill, phase, signal }) {
    const runId = 'skill-eval-' + runIdPrefix + '-' + (++runSerial) + '-' + phase + '-' + digestSkill(skill).slice(0, 12);
    // The parent host must decide whether spending is allowed; this callback can
    // deny for budget/paused policy, but never expands the supplied tool surface.
    if (typeof o.authorize === 'function' && await o.authorize({ runId, taskId: task.id, phase }) !== true) return { reason: 'policy-denied' };
    const streamAttempts = [];
    let streamSpent = 0, streamUncertain = false, streamDenied = false;
    // An unmetered provider (Ollama, a Codex/Grok/Kimi sign-in) bills nothing per call. The host says so when it
    // builds the runner (o.unmetered) or in its dispatch admission (beforeRun), before any provider attempt.
    let unmetered = o.unmetered === true;
    const accountableProvider = Object.create(o.provider);
    accountableProvider.stream = async function* trackedStream(request) {
      // This is the paid entry, including retries and continuation calls inside one loop turn.
      const limit = Number(o.limits && o.limits.maxCostUsd) || 0.08;
      if (streamUncertain || streamSpent >= limit || (typeof o.beforeStream === 'function' &&
          await o.beforeStream({ runId, taskId: task.id, phase, spentUsd: streamSpent }) !== true)) {
        streamDenied = true;
        throw Object.assign(new Error('evaluation spending policy refused another provider attempt'), { status: 403 });
      }
      let lastUsage = null;
      let liveAttemptUsd = 0;
      const reconcile = usage => {
        try { return o.cost && o.cost.reconcile(usage, request.model || o.model); } catch (_) { return null; }
      };
      const priced = charge => charge && !charge.unpriced && Number.isFinite(charge.usd) && charge.usd >= 0;
      const attempt = { attempt: streamAttempts.length + 1, usageObserved: false, done: false, truncated: false,
        exhausted: false, errored: false, aborted: false };
      streamAttempts.push(attempt);
      try {
        // The outer loop owns retries. Disabling the adapter's documented hidden
        // pre-stream retry ladder makes each attempt visible to this accounting boundary.
        for await (const event of o.provider.stream({ ...request, preStreamRetries: 0 })) {
          if (event && event.type === 'usage') {
            const usage = event.usage; lastUsage = usage;
            const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
            // Settlement depends on the final snapshot, not any earlier valid one.
            attempt.usageObserved = !!(usage && ((nonnegative(usage.prompt_tokens) && nonnegative(usage.completion_tokens)) ||
              nonnegative(usage.cost) || nonnegative(usage.cost_in_usd_ticks)));
            const charge = attempt.usageObserved && reconcile(usage);
            if (!unmetered && priced(charge)) {
              // Publish known accrued usage while the request is still streaming so
              // concurrent station admissions see it. Final reconciliation may replace it.
              liveAttemptUsd = Math.max(liveAttemptUsd, charge.usd);
              if (typeof o.onStream === 'function') await o.onStream({ runId, spentUsd: streamSpent + liveAttemptUsd, accountingIncomplete: false });
            }
          }
          if (event && event.type === 'done') { attempt.done = true; attempt.truncated = attempt.truncated || event.truncated === true; }
          if (event && event.type === 'error') attempt.errored = true;
          yield event;
        }
        attempt.exhausted = true;
      } catch (error) { attempt.errored = true; throw error; }
      finally {
        attempt.aborted = !!(request && request.signal && request.signal.aborted) || !attempt.exhausted;
        attempt.complete = attempt.exhausted && attempt.done && !attempt.truncated && !attempt.errored && !attempt.aborted;
        const charge = reconcile(lastUsage);
        // The same reconciler used by the loop supplies totals. Unknown pricing or
        // partial streams cannot authorize another attempt using guessed headroom.
        // An unmetered provider bills nothing per call: every attempt there is known $0, complete or not, as runOnce
        // books it, whatever its usage said. There is no headroom to guess.
        if (unmetered) attempt.accounted = attempt.unmetered = true;
        else {
          attempt.accounted = !!(attempt.complete && attempt.usageObserved && priced(charge));
          if (attempt.accounted) streamSpent += charge.usd;
          else streamUncertain = true;
        }
        if (typeof o.onStream === 'function') await o.onStream({ runId, spentUsd: streamSpent, accountingIncomplete: streamUncertain });
      }
    };
    const files = new Map(Object.entries(task.fixtures || {}));
    const writable = new Set(task.writablePaths || []), toolCalls = [];
    const dispatch = async call => {
      const name = String(call.name || '').replace(/^fs_/, 'fs.');
      const args = call.args || {};
      let result;
      if (name === 'fs.read' && typeof args.path === 'string' && files.has(args.path)) result = { ok: true, isError: false, content: files.get(args.path) };
      else if (name === 'fs.write' && writable.has(args.path) && typeof args.content === 'string' && Buffer.byteLength(args.content) <= 65536) {
        files.set(args.path, args.content); result = { ok: true, isError: false, content: 'Saved ' + args.path };
      } else result = { ok: false, isError: true, content: 'Unavailable file, unsupported operation, or invalid output in the isolated evaluation workspace.' };
      toolCalls.push({ name, arguments: copy(args), ok: result.ok });
      return result;
    };
    const activeSkill = skill && skill.state !== 'archived' ? skill : null;
    const supportFiles = activeSkill && activeSkill.files ? (Array.isArray(activeSkill.files) ? activeSkill.files : Object.values(activeSkill.files)) : [];
    // The skill's text is stored exactly as written, so it reaches the model through the host's stored-text scrub
    // (o.scrub: PromptScrub.scrubStored in the sidecar, held credentials, vendor key shapes and credential field values).
    const skillContext = activeSkill ? scrub('\nProcedure under evaluation:\n' + (activeSkill.body || '') + '\n' + (activeSkill.setup || '') +
      // A text file is shown as its exact text however it is stored (an installed package's references were stored
      // base64, and were silently left out of the procedure under evaluation); a binary file is left out, as before.
      supportFiles.map(f => ({ path: f.path, text: FileBytes.readableText(f) })).filter(f => f.text != null)
        .map(f => '\nSupporting file ' + f.path + ':\n' + f.text).join('')) : '';
    // The host commits its dispatch receipt before spend. A rejected/failed write
    // must stop here so interrupted or unpriced runs remain durably unsettled.
    // An unmetered admission ({ ok: true, unmetered: true }) has no receipt to commit: the run is $0.
    if (typeof o.beforeRun === 'function') {
      const admission = await o.beforeRun({ runId, taskId: task.id, phase });
      if (admission !== true && !(admission && admission.ok === true)) throw new Error('evaluation dispatch receipt was not accepted');
      // The admission can only add the unmetered fact; it never turns a host-declared unmetered provider metered.
      if (admission && admission.unmetered === true) unmetered = true;
    }
    let result;
    try { result = await loop({
      messages: [{ role: 'system', content: 'Complete the task using the isolated workspace tools when needed. Report only work actually completed. The task supplies the required output contract.' + skillContext }, { role: 'user', content: task.prompt }],
      provider: accountableProvider, model: o.model, cost: o.cost, clock, signal, tools: tools.map(copy), dispatch,
      capCtx: { signal }, limits: { maxIters: 8, grace: false, ...(o.limits || {}) }, emit: o.emit || (() => {}),
      agentId: 'skill-evaluation', runId, trigger: 'event'
    }); } catch (error) {
      // The real loop returns billing even on provider failures. Unexpected runner
      // throws still produce an attributable failed run; no zero-spend claim is made.
      result = { reason: 'runner-error', messages: [], error: String(error && error.message || error), accountingIncomplete: true };
    }
    if (streamDenied) result.reason = 'policy-denied';
    const uncertainAttempts = streamAttempts.filter(attempt => !attempt.accounted);
    result.accountingIncomplete = !unmetered && (result.accountingIncomplete === true || uncertainAttempts.length > 0 || (result.reason === 'done' && streamAttempts.length === 0));
    result.accountingStreams = { attempted: streamAttempts.length, complete: streamAttempts.filter(attempt => attempt.accounted).length,
      uncertain: uncertainAttempts.slice(0, 128), omitted: Math.max(0, uncertainAttempts.length - 128) };
    if (typeof o.onRun === 'function') await o.onRun({ result, runId, taskId: task.id, phase });
    let value;
    const final = (result.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
    if (final) { try { value = JSON.parse(final.content); } catch (_) { value = undefined; } }
    return { reason: result.reason, value, artifacts: Object.fromEntries(files), toolCalls };
  };
}
module.exports = { createArtifactWorkflowSuite, createTaskHandoffSuite, makeAgentLoopCaseRunner, evaluationLimits };
