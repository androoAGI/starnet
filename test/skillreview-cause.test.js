/* node test/skillreview-cause.test.js — W3.2's one rule for every skill review (skillreview.js reviewCause).

   The review runs only when the run gives it something to learn from, read from state the harness already holds: a
   verdict that teaches (always, due or not), and, on a due nudge, a correction cue in the Commander's own words (W1.4's
   cue resolver), a failed tool call in a run that succeeded, or a new multi-step procedure (several successful calls
   across two or more tools, no saved skill loaded), or a thumbs-up (praise rides the nudge: it qualifies only when due).
   The end-to-end proof is test/skillreview-useful.e2e.test.js; this pins the edges: what does NOT count (a call that never
   ran: refused, withdrawn or skipped; the skill, Task Brief and bookkeeping tools; one tool repeated; a run that followed a
   saved skill or a bundled recipe; praise under the bar; an undue count). Pure module, no sidecar. */
'use strict';
const A = require('./_assert.js');
const SR = require('../sidecar/skillreview.js');
const LC = require('../sidecar/learning-cooldown.js');
const { VERDICTS_THAT_TEACH } = require('../sidecar/verdictreview.js');

let at = 1000;
const call = (name, o) => { at += 10; return Object.assign({ callId: 'c' + at, name, startedAt: at, endedAt: at + 5, ms: 5, ok: true, isError: false, summary: 'ok' }, o || {}); };
const failed = (name, summary) => call(name, { ok: false, isError: true, summary: summary || 'error' });
const SKILL = [{ id: 's1', name: 'Deploy Site' }];
const cause = f => SR.reviewCause(Object.assign({ due: true, commanderWords: '', toolTrace: [], loadedSkills: [] }, f));
const steps = (...names) => names.map(n => call(n));

// ---- the verdict: a rating that teaches always qualifies, due or not ----
A.eq([...VERDICTS_THAT_TEACH].sort(), ['miss', 'ok'], 'the verdicts that teach are the ones the rating path arms (verdictreview.js)');
for (const v of ['ok', 'miss']) {
  A.eq(SR.reviewCause({ verdict: v }), 'verdict', 'a ' + v + ' verdict qualifies with nothing else known');
  A.eq(SR.reviewCause({ verdict: v, due: false, loadedSkills: SKILL, toolTrace: steps('fs_list') }), 'verdict', 'a ' + v + ' verdict qualifies on a clean run that is not due');
}
// praise (the thumbs-up) is a verdict too, on the cadence floor: due, it qualifies the run it rates; under the bar, nothing
A.eq(SR.PRAISE, 'great', 'the thumbs-up is the rate-the-work vocabulary\'s great');
A.eq(cause({ verdict: 'great', toolTrace: steps('fs_list', 'fs_list'), loadedSkills: SKILL }), 'verdict', 'a thumbs-up on a clean run qualifies it when the nudge is due');
A.eq(SR.reviewCause({ verdict: 'great', due: true }), 'verdict', 'a thumbs-up qualifies with nothing else known, when due');
A.eq(SR.reviewCause({ verdict: 'great', due: false, toolTrace: steps('fs_list'), loadedSkills: SKILL }), '', 'a thumbs-up under the bar reviews nothing (as before W3.2)');
A.eq(SR.reviewCause({ verdict: 'great' }), '', 'a thumbs-up without due: true is under the bar');
A.eq(cause({ verdict: 'meh' }), '', 'an unknown verdict is nothing');
// the size gate's verdict check (shouldReviewRun, kept for its tests) asks the same rule: praise alone never triggers it
const tinyRun = { reason: 'done', turns: 1, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
A.eq(['ok', 'miss', 'great', ''].map(v => SR.shouldReviewRun(tinyRun, { verdict: v })), [true, true, false, false], 'shouldReviewRun reads the verdicts through reviewCause');

// ---- an undue count: nothing but a verdict qualifies ----
A.eq(SR.reviewCause({ due: false, commanderWords: 'From now on, always list the steps.', toolTrace: [failed('fs_read')].concat(steps('fs_list', 'web_fetch', 'fs_list')) }), '',
  'a run whose nudge is not due is not reviewed, whatever it holds (the nudge stays the cadence floor)');
A.eq(SR.reviewCause({ commanderWords: 'never do that again', toolTrace: [failed('fs_read')] }), '', 'facts without due: true are an undue count');

// ---- a clean run: nothing to learn ----
A.eq(cause({ toolTrace: steps('skill_view', 'station_inspect', 'fs_list', 'station_inspect', 'fs_list'), loadedSkills: SKILL }), '',
  'a clean run that followed its saved skill (loaded, every call succeeded, no cue) is not reviewed');
A.eq(cause({}), '', 'a chat with no tools and no cue is not reviewed');
A.eq(cause({ toolTrace: steps('fs_read', 'fs_read', 'fs_read', 'fs_read', 'fs_read') }), '', 'one tool repeated is a lookup, not a procedure');
A.eq(cause({ toolTrace: steps('fs_list', 'fs_read') }), '', 'two successful calls are not yet a multi-step procedure');
A.eq(cause({ toolTrace: steps('skill_list', 'skill_view', 'skill_manage', 'skill_write', 'fs_list') }), '', 'the skill tools are the skillbase, never steps of the work');
A.eq(cause({ toolTrace: steps('brief_ask', 'brief_update', 'brief_proceed', 'station_inspect', 'fs_list') }), '', "the Task Brief tools are the run's own paperwork, never steps of the work (2 left)");
A.eq(cause({ toolTrace: steps('brief_proceed', 'station_inspect', 'fs_list', 'station_inspect') }), 'new-procedure', 'the work steps around a settled brief still count');
A.eq(cause({ toolTrace: steps('notebook_read', 'tool_search', 'notebook_write', 'memory_used', 'widget_set', 'memory_feedback') }), '',
  "the notebook, memory, tool-search and widget tools are the agent's own bookkeeping, never steps of a procedure");
A.eq(cause({ toolTrace: steps('notebook_read', 'tool_search', 'web_fetch', 'fs_write', 'notebook.write') }), '', 'bookkeeping around two steps of the work: 2 left');
A.eq(cause({ toolTrace: steps('notebook_read', 'web_search', 'web_fetch', 'fs_write', 'notebook_write') }), 'new-procedure', 'the work steps around the bookkeeping still count');

// ---- a correction cue in the Commander's own words (W1.4's resolver, reused) ----
for (const words of ['From now on, always list the steps before you run them.', "Don't push to main.", 'I prefer tabs over spaces in my code.', 'Next time, ask before you delete anything.']) {
  A.eq(LC.cueIn(words), true, 'fixture: W1.4 reads a cue in "' + words + '"');
  A.eq(cause({ commanderWords: words, loadedSkills: SKILL, toolTrace: steps('fs_list') }), 'correction', 'a cue qualifies: "' + words + '"');
}
for (const words of ['Survey the station and its workspace.', 'never mind, it was fine', "I don't know why it did that"]) {
  A.eq(cause({ commanderWords: words, loadedSkills: SKILL, toolTrace: steps('fs_list') }), '', 'no cue, no review: "' + words + '"');
}

// ---- a tool error in a run that still succeeded ----
A.eq(cause({ loadedSkills: SKILL, toolTrace: steps('skill_view', 'fs_list').concat([failed('fs_read')], steps('fs_list')) }), 'tool-error',
  'a failed call qualifies, a saved skill loaded or not (the skill may be the thing missing a step)');
A.eq(cause({ toolTrace: [failed('shell_exec', 'timeout')] }), 'tool-error', 'a timeout is a failed call');
A.eq(cause({ toolTrace: [call('fs_read', { ok: false, isError: false, summary: 'error' })] }), 'tool-error', 'ok:false alone is failed (the evidence packet\'s rule)');
A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed('fs_write', 'denied')].concat(steps('fs_list')) }), '', 'a DENIED approval is the Commander\'s decision, not a tool error');
for (const s of ['skipped — cancelled', 'skipped — terminal evidence', 'skipped - terminal evidence', 'skipped - cancelled', 'skipped']) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed('web_fetch', s)] }), '', 'a call the loop skipped never ran: "' + s + '"');
}
// a call refused before it ran is not an error of the work: the Commander's No, the station's policy, their own hook, a withdrawn card
for (const s of ['cancelled', 'capdenied', 'user-control-denied', 'code-nested-denied', 'hook-blocked']) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed('shell_exec', s)].concat(steps('fs_list')) }), '', 'a call refused before it ran ("' + s + '") is not a tool error');
}
for (const s of ['error', 'precondition', 'unknown-tool', 'dispatch-boundary-failed', 'skippedness']) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed('fs_edit', s)] }), 'tool-error', 'a call that ran (or was mis-called) and failed ("' + s + '") is a tool error');
}
A.eq(cause({ loadedSkills: SKILL, toolTrace: [{ callId: 'x', name: 'fs_read', startedAt: 1 }] }), '', 'a call with no result yet is neither failed nor a step');
for (const n of ['brief_proceed', 'brief.proceed', 'brief_update', 'skill_view', 'skill.manage', 'notebook_write', 'memory_forget', 'tool_search', 'widget_set']) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed(n)].concat(steps('fs_list')) }), '', 'a refused ' + n + " is the harness's own protocol, not a lesson about the task");
}

// ---- a new multi-step procedure ----
A.eq(cause({ toolTrace: steps('web_search', 'web_fetch', 'fs_write') }), 'new-procedure', 'three successful calls across tools, no saved skill loaded: a new procedure');
A.eq(cause({ toolTrace: steps('station_inspect', 'fs_list', 'station_inspect') }), 'new-procedure', 'two distinct tools are enough');
A.eq(cause({ toolTrace: steps('web_search', 'web_fetch', 'fs_write'), loadedSkills: SKILL }), '', 'the same steps under a loaded saved skill are not new');
A.eq(cause({ toolTrace: steps('skill_view', 'web_search', 'fs_write') }), '', 'the skill calls do not count toward the steps (2 left)');
A.eq(cause({ toolTrace: steps('skill_view', 'web_search', 'web_fetch', 'fs_write') }), '', 'a skill view that answered loaded a procedure (a bundled recipe never joins loadedSkills): not new');
A.eq(cause({ toolTrace: [failed('skill_view', 'error')].concat(steps('web_search', 'web_fetch', 'fs_write')) }), 'new-procedure', 'a skill view that found nothing loaded nothing');
A.eq(SR.procedureOf(steps('skill_list', 'brief_proceed', 'fs_list', 'fs_read', 'fs_read').concat([failed('fs_write')])), { steps: 3, tools: 2 }, 'procedureOf counts the successful calls of the work and their distinct tools');
A.eq([SR.PROCEDURE_STEPS, SR.PROCEDURE_TOOLS], [3, 2], 'the procedure floor: 3 successful calls across 2 tools');

// ---- the order of the kinds (one cause is named; any one qualifies) ----
A.eq(cause({ commanderWords: 'always do X', toolTrace: [failed('fs_read')].concat(steps('a_b', 'c_d', 'e_f')) }), 'correction', 'a correction is named before a tool error');
A.eq(cause({ toolTrace: [failed('fs_read')].concat(steps('a_b', 'c_d', 'e_f')) }), 'tool-error', 'a tool error is named before a new procedure');

// ---- robustness ----
A.eq(SR.reviewCause(), '', 'no facts: nothing');
A.eq(SR.reviewCause({ due: true, toolTrace: 'junk', loadedSkills: 'junk', commanderWords: { not: 'text' } }), '', 'junk facts: nothing, no throw');
A.eq(cause({ toolTrace: [null, undefined, 0].concat(steps('a_b', 'c_d', 'e_f')) }), 'new-procedure', 'holes in a trace are skipped');

A.report('skillreview-cause.test');
