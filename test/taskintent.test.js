/* node test/taskintent.test.js — task-context protocol + durable Task Brief lifecycle. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const TaskIntent = require('../frontend/app/fork.js').TaskIntent;
const CommanderContext = require('../sidecar/commander-context.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const Policy = require('../sidecar/taskbrief-policy.js');
const { registerTaskBriefTools } = require('../sidecar/taskbrief-tools.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const LoopModule = require('../sidecar/loop.js');
const Loop = LoopModule._internals;

function memFs() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); }, renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}, _files: files
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const makeStore = disk => makeTaskBriefStore({ fs: disk, path, workspaces: '/ws', writeDurable });

const parsed = TaskIntent.parse('I can build that.\nTASK_QUESTION: who is this dashboard primarily for? || operators | executives | customers');
const material = q => Object.assign({
  dimension: 'audience', recommended: 'operators', reason: 'Audience changes information density and navigation.', discoverable: false
}, parsed, q || {});
A.eq(parsed.question, 'who is this dashboard primarily for?', 'protocol parses one concrete question');
A.eq(parsed.options, ['operators', 'executives', 'customers'], 'protocol parses 2-3 options');
A.eq(TaskIntent.strip('Ready.\nTASK_QUESTION: format? || PDF | HTML'), 'Ready.', 'internal marker is stripped from the visible reply');
A.eq(TaskIntent.parse('TASK_QUESTION: only one? || yes'), null, 'one-option marker fails closed instead of rendering a broken choice');
A.eq(TaskIntent.answerMessage('who is this for?', 'operators'), 'operators', 'choice continuation preserves the actual answer without UI annotation noise');
const doctrine = TaskIntent.directive('KNOWN: existing React admin shell');
A.ok(/Research before asking/.test(doctrine) && /what does good look like/.test(doctrine), 'doctrine says discover first and bans vague questions');
A.ok(/use your judgment/i.test(doctrine) && /Proceed immediately/.test(doctrine), 'doctrine preserves autonomy for clear/defaultable tasks');
A.ok(/six is an emergency ceiling, not a target/.test(doctrine) && /at most two asking calls/.test(doctrine), 'conversation has a bounded ceiling while legacy choices retain their shorter budget');
A.ok(/Listen before choosing the next question/.test(doctrine) && /multiSelect:true/.test(doctrine), 'discovery adapts after each answer while concrete multi-select choices remain supported');
A.ok(/brief_proceed/.test(doctrine) && /brief_ask/.test(doctrine), 'doctrine names the structured host controls');

const replyCases = [
  ['cancel', 'cancel'], ['never mind.', 'cancel'], ['drop that', 'cancel'],
  ['instead, export a PDF', 'replace'], ['new task: audit billing', 'replace'], ['operators', 'answer']
];
for (const [input, action] of replyCases) {
  A.eq(Policy.routeReply(input).action, action, 'reply router: ' + JSON.stringify(input) + ' -> ' + action);
  A.eq(TaskIntent.routeReply(input).action, action, 'browser reply router matches host: ' + JSON.stringify(input));
}
const valid = Policy.validateQuestion(material(), { questions: [] });
A.eq(valid.ok, true, 'a concrete researched material decision passes host validation');
A.eq(Policy.validateQuestion(material({ question: 'What does good look like?', options: ['simple', 'detailed'] }), { questions: [] }).ok, false, 'vague quality prompts fail closed');
A.eq(Policy.validateQuestion(material({ options: ['operators', 'Operators'] }), { questions: [] }).ok, false, 'duplicate options do not masquerade as distinct choices');
A.eq(Policy.validateQuestion(material({ discoverable: true }), { questions: [] }).ok, false, 'a discoverable gap must be researched instead of asked');
// a recommendation that matches no visible choice is DROPPED (no ★), never a rejection — a rejection sent the model to
// the marker fallback and it asked the same question twice, in prose and as a card (live walkthrough 2026-10-13)
{
  const unlisted = Policy.validateQuestion(material({ recommended: 'not listed' }), { questions: [] });
  A.eq(unlisted.ok, true, 'an unlisted recommendation does not reject the question');
  A.eq(unlisted.question.recommended, '', 'and no chip is starred for it — the host never guesses which one was meant');
}
// hiring is setup, not the deliverable: a briefExempt tool passes an unsettled brief; every other write still waits
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'write', briefExempt: true }).ok, true, 'team.summon (briefExempt) is never held behind the Task Brief');
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'write' }).ok, false, 'any other consequential tool still waits for brief_proceed');
A.ok(/name: 'team\.summon'[^\n]*\n\s*briefExempt: true/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'orchestration.js'), 'utf8')),
  'team.summon is the tool that carries briefExempt');
// …and the REGISTERED tool keeps it: the host's gate reads registry.get(name), whose makeTool used to drop the flag, so every hire
// was still "paused — settling the task first" on a live station (final-rc-seams live proof, 2026-10-14)
{
  const { makeRegistry } = require('../sidecar/tools/registry.js');
  const reg = makeRegistry();
  const hire = reg.register({ name: 'team.summon', capability: 'orchestrator', scope: 'write', requiresConsent: true, briefExempt: true, run: async () => ({ content: 'ok' }) });
  const write = reg.register({ name: 'fs.write', capability: 'files', scope: 'write', requiresConsent: true, run: async () => ({ content: 'ok' }) });
  A.eq(Policy.canMutate({ status: 'ready' }, reg.get('team.summon')).ok, true, 'the registered team.summon passes an unsettled brief (the flag survives registration)');
  A.eq([hire.briefExempt, write.briefExempt], [true, false], 'only a tool that opts in is exempt');
  A.eq(Policy.canMutate({ status: 'ready' }, reg.get('fs.write')).ok, false, 'a registered write still waits for brief_proceed');
}
/* SEATING CREW IS SETUP TOO (rc walk 10-14, Haiku 4.5): "bring two crew in to help me write a launch post" picked
   station.control group.add and the gate refused it until a brief interview finished. The registered station.control
   exempts group.add by its args — every other station change, and station.power, still waits. */
{
  const { makeRegistry } = require('../sidecar/tools/registry.js');
  const { makeStationControlTools } = require('../sidecar/tools/builtin/station-control.js');
  const reg = makeRegistry();
  makeStationControlTools({}).register(reg);
  const control = reg.get('station.control'), power = reg.get('station.power');
  const ready = { status: 'ready' };
  A.eq(Policy.canMutate(ready, control, { name: 'station.control', args: { action: 'group.add', args: { agents: ['COPY', 'STRATEGY'] } } }).ok, true, 'group.add passes an unsettled brief');
  A.eq(Policy.canMutate(ready, control, { name: 'station.control', args: { setting: 'group.add', agents: 'COPY' } }).ok, true, 'however the model spells the call (readCall)');
  A.eq(Policy.canMutate(ready, control, { name: 'station.control', args: { action: 'session.delete' } }).ok, false, 'any other station change still waits');
  A.eq(Policy.canMutate(ready, control).ok, false, 'no call, no exemption (fail closed)');
  A.eq(Policy.canMutate(ready, power, { name: 'station.power', args: { action: 'group.add' } }).ok, false, 'station.power never qualifies');
  A.ok(/const gate = TaskBriefPolicy\.canMutate\(taskBriefState\.brief, liveTool, c\);/.test(readSidecarSource()), 'the host gate hands the call to the policy');
}

// RECOMMENDATION MATCHING — a formatting slip must not silently cost the Commander the ★ suggestion, and a
// rescue must never resolve to the WRONG chip. Every accepted form returns the CANONICAL option text.
{
  const opts = ['operators', 'executives', 'customers'];
  for (const near of ['operators', 'Operators', 'operators.', 'operators!', '"operators"', '“operators”', 'the operators', '  operators  ']) {
    A.eq(Policy.matchOption(opts, near), 'operators', 'near-miss recommendation resolves to the canonical option: ' + JSON.stringify(near));
    A.eq(Policy.validateQuestion(material({ recommended: near }), { questions: [] }).question.recommended, 'operators', 'the stored recommendation is canonical, never the model spelling: ' + JSON.stringify(near));
  }
  for (const miss of ['', 'not listed', 'ops team', 'whoever']) {
    A.eq(Policy.matchOption(opts, miss), '', 'a genuine miss stays rejected rather than guessing: ' + JSON.stringify(miss));
  }
  A.eq(Policy.matchOption(['ship it', 'do not ship it'], 'ship'), '', 'an ambiguous substring matching two options fails closed');
  A.eq(Policy.matchOption(['ship it', 'do not ship it'], 'do not ship it.'), 'do not ship it', 'negation is never collapsed into its opposite');
  A.eq(Policy.matchOption(['A. keep it', 'B. drop it'], 'keep it'), 'A. keep it', 'an enumerator prefix still resolves uniquely');
  A.eq(Policy.matchOption(['2) ship', '3) hold'], 'ship'), '2) ship', 'a numeric enumerator resolves too');
  // NEGATION INVERSION (caught in review 2026-07-24). A substring tier used to rescue enumerators, but the
  // negated option CONTAINS the positive one, so every one of these resolved to the exact opposite of intent
  // and the uniqueness guard could not help — exactly one option matched, it was just the wrong one.
  A.eq(Policy.matchOption(['publish', 'do not publish'], "don't publish"), '', 'a contracted negation never resolves to its opposite');
  A.eq(Policy.matchOption(['include tests', 'skip tests'], 'do not include tests'), '', 'a spelled-out negation never resolves to its opposite');
  A.eq(Policy.matchOption(['dark', 'light'], 'not dark'), '', '"not dark" is not a vote for dark');
  A.eq(Policy.matchOption(['operators', 'executives'], 'anyone but operators'), '', 'an exclusion never resolves to the excluded option');
  A.eq(Policy.matchOption(['operators', 'executives'], 'definitely not operators'), '', 'an emphatic exclusion never resolves to the excluded option');
}

// NEAR-DUPLICATE OPTIONS — "operators", "operators." and "the operators" are ONE choice offered three times.
// Exact-string dedupe let them through as a fake trilemma; both producers now collapse them identically.
{
  const ask = (options) => Policy.validateQuestion(material({ options, recommended: options[0] }), { questions: [] });
  A.eq(ask(['operators', 'operators.', 'the operators']).ok, false, 'three spellings of one choice is not a decision');
  A.eq(ask(['PDF', 'PDF.']).ok, false, 'a punctuation-only difference is not a second option');
  A.eq(ask(['yes', 'yes!', 'no']).question.options, ['yes', 'no'], 'a fake trilemma collapses to the honest dilemma');
  A.eq(ask(['operators', 'executives', 'customers']).question.options, ['operators', 'executives', 'customers'], 'genuinely distinct options are untouched');
  A.eq(TaskIntent.dedupeOptions(['x', '  ', '.', 'X']), ['x'], 'blank and punctuation-only entries are never offered as choices');
  // Deduping is deliberately STRICTER than recommendation-matching: an article carries meaning between two
  // options ("the doc" = the existing one, "a doc" = a new one), so folding them destroyed real alternatives
  // and then rejected the whole question as "not a decision".
  A.eq(TaskIntent.dedupeOptions(['the doc', 'a doc']), ['the doc', 'a doc'], 'definite vs indefinite are different choices, not a duplicate');
  A.eq(TaskIntent.dedupeOptions(['operators', 'operators.', 'the operators']), ['operators'], 'a bare noun and its definite form ARE one choice');
  A.eq(TaskIntent.dedupeOptions(['a report', 'the report']), ['a report', 'the report'], 'a-vs-the survives: make a new one vs use the existing one');
  A.eq(ask(['operators', 'operators.', 'the operators']).ok, false, 'three spellings of one choice is still not a decision');
  // The MARKER path is the last resort and has NO retry loop, so dedupe there is best-effort: nulling the
  // parse does not mean "fail closed" upstream, it means "no question asked" — the brief completes as done
  // and the raw TASK_QUESTION: line leaks into the transcript and out to channels.
  A.eq(TaskIntent.parse('TASK_QUESTION: who is this for? || the operators | operators.').options, ['the operators', 'operators.'], 'a recoverable marker question is never destroyed by dedupe');
  A.eq(TaskIntent.parse('TASK_QUESTION: pick? || dark | Dark | dark.').options, ['dark', 'Dark', 'dark.'], 'an all-duplicate marker keeps its raw options rather than leaking the protocol line');
  A.eq(TaskIntent.parse('TASK_QUESTION: pick? || dark | dark. | light').options, ['dark', 'light'], 'a marker with a real alternative still dedupes');
  // model-controlled input: cap BEFORE the pairwise compare or a huge option list blocks the sidecar
  const huge = Array.from({ length: 20000 }, (_, i) => 'opt' + i);
  const t0 = Date.now(); TaskIntent.dedupeOptions(huge); const spent = Date.now() - t0;
  A.ok(spent < 250, 'a pathological option list cannot block the single-process sidecar (took ' + spent + 'ms)');
}
A.eq(Policy.validateQuestion(material({ dimension: 'vibes' }), { questions: [] }).ok, false, 'unknown decision dimensions fail closed');
A.eq(Policy.validateQuestion(material({ newBlocker: false }), { questions: [{ answer: 'operators' }] }).ok, false, 'second question requires a newly exposed blocker');
A.eq(Policy.validateQuestion(material({ newBlocker: true }), { questions: [{ answer: '' }] }).ok, false, 'second question cannot precede the first answer');
A.eq(Policy.validateQuestion(material(), { questions: [{ answer: 'a' }, { answer: 'b' }] }).ok, false, 'host enforces the whole-task two-question cap');
A.eq(Policy.validateProceed({ objective: '' }).ok, false, 'empty settled briefs cannot unlock mutation');
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'write' }).ok, false, 'writes are locked while intent is unsettled');
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'read' }).ok, true, 'reads remain available for pre-question research');
A.eq(Policy.canMutate({ status: 'executing' }, { scope: 'execute' }).ok, true, 'settling the brief unlocks consequential tools');

(async () => {
  const disk = memFs(); const s1 = makeStore(disk);
  const first = await s1.prepare({ id: 'tb_run1', key: 'stream:w1', streamId: 'w1', agentId: 'agent', text: 'Build me a dashboard' }, 100);
  A.eq(first.status, 'ready', 'a new directive opens a ready brief');
  await s1.ask(first.id, material(), 110);
  A.eq(s1.active('stream:w1').status, 'clarifying', 'a material question leaves the brief waiting');

  const s2 = makeStore(disk); // restart: fresh store over the same durable bytes
  const waiting = s2.active('stream:w1');
  A.eq(waiting.originalDirective, 'Build me a dashboard', 'original directive survives a store restart');
  A.eq(waiting.questions[0].text, parsed.question, 'visible question survives restart');

  const resumed = await s2.prepare({ id: 'ignored', key: 'stream:w1', text: 'operators', taskAction: 'answer' }, 120);
  A.eq(resumed.id, first.id, 'answer resumes the SAME task brief');
  A.eq(resumed.questions[0].answer, 'operators', 'answer is recorded on the pending decision');
  A.eq(resumed.status, 'ready', 'answered brief is ready to execute');
  const settled = await s2.proceed(resumed.id, { objective: 'Build the requested dashboard', deliverable: 'Existing admin shell', assumptions: ['Use the existing admin shell'] }, 125);
  A.eq(settled.status, 'executing', 'structured proceed durably unlocks execution');
  A.eq(settled.settled.objective, 'Build the requested dashboard', 'settled brief preserves the explicit objective');
  await s2.complete(resumed.id, 'run2', 130, ['Use the existing admin shell']);
  A.eq(s2.active('stream:w1').status, 'done', 'successful continuation completes the brief');

  // Same decision twice becomes weak observed relationship evidence, never a standing order.
  const second = await s2.prepare({ id: 'tb_run3', key: 'stream:w2', text: 'Build another dashboard' }, 200);
  await s2.ask(second.id, material(), 210); await s2.prepare({ key: 'stream:w2', text: 'operators' }, 220); await s2.complete(second.id, 'run4', 230);
  A.eq(s2.patterns(5)[0].count, 2, 'repeated identical decisions compound into bounded weak evidence');

  // A DIFFERENT question in the same dimension sharing an answer is a different decision — never merged.
  const cousin = await s2.prepare({ id: 'tb_cousin', key: 'stream:w2b', text: 'Build a status page' }, 232);
  await s2.ask(cousin.id, material({ question: 'Who will use this status page day to day?' }), 234);
  await s2.prepare({ key: 'stream:w2b', text: 'operators' }, 236); await s2.complete(cousin.id, 'run4b', 238);
  A.eq(s2.patterns(5).length, 1, 'same dimension + same answer under a different question never merges into the bin');

  const incomplete = await s2.prepare({ id: 'tb_incomplete', key: 'stream:w3', text: 'Build a third dashboard' }, 240);
  await s2.ask(incomplete.id, material({ question: 'Which group owns this dashboard?' }), 250);
  await s2.prepare({ key: 'stream:w3', text: 'operators' }, 260);
  A.eq(s2.patterns(5)[0].count, 2, 'unfinished work never contributes relationship evidence');

  // GROUNDED RECOMMENDATION — the suggestion drawn from the Commander's OWN answered history. It is the only
  // provable one on this surface, so it must appear ONLY when actually observed (>=2), and never leak across
  // questions or outlive its own answer.
  {
    const open = { text: parsed.question, options: parsed.options, answer: '' };
    const g = s2.groundedFor(open);
    A.ok(g && g.option === 'operators' && g.count === 2, 'a decision answered twice becomes a grounded suggestion with its real count');
    A.eq(s2.groundedFor({ text: parsed.question, options: parsed.options, answer: 'customers' }), null, 'an already-answered question is never re-suggested');
    A.eq(s2.groundedFor({ text: 'what output format do you want?', options: ['PDF', 'HTML'], answer: '' }), null, 'a different question never inherits another decision history');
    A.eq(s2.groundedFor({ text: parsed.question, options: ['interns', 'vendors'], answer: '' }), null, 'history that is no longer an offered option cannot ground a chip');
    A.eq(s2.groundedFor({ text: parsed.question, options: ['operators'], answer: '' }), null, 'a one-option question is never grounded');
    // the count is REAL: it is the same number patterns() reports, not a fabricated confidence
    A.eq(g.count, s2.patterns(5).find(p => p.answer === 'operators').count, 'the displayed count IS the observed pattern count');
  }

  // GROUNDED HONESTY (caught in review 2026-07-24). This is the ONE surface labelled provable, so every way it
  // could misquote the Commander is a correctness bug, not a polish item.
  {
    const SKIP = 'Use your judgment. Choose the most sensible reversible default and continue the original task.';
    const Q = parsed.question, OPTS = parsed.options;
    let k = 0;
    const run = async (store, answer, opts) => {
      const t = 5000 + (k * 10), uid = 'gh' + (k++), key = 'stream:' + uid;
      const b = await store.prepare({ id: 'tb_' + uid, key, streamId: uid, text: 'Build a dashboard' }, t);
      await store.ask(b.id, { dimension: 'audience', question: Q, text: Q, options: opts || OPTS, recommended: (opts || OPTS)[0], reason: 'matters', discoverable: false }, t + 1);
      await store.prepare({ key, text: answer }, t + 2);
      await store.proceed(b.id, { objective: 'ship' }, t + 3); await store.complete(b.id, 'r' + uid, t + 4);
    };
    const open = { text: Q, options: OPTS, answer: '' };

    const neg = makeStore(memFs());
    await run(neg, 'not operators'); await run(neg, 'not operators');
    A.eq(neg.groundedFor(open), null, 'a negated answer never becomes a "you chose operators" claim');

    const skip = makeStore(memFs());
    await run(skip, SKIP); await run(skip, SKIP);
    A.eq(skip.groundedFor(open), null, 'declining to choose twice is not a choice made twice');

    const tie = makeStore(memFs());
    await run(tie, 'operators'); await run(tie, 'operators'); await run(tie, 'executives'); await run(tie, 'executives');
    A.eq(tie.groundedFor(open), null, 'a dead heat is not a preference');
    await run(tie, 'operators');
    A.eq(tie.groundedFor(open).count, 3, 'a clear winner still surfaces with its real count');

    const split = makeStore(memFs());
    await run(split, 'operators'); await run(split, 'operators'); await run(split, 'operators.'); await run(split, 'operators.');
    const sg = split.groundedFor(open);
    A.eq([sg.option, sg.count], ['operators', 4], 'counts fold across spellings of the same option instead of understating');
  }

  // ASK-WORTHINESS — a dimension the Commander habitually waves off with "use your judgment" stops being
  // asked about. Conservative on purpose: a false suppression silently guesses at something they cared about.
  {
    const SKIP = 'Use your judgment. Choose the most sensible reversible default and continue the original task.';
    const s3 = makeStore(memFs());
    let n = 0;
    const decide = async (dimension, answer) => {
      const t = 1000 + (n * 10), uid = dimension + '_' + (n++), key = 'stream:' + uid;
      const text = 'which ' + dimension + ' applies for ' + uid + '?';
      const b = await s3.prepare({ id: 'tb_' + uid, key, streamId: uid, text: 'Do a thing' }, t);
      await s3.ask(b.id, { dimension, question: text, text, options: ['alpha', 'beta'], recommended: 'alpha', reason: 'matters', discoverable: false }, t + 1);
      await s3.prepare({ key, text: answer }, t + 2);
      await s3.proceed(b.id, { objective: 'ship' }, t + 3);
      await s3.complete(b.id, 'run_' + uid, t + 4);
    };
    await decide('scope', SKIP); await decide('scope', SKIP);
    A.eq(s3.deferredDimensions().length, 0, 'two deferrals is not yet a habit — the question still gets asked');
    await decide('scope', SKIP);
    A.eq(s3.deferredDimensions().join(), 'scope', 'a third deferral in one dimension stops the agent asking about it');
    // engagement protects a dimension: real answers outweigh the skips
    for (let i = 0; i < 3; i++) await decide('audience', SKIP);
    for (let i = 0; i < 5; i++) await decide('audience', 'operators');
    A.eq(s3.deferredDimensions().indexOf('audience'), -1, 'a dimension they actually engage with is never suppressed by a minority of skips');
    // an answer that merely MENTIONS judgment is a real answer, not a deferral
    const s4 = makeStore(memFs()); n = 0;
    const s4decide = async () => {
      const t = 1000 + (n * 10), uid = 'safety_' + (n++), key = 'stream:' + uid;
      const text = 'which safety bar for ' + uid + '?';
      const b = await s4.prepare({ id: 'tb_' + uid, key, streamId: uid, text: 'Do a thing' }, t);
      await s4.ask(b.id, { dimension: 'safety', question: text, text, options: ['alpha', 'beta'], recommended: 'alpha', reason: 'matters', discoverable: false }, t + 1);
      await s4.prepare({ key, text: 'I trust your judgment on encryption, but use AES-256' }, t + 2);
      await s4.proceed(b.id, { objective: 'ship' }, t + 3); await s4.complete(b.id, 'r_' + uid, t + 4);
    };
    await s4decide(); await s4decide(); await s4decide();
    A.eq(s4.deferredDimensions().length, 0, 'an answer that merely mentions judgment is never miscounted as a deferral');

    // A deferral that still STATES a constraint is an engaged answer — suppressing the dimension would mute
    // decisions the Commander is actively steering.
    const s5 = makeStore(memFs()); n = 0;
    for (const a of ['Use your judgment, but keep it under 3 pages', 'Use your judgment — stay inside the api package', 'use your judgment but do not touch billing']) {
      const t = 1000 + (n * 10), uid = 'eng_' + (n++), key = 'stream:' + uid, text = 'how wide ' + uid + '?';
      const b = await s5.prepare({ id: 'tb_' + uid, key, streamId: uid, text: 'Do a thing' }, t);
      await s5.ask(b.id, { dimension: 'scope', question: text, text, options: ['alpha', 'beta'], recommended: 'alpha', reason: 'matters', discoverable: false }, t + 1);
      await s5.prepare({ key, text: a }, t + 2);
      await s5.proceed(b.id, { objective: 'ship' }, t + 3); await s5.complete(b.id, 'r_' + uid, t + 4);
    }
    A.eq(s5.deferredDimensions(), [], 'a deferral carrying a real constraint does not suppress the dimension');

    // RECOVERY. Suppression blocks brief_ask, the only path that records a dimension — so without a way back
    // the latch is permanent by construction and there is no reset route, setting, or UI.
    const s6 = makeStore(memFs()); n = 0;
    const s6decide = async (dimension, answer) => {
      const t = 1000 + (n * 10), uid = 'rec_' + (n++), key = 'stream:' + uid, text = 'which ' + dimension + ' for ' + uid + '?';
      const b = await s6.prepare({ id: 'tb_' + uid, key, streamId: uid, text: 'Do a thing' }, t);
      await s6.ask(b.id, { dimension, question: text, text, options: ['alpha', 'beta'], recommended: 'alpha', reason: 'matters', discoverable: false }, t + 1);
      await s6.prepare({ key, text: answer }, t + 2);
      await s6.proceed(b.id, { objective: 'ship' }, t + 3); await s6.complete(b.id, 'r_' + uid, t + 4);
    };
    for (let i = 0; i < 3; i++) await s6decide('scope', SKIP);
    A.eq(s6.deferredDimensions(), ['scope'], 'three pure deferrals suppress the dimension');
    for (let i = 0; i < 8; i++) await s6decide('audience', 'alpha');
    A.eq(s6.deferredDimensions(), [], 'a probe is allowed through after PROBE_GAP completed tasks');
    await s6decide('scope', 'alpha');
    A.eq(s6.deferredDimensions(), [], 'answering the probe for real re-opens the dimension immediately');
    for (let i = 0; i < 3; i++) await s6decide('scope', SKIP);
    A.eq(s6.deferredDimensions(), ['scope'], 'and deferring again re-suppresses it — the signal stays live in both directions');
  }

  const cancelled = await s2.prepare({ id: 'tb_cancel', key: 'stream:cancel', text: 'Build a report' }, 300);
  await s2.ask(cancelled.id, material(), 310);
  const cancelResult = await s2.prepare({ key: 'stream:cancel', text: 'never mind' }, 320);
  A.eq(cancelResult.status, 'cancelled', 'explicit cancel closes rather than answers the pending brief');
  A.eq(cancelResult.questions[0].answer, '', 'cancel text is never learned as a task answer');

  // Marker path: a plain TASK_QUESTION reply persists honestly — nothing the model didn't say is recorded.
  const marker = await s2.prepare({ id: 'tb_marker', key: 'stream:marker', text: 'Build a landing page' }, 340);
  const mq = await s2.ask(marker.id, { question: 'dark theme or light theme?', options: ['dark', 'light'] }, 342, { source: 'marker' });
  A.eq(mq.status, 'clarifying', 'a marker question still leaves the brief waiting');
  A.eq(mq.questions[0].dimension, '', 'marker questions record no fabricated dimension');
  A.eq(mq.questions[0].recommended, '', 'marker questions record no fabricated recommendation');
  A.eq(mq.questions[0].reason, '', 'marker questions record no fabricated reason');
  A.eq(await s2.ask(marker.id, { question: 'serif or sans?', options: ['serif', 'sans'] }, 344, { source: 'marker' }), null, 'a marker second question requires an answered first question');
  await s2.prepare({ key: 'stream:marker', text: 'dark' }, 346);
  A.ok(await s2.ask(marker.id, { question: 'serif or sans?', options: ['serif', 'sans'] }, 348, { source: 'marker' }), 'a marker second question is allowed once the first is answered');
  A.eq(await s2.ask(marker.id, { question: 'hero image?', options: ['yes', 'no'] }, 350, { source: 'marker' }), null, 'the marker path still enforces the whole-task two-question cap');
  const soloBrief = await s2.prepare({ id: 'tb_solo', key: 'stream:solo', text: 'Build a page' }, 352);
  A.eq(await s2.ask(soloBrief.id, { question: 'only one?', options: ['solo'] }, 354, { source: 'marker' }), null, 'a one-option marker fails closed in the store too');
  // Marker questions (empty dimension) still feed pattern learning, binned by their question text.
  await s2.prepare({ key: 'stream:marker', text: 'sans' }, 356); await s2.complete(marker.id, 'run-m1', 358);
  const marker2 = await s2.prepare({ id: 'tb_marker2', key: 'stream:marker2', text: 'Build a second landing page' }, 360);
  await s2.ask(marker2.id, { question: 'dark theme or light theme?', options: ['dark', 'light'] }, 362, { source: 'marker' });
  await s2.prepare({ key: 'stream:marker2', text: 'dark' }, 364); await s2.complete(marker2.id, 'run-m2', 366);
  A.ok(s2.patterns(5).some(p => p.question === 'dark theme or light theme?' && p.count === 2), 'repeated marker decisions bin by question text');

  const pivoted = await s2.prepare({ id: 'tb_pivot', key: 'stream:pivot', text: 'Build a report' }, 400);
  await s2.ask(pivoted.id, material(), 410);
  const replacement = await s2.prepare({ id: 'tb_replacement', key: 'stream:pivot', text: 'instead, export the raw CSV' }, 420);
  A.eq(replacement.inputAction, 'replace', 'a clear pivot opens a replacement instead of contaminating the old brief');
  A.eq(replacement.originalDirective, 'export the raw CSV', 'replacement brief strips the pivot preamble');
  A.eq(s2.list({ key: 'stream:pivot' }).filter(b => b.status === 'cancelled').length, 1, 'replaced brief retains an honest cancelled predecessor');

  // Structured internal tools preserve control metadata through the registry and stop the same batch before
  // any later call can run. They are hidden from ordinary tool telemetry by the run host.
  const controlBrief = await s2.prepare({ id: 'tb_control', key: 'stream:control', text: 'Build something' }, 500);
  const state = { brief: controlBrief }; const registry = makeRegistry();
  registerTaskBriefTools(registry, s2, state, { now: () => 510 });
  const askResult = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
  A.ok(askResult.ok, 'structured brief.ask dispatches through the normal host registry: ' + JSON.stringify(askResult));
  A.eq(askResult.control && askResult.control.final, true, 'registry preserves the internal final-control signal');
  A.ok(/^TASK_QUESTION:/.test(askResult.control.text), 'structured ask emits the backward-compatible UI marker');
  let laterRan = false;
  const calls = [
    { id: 'a', name: 'brief_ask', argsRaw: '{}' },
    { id: 'b', name: 'fs_write', argsRaw: '{}' }
  ];
  const controlResults = await Loop.executeCalls(calls, async c => c.id === 'a'
    ? { ok: true, isError: false, content: 'wait', summary: 'wait', control: { final: true, text: 'TASK_QUESTION: format? || PDF | HTML' } }
    : (laterRan = true, { ok: true, isError: false, content: 'wrote' }), {}, () => {}, { agentId: 'agent', runId: 'run', clock: { now: () => 1 }, hiddenTools: new Set(['brief_ask']) });
  A.eq(laterRan, false, 'a final brief control skips later calls in the same model batch');
  A.eq(controlResults.length, 2, 'skipped calls still receive paired tool results');
  A.eq(controlResults[1].isError, true, 'the paired skipped result is explicitly an error');
  const emitted = [];
  const loopResult = await LoopModule.runAgentLoop({
    messages: [{ role: 'user', content: 'Build something' }],
    provider: { async *stream() {
      yield { type: 'tool_start', index: 0, id: 'ask1', name: 'brief_ask' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: {} }; yield { type: 'done', finishReason: 'tool_calls' };
    } },
    emit: (name, payload) => emitted.push({ name, payload }),
    dispatch: async () => ({ ok: true, isError: false, content: 'wait', summary: 'wait', control: { final: true, reason: 'done', text: 'TASK_QUESTION: format? || PDF | HTML' } }),
    hiddenTools: ['brief_ask'], limits: { maxIters: 2 }, signal: { aborted: false }, clock: { now: () => 1 },
    cost: { estimate: () => ({ usd: 0 }), reconcile: () => ({ usd: 0, tokensIn: 0, tokensOut: 0 }) },
    capCtx: { canRun: () => true }, agentId: 'agent', runId: 'control-run', model: 'replay/model'
  });
  A.eq(loopResult.reason, 'done', 'final Task Brief control ends the loop without a second paid model turn');
  A.ok(loopResult.messages.some(m => m.role === 'assistant' && /^TASK_QUESTION:/.test(m.content)), 'loop appends the compatible question marker after paired tool results');
  A.eq(emitted.some(e => e.name === 'agent.tool_call'), false, 'internal brief controls stay out of user-facing tool telemetry');

  // TURN BREAK (first-hour walk 2026-09-28): a hidden brief tool emits no agent.tool_call, so the page never reset its
  // reply and the next turn's prose glued onto the previous line — straight into a TASK_QUESTION option chip.
  {
    const scripted = turns => { let i = 0; return { async *stream() {
      const t = turns[Math.min(i++, turns.length - 1)];
      if (t.text) for (const piece of t.text) yield { type: 'text', delta: piece };
      if (t.tool) { yield { type: 'tool_start', index: 0, id: t.tool + i, name: t.tool }; yield { type: 'tool_args', index: 0, chunk: '{}' }; }
      yield { type: 'usage', usage: {} }; yield { type: 'done', finishReason: t.finish || (t.tool ? 'tool_calls' : 'stop') };
    } }; };
    const runWith = async (turns, extra) => {
      const ev = [];
      const res = await LoopModule.runAgentLoop(Object.assign({
        messages: [{ role: 'user', content: 'Draft it' }], provider: scripted(turns),
        emit: (name, payload) => ev.push({ name, payload }),
        dispatch: async () => ({ ok: true, isError: false, content: 'noted', summary: 'ok' }),
        hiddenTools: ['brief_update'], limits: { maxIters: 4 }, signal: { aborted: false }, clock: { now: () => 1 },
        cost: { estimate: () => ({ usd: 0 }), reconcile: () => ({ usd: 0, tokensIn: 0, tokensOut: 0 }) },
        capCtx: { canRun: () => true }, agentId: 'agent', runId: 'turn-break', model: 'replay/model'
      }, extra || {}));
      return { res, stream: ev.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join(''), calls: ev.filter(e => e.name === 'agent.tool_call').length };
    };
    const hidden = await runWith([{ text: ['Here is my read.'], tool: 'brief_update' }, { text: ['I have done ', 'what I can.'] }]);
    A.eq(hidden.stream, 'Here is my read.\n\nI have done what I can.', 'a turn after a HIDDEN tool starts a new paragraph in the live stream');
    A.eq(hidden.calls, 0, 'the hidden tool still emits no tool telemetry');
    A.ok(hidden.res.messages.filter(m => m.role === 'assistant').every(m => !/^\n/.test(String(m.content || ''))), 'durable turn text never carries the break');
    const visible = await runWith([{ text: ['Checking.'], tool: 'fs_read' }, { text: ['Found it.'] }]);
    A.eq(visible.stream, 'Checking.Found it.', 'a VISIBLE tool call resets the page itself — no extra break is streamed');
    A.eq(visible.calls, 1, 'the visible tool call is announced');
    const cut = await runWith([{ text: ['Half a sen'], finish: 'length' }, { text: ['tence.'] }]);
    A.ok(!/\n\n/.test(cut.stream), 'a length-continuation joins mid-sentence with no break: ' + JSON.stringify(cut.stream));
  }
  // every choice marker leaves displayed text, in any number and any mix; prose that merely says FORK: stays
  {
    const Fork = require('../frontend/app/fork.js');
    const two = 'Here is the plan.\nTASK_QUESTION: whose voice? || yours | neutral\nMore prose.\nTASK_QUESTION: when? || now | later';
    const t2 = Fork.TaskIntent.strip(two);
    A.ok(!/TASK_QUESTION/.test(t2) && /Here is the plan\./.test(t2) && /More prose\./.test(t2), 'TaskIntent.strip removes EVERY task question line, not just the first: ' + JSON.stringify(t2));
    const mixed = 'Draft ready.\n\nFORK: casual or formal? || casual | formal\nTASK_QUESTION: send now? || yes | no';
    A.eq(Fork.stripMarkers(mixed), 'Draft ready.', 'stripMarkers removes FORK and TASK_QUESTION lines together');
    A.eq(Fork.stripMarkers('FORK: a or b? || a | b'), '', 'a marker-only reply leaves nothing to show');
    const plain = 'The FORK: in the road is where we choose.\n  Keep this spacing.  ';
    A.eq(Fork.stripMarkers(plain), plain, 'prose without a marker is returned byte-identical');
    A.eq(Fork.strip('x\nFORK: q? || a | b\nFORK: r? || c | d'), 'x', 'Fork.strip removes every FORK line');
    const chatSrcT = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
    A.ok(/const forkAsked = [^\n]*Fork\.parse\(replyText\)/.test(chatSrcT) && chatSrcT.indexOf('const forkAsked') < chatSrcT.indexOf('replyText = shown;'), 'the FORK is parsed from the raw reply before the markers are stripped');
    // (the stripped text may be split around folded [steering] lines first — every prose part still comes from shownText)
    A.ok((/renderProse\(r\.body, shownText[,)]/.test(chatSrcT) || (/renderProse\(r\.body, parts\[pi\][,)]/.test(chatSrcT) && /const parts = [^\n]*shownText\.split\(/.test(chatSrcT))) && /const shownText = [^\n]*Fork\.stripMarkers\(m\.content\)/.test(chatSrcT), 'history re-renders strip markers from server-synced rows');
  }

  const cx = CommanderContext.compose({ brief: resumed, dossier: 'COMMANDER DOSSIER\n- Goals: ship', existingSystem: '', patterns: s2.patterns(5) });
  A.ok(/ORIGINAL REQUEST: Build me a dashboard/.test(cx) && /=> operators/.test(cx), 'composer carries original task + answered decision');
  A.ok(/strength="weak; never override current instructions"/.test(cx), 'relationship evidence is truthfully labelled weak');

  // Source guards lock the full seam: central run host, browser chips, channel fallback, and no dossier write.
  const indexSrc = readSidecarSource({ except: ['sidecar/group-sessions.js', 'sidecar/taskbrief-tools.js'] });   // the host; both name a `grounded:` key of their own
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  const hubSrc = fs.readFileSync(path.join(__dirname, '../sidecar/channels/hub.js'), 'utf8');
  const orchestrationSrc = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');
  A.ok(/taskBriefStore\.prepare/.test(indexSrc) && /TaskIntent\.directive/.test(indexSrc), 'runOnce prepares the durable brief and injects the shared doctrine');
  A.ok(/taskContext:\s*taskContextBlock/.test(indexSrc) && /workerSystem/.test(orchestrationSrc), 'delegated workers inherit the settled brief without re-questioning the Commander');
  A.ok(/taskQuestionAsked/.test(indexSrc) && /!taskQuestionAsked/.test(indexSrc), 'clarifications suppress completed-task learning sweeps');
  A.ok(/\{ source: 'marker' \}/.test(indexSrc) && !/The model identified a material unresolved decision/.test(indexSrc), 'the marker settle path records honestly instead of fabricating validation metadata');
  A.ok(/bufferedTaskEnd/.test(indexSrc) && /taskQuestionAsked\s*\?\s*'clarifying'/.test(indexSrc) && !/taskQuestionAsked\s*\?\s*'cancelled'/.test(indexSrc), 'clarification ends as the honest additive clarifying terminal before global completed-work listeners run');
  // Lane D — the additive contract change: 'clarifying' joined the run-end enum; every prior reason survives.
  const eventsSrc = fs.readFileSync(path.join(__dirname, '../shared/events.js'), 'utf8');
  const reasonEnum = /'agent\.run\.end'[\s\S]{0,1500}?reason:\s*\{\s*enum:\s*\[([^\]]+)\]/.exec(eventsSrc);
  A.ok(reasonEnum, 'run-end reason enum is declared in the shared contract');
  for (const r of ['done', 'max_iters', 'budget', 'cancelled', 'error', 'refusal', 'empty', 'clarifying']) {
    A.ok(reasonEnum[1].indexOf("'" + r + "'") >= 0, 'run-end reason enum carries ' + r + ' (additive-only contract)');
  }
  A.ok(/reason === 'clarifying'\) return ''/.test(hubSrc), 'channel endNote treats a clarifying end as the reply itself, never a stopped note');

  // Live-caught 2026-07-16 (real haiku-4.5 run): the internal brief controls must never route through the
  // external-unknown per-call confirmation, and the model must SEE the legal dimensions in the tool schema.
  const InputPolicy = require('../sidecar/inputpolicy.js');
  {
    const reg2 = makeRegistry();
    registerTaskBriefTools(reg2, { ask: async () => null, proceed: async () => null }, { brief: { id: 'x', status: 'ready', questions: [] } }, { now: () => 1 });
    const authority = InputPolicy.makeRunAuthority({ surface: 'interactive', isTask: true, confirm: () => { throw new Error('brief controls must not need confirmation'); } });
    for (const nm of ['brief.ask', 'brief.proceed']) {
      const t2 = reg2.get(nm);
      A.eq(t2.capability, 'taskbrief', nm + ' carries the internal taskbrief capability');
      const auth = await authority.authorize({ name: nm }, t2);
      A.eq(auth.ok, true, nm + ' authorizes without an external-unknown confirmation');
      A.ok(auth.oneShot !== true, nm + ' is not the one-shot external-unknown lease');
    }
    const dimSchema = reg2.get('brief.ask').schema.properties.dimension;
    A.ok(Array.isArray(dimSchema.enum) && dimSchema.enum.length === Policy.DIMENSIONS.size && dimSchema.enum.every(d => Policy.DIMENSIONS.has(d)), 'the wire schema enum IS the policy dimension whitelist');
  }
  A.ok(/dimension must be one of:/.test(Policy.validateQuestion(material({ dimension: 'dashboard_tech' }), { questions: [] }).error), 'a rejected dimension names the legal set in the error');
  const loopSrc = fs.readFileSync(path.join(__dirname, '../sidecar/loop.js'), 'utf8');
  A.ok(/delta: '\\n\\n' \+ controlText/.test(loopSrc), 'the final-control marker streams on its own line so the client line-anchored parse always hits');
  A.ok(/endReason === 'clarifying'\) restoreTaskQuestion\(ws\)/.test(chatSrc), 'a clarifying end without a parsed marker re-presents from the durable brief');

  // TASTE EXTRACTION slice 1 — announce-and-act: the settled read surfaces, corrections steer the live run.
  A.ok(/'taskbrief\.settled': obj\(\['agentId', 'runId', 'objective'\]/.test(eventsSrc), 'the settled-read event is declared additively in the shared contract');
  A.ok(/emit\('taskbrief\.settled'/.test(indexSrc) && /c\.name === 'brief\.proceed'/.test(indexSrc), 'a successful brief.proceed emits the settled read');
  A.ok(/wireBriefRead/.test(chatSrc) && /taskbrief\.settled/.test(chatSrc), 'COMMS renders the READ card from the settled event');
  A.ok(/\/api\/run\/steer/.test(chatSrc) && /folded into the run/.test(chatSrc), 'READ-card corrections fold into the live run via steer');
  A.ok(/run already ended|run already finished/.test(chatSrc), 'a correction after run end is refused honestly, never faked');
  /* TASTE-FILLER CEILING (2026-08-14, live-caught): the doctrine used to demand a STYLE+TONE+AESTHETIC read on
     EVERY task, so a "what are my PC specs?" lookup produced three invented taste chips and buried the one real
     assumption. Taste is now CONDITIONAL on an authored artifact, and the host caps what a prompt cannot. */
  {
    const doc = TaskIntent.directive('');
    A.ok(/ONLY when the task produces an authored artifact/.test(doc), 'taste assumptions are conditional on there being a look to choose');
    A.ok(/NEVER restate your normal defaults as assumptions/.test(doc) && /needs no taste assumption at all/.test(doc), 'restating our own defaults is banned outright');
    A.ok(/what you picked AND what you rejected/.test(doc), 'an earned taste assumption must name the alternative it rejected');
    // the EXACT chips from the live card Andrew caught
    const caught = ['Style: brief, direct, and practical.', 'Tone: friendly with a small spark, no unnecessary ceremony.',
      'Aesthetic: plain readable summary, not an elaborate report.', 'I will omit serial numbers, product keys, usernames, and other sensitive identifiers.'];
    A.eq(Policy.trimAssumptions(caught), ['I will omit serial numbers, product keys, usernames, and other sensitive identifiers.'],
      'every taste-filler chip is dropped and the one real assumption survives');
    A.eq(Policy.validateProceed({ objective: 'Report the host PC specs', assumptions: caught }).brief.assumptions.length, 1, 'the ceiling applies at the policy boundary, not just in the prompt');
    // fail-open: an EARNED taste call (names its rejected alternative, task-specific words) is never destroyed
    const earned = ['Aesthetic: gritty and readable, not decorative — this is a recruiting poster', 'Treating the Q3 export as the source of truth, not the dashboard'];
    A.eq(Policy.trimAssumptions(earned), earned, 'a specific, contestable taste assumption is left completely alone');
    A.eq(Policy.trimAssumptions(['Style: terse', 'Tone: gritty and profane, not corporate']).length, 1, 'taste is at most ONE line of a read, never its body');
    A.eq(Policy.tasteFiller('I will omit serial numbers'), false, 'an unlabelled assumption is never touched');
  }
  A.ok(/endReason !== 'clarifying'/.test(chatSrc), 'COMMS never renders a clarifying end as a stopped run');
  A.ok(/offerTaskQuestion/.test(chatSrc) && /TaskIntent\.strip/.test(chatSrc), 'COMMS strips the marker and renders the natural decision');
  A.ok(/clarificationRuns\.has\(runId\)/.test(chatSrc) && /clarificationRuns\.add\(thisRunId\)/.test(chatSrc), 'clarification turns do not count as completed-work beats');
  A.ok(/endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion/.test(chatSrc), 'the neutral clarification terminal is not rendered as a stopped/error run');
  A.ok(/endReason:\s*taskQuestion\s*\?\s*'done'/.test(chatSrc), 'the visible presence line describes the completed decision turn without claiming task delivery');
  A.ok(/function restoreTaskQuestion/.test(chatSrc) && /status=clarifying/.test(chatSrc), 'reload or stream-switch re-presents the real unanswered durable brief');
  const offer = chatSrc.slice(chatSrc.indexOf('function offerTaskQuestion'), chatSrc.indexOf('function offerTaskQuestion') + 1400);
  A.ok(!/DossierStore\.upsert/.test(offer), 'task-specific answers never pollute the global dossier');
  A.ok(/taskKey: 'channel:'/.test(hubSrc) && /Reply with a choice/.test(hubSrc), 'messaging channels share brief continuity with a text-choice fallback');

  // TASK BRIEF v2 — the stored recommendation reaches every surface, and only when it is real.
  const cssSrc = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');
  // (the run-end call scopes the question to its run so the card carries that run's connect door — first-hour fixes 2026-09-28)
  A.ok(/function presentTaskQuestion/.test(chatSrc) && /presentTaskQuestion\(ws, Object\.assign\(\{ runId: thisRunId \}, taskQuestion\)\)/.test(chatSrc), 'run-end questions render through the brief-enriched presenter');
  A.ok(/it\.suggested \? ' suggested'/.test(chatSrc) && /tq-reason/.test(chatSrc), 'COMMS marks the recommended chip and renders the one-line why');
  A.ok(/recommended: q\.recommended \|\| ''/.test(chatSrc), 'restore-on-reload passes the stored recommendation through');
  A.ok(/\.choice\.suggested/.test(cssSrc) && /--gold-rgb/.test(cssSrc.slice(cssSrc.indexOf('.choice.suggested'), cssSrc.indexOf('.choice.suggested') + 700)), 'the suggested chip uses the theme gold vocabulary, never a literal amber');
  A.ok(/briefFor/.test(hubSrc) && /suggested: ' \+ q\.recommended/.test(hubSrc), 'the channel fallback carries the stored recommendation');
  A.ok(/briefFor: \(key\) => taskBriefStore\.active\(key\)/.test(indexSrc), 'both hub compositions read recommendations from the durable store');

  // GROUNDED SUGGESTION wiring — the observed-history recommendation must reach every surface, outrank the
  // model's guess, and stay visually separable from it (provable vs asserted must never look identical).
  A.ok(/grounded = q0 \? taskBriefStore\.groundedFor\(q0, pats\)/.test(indexSrc), 'the briefs route serves the grounded suggestion for the open question');
  A.ok(/j\.grounded \|\| null/.test(chatSrc), 'COMMS reads the grounded field the response already carried');
  A.ok(/you chose this ' \+ g\.count \+ ' times before/.test(chatSrc), 'the grounded why-line states a real observed count, never a vague confidence');
  A.ok(/tq-reason' \+ \(useGrounded \? ' grounded' : ''\)/.test(chatSrc), 'a grounded suggestion is marked so it cannot be mistaken for the model guess');
  A.ok(/const gSet = .*\.filter\(has\)/.test(chatSrc) && /useGrounded \? gSet\.map/.test(chatSrc) && /has\(tq\.recommended\) \? \[String\(tq\.recommended\)/.test(chatSrc),
    'a grounded option that is not among the choices falls back to the model recommendation instead of losing both');
  /* MULTI-SELECT GROUNDING (2026-08-14). A set answer ("billing exports, the run ledger") can never satisfy
     whole-string equality, so the one PROVABLE suggestion was permanently dead for the question kind
     multi-select exists for. Split-and-tally per option — and ONLY for multiSelect, so an exclusive
     question's free-text answer is still never mined for a word that happens to name an option. */
  {
    const store = makeStore(memFs());
    const toolsSrc2 = fs.readFileSync(path.join(__dirname, '../sidecar/taskbrief-tools.js'), 'utf8');
    const q = { text: 'which data should it pull from?', options: ['billing exports', 'the run ledger', 'support tickets'], multiSelect: true };
    const pool = [{ question: q.text, answer: 'billing exports, the run ledger', count: 3, updatedAt: 9 }];
    const g = store.groundedFor(q, pool);
    A.eq(g && g.options, ['billing exports', 'the run ledger'], 'both halves of a set answer are credited, in the question\'s own option order');
    A.eq(g && g.multi, true, 'the set result is marked as a set');
    // a DEAD HEAT is fine for a set (options are independent) but still fatal for an exclusive question
    const excl = { text: 'who is this for?', options: ['operators', 'executives'] };
    A.eq(store.groundedFor(excl, [{ question: excl.text, answer: 'operators, executives', count: 4, updatedAt: 9 }]), null,
      'an exclusive question NEVER splits — a comma answer stays unmatched rather than crediting both');
    A.eq(store.groundedFor(Object.assign({}, q, { multiSelect: true }), [{ question: q.text, answer: 'support tickets', count: 1, updatedAt: 9 }]), null,
      'one sighting is not a habit');
    A.ok(/you usually pick these/.test(chatSrc), 'a set suggestion says so in its own words rather than pretending to be one favourite');
    A.ok(/grounded: grounded \? \{ options:/.test(toolsSrc2) && /grounded:/.test(indexSrc), 'the LIVE clarify card receives the grounded suggestion, not just the end-run fallback');
    // BATCH-WIDE ESCAPE: one tap hands back every remaining decision (3 taps was the wrong ratio).
    A.ok(/use your judgment for the rest/.test(chatSrc), 'the card offers the batch-wide escape');
    A.ok(/REST_SKIP = \/\^\\s\*use your judgment for the rest/.test(toolsSrc2), 'the host recognises it exactly — a deferral carrying a real constraint is NOT swallowed');
    A.ok(/answerInTurn\(state\.brief\.id, 'use your judgment', now\(\), rest\.id\)/.test(toolsSrc2), 'the remaining questions are recorded as real deferrals so the skip bookkeeping still sees them');
  }
  // PER-KIND OPTION CAP: the store used to slice EVERY question to 3, silently eating options 4-6 of a
  // validated multi-select on the way to disk.
  {
    const norm = require('../sidecar/taskbrief-store.js').normalizeQuestion;
    A.eq(norm({ text: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f'], multiSelect: true }).options.length, 6, 'a multi-select keeps up to six options on disk');
    A.eq(norm({ text: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f'] }).options.length, 3, 'an exclusive question is still capped at three');
    A.ok(/q\.options\.length > \(tq\.options \|\| \[\]\)\.length/.test(chatSrc), 'the end-run card prefers the STORED options over the 3-capped marker line');
  }
  A.ok(/\.tq-reason\.grounded/.test(cssSrc), 'the grounded why-line has its own provable-source styling');
  A.ok(/groundedFor: \(q\) => taskBriefStore\.groundedFor\(q\)/.test(indexSrc) && /groundedFor \? groundedFor\(q\)/.test(hubSrc), 'messaging channels carry the same grounded suggestion as COMMS');
  A.ok(/console\.warn\('\[taskbrief\] brief_ask rejected/.test(fs.readFileSync(path.join(__dirname, '../sidecar/taskbrief-tools.js'), 'utf8')), 'a hidden-tool rejection is logged instead of silently downgrading the surface');

  // ASK-WORTHINESS wiring — the gate refuses at the tool, the prompt says so first, and a store without the
  // capability (older/injected) still works. Plus the typed-answer escape hatch is finally VISIBLE.
  {
    const toolsSrc = fs.readFileSync(path.join(__dirname, '../sidecar/taskbrief-tools.js'), 'utf8');
    const cxSrc = fs.readFileSync(path.join(__dirname, '../sidecar/commander-context.js'), 'utf8');
    A.ok(/typeof store\.deferredDimensions === 'function'/.test(toolsSrc), 'the ask-worthiness gate degrades safely when the store cannot answer');
    A.ok(/deferred\.indexOf\(q\.dimension\)/.test(toolsSrc) && /!kept\.length/.test(toolsSrc), 'a habitually deferred dimension is trimmed (and an all-deferred ask refused) at the tool boundary');
    A.ok(/<deferred_decisions provenance="commander-observed">/.test(cxSrc), 'the deferred dimensions are declared to the model with honest provenance');
    A.ok(/deferredDimensions = taskBriefStore\.deferredDimensions\(\)/.test(indexSrc) && /goal, patterns, deferredDimensions/.test(indexSrc), 'runOnce feeds the observed deferrals into the composed context');
    A.eq(CommanderContext.compose({ deferredDimensions: [] }), '', 'no observed deferrals -> no block');
    A.ok(/scope/.test(CommanderContext.compose({ deferredDimensions: ['scope'] })), 'an observed deferral names the dimension it covers');
    const gate = await (async () => {
      const reg = makeRegistry();
      registerTaskBriefTools(reg, { ask: async () => ({ id: 'b' }), proceed: async () => null, deferredDimensions: () => ['scope'] }, { brief: { id: 'b', status: 'ready', questions: [] } }, { now: () => 1 });
      const args = { dimension: 'scope', question: 'how wide should this go?', options: ['just the api', 'the whole service'], recommended: 'just the api', reason: 'changes the work', discoverable: false };
      return reg.get('brief.ask').run(args).then(() => '').catch(e => e.message);
    })();
    A.ok(/repeatedly answered "use your judgment"/.test(gate) && /correctable assumption/.test(gate), 'the refusal steers to deciding + surfacing an assumption, never to silent guessing');
    A.ok(/tq-hint/.test(chatSrc) && /more than one is fine/.test(chatSrc), 'the chip row tells the Commander a typed answer is accepted');
    A.ok(/\.tq-hint/.test(cssSrc), 'the typed-answer hint is styled as a quiet affordance note');
  }

  // TASK BRIEF v2 — recipe intake: declared material decisions, settled at launch or aimed mid-run.
  const Recipes = require('../frontend/app/recipes.js');
  for (const r of Recipes.list()) {
    for (const e of (r.intake || [])) {
      A.ok(Policy.DIMENSIONS.has(e.dimension), 'recipe intake dimension is a policy dimension: ' + r.id + '/' + e.dimension);
      A.ok(e.options.some(o => o.toLowerCase() === e.recommended.toLowerCase()), 'recipe intake recommended is one of its options: ' + r.id);
    }
  }
  const dr = Recipes.get('deep-research');
  A.eq((dr.intake || []).length, 2, 'the flagship intake survived catalog normalization');
  const filled = Recipes.fillTask('deep-research', { topic: 'X', __intake: { deliverable: 'tight brief' } });
  A.ok(/Decisions \(chosen at launch/.test(filled) && /- deliverable: tight brief/.test(filled), 'launch-tapped intake decisions ride the directive itself');
  A.ok(!/Decisions \(chosen at launch/.test(Recipes.fillTask('deep-research', { topic: 'X' })), 'no tapped decisions -> no decisions block');
  const cxIntake = CommanderContext.compose({ recipeIntake: dr.intake });
  A.ok(/<recipe_intake provenance="recipe-declared">/.test(cxIntake) && /suggested: tight brief/.test(cxIntake), 'composer renders the declared decisions with their suggested defaults');
  A.ok(CommanderContext.compose({}).indexOf('recipe_intake') < 0, 'no recipe -> no intake block');
  const evidenceCx = CommanderContext.compose({
    topics: [{ label: 'release automation', count: 3, evidence: ['automate release notes'] }],
    threads: [{ title: 'finish the changelog verifier' }],
    worksignal: 'dominant lane: workbench; 4 completed task-runs',
    verdicts: { kinds: { research: { weight: 0.4, positive: 3, negative: 0 } } },
    activity: ['Ship the StarNet beta (yesterday)']
  });
  A.ok(/<commander_evidence provenance="observed; weak; never override the current request">/.test(evidenceCx), 'one provenance-labelled evidence block composes the learned model for every execution lane');
  A.ok(/release automation/.test(evidenceCx) && /automate release notes/.test(evidenceCx), 'topic claims carry their stored evidence quote');
  A.ok(/finish the changelog verifier/.test(evidenceCx) && /research=\+0\.4/.test(evidenceCx), 'open threads and bounded verdict learning share the same composer');
  A.ok(CommanderContext.compose({ topics: [], threads: [], activity: [] }).indexOf('commander_evidence') < 0, 'empty evidence fabricates no learned context block');
  const mktSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
  A.ok(/const ready = recommendationsReady\(\)/.test(mktSrc) && /STARTING POINTS/.test(mktSrc), 'the marketplace uses shared readiness and labels its cold shelf honestly');
  A.ok((mktSrc.match(/const gt = ready \? goalText\(\) : ''/g) || []).length >= 2, 'cold marketplace shelves cannot smuggle dossier goals past readiness');
  A.ok(/values\.__intake = intake/.test(mktSrc) && /mkt-intake-opt/.test(mktSrc), 'the launch form collects one-tap intake decisions');
  A.ok(/recipeIntake/.test(indexSrc) && /Recipes\.get\(String\(o\.recipeId\)\)/.test(indexSrc), 'a recipe-launched run injects its declared intake');

  A.report('taskintent.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
