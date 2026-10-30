/* node test/comms-system-register.test.js — REGRESSION LOCK for the COMMS SYSTEM register (org P29-sys, Andrew 10-14:
   "system messages in general should have a cleaner UI, it looks ugly and unaligned").

   What it locks:
   1. A goal-loop continuation turn is the STATION's words: it renders as ONE compact system line naming the goal — live
      (send) and on every replay (renderHistory) — never as the Commander's speech. The wire text it sends is unchanged.
   2. The system register is one quiet aligned column (comms-convo.css): the agent's text edge, one type step under prose,
      door keys in one compact glass row, no glow. Door placement + the no-repeat rule run in slash.palette.test.js.
   chat.js is browser-flow, so the functions are lifted out of the source and run against stubs (the house pattern). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const GoalLoop = require('../frontend/app/goalloop.js');

const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/comms-convo.css'), 'utf8');

/* ---------- 1. the continuation prompt: wire text unchanged, its goal readable back out ---------- */
{
  const s = GoalLoop.create('ship the landing page', { now: 1000 });
  const wire = GoalLoop.continuationPrompt(s);
  A.eq(wire, '[Continuing toward your session goal]\nGoal: ship the landing page\n\n'
    + 'Continue working toward this goal. Take the next concrete step. '
    + 'If you believe the goal is complete, state so explicitly and stop. '
    + 'If you are blocked and need input from the user, say so clearly and stop.', 'the continuation the model receives is byte-identical');
  A.eq(GoalLoop.continuationGoal(wire), 'ship the landing page', 'a continuation names its goal');
  GoalLoop.addSubgoal(s, 'it has a dark mode');
  const withSubs = GoalLoop.continuationPrompt(s);
  A.ok(withSubs.indexOf('Additional criteria the Commander added:\n- 1. it has a dark mode') > 0, 'subgoals still ride the continuation');
  A.eq(GoalLoop.continuationGoal(withSubs), 'ship the landing page', '…and the goal still reads back with criteria attached');
  const multi = GoalLoop.create('ship the page\nand the pricing table', { now: 1000 });
  A.eq(GoalLoop.continuationGoal(GoalLoop.continuationPrompt(multi)), 'ship the page\nand the pricing table', 'a multi-line goal reads back whole');
  A.eq(GoalLoop.continuationGoal('can you ship the landing page?'), null, 'a Commander message is not a goal step');
  A.eq(GoalLoop.continuationGoal('please read this: [Continuing toward your session goal]\nGoal: x\n\nContinue working toward this goal. '), null, 'quoting the marker mid-message is not a goal step');
  A.eq(GoalLoop.continuationGoal('[Continuing toward your session goal]\nGoal: x'), null, 'a truncated marker without its directive is not a goal step');
  A.eq(GoalLoop.continuationGoal(null), null, 'nothing is not a goal step');
  // a goal step SAVED before the org pass (0.13.2 / 0.13.3 / the 0.13.5 candidate wrote "standing goal") still reads back
  const legacy = '[Continuing toward your standing goal]\nGoal: ship the landing page\n\n'
    + 'Continue working toward this goal. Take the next concrete step. '
    + 'If you believe the goal is complete, state so explicitly and stop. '
    + 'If you are blocked and need input from the user, say so clearly and stop.';
  A.eq(GoalLoop.continuationGoal(legacy), 'ship the landing page', 'a pre-org-pass "standing goal" step names its goal too');
  A.eq(GoalLoop.continuationGoal('[Continuing toward your standing goal]\nGoal: ship it\n\nAdditional criteria the Commander added:\n- 1. dark mode\n\nContinue working toward the goal AND every criterion. '),
    'ship it', '…with its criteria attached');
  A.eq(GoalLoop.continuationGoal('[Continuing toward your mystery goal]\nGoal: x\n\nContinue working toward this goal. '), null, 'only the two known heads are goal steps');
  A.ok(wire.indexOf('[Continuing toward your session goal]') === 0, 'the WRITER still uses the current head only');
}

/* ---------- 2. the goal step line: ONE system row, the goal named, nothing of the internal prompt ---------- */
const stepLineSrc = A.fnBody(chat, 'function goalStepLine(');
const stepOfSrc = A.fnBody(chat, 'function goalStepOf(');
A.ok(stepLineSrc && stepOfSrc, 'goalStepLine + goalStepOf exist');
const mkRow = () => { const cls = new Set(); return { d: { classList: { add: c => cls.add(c) }, cls }, body: { textContent: '' } }; };
{
  const rows = [];
  const goalStepLine = new Function('log', 'row', 'autoscroll', stepLineSrc + '\nreturn goalStepLine;')({}, (role) => { const r = mkRow(); r.role = role; rows.push(r); return r; }, () => {});
  goalStepLine('ship the landing page');
  A.eq(rows.length, 1, 'a goal step is ONE row');
  A.eq(rows[0].role, 'system', '…in the SYSTEM register, never the Commander\'s');
  A.ok(rows[0].d.cls.has('goal-step'), '…marked as a goal step');
  A.eq(rows[0].body.textContent, '↻ Continuing toward your session goal — ship the landing page', 'it reads as one compact station line');
  goalStepLine('line one\n\nline two ' + 'x'.repeat(300));
  A.ok(rows[1].body.textContent.length <= 202 && /…$/.test(rows[1].body.textContent) && !/\n/.test(rows[1].body.textContent), 'a long goal is clamped to one tidy line');
}

/* ---------- 3. replay: renderHistory shows a stored continuation as the station's line ---------- */
{
  const src = A.fnBody(chat, 'function renderHistory(');
  A.ok(src.length > 200 && src.length < 8000, 'renderHistory sliced cleanly');
  const users = [], steps = [], agents = [];
  const goalStepOf = new Function('GoalLoop', stepOfSrc + '\nreturn goalStepOf;')(GoalLoop);
  const params = ['activeWs', 'renderingHistory', 'replayableDeliverables', 'replayDeliverableRow', 'trimMarkerLine', 'goalStepOf', 'goalStepLine',
    'addUser', 'toolLine', 'Fork', 'App', 'row', 'renderProse', 'turnFileRefs', 'isBusy', 'offerTryAgain', 'offerRetry'];
  const renderHistory = new Function(...params, src + '\nreturn renderHistory;')(
    null, false, () => [], () => {}, () => {}, goalStepOf, g => steps.push(g),
    (t, atts, stamp, from) => users.push({ t, from }), () => {}, undefined, undefined,
    () => { const r = mkRow(); agents.push(r); return r; }, (b, t) => { b.textContent = t; }, () => [], () => false, () => {}, () => {});
  const s = GoalLoop.create('ship the landing page', { now: 1 });
  renderHistory([
    { role: 'user', content: 'can you check the build?', ts: 1 },
    { role: 'assistant', content: 'Green.', ts: 2 },
    { role: 'user', content: GoalLoop.continuationPrompt(s), ts: 3 },
    { role: 'assistant', content: 'Drafted the hero section.', ts: 4 },
    { role: 'user', content: GoalLoop.continuationPrompt(s), ts: 5, from: 'nova' },
    { role: 'user', content: '[Continuing toward your standing goal]\nGoal: old goal\n\nContinue working toward this goal. Take the next concrete step.', ts: 6 }
  ]);
  A.eq(steps, ['ship the landing page', 'old goal'], 'a stored goal step (current OR pre-org-pass head) replays as ONE station line naming the goal');
  A.eq(users.map(u => u.t), ['can you check the build?', GoalLoop.continuationPrompt(s)], 'only real turns replay as the Commander\'s (a delegated brief keeps its own row)');
  A.ok(!users.some(u => /^\[Continuing toward your session goal\]/.test(u.t) && !u.from), 'the internal continuation prompt never replays as the Commander\'s speech');
  A.eq(agents.length, 2, 'the agent\'s replies still replay');
}

/* ---------- 4. live: send() shows the step line, the history turn (= the model's wire) is untouched ---------- */
{
  const send = A.fnBody(chat, 'async function send(');
  A.ok(send.length > 1000, 'send() sliced');
  A.ok(/if \(goalContinuation\) goalStepLine\(goalStepOf\(text\) \|\| \(\(goalOf\(ws\) \|\| \{\}\)\.goal\) \|\| ''\); else addUser\(text, attsIn, uts\);/.test(send),
    'a live continuation renders the goal step line instead of a Commander row');
  A.ok(/ws\.history\.push\(attsIn\.length \? \{ role: 'user', content: text, attachments: attsIn, ts: uts \} : \{ role: 'user', content: text, ts: uts \}\)/.test(send),
    'the continuation still enters history as the same user-role turn (nothing new on the wire)');
  A.ok(/send\(prompt, \{ goalContinuation: true \}\)/.test(A.fnBody(chat, 'function kickGoal(')), 'kickGoal still sends GoalLoop.continuationPrompt as the turn');
  // the session's name: a goal step titles it from its GOAL (the rail row + the P26 COMMS title), never the marker prompt
  A.ok(/Workstreams\.autoTitle\(ws\.id, goalContinuation \? \(goalStepOf\(text\) \|\| \(goalOf\(ws\) \|\| \{\}\)\.goal \|\| ''\) : text\)/.test(send),
    'send() names an untitled session from the goal when the turn is a goal step');
}

/* ---------- 4b. /goal names an untitled session from its goal BEFORE the first step (which may wait on a busy stream) ---------- */
{
  const src = A.fnBody(chat, 'function goalCommand(');
  const W = require('../frontend/app/workstreams.js');
  W.reset();
  const ws = W.create(null);
  const order = [];
  const goal = new Function('GoalLoop', 'activeWs', 'goalOf', 'localLine', 'persistGoal', 'kickGoal', 'StationUI', 'Workstreams', 'App', 'paintTitle', src + '\nreturn goalCommand;')(
    GoalLoop, ws, () => null, () => null, () => {}, () => order.push('kick'), undefined, W, { refreshRail: () => order.push('rail') }, () => order.push('title'));
  goal('ship the landing page');
  A.eq(W.titleOf(ws), 'ship the landing page', '/goal on an untitled session names it from the goal');
  A.eq(order, ['rail', 'title', 'kick'], '…and repaints the rail + COMMS title before the first step is sent');
  ws.title = 'My launch'; ws.titleAuto = false; order.length = 0;
  goal('ship the pricing page');
  A.eq(W.titleOf(ws), 'My launch', 'a session that already has a name keeps it');
  A.eq(order, ['kick'], '…with no extra repaint');
}

/* ---------- 5. /history names a goal step as the station's, not "You" ---------- */
{
  const src = A.fnBody(chat, 'function historyCommand(');
  const cards = [];
  const goalStepOf = new Function('GoalLoop', stepOfSrc + '\nreturn goalStepOf;')(GoalLoop);
  const s = GoalLoop.create('ship the landing page', { now: 1 });
  const history = new Function('activeWs', 'localLine', 'systemCard', 'goalStepOf', src + '\nreturn historyCommand;')(
    { history: [{ role: 'user', content: 'hi' }, { role: 'user', content: GoalLoop.continuationPrompt(s) }, { role: 'assistant', content: 'on it' }] },
    () => {}, (title, lines) => cards.push(lines), goalStepOf);
  history('');
  A.eq(cards[0], ['You: hi', 'Goal step: ship the landing page', 'Agent: on it'], '/history lists a goal step as the station\'s line');
}

/* ---------- 6. the register's look (comms-convo.css) — the SYSTEM card (Andrew 10-30, on the 10-14 rail column: "absolutely
   unacceptable and hideous … all differently spaced, the text is ugly and tiny … IT NEEDS TO LOOK CLEAN"; on the card: "yes this
   is a perfect fit for system messages") ---------- */
const rule = sel => { const i = css.indexOf(sel); if (i < 0) return ''; return css.slice(i, css.indexOf('}', i) + 1); };
const SYS = 'body #chat-panel :is(#chat-log, #gc-log) > .cmsg.system';
const has = (src, needle) => src.indexOf(needle) >= 0;
const card = rule(SYS + ' {');
A.ok(has(card, 'border: 1px solid var(--sys-edge); border-width: 0 1px;') && has(card, 'background: var(--sys-face)') && has(card, 'padding: 0 16px 10px;'), 'a run of station lines is ONE card: soft side edges, one face, 16px text edge');
A.ok(has(rule(SYS + ':not(.cmsg.system + .cmsg.system) {'), 'border-top-width: 1px; border-top-left-radius: 10px; border-top-right-radius: 10px;'), "the run's first line carries the card's top edge (top radii only, so a one-line run keeps its bottom corners)");
A.ok(has(rule(SYS + ':not(:has(+ .cmsg.system)):not(:has(+ .choice-row)) {'), 'border-bottom-width: 1px; border-bottom-left-radius: 10px; border-bottom-right-radius: 10px;'), "the run's last line carries the bottom edge");
A.ok(has(rule(SYS + ' + .cmsg.system {'), 'margin-top: -6px'), "the lines of a run sit flush (the log's 6px flex gap taken back), so the card is one surface");
A.ok(has(rule(SYS + ' + .cmsg.system > .who {'), 'display: none'), 'the SYSTEM tag heads the card once');
const parts = rule(SYS + ' > :is(.body, .syscard-head, .syscard-body, .sys-doors) {');
A.ok(has(parts, 'padding: 0; border: 0;') && !has(parts, 'border-left'), "every part of a line starts on the card's edge: no rail, no second indent");
const text = rule(SYS + ' > :is(.body, .syscard-head) {');
A.ok(has(text, 'font-size: var(--sn-type-prose) !important;') && has(text, 'line-height: 1.5;') && has(text, 'color: color-mix(in srgb, var(--text) 86%, transparent)'), "the station's words read at the cards' prose size in the reading colour (they were 16px in the dim purple)");
A.ok(has(fs.readFileSync(path.join(__dirname, '../frontend/css/readability.css'), 'utf8'), '--sn-type-prose: 18px;'), 'prose is 18px');
A.ok(has(rule(SYS + ' .syscard-row {'), 'font-size: var(--sn-type-control)'), "an opened readout's rows stay readable (16px)");
const chev = rule(SYS + ' > .syscard-head .syscard-chev {');
A.ok(has(chev, 'font-size: 0;') && has(chev, 'border-right: 1.5px solid currentColor'), "the readout's chevron is drawn in CSS (VT323 has no ▸)");
const key = rule(SYS + ' .sys-door,');
A.ok(has(key, 'border: 1px solid var(--beat-edge)') && has(key, 'box-shadow: inset 0 1px 0 var(--beat-light)') && has(key, 'border-radius: 8px'), 'door keys wear the glass key (beat edge + inset light, 8px)');
A.ok(has(key, 'font-size: var(--sn-type-control)') && has(key, 'text-shadow: none'), 'a door key is matte and never bigger than its message');
A.ok(has(rule('body #chat-panel :is(#chat-log, #gc-log) > .cmsg.system + .choice-row {'), 'border-radius: 0 0 10px 10px;'), "a choice row that answers the card's last line closes the card as its footer");
const sysBlock = css.slice(css.indexOf("THE STATION'S OWN WORDS"));
// a glow is a shadow with no offset (box-/text-shadow "0 0 Npx"); the card's own "margin: 0 0 8px" and "border-radius: 0 0 10px
// 10px" are not shadows, so the check reads the shadow declarations only
A.ok(sysBlock.length > 500 && !/(?:box|text)-shadow:[^;}]*(?:^|[\s,])0 0 \d+px/.test(sysBlock), 'no glow anywhere in the system register');
A.ok(has(rule(SYS + ' > .sys-doors {'), 'display: flex; flex-wrap: wrap;'), "a line's keys share ONE wrapping row");

A.report('comms-system-register.test');
