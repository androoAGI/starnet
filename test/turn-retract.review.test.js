'use strict';
// Review regressions: full-stream authority for directive-free undo, plus the actual desktop command.
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const { createHash } = require('node:crypto');
const { harnessApi } = require('./helpers/harness-api.js');
const History = require('../sidecar/transcript-history.js'), Merge = require('../frontend/app/turnmerge.js');
let Store = require('../sidecar/transcriptstore.js');
if (process.env.TURN_RETRACT_REVIEW_CONTROL) {
  const filename = require.resolve('../sidecar/transcriptstore.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(process.env.TURN_RETRACT_REVIEW_CONTROL, 'utf8'), filename); Store = loaded.exports;
}
const hash = text => createHash('sha256').update(text).digest('hex');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'retract-review-'));
if (path.dirname(path.resolve(root)) !== temp) throw new Error('fixture escaped its temporary parent');
const handles = [], reads = [], tracked = Object.create(fs);
tracked.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(String(file)); return fs.readFileSync(file, ...args); };
function open(name) {
  const io = History.makeSegmentedTranscriptIo({ fs: tracked, path, root: path.join(root, name), segmentBytes: 4096, schedule() {}, onWarning() {} });
  handles.push(io); return { io, store: Store.makeTranscriptStore({ io, hash, clock: { now: () => 10 } }) };
}
function add(store, extra) {
  return store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', role: 'assistant', content: 'ASSISTANT_ONLY',
    turnId: 'review_assistant_001', sourceRunId: 'delivery-run', kind: 'turn' }, extra));
}
const chat = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8'), undo = A.fnBody(chat, 'async function undoCommand(');
function page(rows, response) {
  const ws = { id: 's', history: rows.slice() }, calls = [], notes = [], effects = [];
  const context = vm.createContext({ activeWs: ws, TurnMerge: Merge, Workstreams: { get: () => context.current },
    isBusy: () => false, localLine: note => notes.push(note), App: { persist: () => effects.push('persist') },
    load: () => effects.push('load'), refreshWorkflowViews: () => effects.push('refresh'),
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); const r = await response(body); return Object.assign({ status: r.ok ? 200 : 500 }, r); } });
  context.Harness = { api: harnessApi(context.fetch) };
  context.current = ws;
  vm.runInContext(undo + '\nthis.undo = undoCommand;', context);
  return { ws, context, calls, notes, effects, run: () => context.undo() };
}
(async () => {
  try {
    const initial = open('short'), row = add(initial.store), other = add(initial.store, { turnId: 'review_other_001', content: 'KEEP_OTHER' });
    initial.io.close();
    const f = open('short'), before = f.io.streamRows('s');
    A.eq(f.store.retract({ streamId: 's', turnId: row.turnId, reason: 'retry' }).state, 'unknown', 'directive-free retry remains refused even on a complete stream');
    A.eq(f.io.streamRows('s'), before, 'refused retry makes no durable mutation');
    reads.length = 0;
    const done = f.store.retract({ streamId: 's', turnId: row.turnId, reason: 'undo' });
    A.eq(done.state, 'done', 'cold complete strict stream proves an assistant-only undo');
    A.eq(done.targets, [row.rowId], 'undo targets only the named assistant turn');
    A.ok(reads.length <= 16, 'selection and point proof retain their separate eight-read budgets');
    A.eq(f.store.view('display', 's').map(row => row.content), ['KEEP_OTHER'], 'another turn survives assistant-only undo');
    A.ok(f.store.view('proof', 's').some(found => found.rowId === row.rowId && found.content === row.content), 'undo retains the original durable row');
    const final = open('accepted'), text = 'ACCEPTED_FINAL';
    add(final.store, { role: 'user', content: 'transport prompt', dispatchState: 'pending' });
    add(final.store, { content: 'raw attempt', dispatchState: 'pending' });
    const accepted = add(final.store, { content: text, dispatchState: 'final', dispatchPrompt: 'accepted prompt', dispatchReason: 'done', textLength: text.length, textSha256: hash(text) });
    A.ok(final.store.view('display', 's').some(row => row.rowId === accepted.rowId && row.content === text), 'fixture has a verified accepted final without a directive');
    A.eq(final.store.retract({ streamId: 's', turnId: accepted.turnId, reason: 'undo' }).targets.length, 3, 'complete accepted delivery retracts prompt, raw attempt and final together');
    A.eq(final.store.view('display', 's'), [], 'accepted final cannot reappear after undo');
    const partial = open('partial');
    for (let i = 0; i < 9; i++) add(partial.store, { content: 'x'.repeat(4300) });
    const count = partial.io.streamRows('s'); reads.length = 0;
    A.eq(partial.store.retract({ streamId: 's', turnId: row.turnId, reason: 'undo' }).state, 'unknown', 'no directive in an incomplete suffix never proves an assistant-only turn');
    A.ok(reads.length <= 8, 'sparse incomplete stream refuses within its strict suffix read ceiling');
    A.eq(partial.io.streamRows('s'), count, 'unproven whole-stream coverage has no partial append');
    for (const kind of ['missing', 'changed', 'partial']) {
      const io = History.makeMemoryTranscriptIo(), store = Store.makeTranscriptStore({ io });
      const one = add(store), two = add(store, { content: 'SECOND' });
      const streamRows = io.streamRows.bind(io); let countReads = 0;
      io.history = () => kind === 'partial' ? [two] : [one, two];
      io.streamRows = () => kind === 'missing' ? -1 : streamRows('s') + (kind === 'changed' && ++countReads > 1 ? 1 : 0);
      A.eq(store.retract({ streamId: 's', turnId: one.turnId, reason: 'undo' }).state, 'unknown', kind + ' durable count cannot prove whole-stream coverage');
      A.eq(io.readAll({ perStream: 20 }).length, 2, kind + ' coverage refusal leaves originals alone');
    }
    const cleanIo = History.makeMemoryTranscriptIo(), clean = Store.makeTranscriptStore({ io: cleanIo });
    const local = add(clean), foreign = Object.assign({}, local, { streamId: 'elsewhere', foreign: true });
    let release, reached; const entered = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const p = page([local, foreign], async body => { reached(); await gate; const result = clean.retract(Object.assign({ reason: 'undo' }, body)); return { ok: result.state === 'done', json: async () => Object.assign({ ok: result.state === 'done' }, result) }; });
    const pending = p.run(); await entered;
    A.eq(p.ws.history, [local, foreign], 'actual undo command does not optimistically remove local history');
    A.eq(p.calls[0].body, { streamId: 's', turnId: local.turnId }, 'actual undo uses the shared identity owner and modern selector');
    release(); await pending;
    A.eq(p.ws.history, [foreign], 'confirmed undo removes owned rows and preserves foreign branch context');
    A.eq(p.effects, ['persist', 'load', 'refresh'], 'confirmed undo persists and reloads the active stream');
    const failed = page([local], async () => ({ ok: false, json: async () => ({ error: 'write unconfirmed' }) }));
    await failed.run();
    A.eq(failed.ws.history, [local], 'write failure leaves actual page history untouched');
    A.eq(failed.effects, [], 'write failure never persists an optimistic removal');
    const removed = page([other], async () => { removed.context.current = null; return { ok: true, json: async () => ({ ok: true, targets: [other.rowId] }) }; });
    await removed.run();
    A.eq(removed.ws.history, [other], 'an obsolete deleted workstream is not republished after acknowledgement');
    A.eq(removed.effects, [], 'obsolete command never persists or reloads the deleted workstream');
  } finally {
    for (const io of handles) io.close();
    if (path.dirname(path.resolve(root)) !== temp) throw new Error('fixture cleanup escaped its temporary parent');
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('turn-retract.review');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
