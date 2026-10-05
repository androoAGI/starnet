/* node test/autopilot-focus-veto.test.js — the declared night focus is HOST-ENFORCED, not prompt-only
   (2026-10-05 audit item 3). parseCandidates({ focus }) drops a candidate whose title/grounds/spec share no
   significant token with the focus's own evidence (label, ref name, why-lines, host extras like the project
   snapshot). Lenient by design: one shared word passes; template words of the why-lines never count. */
'use strict';
const A = require('./_assert.js');
const AP = require('../frontend/app/autopilot.js');

const eligible = AP.ARCHETYPES.slice();
const kind = eligible[0].id;
const block = (title, grounds, spec) => ['JOB: ' + title, 'KIND: ' + kind, 'GROUNDS: ' + grounds, 'CONFIDENCE: high', 'SPEC: ' + spec].join('\n');
const beliefs = { goals: ['ship the parkour game demo', 'get taxes filed before April'] };

const projectFocus = { kind: 'project', ref: 'C:\\code\\parkour-game', label: 'parkour-game',
  why: ['you worked in parkour-game — last touched today (a git repo I can read + patch)'] };

(function noFocusUnchanged() {
  const txt = block('Tax prep checklist', 'get taxes filed before April', 'a checklist') + '\n' + block('Parkour level', 'ship the parkour game demo', 'a level');
  A.eq(AP.parseCandidates(txt, { eligible, beliefs }).length, 2, 'no focus → the focus veto never runs (byte-identical behavior)');
})();

(function offFocusDropped() {
  const dropped = [];
  const txt = block('Tax prep checklist', 'get taxes filed before April', 'a checklist') + '\n'
    + block('Parkour speedrun timer', 'ship the parkour game demo', 'an in-game timer');
  const out = AP.parseCandidates(txt, { eligible, beliefs, focus: projectFocus, onDrop: (c, r) => dropped.push([c.title, r]) });
  A.eq(out.map(c => c.title), ['Parkour speedrun timer'], 'with a project focus, the off-focus tax job is dropped');
  A.eq(dropped, [['Tax prep checklist', 'off-focus']], 'the drop is reported with its reason');
})();

(function templateWordsDoNotCount() {
  // "today", "repo", "patch", "read" all appear in the why TEMPLATE — they are not evidence of the focus.
  const c = { title: 'Patch the repo today', grounds: 'read their taxes', spec: 'csv' };
  A.eq(AP.advancesFocus(c, projectFocus), false, 'why-line template words alone never satisfy the focus');
  A.eq(AP.advancesFocus({ title: 'Level editor', grounds: 'parkour players asked for it', spec: 'x' }, projectFocus), true, 'one real shared word (parkour) is enough');
  A.eq(AP.advancesFocus({ title: 'Speedrun', grounds: 'x', spec: 'y' }, projectFocus, ['src/speedrun.js: TODO add splits']), true, 'host extras (project snapshot lines) count as focus evidence');
})();

(function workflowAndGoalFocus() {
  const wf = { kind: 'workflow', ref: 'workflow-abc', label: "summarize today's AI news",
    why: ['you asked for this 4 times on separate days', 'in your words: "give me a rundown of the AI news"'] };
  A.eq(AP.advancesFocus({ title: 'AI news digest', grounds: 'their daily ask', spec: 'a digest' }, wf), true, 'workflow focus: its own words (news) ground a candidate');
  A.eq(AP.advancesFocus({ title: 'Gym plan', grounds: 'fitness', spec: 'plan' }, wf), false, 'workflow focus: unrelated work is dropped');
  const goal = { kind: 'goal', ref: 'goal', label: 'launch the beta', why: ['your active goal arc: "launch the beta"'] };
  A.eq(AP.advancesFocus({ title: 'Beta signup page', grounds: 'g', spec: 's' }, goal), true, 'goal focus: goal words pass');
})();

(function threadFocusById() {
  const threads = [{ id: 'th-1', title: 'Rewrite onboarding emails' }];
  const tf = { kind: 'thread', ref: 'th-1', label: 'Rewrite onboarding emails', why: ['an open thread you raised but never acted on: "Rewrite onboarding emails"'] };
  const out = AP.parseCandidates(block('First draft', '[t1] they wanted this', 'three drafts'), { eligible, beliefs, threads, focus: tf });
  A.eq(out.length, 1, 'a candidate citing the focus thread by tag passes even with no shared words');
})();

A.report('autopilot-focus-veto.test');
