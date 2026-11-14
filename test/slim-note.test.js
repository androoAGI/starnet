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

   RED on the base (57c741da7): sidecar/slim-note.js does not exist and nothing reads the switch. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const SlimNote = require('../sidecar/slim-note.js');
const ContextPack = require('../sidecar/contextpack.js');
const CommanderContext = require('../sidecar/commander-context.js');
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
  const env = sidecarSourceFiles().filter(f => /SLIM_NOTE/.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')) && f.rel !== 'sidecar/index.js').map(f => f.rel);
  A.eq(env, [], 'A: no other sidecar file names the switch in code');
  const mod = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'slim-note.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  A.ok(!/process\.env|Date\.now|new Date|Math\.random|require\('(?:node:)?fs'\)/.test(mod), 'A: the module is pure (no env, clock, random or fs)');
  // every line of index.js that calls the module either reads the switch or sits behind it
  const uses = IDX.split('\n').filter(l => /\bSlimNote\.(?!on\()[A-Za-z]+\(/.test(l));
  A.ok(uses.length >= 1 && uses.every(l => /slimNoteOn\(\) \? SlimNote\./.test(l)), 'A: index.js reaches the module only behind slimNoteOn(): ' + JSON.stringify(uses.map(l => l.trim().slice(0, 90))));
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

A.report('slim-note.test');
