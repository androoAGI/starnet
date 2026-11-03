/* node test/stop-reason.test.js — EVERY run stop says WHY, in words, on every surface (2026-10-11).

   The user report: "they start a task and then stop repeatedly with no explanation as to why." The harness's own
   stop messages ("loop guard: …", "loop breaker: …", an unkept memory promise, an output-limit cut) led COMMS with
   "Something went wrong on that turn — try again"; raw reasons ("stopped (empty)", "run cancelled", "(stopped: empty)")
   read as silent stops; the saved ⚠ row lost the reason on reload AND was replayed to the model as its own words; and
   a goal loop whose step stopped stayed "active" forever. Locked here:
     1. sidecar/stop-reason.js (channels, routines, loops) names each end reason in plain words;
     2. explainStop has ONE vocabulary: the sidecar copy and the browser mirror (friendlyerror.js) produce the same
        kind + words for the real loop messages, and friendlyError() leads with them on BOTH classifier paths;
     3. COMMS (chat.js, evaluated from its own source): the work-log stop line, the ⚠ history row that keeps the real
        reason, historyWindowFrom keeping ⚠ rows off the model's wire, and the goal loop pausing with a reason. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const SR = require('../sidecar/stop-reason.js');
const Friendly = require('../frontend/app/friendlyerror.js');

const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const loopSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'loop.js'), 'utf8');
const breakerSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'loop-breaker.js'), 'utf8');

/* ---- 1. plain stop sentences ---- */
A.ok(/empty reply, so nothing was done/.test(SR.stopSentence('empty')) && /continue/.test(SR.stopSentence('empty')), 'empty says what happened + what to do');
A.ok(/step limit/.test(SR.stopSentence('max_iters')), 'max_iters names the step limit');
A.eq(SR.stopSentence('done'), '', 'a clean end has nothing to explain');
A.ok(/output limit/.test(SR.stopSentence('done', { finishReason: 'length' })), 'a provider-cut "done" is not clean');
A.ok(/no published price|no price/.test(SR.stopSentence('budget', { unpricedModel: 'x/m', unpricedCapTokens: 5 })), 'the unpriced ceiling names itself');
A.ok(!/^run ended without completion: empty$/.test(SR.incompleteRunMessage('empty')) && /empty reply/.test(SR.incompleteRunMessage('empty')) && /\[empty\]$/.test(SR.incompleteRunMessage('empty')),
  'a routine settlement reads in words and keeps the machine reason for triage: ' + SR.incompleteRunMessage('empty'));
A.ok(/missing terminal outcome/.test(SR.incompleteRunMessage('')), 'a missing outcome is named, never blank');
// typed-outcomes: a provider-cut 'done' settles as cut_short in words; a routine's question says nobody can answer it
A.ok(/cut short by the model's output limit/.test(SR.incompleteRunMessage('done', { finishReason: 'length' })) && /\[cut_short\]$/.test(SR.incompleteRunMessage('done', { finishReason: 'length' })),
  'a cut reply names the cut and its outcome: ' + SR.incompleteRunMessage('done', { finishReason: 'length' }));
A.ok(/asked a question instead of finishing/.test(SR.incompleteRunMessage('clarifying')) && !/clean finish/.test(SR.incompleteRunMessage('clarifying')),
  'a routine that asked a question says so, never "without a clean finish"');
// a routine/loop has no conversation to say "continue" to: its settlement names a door that exists (review conveyor-backend-12)
for (const r of ['max_iters', 'empty']) {
  for (const extra of [undefined, { toolsRan: 2 }]) {
    const line = SR.incompleteRunMessage(r, extra);
    A.ok(!/continue/.test(line) && /run it again/.test(line), 'an unattended ' + r + ' end never says "continue": ' + line);
  }
}
A.ok(/continue/.test(SR.stopSentence('max_iters')) && /continue/.test(SR.stopSentence('empty')), 'the chat wording (Telegram/Discord) keeps its "continue" door');
A.ok(!/continue/.test(SR.stopSentence('done', { finishReason: 'length', unattended: true })), 'an unattended cut reply never says "continue"');
A.ok(!/continue/.test(SR.stopSentence('budget', { subscriptionModel: 'claude', unattended: true })), 'an unattended subscription ceiling never says "continue"');
// an empty end AFTER tools ran must never say "nothing was done" — a file may already be written (review threads-backend-03)
{
  const afterTools = SR.stopSentence('empty', { toolsRan: 2 });
  A.ok(!/nothing was done/.test(afterTools) && /2 tool steps/.test(afterTools) && /may already have made changes/.test(afterTools) && /continue/.test(afterTools),
    'an empty end after tool steps says they ran and may have changed things: ' + afterTools);
  A.ok(/1 tool step\b/.test(SR.stopSentence('empty', { toolsRan: 1 })), 'one tool step reads singular: ' + SR.stopSentence('empty', { toolsRan: 1 }));
  A.ok(!/nothing was done/.test(SR.incompleteRunMessage('empty', { toolsRan: 3 })) && /\[empty\]$/.test(SR.incompleteRunMessage('empty', { toolsRan: 3 })),
    'a routine/loop settlement after tool steps never says nothing was done: ' + SR.incompleteRunMessage('empty', { toolsRan: 3 }));
}

/* ---- 2. one vocabulary for the harness's own stops ---- */
// the real loop / breaker sources still emit the shapes the explainers key on
A.ok(/'loop guard: ' \+ nm \+ ' failed ' \+ n \+ ' times with identical arguments/.test(loopSrc), 'loop.js still emits the loop-guard stop shape');
A.ok(/Work is incomplete: the model kept announcing/.test(loopSrc) && /memory update is unverified/.test(loopSrc) && /promise to remember above is unverified/.test(loopSrc), 'loop.js still emits the incomplete/memory stop shapes');
A.ok(/hit the model\\'s output limit while writing a large/.test(loopSrc), 'loop.js still emits the output-limit stop shape');
A.ok(/the model called tools that do not exist/.test(breakerSrc) && /failed ' \+ n \+ ' times in a row/.test(breakerSrc) && /returned the identical result/.test(breakerSrc), 'loop-breaker.js still emits its three stop shapes');
const SAMPLES = [
  ['loop guard: fs_read failed 3 times with identical arguments — stopping a stuck loop', 'loop_stuck', /got stuck repeating one step: fs_read failed 3 times/],
  ['loop breaker: the model called tools that do not exist (launch_rocket) on 3 turns in a row — stopping', 'unknown_tools', /tools that don’t exist \(launch_rocket\)/],
  ['loop breaker: net_get failed 8 times in a row (with varying arguments) on an unattended run — stopping a run that is not making progress', 'tool_keeps_failing', /net_get kept failing \(8 times in a row/],
  ['loop breaker: shell_exec returned the identical result 5 turns in a row with identical arguments on an unattended run — stopping a run that is not making progress', 'no_progress', /shell_exec kept returning the same result/],
  ['Work is incomplete: the model kept announcing another action without making the tool call. The automatic continuation attempts have ended; no background work was started by these promises.', 'incomplete_work', /stopped before finishing/],
  ['The requested memory update is unverified: this run produced no successful notebook write receipt. The save claim above is not confirmed.', 'memory_unverified', /nothing was written to memory/],
  ['The promise to remember above is unverified: this run wrote nothing to memory, so a later run will not know it.', 'memory_unverified', /will not remember this next time/],
  ["The reply hit the model's output limit while writing a large fs_write call: it was cut off 3 times in a row and never ran, so nothing from it was saved.", 'output_limit', /output limit while writing a large fs_write call/],
  ['run checkpoint failed: ENOSPC: no space left on device', 'checkpoint_failed', /free disk space/],
  ['blocked by your hook `deploy-freeze`: deploys are frozen until Friday', 'hook_blocked', /Your hook `deploy-freeze` blocked this run: deploys are frozen until Friday/],
  ["context still too large after compacting: about 210,000 tokens remain against the model's 200,000-token window after 2 folds", 'context_overflow', /even after StarNet compacted it/]
];
for (const [msg, kind, words] of SAMPLES) {
  const s = SR.explainStop(msg), f = Friendly.explainStop(msg);
  A.ok(s && f, 'both copies explain: ' + msg.slice(0, 40));
  A.eq([s.kind, s.text], [f.kind, f.text], 'the sidecar copy and the browser mirror say the SAME thing for ' + kind);
  A.eq(s.kind, kind, 'kind of: ' + msg.slice(0, 40));
  A.ok(words.test(s.text), 'words of ' + kind + ': ' + s.text);
  const v = Friendly.friendlyError(new Error(msg));
  A.eq(v.userMessage, s.text, kind + ': COMMS leads with what happened, never "Something went wrong"');
  A.ok(!/Something went wrong/.test(v.userMessage), kind + ': not the generic headline');
  A.eq(v.raw, msg, kind + ': the raw text still rides along for the sub-line / diagnostics');
}
A.eq(SR.STOP_EXPLAINERS.map(e => e.kind + ':' + e.re.source), Friendly.STOP_EXPLAINERS.map(e => e.kind + ':' + e.re.source), 'the two explainer tables match pattern for pattern');
A.eq(Friendly.explainStop('Anthropic http 529 - Overloaded'), null, 'provider failures are not harness stops (their classifier owns them)');
A.eq(Friendly.friendlyError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'user_abort', 'a real user abort is still Stopped.');

/* ---- 3. COMMS ---- */
// the work-log line for a run that ENDED without a clean delivery
A.ok(/empty reply, so nothing was done/.test(Friendly.stopLine('empty')), 'COMMS: empty is explained, never "stopped (empty)"');
// an empty end AFTER tool steps: COMMS says what the chat surfaces say, in the same words (review threads-backend-03)
for (const n of [1, 2]) {
  const line = Friendly.stopLine('empty', { toolsRan: n });
  A.ok(!/nothing was done/.test(line), 'COMMS: an empty end after ' + n + ' tool step(s) never says nothing was done: ' + line);
  A.eq(line, SR.stopSentence('empty', { toolsRan: n }), 'COMMS mirrors the chat wording for an empty end after ' + n + ' tool step(s)');
}
A.eq(Friendly.stopLine('empty', { toolsRan: 0 }), SR.stopSentence('empty'), 'COMMS mirrors the chat wording for an empty end with no tool step');
A.ok(/outside this chat/.test(Friendly.stopLine('cancelled')) && /Pause Automation in the StarNet tray menu/.test(Friendly.stopLine('cancelled')), 'COMMS: a cancel that was not yours says it came from elsewhere, naming the tray\'s real Pause Automation');
A.ok(!/E-STOP/.test(Friendly.stopLine('cancelled')) && !/E-STOP/.test(Friendly.stopLine('cancelled', { cancelSource: 'estop_by_run' })), 'COMMS: stop lines never name an E-STOP the desk does not show (org P30)');
A.ok(/this run paused all automation/.test(Friendly.stopLine('cancelled', { cancelSource: 'estop_by_run' })) && /RESUME AUTOMATION/.test(Friendly.stopLine('cancelled', { cancelSource: 'estop_by_run' })), 'COMMS: the run\'s own automation pause keeps its line');
A.eq(Friendly.stopLine('done'), '', 'COMMS: a clean end has no stop line');
// review 9.2: a FAILED run says it failed, never the stop's word (every failed run's work log read "⏹ it stopped on an error before it finished"
// and its toast "run failed: it stopped on an error…"); the page's line is the chat surfaces' sentence plus its door, so the copies stay in step
A.ok(!/\bstop/i.test(SR.stopSentence('error')) && !/\bstop/i.test(Friendly.stopLine('error')) && Friendly.stopLine('error').indexOf(SR.stopSentence('error')) === 0
  && !/\bstop/i.test(SR.incompleteRunMessage('error')), 'a failed run is never told in the stop\'s word, on the page, in a chat or in a routine\'s settlement: '
  + Friendly.stopLine('error') + ' / ' + SR.stopSentence('error') + ' / ' + SR.incompleteRunMessage('error'));
// (review 9.1: the line reads the run's END word, endWord — the end reason, but 'refusal' for an end-only refusal, reason 'error' stamped 'refused')
A.ok(/Friendly\.stopLine\(endWord/.test(chat), 'COMMS routes its stop lines through Friendly.stopLine');
// threads-backend-03: the stop line hears how many tool calls this run made, so an "empty" end after real steps is
// never told "nothing was done" (callNames is the run's own callId -> tool map that onToolCall fills)
A.ok(/Friendly\.stopLine\(endWord, \{[^}]*toolsRan: Object\.keys\(callNames\)\.length/.test(chat), 'COMMS passes the run\'s tool-call count to its stop line');
A.ok(/stopActive\('esc'\)/.test(chat) && /■ STOPPED BY YOU \(ESC\)/.test(chat), 'Esc stops say STOPPED BY YOU (ESC) on the card');

// the ⚠ row keeps the real reason (unknown verdicts carry their raw text) …
{
  const errorHistoryLine = new Function(A.fnBody(chat, 'function errorHistoryLine(') + '\nreturn errorHistoryLine;')();
  A.eq(errorHistoryLine({ kind: 'unknown', userMessage: 'Something went wrong on that turn — try again.', raw: 'weird upstream thing 42' }),
    '⚠ Something went wrong on that turn — try again. (weird upstream thing 42)', 'an unknown failure keeps WHY beside the generic line');
  A.eq(errorHistoryLine({ kind: 'loop_stuck', userMessage: 'The agent got stuck…', raw: 'loop guard: …' }), '⚠ The agent got stuck…', 'a specific verdict already is the reason');
}
// … and never reaches the model's wire (coordinator ask, 2026-10-11)
{
  const src = A.fnBody(chat, 'function historyWindowFrom(');
  const stationModes = { window: 'legacy' };
  const historyWindowFrom = new Function('HistoryFit', 'stationModes', src + '\nreturn historyWindowFrom;')(require('../frontend/app/historyfit.js'), stationModes);
  const history = [
    { role: 'user', content: 'build the page' },
    { role: 'assistant', content: '⚠ Something went wrong on that turn — try again. (x)', error: true },
    { role: 'user', content: 'try again' },
    { role: 'assistant', content: 'partial', stopped: true, stopNote: 'stopped by you (Esc)' },
    { role: 'system', content: 'routine ran', sys: true }
  ];
  A.eq(historyWindowFrom(history).map(m => m.content), ['build the page', 'try again', 'partial'], 'legacy window retains its stopped partial while excluding the error annotation');
  stationModes.window = 'id';
  A.eq(historyWindowFrom(history).map(m => m.content), ['build the page', 'try again'], 'ID window excludes local stopped/error annotations through the shared classifier');
  A.eq(historyWindowFrom(history.concat([{ rowId: 4, streamId: 's', role: 'assistant', kind: 'turn', content: 'partial' }])).map(m => m.content),
    ['build the page', 'try again', 'partial'], 'actual canonical assistant prose remains replayable, even when a local stopped annotation had the same text');
}
// the stop reason rides the stopped turn and replays after a reload — in its outcome's own mark (review 9.3: endLogLine reads the end word
// noteStopReason keeps beside it; the stop's ⏹ is a stop's alone)
A.ok(/function noteStopReason\(/.test(chat) && /last\.stopWord = word/.test(chat) && /m\.stopped && m\.stopNote\) endLogLine\(m\.stopNote, m\.stopWord\)/.test(chat), 'a stopped turn keeps its reason, and its outcome\'s mark, across a reload');

// org pass 10-14 (P29): /goal is a SESSION goal — its set line says so and carries a real door key into AUTOMATE › GOAL LOOPS
{
  const src = A.fnBody(chat, 'function goalCommand(');
  const lines = [], opened = [];
  // the set line is a system row; its door row is that row's own child (systemDoor, P29-sys), never inside the prose
  const mkEl = () => { const el = { type: '', className: '', textContent: '', onclick: null, kids: [], dataset: {} }; el.appendChild = n => { el.kids.push(n); return n; }; el.classList = { contains: c => (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0 }; Object.defineProperty(el, 'children', { get: () => el.kids }); el.querySelectorAll = () => []; return el; };
  const row = mkEl(); row.className = 'cmsg system';
  const doc = { createElement: mkEl, createTextNode: t => ({ text: t }) };
  const GoalLoop = { create: (goal) => ({ goal, maxTurns: 8, status: 'active' }), statusLine: () => '' };
  let kicked = 0;
  const goal = new Function('GoalLoop', 'activeWs', 'goalOf', 'localLine', 'persistGoal', 'kickGoal', 'StationUI', 'document', A.fnBody(chat, 'function systemDoor(') + '\n' + src + '\nreturn goalCommand;')(
    GoalLoop, { id: 'w' }, () => null, t => { lines.push(t); return row; }, () => {}, () => { kicked++; }, { openTerm: (k, sec) => opened.push(k + ':' + sec) }, doc);
  goal('ship the landing page');
  A.ok(/^⊙ goal set for this session only: ship the landing page \(budget 8 turns\)\./.test(lines[0]) && !/ {2}|lasting goal loops/.test(lines[0]), 'the /goal set line says session-only, one space before the budget, no dangling door label: ' + lines[0]);
  A.ok(/It works while StarNet is open and stays with this session through a reload\./.test(lines[0]), 'org P19: it says when it runs — while StarNet is open, and that a reload keeps it on this session');
  const doorRow = row.kids.find(k => k && k.className === 'sys-doors');
  A.ok(doorRow && doorRow.kids[0] && doorRow.kids[0].className === 'sys-doors-lead' && doorRow.kids[0].textContent === 'Lasting goal loops:', 'P29 polish: the door rides a row of its own, labelled Lasting goal loops:');
  const door = doorRow && doorRow.kids.find(k => k && k.className && /goal-loops-door/.test(k.className));
  A.ok(door && door.type === 'button' && /\bsys-door\b/.test(door.className) && door.textContent === '▸ AUTOMATE › GOAL LOOPS', 'a real door key rides the line (not a menu path)');
  door.onclick(); A.eq(opened, ['automation:loops'], 'the door opens AUTOMATE › GOAL LOOPS');
  A.eq(kicked, 1, 'the session goal still starts working');
  A.ok(!/goal loop (paused|resumed|set)|No goal loop to|Cleared the goal loop|No paused goal loop/.test(src), 'every /goal control line says session goal');
}
// (live walk 10-14) /goal said 'Working toward it…' then sat silent while an optional curiosity nudge was up: a gentle nudge no
// longer holds the loop, and any real wait is SAID once
{
  const body = A.fnBody(chat, 'function goalWaitReason(') + '\n' + A.fnBody(chat, 'function goalBlocked(') + '\n'
    + 'const goalRetry = new Set();\nconst goalWaitSaid = new WeakMap();\n' + A.fnBody(chat, 'function kickGoal(') + '\nreturn { kickGoal, goalBlocked };';
  const mk = (st) => {
    const lines = [], sent = [], timers = [];
    const g = { status: 'active' };
    const f = new Function('S', 'goalOf', 'GoalLoop', 'isActiveWs', 'isBusy', 'studyBusy', 'threadBusy', 'taskQuestionLive', 'localLine', 'send', 'setTimeout',
      'let interview = S.interview, activeTurnin = S.turnin, activeNudge = S.nudge;\n' + body)(
      st, () => g, { isActive: x => x.status === 'active', continuationPrompt: () => 'NEXT STEP' }, () => true, () => false, () => false, () => false,
      () => !!st.question, t => lines.push(t), (p, o) => sent.push([p, o]), (fn) => timers.push(fn));
    return { f, lines, sent, timers };
  };
  const gentle = mk({ nudge: { row: {}, choiceRow: {}, dim: 'tone', beat: null } });
  gentle.f.kickGoal({ id: 'w' });
  A.eq(gentle.sent, [['NEXT STEP', { goalContinuation: true }]], 'an unanswered curiosity nudge does not hold the goal loop: the step is sent');
  A.eq(gentle.lines, [], '…and nothing claims a wait');
  const held = mk({ nudge: { keepUntilDecision: true } });
  held.f.kickGoal({ id: 'w' }); held.timers.shift()(); held.f.kickGoal({ id: 'w' });
  A.eq(held.sent, [], 'a nudge that must be decided still holds the loop');
  A.eq(held.lines, ['⏸ session goal waiting for your choice on the card above — the next step starts once that is settled.'], 'the wait is said ONCE, naming what it waits for: ' + held.lines.join(' | '));
  A.eq(held.timers.length, 1, '…and one re-check stays armed');
  const q = mk({ question: true });
  q.f.kickGoal({ id: 'w' });
  A.ok(q.sent.length === 0 && /waiting for your answer to the question above/.test(q.lines[0] || ''), 'an unanswered task question holds the loop and says so');
  A.ok(/goalBlocked\(activeWs\)/.test(chat.slice(chat.indexOf('function loopTick'), chat.indexOf('function loopCommand'))), '/loop ticks keep the same discipline (goalBlocked)');
}
// a goal-loop step that stopped pauses the loop WITH the reason, instead of leaving it "active" with nothing firing
{
  const src = A.fnBody(chat, 'async function judgeGoalTurn(');
  const lines = []; let paused = null;
  const s = { status: 'active' };
  const GoalLoop = { isActive: x => x.status === 'active', pause: (x, why) => { x.status = 'paused'; paused = why; } };
  const judge = new Function('goalOf', 'GoalLoop', 'persistGoal', 'isActiveWs', 'localLine', 'goalJudging', src + '\nreturn judgeGoalTurn;')(
    () => s, GoalLoop, () => {}, () => true, (t) => lines.push(t), new Set());
  (async () => {
    await judge({ id: 'w' }, null, true, 'the model sent back an empty reply, so nothing was done');
    A.eq(s.status, 'paused', 'a stopped continuation pauses the goal loop (no silent stall)');
    A.eq(paused, 'the model sent back an empty reply, so nothing was done', 'with the real reason');
    A.ok(/⏸ session goal paused: the model sent back an empty reply/.test(lines[0]) && /\/goal resume/.test(lines[0]), 'and says so with the existing resume control: ' + lines[0]);
    A.report('stop-reason.test');
  })().catch(e => { console.error(e); process.exit(1); });
}
