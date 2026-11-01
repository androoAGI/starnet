/* node test/comms-render-seams.test.js — COMMS never shows machine syntax or harness chatter (rc walk 2026-10-14).

   A live walk on a real model (claude-haiku-4.5, Ask mode) found six seams in what COMMS draws. This file pins the ones
   that are not already pinned beside their engines (the marker grammar lives in fork.test.js, the marker-ended reply and
   the nudge wording in continuation-guard.test.js):
   A. THE BRIEF GATE'S PAUSE: a consequential call made before the Task Brief settles is HELD by the host and did not run.
      It drew a red "✗ team.dispatch failed" chip. The host stamps one shared summary (fork.js TaskIntent.GATE_HELD) and these
      surfaces draw that call as not-run: the COMMS and group chips, the world (no red pulse), the desk screen (live and from
      the transcript), the run's telemetry lines, a worker's receipt (not a step), and the phone's live steps. Station SETUP
      (station.control group.add, session rename…; group.add brought "MY READ" cards and the red chip) is never held;
      deleting, wiping or rewinding settings still wait for the brief.
   chat.js is browser-flow (DOM + streaming), not node-loadable, so — like comms-presence.test.js — its DOM-layer invariants
   are read from the source; the pure halves are executed. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const Fork = require('../frontend/app/fork.js');
const TaskIntent = Fork.TaskIntent;
const Policy = require('../sidecar/taskbrief-policy.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeStationControlTools } = require('../sidecar/tools/builtin/station-control.js');

/* ---------- A. the brief gate's pause is neutral, never a failure ---------- */
{
  const held = { isError: true, ok: false, summary: TaskIntent.GATE_HELD };
  A.ok(TaskIntent.isGateHeld(held), 'the host-stamped held result is recognised');
  A.ok(!TaskIntent.isGateHeld({ isError: true, summary: 'error' }), 'an ordinary failure is not a held call');
  A.ok(!TaskIntent.isGateHeld({ isError: false, summary: TaskIntent.GATE_HELD }), 'a success never reads as held');
  A.ok(/not run yet/.test(TaskIntent.GATE_HELD), 'the held summary says the call did not run: ' + TaskIntent.GATE_HELD);

  const idx = readSidecarSource();
  const gate = /if \(!gate\.ok\) return \{[^\n]*\};/.exec(idx);
  A.ok(gate && /summary: TaskIntent\.GATE_HELD/.test(gate[0]), 'the host gate stamps the shared held summary (one source of truth)');
  A.ok(gate && /TaskIntent\.GATE_HELD_LEAD/.test(gate[0]) && /nothing ran/.test(TaskIntent.GATE_HELD_LEAD) && /make the brief call with no text before it and never mention the gate/.test(gate[0]), 'and tells the model nothing ran and not to narrate the gate');
  A.ok(gate && /isError: true/.test(gate[0]), 'the result stays an error for the model (the call really did not run)');
  A.ok(gate && /TaskIntent\.GATE_HELD_LEAD \+ ' ' \+ String\(gate\.reason\)\.charAt\(0\)\.toUpperCase\(\) \+ String\(gate\.reason\)\.slice\(1\)/.test(gate[0]), 'the gate text starts its reason as a sentence (the desk screen shows it): "nothing ran. Settle…"');

  const chat = read('frontend/app/chat.js');
  const rc = /function foldChipResult\(chip, ev\) \{[\s\S]*?\n  \}/.exec(chat);
  A.ok(rc && /TaskIntent\.isGateHeld\(ev\)/.test(rc[0]), 'the chip result fold (live rail and group rail) reads the held stamp');
  A.ok(/function resolveChip\(ev, fallbackName\) \{[\s\S]{0,500}foldChipResult\(chip, ev\);/.test(chat), 'the live rail folds results through it');
  A.ok(rc && /classList\.add\(heldCall \? 'held' : deniedCall \? 'denied' : ev\.isError \? 'err' : 'ok'\)/.test(rc[0]), 'a held call draws the neutral .held chip, never .err');
  A.ok(rc && /heldCall \? 'not run yet'/.test(rc[0]) && !/heldCall \? '✗'/.test(rc[0]), 'its stat reads "not run yet", never ✗ failed');
  A.ok(/U\.bus\.emit\('agent\.tool_result', \{[^\n]*held: !!\(typeof TaskIntent !== 'undefined' && TaskIntent\.isGateHeld && TaskIntent\.isGateHeld\(ev\)\)/.test(chat), 'the bus copy carries held for the world');
  A.ok(/if \(tgt && !p\.held\) PropSprites\.pulseProp/.test(read('frontend/app/world.js')), 'the world never pulses a prop red for a call that did not run');
  A.ok(/s\.ok = \(typeof TaskIntent !== 'undefined' && TaskIntent\.isGateHeld && TaskIntent\.isGateHeld\(p\)\) \? null/.test(read('frontend/app/deskscreen.js')), 'the desk screen records no outcome (not a failed step)');
  // the DESK SCREEN once the run's transcript loads (rc review 2026-10-14): the held call read "bad" and its screen showed the
  // gate's instructions to the model; live, a held fs.write read as a finished "ok" editor screen
  {
    global.TaskIntent = TaskIntent;
    const D = require('../frontend/app/deskscreen.js');
    const gateBody = 'ERROR: Task Brief gate: nothing ran. Settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work, then make this same call again. This is a routine step: the Commander sees your brief as its own card, so make the brief call with no text before it and never mention the gate.';
    const rows = [
      { role: 'assistant', toolCalls: JSON.stringify([{ id: 'w1', function: { name: 'fs_write', arguments: '{"path":"a.md","content":"hello"}' } }]) },
      { role: 'tool', toolCallId: 'w1', content: gateBody },
      { role: 'assistant', toolCalls: JSON.stringify([{ id: 'w2', function: { name: 'fs_write', arguments: '{"path":"b.md","content":"x"}' } }]) },
      { role: 'tool', toolCallId: 'w2', content: 'ERROR: EACCES: permission denied' }
    ];
    const [heldStep, failedStep] = D._parseScreens(rows);
    A.ok(heldStep.held === true && !heldStep.isError && heldStep.done, 'a held call in the transcript is a held screen, not a failed one');
    A.ok(failedStep.isError && !failedStep.held, 'a real failure still reads as failed');
    const sc = D._screenOf(heldStep);
    A.eq(sc.note, TaskIntent.GATE_HELD, 'its screen status says "not run yet — waiting on the task brief"');
    A.ok(!/brief_proceed|never mention the gate|not written/.test(JSON.stringify(sc)), 'the gate\'s instructions to the model never reach the screen');
    A.ok(/not written/.test(D._screenOf(failedStep).note), 'a failed write still says not written');
    const ds = read('frontend/app/deskscreen.js');
    A.ok(/data-s="' \+ \(!s\.done \? 'run' : s\.held \? 'held' : s\.isError \? 'bad' : 'ok'\)/.test(ds), 'a held screen is its own state, never "bad" or "ok"');
    A.ok(/held: !!\(st\.done && st\.ok === null\)/.test(ds) && /s\.held = !!\(st\.done && st\.ok === null\)/.test(ds), 'the live screen keeps a held step held (the bus step records no outcome)');
    A.ok(/\.ds-app\[data-s="held"\] \.ds-status \{ color: var\(--ph-dim\); \}/.test(read('frontend/css/deskscreen.css')), 'and draws it in dim phosphor');
    A.ok(TaskIntent.isGateHeldBody(gateBody) && TaskIntent.isGateHeldBody(gateBody.slice(7)) && !TaskIntent.isGateHeldBody('ERROR: EACCES'), 'one recogniser for the held result text (with or without the ERROR: prefix)');
    A.ok(/content: TaskIntent\.GATE_HELD_LEAD \+ ' '/.test(idx), 'the host writes the held result with that same lead');
  }
  // the run's telemetry lines under a resolved presence card read "not run yet" for it, never "failed" in red
  {
    const tr = /function telemetryRun\(entry, role, skipTools\) \{[\s\S]*?\n  \}/.exec(chat);
    A.ok(tr && /const held = typeof TaskIntent !== 'undefined' && TaskIntent\.isGateHeld && TaskIntent\.isGateHeld\(t\);/.test(tr[0]) && /\(held \? ' held' : denied \? ' denied' : t\.isError \? ' err' : ''\)/.test(tr[0]) && /held \? 'not run yet' : denied \? 'denied' : t\.isError \? 'failed' : 'ok'/.test(tr[0]), 'a held call\'s telemetry line reads "not run yet", never "failed"');
  }
  // the PHONE live view (rc review 2026-10-14: it drew ✕ for a held call): the station sends held, and the phone app draws it
  const host = read('sidecar/remote/host.js'), phone = read('relay/app/app.js');
  A.ok(/const held = TaskIntent\.isGateHeld\(p\);[\s\S]{0,200}ok: held \? null : \(!!p\.ok && !p\.isError\)[\s\S]{0,80}held \? \{ held: true \} : \{\}/.test(host), 'the phone step for a held call carries held and no outcome (an older phone shows it pending, never ✕)');
  A.ok(/if \(s\) \{ s\.ok = e\.held \? null : e\.ok; if \(e\.held\) s\.held = true; \}/.test(phone) && /if \(s\.held\) d\.appendChild\(el\('b', 'h', '▸'\)\);/.test(phone) && /s\.held \? ' · not run yet' : ''/.test(phone), 'the phone draws a held step as a dim ▸ "not run yet"');
  A.ok(/\.step b\.h \{ color: var\(--ph-dim\); \}/.test(read('relay/app/app.css')), 'in dim phosphor, not red');
  const css = read('frontend/css/comms.css');
  A.ok(/\.tool-chip\.held \.tc-glyph,\s*\n\.tool-chip\.held \.tc-stat\s*\{ color: var\(--ph-dim\); \}/.test(css), 'the held chip is plain dim phosphor (no red)');

  // a station setting is setup, not the deliverable: station.control passes an unsettled brief; station.power still waits
  const reg = makeRegistry();
  makeStationControlTools({ station: { request: async () => ({ ok: true }) }, route: async () => ({ status: 200, json: { ok: true } }), surface: 'interactive' }).register(reg);
  const ctl = reg.get('station.control'), unsettled = { status: 'ready' };
  for (const action of ['group.add', 'group.configure', 'session.rename', 'session.pin', 'session.archive', 'look.set', 'estop.engage']) {
    A.eq(Policy.canMutate(unsettled, ctl, { args: { action, args: {} } }).ok, true, 'station.control ' + action + ' (station setup) is never held behind the Task Brief');
  }
  A.eq(Policy.canMutate(unsettled, ctl, { args: { setting: 'group.add', members: ['copywriter'] } }).ok, true, 'the exemption reads the call the way the tool does (action named as setting, args flat)');
  // only SETUP is exempt: a destructive or deliverable-shaping setting still waits for the brief (rc review 2026-10-14)
  for (const action of ['agent.delete', 'session.delete', 'memory.reset', 'learning.wipe', 'checkpoint.restore', 'deliverables.cleanup', 'away.queue', 'deliverable.decide']) {
    A.eq(Policy.canMutate(unsettled, ctl, { args: { action, args: {} } }).ok, false, 'station.control ' + action + ' still waits for brief_proceed');
  }
  A.eq(Policy.canMutate(unsettled, ctl).ok, false, 'a station.control call the gate cannot read is held (fail closed)');
  A.eq(Policy.canMutate(unsettled, ctl, { args: { action: 'nope.nothing' } }).ok, false, 'an unknown action is held');
  A.eq(Policy.canMutate(unsettled, reg.get('station.power'), { args: { action: 'group.add', args: {} } }).ok, false, 'station.power (an escalation) still waits for brief_proceed');
  A.ok(/TaskBriefPolicy\.canMutate\(taskBriefState\.brief, liveTool, c\)/.test(idx), 'the host gate hands the call to canMutate, so an action-aware exemption sees the action');
}

/* ---------- A1. an approval not given reads "denied", never "failed" (releases#9, 2026-10-17) ----------
   Deny on an approval card: the call did not run, the agent carries on, the run ends done (test/e2e.run-truth-1017.test.js
   proves that against the real sidecar). COMMS drew the red ✗ chip and the run's history said "↳ fs_write · 54ms · failed",
   the same as a real error. Executed here: the real foldChipResult + telemetryRun from chat.js on a minimal DOM. */
{
  const vm = require('vm');
  const chat = read('frontend/app/chat.js');
  const grab = (re, what) => { const m = re.exec(chat); A.ok(!!m, 'chat.js has ' + what); return m ? m[0] : ''; };
  const src = [
    grab(/const deniedResult = ev => [^\n]*\n/, 'the denied-result predicate'),
    grab(/function foldChipResult\(chip, ev\) \{[\s\S]*?\n  \}/, 'foldChipResult'),
    grab(/function runCallCount\(entry\) \{[\s\S]*?\n  \}/, 'runCallCount'),
    grab(/const runWho = id => [^\n]*\n/, 'the run head\'s agent name'),   // telemetryRun's head names its agent (10-18)
    grab(/function telemetryRun\(entry, role, skipTools\) \{[\s\S]*?\n  \}/, 'telemetryRun')
  ].join('\n');
  const el = () => {
    const cls = new Set(), kids = [];
    return { className: '', textContent: '', title: '', kids, cls, querySelector: () => null,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
      appendChild: k => { kids.push(k); return k; } };
  };
  const chip = () => { const c = el(), parts = { '.tc-glyph': el(), '.tc-stat': el(), '.tc-detail': el() }; c.querySelector = s => parts[s] || null; c.parts = parts; return c; };
  const ctx = { document: { createElement: el }, TaskIntent, fmtMs: ms => ms + 'ms', cap: s => String(s) };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.fold = foldChipResult; this.tele = telemetryRun;', ctx);
  const fold = ev => { const c = chip(); ctx.fold(c, ev); return { cls: Array.from(c.cls), glyph: c.parts['.tc-glyph'].textContent, stat: c.parts['.tc-stat'].textContent, res: c.parts['.tc-detail'].kids[0] }; };

  const denied = fold({ isError: true, summary: 'denied', ms: 54 });
  A.eq(denied.cls.join(','), 'denied', 'a denied call draws the neutral .denied chip, never .err');
  A.eq([denied.glyph, denied.stat], ['▸', 'denied'], 'its glyph is the not-run ▸ and its stat says "denied" (no red ✗, no duration of a failure)');
  A.eq([denied.res.className, denied.res.textContent], ['tc-d-res denied', 'denied · not run'], 'its detail says it did not run, without the ✗');
  const failed = fold({ isError: true, summary: 'error', ms: 54 });
  A.eq([failed.cls.join(','), failed.glyph, failed.stat, failed.res.className], ['err', '✗', '54ms', 'tc-d-res err'], 'a real failure still draws the red ✗');
  const ok = fold({ isError: false, summary: 'wrote 1 file', ms: 9 });
  A.eq([ok.cls.join(','), ok.glyph], ['ok', '✓'], 'a success is unchanged');
  const held = fold({ isError: true, summary: TaskIntent.GATE_HELD });
  A.eq([held.cls.join(','), held.stat], ['held', 'not run yet'], 'a held call is unchanged');
  A.eq(fold({ isError: false, summary: 'denied' }).cls.join(','), 'ok', 'only an errored result can read as denied');

  const wrap = ctx.tele({ agentId: 'agent', toolTrace: [
    { name: 'fs_write', ms: 54, ok: false, isError: true, summary: 'denied' },
    { name: 'fs_read', ms: 3, ok: false, isError: true, summary: 'error' }] }, 'LEAD', false);
  const lines = wrap.kids.slice(1);
  A.eq(lines.map(l => l.textContent), ['↳ fs_write · 54ms · denied', '↳ fs_read · 3ms · failed'], 'the run\'s history says "denied" for the Deny and "failed" only for the real error');
  A.eq(lines.map(l => l.className), ['rt-tool denied', 'rt-tool err'], 'and only the real error is drawn red');

  A.ok(/c\.reason === 'denied'\) return errResult\('consent denied for ' \+ call\.name \+ ': the Commander said no on the approval card[^\n]*'denied'\);/.test(read('sidecar/tools/registry.js')), 'the summary it keys on is the consent broker\'s own answer to a Deny on the card');
  A.ok(/\.tool-chip\.denied \.tc-glyph,\s*\n\.tool-chip\.denied \.tc-stat \{ color: var\(--ph-dim\); \}/.test(read('frontend/css/comms.css')) && /\.tool-chip \.tc-d-res\.denied \{ color: var\(--ph-dim\); \}/.test(read('frontend/css/comms.css')), 'the denied chip is plain dim phosphor (no red)');
}

/* ---------- A2. the LIVE reply (chat.js streamingAgent, executed) never shows a choice marker, and keeps every prose line ---------- */
{
  const vm = require('vm');
  const chat = read('frontend/app/chat.js');
  const part = (start, end) => { const i = chat.indexOf(start), j = chat.indexOf(end, i + start.length); A.ok(i >= 0 && j > i, 'chat.js has ' + start.trim()); return chat.slice(i, j); };
  const renders = [];
  const row = () => ({ d: { classList: { add() {} }, appendChild() {}, remove() {} }, body: { textContent: 'x', addEventListener() {} } });
  const c = vm.createContext({ Fork, activeWs: { id: 's', agentId: 'agent' }, row, renderProse: (el, text) => { renders.push(text); el.textContent = text; },
    turnFileRefs: () => null, endToolRail() {}, autoscroll() {}, document: { hidden: true, createElement: () => ({ remove() {} }) } });
  vm.runInContext(part('  function streamingAgent(', '  // close the live paragraph (if any)'), c);
  const live = c.streamingAgent();
  live.append('One thing first. Is it:\n\n**FORK: which angle?** || local-first | pixel art');
  A.eq(renders.at(-1), 'One thing first. Is it:', 'a bold FORK never renders in the live reply');
  live.append('\n\nTASK_QUESTION: who is it fo');
  A.ok(!/TASK_QUESTION/.test(renders.at(-1)), 'a marker still being typed is held back: ' + JSON.stringify(renders.at(-1)));
  const prose = c.streamingAgent();
  prose.append('The FORK: in the road');
  A.eq(renders.at(-1), 'The', 'the last line waits while it could still become a marker');
  prose.done();
  A.eq(renders.at(-1), 'The FORK: in the road', 'and shows in full the moment the paragraph closes');
}

/* ---------- B. *italic* renders as italics in COMMS and group replies (one renderer: Chat.renderProse) ---------- */
{
  const src = read('frontend/app/chat.js');
  const extract = name => { const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(src); A.ok(m, 'chat.js defines ' + name + '()'); return m[1]; };
  const esc = /const HTML_ESC = \{[^}]*\};/.exec(src);
  // eslint-disable-next-line no-new-func
  const reportInline = new Function(esc[0] + '\n' + extract('escapeHtml') + '\n' + extract('linkify') + '\n' + extract('hostOf') + '\n'
    + extract('linkHostNote') + '\n' + extract('reportInline') + '\nreturn reportInline;')();
  A.eq(reportInline('- Lean on *speed* first'), '- Lean on <span class="md-i">speed</span> first', 'a single-asterisk word is italic, not raw');
  A.eq(reportInline('what a developer actually *does* with it'), 'what a developer actually <span class="md-i">does</span> with it', 'the walk\'s "*does*" renders italic');
  A.eq(reportInline('*Run* it twice'), '<span class="md-i">Run</span> it twice', 'italic at the start of a line');
  A.eq(reportInline('a *two word* phrase'), 'a <span class="md-i">two word</span> phrase', 'an italic phrase');
  A.ok(reportInline('**bold** and *soft*').includes('<span class="md-b">bold</span> and <span class="md-i">soft</span>'), 'bold and italic side by side');
  A.eq(reportInline('2*3*4 = 24'), '2*3*4 = 24', 'arithmetic keeps its asterisks (no word may open an italic)');
  A.eq(reportInline('5 * 3 * 2'), '5 * 3 * 2', 'spaced asterisks are not italics');
  A.eq(reportInline('glob *.js and *.md'), 'glob *.js and *.md', 'a glob is not italic (its close is followed by a word or nothing closes it)');
  A.eq(reportInline('*<b>x</b>*'), '<span class="md-i">&lt;b&gt;x&lt;/b&gt;</span>', 'italic text stays HTML-escaped');
  A.ok(/\\\*\[\^\\s\*\]\[\^\*\\n\]\*\\\*/.test(/const MD_MARKERS = (\/.*\/m);/.exec(src)[1]), 'the fast path sees *italic* (a reply with only italics still takes the markdown pass)');
  A.ok(/\.cmsg \.body \.md-i \{ font-style: italic; \}/.test(read('frontend/css/comms.css')), 'the italic span slants');
  A.ok(/Chat\.renderProse\(body, content/.test(read('frontend/app/group-chat.js')), 'group replies render through the same Chat.renderProse');
}

/* ---------- C. the goal-arc Dialogue never takes over COMMS while a delivery lands; its edit key has one ✎ ---------- */
{
  const src = read('frontend/app/chat.js');
  const dl = /function deliveryLanding\(runId\) \{[\s\S]*?\n  \}/.exec(src);
  A.ok(dl, 'chat.js defines deliveryLanding()');
  // execute it against stub run records
  const RUN = new Map(), WORK = new Map();
  // eslint-disable-next-line no-new-func
  const deliveryLanding = new Function('runMeta', 'runWork', dl[0] + '\nreturn deliveryLanding;')(id => RUN.get(id) || null, WORK);
  RUN.set('chat', { isTask: false }); WORK.set('chat', { toolsOk: 0, delivered: 0 });
  RUN.set('file', { isTask: true }); WORK.set('file', { toolsOk: 2, delivered: 1 });
  RUN.set('crew', { isTask: true, delegated: true }); WORK.set('crew', { toolsOk: 1, delivered: 0 });
  A.eq(deliveryLanding('chat'), false, 'a reply with nothing new to look at is a free moment for the arc');
  A.eq(deliveryLanding('file'), true, 'a run that delivered a file is a delivery landing');
  A.eq(deliveryLanding('crew'), true, 'a run whose crew handed results back is a delivery landing');
  A.eq(deliveryLanding('handback'), true, 'a run this page did not start (a background worker\'s hand-back) is a delivery landing');
  const ac = /function arcCandidate\(runId\) \{[\s\S]*?\n  \}/.exec(src);
  A.ok(ac && /if \(deliveryLanding\(runId\)\) return null;\s*\n[\s\S]*return \{ kind: 'arc', dim: 'goals', why:/.test(ac[0]), 'the arc Dialogue stands down on a delivery landing');
  A.ok(ac && ac[0].indexOf('deliveryLanding') > ac[0].indexOf('if (arcSeen(runId)) return null;'), 'standing down never spends the run\'s arc token (it is offered again at the next run end)');
  A.ok(/if \(!ev\.isError && \/\^\(\?:team\[\._\]dispatch\|group\[\._\]handoff\)\$\/\.test\(nm\)\) \{ const rm = runMeta\(thisRunId\); if \(rm\) rm\.delegated = true; \}/.test(src), 'a run that handed work to crew is marked delegated');
  A.ok(/customLabel: 'edit the milestones'/.test(src) && !/customLabel: '✎/.test(src), 'the arc edit key carries no ✎ of its own (Dialogue draws one: it read "✎✎")');
  A.ok(/num\.textContent = '✎';/.test(read('frontend/app/dialogue.js')), 'Dialogue draws the ✎ for every custom key');
  // …so NO caller may bring its own: the first-command plan in onboarding read "✎✎ edit the steps" too (rc review 2026-10-14)
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'frontend', 'app')).filter(n => /\.js$/.test(n))) {
    const own = /customLabel:\s*['"`]\s*✎/.exec(read('frontend/app/' + f));
    A.ok(!own, 'frontend/app/' + f + ' passes no ✎ in a customLabel (Dialogue draws it): ' + (own ? own[0] : ''));
  }
}

/* ---------- D. the group transcript keeps the spaces between streamed turns and shows the lead's tool chips ---------- */
(async () => {
  const os = require('os');
  const { makeGroupSessions } = require('../sidecar/group-sessions.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-flow-'));
  let seq = 0, gate = null, snapshot = null;
  const api = makeGroupSessions({ fs, path, root, now: () => ++seq, id: () => 'id' + (++seq), log: () => {},
    roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'copy', name: 'Copy' }],
    readFile: async () => null, decodeFile: () => null, uploadFile: (n, c) => ({ name: n, content: c, hash: 'h' }),
    execute: async o => {
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.token', { runId: o.runId, delta: 'Let me configure it:' });
      o.emit('agent.tool_call', { runId: o.runId, callId: 'c1', name: 'loop.create', argsSummary: '{"title":"draft then review"}' });
      o.emit('agent.tool_result', { runId: o.runId, callId: 'c1', ok: false, isError: true, summary: TaskIntent.GATE_HELD, ms: 0 });
      o.emit('agent.token', { runId: o.runId, delta: 'The steps are locked.' });
      o.emit('agent.tool_call', { runId: o.runId, callId: 'c2', name: 'loop.create', argsSummary: '{"title":"draft then review"}' });
      await new Promise(r => { gate = r; });   // hold mid-run so the DRAFT can be read
      o.emit('agent.tool_result', { runId: o.runId, callId: 'c2', ok: true, isError: false, summary: 'created', ms: 120 });
      o.emit('agent.token', { runId: o.runId, delta: 'Done — the line is set.' });
      return { reason: 'done', messages: [{ role: 'assistant', content: 'Done — the line is set.' }] };
    } });
  try {
    await api.ready;
    const g = await api.create({ members: ['agent', 'copy'] });
    await api.send(g.id, { key: 'k1', text: 'set up a conveyor line' });
    for (let n = 0; n < 200 && !gate; n++) await new Promise(r => setTimeout(r, 5));
    snapshot = await api.get(g.id);
    const dt = snapshot.turns.find(t => t.draft);
    A.ok(dt, 'a running reply exposes its draft');
    A.eq(dt.draft, 'Let me configure it:\n\nThe steps are locked.', 'the draft breaks the paragraph where a tool call cut it (no "it:The")');
    A.eq(dt.draftSteps.map(s => [s.at, s.name, s.done]), [[20, 'loop.create', true], [43, 'loop.create', false]], 'the draft carries each call at its place in the prose');
    gate();
    await api.idle(g.id);
    const done = await api.get(g.id);
    const m = done.messages.find(x => x.author === 'agent');
    A.eq(m.content, 'Done — the line is set.', 'the message content stays the final answer (what peers read and copy)');
    A.ok(m.flow && m.flow.text === 'Let me configure it:\n\nThe steps are locked.\n\nDone — the line is set.', 'the saved flow keeps every streamed sentence, spaced: ' + JSON.stringify(m.flow && m.flow.text));
    A.eq(m.flow.steps.map(s => [s.at, s.done, s.isError, s.summary]), [[20, true, true, TaskIntent.GATE_HELD], [43, true, false, 'created']], 'and every call with its outcome (the held one stays recognisable as held)');
  } finally { try { await api.close && api.close(); } catch (_) {} }

  const gc = read('frontend/app/group-chat.js');
  A.ok(/function renderFlow\(body, text, steps, files, clean, live\)/.test(gc), 'the group transcript draws a reply flow');
  A.ok(/body\.append\(Chat\.toolRailOf\(batch\)\)/.test(gc), 'with the one-on-one chips (Chat.toolRailOf)');
  A.ok(/m\.flow && Array\.isArray\(m\.flow\.steps\) && m\.flow\.steps\.length[\s\S]{0,120}renderFlow\(body, m\.flow\.text, m\.flow\.steps/.test(gc), 'a finished reply with calls renders its flow');
  A.ok(/renderFlow\(n\._gcBody, t\.draft \|\| '', t\.draftSteps \|\| \[\]/.test(gc) && !/n\._gcBody\.textContent = t\.draft/.test(gc), 'a streaming draft renders its flow (markdown + chips), never raw textContent');
  A.ok(/Fork\.liveText\(s\)/.test(gc), 'a draft never shows a choice marker being typed');
  const chat = read('frontend/app/chat.js');
  A.ok(/function toolRailOf\(steps\)[\s\S]{0,700}chipNode\([\s\S]{0,300}foldChipResult\(chip/.test(chat), 'toolRailOf builds the same chip DOM and folds the same result (held stays neutral)');
  A.ok(/head\.addEventListener\('click', \(\) => toggleChip\(head\)\)/.test(chat), 'a group chip toggles its own detail (#gc-log has no delegated handler)');
  A.ok(/renderProse, toolRailOf, openFile/.test(chat), 'Chat exports toolRailOf');
  A.ok(/function toolRailOf\(steps\)[\s\S]{0,400}if \(s && s\.callId\) chip\.dataset\.callId = String\(s\.callId\);/.test(chat), 'a group chip carries its call id');
  /* D2. A CHIP THE COMMANDER OPENED STAYS OPEN WHILE THE REPLY STREAMS (rc review 2026-10-14): the draft rebuilds its flow on
     every token or poll, which collapsed an expanded chip mid-read. renderFlow is executed on a minimal DOM. */
  {
    const vm = require('vm');
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this.textContent = ''; }
      get classList() { const el = this; return { add: c => { if (!el.has(c)) el.className = (el.className + ' ' + c).trim(); }, contains: c => el.has(c), toggle: c => { if (el.has(c)) { el.className = el.className.split(/\s+/).filter(x => x !== c).join(' '); return false; } el.className = (el.className + ' ' + c).trim(); return true; } }; }
      has(c) { return this.className.split(/\s+/).includes(c); }
      append(...n) { this.children.push(...n); } appendChild(n) { this.children.push(n); return n; }
      replaceChildren() { this.children = []; }
      setAttribute(k, v) { this.attrs[k] = String(v); } addEventListener() {}
      all() { return this.children.flatMap(c => [c].concat(c.all ? c.all() : [])); }
      querySelectorAll(sel) { const want = sel.split('.').filter(Boolean); return this.all().filter(n => want.every(c => n.has && n.has(c))); }
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    }
    const railOf = steps => { const rail = new El('div'); rail.className = 'tool-rail'; for (const s of steps) { const chip = new El('div'); chip.className = 'tool-chip'; if (s.callId) chip.dataset.callId = s.callId; const head = new El('button'); head.className = 'tc-head'; chip.append(head); rail.append(chip); } return rail; };
    const ctx = vm.createContext({ document: { createElement: t => new El(t) }, Chat: { toolRailOf: railOf, renderProse: (el, s) => { el.textContent = s; } }, Fork });
    const gsrc = read('frontend/app/group-chat.js');
    const hs = gsrc.indexOf('  const h = (tag'), he = gsrc.indexOf('\n', gsrc.indexOf('return e;', hs) + 12);
    const fs0 = gsrc.indexOf('  function renderFlow('), fe = gsrc.indexOf('\n  }\n', fs0) + 4;
    vm.runInContext(gsrc.slice(hs, he + 1) + gsrc.slice(fs0, fe) + '\nthis.renderFlow = renderFlow;', ctx);
    const body = new El('div');
    const steps = [{ at: 5, callId: 'c1', name: 'fs.list', done: true }, { at: 12, callId: 'c2', name: 'fs.write', done: false }];
    ctx.renderFlow(body, 'Look:\n\nWrite:', steps, null, null, true);
    const chip = id => body.querySelectorAll('.tool-chip').find(c => c.dataset.callId === id);
    chip('c1').classList.toggle('open');
    ctx.renderFlow(body, 'Look:\n\nWrite: done', steps, null, null, true);
    A.ok(chip('c1') && chip('c1').has('open'), 'the chip the Commander opened is still open after the draft re-renders');
    A.eq(chip('c1').querySelector('.tc-head').attrs['aria-expanded'], 'true', 'and its disclosure says so');
    A.ok(!chip('c2').has('open'), 'a chip they did not open stays closed');
  }

  /* C2. A DELIVERY THAT LANDS AFTER THE ARC WAS OFFERED (rc review 2026-10-14): the check at offer time could not see a worker's
     hand-back landing during the seconds-long decomposition call, or while the panel was open. offerArc is executed here. */
  {
    const vm = require('vm');
    const i = chat.indexOf('  function arcBlocked() {'), j = chat.indexOf('  function planGoalPath()', i);
    A.ok(i > 0 && j > i, 'chat.js has arcBlocked … offerArc');
    const mk = () => {
      const log = { open: 0, close: 0, decline: 0, recDecline: 0, finished: 0, firing: [] };
      let isOpen = false, releaseAux = null, sayDone = null;
      const ctx = vm.createContext({
        console, Promise,
        GoalStore: { willOfferDecomposition: () => true, isFiring: () => false, setFiring: v => log.firing.push(v),
          proposeDecomposition: () => new Promise(r => { releaseAux = () => r({ belief: { text: 'ship it' }, texts: ['a', 'b', 'c'] }); }),
          confirm: () => ({}), declineDecomposition: () => { log.decline++; } },
        Dialogue: { open: () => { log.open++; isOpen = true; }, say: () => new Promise(r => { sayDone = r; }), node: () => new Promise(() => {}),
          isOpen: () => isOpen, close: () => { log.close++; isOpen = false; } },
        slotCanArc: () => 'free', studyBlocked: () => false, taskQuestionLive: () => false, log: null, clearNudge() {}, turninQueue: [], activeTurnin: null, showNextTurnin() {},
        beatCards: { generation: () => 1, claim: () => ({ decide() {}, finish() { log.finished++; } }) },
        name: 'NOVA', recAccept() {}, recDecline: () => { log.recDecline++; }
      });
      vm.runInContext(chat.slice(i, j) + '\nthis.offerArc = offerArc; this.noteDeliveryLanding = noteDeliveryLanding;', ctx);
      return { ctx, log, aux: () => releaseAux && releaseAux(), say: () => sayDone && sayDone() };
    };
    const tick = () => new Promise(r => setImmediate(r));
    // (1) a delivery lands DURING the decomposition call: the panel never opens
    {
      const t = mk();
      const p = t.ctx.offerArc('run-1');
      await tick();
      t.ctx.noteDeliveryLanding();
      t.aux();
      await p;
      A.eq(t.log.open, 0, 'a delivery that lands during the decomposition call keeps the arc panel shut');
      A.eq(t.log.decline, 0, 'and records no decline (it is offered again at a later run end)');
      A.eq(t.log.firing.at(-1), false, 'and the arc lane is released');
    }
    // (2) a delivery lands WHILE the panel is open: it steps aside, unanswered, never a decline
    {
      const t = mk();
      const p = t.ctx.offerArc('run-2');
      await tick(); t.aux(); await tick(); t.say(); await tick(); await tick();
      A.eq(t.log.open, 1, 'with nothing landing the arc panel opens');
      t.ctx.noteDeliveryLanding();
      await p;
      A.ok(t.log.close >= 1, 'a delivery landing while the panel is open closes it, so the delivery shows');
      A.eq(t.log.decline + t.log.recDecline, 0, 'stepping aside is not the Commander declining (no decline, no learning signal)');
      A.eq(t.log.finished, 1, 'the beat slot is released');
      A.eq(t.log.firing.at(-1), false, 'and the arc lane is released');
    }
    // (3) the Commander asked for it (PLAN A PATH): a landing does not yank a panel they opened themselves
    {
      const t = mk();
      const p = t.ctx.offerArc('manual:1');
      await tick(); t.ctx.noteDeliveryLanding(); t.aux(); await tick(); t.say(); await tick(); await tick();
      A.eq(t.log.open, 1, 'a panel the Commander asked for still opens');
      t.ctx.noteDeliveryLanding(); await tick();
      A.eq(t.log.close, 0, 'and stays open until they answer it');
      void p;
    }
    A.ok(/function deliverTurns\(ws, turns\) \{[\s\S]*?noteDeliveryLanding\(\);[\s\S]*?return true;\n  \}/.test(chat), 'a delivered answer landing in the open conversation (deliverTurns) is a delivery landing');
    A.ok(/function deliverableLine\(title, agentId\) \{[\s\S]{0,120}noteDeliveryLanding\(\);/.test(chat) && /function imageDeliverableLine\(title, agentId\) \{[\s\S]{0,160}noteDeliveryLanding\(\);/.test(chat), 'so is a saved file or image line');
  }

  A.report('comms-render-seams.test');
})().catch(e => { console.error(e); process.exit(1); });
