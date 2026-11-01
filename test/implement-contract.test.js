/* node test/implement-contract.test.js — the PROMPT/MANIFEST contract behind the delivery card's Implement action.

   THE BUG THIS LOCKS (2026-07-07 → 2026-08-14, five weeks live): the night-shift build directive told the agent
   "set the manifest kind to patch" for a project change, while the manifest SHAPE printed two lines below it
   listed `"kind": "tool|fix|draft|doc|other"` — no `patch`. A model following the shape emitted kind:"doc", and
   the whole apply-to-a-branch path (nightpatch.patchTargetFrom fires ONLY on kind === 'patch') became dead code.
   Worse, the savedOnly/patchRefused honesty fields are keyed on the SAME kind, so a patch that was merely COPIED
   still reported "✓ implemented". The rule and the shape must never disagree again — that is what this asserts.

   Also locks the `planOnly` declaration the card reads to decide whether Implement means "land the files" or
   "build what this describes". */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const AP = require('../frontend/app/autopilot.js');
const fs = require('node:fs');
const path = require('node:path');

const selected = { title: 'Add a retry to the uploader', grounds: 'they said uploads fail', spec: 'a patch that retries 3x' };

(function shapeListsPatch() {
  const d = AP.buildDoDirectiveV2(selected, { runId: 'r1', dir: 'workshop/r1', backlogId: 'b1' });
  const shape = d.split('\n').find(l => l.indexOf('"kind"') >= 0) || '';
  A.ok(shape, 'the build directive prints a manifest shape line naming "kind"');
  A.ok(/patch/.test(shape), 'the kind enum LISTS patch — without it the apply path is unreachable (regression 2026-07-07)');
  // every other kind the validator accepts must still be offered, so this fix never narrows the contract.
  ['tool', 'fix', 'draft', 'doc', 'other'].forEach(k => A.ok(shape.indexOf(k) >= 0, 'the kind enum still offers "' + k + '"'));
})();

(function ruleAndShapeAgree() {
  const ctx = { runId: 'r2', dir: 'workshop/r2', backlogId: 'b2', targetRoot: 'C:/proj/alpha', projectSnapshot: 'HEAD: abc123\nM src/up.js' };
  const d = AP.buildDoDirectiveV2(selected, ctx);
  A.ok(/THIS IS A PROJECT PATCH/.test(d), 'with a project target the directive carries the PROJECT PATCH rule');
  A.ok(/"kind":"patch"/.test(d), 'and the rule tells the agent to set kind:"patch"');
  const shape = d.split('\n').find(l => l.indexOf('"kind":') >= 0 && l.indexOf('|') >= 0) || '';
  A.ok(/patch/.test(shape), 'and the manifest SHAPE offers patch too — the rule and the shape agree');
})();

(function planOnlyIsDeclared() {
  const d = AP.buildDoDirectiveV2(selected, { runId: 'r3', dir: 'workshop/r3', backlogId: 'b3' });
  A.ok(/"planOnly"/.test(d), 'the manifest shape asks the shift to declare planOnly');
  A.ok(/DESCRIBES work/.test(d), 'and defines it as "describes work rather than being the finished thing"');
})();

/* THE AUTONOMY RUNG DECIDES WHETHER A PLAN IS A DELIVERABLE (2026-08-15).
   Before this, NO rung information reached the build directive at all: FREE (FULLY AUTONOMOUS) and
   BUILD (DRAFTS) sent byte-identical prompts, so the top rung differed only in how OFTEN it ran — and could
   still hand back a backlog describing work instead of doing it, under a headline that says it BUILT something. */
(function rungChangesThePrompt() {
  const base = { runId: 'r9', dir: 'workshop/r9', backlogId: 'b9' };
  const free = AP.buildDoDirectiveV2(selected, Object.assign({ initiative: 'free' }, base));
  const leash = AP.buildDoDirectiveV2(selected, Object.assign({ initiative: 'leash' }, base));
  A.ok(free !== leash, 'FREE and BUILD (DRAFTS) no longer send an identical build directive');

  A.ok(/FINISH IT, DO NOT PLAN IT/.test(free), 'FREE forbids delivering a plan');
  A.ok(/smallest COMPLETE WORKING PIECE/i.test(free), 'and says what to do instead when the job is too big');
  A.ok(/"planOnly": false/.test(free), 'FREE pins planOnly to false in the manifest shape');
  A.ok(!/planOnly": <true ONLY if/.test(free), 'and does not also offer the tri-state that would contradict it');

  A.ok(/acceptable deliverable/.test(leash), 'BUILD (DRAFTS) still allows a plan — that rung literally says drafts');
  A.ok(/planOnly": <true ONLY if/.test(leash), 'and keeps the tri-state planOnly field');
  A.ok(!/FINISH IT, DO NOT PLAN IT/.test(leash), 'the FREE-only refusal never leaks onto the draft rung');

  // a research ANSWER is not a plan — refusing plans must not ban findings docs at the top rung.
  A.ok(/findings doc/.test(free), 'FREE still permits a findings doc (an answer IS the deliverable)');
  A.ok(/NOT a plan/.test(free), 'and says so explicitly, so the model does not over-apply the ban');

  // an unknown/absent rung must behave like the permissive default, never silently like FREE.
  const unknown = AP.buildDoDirectiveV2(selected, base);
  A.ok(!/FINISH IT, DO NOT PLAN IT/.test(unknown), 'an absent initiative does not silently impose the FREE refusal');
})();

/* THE SELECTOR IS WHERE THE VISION LEAKS. Away-work exists to GET THINGS DONE toward the Commander's goals, but
   goals/quests/threads are often PHRASED as drafts — "Draft Automation Backlog" was a real quest that produced a
   real backlog instead of the tool it described. That choice happens at CANDIDATE time, before any card exists. */
(function selectorAimsAtFinishableWork() {
  const ctx = { beliefs: { goals: ['ship the station'] }, activity: ['ran a build (today)'], eligible: AP.ARCHETYPES };
  const free = AP.buildCandidateDirectiveV2(Object.assign({ initiative: 'free' }, ctx));
  const leash = AP.buildCandidateDirectiveV2(Object.assign({ initiative: 'leash' }, ctx));

  [['free', free], ['leash', leash]].forEach(([rung, d]) => {
    A.ok(/PREFER WHAT YOU CAN FINISH/.test(d), rung + ': the selector prefers work it can COMPLETE');
    A.ok(/the job is to BUILD X/.test(d), rung + ': a draft-phrased ask is re-read as an instruction to build the thing');
  });
  A.ok(/NEVER propose writing a plan, backlog, roadmap/.test(free), 'FREE additionally bans proposing a plan as the job');
  A.ok(!/NEVER propose writing a plan/.test(leash), 'BUILD (DRAFTS) keeps the softer form — plans are legitimate there');

  // the ARCHETYPE BLURBS teach the shape of work; two of them used to say "draft".
  const blurbs = AP.ARCHETYPES.map(a => a.blurb).join(' | ');
  A.ok(!/draft a tool/.test(blurbs), 'no archetype invites "draft a tool" instead of building one');
  A.ok(!/research \/ draft \/ stage/.test(blurbs), 'and none offers "draft" as a default deliverable shape');
  // the ids are LEARN-STORE KEYS — renaming one silently orphans a Commander's learned preferences.
  ['advance-goal', 'kill-pain', 'prep-next', 'maintain-extend', 'scout'].forEach(id =>
    A.ok(AP.ARCHETYPES.some(a => a.id === id), 'archetype id "' + id + '" is preserved (learn-store key)'));
})();

/* THE IMPLEMENT COMMIT IS FAIL-CLOSED (2026-08-15). A plain write + swallowed failures let the API announce
   `built` even when the on-disk loop guard was absent (or the manifest was truncated), and even when no durable
   backlog registration existed. The source plan could then be retired despite there being no reviewable build. */
(function implementCommitIsDurableAndOrdered() {
  const src = readSidecarSource();
  const start = src.indexOf('async function runImplementBuild(');
  const end = src.indexOf('\n/* ---- the WORKSHOP SHIFT ROUTINE', start);
  const body = src.slice(start, end);
  A.ok(start >= 0 && end > start, 'the real Implement routine is present for the durability contract');
  A.ok(/writeFileDurable\(\{ fs: fs, path: path \}, abs, JSON\.stringify\(raw, null, 2\)\)/.test(body),
    'the manifest loop guard uses the shared atomic durable writer, never a plain writeFile');
  A.ok(/proven\.implementOf !== String\(sourceRunId\)/.test(body),
    'the durable manifest stamp is read back and proved before registration');
  A.ok(/reason: 'manifest-stamp-failed'/.test(body),
    'a failed/mismatched manifest stamp returns an explicit failure');
  A.ok(/reason: 'registration-failed'/.test(body) && /built registration readback mismatch/.test(body),
    'durable backlog registration is read back and failure is explicit');
  A.ok(body.indexOf("reason: 'manifest-stamp-failed'") < body.indexOf('workshopStore.markBuilt'),
    'stamp failure exits before any built registration');
  A.ok(body.indexOf('workshopStore.markBuilt') < body.indexOf("chanEmit('workshop.built'"),
    'the station cannot emit workshop.built before durable registration');
  A.ok(/retireImplementedSource\(id, sourceRunId, source/.test(body),
    'source retirement runs through the recoverable durable transaction');
  A.ok(/reason: 'built-source-retire-failed'/.test(body),
    'a retirement failure is surfaced instead of silently claiming a clean build');
})();

A.report();
