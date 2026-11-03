/* node test/transcript-run.identity.test.js — a run's transcript writer stamps turn identity (turn-identity commit 1).

   makeRunTranscript writes one run's directive and dialogue onto the durable transcript. With the new opts it stamps
   the turn's identity: the directive row carries content, typed words, attachment refs, turnId, kind and
   directive: true, and directiveRow() names it once proven; with stamp: true every drained row carries the turnId and
   a kind (its tag, 'station' for the station's own user rows, the run's rowKind), and the quotes the run has read so
   far. With none of them, every row is byte-identical to a trunk run's. Driven over the REAL segmented io on a temp
   dir, read back from the segment file's bytes.

   Legs 1 and 2 fail on a tree without this commit (no setDirective object, no directiveRow, no stamps); leg 3 is the
   control (passes on trunk too). Every test here is a ratchet (commit 1 closes nothing). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeRunTranscript } = require('../sidecar/transcript-run.js');
let TurnKinds = null;
try { TurnKinds = require('../frontend/app/turnkinds.js'); } catch (e) { A.ok(false, 'frontend/app/turnkinds.js loads: ' + (e && e.message)); }
const tag = (m, kind, extra) => (TurnKinds ? TurnKinds.tag(m, kind, extra) : m);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-run-identity-'));
let dirs = 0;
const T = 'tTURNabcdef0123456789xyz';
const T0 = 'tSTALEturn0000000000000';

function leg(name, fn) {
  try { fn(); } catch (e) { A.ok(false, name + ': the leg threw ' + ((e && e.stack) || e)); }
}
function fixture() {
  const root = path.join(BASE, 'h' + (++dirs));
  const io = makeSegmentedTranscriptIo({ fs, path, root });
  const store = makeTranscriptStore({ io, clock: { now: () => 5 } });
  const lines = () => fs.readdirSync(root).filter(n => /^segment-\d{6}\.jsonl$/.test(n)).sort()
    .map(n => fs.readFileSync(path.join(root, n), 'utf8')).join('').split('\n').filter(Boolean);
  const rows = () => lines().map(l => JSON.parse(l));
  return { io, store, lines, rows };
}
const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

try {
  // ---- 1. setDirective({ text, typed, attachments, kind }), directiveRow(), hold, a turnId read at the write ---------
  leg('1', () => {
    const { io, store, rows } = fixture();
    let turnId = T0, held = true;
    const run = makeRunTranscript({ store, streamId: 's', agentId: 'a', runId: 'run-0001', turnId: () => turnId, hold: () => held });
    run.setDirective({ text: 'expanded: contents of notes.txt', typed: 'read my notes', attachments: [{ id: 'a1', name: 'notes.txt', path: '.attachments/notes.txt', mediaType: 'text/plain', kind: 'file' }], kind: 'turn' });
    turnId = T;   // re-keyed before start(): the directive carries the new value
    const directiveRow = () => (typeof run.directiveRow === 'function' ? run.directiveRow() : 'the run has no directiveRow()');
    A.eq(run.start([]), 0, '1: start() writes nothing while held');
    A.eq(directiveRow(), null, '1: directiveRow() is null while held');
    A.eq(run.checkpoint({ phase: 'tool_results', messages: [] }), 0, '1: a boundary writes nothing while held');
    A.eq(directiveRow(), null, '1: and directiveRow() stays null');
    held = false;
    run.checkpoint({ phase: 'tool_results', messages: [] });
    const got = directiveRow();
    const disk = rows();
    A.eq(disk.length, 1, '1: the hold lifted, a boundary drains the directive row');
    const d = disk[0] || {};
    A.eq([d.content, d.typed, d.attachments, d.turnId, d.kind, d.directive, d.role], ['expanded: contents of notes.txt', 'read my notes', [{ id: 'a1', name: 'notes.txt', path: '.attachments/notes.txt', mediaType: 'text/plain', kind: 'file' }], T, 'turn', true, 'user'],
      '1: the directive row carries content, typed, attachments, the turnId changed before start(), kind and directive: true');
    A.eq(got, { rowId: d.rowId, turnId: T, text: 'read my notes' }, '1: directiveRow() returns the proven rowId, the turnId and the typed text');
    A.ok(d.rowId > 0 && io.readById(d.rowId) && io.readById(d.rowId).directive === true, '1: readById serves the directive row by that rowId');
    io.close();
  });

  // ---- 2. stamp: true --------------------------------------------------------------------------------------------
  leg('2', () => {
    const { io, store, rows } = fixture();
    const read = [];
    const run = makeRunTranscript({ store, streamId: 's', agentId: 'a', runId: 'run-0002', turnId: T, stamp: true, rowKind: 'hop', line: 'line1@dock2', quotes: () => read.slice() });
    run.setDirective('patrol the belt');
    const messages = [
      tag({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE] belt', }, 'capture'),
      { role: 'user', content: '[STRUCTURED RESULT REPAIR] fix the json' },
      { role: 'assistant', content: '', tool_calls: [call('c1', 'look')] }
    ];
    run.checkpoint({ phase: 'assistant', messages });   // the tool-call turn's boundary
    read.push({ id: 'other-stream', at: 11 });          // the run reads another stream: the quotes set grows
    messages.push({ role: 'tool', tool_call_id: 'c1', content: 'belt ok' });
    messages.push(tag({ role: 'system', content: '[steering] slow down' }, 'steer', { noteId: 'note_1' }));
    messages.push({ role: 'system', content: 'an untagged fence' });
    messages.push(tag({ role: 'assistant', content: 'routine report' }, 'delivery'));
    run.drain(messages);
    const all = rows();
    const pick = c => all.find(r => r.content === c) || {};
    A.eq(all.map(r => r.turnId), all.map(() => T), '2: every row written carries the turnId');
    A.eq([pick('patrol the belt').kind, pick('patrol the belt').directive], ['turn', true], '2: the directive row gets kind turn and directive: true');
    A.eq(pick('[STRUCTURED RESULT REPAIR] fix the json').kind, 'station', '2: an untagged non-directive user row gets station');
    A.eq(pick('[BEGIN EXTERNAL SCREEN CAPTURE] belt').kind, 'capture', '2: a message tagged capture gets capture');
    A.eq([pick('').kind, pick('belt ok').kind], ['hop', 'hop'], '2: rowKind hop applies to assistant and tool rows');
    const steer = pick('[steering] slow down');
    A.eq([steer.role, steer.kind, steer.noteId], ['system', 'steer', 'note_1'], '2: a system message tagged steer is written as role system, kind steer, its noteId kept');
    A.ok(!all.some(r => r.content === 'an untagged fence'), '2: an untagged system fence is still skipped');
    A.eq([pick('routine report').role, pick('routine report').kind], ['assistant', 'delivery'], '2: an assistant message tagged delivery keeps role assistant');
    A.eq(all.map(r => r.line), all.map(() => 'line1@dock2'), '2: the line rides every row');
    const before = ['[BEGIN EXTERNAL SCREEN CAPTURE] belt', '[STRUCTURED RESULT REPAIR] fix the json', ''].map(pick);
    const after = ['belt ok', '[steering] slow down', 'routine report'].map(pick);
    A.eq(before.map(r => 'quotes' in r || 'quotesAt' in r), [false, false, false], '2: rows drained before the quotes set grows carry none');
    A.eq(after.map(r => [r.quotes, r.quotesAt]), after.map(() => [['other-stream'], [11]]), '2: rows drained after carry the grown set, quotesAt aligned');
    io.close();
  });

  // ---- 3. control: with no new opts, every row is byte-identical to a trunk run's -------------------------------------
  leg('3', () => {
    const { io, store, lines } = fixture();
    const run = makeRunTranscript({ store, streamId: 's', agentId: 'a', runId: 'run-0003' });
    run.setDirective({ text: 'ignored', typed: 'ignored' });
    run.setDirective('hello there');   // a string: exactly the trunk call
    const messages = [
      { role: 'system', content: 'a fence' },
      tag({ role: 'system', content: '[steering] tagged, but no stamp' }, 'steer', { noteId: 'n1' }),
      tag({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE] x' }, 'capture'),
      { role: 'assistant', content: '', tool_calls: [call('c1', 'look')] },
      { role: 'tool', tool_call_id: 'c1', content: 'seen' },
      { role: 'assistant', content: 'done' }
    ];
    run.start(messages.slice(0, 3));
    run.checkpoint({ phase: 'assistant', messages: messages.slice(0, 4) });
    run.drain(messages);
    A.eq(lines(), [
      '{"streamId":"s","agentId":"a","role":"user","content":"hello there","ts":5,"sourceRunId":"run-0003","taintKnown":true,"rowId":1}',
      '{"streamId":"s","agentId":"a","role":"user","content":"[BEGIN EXTERNAL SCREEN CAPTURE] x","ts":5,"sourceRunId":"run-0003","taintKnown":true,"rowId":2}',
      '{"streamId":"s","agentId":"a","role":"assistant","content":"","ts":5,"toolCalls":"[{\\"id\\":\\"c1\\",\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"look\\",\\"arguments\\":\\"{}\\"}}]","sourceRunId":"run-0003","taintKnown":true,"rowId":3}',
      '{"streamId":"s","agentId":"a","role":"tool","content":"seen","ts":5,"toolCallId":"c1","sourceRunId":"run-0003","taintKnown":true,"rowId":4}',
      '{"streamId":"s","agentId":"a","role":"assistant","content":"done","ts":5,"sourceRunId":"run-0003","taintKnown":true,"rowId":5}'
    ], '3 control: with no new opts the rows are byte-identical to a trunk run\'s (setDirective(string) unchanged, tags ignored, system messages skipped)');
    io.close();
  });
} catch (e) {
  A.ok(false, 'test body threw: ' + ((e && e.stack) || e));
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}
A.report('transcript-run.identity.test');
