/* node test/skillreview-cause.test.js — W3.2's one rule for every skill review (skillreview.js reviewCause).

   The review runs only when the run gives it something to learn from, read from state the harness already holds: a
   verdict that teaches (always, due or not), and, on a due nudge, a correction cue in the Commander's own words (W1.4's
   cue resolver), a failed tool call in a run that succeeded, or a new multi-step procedure (several successful calls
   across two or more tools, no saved skill loaded), or a thumbs-up (praise rides the nudge: it qualifies only when due).
   The end-to-end proof is test/skillreview-useful.e2e.test.js; this pins the edges: what does NOT count (a call held or
   refused: the Task Brief's hold, a refusal, a host guard, a withdrawn card, a skip; the skill, Task Brief and bookkeeping
   tools; one tool repeated; a run that followed a saved skill or a bundled recipe; praise under the bar; an undue count).
   Pure modules, no sidecar: the family block reads the harness's dispatch sources as text and fails on a held-or-refused
   stamp nobody classified, and the last block reads sidecar/index.js to pin the thumbs-up's release (the governor before
   the count is spent; a throw answers no error). */
'use strict';
const A = require('./_assert.js');
const SR = require('../sidecar/skillreview.js');
const LC = require('../sidecar/learning-cooldown.js');
const { VERDICTS_THAT_TEACH } = require('../sidecar/verdictreview.js');
const { TaskIntent } = require('../frontend/app/fork.js');
// the sidecar as text through the source helper (index.js first, then every other sidecar file): source-helper H5
const { readSidecarSource } = require('./helpers/source.js');

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
// the run's checklist, its deliverable note, a recall of its own dialogue, a routine's scratchpad and a quest's tick are bookkeeping too
A.eq(cause({ toolTrace: steps('todo', 'web_search', 'todo') }), '', 'a todo write, one search and a todo update is one step of the work, not a procedure');
A.eq(cause({ toolTrace: steps('todo', 'recall_conversation', 'deliverable_note', 'routine_notepad', 'quest_update', 'routine.notepad', 'quest.update', 'deliverable.note', 'recall.conversation', 'web_search') }), '',
  'the checklist, the deliverable note, the dialogue recall, the routine scratchpad and the quest tick are never steps (1 left)');
A.eq(cause({ toolTrace: steps('todo', 'web_search', 'web_fetch', 'todo', 'fs_write', 'deliverable_note') }), 'new-procedure', 'the work steps around the checklist still count');
for (const n of ['todo', 'deliverable_note', 'recall_conversation', 'routine_notepad', 'quest_update']) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed(n)].concat(steps('fs_list')) }), '', 'a failed ' + n + ' is bookkeeping, not a lesson about the task');
}
A.eq(cause({ toolTrace: steps('todos', 'todo_list', 'web_search') }), 'new-procedure', 'only the exact bookkeeping names are excluded (a tool merely named like one is work)');

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
/* ---- a call HELD OR REFUSED is not an error of the work (skillreview.js heldOrRefused, the one rule) ----
   Someone or something other than the call stopped it: the Task Brief's hold (the host's NOT RUN, NOT FAILED stamp, fork.js
   TaskIntent.GATE_HELD), the Commander's No or a withdrawn card, the station's policy, their own hook, a host guard, a read
   whose result the host refused, the loop's skip. Review r2 (W3.2) found the brief hold and four guard stamps read as tool
   errors: a clean chat run whose first write came before brief_proceed fired a review. */
const HELD_OR_REFUSED = [TaskIntent.GATE_HELD, 'denied', 'cancelled', 'capdenied', 'user-control-denied', 'code-nested-denied', 'withheld',
  'untrusted-content-lockout', 'direct-domain-local', 'direct-domain-target-only', 'hook-blocked', 'recovery-replay-blocked', 'held-uncertain',
  'tool-budget', 'workspace-busy', 'loop-break', 'output-only', 'read refused: session deleted', 'read refused: not recorded',
  'read refused: too many sessions', 'skipped', 'skipped - cancelled', 'skipped — cancelled', 'skipped - terminal evidence', 'skipped — terminal evidence'];
/* still an error: a call that ran and failed ('error', 'precondition', 'timeout'), one the registry rejected as wrong in itself
   (unknown-tool; invalid arguments answer 'error'), and the progress guard's verdict that the work's own route is exhausted
   (strategy-exhausted, a normal tool error on purpose). dispatch-boundary-failed and recovery-journal-failed end the run
   (control.final, reason error), and a failed run is never reviewed: they count, and it is moot. */
const COUNTED = ['error', 'precondition', 'timeout', 'unknown-tool', 'strategy-exhausted', 'dispatch-boundary-failed', 'recovery-journal-failed', 'skippedness', 'read refusedness'];
// a success, never an error: an idempotent replay hands back the recorded result of a write that already succeeded
const SUCCEEDS = ['idempotent-replay'];
for (const s of HELD_OR_REFUSED) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: steps('skill_view').concat([failed('fs_write', s)], steps('fs_write', 'fs_list', 'station_inspect')) }), '',
    'a call held or refused ("' + s + '") is not a tool error');
  A.eq(SR.heldOrRefused(failed('fs_write', s)), true, 'heldOrRefused reads "' + s + '"');
}
A.eq(cause({ commanderWords: 'Survey the station and its workspace.', loadedSkills: ['Deploy Site'],
  toolTrace: [call('skill_view', { summary: 'loaded Deploy Site' }), failed('fs_write', TaskIntent.GATE_HELD)].concat(steps('fs_write', 'fs_list', 'station_inspect', 'fs_list')) }), '',
  'the r2 case: a clean chat run whose first write came before brief_proceed (held, then made again and ok) is not reviewed');
A.eq(TaskIntent.isGateHeld({ isError: true, summary: TaskIntent.GATE_HELD }), true, 'fixture: the brief hold is read by fork.js TaskIntent.isGateHeld, the resolver loop.js uses');
A.eq(cause({ loadedSkills: SKILL, toolTrace: [call('fs_write', { ok: false, isError: false, summary: TaskIntent.GATE_HELD })] }), 'tool-error',
  'the hold is the host\'s isError stamp; the same words on a result that is not an error are not the hold (isGateHeld\'s own rule)');
for (const s of COUNTED) {
  A.eq(cause({ loadedSkills: SKILL, toolTrace: [failed('fs_edit', s)] }), 'tool-error', 'a call that ran and failed, or was wrong in itself ("' + s + '"), is a tool error');
  A.eq(SR.heldOrRefused(failed('fs_edit', s)), false, 'heldOrRefused does not read "' + s + '"');
}
A.eq(SR.heldOrRefused(null), false, 'heldOrRefused(null) is false, no throw');

/* ---- THE FAMILY STAYS CLOSED: every stamp a call that did not run can come back with is classified ----
   Read as text (nothing is required that boots anything): the host's dispatch up to the registry, code.run's nested refusal,
   the registry's dispatch up to tool.run, the lead's host scope (domain-task.js), the idempotency gate, the host's read
   refusal (turn-directive.js), the journal's dispatch-boundary refusal (run-execution-state.js failJournal) and the loop's
   own results (skips). A new gate stamp fails here until someone decides whether
   it held the call (HELD_OR_REFUSED, and skillreview.js) or the call failed (COUNTED). */
{
  const fs = require('fs');
  const path = require('path');
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const between = (text, from, to, label) => {
    const a = text.indexOf(from), b = a >= 0 ? text.indexOf(to, a) : -1;
    A.ok(a >= 0 && b > a, 'the scan finds ' + label);
    return a >= 0 && b > a ? text.slice(a, b) : '';
  };
  const literals = (text, re) => { const out = []; let m; while ((m = re.exec(text))) out.push(m[1]); return out; };
  const idx = readSidecarSource();
  const hostDispatch = between(idx, 'const toolBudgetStopFor = (c) =>', 'r = await registry.dispatch(c, dctx);', "the host's dispatch up to the registry");
  const nested = between(idx, 'capCtx.composeDispatch = async', 'const result = await dispatch(call', "code.run's nested refusal");
  const registry = between(read('sidecar/tools/registry.js'), 'async function dispatch(call, ctx) {', 'tool.run(call.args, runCtx)', "the registry's dispatch up to tool.run");
  const domain = between(read('sidecar/domain-task.js'), 'function refusalOf(', '\n  }\n', "the lead's host-scope refusal");
  const idem = read('sidecar/idempotency-ledger.js');
  const quote = between(read('sidecar/turn-directive.js'), 'function quoteRefusal(', '\n}', "the host's read refusal");
  const journal = between(read('sidecar/run-execution-state.js'), 'function failJournal(', '\n  }\n', "the journal's dispatch-boundary refusal");
  const loop = read('sidecar/loop.js');
  const SUMMARY = /summary:\s*'([^']+)'/g;
  const found = new Set([].concat(
    literals(hostDispatch, SUMMARY), literals(nested, SUMMARY), literals(domain, SUMMARY), literals(idem, SUMMARY), literals(loop, SUMMARY), literals(journal, SUMMARY),
    literals(hostDispatch, /summary:\s*TaskIntent\.(\w+)/g).map(k => TaskIntent[k]),
    literals(quote, /'(read refused: [^']+)'/g),
    // the registry's refusals: errResult(text, '<stamp>'), or the default 'error' when no stamp is given
    registry.split('\n').filter(l => l.indexOf('errResult(') >= 0).map(l => { const all = literals(l, /,\s*'([a-z][a-z -]*)'\)/g); return all.length ? all[all.length - 1] : 'error'; })
  ));
  const known = new Set(HELD_OR_REFUSED.concat(COUNTED, SUCCEEDS));
  const unclassified = [...found].filter(s => !known.has(s));
  A.eq(unclassified, [], 'every stamp a call that did not run can carry is classified, held/refused or failed (found ' + found.size + ')');
  for (const s of [TaskIntent.GATE_HELD, 'withheld', 'untrusted-content-lockout', 'recovery-replay-blocked', 'tool-budget', 'capdenied', 'hook-blocked',
    'code-nested-denied', 'direct-domain-target-only', 'held-uncertain', 'workspace-busy', 'loop-break', 'read refused: too many sessions', 'skipped — cancelled',
    'recovery-journal-failed', 'strategy-exhausted', 'unknown-tool']) {
    A.ok(found.has(s), 'the scan reaches "' + s + '" where the harness stamps it');
  }
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

// ---- the thumbs-up's release (sidecar/index.js releaseHeldReview), read as text: the sidecar is never required here ----
{
  const idx = readSidecarSource();
  const start = idx.indexOf('\nfunction releaseHeldReview(');
  const body = start >= 0 ? idx.slice(start, idx.indexOf('\n}\n', start) + 3) : '';
  A.ok(body.length > 0, 'releaseHeldReview is a top-level function of the sidecar');
  const ask = body.indexOf("governor.admit('skill-review', { providerId: j.route, agentId, trigger: 'background' })");
  const spend = body.indexOf('skillNudge.set(agentId, 0)');
  A.ok(ask > 0 && spend > ask && body.slice(ask, spend).indexOf('return false;') > 0,
    'the released review asks the governor before it spends the held count, and a refusal keeps the count (the run end asks governor.admit(\'aux\') up front)');
  A.ok(body.indexOf('reviewCause({ verdict, due })') > 0, 'it asks the one rule, with the due count');
  A.ok(/try \{ skillReviewArmed = releaseHeldReview\(runId, canonical\.verdict, lead\); \} catch \(e\) \{ failNote\('skills\.praise\.release', e\); skillReviewArmed = false; \}/.test(idx),
    'a throw in the release never answers the saved thumbs-up with an error (failNote, armed false)');
}

A.report('skillreview-cause.test');
