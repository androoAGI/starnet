/* node test/turn-dual.forget.test.js — ONE FORGET PREDICATE WITH QUOTE PROVENANCE (turn identity commit 11, A2-MIG-02, A2-FP-01/02).

   A row that QUOTES a session deleted since (its stamp: quotes + quotesAt, put there by the run that read the session) is forgotten like
   the session's own rows: it leaves model-replay (both shapes), recall, owner-evidence and display, in EVERY mode (the rollback modes
   included), whatever its own time says. Proven on the real store, ledger, view, merge and window modules:

     1. the pure rule (TurnKinds.quotesForgotten): a named stream deleted at or after its read, the saturated ['*'] against the newest
        non-adopted delete, the stamp's own time, never a row's ts
     2. the ledger's latestAt(): the newest non-adopted stamp (an adopted stamp is skipped)
     3. the store: ONE predicate (isForgotten) for every legacy reader (history, reconstruct, search, around, all) and every view,
        a delete that lands after a row was written, a row written after the delete, the two stamp shapes, the unstamped control
     4. the rollback: turnDual.pick with a throwing id path falls to the legacy result, which drops the same rows
     5. the page's drop proof: the display view lists what it hid (identity.forgotten), and TurnMerge R2/R4 drop the page's copies
     6. the posted-window forget floor (turn-window.js): keyed rows by the stored row's predicate, an id-less reply by its run, an
        id-less user row never, a row the store keeps never removed */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Kinds = require('../frontend/app/turnkinds.js');
const Merge = require('../frontend/app/turnmerge.js');
const Dual = require('../sidecar/turn-dual.js');
const View = require('../sidecar/turn-view.js');
const Window = require('../sidecar/turn-window.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeSessionTombstones } = require('../sidecar/session-tombstones.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------------- 1. the pure rule ----------------
{
  const at = (stamp, deleted, latest) => Kinds.quotesForgotten(stamp, id => deleted[id] || 0, () => latest || 0);
  A.ok(at({ quotes: ['S'], quotesAt: [50] }, { S: 60 }), 'a quoted stream deleted after the read began is forgotten');
  A.ok(at({ quotes: ['S'], quotesAt: [50] }, { S: 50 }), '…and one deleted AT the read epoch (the read was in flight)');
  A.ok(!at({ quotes: ['S'], quotesAt: [50] }, { S: 49 }), 'a delete before the read began is not the row\'s (the store already hid what S held)');
  A.ok(!at({ quotes: ['S'], quotesAt: [50] }, {}), 'a stream nobody deleted forgets nothing');
  A.ok(at({ quotes: ['S'] }, { S: 1 }), 'a stamp with no times counts every read as time 0: any delete of S forgets it');
  A.ok(at({ quotes: ['A', 'S'], quotesAt: [10, 80] }, { A: 5, S: 90 }), 'one forgotten quote among several forgets the row');
  A.ok(!at({ quotes: ['A', 'S'], quotesAt: [10, 80] }, { A: 5, S: 70 }), '…and each quote is compared against its OWN read time (A deleted before its read, S before its read)');
  // the saturated stamp reads no list
  A.ok(at({ quotes: ['*'], quotesAt: [40] }, {}, 40), 'saturated: a non-adopted delete stamped at its time forgets the row, whichever session it was');
  A.ok(at({ quotes: ['*'], quotesAt: [40] }, {}, 90), '…or after it');
  A.ok(!at({ quotes: ['*'], quotesAt: [40] }, {}, 39), '…but not one stamped before the run began');
  A.ok(!at({ quotes: ['*'], quotesAt: [0] }, {}, 0), 'no delete at all (latestDeleteAt 0) forgets nothing, whatever the stamp\'s time');
  A.ok(!at({ quotes: ['*'], quotesAt: [40] }, { S: 99 }, 0), 'a saturated stamp never consults the per-stream list');
  A.ok(at({ quotes: ['*'] }, {}, 7), 'a saturated stamp with no time counts as 0: any non-adopted delete forgets it');
  A.ok(at({ quotesSaturatedAt: 30 }, {}, 31), 'a run record\'s own quotesSaturatedAt is the same saturated rule');
  A.ok(!at({ quotesSaturatedAt: 30 }, {}, 29), '…against the same ledger');
  A.ok(!at({}, { S: 1 }, 1) && !at(null, {}, 1) && !at({ quotes: [] }, {}, 1), 'no stamp, no verdict');
  A.ok(!Kinds.quotesForgotten({ quotes: ['S'], quotesAt: [1] }, null, null), 'without a ledger nothing is forgotten (never throws)');
  A.eq(Kinds.quoteEntriesOf([{ streamId: 'A', deliveryText: 'x' }, { streamId: 'A', deliveryText: 'y' }, { streamId: 'B', deliveryText: '  ' }, { streamId: '', deliveryText: 'z' }, { streamId: 'C', deliveryText: 'w' }], 77),
    [{ id: 'A', at: 77 }, { id: 'C', at: 77 }], 'quoteEntriesOf: the distinct stream of every run with delivery text, each read at now');
}

// ---------------- 2. the ledger's latestAt ----------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-forget-ledger-'));
  try {
    let now = 1000;
    const t = makeSessionTombstones({ fs, path, file: path.join(dir, 'session-tombstones.json'), now: () => now });
    A.eq(t.latestAt(), 0, 'a fresh ledger has no delete');
    t.observe(['old_1', 'old_2']);   // the first list is ADOPTED
    A.eq([t.deletedAt('old_1'), t.latestAt()], [1000, 0], 'an adopted stamp is a stamp for its stream but never "a delete since"');
    now = 2000; t.observe(['old_1', 'old_2', 'fresh_1']);
    A.eq(t.latestAt(), 2000, 'a fresh delete is the newest non-adopted stamp');
    now = 3000; t.observe(['old_1', 'old_2', 'fresh_1', 'fresh_2']);
    A.eq(t.latestAt(), 3000, '…and the newest of several');
    now = 4000; t.observe(['old_1', 'old_2', 'fresh_1', 'fresh_2']); t.observe(['old_2', 'fresh_2']);
    A.eq(t.latestAt(), 3000, 'an id leaving the page\'s list moves nothing: what was deleted stays the newest delete');
    now = 5000; t.observe(['old_2', 'fresh_2', 'old_1']);
    A.eq([t.deletedAt('old_1'), t.latestAt()], [5000, 5000], 'a re-deleted adopted stream is a fresh delete (no longer adopted)');
    A.eq(t.unpurged().map(e => e.id).sort(), ['fresh_1', 'fresh_2', 'old_1'], 'unpurged() never lists the adopted stamp that was not re-deleted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------- 3. the store: one predicate, every reader ----------------
let ledger = { deleted: {}, latest: 0 };
let time = 100;
const failures = [];
function makeStore(extra) {
  return makeTranscriptStore(Object.assign({ io: makeMemoryTranscriptIo(), clock: { now: () => time++ }, deletedAt: id => ledger.deleted[id] || 0,
    latestDeleteAt: () => ledger.latest,
    runOf: id => (id ? { ownerDirective: true, internal: false, agentId: 'a', streamId: 'T' } : null), quotedMaterial: () => false,
    live: new Set() }, extra));
}
const W = 'quokka';   // the deleted session's word
function seed(store, stream) {
  const row = (role, content, extra) => store.appendStrict(Object.assign({ streamId: stream, agentId: 'a', role, content, taint: null, kind: 'turn', turnId: 'turn-' + (extra && extra.tag || 'x') + '-0001' }, extra));
  const before = row('user', 'plain question about platypus', { directive: true, sourceRunId: 'r_plain', tag: 'a' });
  const plain = row('assistant', 'plain answer about platypus', { sourceRunId: 'r_plain', tag: 'a' });
  const quoting = row('assistant', 'the ' + W + ' codeword is Wallaby-Seven', { sourceRunId: 'r_quote', quotes: ['S'], quotesAt: [50], tag: 'b' });
  const early = row('assistant', 'a wombat note read AFTER its session was deleted stays', { sourceRunId: 'r_late', quotes: ['S'], quotesAt: [70], tag: 'c' });   // S is deleted at 60: this read came later
  const satNow = row('assistant', 'a ' + W + ' summary the saturated run wrote', { sourceRunId: 'r_sat', quotes: ['*'], quotesAt: [40], tag: 'd' });
  const satLater = row('assistant', 'a saturated run that began after the delete', { sourceRunId: 'r_sat2', quotes: ['*'], quotesAt: [90], tag: 'e' });
  const plainTool = row('tool', 'a tool result about platypus', { sourceRunId: 'r_plain', toolCallId: 'call_1', tag: 'a' });
  return { before, plain, quoting, early, satNow, satLater, plainTool };
}
const ids = list => list.map(r => r.rowId);
{
  const store = makeStore();
  const rows = seed(store, 'T');
  const hasWord = list => list.some(r => String(r.content || r.text || '').includes(W));
  // nothing deleted yet: every row is visible
  A.eq(ids(store.view('display', 'T', { limit: 50 })), ids(Object.values(rows)), 'before any delete the display shows every row (the tool row too)');
  A.ok(!store.isForgotten(rows.quoting) && !store.isForgotten(rows.satNow), 'before any delete nothing is forgotten');
  // S is deleted at 60 and the ledger's newest non-adopted delete is 60 - AFTER the rows above were written (their ts 100+)
  ledger = { deleted: { S: 60 }, latest: 60 };
  A.ok(store.isForgotten(rows.quoting), 'a row that quotes S (read at 50) is forgotten once S is deleted at 60, though it was WRITTEN (ts 100+) after the delete stamp');
  A.ok(!store.isForgotten(rows.early), 'a row whose read of S began after the delete (70 > 60) is not');
  A.ok(store.isForgotten(rows.satNow), 'a saturated row begun before the newest delete (40 <= 60) is forgotten');
  A.ok(!store.isForgotten(rows.satLater), 'a saturated row begun after the newest delete (90 > 60) is not');
  A.ok(!store.isForgotten(rows.before) && !store.isForgotten(rows.plain) && !store.isForgotten(rows.plainTool), 'the unstamped control rows are untouched');
  const visible = new Set([rows.before, rows.plain, rows.early, rows.satLater].map(r => r.rowId));
  const gone = [rows.quoting, rows.satNow].map(r => r.rowId);
  // every view
  const display = store.view('display', 'T', { limit: 50 });
  A.eq(ids(display), [rows.before, rows.plain, rows.early, rows.satLater, rows.plainTool].map(r => r.rowId), 'display: the quoting and the saturated-early rows are gone, the rest stay in order');
  A.ok(!display.some(r => gone.includes(r.rowId)), 'display holds no forgotten row');
  for (const shape of ['prose', 'pairs']) {
    const replay = store.view('model-replay', 'T', { limit: 50, shape, form: 'pre' });
    A.ok(!hasWord(replay) && replay.some(m => /platypus/.test(m.content)) && replay.some(m => /wombat/.test(m.content)), 'model-replay (' + shape + '): no forgotten word, the controls (and the later read) stay');
    const rowsOut = store.view('model-replay', 'T', { limit: 50, shape, form: 'pre', rows: true });
    A.ok(rowsOut.every(r => visible.has(r.rowId) || r.rowId === rows.plainTool.rowId), 'model-replay rows (' + shape + '): only visible rows');
  }
  A.eq(ids(store.view('recall', 'T', { op: 'search', query: W, limit: 20, scope: 'all' })), [], 'recall search: the forgotten rows are not returned');
  A.eq(ids(store.view('recall', 'T', { op: 'search', query: 'wombat', limit: 20, scope: 'all' })), [rows.early.rowId], 'recall search: the read that began after the delete still is');
  const around = store.view('recall', 'T', { op: 'around', anchor: 'tx-' + rows.quoting.rowId, window: 6 });
  A.ok(!around.some(r => gone.includes(r.rowId)), 'recall around: the window around a forgotten row holds no forgotten row');
  // owner-evidence: a clean owner USER row that quotes S (a held steer line, a composed brief) is not evidence once S is deleted
  ledger = { deleted: {}, latest: 0 };
  const owner = store.appendStrict({ streamId: 'T', agentId: 'a', role: 'user', content: 'the ' + W + ' brief the Commander asked for', taint: null, kind: 'turn', turnId: 'turn-owner-0001', directive: true, sourceRunId: 'r_owner', quotes: ['S'], quotesAt: [50] });
  A.ok(store.view('owner-evidence', 'T', { limit: 50 }).some(r => r.rowId === owner.rowId), 'before the delete the owner row is evidence');
  ledger = { deleted: { S: 60 }, latest: 60 };
  A.ok(!store.view('owner-evidence', 'T', { limit: 50 }).some(r => r.rowId === owner.rowId), 'owner-evidence: a clean owner row that quotes a deleted session is no longer evidence');
  A.eq(store.ownerProof([owner.rowId]).size, 0, 'ownerProof agrees (the proof read applies the same predicate)');
  // the legacy private readers
  A.ok(!hasWord(store.history('T', { limit: 50 })) && store.history('T', { limit: 50 }).length === 5, 'history: no forgotten row');
  A.ok(!hasWord(store.reconstruct('T', { limit: 50 })) && store.reconstruct('T', { limit: 50 }).length >= 3, 'reconstruct: no forgotten row');
  A.ok(!store.all().some(r => r.rowId === rows.quoting.rowId), 'all(): no forgotten row');
  A.ok(!store.search('T', W, { scope: 'all', limit: 20 }).some(r => gone.includes(r.rowId)), 'search: no forgotten row');
  A.ok(!store.around('T', rows.quoting.ts, { window: 8 }).some(r => gone.includes(r.rowId)), 'around: no forgotten row');
  A.ok(store.history('T', { limit: 50, proof: true }).some(r => r.rowId === rows.quoting.rowId), 'a PROOF read still sees it (append-only evidence; it is never handed to a model)');
  // the rule never reads row.ts: the same stamp on a row written long before is the same verdict
  const old = makeStore();
  old.appendStrict({ streamId: 'T', agentId: 'a', role: 'assistant', content: 'old ' + W, taint: null, kind: 'turn', turnId: 'turn-old-00001', sourceRunId: 'r_o', quotes: ['S'], quotesAt: [50], ts: 1 });
  A.ok(old.isForgotten({ quotes: ['S'], quotesAt: [50], streamId: 'T', ts: 1 }), 'a row timestamped before the delete is forgotten by the quote rule too');
  A.ok(old.isForgotten({ streamId: 'T', ts: 10 ** 12, quotes: ['S'], quotesAt: [50] }), '…and one timestamped long after it: the rule never compares ts');
  A.ok(!old.isForgotten({ streamId: 'T', ts: 1, quotes: ['S'], quotesAt: [70] }) && !old.isForgotten({ streamId: 'T', ts: 10 ** 12 }), '…and a later read or no stamp at all is not');
  // a store with no ledger forgets nothing and never throws
  const bare = makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => time++ } });
  const b = bare.appendStrict({ streamId: 'T', agentId: 'a', role: 'assistant', content: 'x', quotes: ['S'], quotesAt: [1] });
  A.ok(!bare.isForgotten(b) && !bare.isQuoteForgotten(b), 'a store given no ledger forgets nothing');
  // a store given deletedAt but no latestDeleteAt cannot evaluate the saturated stamp (it never throws)
  const half = makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => time++ }, deletedAt: id => ledger.deleted[id] || 0 });
  A.ok(!half.isForgotten({ streamId: 'T', ts: 5, quotes: ['*'], quotesAt: [1] }) && half.isForgotten({ streamId: 'T', ts: 5, quotes: ['S'], quotesAt: [1] }), 'without latestDeleteAt only the named-stream rule applies');
}

// ---------------- 4. the rollback: turnDual.pick with a throwing id path ----------------
{
  ledger = { deleted: {}, latest: 0 };
  let modes = { display: 'id', replay: 'id' };
  const dual = Dual.make({ now: () => time++, hash, env: () => undefined, read: () => ({ modes }), save: () => {}, failNote: (where) => failures.push(where) });
  const broken = (surface, legacyFn) => dual.pick(surface, legacyFn, () => { throw new Error('the id path broke'); });
  const store = makeStore({ pick: broken });
  const rows = seed(store, 'T');
  ledger = { deleted: { S: 60 }, latest: 60 };
  const display = store.view('display', 'T', { limit: 50 });
  A.ok(failures.includes('turnid.display'), 'the id path threw and the fallback ran (turnid.display)');
  A.ok(!display.some(r => [rows.quoting.rowId, rows.satNow.rowId].includes(r.rowId)) && display.some(r => r.rowId === rows.plain.rowId), 'display, legacy fallback: the quote-stamped rows are dropped, the control stays');
  const replay = store.view('model-replay', 'T', { limit: 50, shape: 'prose', form: 'pre' });
  A.ok(!replay.some(m => String(m.content).includes(W)) && replay.some(m => /platypus/.test(m.content)), 'model-replay, legacy fallback: no forgotten word, the control stays');
  // and the explicit rollback modes return the same rows
  modes = { display: 'legacy', replay: 'legacy' };
  const legacyStore = makeStore({ pick: (surface, legacyFn, nextFn) => dual.pick(surface, legacyFn, nextFn) });
  const lrows = seed(legacyStore, 'U');
  ledger = { deleted: { S: 60 }, latest: 60 };
  A.ok(!legacyStore.view('display', 'U', { limit: 50 }).some(r => [lrows.quoting.rowId, lrows.satNow.rowId].includes(r.rowId)), 'display:legacy (the rollback mode) forgets the same rows');
  A.ok(!legacyStore.view('model-replay', 'U', { limit: 50, shape: 'pairs', form: 'pre' }).some(m => String(m.content).includes(W)), 'replay:legacy (the rollback mode) forgets the same rows');
}

// ---------------- 5. the page's drop proof ----------------
{
  ledger = { deleted: {}, latest: 0 };
  const store = makeStore();
  const rows = seed(store, 'T');
  ledger = { deleted: { S: 60 }, latest: 60 };
  const display = store.view('display', 'T', { limit: 50 });
  const listed = display[View.FORGOTTEN];
  A.eq(listed && listed.keys, [['T', rows.quoting.rowId], ['T', rows.satNow.rowId]], 'the display view lists the rows the quote rule hid (stream + rowId), in row order');
  A.eq(listed && listed.runIds, ['r_quote', 'r_sat'], '…and the runs they came from');
  A.ok(!Object.keys(display).includes(String(View.FORGOTTEN)) && !JSON.stringify(display).includes('r_quote'), 'the list is a non-enumerable side channel: the serialized rows are unchanged');
  const dual = Dual.make({ now: () => time++, hash, env: () => undefined, read: () => null, save: () => {}, failNote: () => {} });
  const wire = dual.project('T', display, { forgotten: listed });
  A.eq(wire.identity.forgotten, { keys: [['T', rows.quoting.rowId], ['T', rows.satNow.rowId]], runIds: ['r_quote', 'r_sat'] }, 'the GET identity block carries forgotten {keys, runIds}');
  // the page still holds its copies: a keyed row, an id-less reply of the forgotten run, an id-less user row of the same run
  const keyed = { role: 'assistant', content: 'cached ' + W + ' reply', streamId: 'T', rowId: rows.quoting.rowId, turnId: 'turn-b-0001', sourceRunId: 'r_quote' };
  const idless = { role: 'assistant', content: 'provisional ' + W + ' reply', turnId: 'turn-zz-0001', sourceRunId: 'r_sat', ts: 5 };
  const typed = { role: 'user', content: 'typed words of the same run', turnId: 'turn-zz-0001', sourceRunId: 'r_sat', ts: 4 };
  const merged = Merge.merge([typed, keyed, idless], wire.turns, { identity: wire.identity });
  const texts = merged.rows.map(r => r.content);
  A.ok(!texts.some(t => String(t).includes(W)), 'TurnMerge: the page\'s keyed copy (R2) and its id-less reply of a forgotten run (R4) are dropped');
  A.ok(texts.includes('typed words of the same run'), '…the run\'s typed user row stays (a user row is never a copy a run took by reading)');
  A.eq(Merge.merge([keyed], wire.turns, { identity: Object.assign({}, wire.identity, { forgotten: { keys: [], runIds: [] } }) }).rows.filter(r => r.rowId === keyed.rowId).length, 1, 'control: WITHOUT the list the page cached copy survives (the station no longer returns the row, and silence is not a drop proof), which is why the station lists what it hid');
}

// ---------------- 6. the posted-window forget floor ----------------
{
  ledger = { deleted: {}, latest: 0 };
  const store = makeStore();
  const rows = seed(store, 'T');
  ledger = { deleted: { S: 60 }, latest: 60 };
  const dual = Dual.make({ now: () => time++, hash, env: () => undefined, read: () => ({ modes: { window: 'shadow' } }), save: () => {}, failNote: () => {} });
  const noted = [];
  const window = Window.make({ transcriptStore: store, turnDual: dual, failNote: (tag) => noted.push(tag), runForgotten: id => id === 'r_gone' });
  const posted = [
    { role: 'system', content: 'persona' },
    { role: 'user', content: 'plain question about platypus', rowId: rows.before.rowId, streamId: 'T' },
    { role: 'assistant', content: 'plain answer about platypus', rowId: rows.plain.rowId, streamId: 'T' },
    { role: 'assistant', content: 'cached ' + W, rowId: rows.quoting.rowId, streamId: 'T', sourceRunId: 'r_quote' },
    { role: 'assistant', content: 'provisional ' + W, sourceRunId: 'r_gone' },
    { role: 'user', content: 'typed words of the forgotten run', sourceRunId: 'r_gone' },
    { role: 'assistant', content: 'a reply of a run nobody forgot', sourceRunId: 'r_fine' },
    { role: 'assistant', content: 'a keyed row the store cannot read', rowId: 999999, streamId: 'T', sourceRunId: 'r_gone' },
    { role: 'user', content: 'now: one more question' }
  ];
  const o = { streamId: 'T', agentId: 'a' };   // NOT a desk request: no windowCaller, so the window is ineligible - the floor still runs
  const out = window.apply(posted, o, { agentId: 'a', runId: 'r_now', directive: null });
  A.eq(out.map(m => m.content), ['persona', 'plain question about platypus', 'plain answer about platypus', 'typed words of the forgotten run', 'a reply of a run nobody forgot', 'now: one more question'],
    'floor, ineligible request: a keyed row the store forgets, an id-less reply of a forgotten run and an unreadable key of a forgotten run are dropped; users and the rest stay');
  A.ok(noted.includes('turn.window.forgotten'), 'the drop is tallied (turn.window.forgotten)');
  const clean = [posted[0], posted[1], posted[2], posted[6], posted[8]];
  A.ok(window.apply(clean, o, { agentId: 'a', runId: 'r_now', directive: null }) === clean, 'nothing to drop: the SAME array comes back, byte for byte');
  A.ok(window.apply('not a list', o, null) === 'not a list' && window.apply(clean, { agentId: 'a' }, null) === clean, 'malformed input and a stream-less request pass through');
  // a store that cannot prove a key: the id-less rule is the fallback, and the row the store KEEPS is never removed
  const keeps = [{ role: 'assistant', content: 'kept row of a run the page thinks is forgotten', rowId: rows.plain.rowId, streamId: 'T', sourceRunId: 'r_gone' }, posted[8]];
  A.eq(window.apply(keeps, o, null).length, 2, 'a keyed row whose stored row is NOT forgotten stays even when its run is listed (the stored row is the authority)');
  // eligible request in shadow mode: the posted window is used, so the floor decides what it holds
  const eligible = { streamId: 'T', agentId: 'a', windowCaller: 'desk', turnId: 'tdesk0000000001', windowTokens: 4000, runId: 'r_now' };
  const directive = { turnId: eligible.turnId, rowId: 0 };
  const shadow = window.apply(posted, eligible, { agentId: 'a', runId: 'r_now', directive });
  A.ok(!shadow.some(m => String(m.content).includes(W)), 'eligible request, window:shadow: the posted window the run is handed holds no forgotten word');
  A.ok(dual.status().counters['window.forgotten'] >= 1, '…and the divergence ring tallies the class (window.forgotten)');
}

// ---------------- 7. the run's latch, its journal record and its run record ----------------
{
  const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
  const J = require('../sidecar/run-journal.js');
  const D = require('../sidecar/turn-directive.js');
  const { makeRunStore } = require('../sidecar/runstore.js');
  const exe = makeRunExecutionState({ startedAt: 1000 });
  A.eq(exe.quotes(), [], 'a run that read nothing quotes nothing');
  A.eq(exe.latchQuotes([{ id: 'S', at: 2000 }, { id: 'T', at: 1500 }]), [{ id: 'S', at: 2000 }, { id: 'T', at: 1500 }], 'latchQuotes returns what it added');
  A.eq(exe.latchQuotes([{ id: 'S', at: 2500 }]), [], 'a later read of a latched stream adds nothing: it keeps the EARLIEST at');
  A.eq(exe.latchQuotes([{ id: 'S', at: 1800 }]), [{ id: 'S', at: 1800 }], 'an earlier read moves the stream earlier (the journal must record it)');
  A.eq(Kinds.quoteStamp(exe.quotes()), { quotes: ['S', 'T'], quotesAt: [1800, 1500] }, 'quotes() is exactly what a row stamp is made of');
  A.eq(exe.quoteRoom(['S', 'U', 'S', '*']), ['S', 'U'], 'quoteRoom: a latched stream, a new one in candidate order, no duplicates, never the marker');
  for (let i = 0; i < 30; i++) exe.latchQuotes([{ id: 'n' + i, at: 3000 + i }]);
  A.eq(exe.quotes().length, 32, 'the latch holds QUOTES_MAX (32) streams');
  A.eq(exe.quoteRoom(['n0', 'extra1', 'extra2']), ['n0'], 'full: a stream already held is in the room, a new one is not');
  A.eq(exe.isSaturated(), false, 'a full latch is not saturated: the next direct read is REFUSED (overflow), nothing is cut');
  exe.latchQuotes([{ id: 'overflow', at: 4000 }]);
  A.eq([exe.isSaturated(), exe.quotesSaturatedAt()], [true, 1000], 'a latch that would pass the capacity saturates (never truncates), at the run start at the latest');
  A.eq(Kinds.quoteStamp(exe.quotes()), { quotes: ['*'], quotesAt: [1000] }, '...and every row it writes from then on carries the saturated stamp');
  A.eq(exe.quoteRoom(['anything', 'else']), ['anything', 'else'], 'a saturated run reads anything: its stamp already covers every session');
  const sat = makeRunExecutionState({ startedAt: 500 });
  sat.saturate(900); sat.saturate(2000);
  A.eq(sat.quotesSaturatedAt(), 500, 'saturate() only ever moves earlier and never later than the run started');
  A.eq(makeRunExecutionState({}).saturate(77), 77, 'a run with no known start saturates at the time it is told');

  // the journal: a 'quotes' record, derived state, not redacted, and the verdict
  const files = new Map();
  const io = { create(id, line) { files.set(id, line + '\n'); }, append(id, line) { files.set(id, files.get(id) + line + '\n'); }, read: id => files.get(id), list: () => [...files.keys()],
    readFile: id => files.get(id), remove: id => files.delete(id) };
  let tick = 100;
  const longId = 'ws_' + 'a1b2c3d4e5f60718'.repeat(2);
  const j = J.makeRunJournal({ io, clock: { now: () => ++tick }, redact: s => s.replace(/[a-f0-9]{24,}/g, '[redacted]') });
  j.begin({ runId: 'rq', agentId: 'a', streamId: 'T' });
  A.eq([j.inspect('rq').quotes, j.inspect('rq').quotesSaturatedAt], [[], null], 'a journal with no quotes record derives none');
  j.toolIntent('rq', { callId: 'c1', name: 'recall_conversation', argsRaw: '{}', mutating: false });
  j.quotes('rq', { streams: [{ id: 'S', at: 50 }, { id: longId, at: 60 }, { id: 'bad id!', at: 1 }] });
  j.toolResult('rq', { callId: 'c1', ok: true, content: 'found it' });
  j.quotes('rq', { streams: [{ id: 'S', at: 40 }, { id: 'U', at: 70 }] });
  const state = j.inspect('rq');
  A.eq(state.quotes, [{ id: 'S', at: 40 }, { id: longId, at: 60 }, { id: 'U', at: 70 }], 'analyze derives state.quotes: the earliest at per stream; a stream id is validated, never redacted; a bad id is dropped');
  A.eq(state.quotesSaturatedAt, null, '...and no saturation');
  const order = String(files.get('rq')).split('\n').filter(Boolean).map(l => JSON.parse(l).type);
  A.ok(order.indexOf('quotes') < order.indexOf('tool_result'), 'the quotes record precedes the tool_result record it covers');
  A.ok(J.quotesForgotten(state, id => ({ S: 45 })[id] || 0, () => 0), 'a journaled quote deleted at or after its read forgets the journal');
  A.ok(!J.quotesForgotten(state, id => ({ S: 30 })[id] || 0, () => 0), '...one deleted before its (earliest) read does not');
  j.quotes('rq', { saturatedAt: 90 });
  const state2 = j.inspect('rq');
  A.eq(state2.quotesSaturatedAt, 90, 'a saturation is derived too');
  A.ok(J.quotesForgotten(state2, () => 0, () => 95) && !J.quotesForgotten(state2, () => 0, () => 85) && !J.quotesForgotten(state2, () => 0, () => 0), 'a saturated journal is forgotten by any non-adopted delete at or after its time, by none before it');
  A.eq(j.inspect('rq').corrupt, false, 'the hash chain holds across the new record type');
  // the interrupted run's record names the sessions it read
  A.eq(D.interruptedIdentity({ turnId: 'tinterrupted0001', streamId: '' }, null, state2).quotes, ['*'], 'interruptedIdentity: a saturated journal carries the saturated stamp');
  A.eq(D.interruptedIdentity({}, null, state), { quotes: ['S', longId, 'U'], quotesAt: [40, 60, 70] }, '...a journal with no turn still names the sessions it read');
  A.eq(D.interruptedIdentity({}, null, undefined), {}, 'a journal that read nothing adds nothing');
  // the run record carries the stamp end to end (noteIdentity -> record), saturation included
  const rs = makeRunStore({ io: { lines: [], readAll() { return this.lines.slice(); }, append(e) { this.lines.push(e); } }, clock: { now: () => 5000 } });
  rs.noteIdentity('run-q', D.quoteIdentityOf(exe.quotes()));
  const rec = rs.record({ runId: 'run-q', agentId: 'agent', reason: 'done', turns: 1, title: 'x' });
  A.eq([rec.quotes, rec.quotesAt, rec.quotesSaturatedAt], [['*'], [1000], 1000], 'the run record carries quotes, quotesAt and quotesSaturatedAt');
  A.ok(Kinds.quotesForgotten(rec, () => 0, () => 1500) && !Kinds.quotesForgotten(rec, () => 0, () => 900), '...and the one rule reads it: a delete since the run began forgets the run');
  rs.noteIdentity('run-r', D.quoteIdentityOf([{ id: 'S', at: 50 }]));
  const rec2 = rs.record({ runId: 'run-r', agentId: 'agent', reason: 'done', turns: 1, title: 'y' });
  A.ok(Kinds.quotesForgotten(rec2, id => ({ S: 60 })[id] || 0, () => 0) && rec2.quotesSaturatedAt === undefined, 'a listed quote is forgotten by its stream delete; no saturation field');
  // the refusal notice carries none of the read
  const refusal = D.quoteRefusal({ content: 'the quokka codeword is Wallaby-Seven', quotedStreams: ['S'], taintedBy: 'x' }, 'deleted');
  A.ok(refusal.isError === true && refusal.hostAuthored === true && !/quokka|Wallaby/.test(JSON.stringify(refusal)) && refusal.quotedStreams === undefined, 'quoteRefusal: a host-authored error that holds none of the read and quotes nothing');
}

// ---------------- 8. the tools that read another session name it, and the host latches it (commit 9) ----------------
(async () => {
  const { makeRecallTool } = require('../sidecar/tools/builtin/recall.js');
  const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
  const { makeRegistry } = require('../sidecar/tools/registry.js');
  const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
  const { readSidecarIndex, sidecarTopLevelFunction } = require('./helpers/source.js');
  const openCtx = extra => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', timeoutMs: 5000 }, extra || {});

  // -- 8a. the registry shapes quotedStreams where it shapes taintedBy: valid ids, distinct, bounded; and a park carries it
  {
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'read.other', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} },
      run: async () => ({ content: 'words of another session', quotedStreams: ['S', 'S', 'bad id!', 7, null, 'T', 'x'.repeat(65)] }) });
    reg.register({ impact: 'none', name: 'read.big', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} },
      run: async () => ({ content: 'HEAD ' + 'y'.repeat(9000) + ' TAIL', quotedStreams: ['S'] }) });
    reg.register({ impact: 'none', name: 'read.none', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'nothing quoted', quotedStreams: 'S' }) });
    const r = await reg.dispatch({ id: 'q1', name: 'read.other', args: {} }, openCtx());
    A.eq(r.quotedStreams, ['S', 'T'], 'the registry keeps the valid, distinct stream ids of quotedStreams');
    A.eq((await reg.dispatch({ id: 'q2', name: 'read.none', args: {} }, openCtx())).quotedStreams, undefined, 'a malformed quotedStreams is no quote (and never throws)');
    const parked = [];
    const big = await reg.dispatch({ id: 'q3', name: 'read.big', args: {} }, openCtx({ outputMax: 8000, parkOutput: async (content, meta) => { parked.push(meta); return null; } }));
    A.eq(parked.length, 1, 'an over-budget read goes to the host\'s parker');
    A.eq(parked[0] && parked[0].quotedStreams, ['S'], '...with its quoted streams in the park meta, so the host can refuse to save another session\'s words as a file');
    A.eq(big.quotedStreams, ['S'], '...and the result the host latches still names them');
  }

  // -- 8b. recall_conversation: the sessions it draws on are named, and a session the run has no room for is left out BEFORE the content exists
  {
    ledger = { deleted: {}, latest: 0 };
    const store = makeStore({ runOf: () => null });
    const post = (stream, role, content, extra) => store.appendStrict(Object.assign({ streamId: stream, agentId: 'a', role, content, taint: null, kind: 'turn', turnId: 'turn-' + stream + '-' + role[0] + '-0001' }, extra));
    post('T', 'user', 'my own zebra note about the harbor');
    const others = [];
    for (let i = 1; i <= 8; i++) { const id = 'o' + String(i).padStart(2, '0'); others.push(id); post(id, 'user', 'zebra word tok' + id + ' from session ' + id); }
    const run = (quoteRoom, args) => makeRecallTool({ transcriptStore: store, ownStreamOnly: () => false, quoteRoom }).recallTool.run(args, { streamId: 'T' });
    const free = await run(undefined, { query: 'zebra', scope: 'all', limit: 20 });
    A.eq(free.quotedStreams.slice().sort(), others, 'search: quotedStreams is exactly the other sessions whose words are in the content (the run\'s own stream is never one)');
    A.ok(others.every(id => free.content.includes('tok' + id)) && free.content.includes('my own zebra note'), 'no room limit (a host that passes no quoteRoom): every hit is composed, as before');
    const exe = makeRunExecutionState({ startedAt: 1 });
    for (let i = 0; i < 30; i++) exe.latchQuotes([{ id: 'held' + i, at: 5 }]);   // 30 sessions already read: room for two more
    const capped = await run(ids => exe.quoteRoom(ids), { query: 'zebra', scope: 'all', limit: 20 });
    const shown = others.filter(id => capped.content.includes('tok' + id));
    A.eq(shown.length, 2, 'search: with room for two more sessions only two are composed');
    A.eq(capped.quotedStreams.slice().sort(), shown, '...and quotedStreams names exactly those two');
    const gone = others.filter(id => !shown.includes(id));
    A.ok(gone.every(id => !capped.content.includes(id) && !capped.content.includes('tok' + id)), 'the left-out sessions\' words AND ids are nowhere in the content');
    A.ok(/\[6 results from 6 other sessions withheld: one run may read at most 32 sessions; continue in a new run\.\]/.test(capped.content), '...one host line says so with counts only');
    A.ok(capped.content.includes('my own zebra note'), 'the run\'s own stream is never limited');
    const noRoom = await run(() => [], { query: 'zebra', scope: 'all', limit: 20 });
    A.ok(!others.some(id => noRoom.content.includes('tok' + id)) && noRoom.content.includes('my own zebra note') && noRoom.quotedStreams === undefined, 'a room that allows no session leaves only the run\'s own stream, and quotes nothing');
    const throwing = await run(() => { throw new Error('the room broke'); }, { query: 'zebra', scope: 'all', limit: 20 });
    A.ok(!others.some(id => throwing.content.includes('tok' + id)), 'a room that cannot be asked allows nothing (fail closed)');
    // around: another session's window is refused before it is read when the room has none left
    const row = store.search('o03', 'zebra', { limit: 1 })[0];
    const anchor = 'tx-' + row.rowId;
    const seen = await run(ids => ids, { anchor, stream: 'o03' });
    A.ok(seen.content.includes('toko03') && seen.quotedStreams && seen.quotedStreams.join() === 'o03', 'around: a window of another session is composed and names that session');
    const refused = await run(() => [], { anchor, stream: 'o03' });
    A.ok(!refused.content.includes('toko03') && refused.quotedStreams === undefined && /cannot be read in this run/.test(refused.content), 'around: a session the run has no room for is refused before it is read');
    const own = await run(() => [], { around: row.ts, stream: 'T' });
    A.ok(own.quotedStreams === undefined, 'around: the run\'s own stream is no quote');
    // browse: a preview is another session's words
    const browse = await run(ids => ids.slice(0, 3), {});
    A.eq(browse.quotedStreams.length, 3, 'browse: only the previews the room allows are composed and named');
    A.eq(others.filter(id => browse.content.includes('tok' + id)).sort(), browse.quotedStreams.slice().sort(), 'browse: exactly the named sessions carry words');
    A.ok(/withheld/.test(browse.content), '...and the rest are listed without one, with the counts-only line');
  }

  // -- 8c. session.peek: the session read is named; the run's own is not; a session the room refuses is never composed
  {
    const turns = [{ speaker: 'researcher', text: 'the quokka codeword is Wallaby-Seven' }];
    const bridge = id => ({ request: async verb => (verb === 'station.read_session' ? { ok: true, result: { id, title: 'research', busy: false, turns } } : { ok: false, error: 'unknown' }) });
    const peek = (id, quoteRoom, ctx) => makeStationTools({ station: bridge(id), quoteRoom }).peekTool.run({ session: 'research' }, ctx || { streamId: 'T' });
    const read = await peek('S', undefined);
    A.eq(read.quotedStreams, ['S'], 'session.peek names the session it read');
    A.eq((await peek('T', undefined)).quotedStreams, undefined, '...never the run\'s own');
    A.eq((await peek('S', ids => ids)).quotedStreams, ['S'], '...a room that allows it keeps it');
    const refused = await peek('S', () => []);
    A.ok(!/quokka|Wallaby/.test(refused.content) && refused.quotedStreams === undefined && /REFUSED/.test(refused.content), 'a session the room refuses is never composed, and nothing is quoted');
    A.ok(!/quokka/.test((await peek('S', () => { throw new Error('x'); })).content), 'a room that cannot be asked allows nothing');
    const empty = await makeStationTools({ station: { request: async () => ({ ok: true, result: { id: 'S', title: 'research', turns: [] } }) } }).peekTool.run({ session: 'research' }, { streamId: 'T' });
    A.eq(empty.quotedStreams, undefined, 'a session with nothing to read quotes nothing');
  }

  // -- 8d. the host's wiring, by order: the epoch is read before the dispatch, the latch before the journal's result record
  {
    const src = readSidecarIndex();   // index.js itself: this pins its own structure (the dispatch closure and the forget function live there)
    const at = s => { const i = src.indexOf(s); A.ok(i >= 0, 'index.js holds: ' + s.slice(0, 60)); return i; };
    const epoch = at('const quoteEpoch = Date.now();'), dispatch = at('r = await registry.dispatch(c, dctx);'), latch = at('latchRunQuotes(r.quotedStreams, quoteEpoch)'), journalResult = at('runJournal.toolResult(runId, {');
    A.ok(epoch < dispatch && dispatch < latch && latch < journalResult, 'the read epoch precedes the dispatch, and the latch precedes the tool_result journal record');
    A.ok(src.slice(epoch, dispatch).split('\n').length <= 3, '...the epoch is read immediately before the dispatch (no await between)');
    const latchFn = src.slice(src.indexOf('const latchRunQuotes = (ids, epoch) => {'), src.indexOf('const liveQuote = {'));
    A.ok(latchFn.length > 100 && !/await\s/.test(latchFn), 'latchRunQuotes holds no await: it is one synchronous block');
    const forget = sidecarTopLevelFunction('forgetDeletedSessionMemory');
    A.ok(/^function forgetDeletedSessionMemory\(\) \{\s*\n\s*forgetRegistry\.stopLive\(sessionTombstones\.unpurged\(\)\);/.test(forget), 'forgetDeletedSessionMemory stops the live runs that read a deleted session as its FIRST synchronous statement (through the registry, whose stopLive is stopQuotingRuns)');
    A.ok(/stopLive: stopQuotingRuns/.test(src), '...and the registry\'s stopLive IS the host\'s stopQuotingRuns');
    A.ok(/if \(meta && Array\.isArray\(meta\.quotedStreams\) && meta\.quotedStreams\.length\) return null;/.test(src) && /parkOutput\(r\.content, \{ tool: c\.name, reason: 'run-output-budget', quotedStreams: r\.quotedStreams \}\)/.test(src), 'a quoted read is never parked as a workspace file (both park sites)');
    A.ok(/quoteRoom: ids => execution\.quoteRoom\(ids\)/.test(src) && /overseerStation\(o\.streamId, runId, ids => execution\.quoteRoom\(ids\)\)/.test(src), 'recall, session.peek and the overseer answer are handed the run\'s room');
  }

  // ---------------- 9. what a quoting run writes OUTSIDE its run transcript carries its quotes too (commit 10) ----------------
  const Delivery = require('../sidecar/turn-delivery.js');
  const { finalizeDispatchDelivery } = require('../sidecar/dispatch-delivery.js');
  const { readSidecarSource } = require('./helpers/source.js');
  const inView = (store, view, stream, rowId) => store.view(view, stream, { limit: 200 }).some(r => r.rowId === rowId);
  const recalled = (store, stream, word, rowId) => store.view('recall', stream, { op: 'search', query: word, limit: 20, scope: 'all' }).some(r => r.rowId === rowId);
  const replayHas = (store, stream, word) => ['prose', 'pairs'].some(shape => store.view('model-replay', stream, { limit: 200, shape, form: 'pre' }).some(m => String(m.content).includes(word)));

  // -- 9a. a file named from a session's words (leg e): the file row quotes what its run read, and leaves with it
  {
    ledger = { deleted: {}, latest: 0 };
    const store = makeStore({ runOf: () => null });
    const files = (runId, quotes, path) => Delivery.fileRows(store, { streamId: 'T', agentId: 'a', runId, root: '', artifacts: [{ kind: 'file', path, bytes: 5 }], quotes });
    const quoting = files('run_file_1', [{ id: 'S', at: 50 }], 'notes on quokka.md').rows[0];
    const control = files('run_ctl_1', [], 'plain notes.md').rows[0];
    const stored = store.view('proof', 'T', { limit: 50 }).find(r => r.rowId === quoting.rowId);
    A.eq([stored.quotes, stored.quotesAt, stored.kind], [['S'], [50], 'deliverable'], 'fileRows stamps the row with the run\'s latch');
    A.eq(store.view('proof', 'T', { limit: 50 }).find(r => r.rowId === control.rowId).quotes, undefined, 'a run that read nothing stamps nothing');
    A.ok(inView(store, 'display', 'T', quoting.rowId) && recalled(store, 'T', 'quokka', quoting.rowId) && !replayHas(store, 'T', 'quokka'), 'before the delete the file row is in display and recall, and never in model-replay (a file row is not replayed)');
    const again = files('run_file_1', [{ id: 'S', at: 50 }], 'notes on quokka.md');
    A.eq([again.rows[0].existed, again.rows[0].rowId], [true, quoting.rowId], 'a retry finds the same row (idempotent; the stamp is not rewritten)');
    A.throws(() => files('run_bad_1', 'S', 'x.md'), 'quotes that are not a list are refused, not ignored');
    ledger = { deleted: { S: 60 }, latest: 60 };
    A.ok(!inView(store, 'display', 'T', quoting.rowId) && !recalled(store, 'T', 'quokka', quoting.rowId) && !replayHas(store, 'T', 'quokka'), 'after the delete the file row is out of display, recall and model-replay');
    A.ok(inView(store, 'display', 'T', control.rowId) && recalled(store, 'T', 'plain', control.rowId), '...the unstamped control stays');
    A.ok(store.view('display', 'T', { limit: 50 })[View.FORGOTTEN].keys.some(k => k[1] === quoting.rowId), '...and the page is told to drop its copy (identity.forgotten)');
  }

  // -- 9b. a routine's delivered reply copies the routine run's latch from its own rows (leg e, session return and chat attach)
  {
    ledger = { deleted: {}, latest: 0 };
    const store = makeStore({ runOf: () => null });
    const run = (stream, runId, stamps) => stamps.forEach((s, i) => store.appendStrict(Object.assign({ streamId: stream, agentId: 'a', role: i === 0 ? 'user' : 'assistant', content: 'routine row ' + i + ' of ' + runId, taint: null, kind: 'routine', turnId: 'r' + runId, sourceRunId: runId }, s)));
    run('cron-run_read_1', 'run_read_1', [{}, { quotes: ['S1'], quotesAt: [100] }, { quotes: ['S1', 'S2'], quotesAt: [100, 120] }]);
    run('cron-run_none_1', 'run_none_1', [{}, {}]);
    run('cron-run_sat_1', 'run_sat_1', [{}, { quotes: ['*'], quotesAt: [90] }]);
    const deliver = (runId, extra) => Delivery.write(store, Object.assign({ streamId: 'U', agentId: 'a', runId, text: 'the routine said quokka words for ' + runId, sourceStream: 'cron-' + runId }, extra));
    const read = deliver('run_read_1'), none = deliver('run_none_1'), sat = deliver('run_sat_1');
    const row = id => store.view('proof', 'U', { limit: 50 }).find(r => r.rowId === id);
    A.eq([row(read.rowId).quotes, row(read.rowId).quotesAt, row(read.rowId).kind], [['S1', 'S2'], [100, 120], 'delivery'], 'the delivery row carries the whole latch of the routine run (the union of its rows\' stamps, the earliest read per stream)');
    A.eq(row(none.rowId).quotes, undefined, 'a routine that read no other session delivers an unstamped row');
    A.eq([row(sat.rowId).quotes, row(sat.rowId).quotesAt], [['*'], [90]], 'a saturated routine run delivers a saturated row');
    A.eq(deliver('run_read_1').rowId, read.rowId, 'a retry reuses the row (idempotent)');
    A.eq(Delivery.write(store, { streamId: 'U', agentId: 'a', runId: 'run_read_1', text: '', existingOnly: true }).rowId, read.rowId, 'the confirm-only path finds it and writes nothing');
    const noSource = Delivery.write(store, { streamId: 'U', agentId: 'a', runId: 'run_plain_1', text: 'no source stream given' });
    A.eq(row(noSource.rowId).quotes, undefined, 'a caller that names no source stream gets no stamp (as before)');
    A.throws(() => deliver('run_new_1', { sourceStream: 'not a stream!' }), 'a source stream that is not a stream id is refused');
    const blind = Object.assign(Object.create(store), { view: (name, stream, opts) => (stream === 'cron-run_blind_1' ? null : store.view(name, stream, opts)) });
    let refused = null;
    try { Delivery.write(blind, { streamId: 'U', agentId: 'a', runId: 'run_blind_1', text: 'x', sourceStream: 'cron-run_blind_1' }); } catch (e) { refused = e; }
    A.ok(refused && refused.code === 'TRANSCRIPT_UNVOUCHED' && !store.view('proof', 'U', { limit: 50 }).some(r => r.sourceRunId === 'run_blind_1'), 'a source run whose rows cannot be read refuses the delivery (nothing written): the stamp is never guessed');
    ledger = { deleted: {}, latest: 0 };
    A.ok(inView(store, 'display', 'U', read.rowId) && recalled(store, 'U', 'quokka', read.rowId) && replayHas(store, 'U', 'run_read_1'), 'before any delete the delivered reply is in display, recall and model-replay');
    ledger = { deleted: { S2: 130 }, latest: 130 };
    A.ok(!inView(store, 'display', 'U', read.rowId) && !recalled(store, 'U', 'quokka', read.rowId) && !replayHas(store, 'U', 'run_read_1'), 'a delete of a session the routine read takes its delivered reply out of display, recall and model-replay');
    A.ok(inView(store, 'display', 'U', none.rowId) && recalled(store, 'U', 'quokka', none.rowId) && replayHas(store, 'U', 'run_none_1'), '...a routine that read nothing is not touched');
    A.ok(!inView(store, 'display', 'U', sat.rowId) && !replayHas(store, 'U', 'run_sat_1'), '...a saturated one goes with any later delete');
  }

  // -- 9c. the accepted dispatch answer quotes what the worker (and its repair run) read
  {
    ledger = { deleted: {}, latest: 0 };
    const store = makeStore({ runOf: () => null });
    const crypto2 = require('node:crypto'), sha = s => crypto2.createHash('sha256').update(s).digest('hex');
    const source = { runId: 'wrk', agentId: 'a', streamId: 'W', dispatchDelivery: { state: 'pending' }, deliveryPrompt: 'the brief', startedAt: 1, ts: 2, quotes: ['S'], quotesAt: [50] };
    const finals = [];
    const runStore = { deliverySource: id => (id === 'wrk' ? source : null), latest: id => (id === 'rep' ? { runId: 'rep', quotes: ['U'], quotesAt: [70] } : null),
      finalizeDelivery: (id, v) => { finals.push(v); return v; } };
    finalizeDispatchDelivery({ runStore, transcriptStore: store, redact: s => s, hash: sha }, 'wrk', { text: 'the worker says quokka', reason: 'done', repairRunId: 'rep' });
    const finalRow = store.view('proof', 'W', { limit: 20 }).find(r => r.dispatchState === 'final');
    A.eq([finalRow.quotes, finalRow.quotesAt], [['S', 'U'], [50, 70]], 'the final answer carries the worker\'s and its repair run\'s reads');
    A.ok(replayHas(store, 'W', 'quokka'), 'before the delete the accepted answer replays');
    ledger = { deleted: { U: 80 }, latest: 80 };
    A.ok(!replayHas(store, 'W', 'quokka') && !inView(store, 'display', 'W', finalRow.rowId), 'after a delete of a session either run read, the accepted answer is out of display and model-replay');
    ledger = { deleted: {}, latest: 0 };
    const s2 = makeStore({ runOf: () => null });
    finalizeDispatchDelivery({ runStore: { deliverySource: () => Object.assign({}, source, { quotes: undefined, quotesAt: undefined }), latest: () => null, finalizeDelivery: v => v }, transcriptStore: s2, redact: s => s, hash: sha }, 'wrk', { text: 'clean answer', reason: 'done', repairRunId: '' });
    A.eq(s2.view('proof', 'W', { limit: 20 }).find(r => r.dispatchState === 'final').quotes, undefined, 'a worker that read nothing leaves the answer unstamped');
  }

  // -- 9d. the away briefing is an assistant message of its own session that quotes the sessions it reports
  {
    ledger = { deleted: {}, latest: 0 };
    const store = makeStore({ runOf: () => null });
    const stamp = Kinds.quoteStamp(Kinds.quoteEntriesOf([{ streamId: 'S', deliveryText: 'built the quokka report' }, { streamId: 'T', deliveryText: '' }], 500));
    const plain = store.append({ streamId: 'briefing', agentId: 'away', role: 'assistant', content: 'a briefing with no kind', taint: null });
    const brief = store.append(Object.assign({ streamId: 'briefing', agentId: 'away', role: 'assistant', content: 'While you were away: the quokka report', taint: null, kind: 'briefing' }, stamp));
    A.eq([brief.kind, brief.quotes, brief.quotesAt], ['briefing', ['S'], [500]], 'the briefing row names its kind and quotes the streams of the runs it reports');
    A.eq(Kinds.classify(brief, {}).cell, Kinds.classify(plain, {}).cell, 'naming the kind changes nothing about who reads the row (the same cell as an unkinded assistant message)');
    A.ok(inView(store, 'display', 'briefing', brief.rowId) && inView(store, 'display', 'briefing', plain.rowId), 'both rows are in display before the delete');
    A.ok(recalled(store, 'briefing', 'quokka', brief.rowId) && recalled(store, 'briefing', 'kind', plain.rowId), '...and in recall');
    A.ok(replayHas(store, 'briefing', 'While you were away') && replayHas(store, 'briefing', 'a briefing with no kind'), '...and in model-replay (a reply in the briefing session continues from it)');
    ledger = { deleted: { S: 600 }, latest: 600 };
    A.ok(!inView(store, 'display', 'briefing', brief.rowId) && !recalled(store, 'briefing', 'quokka', brief.rowId) && !replayHas(store, 'briefing', 'quokka') && inView(store, 'display', 'briefing', plain.rowId) && recalled(store, 'briefing', 'kind', plain.rowId),
      'a delete of a briefed session takes the briefing out of display, recall and model-replay; an unstamped one stays');
  }

  // -- 9e. the host's static quotes, by source: where each is stamped
  {
    const index = readSidecarIndex();
    A.eq(index.split('...packQuotes(pack)').length - 1, 3, 'night shift: the V1 propose, the V2 propose and the act run each quote the sessions the pack drew on');
    A.eq(index.split('...sel.quoted, messages:').length - 1, 2, '...and the V1 do and critique runs, composed from the selected idea, quote the same (kept on the selection, out of its enumerable fields)');
    A.ok(/Object\.defineProperty\(sel, 'quoted', \{ value: packQuotes\(pack\), enumerable: false \}\);/.test(index), '...so it never rides the idea into a ledger or a file');
    A.ok(/quotes: o && o\.quotes, quotesAt: o && o\.quotesAt/.test(index), '...and nightshiftChat hands them to its run');
    const pq = new Function('QUOTE_SID_RE', require('./helpers/source.js').sidecarTopLevelFunction('packQuotes') + '\nreturn packQuotes;')(/^[A-Za-z0-9_-]{1,64}$/);
    A.eq(pq({ activity: [{ line: 'a', src: { streamId: 'S' } }, { line: 'b', src: { streamId: 'S' } }, { line: 'c', src: null }, { line: 'd', src: { streamId: 'bad id' } }, { line: 'e', src: { streamId: 'T' } }], assembledAt: 700 }), { quotes: ['S', 'T'], quotesAt: 700 },
      'packQuotes: the distinct streams of the lines that name a source, at the pack\'s assembly time');
    A.eq([pq({ activity: [{ line: 'x', src: null }] }), pq(null), pq({})], [{}, {}, {}], '...nothing when no line names one');
    A.ok(/\.\.\.\(body && typeof body\.quotesStream === 'string' && QUOTE_SID_RE\.test\(body\.quotesStream\) \? \{ quotes: \[body\.quotesStream\], quotesAt: receivedAt \} : \{\}\)/.test(index) && /const receivedAt = Date\.now\(\);/.test(index), '/api/run maps an additive quotesStream to a static quote read at the request\'s receipt');
    const chat = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8'), harness = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
    A.eq(chat.split('quotesStream: ws.id').length - 1, 2, 'the page names the session in both internal calls it composes from one (the retitle and the goal judge)');
    A.ok(/goalContinuation, quotesStream, retryUserRunId, voiceTurn,/.test(harness) && /if \(quotesStream\) reqBody\.quotesStream = String\(quotesStream\)\.slice\(0, 64\);/.test(harness), '...and Harness.chat sends it');
    A.ok(/briefQuoteEntries\(o\)/.test(index) && /execution\.latchQuotes\(staticQuoteEntries\(o\)\.concat\(briefQuoteEntries\(o\)\)\);/.test(index), 'a delegated worker\'s brief quotes its lead\'s stream (seeded before any tool can run)');
    const all = readSidecarSource();
    A.ok(/kind: 'briefing', \.\.\.TurnKinds\.quoteStamp\(TurnKinds\.quoteEntriesOf\(inputs\.runs, now\)\)/.test(all), 'the away briefing row names its kind and quotes the runs it reports');
    A.eq(all.split('...TurnKinds.quoteStamp(execution.quotes())').length - 1, 2, 'the run-end lines written outside the run transcript (the directive line and the new turns) carry the run\'s quotes');
    A.ok(/note: deliverableNotes\.get\(runId\), quotes: execution\.quotes\(\), taint:/.test(all), 'the run-end file rows are given the run\'s quotes');
    A.ok(/sourceStream: 'cron-' \+ result\.runId/.test(all) && /sourceStream: 'cron-' \+ record\.runId/.test(all), 'a routine\'s session return and its chat attach both name the routine run\'s own stream as the source of the stamp');
  }
})().then(() => A.report('turn-dual.forget'), e => { console.error(e && e.stack || e); process.exitCode = 1; });
