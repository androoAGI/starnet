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

A.report('turn-dual.forget');
