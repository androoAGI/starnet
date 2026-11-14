'use strict';
/* node test/batch-hint.test.js — THE BATCHING SENTENCE (cost audit W2.3, 2026-11-14), the pure half.

   One line at the end of the task doctrine (HOW TO WORK) asks a model to request independent reads, searches, listings
   and a todo update together in one reply, and to keep a call whose arguments depend on a result it has not seen for the
   next reply. ONE switch, STARNET_BATCH_HINT, ships off: with it off the doctrine is byte-identical to before.

   A. the module (sidecar/batch-hint.js): the switch's parser, the sentence, and what the doctrine appends;
   B. the station's read of the switch: index.js batchHintOn over the real ENV(), compiled out of the source and run on fake
      environments ('1' is on; unset, blank, '0' and any other word are off; a STARNET_ value that is set wins over SKYNET_);
   C. one reader, one site: production code names the switch once, as ENV('BATCH_HINT') in the sidecar; the module never
      reads the environment; the sentence is appended at one place, the end of taskDoctrineNote;
   D. the wording against the rest of the prompt: nothing per-run in it, no tool named but todo, no promise about how a
      batch runs, and nothing that splits brief_proceed from the first write (W1.2).

   RED on the base (agent/cand-0152 57c741da7): the module does not exist, nothing reads STARNET_BATCH_HINT and the doctrine
   ends at "never apologize for them.". The request-level proof (the system text a real sidecar sends, switch off and on,
   through a recording model) is test/batch-hint.e2e.test.js. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { decomment } = require('./helpers/decomment.js');
const { sidecarSourceFiles, readSidecarIndex, sidecarFunctionSource } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const WITH_TODO = 'When you need several independent things (file reads, searches, listings, a todo update alongside the next real call), request them together in one reply rather than one per reply; a call whose arguments depend on a result you have not seen yet waits for the next reply. ';
const NO_TODO = 'When you need several independent things (file reads, searches, listings), request them together in one reply rather than one per reply; a call whose arguments depend on a result you have not seen yet waits for the next reply. ';

/* ---- A. THE MODULE ------------------------------------------------------------------------------------------------------ */
let BH = null;
try { BH = require('../sidecar/batch-hint.js'); } catch (e) { A.ok(false, 'A: the batching sentence module exists (sidecar/batch-hint.js): ' + e.message); }
if (BH) {
  A.eq([undefined, null, '', '  ', '0', '1', ' 1 ', 'true', 'on', 'yes', '2', '01', 1, true, { STARNET_BATCH_HINT: '1' }].map(v => BH.on(v)),
    [false, false, false, false, false, true, true, false, false, false, false, false, false, false, false],
    'A: the switch: only the value "1" turns it on; unset, blank, "0", another word, or anything that is not a value (an env object too) is off');
  A.eq(BH.sentence({ todo: true }), WITH_TODO, 'A: the sentence, on a run that has the todo tool');
  A.eq(BH.sentence({ todo: false }), NO_TODO, 'A: the sentence without the todo clause, on a run that lacks the todo tool');
  A.eq([BH.sentence(), BH.sentence(null), BH.sentence({})], [NO_TODO, NO_TODO, NO_TODO], 'A: no facts about the run: no todo clause');
  A.eq([BH.line(true, { todo: true }), BH.line(true, { todo: false })], [WITH_TODO, NO_TODO], 'A: on: the doctrine appends the sentence');
  A.eq([BH.line(false, { todo: true }), BH.line(undefined, { todo: true }), BH.line(null), BH.line('1', { todo: true }), BH.line(1, { todo: true })],
    ['', '', '', '', ''], 'A: off, or handed anything but the parsed switch: the doctrine appends nothing (the empty string)');
  A.eq([Buffer.byteLength(WITH_TODO, 'utf8'), Buffer.byteLength(NO_TODO, 'utf8')], [WITH_TODO.length, NO_TODO.length], 'A: the sentence is plain ASCII (one byte per character on every wire)');
  console.log('[batch-hint] sentence bytes: ' + Buffer.byteLength(WITH_TODO, 'utf8') + ' with the todo clause, ' + Buffer.byteLength(NO_TODO, 'utf8') + ' without');
}

/* ---- B. THE STATION'S READ: index.js batchHintOn over the real ENV() -------------------------------------------------- */
{
  const ENVsrc = sidecarFunctionSource('ENV'), readSrc = sidecarFunctionSource('batchHintOn');
  A.ok(!!readSrc, 'B: the sidecar declares batchHintOn');
  const stationOn = env => new Function('process', 'BatchHint', ENVsrc + '\n' + readSrc + '\nreturn batchHintOn();')({ env }, BH);   // eslint-disable-line no-new-func
  let read = null;
  try {
    read = (readSrc && ENVsrc && BH) ? [{}, { STARNET_BATCH_HINT: '1' }, { STARNET_BATCH_HINT: '0' }, { STARNET_BATCH_HINT: '' }, { SKYNET_BATCH_HINT: '1' },
      { STARNET_BATCH_HINT: '', SKYNET_BATCH_HINT: '1' }, { STARNET_BATCH_HINT: '0', SKYNET_BATCH_HINT: '1' }, { STARNET_BATCH_HINT: ' 1 ', SKYNET_BATCH_HINT: '0' },
      { STARNET_BATCH_HINT: 'true' }].map(stationOn) : null;
  } catch (e) { read = 'threw: ' + e.message; }
  A.eq(read, [false, true, false, false, true, false, false, true, false],
    'B: the station reads the switch through ENV(): unset is off, "1" is on, "0" and blank are off, STARNET_ wins (a blank one too), SKYNET_ is the fallback');
}

/* ---- C. ONE READER, ONE SITE ------------------------------------------------------------------------------------------- */
{
  const mentions = [];
  const scan = (rel, text) => {
    const code = decomment(text);
    for (let at = code.indexOf('BATCH_HINT'); at >= 0; at = code.indexOf('BATCH_HINT', at + 1)) {
      const viaEnv = code.slice(at - 5, at) === "ENV('" && code.slice(at + 10, at + 12) === "')";
      mentions.push(rel + ': ' + (viaEnv ? "ENV('BATCH_HINT')" : JSON.stringify(code.slice(Math.max(0, at - 24), at + 24))));
    }
  };
  for (const f of sidecarSourceFiles()) scan(f.rel, f.text);
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); continue; }
      if (/\.(js|mjs|cjs)$/.test(e.name)) scan(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  };
  for (const d of ['frontend/app', 'shared']) walk(d);
  A.eq(mentions, ["sidecar/index.js: ENV('BATCH_HINT')"], 'C: production code names the switch once, as the sidecar\'s ENV(\'BATCH_HINT\') (' + JSON.stringify(mentions) + ')');
  const mod = (() => { try { return decomment(fs.readFileSync(path.join(ROOT, 'sidecar/batch-hint.js'), 'utf8')); } catch (_) { return null; } })();
  A.ok(mod != null && !/\bprocess\b/.test(mod) && !/\bDate\b/.test(mod), 'C: sidecar/batch-hint.js never touches process or the clock (it is handed the value)');

  const idx = decomment(readSidecarIndex());
  A.eq((idx.match(/batchHintOn\(\)/g) || []).length, 2, 'C: batchHintOn is declared once and asked once');
  A.eq((idx.match(/BatchHint\.\w+/g) || []).sort(), ['BatchHint.line', 'BatchHint.on'], 'C: the host uses the module at two places: the parser inside batchHintOn and the line at the doctrine');
  // the one site: the LAST term of taskDoctrineNote, straight after the doctrine's own last sentence
  const start = idx.indexOf('const taskDoctrineNote = ');
  const doctrine = start < 0 ? '' : idx.slice(start, idx.indexOf(';\n', start) + 1);
  A.ok(doctrine.length > 500 && doctrine.length < 6000, 'C: the taskDoctrineNote statement is sliced whole (' + doctrine.length + ' chars)');
  A.ok(/never apologize for them\. '\s*\+ BatchHint\.line\(batchHintOn\(\), \{ todo: wireNames\.indexOf\('todo'\) >= 0 \}\);$/.test(doctrine),
    'C: the doctrine ends with its own last sentence and then the batching line (off: the empty string, so the doctrine is unchanged)');
  A.ok(/\+ taskDoctrineNote\n/.test(idx) && (idx.match(/taskDoctrineNote/g) || []).length === 2, 'C: the doctrine is composed once and rides the [HARNESS] note once');
}

/* ---- D. THE WORDING AGAINST THE REST OF THE PROMPT ------------------------------------------------------------------- */
{
  for (const [name, s] of [['with todo', WITH_TODO], ['without todo', NO_TODO]]) {
    A.ok(!/\d/.test(s) && !/[<>\[\]{}]/.test(s) && s.indexOf('\n') < 0, 'D (' + name + '): static prose on one line: no number, no fence, no per-run value');
    A.ok(/ $/.test(s) && !/^ /.test(s), 'D (' + name + '): it ends with the one space the doctrine\'s sentences end with');
    A.ok(/\bindependent\b/.test(s) && /together in one reply/.test(s), 'D (' + name + '): it asks for INDEPENDENT calls together in one reply');
    A.ok(/a call whose arguments depend on a result you have not seen yet waits for the next reply/.test(s), 'D (' + name + '): a call whose arguments need an unseen result waits');
    // how a batch runs is the host's business (parallel only when every call is a parallel-safe read, else in order):
    // the sentence promises neither
    A.ok(!/parallel|simultaneous|at once|at the same time|concurrent|in order/i.test(s), 'D (' + name + '): no promise about how a batch runs');
    // W1.2: brief_proceed rides with the first write. The sentence never names a write, an edit or the brief, so it
    // cannot be read as "settle first, write next reply"
    A.ok(!/brief|write|edit|settle|approve|consent/i.test(s), 'D (' + name + '): nothing about the brief or about writes');
    // no wire name of a tool (fs_read, web_search, ...): the only tool it can name is todo, and only when the run has it
    A.ok(!/\b[a-z]+_[a-z_]+\b/.test(s), 'D (' + name + '): no tool wire name');
  }
  A.ok(/\btodo\b/.test(WITH_TODO) && !/\btodo\b/.test(NO_TODO), 'D: todo is named only in the variant for a run that has it');
  // the lines this sentence has to agree with are still what it was written against
  const briefTools = fs.readFileSync(path.join(ROOT, 'sidecar/taskbrief-tools.js'), 'utf8');
  A.ok(/send it in the SAME response as your first write\/execute call, listed first; the host runs it first\./.test(briefTools),
    'D: brief_proceed still says to ride in the same response as the first write (W1.2)');
  const idxRaw = readSidecarIndex();
  A.ok(/const PARALLEL_UNSAFE_FAMILY = \/\^\(browser\|computer\|desktop\|spotify\|team\|brief\|shell\|verify\)\\\.\/;/.test(idxRaw),
    'D: the families a batch never runs concurrently are the ones the sentence was checked against (brief and team among them)');
  A.ok(/If you name a next step, make that tool call in the SAME reply\./.test(idxRaw), 'D: the [HARNESS] note still ends on its same-reply rule');
}

A.report('batch-hint.test');
