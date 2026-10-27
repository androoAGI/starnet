/* node test/learning-eligibility.matrix.test.js — memory-truth-1027 (releases#7, quick win 19): ONE rule for which runs
   may teach the station, read by every learning pass.

   Before: each run-end gate carried its own guards and they drifted — a run whose approval was refused stopped reaching
   reflection (10-17) but still reached STUDY and THREAD MINING; a line hand-off stopped reaching reflection, study and
   thread mining (09-30) but still reached the FAILURE REVIEW; tainted / quoted transcripts were spliced out of the
   candidate list by a separate loop. This matrix drives done · failed · denied · cancelled × clean · tainted · quoted ·
   line hop through learning-eligibility.js and asserts the verdict of every pass, then locks that every gate in
   runOnceCore reads that one predicate (and no private copy of the guards is left). */
'use strict';
const A = require('./_assert.js');
const LE = require('../sidecar/learning-eligibility.js');
const { sidecarTopLevelFunction } = require('./helpers/source');

const PASSES = ['reflection', 'study', 'threadmine', 'failure-review', 'trusted-capture'];
const TRANSCRIPT = ['reflection', 'study', 'threadmine', 'failure-review'];
const base = { reflect: true, task: true, internal: false, recovery: false };
const KIND_FACTS = {
  done: { reason: 'done' },
  failed: { reason: 'error' },
  denied: { reason: 'done', denied: true },
  cancelled: { reason: 'cancelled' }
};
const MOD_FACTS = { clean: {}, tainted: { tainted: true }, quoted: { quoted: true }, lineHop: { lineHop: true } };

/* ---------- 1. the matrix ---------- */
// the ONE expected table: which pass may learn from which outcome, under which modifier
const expect = (kind, mod, pass) => {
  if (mod === 'lineHop') return false;                                   // a hand-off frame is never the Commander speaking
  if (pass === 'trusted-capture') return kind === 'done' || kind === 'failed' || kind === 'denied';   // reads only the captured directive
  if (mod !== 'clean') return false;                                     // outside / quoted material withholds every transcript pass
  if (pass === 'failure-review') return kind === 'failed';
  return kind === 'done';                                                // reflection · study · threadmine
};
for (const kind of Object.keys(KIND_FACTS)) {
  for (const mod of Object.keys(MOD_FACTS)) {
    const outcome = LE.runOutcome(Object.assign({}, base, KIND_FACTS[kind], MOD_FACTS[mod]));
    A.eq(outcome.kind, kind, 'classified ' + kind + ' (' + mod + ')');
    const verdict = LE.passes(outcome);
    for (const pass of PASSES) A.eq(verdict[pass], expect(kind, mod, pass), kind + ' × ' + mod + ' → ' + pass);
    // IDENTICAL eligibility: the three passes that read a finished run's transcript always agree, and the failure
    // review mirrors them on a failed run — no pass has a private exception
    A.ok(verdict.reflection === verdict.study && verdict.study === verdict.threadmine, kind + ' × ' + mod + ': reflection, study and thread mining agree');
    const doneTwin = LE.passes(LE.runOutcome(Object.assign({}, base, KIND_FACTS.done, MOD_FACTS[mod]))).reflection;
    const failedTwin = LE.passes(LE.runOutcome(Object.assign({}, base, KIND_FACTS.failed, MOD_FACTS[mod])))['failure-review'];
    A.eq(failedTwin, doneTwin, mod + ': the failure review applies the same modifiers to a failed run as reflection does to a done one');
  }
}
// quick win 19 by name: a refused approval reaches no transcript pass; a line hop reaches no pass, the failure review included
{
  const denied = LE.passes(LE.runOutcome(Object.assign({}, base, { reason: 'done', denied: true })));
  A.ok(!denied.study && !denied.threadmine && !denied.reflection, 'QW19: a run whose approval was refused is studied and thread-mined no more than it is reflected on');
  /* a refused approval that then FAILED stays a failed run (review 10-27: the lane must not remove the failure review the
     pre-lane gate gave it). It is failure-reviewed, the Commander's own words still count, what it raised is marked
     "failed run", and no pass that reads a DONE run's transcript reads it. The review's own floor refuses a lesson that
     routes around the approval, so a refusal never becomes "skip the approval". */
  const deniedFailOutcome = LE.runOutcome(Object.assign({}, base, { reason: 'max_iters', denied: true }));
  const deniedFail = LE.passes(deniedFailOutcome);
  A.ok(deniedFailOutcome.kind === 'failed' && deniedFailOutcome.denied === true, 'a refused approval that then failed is kind failed, denied as a modifier: ' + JSON.stringify(deniedFailOutcome));
  A.ok(deniedFail['failure-review'] && deniedFail['trusted-capture'] && !deniedFail.reflection && !deniedFail.study && !deniedFail.threadmine, 'it is failure-reviewed (as before this lane), and the Commander\'s own words still count');
  A.eq(deniedFail.kind, 'failed', 'the kind its proposals carry is failed, so MEMORY > Awaiting your decision marks them');
  const FR = require('../sidecar/failreview.js');
  A.ok(FR.lowValue('Skip the approval step and write the report directly next time') && !FR.lowValue('Never skip the approval step when writing report files'), 'the failure review never banks a lesson that routes around an approval');
  A.ok(LE.runOutcome(Object.assign({}, base, { reason: 'done', denied: true })).kind === 'denied', 'a FINISHED run with a refused approval is denied (no lesson from work that is not what was asked)');
  const hop = LE.passes(LE.runOutcome(Object.assign({}, base, { reason: 'error', lineHop: true })));
  A.eq(hop['failure-review'], false, 'QW19: a failed line hand-off is not failure-reviewed (its USER turn is the line\'s frame)');
  A.eq(LE.learningEligible(LE.runOutcome(Object.assign({}, base, { reason: 'error', lineHop: true })), 'failure-review').reason, 'line_hop', 'and the verdict names why');
}
// every pass needs a real-work run, and an unfinished run teaches nothing
{
  for (const [why, facts] of [['internal', { internal: true }], ['recovery', { recovery: true }], ['not_a_task', { task: false }], ['not_a_learning_run', { reflect: false }]]) {
    for (const kind of ['done', 'failed']) {
      const o = LE.runOutcome(Object.assign({}, base, KIND_FACTS[kind], facts));
      A.ok(PASSES.every(p => !LE.learningEligible(o, p).ok) && LE.learningEligible(o, 'reflection').reason === why, why + ' (' + kind + '): no pass learns');
    }
  }
  for (const facts of [{ reason: 'done', truncated: true }, { reason: 'done', clarifying: true }, { reason: 'empty' }, { reason: 'done', aborted: true }]) {
    const o = LE.runOutcome(Object.assign({}, base, facts));
    A.ok(PASSES.every(p => !LE.learningEligible(o, p).ok), 'no pass learns from ' + JSON.stringify(facts) + ' (' + o.kind + ')');
  }
  A.eq(LE.runOutcome(Object.assign({}, base, { reason: 'refusal' })).kind, 'failed', 'a provider refusal is a failure (the review decides separately whether it can read it)');
  A.eq(LE.learningEligible({ base: true, kind: 'done' }, 'scout').reason, 'unknown_pass', 'an unknown pass is refused, never waved through');
}

/* ---------- 2. every gate in runOnceCore reads the one predicate ---------- */
{
  const core = sidecarTopLevelFunction('runOnceCore');
  A.ok(core.length > 1000, 'runOnceCore sliced');
  const at = core.indexOf('const _learn = LearningEligibility.passes(LearningEligibility.runOutcome(');
  A.ok(at > 0, 'the run is classified once, through learning-eligibility.js');
  const decl = core.slice(at, core.indexOf('}));', at));
  for (const fact of ['denied: refusedAction(execution.toolTraceList())', 'tainted: !!execution.taintedBy()', 'quoted: quotedLearning', 'lineHop: _lineHop', 'aborted: signal.aborted', 'recovery: !!o.recovery', 'internal: !!internal'])
    A.ok(decl.indexOf(fact) >= 0, 'the outcome is built from the run\'s own fact: ' + fact);
  const gate = name => { const g = core.indexOf('const ' + name + ' = '); return g < 0 ? '' : core.slice(g, core.indexOf(';\n', g)); };
  const gates = { reflection: gate('_gateReflect'), study: gate('_gateStudy'), threadmine: gate('_gateThreadmine'), 'failure-review': gate('_gateFailReview') };
  for (const [pass, text] of Object.entries(gates)) {
    A.ok(text && text.indexOf("_learn['" + pass + "']") >= 0 || text.indexOf('_learn.' + pass + ' ') >= 0, pass + ' gate reads the predicate: ' + text.slice(0, 120));
    A.ok(!/_lineHop|refusedAction|_auxDone|_auxFail|learningTaint/.test(text), pass + ' gate keeps no private copy of the guards');
  }
  A.ok(/if \(_learn\['trusted-capture'\]\) \{\s*await captureTrustedLearning\(/.test(core), 'trusted capture is gated by the same predicate');
  A.ok(!/'reflection', 'failure-review', 'study', 'threadmine'\]/.test(core), 'the separate taint splice of the four transcript passes is gone (the predicate reads taint and quotes)');
  A.ok(core.indexOf('const _lineHop =') < at && core.indexOf('const quotedLearning =') < at, 'the facts the outcome reads are known before it is built');
  A.ok(core.indexOf("if (_learn['trusted-capture'])") > at && gates.reflection && core.indexOf('const _gateReflect = ') > at, 'and every reader comes after it');
}

/* ---------- 3. proposals carry their run outcome, so the deck can say "from a failed run" (releases#7) ---------- */
(async () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const { readSidecarSource } = require('./helpers/source');
  const MS = require('../sidecar/memory-store.js');
  let pending = [];
  const store = { get: () => pending, update: async (k, fn) => { const n = fn(pending); if (n !== undefined) pending = n; } };
  await MS.appendPending(store, 'agent', 'run_f', [{ id: 'owner_1', kind: 'profile', content: 'Always CC finance on invoices.', outcome: 'failed' }, { id: 'p2', kind: 'fact', content: 'x y z' }], 1);
  A.eq(MS.listPending(store, 'agent').map(p => p.outcome || null), ['failed', null], 'the durable queue keeps a proposal\'s run outcome (and adds none it was not given)');

  const src = readSidecarSource();
  // the trusted capture's held statement carries the run outcome (executed from the sidecar, like test/trusted-learning)
  {
    const L = require('../sidecar/trusted-learning.js'), context = require('../sidecar/context.js'), reflectMod = require('../sidecar/reflect.js'), NB = require('../sidecar/tools/builtin/notebook.js');
    const start = src.indexOf('async function captureTrustedLearning('), end = src.indexOf('async function appendDeclined(', start);
    const queued = [], status = {};
    const sandbox = { TrustedLearning: L, highStakes: reflectMod.highStakes, redact: context.redact, recordFromProposal: reflectMod.recordFromProposal,
      reviseRecord: NB.reviseRecord, supersedeRecords: NB.supersedeRecords, supersessionTargets: NB.supersessionTargets, memcore: require('../sidecar/memcore.js'),
      personalizationStore: { read: () => ({ enabled: true }) }, memoryConfig: { reflectEnabled: true }, buildDeclinedIndex: () => ({ has: () => false }),
      notebookStore: { update: async () => {} }, recordRunReceipt: () => {}, stashProposals: () => {}, queuePending: async (a, r, items) => { queued.push(...items); },
      chanEmit: () => {}, hookSpine: { invoke() {} }, QuestSweeps: { learnedFactKeys: () => [] }, questStore: { openForAgent: () => [] },
      skillEvaluationIo: { get: k => status[k], set: (k, v) => { status[k] = v; } }, failNote: (w, e) => { throw e; }, swallow: () => () => {},
      skillStore: {}, skillNameFromReflection: s => s, console: { log() {}, warn() {} }, Date };
    const api = vm.runInNewContext(src.slice(start, end) + '\n({ captureTrustedLearning })', sandbox);
    const content = 'Always CC my wife at jane.doe@example.com on invoices.';
    await api.captureTrustedLearning({ agentId: 'nova', runId: 'run_failed', projectRoot: '', input: { source: 'interactive-owner', content }, outcome: 'failed',
      learningEvidence: L.evidence({ runId: 'run_failed', trustedInput: { source: 'interactive-owner', content } }) });
    A.ok(queued.length === 1 && queued[0].outcome === 'failed', 'a statement a FAILED run held for review carries that outcome: ' + JSON.stringify(queued));
    A.eq(status['learning:nova'][0].outcome, 'failed', 'and the learning receipt records how the run ended');
  }
  // the failure review's own lessons, the reflection deck, and the pending route that serves the deck
  {
    const { sidecarTopLevelFunction } = require('./helpers/source');
    A.ok(/origin: Failreview\.ORIGIN, outcome: 'failed' \}/.test(sidecarTopLevelFunction('runFailureReview')), 'failure-review proposals carry outcome failed');
    A.ok(/origin: origin, outcome: 'done',/.test(sidecarTopLevelFunction('runReflection')), 'reflection proposals carry outcome done');
    const at = src.indexOf('function servePending(req, res)');
    const fn = src.slice(at, src.indexOf('\n}\n', at) + 2);
    let sent = null;
    const serve = vm.runInNewContext('(' + fn + ')', { respondJson: (res, code, obj) => { sent = { code, obj }; }, URL, isAgentId: () => true, redact: x => x,
      listPending: () => MS.listPending(store, 'agent'), readRouteFailure: () => ({ error: 'x' }) });
    serve({ url: '/api/memory/pending?agent=agent' }, {});
    A.ok(sent && sent.code === 200 && sent.obj.pending[0].outcome === 'failed' && !('outcome' in sent.obj.pending[1]), 'GET /api/memory/pending serves the outcome to the deck: ' + JSON.stringify(sent && sent.obj));
  }
  // MEMORY > Awaiting your decision marks it
  {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
    const at = ui.indexOf('function pendingCard(p, a)');
    const card = ui.slice(at, ui.indexOf('\n  }\n', at));
    A.ok(at > 0 && /p\.outcome === 'failed' && p\.origin !== 'failure-review'/.test(card) && /ORIGIN_LABEL\['failure-review'\]/.test(card), 'the pending card marks a failed run\'s proposal with the "⚠ failed run" chip the failure review already wears');
    // …and so does the COMMS Keep/Edit/Discard deck the run end raises (spec: "the deck can say from a failed run")
    const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    const dAt = chat.indexOf('function renderTurninBatch(batch)');
    const deck = chat.slice(dAt, chat.indexOf('\n  function ', dAt + 10));
    const cur = deck.slice(deck.indexOf('function renderCurrent()'), deck.indexOf('slot.appendChild(item)', deck.indexOf('function renderCurrent()')));
    const mark = cur.slice(cur.indexOf("if (prop.outcome === 'failed')"), cur.indexOf('\n', cur.indexOf("if (prop.outcome === 'failed')")));
    A.ok(dAt > 0 && mark.length > 30 && /className = 'turnin-evidence'/.test(mark) && /from a failed run/.test(mark), 'the COMMS deck card marks a proposal a failed run raised: ' + mark.slice(0, 160));
    // the item is a two-column grid (kind | text): a third pill crushes the text column to one character a line (seen in the
    // 10-27 page proof); the deck's evidence line claims a full row instead, between the belief and its buttons
    A.ok(!/turnin-kind/.test(mark) && cur.indexOf('item.appendChild(text)') < cur.indexOf(mark) && cur.indexOf(mark) < cur.indexOf('item.appendChild(btns)'), 'the mark is a full-row evidence line after the belief, never a third pill in the kind/text grid');
  }
  A.report('learning-eligibility.matrix');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
