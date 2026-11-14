/* node test/slim-note.test.js — THE SLIM PER-RUN NOTE, the pure halves (cost lane, 2026-11-14). Part of test:fast.

   The host's <run_context> note is new on every message, so no provider reads it from cache. STARNET_SLIM_NOTE=1
   (sidecar/slim-note.js; off by default) takes out of it what buys nothing by riding there. test/slim-note.e2e.test.js
   holds the bytes on the wire, off and on; this holds the rules.

   A. THE SWITCH. '1' is on; '0', anything else and unset are off. Production code names it once, as ENV('SLIM_NOTE') in
      index.js slimNoteOn; the module never reads the environment; every use of the module in index.js sits behind
      slimNoteOn().
   B. ONE ASK, ONCE. The context pack's pool names a finished task twice: its brief's request and the chat line that
      asked for it, both standing on the same transcript row. activityLines() keeps one line per row, the brief's (the
      whole request, where the chat line is its first line only); a line with no row, a row with one line and a pack
      without its sources pass as they came; no ask the unset note shows is ever missing; the evidence block keeps its
      own bounds.
   C. THE FIRST-SKILL LINE. The paragraph an agent with no saved skills gets moves whole into the stable text; an index
      of saved skills stays in the note with its heading.
   D. THE QUEST BLOCK. Its how-to header and minting doctrine become the guide, word for word but for one added sentence
      (where the list is) and one re-pointed phrase ("open quest above" -> "open quest in that block"); the guide is the
      same text with and without open quests; the note keeps the same stanzas, or the block's own "no open quests" line.
   D2. THE [RUNTIME] BLOCK. Its closing instruction moves word for word, but for the phrase that points at the block
      ("answer from this block" -> "answer from the [RUNTIME] block of this run's context note"); every identity line
      stays in the note.
   E. THE HOST'S WIRING. runOnceCore plans only for a run that has a note, never a granted run, only with the switch on;
      the moved text closes the system prompt's per-conversation tail and never enters cacheSystemPrefix.

   RED on the base (57c741da7): sidecar/slim-note.js does not exist and nothing reads the switch. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const SlimNote = require('../sidecar/slim-note.js');
const ContextPack = require('../sidecar/contextpack.js');
const CommanderContext = require('../sidecar/commander-context.js');
const RuntimeSkills = require('../sidecar/skills/runtime.js');
const QuestInject = require('../sidecar/questinject.js');
const FinishLine = require('../sidecar/finish-line.js');
const RuntimeInfo = require('../sidecar/runtimeinfo.js');
const Provider = require('../sidecar/providers/provider.js');
const { readSidecarIndex, sidecarSourceFiles } = require('./helpers/source.js');

const IDX = readSidecarIndex();   // the switch is read in index.js itself: this pins that file's own text
const NOW = 1794614400000;        // a fixed clock for the pure pack (2026-11-14)
const DAY = 86400000;

/* ---------- A. the switch ---------- */
for (const v of ['1', ' 1 ', 'true', 'YES', 'on']) A.ok(SlimNote.on(v) === true, 'A: ' + JSON.stringify(v) + ' is on');
for (const v of ['0', '', ' ', 'off', 'false', 'no', '2', 'lean', undefined, null]) A.ok(SlimNote.on(v) === false, 'A: ' + JSON.stringify(v) + ' is off');
A.ok(IDX.indexOf("function slimNoteOn() { return SlimNote.on(ENV('SLIM_NOTE')); }") > 0, 'A: index.js reads the switch through ENV() in slimNoteOn');
{
  const named = [];
  for (const f of sidecarSourceFiles()) { const n = f.text.split("ENV('SLIM_NOTE')").length - 1; if (n) named.push(f.rel + ' x' + n); }
  A.eq(named, ['sidecar/index.js x1'], 'A: the switch is read at one place');
  const env = sidecarSourceFiles().filter(f => /process\.env\.(?:STARNET|SKYNET)_SLIM_NOTE|\[['"](?:STARNET|SKYNET)_SLIM_NOTE['"]\]/.test(f.text)).map(f => f.rel);
  A.eq(env, [], 'A: no sidecar file reads the switch from the environment itself');
  const mod = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'slim-note.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  A.ok(!/process\.env|Date\.now|new Date|Math\.random|require\('(?:node:)?fs'\)/.test(mod), 'A: the module is pure (no env, clock, random or fs)');
  // every line of index.js that calls the module either reads the switch or sits behind it
  const uses = IDX.split('\n').filter(l => /\bSlimNote\.(?!on\()[A-Za-z]+\(/.test(l));
  const guarded = l => /slimNoteOn\(\) \? SlimNote\./.test(l) || IDX.indexOf('slimNoteOn()) {\n' + l + '\n') > 0;   // on its own line, or the first line of an if that reads the switch
  A.ok(uses.length >= 1 && uses.every(guarded), 'A: index.js reaches the module only behind slimNoteOn(): ' + JSON.stringify(uses.filter(l => !guarded(l)).map(l => l.trim().slice(0, 90))));
}

/* ---------- B. one ask, once ---------- */
const row = (rowId, content, ago, extra) => Object.assign({ role: 'user', content, ts: NOW - ago, streamId: 'ws_a', sourceRunId: 'run-' + rowId, rowId, kind: 'directive' }, extra || {});
const brief = (r, ago) => ({ originalDirective: r.content.trim().slice(0, 4000), ts: NOW - ago, streamId: r.streamId, sourceRunId: r.sourceRunId, rowId: r.rowId });
const pack = (briefs, chats, extra) => ContextPack.assemble(Object.assign({ runs: [], briefs, chats }, extra || {}), { now: NOW });
const r1 = row(1, 'Research three note-taking apps and save a comparison table to notes/compare.md.', 5000);
const r2 = row(2, 'Now add a column for mobile support.\nKeep the table under ten rows and sort it by price.', 4000);
const r3 = row(3, 'Which one would you pick for a team of five?', 3000);
const r4 = row(4, 'Draft a short email to the team.', 2000);   // asked, its task not finished: a chat line only
{
  const p = pack([brief(r1, 4900), brief(r2, 3900), brief(r3, 2900)], [r1, r2, r3, r4]);
  A.eq(p.activityLines.length, 7, 'B: the pool names three finished tasks twice and the open one once');
  A.ok(p.activityLines.indexOf('Which one would you pick for a team of five? (today)') >= 0 && p.activityLines.indexOf('"Which one would you pick for a team of five?" (today)') >= 0,
    'B: the two forms of one ask are the brief\'s request and the quoted chat line');
  const both = p.activity.filter(e => e.src && e.src.rowId === 3);
  A.eq(both.map(e => [e.src.streamId, e.src.rowId]), [['ws_a', 3], ['ws_a', 3]], 'B: both forms stand on the same transcript row (the proof they are one ask)');
  const slim = SlimNote.activityLines(p);
  A.eq(slim, [
    'Which one would you pick for a team of five? (today)',
    'Now add a column for mobile support. Keep the table under ten rows and sort it by price. (today)',
    'Research three note-taking apps and save a comparison table to notes/compare.md. (today)',
    '"Draft a short email to the team." (today)'
  ], 'B: ONE LINE PER ASK: the finished tasks as their briefs, the open ask as its chat line, in the pool\'s order');
  A.ok(slim[1].indexOf('sort it by price') > 0 && p.activityLines.indexOf('"Now add a column for mobile support." (today)') >= 0,
    'B: the kept form is the more informative one: the brief carries what followed the first line, the chat line never did');
  A.eq(SlimNote.activityLines(p), SlimNote.activityLines(p), 'B: deterministic');
  A.eq(p.activityLines.length, 7, 'B: the pack itself is not changed (the grounding pool and the interest pass still read both forms)');
  // through the composer the note uses: the same bounds, fewer lines
  const lines = act => CommanderContext.compose({ activity: act.slice(0, 8) }).split('\n').filter(l => l.indexOf('- RECENT ACTIVITY: ') === 0);
  A.eq([lines(p.activityLines).length, lines(slim).length], [6, 4], 'B: unset shows 6 lines for 4 asks (two of them twice); on shows 4 lines for 4 asks');
  A.ok(lines(slim).every(l => l.length <= '- RECENT ACTIVITY: '.length + 180), 'B: each line keeps the block\'s 180-character bound');
  // the repeats hold slots: two older asks that never became a finished task are cut by them when unset, and shown when on
  const o1 = row(11, 'What does the team use for notes today?', 9000), o2 = row(12, 'Is anyone on the team phone-only?', 8000);
  const q = pack([brief(r1, 4900), brief(r2, 3900), brief(r3, 2900)], [o1, o2, r1, r2, r3]);
  const asked = (act, r) => lines(act).some(l => l.indexOf(r.content.split('\n')[0]) > 0);
  A.ok(!asked(q.activityLines, o1) && !asked(q.activityLines, o2), 'B: unset, three finished tasks named twice fill the block: the two older asks are cut');
  A.ok(asked(SlimNote.activityLines(q), o1) && asked(SlimNote.activityLines(q), o2) && [r1, r2, r3].every(r => asked(SlimNote.activityLines(q), r)), 'B: on, all five asks are shown');
}
{
  // a finished task asked the day before: the brief line carries the day it was finished
  const old = row(9, 'Compare two wiki engines.', DAY + 3600000);
  const p = pack([brief(old, 1800000)], [old]);
  A.eq(p.activityLines, ['Compare two wiki engines. (today)', '"Compare two wiki engines." (yesterday)'], 'B: a task asked yesterday and finished today is in the pool with both days');
  A.eq(SlimNote.activityLines(p), ['Compare two wiki engines. (today)'], 'B: the kept line is the brief\'s (the day the task was finished)');
}
{
  // what passes as it came
  const p = pack([brief(r1, 4900)], [r1, r4]);
  A.eq(SlimNote.activityLines({ activityLines: p.activityLines }), p.activityLines, 'B: a pack without its sources passes as it came');
  A.eq(SlimNote.activityLines({ activityLines: p.activityLines, activity: p.activity.slice(1) }), p.activityLines, 'B: a pool that is not the same list passes as it came');
  A.eq(SlimNote.activityLines({ activityLines: ['a', 'a'], activity: [{ line: 'a', src: null }, { line: 'a', src: null }] }), ['a', 'a'], 'B: lines with no row behind them are never merged, even when equal');
  A.eq(SlimNote.activityLines({ activityLines: ['a', 'b'], activity: [{ line: 'a', src: { streamId: 'ws_a', rowId: 5 } }, { line: 'b', src: { streamId: 'ws_b', rowId: 5 } }] }), ['a', 'b'], 'B: the same row number on another stream is another ask');
  A.eq(SlimNote.activityLines(null), [], 'B: no pack');
  A.eq(SlimNote.activityLines({}), [], 'B: an empty pack');
}
{
  // no ask the unset block shows is missing when on, over every mix of finished and open asks the bounds allow
  let checked = 0;
  for (let done = 0; done <= 8; done++) for (let open = 0; open <= 8; open++) {
    const rows = [];
    for (let k = 0; k < done + open; k++) rows.push(row(100 + k, 'Ask number ' + (k + 1) + ' of the day.', (done + open - k) * 60000));
    const p = pack(rows.slice(0, done).map(r => brief(r, NOW - r.ts - 1000)), rows);
    const shown = act => CommanderContext.compose({ activity: act.slice(0, 8) }).split('\n').filter(l => l.indexOf('- RECENT ACTIVITY: ') === 0).map(l => /Ask number \d+/.exec(l)[0]);
    const off = shown(p.activityLines), on = shown(SlimNote.activityLines(p));
    A.ok(off.every(a => on.indexOf(a) >= 0) && new Set(on).size === on.length && on.length <= 6, 'B: ' + done + ' finished + ' + open + ' open: every ask shown unset is shown on, once, within 6 lines');
    checked++;
  }
  A.eq(checked, 81, 'B: every mix was checked');
}
// the host calls it at the one place the evidence reads the pack, before the same bound
A.ok(IDX.indexOf('try { const pack = nightshiftContextPack(evidence); activity = (slimNoteOn() ? SlimNote.activityLines(pack) : (pack.activityLines || [])).slice(0, 8); } catch (_) {}') > 0,
  'B: commanderEvidenceInputs asks the rule only with the switch on, and keeps the pack\'s lines and the 8-line bound when off');
A.eq(IDX.split('nightshiftContextPack(evidence).activityLines').length - 1, 0, 'B: and reads the pack\'s lines nowhere else');
{
  // the host's own reader, compiled out of index.js and run on a real pack, switch off and on
  const fn = A.fnBody(IDX, 'function commanderEvidenceInputs(evidence)');
  A.ok(fn.length > 200 && fn.length < 4000 && /return \{ dossier:/.test(fn), 'B: commanderEvidenceInputs is sliced whole');
  const p = pack([brief(r1, 4900), brief(r2, 3900), brief(r3, 2900)], [r1, r2, r3, r4]);
  const read = slim => vm.runInNewContext('(' + fn + ')()', {
    Date: { now: () => NOW }, personalizationStore: { read: () => ({ enabled: false }) }, nightshiftContextPack: () => p, threadsStore: { openThreads: () => [] },
    Interests: { summary: () => [] }, interestsState: {}, scoutState: { context: {} }, commanderGoals: { get: () => null }, recommendationLedger: { summary: () => null },
    stationTrackRecordLines: () => [], commanderDossier: { get: () => '' }, slimNoteOn: () => slim, SlimNote
  }).activity;
  A.eq(read(false), p.activityLines.slice(0, 8), 'B: the host\'s reader, switch off: the pack\'s lines, the first 8, as on the base');
  A.eq(read(true), SlimNote.activityLines(p), 'B: the host\'s reader, switch on: one line per ask');
  A.eq(read(true).length, 4, 'B: four asks, four lines');
}

/* ---------- C. the first-skill line ---------- */
const skillIndex = (skills, opts) => RuntimeSkills.composeIndex(skills, Object.assign({ emptyGuide: true, canManage: true, budget: 6000 }, opts || {})).text;
const GUIDE = skillIndex([]);
const SKILL = { id: 'tidy', name: 'tidy', summary: 'How to tidy a folder', state: 'active', agentId: 'agent' };
{
  A.ok(GUIDE.indexOf('\n\n## SAVED AGENT SKILLS\nYou have no saved skills yet. ') === 0 && RuntimeSkills.isEmptyGuide(GUIDE), 'C: an agent with no saved skills gets the first-skill line, and the module knows it');
  A.ok(RuntimeSkills.isEmptyGuide(skillIndex([Object.assign({}, SKILL, { state: 'archived' })])) && skillIndex([Object.assign({}, SKILL, { state: 'archived' })]).indexOf('(1 archived;') > 0, 'C: so is the line of an agent whose skills are all archived');
  A.ok(RuntimeSkills.isEmptyGuide(skillIndex([], { canManage: false })), 'C: and the skill.write wording');
  const index = skillIndex([SKILL]);
  A.ok(index.indexOf('\n\n## SAVED AGENT SKILLS (mandatory)\nBefore replying, scan this skill index.') === 0 && !RuntimeSkills.isEmptyGuide(index), 'C: an index of saved skills is not the first-skill line');
  for (const v of ['', null, undefined, 'x', 7]) A.ok(!RuntimeSkills.isEmptyGuide(v), 'C: ' + JSON.stringify(v) + ' is not the first-skill line');
  const p = SlimNote.plan({ skills: GUIDE, quests: '' });
  A.eq([p.skills, p.stable, p.quests], ['', GUIDE, ''], 'C: THE FIRST-SKILL LINE MOVES WHOLE: it leaves the note and is the stable text, byte for byte');
  const q = SlimNote.plan({ skills: index, quests: '' });
  A.eq([q.skills, q.stable], [index, ''], 'C: A SAVED-SKILL INDEX STAYS IN THE NOTE, heading and all (it is ranked by the message and says "scan this skill index")');
  A.eq(SlimNote.plan({}), { skills: '', quests: '', runtime: '', stable: '' }, 'C: no blocks, nothing moved');
  A.eq(SlimNote.plan(null), { skills: '', quests: '', runtime: '', stable: '' }, 'C: no input');
}

/* ---------- D. the quest block ---------- */
const QI = QuestInject._internals;
const quest = (n, extra) => Object.assign({ id: 'q:' + n, title: 'Quest number ' + n + ' for the Commander', contract: { type: 'attest', key: '' }, groundedIn: 'fact ' + n, domain: 'research' }, extra || {});
{
  const none = QuestInject.questBlock([]);
  const some = QuestInject.questBlock([quest(1), quest(2, { steps: [{ key: 's1', label: 'first step', done: false }] })]);
  const a = QuestInject.split(none), b = QuestInject.split(some);
  A.ok(a && b, 'D: both forms of the block split');
  A.eq(a.list, 'STATION QUESTS — you have no open quests for the Commander right now.', 'D: no open quests: the note keeps the block\'s own first line');
  A.ok(none.indexOf(a.list + '\n\n') === 0, 'D: which is the unset block\'s first line, byte for byte');
  A.eq(b.list, QI.LIST_HEAD + '\n\n' + QI.stanza(quest(1)) + '\n\n' + QI.stanza(quest(2, { steps: [{ key: 's1', label: 'first step', done: false }] })), 'D: open quests: the note keeps every stanza, byte for byte, under a one-line head');
  A.ok(some.slice(-(b.list.length - QI.LIST_HEAD.length)) === b.list.slice(QI.LIST_HEAD.length), 'D: the stanzas are the tail of the unset block');
  A.eq(a.guide, b.guide, 'D: THE GUIDE IS THE SAME TEXT WITH AND WITHOUT OPEN QUESTS (a quest minted mid-conversation never moves the system prompt)');
  // word for word: undo the two re-pointings and the guide is the block's own fixed text
  const undone = a.guide.replace(' ' + QI.LIST_POINTER, '').replace('NO matching open quest in that block', 'NO matching open quest above');
  A.eq(undone, QI.HEADER + '\n\n' + QI.MINT_DOCTRINE, 'D: THE GUIDE IS THE HOW-TO HEADER AND THE MINTING DOCTRINE, WORD FOR WORD, but for one added sentence and one re-pointed phrase');
  A.ok(some.indexOf(undone + '\n\n') === 0 && none.indexOf(QI.MINT_DOCTRINE) > 0, 'D: which is exactly what the unset block carries ahead of its quests');
  A.eq((a.guide.match(/NO matching open quest in that block/g) || []).length, 1, 'D: the doctrine points at the block the note carries');
  A.ok(a.guide.indexOf('open quest above') < 0, 'D: nothing in the system prompt points "above" at a list that is not there');
  A.ok(a.guide.indexOf('Your open quests are listed in the STATION QUESTS block of this run\'s context note, which also says when you have none.') > 0, 'D: the guide says where the list is, and that it says when there is none');
  A.ok(a.list.indexOf('STATION QUESTS') === 0 && b.list.indexOf('STATION QUESTS') === 0, 'D: the note\'s half opens with the name the guide and the quest.update tool call it by');
  for (const t of [a.guide, a.list, b.list]) A.eq(Provider.inertHostTags(t), t, 'D: no host fence tag in either half (the note fence leaves them as written)');
  // the cap: the same quests are shown
  const many = []; for (let n = 1; n <= 12; n++) many.push(quest(n));
  const capped = QuestInject.questBlock(many), c = QuestInject.split(capped);
  A.ok(capped.indexOf('…and ') > 0 && c.list.indexOf('…and ') > 0, 'D: a ledger over the cap: the "...and N more" line stays');
  A.eq(c.list.slice(QI.LIST_HEAD.length), capped.slice((QI.HEADER + '\n\n' + QI.MINT_DOCTRINE).length), 'D: and the same stanzas are shown as when unset (nothing is cut that was shown, nothing more is shown)');
  // what is not a block this module wrote
  for (const v of ['', null, 'STATION QUESTS', none + ' ', some.slice(5), QI.HEADER + '\n\n' + QI.MINT_DOCTRINE + '\n\n']) A.eq(QuestInject.split(v), null, 'D: ' + JSON.stringify(String(v).slice(0, 30)) + ' is not split');
  const odd = SlimNote.plan({ skills: '', quests: 'SOMETHING ELSE' });
  A.eq([odd.quests, odd.stable], ['SOMETHING ELSE', ''], 'D: a block the rule does not know stays whole in the note');
  // the note takes the list the way it took the block
  A.eq(QuestInject.withQuests('NOTE', b.list), 'NOTE\n\n' + b.list, 'D: withQuests places the list as it placed the block');
  // both together: one stable text, the first-skill line first (the order the note had them in)
  const p = SlimNote.plan({ skills: GUIDE, quests: none });
  A.eq(p, { skills: '', quests: a.list, runtime: '', stable: GUIDE + '\n\n' + a.guide }, 'D: the first-skill line and the quest guide make one stable text, in the note\'s order');
  A.eq(FinishLine.append('PREFIX' + p.stable, { isTask: true, internal: false, tools: [] }).indexOf('PREFIX' + p.stable + '\n\n' + FinishLine.MARKER), 0, 'D: it sits before FINISH THE JOB, which still closes the system prompt');
  const bytes = s => Buffer.byteLength(s);
  console.log('[slim-note] the note without the moved paragraphs: no saved skills and no open quests ' + (bytes(GUIDE) + 2 + bytes(none)) + ' -> ' + bytes(a.list) + ' bytes; an index and two quests '
    + bytes(some) + ' -> ' + bytes(b.list) + ' bytes (the quest block alone)');
  A.ok(bytes(GUIDE) + bytes(none) - bytes(a.list) > 1100 && bytes(some) - bytes(b.list) > 1100, 'D: more than 1,100 bytes leave the note either way');
}

/* ---------- D2. the [RUNTIME] block's closing instruction ---------- */
{
  const ident = { provider: 'anthropic', model: 'claude-test', agentId: 'agent', runId: 'run-1234', surface: 'interactive', trigger: 'directive', harness: 'v0.15.2-0-gtest', app: '0.15.2', now: NOW };
  const LINE = 'If the Commander asks what StarNet build, model, provider, run, surface, or session you are using, answer from this block. For mutable harness state such as scheduler health, routines, connectors, or errors, call station.inspect. Do not guess or invent a CLI command.';
  for (const [name, o] of [['a chat turn', ident], ['a task with a shell', Object.assign({}, ident, { shell: { backend: 'local', platform: 'win32' } })],
    ['fallback models', Object.assign({}, ident, { fallbackModels: ['a/b', 'c/d'] })], ['no clock', Object.assign({}, ident, { now: 0 })]]) {
    const block = RuntimeInfo.runtimeIdentityBlock(o);
    A.ok(block.indexOf('\n\n[RUNTIME]\n') === 0 && block.slice(-LINE.length) === LINE, 'D2 ' + name + ': the block closes with its standing instruction');
    const s = RuntimeInfo.splitGuide(block);
    A.ok(s, 'D2 ' + name + ': it splits');
    A.eq(s.block + '\n' + LINE, block, 'D2 ' + name + ': THE NOTE KEEPS EVERY IDENTITY LINE, byte for byte (the block without its last line)');
    A.ok(s.block.indexOf('Run id: run-1234') > 0 && s.block.indexOf('Requested model at run start: claude-test') > 0 && s.block.indexOf('If the Commander asks') < 0, 'D2 ' + name + ': the run id and model stay; the instruction left');
    A.eq(s.guide.replace('answer from the [RUNTIME] block of this run\'s context note', 'answer from this block'), LINE, 'D2 ' + name + ': THE INSTRUCTION MOVES WORD FOR WORD, but for the one phrase that points at the block');
    A.eq(Provider.inertHostTags(s.guide), s.guide, 'D2 ' + name + ': no host fence tag in it');
  }
  const block = RuntimeInfo.runtimeIdentityBlock(ident);
  A.eq(RuntimeInfo.splitGuide(block).guide, RuntimeInfo.splitGuide(RuntimeInfo.runtimeIdentityBlock(Object.assign({}, ident, { runId: 'other', model: 'm2', now: NOW + 5 * DAY }))).guide, 'D2: the moved line is the same text for every run, model and day');
  for (const v of ['', null, '[RUNTIME]', block + ' ', block.slice(2), '\n\n[RUNTIME]\n' + LINE.slice(1), '\n' + LINE]) A.eq(RuntimeInfo.splitGuide(v), null, 'D2: ' + JSON.stringify(String(v).slice(0, 24)) + ' is not split');
  const chat = SlimNote.plan({ runtime: block });   // a chat turn's note is the [RUNTIME] block alone
  A.eq([chat.runtime + '\n' + LINE, chat.stable], [block, '\n\n' + RuntimeInfo.splitGuide(block).guide], 'D2: a chat turn: the one line moves, nothing else');
  const all = SlimNote.plan({ skills: GUIDE, quests: QuestInject.questBlock([]), runtime: block });
  A.eq(all.stable, GUIDE + '\n\n' + QuestInject.split(QuestInject.questBlock([])).guide + '\n\n' + RuntimeInfo.splitGuide(block).guide, 'D2: the three moved paragraphs make one stable text: skills, quests, runtime');
  A.eq(SlimNote.plan({ runtime: 'NOT A RUNTIME BLOCK' }), { skills: '', quests: '', runtime: 'NOT A RUNTIME BLOCK', stable: '' }, 'D2: a text the rule does not know stays whole in the note');
  A.ok(Buffer.byteLength(block) - Buffer.byteLength(chat.runtime) === Buffer.byteLength(LINE) + 1, 'D2: ' + (Buffer.byteLength(LINE) + 1) + ' bytes leave every note');
}

/* ---------- E. the host's wiring ---------- */
{
  const START = IDX.indexOf('async function runOnceCore(');
  const CORE = IDX.slice(START, IDX.indexOf('\n}\n', START) + 2);
  A.ok(CORE.length > 100000, 'E: runOnceCore is sliced');
  const planAt = CORE.indexOf("if (stablePrefix && !grantedRun && slimNoteOn()) {\n    const slim = SlimNote.plan({ skills: runtimeSkillBlock, quests: questsBlock");
  A.ok(planAt > 0, 'E: the plan is made only for a run with a note (stablePrefix), never a granted run, and only with the switch on');
  A.ok(CORE.indexOf("if (grantedRun) { questsBlock = '';") < planAt && CORE.indexOf('runtimeSkillBlock = PromptScrub.scrubStored(rs.text') < planAt, 'E: after the blocks are composed and a granted run\'s are blanked');
  A.ok(planAt < CORE.indexOf('  const perRunBlocks = ') && planAt < CORE.indexOf('  const taskSystem = '), 'E: before the note and the system prompt are assembled');
  const cachePrefix = CORE.slice(CORE.indexOf('  const cacheSystemPrefix = '), CORE.indexOf('  /* CACHE-STABLE PREFIX (lean-prompt'));
  A.ok(cachePrefix.length > 500 && cachePrefix.indexOf('slimStable') < 0, 'E: the cached prefix (cacheSystemPrefix) never takes the moved text');
  A.ok(CORE.indexOf('? FinishLine.append(cacheSystemPrefix + serviceKeysBlock + taskDoctrine + journeyBlock + deliverableNote + slimStable, { isTask, internal, tools: resolved.tools })') > 0,
    'E: it closes the system prompt\'s per-conversation tail, before FINISH THE JOB');
  A.eq(CORE.split('slimStable').length - 1, 4, 'E: and is used nowhere else (declared, set, placed; named once in the comment)');
  A.ok(CORE.indexOf(': FinishLine.append(cacheSystemPrefix + PromptScrub.scrubStored(delegatedBlock + stationEvidenceBlock + runtimeSkillBlock\n      + preloadedSkillBlock + serviceKeysBlock + taskIntentNote + awayBriefingNote + directDomainBlock + journeyBlock\n      + deliverableNote + crewCallNote + runtimeBlock), { isTask, internal, tools: resolved.tools });') > 0,
    'E: STARNET_STABLE_PREFIX=0 keeps its one system prompt as it was');
}

A.report('slim-note.test');
