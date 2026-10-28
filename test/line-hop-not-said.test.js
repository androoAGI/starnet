/* test/line-hop-not-said.test.js — QUOTE ATTRIBUTION (2026-09-30): a ◈ NOTICED card told the Commander «because you said "Do not include a
   sources list…"» — words they never said: a WRITER step's standing instructions. A work line's later stages run on the hand-off frame
   (Pipeline.handoffPrompt: the job, the upstream work and the step's brief in one USER turn), and the run-end STUDY pass read that turn
   as the Commander speaking. Locked here:
     1. Pipeline.isHandoff knows the frame (whole, or cut short as a run row's title), and nothing else;
     2. the run-end gate never studies or thread-mines a hand-off run, and a batch stashed from one before the fix is never served;
     3. study() says «you said» (kind 'verbatim') only for the Commander's own words — a quote found in a reply or a tool result falls
        back to the directive receipt. */
'use strict';
const { readSidecarSource, sidecarTopLevelFunction } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const P = require('../frontend/app/pipeline.js');
const S = require('../frontend/app/study.js');
const { makeClock } = require('../shared/clock-rng.js');

(async () => {
  /* ---------- 1. the frame, and only the frame ---------- */
  const brief = 'Write a short, punchy digest. Do not include a sources list.';
  const mid = P.handoffPrompt('3 AI stories, keep it short', { agentId: 'nova' }, 'The research notes…', 1, brief, null, false);
  const last = P.handoffPrompt('3 AI stories, keep it short', { agentId: 'nova' }, 'The research notes…', 2, brief, null, true);
  A.ok(P.isHandoff(mid) && P.isHandoff(last), 'a middle stage\'s and the LAST stage\'s hand-off are both hand-offs');
  A.ok(mid.indexOf(brief) >= 0, '…and the step\'s brief really rides that USER turn (why STUDY mistook it for the Commander)');
  A.ok(P.isHandoff(mid.replace(/\s+/g, ' ').slice(0, 80)), 'a run row\'s title (whitespace folded, cut at 80) still reads as a hand-off');
  A.ok(P.isHandoff('\n  ' + mid), 'leading whitespace does not hide the frame');
  A.ok(!P.isHandoff('3 AI stories, keep it short') && !P.isHandoff('') && !P.isHandoff(null), 'a job the Commander typed is not a hand-off');
  A.ok(!P.isHandoff('please explain: PIPELINE HANDOFF — you are stage 2 of a work line on this station.'), 'the frame quoted INSIDE a message is not a hand-off (only a turn that opens with it)');

  /* ---------- 2. the run-end gate and the stash (sidecar/index.js, source-locked: runOnceCore is not unit-loadable) ---------- */
  const src = readSidecarSource();
  // quick win 17: the gate reads the run's directive as captured BEFORE the loop (the loop appends its own user-role turns,
  // e.g. a screen capture, which made the post-loop latest user text the wrong turn to judge)
  const lh = sidecarTopLevelFunction('runOnceCore');
  A.ok(/const _lineHop = !!\(Pipeline\.isHandoff && Pipeline\.isHandoff\(runDirective\)\);/.test(lh)
    && lh.indexOf('const runDirective = latestUserText(') >= 0 && lh.indexOf('const runDirective = latestUserText(') < lh.indexOf('const _lineHop ='),
    'the gate reads the run\'s own directive, captured before the loop, for the hand-off frame');
  // memory-truth-1027: every pass reads the hand-off through ONE predicate (learning-eligibility.js; the full matrix is
  // test/learning-eligibility.matrix.test.js) — the gates read its verdict, and the run's own _lineHop feeds it
  const LE = require('../sidecar/learning-eligibility.js');
  const hop = LE.passes(LE.runOutcome({ reason: 'done', reflect: true, task: true, lineHop: true }));
  A.ok(!hop.study && !hop.threadmine && !hop.reflection && !hop['failure-review'] && !hop['trusted-capture'], 'no learning pass runs on a line hand-off');
  A.ok(/const _gateStudy = !!\(Study && o\.reflect && memoryConfig\.studyEnabled && isTask && _learn\.study && /.test(src), 'STUDY never runs on a line hand-off');
  A.ok(/const _gateThreadmine = !!\([^\n]*_learn\.threadmine && threadmine\.mineSalient/.test(src), 'THREAD-MINE never runs on a line hand-off');
  A.ok(/const _gateReflect = !!\(o\.reflect && memoryConfig\.reflectEnabled && isTask && _learn\.reflection && reflectSalient/.test(src), 'REFLECTION never saves "the user prefers …" from a line hand-off');
  const core = sidecarTopLevelFunction('runOnceCore');   // ordering inside the run itself, never across files
  A.ok(/lineHop: _lineHop/.test(core) && core.indexOf('const _lineHop =') >= 0 && core.indexOf('const _lineHop =') < core.indexOf('const _learn ='), '…(the hand-off is known before the one predicate reads it)');
  A.ok(core.indexOf('const _learn =') < core.indexOf('const _gateReflect ='), '…(and the predicate before any pass\'s gate)');
  A.ok(/o\.reflect && memoryConfig\.reflectEnabled && isTask/.test(src), '…and the reflection gate keeps its settings P1-10 lock');
  A.ok(/function studyFromLineHop\(b\) \{\s*try \{ const r = b && b\.runId \? runStore\.latest\(b\.runId\) : null; return !!\(r && Pipeline\.isHandoff && Pipeline\.isHandoff\(r\.title\)\); \}/.test(src), 'a stashed batch is judged by its run row\'s title');
  A.ok(/!b\.proposals\.length \|\| studyFromLineHop\(b\)\) continue;/.test(src), 'GET /api/study/pending never lists a batch from a hand-off run');
  A.ok(/batch\.agentId !== agent \|\| studyFromLineHop\(batch\)\) return json\(200, \{ runId: runId \|\| null, agentId: agent, proposals: \[\] \}\);/.test(src), 'GET /api/study/proposals never serves one either');

  /* ---------- 3. study(): «you said» only for the Commander's words ---------- */
  const run = { agentId: 'nova', runId: 'run_7', directive: 'summarize the launch notes for me', messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'summarize the launch notes for me — I always want bullet points' },
    { role: 'assistant', content: 'Here you go. I keep every summary under 100 words.', tool_calls: [{ id: 't1' }] },
    { role: 'tool', content: 'file says: the team prefers weekly releases' }
  ] };
  const said = await S.study(run, { propose: async () => 'style ADD: wants bullet-point summaries | EVIDENCE: "I always want bullet points"', clock: makeClock(1), beliefs: {}, declined: [] });
  A.ok(said.proposals.length === 1 && said.proposals[0].evidenceRef.kind === 'verbatim' && said.proposals[0].evidence === 'I always want bullet points', 'the Commander\'s own words stay a verbatim quote');
  const reply = await S.study(run, { propose: async () => 'style ADD: wants very short summaries | EVIDENCE: "I keep every summary under 100 words"', clock: makeClock(2), beliefs: {}, declined: [] });
  A.ok(reply.proposals.length === 1 && reply.proposals[0].evidenceRef.kind === 'directive', 'a quote from the agent\'s OWN reply is never «you said»');
  A.ok(reply.proposals[0].evidence === run.directive, '…it falls back to the directive receipt');
  const tool = await S.study(run, { propose: async () => 'schedule ADD: ships releases every week | EVIDENCE: "the team prefers weekly releases"', clock: makeClock(3), beliefs: {}, declined: [] });
  A.ok(tool.proposals.length === 1 && tool.proposals[0].evidenceRef.kind === 'directive', 'a quote from a TOOL result is never «you said» either');
  const invented = await S.study(run, { propose: async () => 'style ADD: loves purple | EVIDENCE: "make it all purple"', clock: makeClock(4), beliefs: {}, declined: [] });
  A.ok(invented.proposals.length === 0, 'a quote that is nowhere in the run is still dropped');

  A.report('line-hop-not-said.test');
})().catch(e => { console.error(e); process.exit(1); });
