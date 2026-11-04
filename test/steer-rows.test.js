'use strict';
/* node test/steer-rows.test.js — a steering note is a row of the station's own transcript, from the POST to the page (turn identity,
   commit 10; closes 253e5a8e-adjacent mem:send-now-steer-1014).

   A note a Commander sends mid-run (SEND NOW, /steer, a channel follow-up) used to live in three places that never met: the buffer (the
   id died there), the loop (an untagged system message the transcript skipped) and the page (an echo inside the saved reply, replayed to
   the model INSIDE the agent's own message). Now, through the real buffer, loop, run writer, store, merge and windows:
     1. buffer   drainNotes keeps each note's id, settles the ledger exactly as drain does, and drain still answers texts;
     2. loop     a folded note is tagged steer (off-wire: the message's JSON, the <steering_note> text and the '[steering]' token are
                 byte-identical), for a string note and for { text, noteId } alike;
     3. rows     the note is ONE {role system, kind steer, noteId} row written after the tool results of its fold boundary (the tool call
                 and its result stay adjacent), replayed as user '[steering] …' in both shapes, never twice across a duplicate POST, a
                 second drain or a restart;
     4. page     the page stamps the SEND NOW line's id on its echo; the merge replaces the echo with the station's row by id, a note with no
                 id binds by run and words, two equal notes bind one to one; the canonical row is drawn as the mid-run line and never moved;
     5. windows  a reply that embeds '[steering]' lines is split at them outside window:legacy (desk and phone) and byte-preserved in
                 legacy; a retry still ends on the directive; the station's steer rows ride the phone window and thread;
     6. channel  an accepted channel follow-up goes through the same buffer: one steer row from the drain, no second writer.
   RED at 4152883a1: drainNotes does not exist, a folded note is no row, splitSteer does not exist. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const A = require('./_assert.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Merge = require('../frontend/app/turnmerge.js');
const Fit = require('../frontend/app/historyfit.js');
const Workstreams = require('../frontend/app/workstreams.js');
const { makeSteerBuffers } = require('../sidecar/steer-buffer.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const CanonicalHistory = require('./helpers/channel-history.js');
const { steeredRun } = require('./helpers/steer-run.js');
const { TurnFixture } = require('./helpers/turn-fixture.js');
const { PageModel } = require('./helpers/page-model.js');
const { mulberry32 } = require('./helpers/turn-oracle.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeEmitter } = require('../shared/emitter.js');
const events = require('../shared/events.js');

const chat = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-steer-rows-'));
const clockFrom = start => { let t = start; return () => ++t; };
const memoryStore = () => makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: clockFrom(1000) } });
const rowsOf = (store, stream) => store.view('proof', stream, { complete: true });
const steerRows = rows => rows.filter(r => r.kind === 'steer');
const RUN = 'run-00000001';

// every leg fails by itself: a missing owner at the base is one named failure, not an abort of the file
const legs = [];
const leg = (name, fn) => legs.push([name, fn]);

/* ---------------------------------------------------------------- 1. the buffer ---------------------------------------------------- */
leg('buffer: drainNotes keeps each note id and settles the ledger as drain does', async () => {
  const b = makeSteerBuffers({ maxPending: 8, maxNoteChars: 2000 }), twin = makeSteerBuffers({ maxPending: 8, maxNoteChars: 2000 });
  for (const buf of [b, twin]) { buf.post('r1', 'use the blue folder', true, 'sn1'); buf.post('r1', 'from /steer', true); buf.post('r1', 'bad id', true, '../etc'); }
  A.eq(b.drainNotes('r1'), [{ text: 'use the blue folder', noteId: 'sn1' }, { text: 'from /steer', noteId: '' }, { text: 'bad id', noteId: '' }],
    'the loop is handed { text, noteId } in post order; a note with no (or an unusable) id has none');
  A.eq(twin.drain('r1'), ['use the blue folder', 'from /steer', 'bad id'], 'drain still answers texts (its other callers)');
  A.eq(b.status('r1'), twin.status('r1'), 'both drains settle the ledger the same way: the tracked note is applied');
  A.eq(b.status('r1'), { ended: false, notes: { sn1: 'applied' } }, 'applied, once');
  A.eq([b.drainNotes('r1'), b.pending('r1')], [[], 0], 'a drained note leaves the buffer: a second drain finds nothing');
  A.eq(b.drainNotes('nobody'), [], 'a run the buffer never saw drains nothing');
  b.post('r1', 'late', true, 'sn2');
  A.eq(b.close('r1'), ['late'], 'close still hands the loop its never-applied texts');
  A.eq(b.status('r1').notes, { sn1: 'applied', sn2: 'unapplied' }, 'and the ledger keeps what each note became');
});

/* ---------------------------------------------------------------- 2. the loop ----------------------------------------------------- */
leg('loop: a folded note is tagged steer off the wire, for a string and for { text, noteId }', async () => {
  const buffers = makeSteerBuffers({});
  const store = memoryStore();
  const run = await steeredRun(store, { streamId: 's', runId: RUN, directive: 'go work', notes: [{ text: 'make it blue', noteId: 'sn1' }, { text: 'and short' }], buffers });
  const folded = run.result.messages.filter(m => m.role === 'system' && /<steering_note>/.test(String(m.content)));
  A.eq(folded.map(m => JSON.stringify(m)), ['{"role":"system","content":"<steering_note>make it blue</steering_note>"}', '{"role":"system","content":"<steering_note>and short</steering_note>"}'],
    'the wire text of a folded note is unchanged (the tag is off-wire: JSON never sees it)');
  A.eq(folded.map(m => Kinds.tagOf(m)), [{ kind: 'steer', noteId: 'sn1' }, { kind: 'steer' }], 'each is tagged steer, with the id it was posted with');
  A.eq(run.tokens.filter(t => /\[steering\]/.test(t)), ['\n[steering] make it blue\n', '\n[steering] and short\n'], 'the live \'[steering]\' token is unchanged');
  // a worker's generation-bound hook returns strings: the same fold, the same tag, no id
  const bus = A.makeBus(), emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'one' }, { type: 'done', finishReason: 'stop' }], [{ type: 'text', delta: 'two' }, { type: 'done', finishReason: 'stop' }]] });
  const messages = [{ role: 'user', content: 'go' }];
  let calls = 0;
  await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r9', tools: [], limits: { maxIters: 4, grace: false },
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, steer: () => (calls++ ? [] : ['a worker note', { text: '   ' }, { text: 'object note', noteId: 'sn9' }]) });
  const strings = messages.filter(m => m.role === 'system' && /<steering_note>/.test(String(m.content)));
  A.eq(strings.map(m => [m.content, Kinds.tagOf(m)]), [['<steering_note>a worker note</steering_note>', { kind: 'steer' }], ['<steering_note>object note</steering_note>', { kind: 'steer', noteId: 'sn9' }]],
    'a string note and an object note both fold (a blank one never does), tagged steer');
});

/* ---------------------------------------------------------------- 3. the rows ---------------------------------------------------- */
leg('rows: buffer -> loop -> transcript is one steer row per note, after its tool results, replayed as a user line', async () => {
  const store = memoryStore();
  const run = await steeredRun(store, { streamId: 's', runId: RUN, directive: 'go work', notes: [{ text: 'make it blue', noteId: 'sn1' }, { text: 'and short' }] });
  A.eq(run.result.reason, 'done', 'the steered run completes');
  const rows = rowsOf(store, 's'), roles = rows.map(r => r.role + ':' + r.kind);
  A.eq(roles, ['user:turn', 'assistant:turn', 'tool:turn', 'system:steer', 'system:steer', 'assistant:turn'], 'directive, tool call, its result, the two notes, the answer: in the order the run lived them');
  const steers = steerRows(rows);
  A.eq(steers.map(r => [r.content, r.noteId, r.sourceRunId, r.turnId]), [['make it blue', 'sn1', RUN, Kinds.runTurnId(RUN)], ['and short', undefined, RUN, Kinds.runTurnId(RUN)]],
    'each row holds the Commander\'s words alone (not the loop\'s wrapper), its note id when it had one, the run and the run\'s turn');
  const callAt = rows.findIndex(r => r.role === 'assistant' && r.toolCalls), toolAt = rows.findIndex(r => r.role === 'tool');
  A.ok(callAt >= 0 && toolAt === callAt + 1, 'the tool call and its result are still adjacent (the note never splits a pair)');
  A.ok(steers.every(r => r.rowId > rows[toolAt].rowId) && steers.every(r => r.rowId < rows[rows.length - 1].rowId), 'the notes sit after the result and before the answer they shaped');
  const pairs = store.view('model-replay', 's', { shape: 'pairs', form: 'pre' }).map(m => m.role + ':' + (m.content || '').slice(0, 40));
  A.eq(pairs, ['user:go work', 'assistant:On it.', 'tool:worked', 'user:[steering] make it blue', 'user:[steering] and short', 'assistant:Done.'], 'the model replays each as a user \'[steering] …\' line, pairs intact');
  const prose = store.view('model-replay', 's', { shape: 'prose', form: 'pre' });
  A.eq(prose.map(m => m.role), ['user', 'assistant', 'user', 'user', 'assistant'], 'and the prose replay carries them too');
  A.ok(prose.every(m => m.role !== 'assistant' || !/\[steering\]/.test(m.content)), 'no assistant message holds a \'[steering]\' line');
  A.ok(store.view('display', 's', { limit: 50 }).filter(r => r.kind === 'steer').length === 2, 'display shows them');
  A.eq(store.view('model-replay', 's', { shape: 'prose', legacy: true }).map(m => m.role), ['user', 'assistant', 'assistant'], 'the rollback (legacy) replay is unchanged: system rows never reach it');
  // exactly once: a second drain of the same messages, a run-end append of them, and a duplicate POST of a tracked id
  A.eq(store.appendNewStrict('s', 'agent', run.result.messages, { sourceRunId: RUN, turnId: run.turnId, kindOf: m => Kinds.messageKind(m) }), 0, 'a second drain writes nothing (the persisted marker)');
  const dup = makeSteerBuffers({}), again = await steeredRun(memoryStore(), { streamId: 's', runId: 'run-00000002', directive: 'go', notes: [{ text: 'same', noteId: 'snD' }, { text: 'same', noteId: 'snD' }], buffers: dup });
  A.eq(again.result.messages.filter(m => /<steering_note>/.test(String(m.content))).length, 1, 'a retried POST of one tracked id is folded once');
});

leg('rows: a restart finds the same rows, and the steer row of a run survives it once', async () => {
  const fx = new TurnFixture(path.join(scratch, 'restart'), clockFrom(5000), { window: 'id' });
  try {
    await steeredRun(fx.store, { streamId: 's', runId: RUN, directive: 'go work', notes: [{ text: 'make it blue', noteId: 'sn1' }] });
    const before = steerRows(rowsOf(fx.store, 's')).map(r => [r.rowId, r.noteId, r.content]);
    A.eq(before.length, 1, 'one steer row before the restart');
    fx.restart();
    A.eq(steerRows(rowsOf(fx.store, 's')).map(r => [r.rowId, r.noteId, r.content]), before, 'the same row (same id) after it');
    A.eq(fx.read('s').turns.filter(r => r.kind === 'steer').length, 1, 'and GET /api/transcript\'s rows hold it once');
  } finally { fx.close(); }
});

/* ---------------------------------------------------------------- 4. the page ---------------------------------------------------- */
function stationRows(streamId, rows) { return rows.map((r, i) => Object.assign({ streamId, rowId: 10 + i, ts: 100 + i }, r)); }
leg('page: the merge replaces an echo with the station row by note id, else by run and words', async () => {
  const station = stationRows('s', [{ role: 'user', content: 'go', directive: true, turnId: 'rrun-00000001', sourceRunId: RUN },
    { role: 'system', kind: 'steer', content: 'make it blue', noteId: 'sn1', turnId: 'rrun-00000001', sourceRunId: RUN },
    { role: 'system', kind: 'steer', content: 'and short', turnId: 'rrun-00000001', sourceRunId: RUN },
    { role: 'assistant', content: 'Done.', turnId: 'rrun-00000001', sourceRunId: RUN }]);
  const echo = (content, extra) => Object.assign({ role: 'system', sys: true, steerEcho: true, content: '[steering] ' + content, sourceRunId: RUN, ts: 200 }, extra);
  const merged = Merge.merge([echo('make it blue', { noteId: 'sn1' }), echo('and short')], station, { identity: { v: 2, streamId: 's' }, streamId: 's' });
  A.eq(merged.rows.filter(r => r.steerEcho).length, 0, 'both echoes were replaced');
  A.eq(merged.rows.filter(r => r.kind === 'steer').map(r => r.content), ['make it blue', 'and short'], 'by the station\'s rows, in station order');
  A.eq(merged.report.counts.steer_twin, 2, 'each binding is reported');
  // a different id is a different note, even with the same words; and two equal notes bind one to one
  const other = Merge.merge([echo('make it blue', { noteId: 'zzz' })], station, { identity: { v: 2, streamId: 's' }, streamId: 's' });
  A.eq(other.rows.filter(r => r.steerEcho).length, 1, 'an echo whose id the station does not hold is not bound to another note by its words');
  const twice = stationRows('s', [{ role: 'system', kind: 'steer', content: 'again', turnId: 'rrun-00000001', sourceRunId: RUN }, { role: 'system', kind: 'steer', content: 'again', turnId: 'rrun-00000001', sourceRunId: RUN }]);
  const pairing = Merge.merge([echo('again'), echo('again'), echo('again')], twice, { identity: { v: 2, streamId: 's' }, streamId: 's' });
  A.eq([pairing.rows.filter(r => r.kind === 'steer').length, pairing.rows.filter(r => r.steerEcho).length], [2, 1], 'two station rows bind two echoes; a third equal echo stays (nothing for it to bind)');
});

function pageFns(names, globals) {
  const code = names.map(n => A.fnBody(chat, n)).join('\n');
  const c = vm.createContext(Object.assign({ TurnMerge: Merge, TurnKinds: Kinds, sentNow: new Map(), log: null, activeWs: null }, globals || {}));
  vm.runInContext(code + '\nthis.api = { ' + names.map(n => /function (\w+)\(/.exec(n)[1]).join(', ') + ' };', c);
  return { api: c.api, c };
}
leg('page: the SEND NOW line\'s id rides its echo, and the saved history already showing the station row files nothing', async () => {
  const { api, c } = pageFns(['function sentNowIdFor(', 'function fileRunSteers(', 'function showSentNowRead(', 'function shownSteer(']);
  // the live stream: the run echoed two notes, one the page sent (sentNow knows its id) and one it did not
  c.sentNow.set('ws1', [{ id: 'sn1', text: 'make it blue', wire: 'make it blue', runId: RUN, accepted: true, landed: true }]);
  const runSteers = [];
  for (const t of ['make it blue', 'from a channel']) runSteers.push({ text: t, ts: 50, noteId: api.sentNowIdFor('ws1', RUN, t, runSteers) });
  A.eq(runSteers.map(n => n.noteId), ['sn1', ''], 'the id is found by the run and the words; a note the page did not send has none');
  A.eq(api.sentNowIdFor('ws1', RUN, 'make it blue', runSteers), '', 'one line, one echo: the same words twice would need a second line');
  const ws = { id: 'ws1', history: [] };
  A.eq(api.fileRunSteers(ws, runSteers, RUN, 'only the answer'), 2, 'both notes are filed');
  A.eq(ws.history.map(r => [r.steerEcho, r.content, r.noteId]), [[true, '[steering] make it blue', 'sn1'], [true, '[steering] from a channel', undefined]], 'the first echo carries its id, the second none');
  // after a reload: the disk entry says the run read the line; the station row is already in the history
  const read = { id: 'sn1', runId: RUN, text: 'make it blue', wire: 'make it blue', at: 99 };
  const withStation = { id: 'ws2', history: [{ role: 'system', kind: 'steer', content: 'make it blue', noteId: 'sn1', rowId: 4, streamId: 'ws2', sourceRunId: RUN }] };
  api.showSentNowRead(withStation, [read]);
  A.eq(withStation.history.length, 1, 'the station row is the proof it is shown: no second row is filed');
  const without = { id: 'ws3', history: [{ role: 'assistant', content: 'On it.', sourceRunId: RUN }] };
  api.showSentNowRead(without, [read]);
  A.eq(without.history.map(r => [r.steerEcho === true, r.noteId]), [[false, undefined], [true, 'sn1']], 'with nothing showing it, the echo is filed with the line\'s id');
  A.ok(api.shownSteer([{ role: 'system', kind: 'steer', content: '[steering] make it blue', rowId: 4, sourceRunId: RUN }], read, true), 'the same words from the same run are shown');
  A.ok(!api.shownSteer([{ role: 'system', kind: 'steer', content: 'make it blue', rowId: 4, sourceRunId: 'run-other' }], read, true), 'another run\'s row never proves this line');
});

leg('page: a canonical steer row is drawn as the mid-run line and no code moves it', async () => {
  const lines = [];
  const made = Workstreams.create({ agentId: 'agent', title: 'steer' });
  const ws = Workstreams.get(made.id);
  ws.history = [{ role: 'user', content: 'go', ts: 50, rowId: 1, streamId: ws.id, sourceRunId: RUN },
    { role: 'assistant', content: 'On it.', ts: 60, rowId: 2, streamId: ws.id, sourceRunId: RUN },
    { role: 'system', kind: 'steer', content: 'make it blue', noteId: 'sn1', ts: 70, rowId: 3, streamId: ws.id, sourceRunId: RUN },
    { role: 'assistant', content: 'Done.', ts: 80, rowId: 4, streamId: ws.id, sourceRunId: RUN }];
  const code = ['function mediaKindOf(title)', 'function replayableDeliverables(ws)', 'function replayDeliverableRow(d, agentId)', 'function replayFileRow(ws, row, agentId, teachOnly)', 'function steerRow(text, stamp)', 'function renderHistory(onlyTurns)', 'function placeSteerNotes(rows)']
    .map(h => A.fnBody(chat, h)).join('\n');
  const body = {}, classes = [];
  const c = vm.createContext({ TurnKinds: Kinds, TurnMerge: Merge, Workstreams, activeWs: ws, renderingHistory: false,
    row: (who, o) => { lines.push(['row', who, o && o.brief]); return { d: { classList: { add: x => classes.push(x) } }, get body() { return body; } }; },
    addUser: text => lines.push(['user', text]), toolLine() {}, trimMarkerLine() {}, goalStepOf: () => null, goalStepLine() {}, turnFileRefs: () => ({}),
    renderProse: (_b, text) => lines.push(['reply', text]), isBusy: () => false, offerTryAgain() {}, offerRetry() {},
    deliverableLine() {}, imageDeliverableLine() {}, mediaPlayerLine() {}, sysLine() {}, endLogLine() {}, flushSysRuns() {} });
  vm.runInContext(code + '\nthis.api = { renderHistory, placeSteerNotes };', c);
  c.api.renderHistory();
  A.eq(lines.filter(l => l[0] !== 'row'), [['user', 'go'], ['reply', 'On it.'], ['reply', 'Done.']], 'the station\'s steer row is not an agent reply');
  A.eq([lines.filter(l => l[0] === 'row').map(l => l[1] + (l[2] ? ':' + l[2] : '')), classes, body.textContent], [['agent', 'user:COMMANDER · MID-RUN', 'agent'], ['steer-echo'], 'make it blue'],
    'it is drawn as the Commander\'s mid-run line, in its place between the two replies, wire marker stripped');
  // an echo with no station row yet is placed by time; the station row never is
  const echo = { role: 'system', sys: true, steerEcho: true, content: '[steering] later', sourceRunId: RUN, ts: 75 };
  const placed = c.api.placeSteerNotes([ws.history[0], ws.history[1], ws.history[2], ws.history[3], echo]);
  A.eq(placed.map(r => r.rowId || (r.steerEcho ? 'echo' : '')), [1, 2, 3, 'echo', 4], 'only the echo moves (to just after the last row of its run stamped no later than it); row ids keep their order');
});

/* ---------------------------------------------------------------- 5. the windows ------------------------------------------------- */
const SAVED = 'first part\n[steering] older note\nsecond part\n[steering] another\n';
leg('windows: splitSteer splits a steered reply at its notes, and windowRows keeps the rollback window byte for byte', async () => {
  A.eq(typeof Merge.splitSteer, 'function', 'TurnMerge.splitSteer exists');
  const row = { role: 'assistant', content: SAVED, rowId: 7, idFrom: 'content', turnId: 'tAAAAAAAAAAAAAAAAAAAAAAAA', sourceRunId: RUN, streamId: 's', ts: 90 };
  const out = Merge.splitSteer([{ role: 'user', content: 'ask' }, row, { role: 'assistant', content: 'plain' }]);
  A.eq(out.map(m => m.role + ':' + m.content), ['user:ask', 'assistant:first part', 'user:[steering] older note', 'assistant:second part', 'user:[steering] another', 'assistant:plain'],
    'the prose parts are assistant messages and each note a user line, in order; nothing else is trimmed or reworded');
  A.ok(out.slice(1, 5).every(m => !('rowId' in m) && !('idFrom' in m)), 'a derived message is no durable row: it carries no row id');
  A.eq(out[2].kind, 'steer', 'a note line is kind steer (so a retry can tell it from a directive)');
  A.ok(out[1].turnId === row.turnId && out[1].sourceRunId === RUN && out[1].streamId === 's', 'and the rest of the row\'s identity stays on its parts');
  const plain = { role: 'assistant', content: 'no notes here' };
  A.ok(Merge.splitSteer([plain])[0] === plain, 'a row with no steering line is returned as it is');
  A.eq(Merge.splitSteer([{ role: 'assistant', content: '[steering] \nreal' }]).map(m => m.content), ['real'], 'an empty note and an empty part vanish');
  A.eq(Merge.splitSteer([{ role: 'user', content: 'x\n[steering] y' }, { role: 'assistant', sys: true, content: '\n[steering] z' }]).map(m => m.content), ['x\n[steering] y', '\n[steering] z'], 'only a real assistant reply is split');
  for (const window of ['shadow', 'id']) A.ok(Merge.windowRows([row], { window }).every(m => m.role !== 'assistant' || !/\[steering\]/.test(m.content)), window + ': windowRows hands the model no assistant message with a note inside');
  A.ok(Merge.windowRows([row], { window: 'legacy' })[0] === row, 'legacy: the same row object, byte for byte');
  A.eq(Merge.windowRows([{ role: 'system', kind: 'steer', content: 'make it blue', rowId: 3, sourceRunId: RUN, streamId: 's' }, row], { window: 'id' }).slice(0, 1).map(m => m.role + ':' + m.content), ['user:[steering] make it blue'], 'a station steer row is the user line it replays as');
  A.eq(Merge.windowRows([{ role: 'system', kind: 'steer', content: 'make it blue', rowId: 3 }], { window: 'legacy' }), [], 'and never rides the rollback window');
});

leg('windows: a retry still ends on the directive when notes follow it', async () => {
  const window = Merge.windowRows([{ role: 'user', content: 'directive', rowId: 1 }, { role: 'assistant', content: 'On it.', rowId: 2 },
    { role: 'system', kind: 'steer', content: 'make it blue', rowId: 3 }, { role: 'assistant', content: 'Done.', rowId: 4 }], { window: 'id' });
  A.eq(Fit.endOnUserTurn(window).map(m => m.content), ['directive'], 'the replaced attempt\'s note is dropped with its reply');
  A.eq(Fit.endOnUserTurn([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c', kind: 'turn' }]).map(m => m.content), ['a', 'b', 'c'], 'a directive is still the last user turn');
});

const newFixture = (name, window) => new TurnFixture(path.join(scratch, name + '-' + window), clockFrom(9000), { window });
leg('windows: the desk and the phone hand the model no assistant message holding a note (shadow, id), and legacy keeps its bytes', async () => {
  for (const window of ['legacy', 'shadow', 'id']) {
    const fx = newFixture('windows', window);
    try {
      // (a) a reply saved the trunk way: the notes inside the agent's own message (the desk's save is the only copy)
      const local = [{ role: 'user', content: 'older ask' }, { role: 'assistant', content: SAVED }];
      fx.desk = [{ id: 'e', agentId: 'agent', history: local.map(r => Object.assign({}, r)) }];
      const bodiesBefore = fx.calls.length;
      await fx.phoneSend('e', 'next question');
      const phone = fx.calls.slice(bodiesBefore).pop().messages;
      const holds = m => m.role === 'assistant' && /\[steering\]/.test(String(m.content));
      if (window === 'legacy') A.ok(phone.some(m => m.role === 'assistant' && m.content === SAVED), 'legacy: the phone window carries the saved reply byte for byte');
      else A.ok(!phone.some(holds), window + ': no assistant message of the phone window holds a \'[steering]\' line');
      if (window === 'shadow') A.eq(phone.filter(m => m.role !== 'system').map(m => m.role + ':' + m.content), ['user:older ask', 'assistant:first part', 'user:[steering] older note', 'assistant:second part', 'user:[steering] another', 'user:next question'],
        'shadow: the phone window is the saved history split at its notes');
      // (b) the station's own rows for a steered run
      await steeredRun(fx.store, { streamId: 's', runId: RUN, directive: 'go work', notes: [{ text: 'make it blue', noteId: 'sn1' }] });
      fx.desk = [{ id: 's', agentId: 'agent', history: [] }];
      const at = fx.calls.length;
      await fx.phoneSend('s', 'what next');
      const station = fx.calls.slice(at).pop().messages.filter(m => m.role !== 'system').map(m => m.role + ':' + m.content);
      if (window === 'legacy') A.ok(!station.some(t => /\[steering\]/.test(t)), 'legacy: the rollback phone window never carries a note row');
      else A.ok(station.includes('user:[steering] make it blue') && !station.some(t => /^assistant:.*\[steering\]/.test(t)), window + ': the station\'s steer row reaches the phone window as a user line');
      // (c) the phone thread shows the row, with its id, and never as prose of the agent's
      const thread = await fx.phone.thread({ streamId: 's', limit: 20 });
      const mine = thread.filter(r => r.kind === 'steer');
      A.eq(mine.map(r => [r.role, r.content, r.noteId]), [['system', 'make it blue', 'sn1']], window + ': the thread carries the steer row (a display row, role system) with its note id');
      // (d) the desk: the real page window over the same two kinds of history
      const rng = mulberry32(7);
      const page = new PageModel({ streamId: 'e', now: clockFrom(20000), rng, read: sid => fx.read(sid), dispatch: () => '', redactAsk: async () => new Map(), model: { getModel: () => 'test/model', contextLimitOf: () => 128000 } });
      page.ws.history = local.map(r => Object.assign({}, r));
      await page.load();
      const body = await page.prepare('next question');
      const desk = body.messages.filter(m => m.role !== 'system');
      if (window === 'legacy') A.ok(desk.some(m => m.role === 'assistant' && m.content === SAVED), 'legacy: the desk window carries the saved reply byte for byte');
      else A.ok(!desk.some(holds) && desk.some(m => m.role === 'user' && m.content === '[steering] older note'), window + ': the desk window is split at the notes');
    } finally { fx.close(); }
  }
});

/* ---------------------------------------------------------------- 6. the channel -------------------------------------------------- */
leg('channel: an accepted follow-up goes through the same buffer, and its row is the drain\'s', async () => {
  const root = fs.mkdtempSync(path.join(scratch, 'channel-'));
  const channelStore = makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  const io = makeMemoryTranscriptIo(), canonical = CanonicalHistory.make(channelStore, { io, now: clockFrom(100), redact: t => t });
  const buffers = makeSteerBuffers({});
  const posted = [], sends = [], mirrored = [];
  const append = channelStore.appendTurn ? channelStore.appendTurn.bind(channelStore) : null;
  if (append) channelStore.appendTurn = (...args) => { mirrored.push(args); return append(...args); };
  let release, streamId = '';
  const gate = new Promise(r => { release = r; });
  let n = 0;
  const hub = makeChannelHub({ channel: 'telegram', store: channelStore, history: canonical.history, textBatchWaitMs: 30,
    runOnce: async o => {
      streamId = o.streamId;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      const run = await steeredRun(canonical.transcript, { streamId: o.streamId, agentId: o.agentId, runId: o.runId, directive: o.messages.at(-1).content, notes: [], buffers, work: () => gate });
      for (const t of run.tokens) o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: t });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', usd: 0 });
      return { reason: 'done', outcome: 'succeeded', text: 'Done.', usd: 0, turns: 2 };
    },
    steerRun: async (runId, text) => { const r = buffers.post(runId, text, true); posted.push(text); return { ok: r.status === 200, status: r.status }; },
    isOwner: m => m.userId === 'u1', ownerTrusted: m => m.userId === 'u1' && m.chatType === 'dm',
    send: (_c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'writer' }), classify: () => false, newId: () => 'chan' + (++n) });
  const dm = (text, id) => ({ channel: 'telegram', chatId: '4242', chatType: 'dm', userId: 'u1', text, messageId: id, ts: 1 });
  const first = hub.onInbound(dm('write me a poem', '1'));
  await new Promise(r => setTimeout(r, 120));
  await hub.onInbound(dm('also make it rhyme', '2'));
  release(); await first;
  hub.close();
  A.eq(posted, ['also make it rhyme'], 'the follow-up went to the run\'s buffer, on one line');
  const rows = rowsOf(canonical.transcript, streamId), steers = steerRows(rows);
  A.eq(steers.map(r => [r.role, r.content, r.noteId]), [['system', 'also make it rhyme', undefined]], 'the drain wrote it: one steer row in the chat\'s own stream (an untracked note carries no id)');
  A.eq(rows.filter(r => r.content === 'also make it rhyme').length, 1, 'and nothing else wrote the note');
  A.eq(mirrored.filter(a => a[2] === 'also make it rhyme').length, 0, 'the bound chat\'s legacy history file got no second copy');
});

(async () => {
  try {
    for (const [name, fn] of legs) {
      try { await fn(); } catch (e) { A.ok(false, name + ' — threw ' + (e && e.stack || e)); }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  A.report('steer-rows.test');
})();
