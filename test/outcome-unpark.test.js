/* node test/outcome-unpark.test.js — THE UNPARK: runOnceCore's own decisions read the run's ONE outcome (typed-outcomes lane, r7,
   2026-10-30).

   While the run-wire-resolver lane edited runOnceCore it was frozen to this lane, and every consumer inside it that decided or
   reported how a run ended from the bare end word stayed PARKED in test/outcome-family.census.test.js. A reply the provider cut
   (reason 'done', finishReason 'length') COMPLETED its run-bound quest and its Task Brief, graded postconditions
   completed_verified, and reached a user's on_session_end hook as 'done'; a 'done' end the run's own late error outranked was
   reflected on as a success and never failure-reviewed; a Commander's `miss` on a cut reply found no verdict-review packet; and
   every up-front host refusal (a routine's pre-check script, too many agents at once, an empty StarNet wallet, a model that cannot
   call tools, an expired sign-in, a full disk) and the image task's late error left the outcome sink to stamp 'run_failure'.

   THE ORDERING (Codex B3): the Task Brief settle, the postconditions and the hook decide while the lead's 'done' end is still
   BUFFERED (the outcome sink has not stamped it), and the quest sweep and the aux passes decide after runStore.record CONSUMED the
   sink's endedOutcomes. So each reads the lead's own facts (sidecar/lead-outcome.js: own error > finishReason > reason), never the
   sink's cache — and this test drives each with exactly those facts, through the statements SLICED from runOnceCore:
     1. the post-loop decisions (image settle -> postconditions -> Task Brief settle -> hook -> the buffered end, through the real
        buffer gate and the station's outcome sink), with a real Task Brief store read back after a "restart";
     2. the quest sweep; 3. the aux gates, learning-eligibility's input and the aux inputs (failure review, skill review, the
        verdict-review packet); 4. the modules they feed (postconditions, failreview, learning-eligibility, learningevidence,
        verdictreview); 5. every up-front refusal's code, through the outcome sink and the page's words (FriendlyError).
   It FAILS on the tip before the unpark (b167cb6c8): run against a `git archive b167cb6c8` of sidecar/, frontend/app/, shared/, bin/
   and test/ with this file, it prints the problems listed at the bottom of this header — every red row below is a control. A
   delegated worker's end and error pass the buffer untouched and never settle the lead (a guard, green on both trees).
   b167cb6c8: 81 problems, 59 ok — the post-loop block 12 (a cut reply graded completed_verified, completed its brief and reached
   the hook as 'done'; the image miss coded run_failure), the quest sweep 2, the aux gates and their inputs 10, the modules 13
   (lead-outcome.js absent among them) and the refusals 44 (all sixteen stamped run_failure; twelve read "Something went wrong"). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const Friendly = require('../frontend/app/friendlyerror.js');
const TaskIntent = require('../frontend/app/fork.js').TaskIntent;
const ImageTask = require('../sidecar/image-task.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
const { makeCompletionEvidence } = require('../sidecar/completion-evidence.js');
const { assessPostconditions } = require('../sidecar/task-postconditions.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const Failreview = require('../sidecar/failreview.js');
const LE = require('../sidecar/learning-eligibility.js');
const LearningEvidence = require('../sidecar/learningevidence.js');
const { compactPacket } = require('../sidecar/verdictreview.js');
const budgetCaps = require('../sidecar/budgetcaps.js');
let LeadOutcome = null;
try { LeadOutcome = require('../sidecar/lead-outcome.js'); } catch (_) { LeadOutcome = null; }   // absent before the unpark
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CORE = sidecarTopLevelFunction('runOnceCore').replace(/\r\n/g, '\n');
A.ok(CORE.length > 100000, 'fixture: runOnceCore is sliced from the sidecar source');
function slice(from, to, start) {
  const a = CORE.indexOf(from, start || 0);
  const b = a < 0 ? -1 : CORE.indexOf(to, a + from.length);
  A.ok(a >= 0 && b > a, 'fixture: runOnceCore holds "' + from.slice(0, 60) + '" … "' + to.slice(0, 40) + '"');
  return a >= 0 && b > a ? CORE.slice(a, b) : '';
}
// the lead's own facts, when the tree has them (the unpark): leadLateError + leadOutcome, as runOnceCore declares them
const LEAD_DECL = (CORE.match(/^\s*let leadLateError = null;$/m) || [''])[0] + '\n' + (CORE.match(/^\s*const leadOutcome = \(\) => [^\n]*$/m) || [''])[0];
// the station's outcome sink (index.js outcomeSink), as the table test slices it
const SINK_SRC = sidecarTopLevelFunction('outcomeSink');
const stationSink = collect => new Function('RunOutcome', 'endedOutcomes', SINK_SRC + '\nreturn outcomeSink;')(RunOutcome, new Map())(collect);
const ends = (evs, runId) => evs.filter(([n, p]) => n === 'agent.run.end' && p.runId === runId).map(([, p]) => p);
const errs = (evs, runId) => evs.filter(([n, p]) => n === 'agent.run.error' && p.runId === runId).map(([, p]) => p);

// ================================ 1. THE POST-LOOP DECISIONS (sliced, in runOnceCore's own order) ================================
const BUFFER_GATE = slice('if (((taskBrief || imageTask) || o.postconditions != null)', 'emit(name, payload);');
const POST = (() => {
  const a = CORE.indexOf('if (result && result.failureStage) execution.recordFailure(');
  const rewrite = CORE.indexOf("reason: taskQuestionAsked ? 'clarifying' : ((result && result.reason) || bufferedTaskEnd.reason),", a);
  // the try body ends at its FIRST closer: since 7f7a2689a (private line-entry observation) a `} catch (error) {` precedes `} finally {`
  const closers = ['\n  } catch (error) {', '\n  } finally {'].map(c => CORE.indexOf(c, rewrite)).filter(i => i > rewrite);
  const b = closers.length ? Math.min(...closers) : -1;
  A.ok(a > 0 && rewrite > a && b > rewrite, 'fixture: runOnceCore holds the post-loop decisions, from the failure stage to the buffered end');
  return a > 0 && b > a ? CORE.slice(a, b) : '';
})();
const POST_NAMES = ['RunOutcome', 'LeadOutcome', 'TaskIntent', 'ImageTask', 'execution', 'imageTask', 'taskBrief', 'agentId', 'runId', 'emitOut', 'o',
  'readPostconditionArtifact', 'readPostconditionConnector', 'taskBriefStore', 'hookSpine', 'WORKSPACES', 'model', 'surface', 'loopEvents', 'loopResult', 'seq'];
const postRun = new AsyncFunction(...POST_NAMES, [
  'let result; let taskQuestionAsked = false; let finalCompletionEvidence = null; let bufferedTaskEnd = null;',
  LEAD_DECL,
  'const emit = (n, p) => { if (n === "agent.run.end" && p && p.runId === runId) seq.push("end"); return emitOut(n, p); };',
  'const loopEmit = (name, payload) => { ' + BUFFER_GATE + ' emit(name, payload); };',
  'for (const [n, p] of loopEvents) loopEmit(n, p);',
  'result = loopResult;',
  POST,
  'return { taskQuestionAsked, finalCompletionEvidence, bufferedLeft: bufferedTaskEnd };'
].join('\n'));

const QUESTION = 'I can write that.\nTASK_QUESTION: who is the launch post for? || customers | investors';
async function postLoop(kind, opts) {
  const x = opts || {};
  const runId = 'r-' + kind, agentId = 'agent';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-unpark-brief-'));
  try {
    const store = makeTaskBriefStore({ fs, path, workspaces: dir });
    const brief = x.brief === false ? null : await store.prepare({ key: 'k', text: 'write the launch post', runId, source: 'interactive' }, 1);
    const artifacts = x.artifacts || [{ kind: 'file', path: 'report.md' }];
    const execution = makeRunExecutionState({ artifacts: { list: () => artifacts.slice() }, completion: makeCompletionEvidence({}) });
    const reply = x.reply || 'Here is the launch post.';
    const loopEnd = Object.assign({ agentId, runId, reason: 'done', turns: 3, usd: 0.02 }, x.finishReason ? { finishReason: x.finishReason } : {});
    const loopEvents = [['agent.run.start', { agentId, runId, trigger: 'directive', model: 'm' }]];
    if (x.child) {
      // a delegated worker's start, error and end, forwarded onto the lead's stream (orchestration.js FORWARD)
      loopEvents.push(['agent.run.start', { agentId: 'worker', runId: 'w-1', trigger: 'delegated', model: 'm' }]);
      loopEvents.push(['agent.run.error', { agentId: 'worker', runId: 'w-1', message: 'openrouter http 429', transient: true, failureCode: 'rate_limit' }]);
      loopEvents.push(['agent.run.end', { agentId: 'worker', runId: 'w-1', reason: 'done', turns: 1, usd: 0 }]);
    }
    loopEvents.push(['agent.run.end', loopEnd]);
    const loopResult = Object.assign({ reason: 'done', turns: 3, usd: 0.02, messages: [{ role: 'user', content: 'write the launch post' }, { role: 'assistant', content: reply }] },
      x.finishReason ? { finishReason: x.finishReason } : {});
    const out = [], seq = [], hooks = [];
    const hookSpine = { invoke: async (name, payload) => { seq.push('hook:' + name); hooks.push(payload); } };
    const r = await postRun(RunOutcome, LeadOutcome, TaskIntent, ImageTask, execution, !!x.imageTask, brief, agentId, runId, stationSink((n, p) => out.push([n, p])),
      { postconditions: x.contract === false ? null : { requirements: [{ type: 'artifact_exists', path: 'report.md' }] } },
      async () => ({ exists: true, isFile: true, bytes: 12 }), async () => ({ ok: false, code: 'connector_reader_unavailable' }), store,
      hookSpine, dir, 'm', 'interactive', loopEvents, loopResult, seq);
    // a RESTART: a fresh store over the same file reads what the settle persisted
    const reread = brief ? makeTaskBriefStore({ fs, path, workspaces: dir }).active('k') : null;
    return { runId, events: out, end: ends(out, runId)[0] || null, error: errs(out, runId)[0] || null, hook: hooks[0] ? hooks[0].extra : null, seq, r,
      briefStatus: reread ? reread.status : null, failureCode: execution.failureCode(), failureStage: execution.failureStage() };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp dir the OS reaps */ }
  }
}

(async () => {
  // ---- a reply the provider CUT (finishReason 'length'), with a postcondition contract and a Task Brief ----
  const cut = await postLoop('cut', { finishReason: 'length' });
  A.ok(cut.end && cut.end.outcome === 'cut_short', 'post-loop / cut: the buffered end leaves stamped cut_short (got ' + JSON.stringify(cut.end && cut.end.outcome) + ')');
  A.eq(cut.end && cut.end.finishReason, 'length', 'post-loop / cut: the buffered end keeps its finishReason through the rewrite');
  A.eq(cut.end && cut.end.completionVerdict, 'incomplete', 'post-loop / cut: a file existing never grades a cut reply completed_verified (postconditions cleanTerminal)');
  A.eq(cut.r.finalCompletionEvidence && cut.r.finalCompletionEvidence.completionVerdict, 'incomplete', 'post-loop / cut: the run row\'s completion evidence says incomplete too');
  A.eq(cut.hook && [cut.hook.reason, cut.hook.outcome, cut.hook.failure_code], ['cut_short', 'cut_short', ''], 'post-loop / cut: the on_session_end hook hears cut_short, never \'done\'');
  A.eq(cut.hook && [cut.hook.completed, cut.hook.completion_verdict], [false, 'incomplete'], 'post-loop / cut: the hook\'s completion evidence says what the end says');
  A.ok(cut.briefStatus && cut.briefStatus !== 'done', 'post-loop / cut: the Task Brief stays active across a restart, so "continue" keeps it (got ' + cut.briefStatus + ')');
  A.ok(cut.seq.indexOf('hook:on_session_end') >= 0 && cut.seq.indexOf('hook:on_session_end') < cut.seq.indexOf('end'), 'post-loop: the hook decides before the buffered end leaves (ordering kept)');

  // ---- a run that SUCCEEDED: every decision completes ----
  const ok = await postLoop('ok', {});
  A.eq(ok.end && [ok.end.outcome, ok.end.completionVerdict], ['succeeded', 'completed_verified'], 'post-loop / succeeded: stamped succeeded, its postconditions completed_verified');
  A.eq(ok.hook && [ok.hook.reason, ok.hook.outcome, ok.hook.completed], ['done', 'succeeded', true], 'post-loop / succeeded: the hook hears done, succeeded, completed');
  A.eq(ok.briefStatus, 'done', 'post-loop / succeeded: the Task Brief is completed, and stays completed across a restart');

  // ---- a Task Brief QUESTION: asked, neither completed work nor a failure ----
  const asked = await postLoop('asked', { reply: QUESTION });
  A.eq(asked.end && [asked.end.reason, asked.end.outcome, asked.end.completionVerdict], ['clarifying', 'asked', 'not_assessed'], 'post-loop / asked: the end is re-emitted clarifying, stamped asked');
  A.eq(asked.hook && [asked.hook.reason, asked.hook.outcome, asked.hook.completed, asked.hook.completion_verdict], ['clarifying', 'asked', false, 'not_assessed'],
    'post-loop / asked: the hook hears the question (it runs after the Task Brief settle), never \'done\'');
  A.eq(asked.briefStatus, 'clarifying', 'post-loop / asked: the brief waits on its question across a restart');
  const askedCut = await postLoop('askedCut', { reply: QUESTION, finishReason: 'length' });
  A.eq([askedCut.end && askedCut.end.outcome, askedCut.briefStatus], ['asked', 'clarifying'], 'post-loop / asked + cut: a question is asked however the provider ended the reply (RunOutcome.resolve)');

  // ---- an image task that produced no image: the host's LATE error outranks the apparent done ----
  const img = await postLoop('image', { imageTask: true, contract: false });
  A.ok(img.error && img.error.failureCode === 'image_not_produced', 'post-loop / image miss: the late error names image_not_produced (got ' + JSON.stringify(img.error && img.error.failureCode) + ')');
  A.eq(img.end && [img.end.reason, img.end.outcome, img.end.failureCode], ['error', 'failed', 'image_not_produced'], 'post-loop / image miss: the end is failed with the image code, never run_failure');
  A.eq([img.failureStage, img.failureCode], ['completion', 'image_not_produced'], 'post-loop / image miss: the run row records the stage and the code');
  A.eq(img.hook && [img.hook.reason, img.hook.outcome, img.hook.failure_code], ['error', 'failed', 'image_not_produced'], 'post-loop / image miss: the hook hears the failure and its code');
  A.ok(img.briefStatus && img.briefStatus !== 'done', 'post-loop / image miss: the Task Brief is never completed by a run its own error failed');
  A.eq(Friendly.friendlyError(img.error ? img.error.message : '', null, { code: img.error && img.error.failureCode }).kind, 'image_not_produced', 'post-loop / image miss: COMMS words it from the code');

  // ---- a delegated worker's terminals never settle or rewrite the lead (a guard: green on both trees) ----
  const child = await postLoop('child', { child: true, finishReason: 'length' });
  const wEnd = ends(child.events, 'w-1')[0];
  A.ok(wEnd && wEnd.reason === 'done' && wEnd.outcome === 'failed' && !('completionVerdict' in wEnd), 'post-loop / child: the worker\'s end passes the buffer untouched, paired with ITS error');
  A.eq(child.end && child.end.outcome, 'cut_short', 'post-loop / child: the worker\'s 429 never stands in for the lead (its own cut does)');
  A.ok(child.end && child.end.failureCode !== 'rate_limit', 'post-loop / child: the lead takes no failure code from its worker');

  // ================================ 2. THE QUEST SWEEP (after runStore.record consumed endedOutcomes) ================================
  const QUEST = slice('// QUEST V2 §A — the run-lifecycle sweeps at the settle point', '// QUEST V2 §A — the ARTIFACT-contract sweep');
  const questRun = new Function('RunOutcome', 'LeadOutcome', 'questStore', 'runId', 'completeQuestRecommendationIds', 'swallow', 'loopResult', 'asked', 'lateError',
    'let result = loopResult; let taskQuestionAsked = asked;\n' + LEAD_DECL + '\nif (lateError && typeof leadLateError !== "undefined") leadLateError = lateError;\n' + QUEST);
  const sweep = (result, o) => {
    const calls = [];
    const questStore = { completeByContract: (...a) => { calls.push(['complete'].concat(a.slice(0, 2))); return Promise.resolve([]); },
      stallRun: (...a) => { calls.push(['stall', a[0], a[1]]); return Promise.resolve([]); } };
    try { questRun(RunOutcome, LeadOutcome, questStore, 'r-q', () => {}, () => () => {}, result, !!(o && o.asked), (o && o.lateError) || null); }
    catch (e) { calls.push(['threw', String(e && e.message)]); }
    return calls;
  };
  A.eq(sweep({ reason: 'done', finishReason: 'length' }), [['stall', 'r-q', 'cut_short']], 'quest sweep / cut: a run-bound quest STALLS (cut_short), never completes on a cut reply');
  A.eq(sweep({ reason: 'done' }), [['complete', 'run', 'r-q']], 'quest sweep / succeeded: completes');
  A.eq(sweep({ reason: 'done' }, { asked: true }), [['stall', 'r-q', 'clarifying']], 'quest sweep / asked: stalls on the question');
  A.eq(sweep(undefined), [['stall', 'r-q', 'error']], 'quest sweep / thrown: no end stalls it as error');
  A.eq(sweep({ reason: 'done' }, { lateError: { runId: 'r-q', message: 'late', failureCode: 'image_not_produced' } }), [['stall', 'r-q', 'error']],
    'quest sweep / own late error: an error the run raised outranks an apparent done');
  A.eq(sweep({ reason: 'error', failureCode: 'rate_limit' }), [['stall', 'r-q', 'error']], 'quest sweep / failed: stalls error');

  // ================================ 3. THE AUX GATES AND INPUTS ================================
  const GATES = slice('const _fr = result && result.finishReason;', 'const _auxNow = Date.now();');
  const gateRun = new Function('RunOutcome', 'LeadOutcome', 'Failreview', 'loopResult', 'asked', 'lateError', 'o', 'signal', 'isTask', 'internal',
    'let result = loopResult; let taskQuestionAsked = asked;\n' + LEAD_DECL + '\nif (lateError && typeof leadLateError !== "undefined") leadLateError = lateError;\n' + GATES +
    '\nreturn { done: _auxDone, fail: _auxFail, truncated: _truncated, leadOc: typeof _leadOc !== "undefined" ? _leadOc : null };');
  const gates = (result, o) => gateRun(RunOutcome, LeadOutcome, Failreview, result, !!(o && o.asked), (o && o.lateError) || null, {}, { aborted: false }, true, false);
  const LATE = { runId: 'r', message: 'late', failureCode: 'image_not_produced' };
  A.eq([gates({ reason: 'done' }).done, gates({ reason: 'done' }).fail], [true, false], 'aux gates / succeeded: the success passes, no failure review');
  A.eq([gates({ reason: 'done', finishReason: 'length' }).done, gates({ reason: 'done', finishReason: 'length' }).fail], [false, false],
    'aux gates / cut: neither — a cut reply is unfinished work (the explicit policy: no reflection, no failure review)');
  A.eq([gates({ reason: 'done' }, { lateError: LATE }).done, gates({ reason: 'done' }, { lateError: LATE }).fail], [false, true],
    'aux gates / own late error: a \'done\' its own error outranked is failure-reviewed, never reflected on as a success');
  A.eq([gates({ reason: 'done' }, { asked: true }).done, gates({ reason: 'done' }, { asked: true }).fail], [false, false], 'aux gates / asked: neither');
  for (const r of ['error', 'max_iters', 'budget', 'refusal']) A.eq(gates({ reason: r }).fail, true, 'aux gates / ' + r + ': failure-reviewed');
  for (const r of ['cancelled', 'empty']) A.eq([gates({ reason: r }).done, gates({ reason: r }).fail], [false, false], 'aux gates / ' + r + ': neither');
  A.eq(gates({ reason: 'error', failureCode: 'content_policy_blocked' }).fail, true, 'aux gates / a provider safety block (refused) is still failure-reviewed (providerRefused decides what it reads)');

  // learning-eligibility's input: the base kind of a 'done' its own error outranked is failed
  const LEARN = slice('const _learn = LearningEligibility.passes(LearningEligibility.runOutcome(', '}));') + '}));';
  const learnRun = new Function('LearningEligibility', 'loopResult', 'asked', '_leadOc', '_truncated',
    'const result = loopResult, taskQuestionAsked = asked, signal = { aborted: false }, o = { reflect: true }, isTask = true, internal = false, quotedLearning = false, _lineHop = false;\n' +
    'const refusedAction = () => false; const execution = { toolTraceList: () => [], taintedBy: () => null };\n' + LEARN + '\nreturn _learn;');
  const learn = (result, o) => { const g = gates(result, o); return learnRun(LE, result, !!(o && o.asked), g.leadOc, g.truncated); };
  A.eq(learn({ reason: 'done' }, { lateError: LATE }).kind, 'failed', 'learning eligibility / own late error: the base kind is failed, never done');
  A.eq(learn({ reason: 'done' }, { lateError: LATE }).reflection, false, 'learning eligibility / own late error: reflection never learns from it');
  A.eq(learn({ reason: 'done', finishReason: 'length' }).kind, 'unfinished', 'learning eligibility / cut: unfinished');
  A.eq(learn({ reason: 'done' }).kind, 'done', 'learning eligibility / succeeded: done');

  // the aux inputs: the failure review, the skill review and the verdict-review packet carry the outcome-aware reason and the outcome
  const AUX_NAMES = ['_auxSpend', '_auxDone', '_auxFail', '_leadOc', 'result', 'agentId', 'runId', 'o', 'execution', 'ENV', 'isTask', 'internal',
    'runFailureReview', 'runBackgroundSkillReview', 'verdictReview', 'failReviewingNow', 'skillReviewingNow', 'auxProvider', '_auxFailModel', '_auxFailEffort',
    '_auxSkillModel', 'cost', 'providerUnmetered', 'learningEvidence', 'finalCompletionEvidence', 'loadedSkills', 'managedSkills', 'swallow', 'activeProviderId',
    'TurnDirective', 'directive', 'redact', 'liveServiceKeys', 'runTranscript', 'retryDirective', '_keyGone',   // the packet's directive and credential-presence gate are owned by the surrounding run
    'automaticAux', 'skillNudge', 'persistSkillNudge', 'forgetRegistry', 'TurnKinds'];
  const auxRun = new Function(...AUX_NAMES, slice("if (_auxSpend.has('failure-review')) {", "if (_auxSpend.has('study')) {") +
    slice("if (_auxSpend.has('skill-review')) {", "if (_auxSpend.has('skill-curator')) {"));
  const aux = (result, o, spend) => {
    const g = gates(result, o), got = { failure: null, skill: null, stash: null };
    const settle = () => ({ catch: () => ({ finally: f => f() }) });
    auxRun(new Set(spend), g.done, g.fail, g.leadOc, Object.assign({ messages: [] }, result), 'agent', 'r-aux', {},
      { failureStage: () => '', failureCode: () => '', toolTraceList: () => [], recoveryAttempts: () => [], uncertainMutations: () => [], quotes: () => [] },
      () => '', true, false,
      a => { got.failure = a; return settle(); }, a => { got.skill = a; return settle(); }, { stash: (id, p) => { got.stash = p; return true; } },
      new Set(), new Set(), {}, 'm', null, 'm', {}, false, {}, {}, [], [], () => () => {}, 'route-1',
      require('../sidecar/turn-directive.js'), null, t => t, () => [], { directiveRow: () => null }, null, false,
      (route, kind, agent, run, work) => work(), new Map(), () => {},
      { admit: () => true }, require('../frontend/app/turnkinds.js'));
    return got;
  };
  const late = aux({ reason: 'done' }, { lateError: LATE }, ['failure-review']);
  A.eq(late.failure && [late.failure.reason, late.failure.outcome], ['error', 'failed'], 'aux inputs / own late error: the failure review is handed reason error, outcome failed');
  A.eq(late.stash && [late.stash.reason, late.stash.outcome, late.stash.failed], ['error', 'failed', true], 'aux inputs / own late error: the verdict-review packet says failed');
  const cutAux = aux({ reason: 'done', finishReason: 'length' }, null, []);
  A.ok(!!cutAux.stash, 'aux inputs / cut: a provider-cut reply\'s packet is parked, so a Commander\'s `miss` on it arms the verdict review');
  A.eq(cutAux.stash && [cutAux.stash.reason, cutAux.stash.outcome, cutAux.stash.failed], ['cut_short', 'cut_short', true], 'aux inputs / cut: the packet says cut_short');
  const okAux = aux({ reason: 'done' }, null, ['skill-review']);
  A.eq(okAux.skill && [okAux.skill.reason, okAux.skill.outcome], ['done', 'succeeded'], 'aux inputs / succeeded: the skill review carries the outcome beside done');
  A.eq(okAux.skill && okAux.skill.route, 'route-1', 'aux inputs: the skill review keeps its route');
  A.eq(okAux.stash && okAux.stash.route, 'route-1', 'aux inputs: and so does the verdict-review packet');

  // runFailureReview hands Failreview.review the outcome; runBackgroundSkillReview hands the skill reviewer's prompt the outcome
  const indexFns = { failure: sidecarTopLevelFunction('runFailureReview'), skill: sidecarTopLevelFunction('runBackgroundSkillReview') };
  const reviewInput = (() => { const a = indexFns.failure.indexOf('Failreview.review(\n'); const b = indexFns.failure.indexOf(',\n      { propose', a); return a > 0 && b > a ? indexFns.failure.slice(a + 'Failreview.review(\n'.length, b) : ''; })();
  A.ok(!!reviewInput, 'fixture: runFailureReview builds Failreview.review\'s run');
  const reviewRun = reviewInput ? new Function('agentId', 'runId', 'o', 'messages', 'return (' + reviewInput + ');')('agent', 'r', { reason: 'error', outcome: 'failed' }, []) : {};
  A.eq(reviewRun.outcome, 'failed', 'aux inputs: runFailureReview hands the failure review the outcome');
  const promptLine = (indexFns.skill.match(/skillReview\.buildPrompt\(\{\n\s*([^\n]*)\n/) || [])[1] || '';
  A.ok(/outcome: o && o\.outcome/.test(promptLine), 'aux inputs: runBackgroundSkillReview hands the skill reviewer\'s prompt the outcome beside the reason');

  // ================================ 4. THE MODULES THEY FEED ================================
  const contract = { requirements: [{ type: 'artifact_exists', path: 'out/report.md' }] };
  const pc = extra => assessPostconditions(Object.assign({ contract, effectVerdict: 'no_observed_effects', artifacts: [{ kind: 'file', path: 'out/report.md' }],
    readArtifact: async () => ({ exists: true, isFile: true }) }, extra));
  A.eq((await pc({ reason: 'done', finishReason: 'length' })).completionVerdict, 'incomplete', 'postconditions: a provider-cut done is no clean terminal (reason-only input, resolved)');
  A.eq((await pc({ outcome: 'cut_short', reason: 'done' })).completionVerdict, 'incomplete', 'postconditions: the outcome decides (cut_short)');
  A.eq((await pc({ outcome: 'failed', reason: 'done' })).completionVerdict, 'incomplete', 'postconditions: a done its own error outranked is incomplete');
  A.eq((await pc({ outcome: 'succeeded' })).completionVerdict, 'completed_verified', 'postconditions: a succeeded run with its file is completed_verified');

  A.ok(typeof Failreview.reviewableOutcome === 'function' && Failreview.reviewableOutcome('failed') && Failreview.reviewableOutcome('refused')
    && Failreview.reviewableOutcome('step_limit') && Failreview.reviewableOutcome('out_of_budget'), 'failreview: the failure outcomes are reviewable');
  A.ok(typeof Failreview.reviewableOutcome === 'function' && ['succeeded', 'cut_short', 'asked', 'stopped', 'empty', 'interrupted', 'blocked', '', 'junk'].every(x => !Failreview.reviewableOutcome(x)),
    'failreview: success, a cut reply, a question, a stop, an empty reply are never reviewed');
  A.ok(/\nFAILED RUN — reason: error, outcome: failed/.test(Failreview.buildPrompt({ reason: 'done', outcome: 'failed', messages: [] })), 'failreview: the prompt names a done its own error outranked as error, with its outcome');

  A.eq(LE.runOutcome({ reason: 'done', outcome: 'failed', reflect: true, task: true }).kind, 'failed', 'learning-eligibility: the base kind reads the outcome (failed)');
  A.eq(LE.runOutcome({ reason: 'done', outcome: 'cut_short', reflect: true, task: true }).kind, 'unfinished', 'learning-eligibility: a cut reply is unfinished');
  A.eq(LE.runOutcome({ reason: 'done', outcome: 'stopped', reflect: true, task: true }).kind, 'cancelled', 'learning-eligibility: a stop is the Commander\'s own hand, never a failure');
  A.eq(LE.runOutcome({ reason: 'done', denied: true, reflect: true, task: true }).kind, 'denied', 'learning-eligibility: its denied kind is unchanged (rel#9 is denied-outcome\'s)');

  const ev = LearningEvidence.buildLearningEvidence({ runId: 'r', agentId: 'a', reason: 'cut_short', outcome: 'cut_short', failed: true, messages: [] });
  A.eq([ev.reason, ev.outcome], ['cut_short', 'cut_short'], 'learningevidence: the packet carries the outcome beside the reason');
  const packet = compactPacket({ agentId: 'a', reason: 'cut_short', outcome: 'cut_short', failed: true, messages: [] });
  A.eq([packet.reason, packet.outcome, packet.failed], ['cut_short', 'cut_short', true], 'verdictreview: the persisted packet keeps the outcome (a restart reads it)');

  A.ok(!!LeadOutcome, 'lead-outcome.js: runOnceCore\'s own outcome reader exists');
  if (LeadOutcome) {
    const L = (r, x) => LeadOutcome.ofResult(r, x || {});
    A.eq(L({ reason: 'done', finishReason: 'length' }, { ownError: { failureCode: 'image_not_produced' } }).outcome, 'failed', 'lead-outcome: an own error outranks the provider cut');
    A.eq(L({ reason: 'done', finishReason: 'content_filter' }).reason, 'cut_short', 'lead-outcome: a provider cut outranks the end word');
    A.eq(L(undefined).failureCode, RunOutcome.NO_TERMINAL, 'lead-outcome: no end is no_terminal_outcome, never done');
    // review 9.2: a provider's safety block ends 'error' with a refusal code — the lead is refused, and its word (the on_session_end hook's reason, a
    // quest's stall) is the refusal's own, never the failure's 'error' (RunOutcome.reasonOf's rule)
    A.eq([L({ reason: 'error', failureCode: 'content_policy_blocked' }).outcome, L({ reason: 'error', failureCode: 'content_policy_blocked' }).reason, L({ reason: 'error', failureCode: 'rate_limit' }).reason],
      ['refused', 'refusal', 'error'], 'lead-outcome: a refused lead reads the refusal\'s own word; a failed one stays error');
  }

  // ================================ 5. EVERY UP-FRONT REFUSAL NAMES ITS CODE ================================
  const REFUSAL_NAMES = ['emit', 'agentId', 'runId', 'trigger', 'model', 'runStartExtra', 'o', 'e', 'scan', 'concurrencyGate', 'refusal', 'agentModelBlocker',
    'imageBlocker', 'ref', 'saved', 'providerId', 'oauthLabel', 'RunTable'];
  // run-table S2: each refusal is ONE refuse({...}) call through runOnceCore's own refuse() (RunTable.refuseRun over the run's chain), so
  // the site is sliced as that call, from its marker to its balanced close, and run with the declaration and the REAL sidecar/run-table.js
  const REFUSE_DECL = (CORE.match(/^\s*const refuse = \(r, startModel\) => [^\n]*$/m) || [''])[0];
  function refuseCall(marker) {
    const at = CORE.indexOf(marker);
    const from = at < 0 ? -1 : CORE.indexOf('refuse(', at);
    if (from < 0) return '';
    let depth = 0, i = from + 'refuse'.length;
    for (; i < CORE.length; i++) {
      const ch = CORE[i];
      if (ch === '/' && CORE[i + 1] === '/') i = CORE.indexOf('\n', i);   // a comment line inside the call
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) break; }
      else if (ch === "'" || ch === '"' || ch === '`') { const q = ch; for (i++; i < CORE.length && CORE[i] !== q; i++) if (CORE[i] === '\\') i++; }
    }
    return CORE.slice(from, i + 1) + ';';
  }
  function refusal(marker, scope) {
    const call = refuseCall(marker);
    A.ok(REFUSE_DECL && call, 'fixture: runOnceCore refuses at "' + marker.slice(0, 50) + '"');
    const out = [];
    const sc = Object.assign({ agentId: 'agent', runId: 'r-ref', trigger: 'directive', model: 'm', runStartExtra: {}, o: { noAgent: false }, e: new Error('boom'),
      scan: { error: 'blocked: the script output carried an instruction' }, concurrencyGate: { max: () => 4 }, refusal: null, agentModelBlocker: 'Model unavailable for agent chat',
      imageBlocker: 'Image task blocked: this agent has no STUDIO.', ref: 'weekly-digest', saved: null, providerId: 'grok', oauthLabel: () => 'Grok (xAI)',
      RunTable: require('../sidecar/run-table.js') }, scope || {});
    sc.emit = stationSink((n, p) => out.push([n, p]));
    try { new Function(...REFUSAL_NAMES, REFUSE_DECL + '\n' + call)(...REFUSAL_NAMES.map(k => sc[k])); }
    catch (err) { out.push(['threw', { message: String(err && err.message) }]); }
    return { end: ends(out, 'r-ref')[0] || null, error: errs(out, 'r-ref')[0] || null };
  }
  const REFUSALS = [
    ['try { checked = await executeCronScript(', {}, 'routine_script_failed', 'routine_precheck'],
    ['const scan = cronGuard.scanAssembled(', {}, 'routine_script_blocked', 'routine_precheck'],
    ['} else if (o.noAgent) {', {}, 'routine_script_missing', 'routine_precheck'],
    ['if (!agentLifecycle.canStart(agentId)) {', {}, 'agent_deleting', 'agent_deleting'],
    ['if (!concurrencyGate.tryEnter(agentId)) {', {}, 'concurrency_limit', 'concurrency_limit'],
    ['const refusal = budgetCaps.managedRefusalMessage(', { refusal: budgetCaps.managedRefusalMessage({ exhausted: true, balanceUsd: 0 }) }, 'managed_credit', 'managed_credit'],
    ['const refusal = budgetCaps.managedRefusalMessage(', { refusal: budgetCaps.managedRefusalMessage({ linkRefused: true }) }, 'managed_credit_link', 'managed_credit_link'],
    ['if (agentModelBlocker) {', { agentModelBlocker: ImageTask.agentModelBlocker('openai', 'gpt-image-1') || 'Model unavailable for agent chat' }, 'model_unsuitable', 'model_unsuitable'],
    ['if (imageBlocker) {', {}, 'image_route_blocked', 'image_blocked'],
    ["resolved.tools.indexOf('skill.view') < 0) {", {}, 'routine_skill_unavailable', 'routine_skill'],
    ['const verdict = saved ? skillGate.verify(saved) : null;', { saved: null }, 'routine_skill_missing', 'routine_skill'],
    ['const verdict = saved ? skillGate.verify(saved) : null;', { saved: { id: 'weekly-digest' } }, 'routine_skill_withheld', 'routine_skill'],
    ['try { codexToken = await ensureCodexAccessToken(); }', { e: Object.assign(new Error('Sign in with ChatGPT again'), { reloginRequired: true }) }, 'auth', 'oauth'],
    ['try { oauthToken = await ensureOAuthAccessToken(providerId); }', { e: Object.assign(new Error('grok not connected'), { reloginRequired: true }) }, 'auth', 'oauth'],
    ['if (isTask && provider.supportsTools(model) === false) {', { providerId: 'ollama' }, 'model_no_tools', 'model_unsuitable'],
    ["runJournal.checkpoint(runId, { phase: 'initial'", { e: new Error('ENOSPC: no space left on device') }, 'checkpoint_failed', 'checkpoint_failed']
  ];
  for (const [marker, scope, code, kind] of REFUSALS) {
    const r = refusal(marker, scope);
    const what = code + ' (' + marker.slice(0, 40) + ')';
    A.eq(r.end && [r.end.outcome, r.end.failureCode], ['failed', code], 'refusal ' + what + ': the stamped end names its code, never run_failure (got ' + JSON.stringify(r.end && [r.end.outcome, r.end.failureCode]) + ')');
    A.eq(r.error && r.error.failureCode, code, 'refusal ' + what + ': the run\'s error carries the same code');
    const v = Friendly.friendlyError(r.error ? r.error.message : '', null, { engineAlive: true, code: r.error && r.error.failureCode });
    A.eq(v.kind, kind, 'refusal ' + what + ': COMMS words it as ' + kind + ' (got ' + v.kind + ': ' + String(v.userMessage).slice(0, 80) + ')');
  }
  A.ok(RunOutcome.isProviderCode('auth') && !RunOutcome.isProviderCode('concurrency_limit') && !RunOutcome.isProviderCode('model_no_tools'),
    'refusals: a sign-in refusal is the provider\'s (auth); a host refusal is StarNet\'s own, by name');

  A.report('outcome-unpark.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); A.ok(false, 'outcome-unpark threw'); A.report('outcome-unpark.test'); });
